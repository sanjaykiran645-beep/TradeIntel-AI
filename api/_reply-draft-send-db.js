import pg from 'pg';
import database from './_db-client.js';
import { assertDatabaseTargetConsistency } from './_database-target.js';
import { assessReplySenderRuntimeMetadata, validateReplySenderConfiguration } from './_reply-sender-readiness.js';
import { collectReplySenderMetadata } from '../scripts/preflight-reply-sender-migrations.mjs';

const { Pool } = pg;
let senderPool = null;

function assertFinalizationEvidence({ outcome, smtpCode, smtpStage, outcomeEvidence, sendError }) {
  const explicitStages = new Set(['CONNECT', 'AUTH', 'MAIL_FROM', 'RCPT_TO', 'RECIPIENT_REJECTED', 'DATA']);
  let valid = false;
  if (outcome === 'SENT') {
    valid = outcomeEvidence === 'SMTP_ACCEPTED_INTENDED_RECIPIENT' &&
      Number.isInteger(smtpCode) && smtpCode >= 200 && smtpCode < 300 && smtpStage === 'ACCEPTED';
  } else if (outcome === 'FAILED') {
    valid = (outcomeEvidence === 'SMTP_RECIPIENT_REJECTED' &&
        Number.isInteger(smtpCode) && smtpCode >= 400 && smtpCode < 600 &&
        ['RCPT_TO', 'RECIPIENT_REJECTED'].includes(smtpStage)) ||
      (outcomeEvidence === 'SMTP_SERVER_REJECTED' &&
        Number.isInteger(smtpCode) && smtpCode >= 400 && smtpCode < 600 && explicitStages.has(smtpStage)) ||
      (outcomeEvidence === 'SMTP_PRE_SUBMISSION_FAILURE' && smtpCode === null && smtpStage === 'PRE_SUBMISSION');
    valid = valid && typeof sendError === 'string' && /^[A-Z0-9_:-]{1,240}$/.test(sendError);
  } else if (outcome === 'UNKNOWN') {
    valid = outcomeEvidence === 'SMTP_ACCEPTANCE_UNCERTAIN' && smtpCode === null &&
      typeof sendError === 'string' && /^[A-Z0-9_:-]{1,240}$/.test(sendError);
  }
  if (!valid) {
    throw Object.assign(new Error('The SMTP outcome is missing valid typed evidence from the trusted sender.'), {
      code: 'REPLY_SEND_OUTCOME_INVALID', status: 500
    });
  }
}

function getSenderPool() {
  const connectionString = String(process.env.REPLY_SENDER_DATABASE_URL || '').trim();
  if (!connectionString) {
    throw Object.assign(new Error('The restricted reply-sender database connection is not configured.'), {
      code: 'REPLY_SENDER_DATABASE_NOT_CONFIGURED', status: 503
    });
  }

  // The restricted login must target the same verified database as the normal
  // application connection. Never print either connection string.
  assertDatabaseTargetConsistency({ ...process.env, DATABASE_DIRECT_URL: connectionString });
  if (!senderPool) {
    senderPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, query_timeout: 30000 });
    senderPool.on('error', error => {
      console.error(`[REPLY SENDER DATABASE] idle client error code=${String(error?.code || 'DATABASE_ERROR')}`);
    });
  }
  return senderPool;
}

