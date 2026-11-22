import { createHash } from 'node:crypto';
import { migrationPlan } from './_migration-plan.js';

export const REPLY_SENDER_MIGRATION_CHECKSUMS = Object.freeze({
  '007_response_draft_send_state': 'e025f598153b3206b80a8ed382981e792de4c9071623b11fc8ef62d4a7c65003',
  '008_reply_sender_boundary': 'c028302f6d1fe17fb53fcb35a5a4e40dbc9e2aa3dbc62fa8980464a327d28948',
  '009_reply_sender_safety_hardening': 'ce872e85e76fb636ea72b649d93692c3485ae7575d5637c6248688cde2b61956'
});

export const REPLY_SENDER_FUNCTION_SOURCE_HASHES = Object.freeze({
  claim: 'dd79afdf5e4b2d0ff875edc4ea945789a31f08ede39b2c8eebf12a06edf29fe5',
  legacyFinalizer: 'ce88627c94a913a886ff156e60d6e922665b63e430c45ba87f6ff739a8eeb9d9',
  finalizerV2: 'ed21ae6cce051c1006ed3eeb89782b0f84abcae2acacd37fd41c26608b202972',
  writerGuard: '669c5f01880c8914b328777dca58899e49c83464e2da020aeb0898e3a64642fd'
});

export const REPLY_SENDER_REQUIRED_ENV = Object.freeze([
  'DATABASE_URL',
  'DATABASE_DIRECT_URL',
  'REPLY_SENDER_DATABASE_URL',
  'REPLY_SEND_OWNER_ROLE',
  'REPLY_SENDER_ROLE',
  'REPLY_SEND_APP_ROLE',
  'REPLY_SENDER_LOGIN_ROLE',
  'REPLY_SEND_MIGRATION_LOGIN_ROLE'
]);

export const REPLY_SENDER_BASE_COLUMNS = Object.freeze({
  response_drafts: { id: 'int8', dataset_id: 'int8', inbox_message_id: 'int8', recipient_email: 'text', subject: 'text', body_text: 'text', status: 'text' },
  inbox_messages: { id: 'int8', dataset_id: 'int8', contact_id: 'int8', outreach_id: 'int8', sender_email: 'text', intent: 'text' },
  contacts: { id: 'int8', dataset_id: 'int8', email: 'text', verification_status: 'text', is_suppressed: 'bool' },
  outreach_emails: { id: 'int8', dataset_id: 'int8', status: 'text' },
  audit_logs: { id: 'int8', dataset_id: 'int8', user_email: 'text', action: 'text', entity_type: 'text', entity_id: 'text', details: 'jsonb', created_at: 'timestamptz' },
  schema_migrations: { version: 'text', checksum: 'text', applied_at: 'timestamptz' }
});

export const REPLY_SENDER_COLUMNS_007 = Object.freeze({
  send_state: 'text', send_attempted_at: 'timestamptz', send_error: 'text', sent_at: 'timestamptz', provider_message_id: 'text'
});

const TABLE_NAME = 'public.response_drafts';
const REQUIRED_PRIMARY_KEYS = Object.freeze({
  response_drafts: ['id'],
  inbox_messages: ['id'],
  contacts: ['id'],
  outreach_emails: ['id'],
  audit_logs: ['id']
});
const FUNCTION_SIGNATURES = Object.freeze({
  claim: 'public.claim_response_draft_send(bigint,uuid,text)',
  legacyFinalizer: 'public.finalize_response_draft_send(bigint,uuid,text,text,integer,text,text,text)',
  finalizerV2: 'public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text)',
  writerGuard: 'public.guard_response_draft_send_state_writer()'
});

const STAGES = Object.freeze({
  before: '006_web_research_result_contract',
  'after:007': '007_response_draft_send_state',
  'after:008': '008_reply_sender_boundary',
  'after:009': '009_reply_sender_safety_hardening'
});

function roleName(env, key) {
  return String(env?.[key] || '').trim();
}

