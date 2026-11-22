import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { inspectDatabaseTargetConsistency } from '../api/_database-target.js';
import { migrationPlan, migrationPlanThrough } from '../api/_migration-plan.js';

const { Pool } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = path.join(root, 'database', 'migrations');

for (const envFile of ['.env.local', '.env.vercel.local']) {
  const envPath = path.join(root, envFile);
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

const filesOnDisk = (await readdir(migrationDirectory)).filter(file => file.endsWith('.sql')).sort();
const plannedFiles = migrationPlan.map(migration => migration.file).sort();
if (filesOnDisk.length !== plannedFiles.length || filesOnDisk.some((file, index) => file !== plannedFiles[index])) {
  console.error('DATABASE_MIGRATION_PLAN_INVALID: Register every SQL migration exactly once in scripts/db-migrate.mjs.');
  process.exitCode = 1;
}

let selectedMigrationPlan = migrationPlan;
const migrationArguments = process.argv.slice(2);
if (migrationArguments.length > 0) {
  try {
    if (migrationArguments.length !== 2 || migrationArguments[0] !== '--through') {
      throw new Error('Use --through 007_response_draft_send_state, 008_reply_sender_boundary, or 009_reply_sender_safety_hardening.');
    }
    selectedMigrationPlan = migrationPlanThrough(migrationArguments[1]);
  } catch (error) {
    console.error(`DATABASE_MIGRATION_ARGUMENT_INVALID: ${error.message}`);
    process.exitCode = 1;
    selectedMigrationPlan = [];
  }
}

const migrations = await Promise.all(selectedMigrationPlan.map(async migration => {
  const sql = await readFile(path.join(migrationDirectory, migration.file), 'utf8');
  return { ...migration, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}));
const databaseUrl = String(process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL || '').trim();
const targetConsistency = inspectDatabaseTargetConsistency();

if (databaseUrl && targetConsistency.status !== 'MATCH') {
  const code = targetConsistency.status === 'MISMATCH' ? 'DATABASE_TARGET_MISMATCH' : 'DATABASE_TARGET_UNVERIFIED';
  console.error(`${code}: database target configuration is conflicting or could not be verified; no migration connection was opened.`);
  process.exitCode = 1;
}

async function hasVerifiedWebResearchUniqueIndex(client) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1
        FROM pg_index index_info
        JOIN pg_class table_info ON table_info.oid = index_info.indrelid
        JOIN pg_class index_relation ON index_relation.oid = index_info.indexrelid
       WHERE table_info.oid = to_regclass('public.web_research')
         AND index_relation.relname = 'web_research_dataset_company_key'
         AND index_info.indisunique
         AND index_info.indisvalid
         AND index_info.indpred IS NULL
         AND (
           SELECT array_agg(attribute.attname::text ORDER BY key_column.ordinality)
             FROM unnest(index_info.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
             JOIN pg_attribute attribute
               ON attribute.attrelid = table_info.oid
              AND attribute.attnum = key_column.attnum
         ) = ARRAY['dataset_id', 'company_id']::text[]
    ) AS verified
  `);
  return result.rows[0]?.verified === true;
}

if (!databaseUrl) {
  console.error('DATABASE_UNAVAILABLE: Set DATABASE_URL or DATABASE_DIRECT_URL in the environment or .env.local.');
  process.exitCode = 1;
} else if (!process.exitCode) {
  const timeout = Math.max(1000, Math.min(120000, Number.parseInt(process.env.DATABASE_QUERY_TIMEOUT || '30000', 10) || 30000));
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: Math.max(1000, Math.min(30000, Number.parseInt(process.env.DATABASE_CONNECTION_TIMEOUT || '5000', 10) || 5000)),
    query_timeout: timeout,
    statement_timeout: timeout,
    idleTimeoutMillis: 5000
  });

  let client;
  let locked = false;
  let activeMigration = 'bootstrap';
  try {
    client = await pool.connect();
    await client.query('SELECT pg_advisory_lock($1::bigint)', ['7418024119']);
    locked = true;

    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query('COMMIT');

    for (const migration of migrations) {
      activeMigration = migration.version;
      await client.query('BEGIN');
      try {
        const previous = await client.query('SELECT checksum FROM public.schema_migrations WHERE version = $1', [migration.version]);
        if (previous.rowCount) {
          if (previous.rows[0].checksum !== migration.checksum) {
            // This legacy migration was recorded with an earlier SQL checksum.
            // Accept it only when its exact resulting index is present and valid.
            const compatibleLegacyApply = migration.version === '003_add_web_research_uniqueness'
              && await hasVerifiedWebResearchUniqueIndex(client);
            if (!compatibleLegacyApply) {
              throw Object.assign(new Error('Applied migration checksum differs from the checked-in migration.'), { code: 'DATABASE_MIGRATION_CHECKSUM_MISMATCH' });
            }
            await client.query('COMMIT');
            console.log(`Migration ${migration.version} is applied; its checked schema effect was verified.`);
            continue;
          }
          await client.query('COMMIT');
          console.log(`Migration ${migration.version} is already applied.`);
          continue;
        }

        if (migration.version === '008_reply_sender_boundary') {
          const replySendOwnerRole = String(process.env.REPLY_SEND_OWNER_ROLE || '').trim();
          const replySenderRole = String(process.env.REPLY_SENDER_ROLE || '').trim();
          if (!replySendOwnerRole || !replySenderRole) {
            throw Object.assign(new Error('Reply sender database roles must be provisioned and configured before migration 008.'), {
              code: 'REPLY_SENDER_ROLE_CONFIGURATION_REQUIRED'
            });
          }
          await client.query(
            `SELECT set_config('tradeintel.reply_send_owner_role', $1, true),
                    set_config('tradeintel.reply_sender_role', $2, true)`,
            [replySendOwnerRole, replySenderRole]
          );
        }

        if (migration.version === '009_reply_sender_safety_hardening') {
          const replySendOwnerRole = String(process.env.REPLY_SEND_OWNER_ROLE || '').trim();
          const replySenderRole = String(process.env.REPLY_SENDER_ROLE || '').trim();
          const replySendAppRole = String(process.env.REPLY_SEND_APP_ROLE || '').trim();
          const replySenderLoginRole = String(process.env.REPLY_SENDER_LOGIN_ROLE || '').trim();
          const replySendMigrationLoginRole = String(process.env.REPLY_SEND_MIGRATION_LOGIN_ROLE || '').trim();
          if (!replySendOwnerRole || !replySenderRole || !replySendAppRole || !replySenderLoginRole || !replySendMigrationLoginRole) {
            throw Object.assign(new Error('Migration 009 requires administrator-provisioned owner, sender group, application login, sender login, and migration login roles.'), {
              code: 'REPLY_SENDER_ROLE_CONFIGURATION_REQUIRED'
            });
          }
          await client.query(
            `SELECT set_config('tradeintel.reply_send_owner_role', $1, true),
                    set_config('tradeintel.reply_sender_role', $2, true),
                    set_config('tradeintel.reply_send_app_role', $3, true),
                    set_config('tradeintel.reply_sender_login_role', $4, true),
                    set_config('tradeintel.reply_send_migration_login_role', $5, true)`,
            [replySendOwnerRole, replySenderRole, replySendAppRole, replySenderLoginRole, replySendMigrationLoginRole]
          );
        }

        await client.query(migration.sql);
        await client.query('INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)', [migration.version, migration.checksum]);
        await client.query('COMMIT');
        console.log(`Migration ${migration.version} applied successfully.`);
      } catch (migrationError) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the migration error */ }
        throw migrationError;
      }
    }
  } catch (error) {
    const code = error?.code === '57014' || error?.code === 'QUERY_TIMEOUT'
      ? 'DATABASE_TIMEOUT'
      : ['42P01', '42703', '42804'].includes(error?.code)
        ? 'DATABASE_SCHEMA_ERROR'
        : ['57P03', '57P01', 'ECONNREFUSED', 'ECONNRESET', 'EACCES'].includes(error?.code) || String(error?.code || '').startsWith('08')
          ? 'DATABASE_UNAVAILABLE'
          : String(error?.code || 'DATABASE_MIGRATION_FAILED');
    console.error(`${code}: migration=${activeMigration} failed; no credentials or row values were printed.`);
    process.exitCode = 1;
  } finally {
    if (locked && client) {
      try { await client.query('SELECT pg_advisory_unlock($1::bigint)', ['7418024119']); } catch { /* close the connection below */ }
    }
    if (client) client.release();
    await pool.end();
  }
}
