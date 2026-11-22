import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { POTENTIAL_SCORE_VALIDATION_SQL } from '../api/_potential-score-validation.js';
import { inspectDatabaseTargetConsistency } from '../api/_database-target.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const envFile of ['.env.local', '.env.vercel.local']) {
  const envPath = path.join(root, envFile);
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

const { Pool } = pg;
const databaseUrl = String(process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL || '').trim();
const targetConsistency = inspectDatabaseTargetConsistency();
if (!databaseUrl) {
  console.error('DATABASE_UNAVAILABLE: Configure DATABASE_URL before running the database smoke test.');
  process.exitCode = 1;
} else if (targetConsistency.status !== 'MATCH') {
  const code = targetConsistency.status === 'MISMATCH' ? 'DATABASE_TARGET_MISMATCH' : 'DATABASE_TARGET_UNVERIFIED';
  console.error(`${code}: database target configuration is conflicting or could not be verified; no smoke-test connection was opened.`);
  process.exitCode = 1;
} else if (process.env.DATABASE_TEST_CONFIRM !== 'CREATE_AND_DELETE_TEST_DATA') {
  console.error('REFUSED: Set DATABASE_TEST_CONFIRM=CREATE_AND_DELETE_TEST_DATA to permit creation and removal of tagged test rows.');
  process.exitCode = 1;
} else {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: Math.max(1000, Math.min(30000, Number.parseInt(process.env.DATABASE_CONNECTION_TIMEOUT || '5000', 10) || 5000)),
    query_timeout: Math.max(1000, Math.min(120000, Number.parseInt(process.env.DATABASE_QUERY_TIMEOUT || '30000', 10) || 30000)),
    idleTimeoutMillis: 5000
  });
  const tag = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const health = await client.query('SELECT current_database() AS database_name, 1 AS ok');
    const dataset = await client.query(
      `INSERT INTO datasets (filename, file_type, content_hash, total_rows, valid_rows, duplicate_rows, error_rows, status, import_status)
       VALUES ($1, 'test', $2, 1, 1, 0, 0, 'TEST', 'COMPLETED') RETURNING id`,
      [`tradeintel-db-smoke-${tag}.csv`, tag]
    );
    const datasetId = dataset.rows[0].id;
    const company = await client.query(
      `INSERT INTO companies (dataset_id, name, normalized_name, country)
       VALUES ($1, 'DB Smoke Test', $2, 'Test') RETURNING id`,
      [datasetId, `dbsmoketest${tag.replace(/-/g, '')}`]
    );
    await client.query(
      `INSERT INTO raw_records (dataset_id, row_index, raw_data, errors, is_valid, raw_hash)
       VALUES ($1, 1, $2::jsonb, '[]'::jsonb, true, $3)`,
      [datasetId, JSON.stringify({ tag }), tag]
    );
    await client.query(
      `INSERT INTO normalized_records (dataset_id, source_row_index, source_hash, company_id, company_name, product_name)
       VALUES ($1, 1, $2, $3, 'DB Smoke Test', 'Test Product')`,
      [datasetId, tag, company.rows[0].id]
    );

    const scoreEvidence = {
      factors: {
        productFit: { value: 11, status: 'AVAILABLE', weight: 20 },
        activity: { value: 8, status: 'AVAILABLE', weight: 15 },
        recency: { value: null, status: 'UNAVAILABLE', weight: 15 },
        marketFit: { value: 10, status: 'AVAILABLE', weight: 10 },
        commercialRelevance: { value: null, status: 'UNAVAILABLE', weight: 15 },
        growth: { value: null, status: 'UNAVAILABLE', weight: 10 },
        supplierDiversification: { value: null, status: 'UNAVAILABLE', weight: 5 },
        engagement: { value: null, status: 'UNAVAILABLE', weight: 10 }
      },
      scoreMetadata: { modelWeight: 100, availableWeight: 45, excludedWeight: 55, rawWeightedScore: 29, normalizedScore: 64.44 }
    };
    await client.query(
      `INSERT INTO company_potential (
         dataset_id, company_id, product_fit_score, activity_score, recency_score, market_fit_score,
         commercial_relevance_score, growth_score, supplier_diversification_score, engagement_score,
         total_score, category, evidence_breakdown
       ) VALUES ($1, $2, 11, 8, NULL, 10, NULL, NULL, NULL, NULL, 64.44, 'MEDIUM', $3::jsonb)`,
      [datasetId, company.rows[0].id, JSON.stringify(scoreEvidence)]
    );
    const scoreValidation = await client.query(POTENTIAL_SCORE_VALIDATION_SQL, [datasetId, [company.rows[0].id]]);
    if (Number(scoreValidation.rows[0]?.score_count) !== 1 || Number(scoreValidation.rows[0]?.invalid_score_count) !== 0) {
      throw new Error('Evidence-weighted score validation rejected a valid synthetic score with unavailable factors.');
    }

    const researchUpdatedAt = new Date().toISOString();
    await client.query(
      `INSERT INTO web_research (dataset_id, company_id, result, updated_at)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [datasetId, company.rows[0].id, JSON.stringify({ synthetic: true }), researchUpdatedAt]
    );
    const research = await client.query(
      'SELECT updated_at FROM web_research WHERE dataset_id = $1 AND company_id = $2',
      [datasetId, company.rows[0].id]
    );
    if (research.rowCount !== 1 || new Date(research.rows[0].updated_at).toISOString() !== researchUpdatedAt) {
      throw new Error('Research updated_at persistence verification failed.');
    }

    const read = await client.query(
      `SELECT d.filename, r.row_index, n.source_row_index, n.company_id
       FROM datasets d
       JOIN raw_records r ON r.dataset_id = d.id
       JOIN normalized_records n ON n.dataset_id = d.id
       WHERE d.id = $1`, [datasetId]
    );
    if (read.rowCount !== 1 || Number(read.rows[0].row_index) !== 1 || Number(read.rows[0].source_row_index) !== 1) {
      throw new Error('Inserted rows were not read back with their dataset and source-row relationship intact.');
    }

    await client.query('UPDATE datasets SET status = $1 WHERE id = $2', ['UPDATED', datasetId]);
    const updated = await client.query('SELECT status FROM datasets WHERE id = $1', [datasetId]);
    if (updated.rows[0]?.status !== 'UPDATED') throw new Error('Dataset update verification failed.');

    await client.query('SAVEPOINT duplicate_check');
    let duplicateRejected = false;
    try {
      await client.query(
        `INSERT INTO raw_records (dataset_id, row_index, raw_data, is_valid) VALUES ($1, 1, '{}'::jsonb, true)`,
        [datasetId]
      );
    } catch (error) {
      duplicateRejected = error.code === '23505';
      await client.query('ROLLBACK TO SAVEPOINT duplicate_check');
    }
    await client.query('RELEASE SAVEPOINT duplicate_check');
    if (!duplicateRejected) throw new Error('Duplicate (dataset_id, row_index) protection did not reject the duplicate row.');

    await client.query('SAVEPOINT cross_dataset_check');
    let crossDatasetRejected = false;
    try {
      const other = await client.query(
        `INSERT INTO datasets (filename, file_type, total_rows, status) VALUES ($1, 'test', 0, 'TEST') RETURNING id`,
        [`tradeintel-db-scope-${tag}.csv`]
      );
      await client.query(
        `INSERT INTO normalized_records (dataset_id, source_row_index, source_hash, company_id, company_name, product_name)
         VALUES ($1, 1, $2, $3, 'Wrong Scope', 'Test Product')`,
        [other.rows[0].id, `${tag}-cross-scope`, company.rows[0].id]
      );
    } catch (error) {
      crossDatasetRejected = error.code === '23503';
      await client.query('ROLLBACK TO SAVEPOINT cross_dataset_check');
    }
    await client.query('RELEASE SAVEPOINT cross_dataset_check');
    if (!crossDatasetRejected) throw new Error('Cross-dataset entity foreign-key protection failed.');

    await client.query('SAVEPOINT rollback_check');
    await client.query(
      `INSERT INTO datasets (filename, file_type, total_rows, status) VALUES ($1, 'test', 0, 'TEST')`,
      [`tradeintel-db-rollback-${tag}.csv`]
    );
    await client.query('ROLLBACK TO SAVEPOINT rollback_check');
    await client.query('RELEASE SAVEPOINT rollback_check');
    const rollback = await client.query('SELECT count(*)::int AS count FROM datasets WHERE filename = $1', [`tradeintel-db-rollback-${tag}.csv`]);
    if (rollback.rows[0].count !== 0) throw new Error('Transaction rollback verification failed.');

    const indexes = await client.query(
      `SELECT to_regclass('public.raw_records_dataset_id_idx') IS NOT NULL AS raw_index,
              to_regclass('public.normalized_records_dataset_company_idx') IS NOT NULL AS normalized_company_index,
              to_regclass('public.leads_dataset_status_created_idx') IS NOT NULL AS lead_status_index`
    );
    if (!indexes.rows[0].raw_index || !indexes.rows[0].normalized_company_index || !indexes.rows[0].lead_status_index) {
      throw new Error('Required dataset, company, or lead-status indexes are missing.');
    }

    // Dataset-owned rows use RESTRICT foreign keys intentionally. Remove the
    // smoke-test children explicitly in dependency order before deleting their
    // dataset, then verify the complete tagged fixture is gone.
    await client.query('DELETE FROM web_research WHERE dataset_id = $1', [datasetId]);
    await client.query('DELETE FROM company_potential WHERE dataset_id = $1', [datasetId]);
    await client.query('DELETE FROM normalized_records WHERE dataset_id = $1', [datasetId]);
    await client.query('DELETE FROM raw_records WHERE dataset_id = $1', [datasetId]);
    await client.query('DELETE FROM companies WHERE dataset_id = $1', [datasetId]);
    await client.query('DELETE FROM datasets WHERE id = $1', [datasetId]);
    const cleanup = await client.query(
      `SELECT (SELECT count(*) FROM datasets WHERE id = $1)::int AS dataset_count,
              (SELECT count(*) FROM raw_records WHERE dataset_id = $1)::int AS raw_count,
              (SELECT count(*) FROM normalized_records WHERE dataset_id = $1)::int AS normalized_count,
              (SELECT count(*) FROM company_potential WHERE dataset_id = $1)::int AS potential_count,
              (SELECT count(*) FROM web_research WHERE dataset_id = $1)::int AS research_count,
              (SELECT count(*) FROM companies WHERE dataset_id = $1)::int AS company_count`,
      [datasetId]
    );
    if (cleanup.rows[0].dataset_count || cleanup.rows[0].raw_count || cleanup.rows[0].normalized_count || cleanup.rows[0].potential_count || cleanup.rows[0].research_count || cleanup.rows[0].company_count) {
      throw new Error('Dataset cascade behavior left dataset-owned test rows behind.');
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({ status: 'VERIFIED', database: health.rows[0].database_name, checks: [
      'connection', 'insert', 'read', 'update', 'duplicate constraint', 'dataset isolation foreign key',
      'transaction rollback', 'evidence-weighted score validation', 'research updated_at persistence', 'required indexes', 'dataset-owned ordered cleanup'
    ] }));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original smoke test failure */ }
    const code = error?.code === '57014' || error?.code === 'QUERY_TIMEOUT'
      ? 'DATABASE_TIMEOUT'
      : ['42P01', '42703', '42804'].includes(error?.code)
        ? 'DATABASE_SCHEMA_ERROR'
        : ['57P03', '57P01', 'ECONNREFUSED', 'ECONNRESET'].includes(error?.code) || String(error?.code || '').startsWith('08')
          ? 'DATABASE_UNAVAILABLE'
          : String(error?.code || 'DATABASE_SMOKE_FAILED');
    console.error(`${code}: ${error?.message || 'Database smoke test failed.'}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
