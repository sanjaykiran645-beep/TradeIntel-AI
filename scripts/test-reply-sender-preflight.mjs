import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { migrationPlan, migrationPlanThrough } from '../api/_migration-plan.js';
import {
  REPLY_SENDER_BASE_COLUMNS,
  REPLY_SENDER_COLUMNS_007,
  REPLY_SENDER_FUNCTION_SOURCE_HASHES,
  REPLY_SENDER_MIGRATION_CHECKSUMS,
  assessReplySenderRuntimeMetadata,
  assessReplySenderStage,
  replySenderStageVersions,
  validateMigrationHistory
} from '../api/_reply-sender-readiness.js';
import {
  checkConstraintSemantics,
  expectedConstraintPass,
  probeValues,
  safeConstraintExpression,
  verifyRepositoryManifest
} from './preflight-reply-sender-migrations.mjs';
import { createResponseDraftSendRepository } from '../api/_reply-draft-send-db.js';
import { createResponseSendHandler } from '../api/_routes/response-send.js';

const checksums = {};
for (const migration of migrationPlan) {
  const sql = await readFile(new URL('../database/migrations/' + migration.file, import.meta.url));
  checksums[migration.version] = createHash('sha256').update(sql).digest('hex');
}
assert.deepEqual(await verifyRepositoryManifest(checksums), [],
  'the checked-in runner plan, migration checksums, and exact protected function sources agree');
const stagedVersions = [
  '007_response_draft_send_state',
  '008_reply_sender_boundary',
  '009_reply_sender_safety_hardening'
];
for (const version of stagedVersions) {
  const selected = migrationPlanThrough(version);
  assert.equal(selected.at(-1).version, version);
  assert.deepEqual(selected, migrationPlan.slice(0, migrationPlan.findIndex(item => item.version === version) + 1));
}
assert.throws(() => migrationPlanThrough('006_web_research_result_contract'), /checkpoint/i);

const roleNames = {
  owner: 'fixture_reply_owner',
  sender: 'fixture_reply_sender_group',
  app: 'fixture_app_login',
  senderLogin: 'fixture_sender_login',
  migrationLogin: 'fixture_migration_login'
};
const signatures = {
  claim: 'public.claim_response_draft_send(bigint,uuid,text)',
  legacyFinalizer: 'public.finalize_response_draft_send(bigint,uuid,text,text,integer,text,text,text)',
  finalizerV2: 'public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text)'
};

const initialSchema = await readFile(new URL('../database/migrations/001_initial_schema.sql', import.meta.url), 'utf8');
const hardeningSql = await readFile(new URL('../database/migrations/009_reply_sender_safety_hardening.sql', import.meta.url), 'utf8');
assert.match(hardeningSql, /has_parameter_privilege/);
assert.doesNotMatch(hardeningSql, /has_schema_privilege\([^)]*WITH GRANT OPTION/i,
  'schema grant options are verified through ACL metadata, not an unsupported has_schema_privilege form');
