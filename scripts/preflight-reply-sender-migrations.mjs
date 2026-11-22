import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { inspectDatabaseTargetConsistency } from '../api/_database-target.js';
import { migrationPlan } from '../api/_migration-plan.js';
import {
  REPLY_SENDER_FUNCTION_SOURCE_HASHES,
  REPLY_SENDER_MIGRATION_CHECKSUMS,
  assessReplySenderStage,
  sha256,
  validateReplySenderConfiguration
} from '../api/_reply-sender-readiness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Pool } = pg;
const MIGRATIONS_DIR = path.join(root, 'database', 'migrations');
const BASE_TABLES = ['response_drafts', 'inbox_messages', 'contacts', 'outreach_emails', 'audit_logs', 'schema_migrations'];
const FUNCTION_SIGNATURES = {
  claim: 'public.claim_response_draft_send(bigint,uuid,text)',
  legacyFinalizer: 'public.finalize_response_draft_send(bigint,uuid,text,text,integer,text,text,text)',
  finalizerV2: 'public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text)',
  writerGuard: 'public.guard_response_draft_send_state_writer()'
};
const REQUIRED_CONSTRAINTS = [
  'response_drafts_send_state_check',
  'response_drafts_send_timestamps_check',
  'response_drafts_send_error_check',
  'response_drafts_send_attempt_id_check'
];

function configuredRoles(env) {
  return {
    owner: String(env.REPLY_SEND_OWNER_ROLE || '').trim(),
    sender: String(env.REPLY_SENDER_ROLE || '').trim(),
    app: String(env.REPLY_SEND_APP_ROLE || '').trim(),
    senderLogin: String(env.REPLY_SENDER_LOGIN_ROLE || '').trim(),
    migrationLogin: String(env.REPLY_SEND_MIGRATION_LOGIN_ROLE || '').trim()
  };
}

function parseStage(args) {
  if (args.length !== 2 || args[0] !== '--stage' || !['before', 'after:007', 'after:008', 'after:009'].includes(args[1])) return null;
  return args[1];
}

async function expectedMigrationChecksums() {
  const result = {};
  for (const migration of migrationPlan) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, migration.file), 'utf8');
    result[migration.version] = createHash('sha256').update(sql).digest('hex');
  }
  return result;
}

async function verifyRepositoryManifest(checksums) {
  const blockers = [];
  const files = (await readdir(MIGRATIONS_DIR)).filter(file => file.endsWith('.sql')).sort();
  const planned = migrationPlan.map(item => item.file).sort();
  const plannedVersions = migrationPlan.map(item => item.version);
  if (files.length !== planned.length || files.some((file, index) => file !== planned[index]) ||
      new Set(planned).size !== planned.length || new Set(plannedVersions).size !== plannedVersions.length) {
    blockers.push('Migration runner manifest does not register every SQL file exactly once.');
  }
  const replySequence = ['007_response_draft_send_state', '008_reply_sender_boundary', '009_reply_sender_safety_hardening'];
  const observedReplySequence = plannedVersions.filter(version => replySequence.includes(version));
  if (observedReplySequence.length !== replySequence.length || observedReplySequence.some((version, index) => version !== replySequence[index])) {
    blockers.push('Reply-sender migrations 007–009 are missing, duplicated, or out of order in the runner manifest.');
  }
  for (const [version, checksum] of Object.entries(REPLY_SENDER_MIGRATION_CHECKSUMS)) {
    if (checksums[version] !== checksum) blockers.push('Checked-in reply-sender migration checksum manifest is stale for ' + version + '.');
  }
  const sourceFiles = {
    claim: '008_reply_sender_boundary.sql',
    legacyFinalizer: '008_reply_sender_boundary.sql',
    finalizerV2: '009_reply_sender_safety_hardening.sql',
    writerGuard: '009_reply_sender_safety_hardening.sql'
  };
  const regexes = {
    claim: /CREATE OR REPLACE FUNCTION public\.claim_response_draft_send[\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
    legacyFinalizer: /CREATE OR REPLACE FUNCTION public\.finalize_response_draft_send\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
    finalizerV2: /CREATE OR REPLACE FUNCTION public\.finalize_response_draft_send_v2\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
    writerGuard: /CREATE OR REPLACE FUNCTION public\.guard_response_draft_send_state_writer[\s\S]*?AS \$\$([\s\S]*?)\$\$;/
  };
  for (const [key, file] of Object.entries(sourceFiles)) {
    const source = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const body = source.match(regexes[key])?.[1];
    if (!body || sha256(body) !== REPLY_SENDER_FUNCTION_SOURCE_HASHES[key]) {
      blockers.push('Checked-in function source manifest is stale for ' + key + '.');
    }
  }
  return blockers;
}

function literalsIn(expression) {
  return [...expression.matchAll(/'((?:''|[^'])*)'/g)].map(match => match[1].replace(/''/g, "'"));
}