export function createResponseDraftSendRepository({
  databaseClient = database,
  connectSenderClient = () => getSenderPool().connect(),
  env = process.env,
  collectReadinessMetadata = collectReplySenderMetadata,
  assessReadiness = assessReplySenderRuntimeMetadata
} = {}) {
  async function assertReady() {
    const config = validateReplySenderConfiguration(env);
    if (!config.ok) {
      throw Object.assign(new Error('Reply sending is disabled because required database readiness configuration is missing or invalid.'), {
        code: 'REPLY_SENDER_NOT_READY', status: 503
      });
    }
    const senderConnectionString = String(env.REPLY_SENDER_DATABASE_URL || '').trim();
    try {
      assertDatabaseTargetConsistency(env);
      assertDatabaseTargetConsistency({ ...env, DATABASE_DIRECT_URL: senderConnectionString });
    } catch {
      throw Object.assign(new Error('Reply sending is disabled because database targets cannot be verified as the same database.'), {
        code: 'REPLY_SENDER_NOT_READY', status: 503
      });
    }

    const client = await connectSenderClient();
    let transactionStarted = false;
    try {
      await client.query('BEGIN READ ONLY');
      transactionStarted = true;
      const roles = {
        owner: String(env.REPLY_SEND_OWNER_ROLE || '').trim(),
        sender: String(env.REPLY_SENDER_ROLE || '').trim(),
        app: String(env.REPLY_SEND_APP_ROLE || '').trim(),
        senderLogin: String(env.REPLY_SENDER_LOGIN_ROLE || '').trim(),
        migrationLogin: String(env.REPLY_SEND_MIGRATION_LOGIN_ROLE || '').trim()
      };
      if (typeof databaseClient.withReadOnlyTransaction !== 'function') {
        throw Object.assign(new Error('A consistent read-only database snapshot is required for sender readiness.'), {
          code: 'REPLY_SENDER_NOT_READY', status: 503
        });
      }
      const readiness = await databaseClient.withReadOnlyTransaction(async applicationClient => {
        const metadata = await collectReadinessMetadata({
          applicationClient,
          migrationExecutorClient: null,
          senderClient: client,
          roles,
          stage: 'after:009',
          requireMigrationConnection: false
        });
        return assessReadiness(metadata);
      });
      if (!readiness.ok) {
        throw Object.assign(new Error('Required reply-sender database safeguards are missing or ambiguous.'), {
          code: 'REPLY_SENDER_NOT_READY', status: 503
        });
      }
      await client.query('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try { await client.query('ROLLBACK'); } catch { /* fail closed with the original readiness error */ }
      }
      if (error?.code === 'REPLY_SENDER_NOT_READY') throw error;
      throw Object.assign(new Error('Reply-sender database readiness could not be verified.'), {
        code: 'REPLY_SENDER_NOT_READY', status: 503
      });
    } finally {
      client.release();
    }
  }

  async function withSenderTransaction(callback) {
    const client = await connectSenderClient();
    try {
      const senderRole = String(env.REPLY_SENDER_ROLE || '').trim();
      const senderLogin = String(env.REPLY_SENDER_LOGIN_ROLE || '').trim();
      const ownerRole = String(env.REPLY_SEND_OWNER_ROLE || '').trim();
      if (!senderRole || !senderLogin || !ownerRole) {
        throw Object.assign(new Error('The restricted reply-sender database roles are not configured.'), {
          code: 'REPLY_SENDER_ROLE_CONFIGURATION_REQUIRED', status: 503
        });
      }
      const roleCheck = await client.query(
        `SELECT role.rolsuper,
                role.rolname = $3::name AS expected_sender_login,
                pg_has_role(current_user, $1::name, 'MEMBER') AS sender_member,
                pg_has_role(current_user, $2::name, 'MEMBER') AS owner_member,
                pg_has_role(current_user, table_info.relowner, 'MEMBER') AS table_owner,
                has_table_privilege(current_user, table_info.oid, 'INSERT')
                  OR has_any_column_privilege(current_user, table_info.oid, 'INSERT') AS direct_insert,
                has_table_privilege(current_user, table_info.oid, 'UPDATE')
                  OR has_any_column_privilege(current_user, table_info.oid, 'UPDATE') AS direct_update,
                has_table_privilege(current_user, table_info.oid, 'DELETE') AS direct_delete,
                has_table_privilege(current_user, table_info.oid, 'TRUNCATE') AS direct_truncate,
                to_regprocedure('public.claim_response_draft_send(bigint,uuid,text)') IS NOT NULL AS claim_exists,
                to_regprocedure('public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text)') IS NOT NULL AS finalizer_exists,
                CASE WHEN to_regprocedure('public.claim_response_draft_send(bigint,uuid,text)') IS NULL THEN false
                     ELSE has_function_privilege(current_user, to_regprocedure('public.claim_response_draft_send(bigint,uuid,text)')::oid, 'EXECUTE') END AS claim_execute,
                CASE WHEN to_regprocedure('public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text)') IS NULL THEN false
                     ELSE has_function_privilege(current_user, to_regprocedure('public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text)')::oid, 'EXECUTE') END AS finalizer_execute,
                (SELECT pg_get_userbyid(proowner)::name = $2::name
                   FROM pg_proc
                  WHERE oid = to_regprocedure('public.claim_response_draft_send(bigint,uuid,text)')) AS claim_owner_matches,
                (SELECT pg_get_userbyid(proowner)::name = $2::name
                   FROM pg_proc
                  WHERE oid = to_regprocedure('public.finalize_response_draft_send_v2(bigint,uuid,text,text,integer,text,text,text,text)')) AS finalizer_owner_matches
           FROM pg_roles AS role
           JOIN pg_class AS table_info ON table_info.oid = 'public.response_drafts'::regclass
          WHERE role.rolname = current_user`,
        [senderRole, ownerRole, senderLogin]
      );
      const authority = roleCheck.rows[0];
      if (!authority || authority.rolsuper || !authority.expected_sender_login || !authority.sender_member || authority.owner_member || authority.table_owner ||
          authority.direct_insert || authority.direct_update || !authority.claim_exists || !authority.finalizer_exists ||
          authority.direct_delete || authority.direct_truncate ||
          !authority.claim_execute || !authority.finalizer_execute || !authority.claim_owner_matches || !authority.finalizer_owner_matches) {
        throw Object.assign(new Error('The configured reply-sender connection does not have the restricted procedure-only boundary.'), {
          code: 'REPLY_SENDER_ROLE_INVALID', status: 503
        });
      }
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the transaction error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    assertReady,
    async inspect(draftId) {
      const { rows } = await databaseClient.query(
      `SELECT draft.*, inbox.sender_email AS inbox_sender_email,
              inbox.intent AS inbox_intent, inbox.outreach_id,
              contact.id AS linked_contact_id, contact.email AS linked_contact_email,
              contact.verification_status AS contact_verification_status,
              contact.is_suppressed AS contact_is_suppressed,
              outreach.status AS linked_outreach_status,
              EXISTS (
                SELECT 1 FROM contacts AS suppressed
                 WHERE lower(suppressed.email) = lower(draft.recipient_email)
                   AND suppressed.is_suppressed = true
              ) AS globally_suppressed
         FROM response_drafts AS draft
         LEFT JOIN inbox_messages AS inbox
           ON inbox.id = draft.inbox_message_id AND inbox.dataset_id = draft.dataset_id
         LEFT JOIN contacts AS contact
           ON contact.id = inbox.contact_id AND contact.dataset_id = draft.dataset_id
         LEFT JOIN outreach_emails AS outreach
           ON outreach.id = inbox.outreach_id AND outreach.dataset_id = draft.dataset_id
        WHERE draft.id = $1
        LIMIT 1`,
        [draftId]
      );
      return rows[0] || null;
    },

    async claim(draftId, attemptId, actorEmail) {
      return withSenderTransaction(async client => {
        const { rows } = await client.query(
          'SELECT * FROM public.claim_response_draft_send($1::bigint, $2::uuid, $3::text)',
          [draftId, attemptId, actorEmail]
        );
        return rows[0] || null;
      });
    },

    async finalize({ draftId, attemptId, actorEmail, outcome, smtpCode, smtpStage, outcomeEvidence, sendError, providerMessageId }) {
      assertFinalizationEvidence({ outcome, smtpCode, smtpStage, outcomeEvidence, sendError });
      return withSenderTransaction(async client => {
        const { rows } = await client.query(
          `SELECT public.finalize_response_draft_send_v2(
             $1::bigint, $2::uuid, $3::text, $4::text, $5::integer,
             $6::text, $7::text, $8::text, $9::text
           ) AS persisted`,
          [draftId, attemptId, actorEmail, outcome, smtpCode, smtpStage, outcomeEvidence, sendError, providerMessageId]
        );
        return rows[0]?.persisted === true;
      });
    }
  };
}

export const responseDraftSendRepository = createResponseDraftSendRepository();

export async function closeResponseDraftSendPool() {
  if (!senderPool) return;
  const activePool = senderPool;
  senderPool = null;
  await activePool.end();
}
