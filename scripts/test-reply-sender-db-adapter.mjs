import assert from 'node:assert/strict';
import { createResponseDraftSendRepository } from '../api/_reply-draft-send-db.js';

const roleAuthority = {
  rolsuper: false,
  expected_sender_login: true,
  sender_member: true,
  owner_member: false,
  table_owner: false,
  direct_insert: false,
  direct_update: false,
  direct_delete: false,
  direct_truncate: false,
  claim_exists: true,
  finalizer_exists: true,
  claim_execute: true,
  finalizer_execute: true,
  claim_owner_matches: true,
  finalizer_owner_matches: true
};

function makeClient({ finalizerFailure = false, claimFailure = false, claimState = null, authority = roleAuthority } = {}) {
  const calls = [];
  const client = {
    calls,
    released: false,
    async query(sql, values = []) {
      const normalized = String(sql).trim();
      calls.push({ sql: normalized, values });
      if (/^SELECT role\.rolsuper/.test(normalized)) return { rows: [authority] };
      if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(normalized)) return { rows: [] };
      if (/claim_response_draft_send\(/.test(normalized)) {
        if (claimFailure) throw new Error('simulated claim and audit transaction failure');
        if (!claimState || !['NOT_SENT', 'FAILED'].includes(claimState.state)) return { rows: [] };
        claimState.state = 'SENDING';
        claimState.attemptId = values[1];
        return { rows: [{ id: values[0], send_state: 'SENDING', send_attempt_id: values[1] }] };
      }
      if (/^SELECT public\.finalize_response_draft_send_v2\(/.test(normalized)) {
        if (finalizerFailure) throw new Error('simulated finalizer/audit transaction failure');
        return { rows: [{ persisted: true }] };
      }
      throw new Error(`Unexpected SQL in offline adapter fixture: ${normalized.slice(0, 80)}`);
    },
    release() { this.released = true; }
  };
  return client;
}

const env = { REPLY_SENDER_ROLE: 'test_sender_group', REPLY_SENDER_LOGIN_ROLE: 'test_sender_login', REPLY_SEND_OWNER_ROLE: 'test_owner_group' };
const finalizerClient = makeClient();
const repository = createResponseDraftSendRepository({
  env,
  databaseClient: { query: async () => ({ rows: [] }) },
  connectSenderClient: async () => finalizerClient
});
const finalization = {
  draftId: '71',
  attemptId: '5ee24d7f-2b59-4559-a73b-707f7e8d89b9',
  actorEmail: 'admin@example.invalid',
  outcome: 'FAILED',
  smtpCode: 550,
  smtpStage: 'RCPT_TO',
  outcomeEvidence: 'SMTP_RECIPIENT_REJECTED',
  sendError: 'SMTP_REJECTED_RCPT_TO_550',
  providerMessageId: null
};
assert.equal(await repository.finalize(finalization), true);
const finalizerCall = finalizerClient.calls.find(call => /^SELECT public\.finalize_response_draft_send_v2\(/.test(call.sql));
assert.ok(finalizerCall, 'the real adapter invokes the versioned SQL finalizer');
assert.match(finalizerCall.sql, /\$1::bigint, \$2::uuid, \$3::text, \$4::text, \$5::integer,\s*\$6::text, \$7::text, \$8::text, \$9::text/);
assert.deepEqual(finalizerCall.values, [
  finalization.draftId,
  finalization.attemptId,
  finalization.actorEmail,
  finalization.outcome,
  finalization.smtpCode,
  finalization.smtpStage,
  finalization.outcomeEvidence,
  finalization.sendError,
  finalization.providerMessageId
]);
assert.equal(finalizerCall.values.length, 9, 'invocation argument count matches the nine-argument SQL signature');
assert.ok(finalizerClient.calls.some(call => call.sql === 'COMMIT'));
assert.equal(finalizerClient.released, true);

const invalidEvidenceClient = makeClient();
const invalidEvidenceRepository = createResponseDraftSendRepository({
  env,
  databaseClient: { query: async () => ({ rows: [] }) },
  connectSenderClient: async () => invalidEvidenceClient
});
await assert.rejects(() => invalidEvidenceRepository.finalize({
  ...finalization,
  smtpCode: null,
  smtpStage: null,
  outcomeEvidence: null,
  sendError: null
}), error => error.code === 'REPLY_SEND_OUTCOME_INVALID');
assert.equal(invalidEvidenceClient.calls.length, 0, 'missing/null FAILED evidence is rejected before database invocation');

const failingFinalizerClient = makeClient({ finalizerFailure: true });
const failingRepository = createResponseDraftSendRepository({
  env,
  databaseClient: { query: async () => ({ rows: [] }) },
  connectSenderClient: async () => failingFinalizerClient
});
await assert.rejects(() => failingRepository.finalize(finalization), /simulated finalizer\/audit transaction failure/);
assert.ok(failingFinalizerClient.calls.some(call => call.sql === 'ROLLBACK'), 'finalizer or audit failure rolls back the adapter transaction');

const sharedClaim = { state: 'NOT_SENT', attemptId: null };
const claimClients = [makeClient({ claimState: sharedClaim }), makeClient({ claimState: sharedClaim })];
let connectionIndex = 0;
const claimRepository = createResponseDraftSendRepository({
  env,
  databaseClient: { query: async () => ({ rows: [] }) },
  connectSenderClient: async () => claimClients[connectionIndex++]
});
const claims = await Promise.all([
  claimRepository.claim('71', 'attempt-one', 'admin@example.invalid'),
  claimRepository.claim('71', 'attempt-two', 'admin@example.invalid')
]);
assert.equal(claims.filter(Boolean).length, 1, 'only one mocked atomic-claim winner receives a row');
assert.ok(claimClients.every(client => client.calls.some(call => call.sql === 'COMMIT' || call.sql === 'ROLLBACK')));

const failingClaimClient = makeClient({ claimFailure: true, claimState: { state: 'NOT_SENT', attemptId: null } });
const failingClaimRepository = createResponseDraftSendRepository({
  env,
  databaseClient: { query: async () => ({ rows: [] }) },
  connectSenderClient: async () => failingClaimClient
});
await assert.rejects(() => failingClaimRepository.claim('71', 'attempt-audit-fail', 'admin@example.invalid'));
assert.ok(failingClaimClient.calls.some(call => call.sql === 'ROLLBACK'), 'claim audit failure rolls back and cannot return a claim');

const deletePrivilegeClient = makeClient({ authority: { ...roleAuthority, direct_delete: true } });
const deletePrivilegeRepository = createResponseDraftSendRepository({
  env,
  databaseClient: { query: async () => ({ rows: [] }) },
  connectSenderClient: async () => deletePrivilegeClient
});
await assert.rejects(() => deletePrivilegeRepository.claim('71', 'attempt-delete-privilege', 'admin@example.invalid'),
  error => error.code === 'REPLY_SENDER_ROLE_INVALID');
assert.ok(!deletePrivilegeClient.calls.some(call => /^SELECT \* FROM public\.claim_response_draft_send\(/.test(call.sql)),
  'a sender login with direct DELETE privilege cannot invoke a state transition');
const wrongSenderLoginClient = makeClient({ authority: { ...roleAuthority, expected_sender_login: false } });
const wrongSenderLoginRepository = createResponseDraftSendRepository({
  env,
  databaseClient: { query: async () => ({ rows: [] }) },
  connectSenderClient: async () => wrongSenderLoginClient
});
await assert.rejects(() => wrongSenderLoginRepository.claim('71', 'attempt-wrong-login', 'admin@example.invalid'),
  error => error.code === 'REPLY_SENDER_ROLE_INVALID');
assert.ok(!wrongSenderLoginClient.calls.some(call => /^SELECT \* FROM public\.claim_response_draft_send\(/.test(call.sql)),
  'a connection authenticated as a different sender-group member cannot claim');
const truncatePrivilegeClient = makeClient({ authority: { ...roleAuthority, direct_truncate: true } });
const truncatePrivilegeRepository = createResponseDraftSendRepository({
  env,
  databaseClient: { query: async () => ({ rows: [] }) },
  connectSenderClient: async () => truncatePrivilegeClient
});
await assert.rejects(() => truncatePrivilegeRepository.claim('71', 'attempt-truncate-privilege', 'admin@example.invalid'),
  error => error.code === 'REPLY_SENDER_ROLE_INVALID');
assert.ok(!truncatePrivilegeClient.calls.some(call => /^SELECT \* FROM public\.claim_response_draft_send\(/.test(call.sql)),
  'a sender login with direct TRUNCATE privilege cannot invoke a state transition');

console.log('Offline reply-sender database adapter mapping tests passed (mocked PostgreSQL client; server SQL semantics not exercised).');