function safeConstraintExpression(definition, allowedColumns, allowedLiterals) {
  const match = /^\s*CHECK\s*\(([\s\S]*)\)\s*$/i.exec(String(definition || ''));
  if (!match) return null;
  const expression = match[1].replace(/::\s*text\b/gi, '');
  const literalValues = literalsIn(expression);
  if (literalValues.some(value => !allowedLiterals.includes(value)) ||
      allowedLiterals.some(value => !literalValues.includes(value))) return null;
  const withoutStrings = expression.replace(/'(?:''|[^'])*'/g, 'LIT');
  const tokens = withoutStrings.match(/[A-Za-z_][A-Za-z_0-9]*|<=|>=|<>|=|[()[\],]/g) || [];
  if (tokens.join('') !== withoutStrings.replace(/\s/g, '')) return null;
  const allowed = new Set([...allowedColumns.map(column => column.toUpperCase()), 'LIT', 'AND', 'OR', 'IN', 'ANY', 'ALL', 'ARRAY', 'IS', 'NOT', 'NULL', 'BTRIM', 'NULLIF', '=', '<>', '(', ')', '[', ']', ',']);
  if (tokens.some(token => !allowed.has(token.toUpperCase()))) return null;
  return expression;
}

function expectedConstraintPass(name, row) {
  const state = row.send_state;
  if (name === 'response_drafts_send_state_check') {
    return ['NOT_SENT', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN'].includes(state);
  }
  if (name === 'response_drafts_send_timestamps_check') {
    return (state === 'NOT_SENT' && row.send_attempted_at === null && row.sent_at === null) ||
      (['SENDING', 'FAILED', 'UNKNOWN'].includes(state) && row.send_attempted_at !== null && row.sent_at === null) ||
      (state === 'SENT' && row.send_attempted_at !== null && row.sent_at !== null);
  }
  if (name === 'response_drafts_send_error_check') {
    return (['FAILED', 'UNKNOWN'].includes(state) && row.send_error !== null && row.send_error.trim() !== '') ||
      (!['FAILED', 'UNKNOWN'].includes(state) && row.send_error === null);
  }
  return (state === 'NOT_SENT' && row.send_attempt_id === null) ||
    (state !== 'NOT_SENT' && row.send_attempt_id !== null);
}

function probeValues() {
  const states = ['NOT_SENT', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'OTHER'];
  const timestamps = [null, "TIMESTAMPTZ '2000-01-01 00:00:00+00'"];
  const errors = [null, "''::text", "'EVIDENCE'::text"];
  const attempts = [null, "'00000000-0000-0000-0000-000000000001'::uuid"];
  const rows = [];
  for (const send_state of states) for (const send_attempted_at of timestamps) for (const sent_at of timestamps)
    for (const send_error of errors) for (const send_attempt_id of attempts) {
      const renderText = value => value === null ? 'NULL::text' : "'" + value.replace(/'/g, "''") + "'::text";
      const row = { send_state, send_attempted_at, sent_at, send_error: send_error === null ? null : send_error === "''::text" ? '' : 'EVIDENCE',
        send_attempt_id: send_attempt_id === null ? null : '00000000-0000-0000-0000-000000000001' };
      const tuple = '(' + [
        renderText(send_state),
        send_attempted_at === null ? 'NULL::timestamptz' : send_attempted_at,
        sent_at === null ? 'NULL::timestamptz' : sent_at,
        send_error === null ? 'NULL::text' : send_error,
        send_attempt_id === null ? 'NULL::uuid' : send_attempt_id
      ].join(',') + ')';
      rows.push({ row, tuple });
    }
  return rows;
}

async function checkConstraintSemantics(client, name, definition) {
  const contracts = {
    response_drafts_send_state_check: { columns: ['send_state'], literals: ['NOT_SENT', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN'] },
    response_drafts_send_timestamps_check: { columns: ['send_state', 'send_attempted_at', 'sent_at'], literals: ['NOT_SENT', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN'] },
    response_drafts_send_error_check: { columns: ['send_state', 'send_error'], literals: ['FAILED', 'UNKNOWN', ''] },
    response_drafts_send_attempt_id_check: { columns: ['send_state', 'send_attempt_id'], literals: ['NOT_SENT'] }
  };
  const contract = contracts[name];
  const expression = contract && safeConstraintExpression(definition, contract.columns, contract.literals);
  if (!expression) return false;
  const probes = probeValues();
  const values = probes.map(item => item.tuple).join(',');
  const query = 'WITH probe(send_state,send_attempted_at,sent_at,send_error,send_attempt_id) AS (VALUES ' + values + ') ' +
    'SELECT coalesce((' + expression + '), true) AS accepted FROM probe';
  try {
    const result = await client.query(query);
    return result.rows?.length === probes.length && result.rows.every((row, index) =>
      row.accepted === expectedConstraintPass(name, probes[index].row)
    );
  } catch {
    return false;
  }
}

async function collectReplySenderMetadata({ applicationClient, migrationExecutorClient, senderClient, roles, stage, requireMigrationConnection = true }) {
  const columnsResult = await applicationClient.query(
    'SELECT table_name,column_name,udt_name,is_nullable,column_default FROM information_schema.columns ' +
    'WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name,ordinal_position',
    ['public', [...BASE_TABLES]]
  );
  const columns = columnsResult.rows || [];
  const columnSet = new Set(columns.map(column => column.table_name + '.' + column.column_name));
  const hasHistory = ['schema_migrations.version', 'schema_migrations.checksum', 'schema_migrations.applied_at'].every(column => columnSet.has(column));
  const history = hasHistory ? (await applicationClient.query(
    'SELECT version,checksum,extract(epoch FROM applied_at)::numeric::text AS applied_epoch ' +
    'FROM public.schema_migrations ORDER BY applied_at ASC,version ASC'
  )).rows || [] : [];
  const uniqueResult = hasHistory ? await applicationClient.query(
    "SELECT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid='public.schema_migrations'::regclass " +
    "AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND " +
    "(SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ordinality) " +
    "JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum) = ARRAY['version']::text[]) AS version_unique"
  ) : { rows: [] };
  const primaryKeyResult = await applicationClient.query(
    'SELECT table_info.relname AS table_name, ' +
    'array_agg(attribute.attname::text ORDER BY key_column.ordinality) AS columns ' +
    'FROM pg_constraint constraint_info ' +
    'JOIN pg_class table_info ON table_info.oid=constraint_info.conrelid ' +
    'CROSS JOIN LATERAL unnest(constraint_info.conkey) WITH ORDINALITY AS key_column(attnum,ordinality) ' +
    'JOIN pg_attribute attribute ON attribute.attrelid=table_info.oid AND attribute.attnum=key_column.attnum ' +
    "WHERE table_info.relnamespace='public'::regnamespace AND table_info.relname=ANY($1::name[]) AND constraint_info.contype='p' " +
    'GROUP BY table_info.relname',
    [['response_drafts', 'inbox_messages', 'contacts', 'outreach_emails', 'audit_logs']]
  );
  const primaryKeys = Object.fromEntries((primaryKeyResult.rows || []).map(row => [row.table_name, row.columns || []]));
  let rowCounts = null;
  const has007 = ['send_state', 'send_attempted_at', 'send_error', 'sent_at'].every(name => columnSet.has('response_drafts.' + name));
  const has008 = columnSet.has('response_drafts.send_attempt_id');
  if (has007) {
    const counts = (await applicationClient.query(
      "SELECT count(*) FILTER (WHERE send_state IS NULL OR send_state NOT IN ('NOT_SENT','SENDING','SENT','FAILED','UNKNOWN'))::int AS invalid_state," +
      "count(*) FILTER (WHERE NOT ((send_state='NOT_SENT' AND send_attempted_at IS NULL AND sent_at IS NULL) OR " +
      "(send_state IN ('SENDING','FAILED','UNKNOWN') AND send_attempted_at IS NOT NULL AND sent_at IS NULL) OR " +
      "(send_state='SENT' AND send_attempted_at IS NOT NULL AND sent_at IS NOT NULL)))::int AS invalid_timestamps," +
      "count(*) FILTER (WHERE NOT ((send_state IN ('FAILED','UNKNOWN') AND NULLIF(btrim(send_error),'') IS NOT NULL) OR " +
      "(send_state NOT IN ('FAILED','UNKNOWN') AND send_error IS NULL)))::int AS invalid_error," +
      (has008 ? "count(*) FILTER (WHERE send_state<>'NOT_SENT' AND send_attempt_id IS NULL)::int AS missing_attempt," +
        "count(*) FILTER (WHERE send_state='NOT_SENT' AND send_attempt_id IS NOT NULL)::int AS stray_attempt " :
        "0::int AS missing_attempt,0::int AS stray_attempt ") +
      'FROM public.response_drafts'
    )).rows?.[0] || {};
    rowCounts = Object.fromEntries([
      ['invalidState', Number(counts.invalid_state || 0)],
      ['invalidTimestamps', Number(counts.invalid_timestamps || 0)],
      ['invalidError', Number(counts.invalid_error || 0)],
      ['missingAttempt', Number(counts.missing_attempt || 0)],
      ['strayAttempt', Number(counts.stray_attempt || 0)]
    ]);
  }

  const roleNames = [roles.owner, roles.sender, roles.app, roles.senderLogin, roles.migrationLogin];
  const roleKeys = ['owner', 'sender', 'app', 'senderLogin', 'migrationLogin'];
  const roleResult = await applicationClient.query(
    'WITH configured(role_key,role_name) AS (SELECT * FROM unnest($1::text[],$2::text[])), ' +
    "table_info AS (SELECT c.oid,c.relowner FROM pg_class c WHERE c.oid=to_regclass('public.response_drafts')), " +
    'owner_info AS (SELECT oid FROM pg_roles WHERE rolname=$3), sender_info AS (SELECT oid FROM pg_roles WHERE rolname=$4), ' +
    'app_info AS (SELECT oid FROM pg_roles WHERE rolname=$5) ' +
    'SELECT configured.role_key,configured.role_name,(r.oid IS NOT NULL) AS exists,r.rolcanlogin AS can_login,r.rolsuper AS superuser,' +
    'r.rolcreaterole AS create_role,r.rolcreatedb AS create_db,r.rolreplication AS replication,r.rolbypassrls AS bypass_rls,' +
    "coalesce(r.oid=t.relowner OR pg_has_role(r.oid,t.relowner,'MEMBER'),false) AS table_owner," +
    "coalesce(pg_has_role(r.oid,o.oid,'MEMBER'),false) AS member_of_owner," +
    "coalesce(pg_has_role(r.oid,s.oid,'MEMBER'),false) AS member_of_sender," +
    "coalesce(pg_has_role(r.oid,a.oid,'MEMBER'),false) AS member_of_app," +
    "coalesce(has_table_privilege(r.oid,t.oid,'INSERT') OR has_any_column_privilege(r.oid,t.oid,'INSERT'),false) AS direct_insert," +
    "coalesce(has_table_privilege(r.oid,t.oid,'UPDATE') OR has_any_column_privilege(r.oid,t.oid,'UPDATE'),false) AS direct_update," +
    "coalesce(has_table_privilege(r.oid,t.oid,'DELETE'),false) AS direct_delete,coalesce(has_table_privilege(r.oid,t.oid,'TRUNCATE'),false) AS direct_truncate," +
    "coalesce(EXISTS (SELECT 1 FROM pg_namespace ns WHERE ns.oid='public'::regnamespace AND (ns.nspowner=r.oid " +
      "OR EXISTS (SELECT 1 FROM aclexplode(ns.nspacl) acl WHERE acl.grantee=r.oid " +
      "AND acl.privilege_type='CREATE' AND acl.is_grantable))),false) AS public_create_with_grant " +
    'FROM configured LEFT JOIN pg_roles r ON r.rolname=configured.role_name CROSS JOIN table_info t CROSS JOIN owner_info o CROSS JOIN sender_info s CROSS JOIN app_info a',
    [roleKeys, roleNames, roles.owner, roles.sender, roles.app]
  );
  const serverVersionResult = await applicationClient.query("SELECT current_setting('server_version_num')::integer AS server_version");
  const serverVersion = Number(serverVersionResult.rows?.[0]?.server_version || 0);
  const parameterPrivilegeResult = serverVersion >= 150000 ? await applicationClient.query(
    'SELECT configured.role_key,has_parameter_privilege(r.oid,\'session_replication_role\',\'SET\') AS can_set_replication_role ' +
    'FROM unnest($1::text[],$2::text[]) AS configured(role_key,role_name) JOIN pg_roles r ON r.rolname=configured.role_name',
    [['app', 'senderLogin', 'migrationLogin'], [roles.app, roles.senderLogin, roles.migrationLogin]]
  ) : { rows: [] };

  const functionResult = await applicationClient.query(
    'WITH expected(function_key,signature) AS (VALUES ' +
    "('claim','" + FUNCTION_SIGNATURES.claim + "'),('legacyFinalizer','" + FUNCTION_SIGNATURES.legacyFinalizer + "')," +
    "('finalizerV2','" + FUNCTION_SIGNATURES.finalizerV2 + "'),('writerGuard','" + FUNCTION_SIGNATURES.writerGuard + "')) " +
    'SELECT e.function_key,(p.oid IS NOT NULL) AS exists,CASE WHEN p.oid IS NULL THEN NULL ELSE pg_get_userbyid(p.proowner) END AS owner_name,' +
    'p.prosecdef AS security_definer,p.proconfig AS function_config,p.prosrc AS source,pg_get_function_result(p.oid) AS return_type,' +
    "CASE WHEN p.oid IS NULL THEN ARRAY[]::text[] ELSE ARRAY(SELECT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END " +
    "FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl LEFT JOIN pg_roles grantee ON grantee.oid=acl.grantee " +
    "WHERE acl.privilege_type='EXECUTE') END AS execute_grantees " +
    'FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)::oid'
  );
  const functions = Object.fromEntries((functionResult.rows || []).map(row => {
    const hashes = REPLY_SENDER_FUNCTION_SOURCE_HASHES;
    const hash = row.source ? sha256(row.source) : null;
    const key = row.function_key;
    return [key, {
      exists: row.exists === true,
      ownerName: row.owner_name,
      securityDefiner: row.security_definer === true,
      searchPathPinned: (row.function_config || []).some(value => String(value).replace(/\s/g, '') === 'search_path=pg_catalog,public'),
      sourceHash: hash,
      sourceMatches: Boolean(hash && hashes[key] && hash === hashes[key]),
      returnTypeMatches: key === 'claim'
        ? /^SETOF (public\.)?response_drafts$/i.test(String(row.return_type || ''))
        : key === 'writerGuard'
          ? String(row.return_type || '').toLowerCase() === 'trigger'
          : String(row.return_type || '').toLowerCase() === 'boolean',
      executeGrantees: row.execute_grantees || [],
      returnType: row.return_type
    }];
  }));

  const ownerFunctions = (await applicationClient.query(
    "SELECT format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) AS signature " +
    'FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=to_regrole($1)::oid AND p.prosecdef',
    [roles.owner]
  )).rows || [];
  const senderDefiners = (await applicationClient.query(
    "SELECT format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) AS signature " +
    'FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace ' +
    "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' " +
    "AND p.prosecdef AND has_function_privilege(to_regrole($1)::oid,p.oid,'EXECUTE')",
    [roles.senderLogin]
  )).rows || [];

  const triggerResult = await applicationClient.query(
    "SELECT t.tgname,t.tgenabled,t.tgtype::int AS event_mask," +
    "ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY x(attnum,ord) " +
    'JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.attnum ORDER BY x.ord) AS columns,' +
    "format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) AS function_signature " +
    'FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace ' +
    "WHERE t.tgrelid=to_regclass('public.response_drafts') AND NOT t.tgisinternal"
  );
  const triggers = {};
  for (const trigger of triggerResult.rows || []) {
    if (trigger.tgname === 'response_drafts_send_state_insert_guard') triggers.insert = {
      enabledMode: trigger.tgenabled, eventMask: Number(trigger.event_mask), columns: trigger.columns || [],
      functionSignature: trigger.function_signature
    };
    if (trigger.tgname === 'response_drafts_send_state_writer_guard') triggers.update = {
      enabledMode: trigger.tgenabled, eventMask: Number(trigger.event_mask), columns: trigger.columns || [],
      functionSignature: trigger.function_signature
    };
  }
  const constraintResult = await applicationClient.query(
    "SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition " +
    "FROM pg_constraint WHERE conrelid=to_regclass('public.response_drafts') AND conname=ANY($1::text[])",
    [REQUIRED_CONSTRAINTS]
  );
  const constraints = {};
  for (const row of constraintResult.rows || []) {
    constraints[row.conname] = {
      validated: row.convalidated === true,
      semanticValid: await checkConstraintSemantics(applicationClient, row.conname, row.definition),
      definition: row.definition
    };
  }

  const connectionRole = async client => {
    const { rows } = await client.query('SELECT current_user AS role_name');
    return rows?.[0]?.role_name || null;
  };
  const applicationRole = await connectionRole(applicationClient);
  const senderRole = await connectionRole(senderClient);
  const migrationRole = migrationExecutorClient ? await connectionRole(migrationExecutorClient) : null;
  const membershipQuery =
    'SELECT coalesce(array_agg(r.rolname::text ORDER BY r.rolname),ARRAY[]::text[]) AS members ' +
    "FROM pg_roles r WHERE r.rolcanlogin AND NOT r.rolsuper AND pg_has_role(r.oid,to_regrole($1)::oid,'MEMBER')";
  const senderMembers = await applicationClient.query(membershipQuery, [roles.sender]);
  const ownerMembers = await applicationClient.query(membershipQuery, [roles.owner]);
  const effectiveMembershipQuery =
    'SELECT coalesce(array_agg(r.rolname::text ORDER BY r.rolname),ARRAY[]::text[]) AS memberships ' +
    'FROM pg_roles r WHERE r.oid<>to_regrole($1)::oid AND pg_has_role(to_regrole($1)::oid,r.oid,\'MEMBER\')';
  const senderLoginMemberships = await applicationClient.query(effectiveMembershipQuery, [roles.senderLogin]);
  const migrationLoginMemberships = await applicationClient.query(effectiveMembershipQuery, [roles.migrationLogin]);

  const executorResult = migrationExecutorClient ? await migrationExecutorClient.query(
    'SELECT r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolbypassrls,' +
    "coalesce(r.oid=t.relowner OR pg_has_role(r.oid,t.relowner,'MEMBER'),false) AS target_table_owner," +
    "coalesce(pg_has_role(current_user,to_regrole($1)::oid,'MEMBER'),false) AS member_owner," +
    "coalesce(pg_has_role(current_user,to_regrole($2)::oid,'MEMBER'),false) AS member_sender," +
    "coalesce(pg_has_role(current_user,to_regrole($3)::oid,'MEMBER'),false) AS member_app," +
    "coalesce(EXISTS (SELECT 1 FROM pg_namespace ns WHERE ns.oid='public'::regnamespace AND (ns.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) " +
      "OR EXISTS (SELECT 1 FROM aclexplode(ns.nspacl) acl WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=current_user) " +
      "AND acl.privilege_type='CREATE' AND acl.is_grantable))),false) AS public_create_with_grant " +
    "FROM pg_roles r CROSS JOIN (SELECT relowner FROM pg_class WHERE oid=to_regclass('public.response_drafts')) t WHERE r.rolname=current_user",
    [roles.owner, roles.sender, roles.app]
  ) : { rows: [] };
  const executor = executorResult.rows?.[0] || {};

  const privilegeResult = stage === 'after:008' || stage === 'after:009' ? await applicationClient.query(
    'SELECT ' +
    "coalesce(has_table_privilege(to_regrole($1)::oid,'public.response_drafts','SELECT'),false) AS owner_draft_select," +
    "coalesce(has_column_privilege(to_regrole($1)::oid,'public.response_drafts','send_state','UPDATE'),false) AND " +
    "coalesce(has_column_privilege(to_regrole($1)::oid,'public.response_drafts','send_attempted_at','UPDATE'),false) AND " +
    "coalesce(has_column_privilege(to_regrole($1)::oid,'public.response_drafts','send_attempt_id','UPDATE'),false) AND " +
    "coalesce(has_column_privilege(to_regrole($1)::oid,'public.response_drafts','send_error','UPDATE'),false) AND " +
    "coalesce(has_column_privilege(to_regrole($1)::oid,'public.response_drafts','sent_at','UPDATE'),false) AND " +
    "coalesce(has_column_privilege(to_regrole($1)::oid,'public.response_drafts','provider_message_id','UPDATE'),false) AS owner_state_update," +
    "coalesce(has_table_privilege(to_regrole($1)::oid,'public.inbox_messages','SELECT'),false) AS owner_inbox_select," +
    "coalesce(has_table_privilege(to_regrole($1)::oid,'public.contacts','SELECT'),false) AS owner_contacts_select," +
    "coalesce(has_table_privilege(to_regrole($1)::oid,'public.outreach_emails','SELECT'),false) AS owner_outreach_select," +
    "coalesce(has_table_privilege(to_regrole($1)::oid,'public.audit_logs','INSERT'),false) AS owner_audit_insert," +
    "coalesce(has_sequence_privilege(to_regrole($1)::oid,pg_get_serial_sequence('public.audit_logs','id'),'USAGE'),false) AS owner_audit_sequence_usage," +
    "coalesce(has_schema_privilege(to_regrole($1)::oid,'public','USAGE'),false) AS owner_schema_usage," +
    "coalesce(has_schema_privilege(to_regrole($2)::oid,'public','USAGE'),false) AS sender_schema_usage",
    [roles.owner, roles.sender]
  ) : { rows: [] };
  const rowSecurity = await applicationClient.query(
    "SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname),ARRAY[]::text[]) AS tables " +
    "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' " +
    "AND c.relname=ANY(ARRAY['response_drafts','inbox_messages','contacts','outreach_emails','audit_logs']::name[]) " +
    'AND (c.relrowsecurity OR c.relforcerowsecurity)'
  );

  const roleObjects = {};
  for (const row of roleResult.rows || []) {
    roleObjects[row.role_key] = {
      exists: row.exists === true,
      roleName: row.role_name,
      canLogin: row.can_login === true,
      superuser: row.superuser === true,
      createRole: row.create_role === true,
      createDb: row.create_db === true,
      replication: row.replication === true,
      bypassRls: row.bypass_rls === true,
      tableOwner: row.table_owner === true,
      memberOfOwner: row.member_of_owner === true,
      memberOfSender: row.member_of_sender === true,
      memberOfApp: row.member_of_app === true,
      directInsert: row.direct_insert === true,
      directUpdate: row.direct_update === true,
      directDelete: row.direct_delete === true,
      directTruncate: row.direct_truncate === true,
      publicCreateWithGrant: row.public_create_with_grant === true
    };
  }
  for (const row of parameterPrivilegeResult.rows || []) {
    if (roleObjects[row.role_key]) roleObjects[row.role_key].canSetSessionReplicationRole = row.can_set_replication_role === true;
  }
  if (serverVersion < 150000) {
    for (const key of ['app', 'senderLogin', 'migrationLogin']) {
      if (roleObjects[key]) roleObjects[key].canSetSessionReplicationRole = false;
    }
  }
  const roleMap = Object.fromEntries(roleKeys.map((key, index) => [['owner', 'sender', 'app', 'senderLogin', 'migrationLogin'][index], roleObjects[key]]));
  if (roleMap.migrationLogin) {
    roleMap.migrationLogin.targetTableOwner = roleMap.migrationLogin.tableOwner;
    if (migrationExecutorClient) {
      roleMap.migrationLogin.targetTableOwner = executor.target_table_owner === true;
      roleMap.migrationLogin.publicCreateWithGrant = executor.public_create_with_grant === true;
      roleMap.migrationLogin.memberOfOwner = executor.member_owner === true;
      roleMap.migrationLogin.memberOfSender = executor.member_sender === true;
      roleMap.migrationLogin.memberOfApp = executor.member_app === true;
    }
  }
  const p = privilegeResult.rows?.[0] || {};
  const procedurePrivileges = {
    ownerRequired: p.owner_draft_select === true && p.owner_state_update === true && p.owner_inbox_select === true &&
      p.owner_contacts_select === true && p.owner_outreach_select === true && p.owner_audit_insert === true &&
      p.owner_audit_sequence_usage === true && p.owner_schema_usage === true && p.sender_schema_usage === true
  };

  const functionArtifacts = Object.fromEntries(Object.keys(FUNCTION_SIGNATURES).map(key => [key, functions[key]?.exists === true]));
  return {
    stage,
    serverVersion,
    columns,
    primaryKeys,
    history,
    historyVersionUnique: uniqueResult.rows?.[0]?.version_unique === true,
    rowCounts,
    roles: roleMap,
    configuredRoles: roles,
    connectionRoles: { application: applicationRole, sender: senderRole, migration: migrationRole },
    requireMigrationConnection,
    senderGroupLoginMembers: senderMembers.rows?.[0]?.members || [],
    ownerGroupLoginMembers: ownerMembers.rows?.[0]?.members || [],
    senderLoginMemberships: senderLoginMemberships.rows?.[0]?.memberships || [],
    migrationLoginMemberships: migrationLoginMemberships.rows?.[0]?.memberships || [],
    migrationExecutor: {
      superuser: executor.rolsuper === true,
      createRole: executor.rolcreaterole === true,
      createDb: executor.rolcreatedb === true,
      replication: executor.rolreplication === true,
      bypassRls: executor.rolbypassrls === true,
      targetTableOwner: executor.target_table_owner === true,
      memberOfOwner: executor.member_owner === true,
      memberOfSender: executor.member_sender === true,
      memberOfApp: executor.member_app === true,
      publicCreateWithGrant: executor.public_create_with_grant === true
    },
    migrationPrerequisiteBlockers: [],
    functions,
    ownerSecurityDefinerFunctions: ownerFunctions.map(row => String(row.signature || '').replace(/\s/g, '')),
    senderExecutableSecurityDefinerFunctions: senderDefiners.map(row => String(row.signature || '').replace(/\s/g, '')),
    triggers,
    constraints,
    artifacts: {
      send_state: columnSet.has('response_drafts.send_state'),
      send_attempted_at: columnSet.has('response_drafts.send_attempted_at'),
      send_error: columnSet.has('response_drafts.send_error'),
      sent_at: columnSet.has('response_drafts.sent_at'),
      provider_message_id: columnSet.has('response_drafts.provider_message_id'),
      send_attempt_id: columnSet.has('response_drafts.send_attempt_id'),
      send_attempt_id_constraint: Object.hasOwn(constraints, 'response_drafts_send_attempt_id_check'),
      ...functionArtifacts,
      insertTrigger: Boolean(triggers.insert),
      updateTrigger: Boolean(triggers.update)
    },
    procedurePrivileges,
    rowSecurityTables: rowSecurity.rows?.[0]?.tables || []
  };
}

function mapMigrationRole(role) {
  return {
    exists: role.exists,
    canLogin: role.canLogin,
    superuser: role.superuser,
    createRole: role.createRole,
    createDb: role.createDb,
    replication: role.replication,
    bypassRls: role.bypassRls,
    tableOwner: role.tableOwner,
    memberOfOwner: role.memberOfOwner,
    memberOfSender: role.memberOfSender,
    memberOfApp: role.memberOfApp,
    directInsert: role.directInsert,
    directUpdate: role.directUpdate,
    directDelete: role.directDelete,
    directTruncate: role.directTruncate,
    targetTableOwner: role.tableOwner,
    publicCreateWithGrant: false
  };
}

async function main() {
  const stage = parseStage(process.argv.slice(2));
  if (!stage) {
    console.error('Usage: node scripts/preflight-reply-sender-migrations.mjs --stage before|after:007|after:008|after:009');
    process.exitCode = 2;
    return;
  }
  const config = validateReplySenderConfiguration(process.env);
  if (!config.ok) {
    console.error('Reply-sender preflight unavailable: required connection or role configuration is missing or invalid.');
    process.exitCode = 2;
    return;
  }
  const roles = configuredRoles(process.env);
  const directUrl = String(process.env.DATABASE_DIRECT_URL || '').trim();
  const appUrl = String(process.env.DATABASE_URL || '').trim();
  const senderUrl = String(process.env.REPLY_SENDER_DATABASE_URL || '').trim();
  const target = inspectDatabaseTargetConsistency(process.env);
  const senderTarget = inspectDatabaseTargetConsistency({ ...process.env, DATABASE_DIRECT_URL: senderUrl });
  if (target.status !== 'MATCH' || senderTarget.status !== 'MATCH') {
    console.error('Database targets are conflicting or cannot be verified; no preflight connection was opened.');
    process.exitCode = 2;
    return;
  }

  const checksums = await expectedMigrationChecksums();
  const repositoryBlockers = await verifyRepositoryManifest(checksums);
  if (repositoryBlockers.length) {
    console.error(JSON.stringify({ status: 'BLOCKED', stage, blockers: repositoryBlockers }, null, 2));
    process.exitCode = 1;
    return;
  }
  const appPool = new Pool({ connectionString: appUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000 });
  const executorPool = directUrl === appUrl ? null : new Pool({ connectionString: directUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000 });
  const senderPool = senderUrl === appUrl ? null : senderUrl === directUrl ? null : new Pool({ connectionString: senderUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000 });
  let appClient;
  let executorClient;
  let senderClient;
  try {
    appClient = await appPool.connect();
    executorClient = executorPool ? await executorPool.connect() : appClient;
    senderClient = senderPool ? await senderPool.connect() : senderUrl === directUrl ? executorClient : appClient;
    await appClient.query('BEGIN READ ONLY');
    if (executorClient !== appClient) await executorClient.query('BEGIN READ ONLY');
    if (senderClient !== appClient && senderClient !== executorClient) await senderClient.query('BEGIN READ ONLY');

    const metadata = await collectReplySenderMetadata({ applicationClient: appClient, migrationExecutorClient: executorClient, senderClient, roles, stage });
    const report = assessReplySenderStage(metadata, stage, checksums);
    report.blockers.push(...repositoryBlockers);
    if (report.blockers.length) report.status = 'BLOCKED';
    await appClient.query('COMMIT');
    if (executorClient !== appClient) await executorClient.query('COMMIT');
    if (senderClient !== appClient && senderClient !== executorClient) await senderClient.query('COMMIT');
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'BLOCKED') process.exitCode = 1;
  } catch (error) {
    for (const client of new Set([appClient, executorClient, senderClient].filter(Boolean))) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the generic preflight failure */ }
    }
    console.error('REPLY_SENDER_PREFLIGHT_FAILED: ' + String(error?.code || 'PREFLIGHT_ERROR'));
    process.exitCode = 1;
  } finally {
    appClient?.release();
    if (executorClient && executorClient !== appClient) executorClient.release();
    if (senderClient && senderClient !== appClient && senderClient !== executorClient) senderClient.release();
    await appPool.end();
    if (executorPool) await executorPool.end();
    if (senderPool) await senderPool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

export {
  collectReplySenderMetadata,
  safeConstraintExpression,
  checkConstraintSemantics,
  verifyRepositoryManifest,
  expectedConstraintPass,
  probeValues
};
