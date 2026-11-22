import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { migrationPlan } from '../api/_migration-plan.js';
import {
  classifyReplySmtpOutcome,
  createResponseDraftSender,
  responseDraftSendBlocker
} from '../api/_response-draft-sender.js';
import { decideInboundSafety } from '../api/_routes/inbox.js';
import { isSupportedResponseDraftMode } from '../api/_routes/responses.js';

assert.equal(isSupportedResponseDraftMode('MANUAL'), true);
assert.equal(isSupportedResponseDraftMode('SUPERVISED'), true);
assert.equal(isSupportedResponseDraftMode('AUTHORIZED_AUTOMATION'), true);
assert.equal(isSupportedResponseDraftMode('AUTHORIZED AUTOMATION'), false);

const validDraft = overrides => ({
  id: '71',
  dataset_id: '5',
  status: 'APPROVED',
  send_state: 'NOT_SENT',
  recipient_email: 'buyer@example.invalid',
  inbox_sender_email: 'buyer@example.invalid',
  inbox_intent: 'QUESTION',
  subject: 'Re: Product question',
  body_text: 'Thank you for your question.',
  linked_contact_id: '18',
  linked_contact_email: 'buyer@example.invalid',
  contact_verification_status: 'VERIFIED',
  contact_is_suppressed: false,
  linked_outreach_status: 'REPLIED',
  globally_suppressed: false,
  ...overrides
});

const migration = await readFile(new URL('../database/migrations/008_reply_sender_boundary.sql', import.meta.url), 'utf8');
const hardeningMigration = await readFile(new URL('../database/migrations/009_reply_sender_safety_hardening.sql', import.meta.url), 'utf8');
const runner = await readFile(new URL('./db-migrate.mjs', import.meta.url), 'utf8');
const inboxSource = await readFile(new URL('../api/_routes/inbox.js', import.meta.url), 'utf8');
const claimDefinition = migration.split('CREATE OR REPLACE FUNCTION public.claim_response_draft_send')[1]?.split('CREATE OR REPLACE FUNCTION public.finalize_response_draft_send')[0] || '';
const finalizeDefinition = migration.split('CREATE OR REPLACE FUNCTION public.finalize_response_draft_send')[1]?.split('ALTER FUNCTION public.claim_response_draft_send')[0] || '';
const writerGuardDefinition = hardeningMigration.split('CREATE OR REPLACE FUNCTION public.guard_response_draft_send_state_writer')[1]?.split('DROP TRIGGER IF EXISTS response_drafts_send_state_insert_guard')[0] || '';
assert.match(claimDefinition, /draft\.status = 'APPROVED'/);
assert.match(claimDefinition, /draft\.send_state IN \('NOT_SENT', 'FAILED'\)/);
assert.match(claimDefinition, /send_attempt_id = p_attempt_id/);
assert.match(claimDefinition, /INSERT INTO public\.audit_logs/);
assert.match(finalizeDefinition, /draft\.send_state = 'SENDING'/);
assert.match(finalizeDefinition, /draft\.send_attempt_id = p_attempt_id/);
assert.match(finalizeDefinition, /INSERT INTO public\.audit_logs/);
assert.match(migration, /current_user <> trusted_owner/);
assert.match(hardeningMigration, /BEFORE INSERT ON public\.response_drafts/);
assert.match(hardeningMigration, /BEFORE UPDATE OF send_state/);
assert.match(writerGuardDefinition, /TG_OP = 'INSERT'/);
assert.match(writerGuardDefinition, /NEW\.send_state IS DISTINCT FROM 'NOT_SENT'/);
for (const field of ['send_attempted_at', 'send_attempt_id', 'send_error', 'sent_at', 'provider_message_id']) {
  assert.match(writerGuardDefinition, new RegExp(`NEW\\.${field} IS NOT NULL`), `INSERT must reject forged ${field}`);
  assert.match(writerGuardDefinition, new RegExp(`OLD\\.${field} IS DISTINCT FROM NEW\\.${field}`), `UPDATE must protect ${field}`);
}
assert.match(writerGuardDefinition, /SECURITY INVOKER/);
assert.match(hardeningMigration, /Only the migration executor and trusted superusers may be members of the SECURITY DEFINER owner role/);
assert.match(hardeningMigration, /sender_group_super OR sender_group_can_login/);
assert.ok(hardeningMigration.indexOf('ALTER FUNCTION public.finalize_response_draft_send_v2') <
  hardeningMigration.lastIndexOf('REVOKE ALL ON FUNCTION public.finalize_response_draft_send_v2'),
'finalizer ownership must be transferred before unexpected EXECUTE grants are revoked');
assert.doesNotMatch(hardeningMigration, /NOT IN \(owner_role::name, sender_role::name, function_owner\)/,
  'the former creator must not retain execute access after ownership transfer');