const sqlTypeToUdt = { bigint: 'int8', integer: 'int4', text: 'text', boolean: 'bool', timestamptz: 'timestamptz', jsonb: 'jsonb' };
const parsedBaseColumns = [];
for (const tableName of Object.keys(REPLY_SENDER_BASE_COLUMNS)) {
  const definition = initialSchema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}\\s*\\(([\\s\\S]*?)\\n\\s*\\);`, 'i'))?.[1];
  assert.ok(definition, `001_initial_schema.sql contains the ${tableName} table`);
  for (const [columnName, expectedType] of Object.entries(REPLY_SENDER_BASE_COLUMNS[tableName])) {
    const line = definition.split(/\r?\n/).find(item => new RegExp(`^\\s*${columnName}\\s+`, 'i').test(item));
    const sqlType = line?.trim().match(new RegExp(`^${columnName}\\s+([a-z]+)`, 'i'))?.[1]?.toLowerCase();
    assert.equal(sqlTypeToUdt[sqlType], expectedType, `001 ${tableName}.${columnName} has expected type ${expectedType}`);
    parsedBaseColumns.push({ table_name: tableName, column_name: columnName, udt_name: sqlTypeToUdt[sqlType] });
  }
}
function makeFunction(key, owner, securityDefiner, executeGrantees, sourceHash, returnTypeMatches = true) {
  return {
    exists: true,
    ownerName: owner,
    securityDefiner,
    searchPathPinned: true,
    sourceHash,
    sourceMatches: true,
    returnTypeMatches,
    executeGrantees
  };
}
function makeRoles() {
  return {
    owner: { exists: true, canLogin: false, superuser: false },
    sender: { exists: true, canLogin: false, superuser: false },
    app: { exists: true, canLogin: true, superuser: false, tableOwner: false, memberOfOwner: false, memberOfSender: false, directDelete: false, directTruncate: false, canSetSessionReplicationRole: false },
    senderLogin: { exists: true, canLogin: true, superuser: false, tableOwner: false, memberOfOwner: false, memberOfSender: true, directInsert: false, directUpdate: false, directDelete: false, directTruncate: false, canSetSessionReplicationRole: false },
    migrationLogin: {
      exists: true, canLogin: true, superuser: false, createRole: false, createDb: false, replication: false, bypassRls: false,
      tableOwner: true, targetTableOwner: true, publicCreateWithGrant: true,
      memberOfOwner: true, memberOfSender: false, memberOfApp: false, canSetSessionReplicationRole: false
    }
  };
}
function makeFixture(stage) {
  const versions = replySenderStageVersions(stage);
  const columns = [...parsedBaseColumns];
  const addColumn = (table_name, column_name, udt_name, properties = {}) => columns.push({ table_name, column_name, udt_name, ...properties });
  const after007 = stage !== 'before';
  const after008 = stage === 'after:008' || stage === 'after:009';
  const after009 = stage === 'after:009';
  if (after007) for (const [column_name, udt_name] of Object.entries(REPLY_SENDER_COLUMNS_007)) {
    addColumn('response_drafts', column_name, udt_name,
      column_name === 'send_state' ? { is_nullable: 'NO', column_default: "'NOT_SENT'::text" } : { is_nullable: 'YES', column_default: null });
  }
  if (after008) addColumn('response_drafts', 'send_attempt_id', 'uuid', { is_nullable: 'YES', column_default: null });

  const history = versions.map((version, index) => ({ version, checksum: checksums[version], applied_epoch: String(index + 100) }));
  const artifacts = {
    send_state: after007,
    send_attempt_id: after008,
    claim: after008 || after009,
    legacyFinalizer: after008 && !after009,
    finalizerV2: after009,
    writerGuard: after008,
    send_attempt_id_constraint: after008,
    insertTrigger: after009,
    updateTrigger: after008 || after009
  };
  const constraints = {};
  if (after007) {
    for (const name of ['response_drafts_send_state_check', 'response_drafts_send_timestamps_check', 'response_drafts_send_error_check']) {
      constraints[name] = { validated: true, semanticValid: true };
    }
  }
  if (after008) constraints.response_drafts_send_attempt_id_check = { validated: true, semanticValid: true };

  const functions = {};
  if (after008) {
    functions.claim = makeFunction('claim', roleNames.owner, true, [roleNames.owner, roleNames.sender], REPLY_SENDER_FUNCTION_SOURCE_HASHES.claim);
    functions.legacyFinalizer = makeFunction('legacyFinalizer', roleNames.owner, true, [roleNames.owner, roleNames.sender], REPLY_SENDER_FUNCTION_SOURCE_HASHES.legacyFinalizer);
    functions.writerGuard = makeFunction('writerGuard', roleNames.migrationLogin, false,
      after009 ? [roleNames.migrationLogin] : [roleNames.migrationLogin, 'PUBLIC'], REPLY_SENDER_FUNCTION_SOURCE_HASHES.writerGuard);
  }
  if (after009) {
    delete functions.legacyFinalizer;
    functions.finalizerV2 = makeFunction('finalizerV2', roleNames.owner, true, [roleNames.owner, roleNames.sender], REPLY_SENDER_FUNCTION_SOURCE_HASHES.finalizerV2);
  }
  const ownerFunctions = after009
    ? [signatures.claim, signatures.finalizerV2]
    : after008 ? [signatures.claim, signatures.legacyFinalizer] : [];
  return {
    stage,
    serverVersion: 160000,
    columns,
    primaryKeys: {
      response_drafts: ['id'], inbox_messages: ['id'], contacts: ['id'], outreach_emails: ['id'], audit_logs: ['id']
    },
    history,
    historyVersionUnique: true,
    rowCounts: after007 ? { invalidState: 0, invalidTimestamps: 0, invalidError: 0, missingAttempt: 0, strayAttempt: 0 } : null,
    roles: makeRoles(),
    configuredRoles: roleNames,
    connectionRoles: { application: roleNames.app, sender: roleNames.senderLogin, migration: roleNames.migrationLogin },
    requireMigrationConnection: true,
    senderGroupLoginMembers: [roleNames.senderLogin],
    ownerGroupLoginMembers: [roleNames.migrationLogin],
    senderLoginMemberships: [roleNames.sender],
    migrationLoginMemberships: [roleNames.owner],
    procedurePrivileges: { ownerRequired: after008 },
    rowSecurityTables: [],
    migrationPrerequisiteBlockers: [],
    functions,
    ownerSecurityDefinerFunctions: ownerFunctions,
    senderExecutableSecurityDefinerFunctions: after009 ? [signatures.claim, signatures.finalizerV2] : [],
    triggers: {
      ...(after009 ? { insert: { enabledMode: 'O', eventMask: 7, columns: [], functionSignature: 'public.guard_response_draft_send_state_writer()' } } : {}),
      ...(after008 ? { update: { enabledMode: 'O', eventMask: 19, columns: ['send_state', 'send_attempted_at', 'send_attempt_id', 'send_error', 'sent_at', 'provider_message_id'], functionSignature: 'public.guard_response_draft_send_state_writer()' } } : {})
    },
    constraints,
    artifacts
  };
}
const fullExpected = versions => versions.map(version => ({ version, checksum: checksums[version], applied_epoch: String(100 + migrationPlan.findIndex(row => row.version === version)) }));

const before = makeFixture('before');
assert.equal(assessReplySenderStage(before, 'before', checksums).status, 'READY_TO_APPLY_007',
  'the real 001 baseline shape with history through 006 is accepted without reply-send columns');

for (const [stage, expected] of [
  ['after:007', 'READY_TO_APPLY_008'],
  ['after:008', 'READY_TO_APPLY_009'],
  ['after:009', 'READY_FOR_ADMIN_REVIEW']
]) {
  assert.equal(assessReplySenderStage(makeFixture(stage), stage, checksums).status, expected);
}
assert.equal(assessReplySenderRuntimeMetadata({ ...makeFixture('after:009'), requireMigrationConnection: false }).ok, true);

assert.ok(assessReplySenderStage({ ...before, artifacts: { ...before.artifacts, send_state: true } }, 'before', checksums).status === 'BLOCKED',
  'reply-send schema present before 007 is treated as partial or ambiguous');
assert.equal(assessReplySenderStage({ ...before, artifacts: { ...before.artifacts, send_error: true } }, 'before', checksums).status, 'BLOCKED',
  'a partial 007 column set blocks the before-migrations checkpoint');
assert.equal(validateMigrationHistory([], 'before', checksums).length > 0, true, 'missing history blocks readiness');
const validHistory = before.history;
assert.ok(validateMigrationHistory(validHistory, 'before', checksums).length === 0);
assert.ok(validateMigrationHistory([...validHistory, { ...validHistory[0] }], 'before', checksums).some(message => message.includes('records')),
  'duplicate history rows block readiness');
const outOfOrder = [...validHistory];
[outOfOrder[1], outOfOrder[2]] = [outOfOrder[2], outOfOrder[1]];
assert.ok(validateMigrationHistory(outOfOrder, 'before', checksums).some(message => message.includes('sequential')),
  'out-of-order history blocks readiness');
assert.ok(validateMigrationHistory(validHistory.map((row, index) => index === 1 ? { ...row, applied_epoch: '100' } : row), 'before', checksums)
  .some(message => message.includes('timestamps')),
  'tied or out-of-order applied timestamps block readiness');

for (const version of ['007_response_draft_send_state', '008_reply_sender_boundary', '009_reply_sender_safety_hardening']) {
  const fixture = makeFixture('after:009');
  fixture.history = fixture.history.map(row => row.version === version ? { ...row, checksum: 'mismatch' } : row);
  assert.equal(assessReplySenderStage(fixture, 'after:009', checksums).status, 'BLOCKED', version + ' checksum mismatch blocks readiness');
}
const partial = makeFixture('after:008');
partial.history = partial.history.slice(0, -1);
assert.equal(assessReplySenderStage(partial, 'after:008', checksums).status, 'BLOCKED', 'partial migration sequence blocks readiness');
const after007WithAttempt = makeFixture('after:007');
after007WithAttempt.columns.push({ table_name: 'response_drafts', column_name: 'send_attempt_id', udt_name: 'uuid' });
assert.equal(assessReplySenderStage(after007WithAttempt, 'after:007', checksums).status, 'BLOCKED');
const missingColumn = makeFixture('after:009');
missingColumn.columns = missingColumn.columns.filter(column => column.column_name !== 'send_attempt_id');
assert.equal(assessReplySenderStage(missingColumn, 'after:009', checksums).status, 'BLOCKED');
const nullableSendState = makeFixture('after:009');
nullableSendState.columns.find(column => column.column_name === 'send_state').is_nullable = 'YES';
assert.equal(assessReplySenderStage(nullableSendState, 'after:009', checksums).status, 'BLOCKED');
const missingPrimaryKey = makeFixture('after:009');
delete missingPrimaryKey.primaryKeys.response_drafts;
assert.equal(assessReplySenderStage(missingPrimaryKey, 'after:009', checksums).status, 'BLOCKED');
const missingConstraint = makeFixture('after:009');
delete missingConstraint.constraints.response_drafts_send_attempt_id_check;
assert.equal(assessReplySenderStage(missingConstraint, 'after:009', checksums).status, 'BLOCKED');
const missingProcedure = makeFixture('after:009');
missingProcedure.functions.finalizerV2.exists = false;
assert.equal(assessReplySenderStage(missingProcedure, 'after:009', checksums).status, 'BLOCKED');

const replicaOnly = makeFixture('after:009');
replicaOnly.triggers.insert.enabledMode = 'R';
assert.equal(assessReplySenderStage(replicaOnly, 'after:009', checksums).status, 'BLOCKED',
  'replica-only triggers do not count as active for ordinary sessions');
const disabledTrigger = makeFixture('after:009');
disabledTrigger.triggers.update.enabledMode = 'D';
assert.equal(assessReplySenderStage(disabledTrigger, 'after:009', checksums).status, 'BLOCKED');
const wrongTriggerFunction = makeFixture('after:009');
wrongTriggerFunction.triggers.insert.functionSignature = 'public.unrelated_trigger()';
assert.equal(assessReplySenderStage(wrongTriggerFunction, 'after:009', checksums).status, 'BLOCKED',
  'enabled trigger shape is insufficient unless it invokes the reviewed guard function');
const badOwner = makeFixture('after:009');
badOwner.functions.claim.ownerName = 'unexpected_owner';
assert.equal(assessReplySenderStage(badOwner, 'after:009', checksums).status, 'BLOCKED');
const badGrant = makeFixture('after:009');
badGrant.functions.finalizerV2.executeGrantees = ['PUBLIC', roleNames.sender];
assert.equal(assessReplySenderStage(badGrant, 'after:009', checksums).status, 'BLOCKED');
const unsafeRole = makeFixture('after:009');
unsafeRole.roles.senderLogin.superuser = true;
assert.equal(assessReplySenderStage(unsafeRole, 'after:009', checksums).status, 'BLOCKED');
const replicaRoleGrant = makeFixture('after:009');
replicaRoleGrant.roles.app.canSetSessionReplicationRole = true;
assert.equal(assessReplySenderStage(replicaRoleGrant, 'after:009', checksums).status, 'BLOCKED',
  'an otherwise enabled origin trigger is not accepted when the app login can set replica mode');
const missingServerVersion = makeFixture('after:009');
missingServerVersion.serverVersion = 0;
assert.equal(assessReplySenderStage(missingServerVersion, 'after:009', checksums).status, 'BLOCKED');
const extraMembership = makeFixture('after:009');
extraMembership.migrationLoginMemberships.push('pg_write_all_data');
assert.equal(assessReplySenderStage(extraMembership, 'after:009', checksums).status, 'BLOCKED');
const deletableApp = makeFixture('after:009');
deletableApp.roles.app.directDelete = true;
assert.equal(assessReplySenderStage(deletableApp, 'after:009', checksums).status, 'BLOCKED');

const validStateDefinition = "CHECK (send_state IN ('NOT_SENT','SENDING','SENT','FAILED','UNKNOWN'))";
assert.ok(safeConstraintExpression(validStateDefinition, ['send_state'], ['NOT_SENT', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN']));
assert.equal(safeConstraintExpression("CHECK (send_state IN ('NOT_SENT','SENDING','SENT','FAILED','UNKNOWN') OR true)", ['send_state'], ['NOT_SENT', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN']), null,
  'semantic probe refuses non-allowlisted operators and tautologies');
for (const name of [
  'response_drafts_send_state_check',
  'response_drafts_send_timestamps_check',
  'response_drafts_send_error_check',
  'response_drafts_send_attempt_id_check'
]) {
  const values = probeValues();
  const client = { query: async sql => {
    assert.match(sql, /^WITH probe/);
    return { rows: values.map(item => ({ accepted: expectedConstraintPass(name, item.row) })) };
  } };
  const definition = name === 'response_drafts_send_state_check'
    ? validStateDefinition
    : name === 'response_drafts_send_timestamps_check'
      ? "CHECK ((send_state='NOT_SENT' AND send_attempted_at IS NULL AND sent_at IS NULL) OR (send_state IN ('SENDING','FAILED','UNKNOWN') AND send_attempted_at IS NOT NULL AND sent_at IS NULL) OR (send_state='SENT' AND send_attempted_at IS NOT NULL AND sent_at IS NOT NULL))"
      : name === 'response_drafts_send_error_check'
        ? "CHECK ((send_state IN ('FAILED','UNKNOWN') AND NULLIF(btrim(send_error),'') IS NOT NULL) OR (send_state NOT IN ('FAILED','UNKNOWN') AND send_error IS NULL))"
        : "CHECK ((send_state='NOT_SENT' AND send_attempt_id IS NULL) OR (send_state<>'NOT_SENT' AND send_attempt_id IS NOT NULL))";
  assert.equal(await checkConstraintSemantics(client, name, definition), true, name + ' semantic truth-table check passes its isolated fixture');
}

const runtimeEnv = {
  DATABASE_URL: 'postgres://app@db.example.invalid:5432/tradeintel',
  DATABASE_DIRECT_URL: 'postgres://migration@db.example.invalid:5432/tradeintel',
  REPLY_SENDER_DATABASE_URL: 'postgres://sender@db.example.invalid:5432/tradeintel',
  REPLY_SEND_OWNER_ROLE: roleNames.owner,
  REPLY_SENDER_ROLE: roleNames.sender,
  REPLY_SEND_APP_ROLE: roleNames.app,
  REPLY_SENDER_LOGIN_ROLE: roleNames.senderLogin,
  REPLY_SEND_MIGRATION_LOGIN_ROLE: roleNames.migrationLogin
};
function mockClient() {
  const calls = [];
  return {
    calls,
    released: false,
    async query(sql) { calls.push(String(sql)); return { rows: [] }; },
    release() { this.released = true; }
  };
}
function mockDatabaseClient() {
  return {
    query: async () => ({ rows: [] }),
    async withReadOnlyTransaction(callback) { return callback(this); }
  };
}
const notConfiguredRepo = createResponseDraftSendRepository({
  env: {},
  databaseClient: mockDatabaseClient(),
  connectSenderClient: async () => { throw new Error('must not connect'); }
});
await assert.rejects(() => notConfiguredRepo.assertReady(), error => error.code === 'REPLY_SENDER_NOT_READY');
const malformedConfigRepo = createResponseDraftSendRepository({
  env: { ...runtimeEnv, REPLY_SEND_OWNER_ROLE: 'x'.repeat(64) },
  databaseClient: mockDatabaseClient(),
  connectSenderClient: async () => { throw new Error('invalid configuration must fail before connecting'); }
});
await assert.rejects(() => malformedConfigRepo.assertReady(), error => error.code === 'REPLY_SENDER_NOT_READY');
const duplicateRoleRepo = createResponseDraftSendRepository({
  env: { ...runtimeEnv, REPLY_SEND_OWNER_ROLE: roleNames.sender },
  databaseClient: mockDatabaseClient(),
  connectSenderClient: async () => { throw new Error('duplicate roles must fail before connecting'); }
});
await assert.rejects(() => duplicateRoleRepo.assertReady(), error => error.code === 'REPLY_SENDER_NOT_READY');
const mismatchedMigrationTargetRepo = createResponseDraftSendRepository({
  env: { ...runtimeEnv, DATABASE_DIRECT_URL: 'postgres://migration@other.example.invalid:5432/other' },
  databaseClient: mockDatabaseClient(),
  connectSenderClient: async () => { throw new Error('mismatched migration target must fail before connecting'); }
});
await assert.rejects(() => mismatchedMigrationTargetRepo.assertReady(), error => error.code === 'REPLY_SENDER_NOT_READY');

let connectCount = 0;
const validReadinessClient = mockClient();
const validRepo = createResponseDraftSendRepository({
  env: runtimeEnv,
  databaseClient: mockDatabaseClient(),
  connectSenderClient: async () => { connectCount += 1; return validReadinessClient; },
  collectReadinessMetadata: async () => ({ ...makeFixture('after:009'), requireMigrationConnection: false })
});
await validRepo.assertReady();
assert.equal(connectCount, 1);
assert.ok(validReadinessClient.calls.includes('BEGIN READ ONLY'));
assert.ok(validReadinessClient.calls.includes('COMMIT'));
assert.equal(validReadinessClient.released, true);

const metadataErrorClient = mockClient();
const metadataErrorRepo = createResponseDraftSendRepository({
  env: runtimeEnv,
  databaseClient: mockDatabaseClient(),
  connectSenderClient: async () => metadataErrorClient,
  collectReadinessMetadata: async () => { throw new Error('catalog unavailable'); }
});
await assert.rejects(() => metadataErrorRepo.assertReady(), error => error.code === 'REPLY_SENDER_NOT_READY');
assert.ok(metadataErrorClient.calls.includes('ROLLBACK'));
assert.equal(metadataErrorClient.released, true);

const ambiguousReadinessClient = mockClient();
const ambiguousRepo = createResponseDraftSendRepository({
  env: runtimeEnv,
  databaseClient: mockDatabaseClient(),
  connectSenderClient: async () => ambiguousReadinessClient,
  collectReadinessMetadata: async () => {
    const fixture = makeFixture('after:009');
    fixture.history.pop();
    return { ...fixture, requireMigrationConnection: false };
  }
});
await assert.rejects(() => ambiguousRepo.assertReady(), error => error.code === 'REPLY_SENDER_NOT_READY');
assert.ok(ambiguousReadinessClient.calls.includes('ROLLBACK'));

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; }
  };
}
let transportCalls = 0;
let smtpSubmitCalls = 0;
let configCalls = 0;
const blockedHandler = createResponseSendHandler({
  setCorsFn() {},
  requireAuthFn: async () => true,
  env: { EMAIL_SENDING_ENABLED: 'true' },
  assertReadyFn: async () => { throw Object.assign(new Error('not ready'), { code: 'REPLY_SENDER_NOT_READY' }); },
  getHostingerConfigFn: async () => { configCalls += 1; return { smtpConfigured: true, smtp: {} }; },
  createTransporterFn: () => { transportCalls += 1; return { sendMail: async () => { smtpSubmitCalls += 1; } }; },
  sendDraftFn: async () => ({ outcome: 'SENT' })
});
const blockedResponse = response();
await blockedHandler({ method: 'POST', body: { id: '71' }, user: { email: 'admin@example.invalid' } }, blockedResponse);
assert.equal(blockedResponse.statusCode, 503);
assert.equal(configCalls, 0, 'database readiness failure happens before SMTP configuration is loaded');
assert.equal(transportCalls, 0, 'database readiness failure happens before transporter creation');
assert.equal(smtpSubmitCalls, 0, 'database readiness failure prevents SMTP submission');

const successfulHandler = createResponseSendHandler({
  setCorsFn() {},
  requireAuthFn: async () => true,
  env: { EMAIL_SENDING_ENABLED: 'true' },
  assertReadyFn: async () => {},
  getHostingerConfigFn: async () => ({ smtpConfigured: true, smtp: {
    host: 'smtp.example.invalid', port: 465, secure: true, user: 'fixture', pass: 'fixture',
    fromName: 'TradeIntel', fromEmail: 'from@example.invalid'
  } }),
  createTransporterFn: () => ({ sendMail: async () => { smtpSubmitCalls += 1; return {}; } }),
  sendDraftFn: async ({ sendMail }) => {
    await sendMail({ recipient_email: 'buyer@example.invalid', subject: 'Reply', body_text: 'Offline fixture' });
    return { outcome: 'SENT', attemptId: 'attempt-1' };
  }
});
const successResponse = response();
await successfulHandler({ method: 'POST', body: { id: '71' }, user: { email: 'admin@example.invalid' } }, successResponse);
assert.equal(successResponse.statusCode, 200);
assert.equal(smtpSubmitCalls, 1);

console.log('Reply-sender preflight stages and runtime readiness-gate fixtures passed. PostgreSQL catalog behavior was not exercised.');