export function validateReplySenderConfiguration(env = process.env) {
  const missing = REPLY_SENDER_REQUIRED_ENV.filter(name => !roleName(env, name));
  const roleKeys = ['REPLY_SEND_OWNER_ROLE', 'REPLY_SENDER_ROLE', 'REPLY_SEND_APP_ROLE', 'REPLY_SENDER_LOGIN_ROLE', 'REPLY_SEND_MIGRATION_LOGIN_ROLE'];
  const invalid = roleKeys.filter(name => {
    const value = roleName(env, name);
    return value.length > 0 && (Buffer.byteLength(value, 'utf8') > 63 || value.includes('\0'));
  });
  const configured = roleKeys.map(name => roleName(env, name)).filter(Boolean);
  const duplicateRoles = configured.length === roleKeys.length && new Set(configured).size !== configured.length;
  return { ok: missing.length === 0 && invalid.length === 0 && !duplicateRoles, missing, invalid, duplicateRoles };
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function replySenderStageVersions(stage) {
  const lastVersion = STAGES[stage];
  if (!lastVersion) return null;
  const lastIndex = migrationPlan.findIndex(item => item.version === lastVersion);
  return lastIndex < 0 ? null : migrationPlan.slice(0, lastIndex + 1).map(item => item.version);
}

function epochMicros(value) {
  const text = String(value ?? '');
  const match = /^(-?\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] || '').padEnd(6, '0').slice(0, 6));
  return whole * 1000000n + (whole < 0n ? -fraction : fraction);
}

export function validateMigrationHistory(rows, stage, expectedChecksums = {}) {
  const blockers = [];
  const expected = replySenderStageVersions(stage);
  if (!expected) return ['Unknown migration readiness stage.'];
  const history = Array.isArray(rows) ? rows : [];
  const counts = new Map();
  for (const row of history) counts.set(row.version, (counts.get(row.version) || 0) + 1);
  for (const [version, count] of counts) {
    if (count !== 1) blockers.push(`Migration history has ${count} records for ${version}.`);
  }

  const observed = history.map(row => row.version);
  if (observed.length !== expected.length || observed.some((version, index) => version !== expected[index])) {
    blockers.push(`Migration history does not match the required sequential prefix for stage ${stage}.`);
  }

  for (let index = 0; index < history.length; index += 1) {
    const row = history[index];
    const expectedChecksum = expectedChecksums[row.version];
    if (expectedChecksum && row.checksum !== expectedChecksum) {
      blockers.push(`Migration ${row.version} checksum differs from the checked-in migration.`);
    }
    const applied = epochMicros(row.applied_epoch);
    if (applied === null) {
      blockers.push(`Migration ${row.version} has a missing or invalid applied_at timestamp.`);
    } else if (index > 0) {
      const previous = epochMicros(history[index - 1].applied_epoch);
      if (previous !== null && applied <= previous) {
        blockers.push(`Migration history timestamps are tied or out of order at ${row.version}.`);
      }
    }
  }
  return blockers;
}

function columnKey(column) {
  return `${column.table_name}.${column.column_name}`;
}

function functionReady(fn, { owner, sender, sourceHash, securityDefiner = true, executeGrantees = [owner, sender] }) {
  if (!fn?.exists || fn.securityDefiner !== securityDefiner || fn.ownerName !== owner || !fn.searchPathPinned || !fn.sourceMatches || !fn.returnTypeMatches) return false;
  const allowed = [...executeGrantees].sort();
  const actual = [...(fn.executeGrantees || [])].sort();
  return actual.length === allowed.length && actual.every((role, index) => role === allowed[index]) &&
    (!sourceHash || fn.sourceHash === sourceHash);
}

function validTrigger(trigger, eventMask, columns = [], functionSignature) {
  if (!trigger || !['O', 'A'].includes(trigger.enabledMode) || trigger.eventMask !== eventMask ||
      (functionSignature && String(trigger.functionSignature || '').replace(/\s/g, '') !== functionSignature)) return false;
  return [...(trigger.columns || [])].sort().join(',') === [...columns].sort().join(',');
}