assert.match(hardeningMigration, /p_outcome_evidence IS NULL/);
assert.match(hardeningMigration, /p_outcome_evidence IS DISTINCT FROM 'SMTP_ACCEPTANCE_UNCERTAIN'/);
assert.match(hardeningMigration, /DROP FUNCTION IF EXISTS public\.finalize_response_draft_send\(/);
assert.doesNotMatch(migration, /tradeintel_reply_send_owner|tradeintel_reply_sender/);
assert.match(runner, /REPLY_SEND_OWNER_ROLE/);
assert.match(runner, /REPLY_SENDER_ROLE/);
for (const version of ['007_response_draft_send_state', '008_reply_sender_boundary', '009_reply_sender_safety_hardening']) {
  assert.equal(migrationPlan.filter(item => item.version === version).length, 1, `${version} must be registered once`);
  assert.equal(migrationPlan.filter(item => item.file === `${version}.sql`).length, 1, `${version} filename must be registered once`);
}
const replyMigrationOrder = ['007_response_draft_send_state', '008_reply_sender_boundary', '009_reply_sender_safety_hardening'];
assert.deepEqual(migrationPlan.filter(item => replyMigrationOrder.includes(item.version)).map(item => item.version), replyMigrationOrder);
assert.match(inboxSource, /STOPPED_REPLY_RECEIVED/);
assert.match(inboxSource, /STOPPED_UNSUBSCRIBED/);
assert.match(inboxSource, /STOPPED_BOUNCE/);
assert.equal(decideInboundSafety({ intent: 'QUESTION', contact: { is_suppressed: false }, outreach: { id: '4' } }).stopFollowUps, true);
assert.equal(decideInboundSafety({ intent: 'UNSUBSCRIBE', contact: { is_suppressed: false }, outreach: null }).stopFollowUps, true);

function makeRepository({ state = 'NOT_SENT', auditClaimFails = false, finalizeFails = false } = {}) {
  const record = { ...validDraft({ send_state: state }), send_attempt_id: null };
  const audits = [];
  return {
    record,
    audits,
    async inspect() { return { ...record }; },
    async claim(_id, attemptId, actorEmail) {
      if (auditClaimFails) throw new Error('simulated transactional audit failure');
      if (record.status !== 'APPROVED' || !['NOT_SENT', 'FAILED'].includes(record.send_state)) return null;
      record.send_state = 'SENDING';
      record.send_attempt_id = attemptId;
      audits.push({ action: 'CLAIM', attemptId, actorEmail });
      return { ...record };
    },
    async finalize(input) {
      if (finalizeFails) throw new Error('simulated state/audit transaction failure');
      if (record.send_state !== 'SENDING' || record.send_attempt_id !== input.attemptId) return false;
      record.send_state = input.outcome;
      record.send_error = input.sendError;
      record.outcome_evidence = input.outcomeEvidence;
      record.provider_message_id = input.providerMessageId;
      audits.push({ action: 'FINALIZE', ...input });
      return true;
    }
  };
}

const approved = validDraft();
assert.equal(responseDraftSendBlocker(approved), null);
for (const [label, changes] of [
  ['unapproved', { status: 'PENDING_APPROVAL' }],
  ['invalid recipient', { recipient_email: 'not-an-email' }],
  ['inbox mismatch', { inbox_sender_email: 'else@example.invalid' }],
  ['unverified contact', { contact_verification_status: 'UNVERIFIED' }],
  ['contact mismatch', { linked_contact_email: 'else@example.invalid' }],
  ['suppressed contact', { contact_is_suppressed: true }],
  ['global suppression', { globally_suppressed: true }],
  ['bounce', { linked_outreach_status: 'BOUNCED' }],
  ['unsubscribe', { inbox_intent: 'UNSUBSCRIBE' }]
]) {
  const blockedDraft = validDraft(changes);
  assert.ok(responseDraftSendBlocker(blockedDraft), `${label} must block sending`);
  const blockedRepository = makeRepository();
  blockedRepository.inspect = async () => blockedDraft;
  let claimCalls = 0;
  let sendCalls = 0;
  const originalClaim = blockedRepository.claim;
  blockedRepository.claim = (...args) => { claimCalls += 1; return originalClaim(...args); };
  await assert.rejects(() => createResponseDraftSender({ repository: blockedRepository })({
    draftId: '71', actorEmail: 'admin@example.invalid', sendMail: async () => { sendCalls += 1; }
  }), /approved|cannot|invalid|match|verified|suppressed|bounced|contact-preference/i);
  assert.equal(claimCalls, 0, `${label} must be rejected before claim`);
  assert.equal(sendCalls, 0, `${label} must be rejected before SMTP`);
}

assert.equal(classifyReplySmtpOutcome({
  result: { response: '250 2.0.0 accepted', accepted: ['buyer@example.invalid'], messageId: '<smtp-71@example.invalid>' },
  recipient: 'buyer@example.invalid'
}).outcome, 'SENT');
assert.equal(classifyReplySmtpOutcome({
  result: { response: '250 2.0.0 accepted', accepted: ['buyer@example.invalid'] },
  recipient: 'buyer@example.invalid'
}).outcomeEvidence, 'SMTP_ACCEPTED_INTENDED_RECIPIENT');
assert.deepEqual(
  (({ outcome, smtpCode, smtpStage }) => ({ outcome, smtpCode, smtpStage }))(classifyReplySmtpOutcome({
    error: { responseCode: 550, command: 'RCPT TO' }, recipient: 'buyer@example.invalid'
  })),
  { outcome: 'FAILED', smtpCode: 550, smtpStage: 'RCPT_TO' }
);
assert.equal(classifyReplySmtpOutcome({
  error: { responseCode: 550, command: 'RCPT TO' }, recipient: 'buyer@example.invalid'
}).outcomeEvidence, 'SMTP_RECIPIENT_REJECTED');
assert.equal(classifyReplySmtpOutcome({
  error: { responseCode: 550 }, recipient: 'buyer@example.invalid'
}).outcome, 'UNKNOWN', 'a response code without a known SMTP stage is not sufficient proof');
assert.equal(classifyReplySmtpOutcome({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', command: 'DATA' }), recipient: 'buyer@example.invalid' }).outcome, 'UNKNOWN');
assert.equal(classifyReplySmtpOutcome({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', command: 'DATA' }), recipient: 'buyer@example.invalid' }).outcomeEvidence, 'SMTP_ACCEPTANCE_UNCERTAIN');
assert.equal(classifyReplySmtpOutcome({ error: Object.assign(new Error('connection lost'), { code: 'ECONNRESET', command: 'CONN' }), recipient: 'buyer@example.invalid' }).outcome, 'UNKNOWN');
assert.equal(classifyReplySmtpOutcome({
  result: { response: '550 recipient rejected', responseCode: 550, rejected: ['buyer@example.invalid'] },
  recipient: 'buyer@example.invalid'
}).outcome, 'FAILED');
assert.equal(classifyReplySmtpOutcome({
  result: { response: '250 accepted', accepted: ['different@example.invalid'] },
  recipient: 'buyer@example.invalid'
}).outcome, 'UNKNOWN');

let smtpCalls = 0;
const sentRepository = makeRepository();
const sendSuccessfully = createResponseDraftSender({
  repository: sentRepository,
  idFactory: () => 'attempt-sent-1'
});
const sent = await sendSuccessfully({
  draftId: '71', actorEmail: 'admin@example.invalid',
  sendMail: async draft => {
    smtpCalls += 1;
    assert.equal(draft.recipient_email, 'buyer@example.invalid');
    return { response: '250 accepted', accepted: [draft.recipient_email], messageId: '<reply-71@example.invalid>' };
  }
});
assert.equal(sent.outcome, 'SENT');
assert.equal(sentRepository.record.send_state, 'SENT');
assert.equal(sentRepository.record.provider_message_id, '<reply-71@example.invalid>');
assert.equal(sentRepository.audits.length, 2, 'claim and final state must both be audited');

const unapprovedRepository = makeRepository();
unapprovedRepository.record.status = 'PENDING_APPROVAL';
let unapprovedSends = 0;
await assert.rejects(() => createResponseDraftSender({ repository: unapprovedRepository })({
  draftId: '71', actorEmail: 'admin@example.invalid', sendMail: async () => { unapprovedSends += 1; }
}), /approved response draft/i);
assert.equal(unapprovedSends, 0);

const failedRepository = makeRepository();
const sendRejected = createResponseDraftSender({ repository: failedRepository, idFactory: () => 'attempt-failed-1' });
const failed = await sendRejected({
  draftId: '71', actorEmail: 'admin@example.invalid',
  sendMail: async () => { throw Object.assign(new Error('server rejected'), { responseCode: 550, command: 'RCPT TO' }); }
});
assert.equal(failed.outcome, 'FAILED');
assert.equal(failedRepository.record.send_state, 'FAILED');
assert.equal(failedRepository.record.outcome_evidence, 'SMTP_RECIPIENT_REJECTED');
assert.match(failedRepository.record.send_error, /SMTP_REJECTED_RCPT_TO_550/);
const retryAfterRejection = await createResponseDraftSender({ repository: failedRepository, idFactory: () => 'attempt-retry-1' })({
  draftId: '71', actorEmail: 'admin@example.invalid',
  sendMail: async () => ({ response: '250 accepted', accepted: ['buyer@example.invalid'] })
});
assert.equal(retryAfterRejection.outcome, 'SENT', 'a persisted definitive rejection may be retried once through a fresh claim');

const unknownRepository = makeRepository();
const sendUnknown = createResponseDraftSender({ repository: unknownRepository, idFactory: () => 'attempt-unknown-1' });
const unknown = await sendUnknown({
  draftId: '71', actorEmail: 'admin@example.invalid',
  sendMail: async () => { throw Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT', command: 'DATA' }); }
});
assert.equal(unknown.outcome, 'UNKNOWN');
assert.equal(unknownRepository.record.send_state, 'UNKNOWN');
await assert.rejects(() => sendUnknown({ draftId: '71', actorEmail: 'admin@example.invalid', sendMail: async () => { smtpCalls += 1; } }), /no longer eligible/i);

for (const blockedState of ['SENDING', 'UNKNOWN', 'SENT']) {
  const blockedRepository = makeRepository({ state: blockedState });
  let blockedSends = 0;
  await assert.rejects(() => createResponseDraftSender({ repository: blockedRepository })({
    draftId: '71', actorEmail: 'admin@example.invalid', sendMail: async () => { blockedSends += 1; }
  }), /no longer eligible/i);
  assert.equal(blockedSends, 0, `${blockedState} must never be automatically reclaimed`);
}

const concurrentRepository = makeRepository();
let concurrentSends = 0;
const concurrentSender = createResponseDraftSender({ repository: concurrentRepository, idFactory: (() => {
  let sequence = 0;
  return () => `concurrent-${++sequence}`;
})() });
const concurrentResults = await Promise.allSettled([
  concurrentSender({ draftId: '71', actorEmail: 'admin@example.invalid', sendMail: async () => { concurrentSends += 1; return { response: '250 accepted', accepted: ['buyer@example.invalid'] }; } }),
  concurrentSender({ draftId: '71', actorEmail: 'admin@example.invalid', sendMail: async () => { concurrentSends += 1; return { response: '250 accepted', accepted: ['buyer@example.invalid'] }; } })
]);
assert.equal(concurrentResults.filter(result => result.status === 'fulfilled').length, 1);
assert.equal(concurrentSends, 1, 'only the conditional claim winner may submit SMTP');

const auditFailureRepository = makeRepository({ auditClaimFails: true });
let auditFailureSends = 0;
await assert.rejects(() => createResponseDraftSender({ repository: auditFailureRepository })({
  draftId: '71', actorEmail: 'admin@example.invalid', sendMail: async () => { auditFailureSends += 1; }
}));
assert.equal(auditFailureSends, 0, 'claim audit failure must prevent SMTP');

const finalizeFailureRepository = makeRepository({ finalizeFails: true });
await assert.rejects(() => createResponseDraftSender({ repository: finalizeFailureRepository })({
  draftId: '71', actorEmail: 'admin@example.invalid',
  sendMail: async () => ({ response: '250 accepted', accepted: ['buyer@example.invalid'] })
}), error => error.code === 'RESPONSE_DRAFT_FINALIZATION_UNCONFIRMED' && error.smtpAccepted === true);
assert.equal(finalizeFailureRepository.record.send_state, 'SENDING', 'failed finalization leaves the claimed attempt blocked');

const changedIdentityRepository = makeRepository();
let inspectCount = 0;
changedIdentityRepository.inspect = async () => {
  inspectCount += 1;
  return inspectCount === 1
    ? { ...changedIdentityRepository.record }
    : { ...changedIdentityRepository.record, recipient_email: 'other@example.invalid' };
};
let changedIdentitySends = 0;
const changedIdentityResult = await createResponseDraftSender({ repository: changedIdentityRepository })({
  draftId: '71', actorEmail: 'admin@example.invalid',
  sendMail: async () => { changedIdentitySends += 1; return { response: '250 accepted', accepted: ['buyer@example.invalid'] }; }
});
assert.equal(changedIdentityResult.outcome, 'FAILED');
assert.equal(changedIdentitySends, 0, 'recipient identity changes after claim must block SMTP submission');

console.log('Offline response-draft sender lifecycle tests passed.');