function roleBlockers(metadata) {
  const roles = metadata.roles || {};
  const owner = roles.owner;
  const sender = roles.sender;
  const app = roles.app;
  const senderLogin = roles.senderLogin;
  const migrationLogin = roles.migrationLogin;
  const blockers = [];
  if (!Number.isInteger(metadata.serverVersion) || metadata.serverVersion < 1) {
    blockers.push('PostgreSQL version and parameter privilege support could not be verified.');
  }
  const configuredRoleValues = Object.values(metadata.configuredRoles || {});
  if (configuredRoleValues.length !== 5 || new Set(configuredRoleValues).size !== 5 || configuredRoleValues.some(value => !value)) {
    blockers.push('Configured owner, sender, application, sender-login, and migration-login roles must be distinct and non-empty.');
  }
  for (const [name, role] of Object.entries({ owner, sender, app, senderLogin, migrationLogin })) {
    if (!role?.exists) blockers.push(`Configured ${name} role is missing.`);
  }
  if (owner?.exists && (owner.canLogin || owner.superuser)) blockers.push('Function owner must be a non-superuser NOLOGIN role.');
  if (sender?.exists && (sender.canLogin || sender.superuser)) blockers.push('Sender group must be a non-superuser NOLOGIN role.');
  if (app?.exists && (!app.canLogin || app.superuser || app.tableOwner || app.memberOfOwner || app.memberOfSender ||
      (metadata.stage === 'after:009' && (app.directDelete || app.directTruncate)))) {
    blockers.push('Application role can bypass or erase the reply-send state boundary.');
  }
  if (senderLogin?.exists && (!senderLogin.canLogin || senderLogin.superuser || senderLogin.tableOwner || senderLogin.memberOfOwner || !senderLogin.memberOfSender ||
      senderLogin.directInsert || senderLogin.directUpdate || senderLogin.directDelete || senderLogin.directTruncate)) {
    blockers.push('Restricted sender login is not a procedure-only non-privileged member of the sender group.');
  }
  if (metadata.senderLoginMemberships?.length !== 1 || metadata.senderLoginMemberships?.[0] !== metadata.configuredRoles?.sender) {
    blockers.push('Restricted sender login has role memberships beyond its dedicated sender group.');
  }
  if (migrationLogin?.exists && (!migrationLogin.canLogin || migrationLogin.superuser || migrationLogin.createRole || migrationLogin.createDb ||
      migrationLogin.replication || migrationLogin.bypassRls || migrationLogin.memberOfSender || migrationLogin.memberOfApp ||
      !migrationLogin.memberOfOwner || !migrationLogin.targetTableOwner || !migrationLogin.publicCreateWithGrant)) {
    blockers.push('Migration executor is not the configured least-privilege owner/table/schema migration login.');
  }
  for (const [name, role] of Object.entries({ app, senderLogin, migrationLogin })) {
    if (role?.canSetSessionReplicationRole === true ||
        (metadata.serverVersion >= 150000 && role?.exists && role.canSetSessionReplicationRole !== false)) {
      blockers.push(`Configured ${name} login can bypass ordinary triggers through session_replication_role or its grant is unverified.`);
    }
  }
  if (metadata.connectionRoles?.application !== metadata.configuredRoles?.app) blockers.push('Application database connection role does not match its configured role.');
  if (metadata.connectionRoles?.sender !== metadata.configuredRoles?.senderLogin) blockers.push('Sender connection role does not match its configured role.');
  if (metadata.requireMigrationConnection && metadata.connectionRoles?.migration !== metadata.configuredRoles?.migrationLogin) blockers.push('Migration executor connection role does not match its configured role.');
  if (metadata.senderGroupLoginMembers?.length !== 1 || metadata.senderGroupLoginMembers?.[0] !== metadata.configuredRoles?.senderLogin) {
    blockers.push('Only the configured restricted sender login may be a LOGIN member of the sender group.');
  }
  if (metadata.ownerGroupLoginMembers?.length !== 1 || metadata.ownerGroupLoginMembers?.[0] !== metadata.configuredRoles?.migrationLogin) {
    blockers.push('Only the configured migration login may be a non-superuser LOGIN member of the function-owner role.');
  }
  if (metadata.migrationLoginMemberships?.length !== 1 || metadata.migrationLoginMemberships?.[0] !== metadata.configuredRoles?.owner) {
    blockers.push('Migration executor has role memberships beyond its dedicated function-owner group.');
  }
  if (['after:008', 'after:009'].includes(metadata.stage) && metadata.procedurePrivileges?.ownerRequired !== true) {
    blockers.push('Function-owner table, audit, sequence, or schema privileges are incomplete.');
  }
  if (metadata.rowSecurityTables?.length) blockers.push('Row-level security is enabled on a reply-sender table and requires administrator review.');
  return blockers;
}

export function assessReplySenderStage(metadata, stage, expectedChecksums = {}) {
  const blockers = [];
  const versions = replySenderStageVersions(stage);
  if (!versions) return { status: 'BLOCKED', stage, blockers: ['Unknown migration readiness stage.'], observations: [] };
  blockers.push(...validateMigrationHistory(metadata.history, stage, expectedChecksums));
  if (metadata.historyVersionUnique !== true) blockers.push('schema_migrations.version is not protected by a unique or primary-key constraint.');

  const required = Object.entries(REPLY_SENDER_BASE_COLUMNS).flatMap(([table, fields]) =>
    Object.entries(fields).map(([column, type]) => ({ table_name: table, column_name: column, udt_name: type }))
  );
  const stageIndex = ['before', 'after:007', 'after:008', 'after:009'].indexOf(stage);
  if (stageIndex >= 1) required.push(...Object.entries(REPLY_SENDER_COLUMNS_007).map(([column_name, udt_name]) => ({ table_name: 'response_drafts', column_name, udt_name })));
  if (stageIndex >= 2) required.push({ table_name: 'response_drafts', column_name: 'send_attempt_id', udt_name: 'uuid' });
  const actualColumns = new Map((metadata.columns || []).map(column => [columnKey(column), column]));
  for (const column of required) {
    const found = actualColumns.get(`${column.table_name}.${column.column_name}`);
    if (!found) blockers.push(`Missing required column ${column.table_name}.${column.column_name} for stage ${stage}.`);
    else if (found.udt_name !== column.udt_name) blockers.push(`Column ${column.table_name}.${column.column_name} has an incompatible type.`);
  }
  for (const [table, expectedColumns] of Object.entries(REQUIRED_PRIMARY_KEYS)) {
    const primaryKey = metadata.primaryKeys?.[table] || [];
    if (primaryKey.join(',') !== expectedColumns.join(',')) blockers.push(`Table ${table} does not have the expected primary key.`);
  }

  const has = key => actualColumns.has(`response_drafts.${key}`);
  const artifacts = metadata.artifacts || {};
  if (stage === 'before') {
    if (['send_state', 'send_attempted_at', 'send_error', 'sent_at', 'provider_message_id', 'send_attempt_id',
      'send_attempt_id_constraint', 'claim', 'legacyFinalizer', 'finalizerV2', 'writerGuard', 'insertTrigger', 'updateTrigger'].some(key => artifacts[key]) ||
        Object.keys(metadata.constraints || {}).some(name => name.startsWith('response_drafts_send_'))) {
      blockers.push('Reply-sender schema artifacts exist before migration 007; starting stage is partial or ambiguous.');
    }
  }
  if (stage === 'after:007' || stage === 'after:008' || stage === 'after:009') {
    if (!['send_state', 'send_attempted_at', 'send_error', 'sent_at', 'provider_message_id'].every(has)) {
      blockers.push('Migration 007 result columns are incomplete.');
    }
    const constraints = metadata.constraints || {};
    const sendStateColumn = actualColumns.get('response_drafts.send_state');
    if (sendStateColumn?.is_nullable !== 'NO' || !/^\(?\s*'NOT_SENT'(?:::text)?\s*\)?$/i.test(String(sendStateColumn?.column_default || ''))) {
      blockers.push('Migration 007 send_state must remain NOT NULL with a NOT_SENT default.');
    }
    for (const columnName of ['send_attempted_at', 'send_error', 'sent_at', 'provider_message_id', 'send_attempt_id']) {
      const column = actualColumns.get(`response_drafts.${columnName}`);
      if (column && (column.is_nullable !== 'YES' || column.column_default != null)) {
        blockers.push(`Column response_drafts.${columnName} must remain nullable without a default.`);
      }
    }
    for (const name of ['response_drafts_send_state_check', 'response_drafts_send_timestamps_check', 'response_drafts_send_error_check']) {
      if (!constraints[name]?.validated || !constraints[name]?.semanticValid) blockers.push(`Constraint ${name} is missing, unvalidated, or semantically incompatible.`);
    }
    if (metadata.rowCounts && Object.values(metadata.rowCounts).some(value => Number(value) > 0)) blockers.push('Existing response_drafts rows violate the send-state invariant.');
  }
  if (stage === 'after:007' && (has('send_attempt_id') || artifacts.send_attempt_id_constraint || artifacts.claim || artifacts.legacyFinalizer || artifacts.finalizerV2 || artifacts.writerGuard || artifacts.insertTrigger || artifacts.updateTrigger)) {
    blockers.push('Schema includes 008/009 artifacts before the selected after:007 checkpoint.');
  }
  if (stage === 'after:008' || stage === 'after:009') {
    if (!has('send_attempt_id') || !metadata.constraints?.response_drafts_send_attempt_id_check?.validated ||
        !metadata.constraints?.response_drafts_send_attempt_id_check?.semanticValid) {
      blockers.push('Migration 008 attempt-ID column or semantic constraint is missing.');
    }
    if (!artifacts.claim || !artifacts.writerGuard || !validTrigger(metadata.triggers?.update, 19,
        ['send_state', 'send_attempted_at', 'send_attempt_id', 'send_error', 'sent_at', 'provider_message_id'],
        'public.guard_response_draft_send_state_writer()')) {
      blockers.push('Migration 008 claim procedure or ordinarily enabled update guard is incomplete.');
    }
    if (stage === 'after:008') {
      if (!artifacts.legacyFinalizer) blockers.push('Migration 008 legacy finalizer is missing.');
      const roles = metadata.configuredRoles || {};
      const functions = metadata.functions || {};
      if (!functionReady(functions.claim, { owner: roles.owner, sender: roles.sender, sourceHash: REPLY_SENDER_FUNCTION_SOURCE_HASHES.claim }) ||
          !functionReady(functions.legacyFinalizer, { owner: roles.owner, sender: roles.sender, sourceHash: REPLY_SENDER_FUNCTION_SOURCE_HASHES.legacyFinalizer }) ||
          !functionReady(functions.writerGuard, { owner: roles.migrationLogin, sender: roles.sender, securityDefiner: false,
            executeGrantees: [roles.migrationLogin, 'PUBLIC'], sourceHash: REPLY_SENDER_FUNCTION_SOURCE_HASHES.writerGuard })) {
        blockers.push('Migration 008 function source, ownership, security mode, search path, or EXECUTE grants do not match the reviewed boundary.');
      }
      const expected008Definers = [FUNCTION_SIGNATURES.claim, FUNCTION_SIGNATURES.legacyFinalizer].sort();
      const actual008Definers = [...(metadata.ownerSecurityDefinerFunctions || [])].sort();
      if (actual008Definers.length !== expected008Definers.length || actual008Definers.some((item, index) => item !== expected008Definers[index])) {
        blockers.push('The function-owner role has unexpected SECURITY DEFINER functions at the after:008 checkpoint.');
      }
      if (artifacts.finalizerV2 || artifacts.insertTrigger) blockers.push('009 hardening artifacts exist before the selected checkpoint.');
    }
  }
  if (stage === 'after:009') {
    if (!artifacts.finalizerV2 || artifacts.legacyFinalizer ||
        !validTrigger(metadata.triggers?.insert, 7, [], 'public.guard_response_draft_send_state_writer()') ||
        !validTrigger(metadata.triggers?.update, 19,
          ['send_state', 'send_attempted_at', 'send_attempt_id', 'send_error', 'sent_at', 'provider_message_id'],
          'public.guard_response_draft_send_state_writer()')) {
      blockers.push('Migration 009 procedures or effective INSERT/UPDATE guards are incomplete.');
    }
    const roles = metadata.configuredRoles || {};
    const functions = metadata.functions || {};
    if (!functionReady(functions.claim, { owner: roles.owner, sender: roles.sender, sourceHash: REPLY_SENDER_FUNCTION_SOURCE_HASHES.claim }) ||
        !functionReady(functions.finalizerV2, { owner: roles.owner, sender: roles.sender, sourceHash: REPLY_SENDER_FUNCTION_SOURCE_HASHES.finalizerV2 }) ||
        !functionReady(functions.writerGuard, { owner: roles.migrationLogin, sender: roles.sender, securityDefiner: false,
          executeGrantees: [roles.migrationLogin], sourceHash: REPLY_SENDER_FUNCTION_SOURCE_HASHES.writerGuard })) {
      blockers.push('Function signatures, source, owner, security mode, pinned search path, or effective EXECUTE grants do not match the reviewed boundary.');
    }
    if (metadata.ownerSecurityDefinerFunctions?.some(signature => ![FUNCTION_SIGNATURES.claim, FUNCTION_SIGNATURES.finalizerV2].includes(signature))) {
      blockers.push('The function-owner role owns an unexpected SECURITY DEFINER function.');
    }
    if (metadata.senderExecutableSecurityDefinerFunctions?.some(signature => ![FUNCTION_SIGNATURES.claim, FUNCTION_SIGNATURES.finalizerV2].includes(signature))) {
      blockers.push('The restricted sender can execute an unexpected SECURITY DEFINER function.');
    }
  }

  blockers.push(...roleBlockers(metadata));
  if (stage === 'before') blockers.push(...(metadata.migrationPrerequisiteBlockers || []));
  const readyStatus = {
    before: 'READY_TO_APPLY_007',
    'after:007': 'READY_TO_APPLY_008',
    'after:008': 'READY_TO_APPLY_009',
    'after:009': 'READY_FOR_ADMIN_REVIEW'
  }[stage];
  return { status: blockers.length ? 'BLOCKED' : readyStatus, stage, blockers, observations: [] };
}

export function assessReplySenderRuntimeMetadata(metadata) {
  const result = assessReplySenderStage(metadata, 'after:009', REPLY_SENDER_MIGRATION_CHECKSUMS);
  return result.status === 'READY_FOR_ADMIN_REVIEW' ? { ok: true, blockers: [] } : { ok: false, blockers: result.blockers };
}
