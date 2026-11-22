import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  createTimestampPairDiagnostic,
  matchTimestampAttempt,
  timestampEpochMillis
} from './_research-concurrency-test-utils.mjs';
import { startTestAuthServer, TEST_ADMIN_TOKEN, TEST_ADMIN_USER_ID } from './_test-auth-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.test.local');
const expectedBranch = 'tradeintel-test';
const expectedDatabase = 'neondb';
const expectedHost = 'ep-hidden-wind-b4x5ff13-pooler.c-6.us-east-2.aws.neon.tech';
const expectedConfirmation = 'CREATE_AND_DELETE_TEST_DATA';
const barrierTimeoutMs = 15000;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function requireCheck(condition, code) {
  if (!condition) fail(code);
}

function safeErrorCode(error, fallback) {
  const code = String(error?.code || '').trim();
  return /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : fallback;
}

function loadTestConfiguration() {
  requireCheck(existsSync(envPath), 'TEST_ENV_FILE_MISSING');
  let parsed;
  try {
    parsed = dotenv.parse(readFileSync(envPath));
  } catch {
    fail('TEST_ENV_FILE_UNREADABLE');
  }

  requireCheck(parsed.NEON_BRANCH === expectedBranch, 'TEST_BRANCH_MARKER_MISMATCH');
  requireCheck(parsed.DATABASE_TEST_CONFIRM === expectedConfirmation, 'TEST_CONFIRMATION_MISSING');
  requireCheck(typeof parsed.DATABASE_URL === 'string' && parsed.DATABASE_URL.length > 0, 'TEST_DATABASE_URL_MISSING');

  let databaseUrl;
  try {
    databaseUrl = new URL(parsed.DATABASE_URL);
  } catch {
    fail('TEST_DATABASE_URL_INVALID');
  }

  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  const hostOverride = [...databaseUrl.searchParams.keys()]
    .some(key => ['host', 'hostaddr'].includes(key.toLowerCase()));
  requireCheck(['postgres:', 'postgresql:'].includes(databaseUrl.protocol), 'TEST_DATABASE_PROTOCOL_REFUSED');
  requireCheck(databaseUrl.hostname === expectedHost, 'TEST_DATABASE_HOST_REFUSED');
  requireCheck(databaseUrl.pathname.startsWith('/') && databaseName === expectedDatabase && databaseUrl.pathname === `/${expectedDatabase}`, 'TEST_DATABASE_NAME_REFUSED');
  requireCheck(!hostOverride, 'TEST_DATABASE_HOST_OVERRIDE_REFUSED');

  return { databaseUrl: parsed.DATABASE_URL, databaseName, branch: parsed.NEON_BRANCH };
}

function isolateProcessEnvironment(configuration, authUrl) {
  const keys = new Set([
    'DATABASE_URL', 'DATABASE_POOL_SIZE', 'DATABASE_CONNECTION_TIMEOUT',
    'DATABASE_QUERY_TIMEOUT', 'DATABASE_IDLE_TIMEOUT', 'NEON_BRANCH',
    'DATABASE_TEST_CONFIRM', 'NODE_ENV', 'RESEARCH_API_KEY',
    'RESEARCH_PROVIDER_NAME', 'SUPABASE_AUTH_URL', 'SUPABASE_AUTH_ANON_KEY', 'ADMIN_SUPABASE_USER_ID',
    'NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY',
    'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
    'PGPASS', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGSSLMODE',
    'PGSSLROOTCERT', 'PGSSLKEY', 'PGSSLCERT'
  ]);
  const previous = new Map([...keys].map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];

  Object.assign(process.env, {
    DATABASE_URL: configuration.databaseUrl,
    DATABASE_POOL_SIZE: '4',
    DATABASE_CONNECTION_TIMEOUT: '10000',
    DATABASE_QUERY_TIMEOUT: '30000',
    DATABASE_IDLE_TIMEOUT: '5000',
    NEON_BRANCH: configuration.branch,
    DATABASE_TEST_CONFIRM: expectedConfirmation,
    NODE_ENV: 'development',
    RESEARCH_API_KEY: 'offline-test-provider-stub',
    RESEARCH_PROVIDER_NAME: 'offline-test-provider-stub',
    SUPABASE_AUTH_URL: authUrl,
    SUPABASE_AUTH_ANON_KEY: 'offline-test-auth-stub',
    ADMIN_SUPABASE_USER_ID: TEST_ADMIN_USER_ID
  });
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function makeTwoRequestBarrier(timeoutMs) {
  let count = 0;
  let release;
  const open = new Promise(resolve => { release = resolve; });
  return async function waitForBoth() {
    count++;
    requireCheck(count <= 2, 'TEST_BARRIER_RECEIVED_EXTRA_REQUEST');
    if (count === 2) release();
    let timeout;
    try {
      await Promise.race([
        open,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Object.assign(new Error('TEST_BARRIER_TIMEOUT'), { code: 'TEST_BARRIER_TIMEOUT' })), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    end() { return this; }
  };
}

function makeTaggedFixture() {
  const tag = randomUUID();
  const filename = `tradeintel-research-concurrency-${tag}.csv`;
  const companyName = `Synthetic Research Company ${tag}`;
  return {
    tag,
    filename,
    contentHash: createHash('sha256').update(`tradeintel-research-concurrency:${tag}`).digest('hex'),
    companyName,
    normalizedName: companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    datasetId: null,
    companyId: null,
    researchIds: []
  };
}

async function snapshotDatasets(pool) {
  const { rows } = await pool.query(
    `SELECT id::text AS id, md5(to_jsonb(d)::text) AS row_fingerprint
       FROM public.datasets AS d
      ORDER BY id`
  );
  return rows.map(row => ({ id: row.id, fingerprint: row.row_fingerprint }));
}

async function preflightSyntheticKeys(pool, fixture) {
  const datasetCollision = await pool.query(
    `SELECT id::text AS id
       FROM public.datasets
      WHERE filename = $1 OR content_hash = $2`,
    [fixture.filename, fixture.contentHash]
  );
  requireCheck(datasetCollision.rowCount === 0, 'SYNTHETIC_DATASET_KEY_EXISTS');

  const companyCollision = await pool.query(
    `SELECT dataset_id::text AS dataset_id, id::text AS id
       FROM public.companies
      WHERE normalized_name = $1`,
    [fixture.normalizedName]
  );
  requireCheck(companyCollision.rowCount === 0, 'SYNTHETIC_COMPANY_KEY_EXISTS');
}

async function createSyntheticDatasetAndCompany(pool, fixture) {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const dataset = await client.query(
      `INSERT INTO public.datasets
         (filename, file_type, content_hash, total_rows, valid_rows, import_status, status, analysis_status)
       VALUES ($1, 'csv', $2, 0, 0, 'COMPLETED', 'IMPORTED', 'QUEUED')
       RETURNING id::text AS id`,
      [fixture.filename, fixture.contentHash]
    );
    requireCheck(dataset.rowCount === 1, 'SYNTHETIC_DATASET_INSERT_UNEXPECTED');
    fixture.datasetId = dataset.rows[0].id;
    requireCheck(Number.isSafeInteger(Number(fixture.datasetId)), 'SYNTHETIC_DATASET_ID_UNSAFE');

    const companyKey = await client.query(
      `SELECT id::text AS id
         FROM public.companies
        WHERE dataset_id = $1 AND normalized_name = $2`,
      [fixture.datasetId, fixture.normalizedName]
    );
    requireCheck(companyKey.rowCount === 0, 'SYNTHETIC_COMPANY_KEY_EXISTS');

    const company = await client.query(
      `INSERT INTO public.companies (dataset_id, name, normalized_name)
       VALUES ($1, $2, $3)
       RETURNING id::text AS id`,
      [fixture.datasetId, fixture.companyName, fixture.normalizedName]
    );
    requireCheck(company.rowCount === 1, 'SYNTHETIC_COMPANY_INSERT_UNEXPECTED');
    fixture.companyId = company.rows[0].id;
    requireCheck(Number.isSafeInteger(Number(fixture.companyId)), 'SYNTHETIC_COMPANY_ID_UNSAFE');

    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* report the original sanitized error */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function assertResearchPairAbsent(pool, fixture) {
  const { rowCount } = await pool.query(
    `SELECT id
       FROM public.web_research
      WHERE dataset_id = $1 AND company_id = $2`,
    [fixture.datasetId, fixture.companyId]
  );
  requireCheck(rowCount === 0, 'SYNTHETIC_RESEARCH_PAIR_ALREADY_EXISTS');
}

async function captureOwnedIdsForCleanup(pool, fixture) {
  requireCheck(fixture.datasetId !== null, 'CLEANUP_CAPTURED_DATASET_ID_MISSING');
  requireCheck(fixture.companyId !== null, 'CLEANUP_CAPTURED_COMPANY_ID_MISSING');

  const dataset = await pool.query(
    `SELECT id::text AS id
       FROM public.datasets
      WHERE id = $1 AND filename = $2 AND content_hash = $3`,
    [fixture.datasetId, fixture.filename, fixture.contentHash]
  );
  requireCheck(dataset.rowCount <= 1, 'CLEANUP_DATASET_ID_AMBIGUOUS');
  requireCheck(dataset.rowCount === 0 || dataset.rows[0].id === fixture.datasetId, 'CLEANUP_DATASET_IDENTITY_MISMATCH');

  const company = await pool.query(
    `SELECT id::text AS id
       FROM public.companies
      WHERE id = $1 AND dataset_id = $2 AND name = $3 AND normalized_name = $4`,
    [fixture.companyId, fixture.datasetId, fixture.companyName, fixture.normalizedName]
  );
  requireCheck(company.rowCount <= 1, 'CLEANUP_COMPANY_ID_AMBIGUOUS');
  requireCheck(company.rowCount === 0 || company.rows[0].id === fixture.companyId, 'CLEANUP_COMPANY_IDENTITY_MISMATCH');

  const research = await pool.query(
    `SELECT id::text AS id, result->>'testRunTag' AS test_run_tag
       FROM public.web_research
      WHERE dataset_id = $1 AND company_id = $2`,
    [fixture.datasetId, fixture.companyId]
  );
  requireCheck(research.rows.every(row => row.test_run_tag === fixture.tag), 'CLEANUP_RESEARCH_IDENTITY_MISMATCH');
  fixture.researchIds = [...new Set(research.rows.map(row => row.id))];
}

async function cleanupExactIds(pool, fixture) {
  await captureOwnedIdsForCleanup(pool, fixture);
  if (fixture.datasetId === null) return;

  for (const researchId of fixture.researchIds) {
    const removed = await pool.query(
      `DELETE FROM public.web_research
        WHERE id = $1 AND dataset_id = $2 AND company_id = $3
          AND result->>'testRunTag' = $4
       RETURNING id::text AS id`,
      [researchId, fixture.datasetId, fixture.companyId, fixture.tag]
    );
    requireCheck(removed.rowCount === 1 && removed.rows[0].id === researchId, 'CLEANUP_RESEARCH_DELETE_MISMATCH');
  }

  if (fixture.companyId !== null) {
    const removed = await pool.query(
      `DELETE FROM public.companies
        WHERE id = $1 AND dataset_id = $2 AND name = $3 AND normalized_name = $4
       RETURNING id::text AS id`,
      [fixture.companyId, fixture.datasetId, fixture.companyName, fixture.normalizedName]
    );
    if (removed.rowCount !== 0) requireCheck(removed.rowCount === 1 && removed.rows[0].id === fixture.companyId, 'CLEANUP_COMPANY_DELETE_MISMATCH');
  }

  const removedDataset = await pool.query(
    `DELETE FROM public.datasets
      WHERE id = $1 AND filename = $2 AND content_hash = $3
     RETURNING id::text AS id`,
    [fixture.datasetId, fixture.filename, fixture.contentHash]
  );
  if (removedDataset.rowCount !== 0) requireCheck(removedDataset.rowCount === 1 && removedDataset.rows[0].id === fixture.datasetId, 'CLEANUP_DATASET_DELETE_MISMATCH');

  const leftovers = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM public.datasets WHERE id = $1) AS datasets,
       (SELECT count(*)::int FROM public.companies WHERE id = $2 AND dataset_id = $1) AS companies,
       (SELECT count(*)::int FROM public.web_research WHERE dataset_id = $1 AND company_id = $2) AS research_pair,
       (SELECT count(*)::int FROM public.web_research WHERE id = ANY($3::bigint[])) AS research_ids`,
    [fixture.datasetId, fixture.companyId, fixture.researchIds]
  );
  const remaining = leftovers.rows[0];
  requireCheck(Number(remaining.datasets) === 0, 'CLEANUP_DATASET_REMAINS');
  requireCheck(Number(remaining.companies) === 0, 'CLEANUP_COMPANY_REMAINS');
  requireCheck(Number(remaining.research_pair) === 0, 'CLEANUP_RESEARCH_PAIR_REMAINS');
  requireCheck(Number(remaining.research_ids) === 0, 'CLEANUP_RESEARCH_ID_REMAINS');
}

async function main() {
  let configuration;
  try {
    configuration = loadTestConfiguration();
  } catch (error) {
    console.error(`REFUSED: test configuration check failed code=${safeErrorCode(error, 'TEST_CONFIGURATION_INVALID')}`);
    process.exitCode = 1;
    return;
  }

  const authServer = await startTestAuthServer();
  const restoreEnvironment = isolateProcessEnvironment(configuration, authServer.url);
  const fixture = makeTaggedFixture();
  let pool;
  let database;
  let researchProvider;
  let tavily;
  let originalDatabaseFrom;
  let originalResearchMethod;
  let originalTavilySearch;
  let baselineBefore = null;
  let baselinePreserved = null;
  let targetVerified = false;
  let fixtureWriteAttempted = false;
  let cleanupAttempted = false;
  let cleanupVerified = null;
  let failureCode = null;
  let cleanupFailureCode = null;
  let researchProviderCalls = 0;
  let realAdapterCalls = 0;
  let researchRowsObservedBeforeCleanup = null;
  let timestampPairDiagnostics = null;
  const upsertAttempts = [];

  try {
    const pgModule = await import('pg');
    const Pool = pgModule.default.Pool;
    pool = new Pool({
      connectionString: configuration.databaseUrl,
      max: 4,
      connectionTimeoutMillis: 10000,
      query_timeout: 30000,
      idleTimeoutMillis: 5000
    });
    pool.on('error', error => {
      console.error(`TEST_POOL_ERROR: code=${safeErrorCode(error, 'DATABASE_ERROR')}`);
    });

    // The branch identity is established from the file's NEON_BRANCH marker and the exact
    // branch-specific endpoint, with host/hostaddr URL overrides rejected above.
    const liveTarget = await pool.query(
      `SELECT current_database() AS database_name,
              current_schema() AS schema_name,
              current_setting('server_version') AS server_version`
    );
    requireCheck(liveTarget.rowCount === 1, 'LIVE_TARGET_QUERY_UNEXPECTED');
    requireCheck(liveTarget.rows[0].database_name === expectedDatabase, 'LIVE_DATABASE_MISMATCH');
    requireCheck(liveTarget.rows[0].schema_name === 'public', 'LIVE_SCHEMA_MISMATCH');
    targetVerified = true;

    baselineBefore = await snapshotDatasets(pool);
    await preflightSyntheticKeys(pool, fixture);

    const [{ default: dbClient }, { default: provider }, { default: tavilyAdapter }] = await Promise.all([
      import('../api/_db-client.js'),
      import('../api/_research-provider.js'),
      import('../api/providers/_tavily.js')
    ]);
    database = dbClient;
    researchProvider = provider;
    tavily = tavilyAdapter;
    originalDatabaseFrom = database.from;
    originalResearchMethod = researchProvider.performResearch;
    originalTavilySearch = tavily.search;

    fixtureWriteAttempted = true;
    await createSyntheticDatasetAndCompany(pool, fixture);
    await assertResearchPairAbsent(pool, fixture);

    const bothExistenceChecksComplete = makeTwoRequestBarrier(barrierTimeoutMs);
    researchProvider.performResearch = async (datasetId, company) => {
      const sequence = ++researchProviderCalls;
      const check = await pool.query(
        `SELECT id
           FROM public.web_research
          WHERE dataset_id = $1 AND company_id = $2`,
        [datasetId, company.id]
      );
      requireCheck(check.rowCount === 0, 'TEST_PROVIDER_EXISTENCE_CHECK_NOT_EMPTY');
      await bothExistenceChecksComplete();
      return {
        data: {
          testRunTag: fixture.tag,
          testRequest: sequence,
          summary: 'Deterministic offline concurrency fixture',
          sources: []
        }
      };
    };
    tavily.search = async () => {
      realAdapterCalls++;
      fail('REAL_TAVILY_ADAPTER_BLOCKED');
    };

    database.from = function from(table) {
      const query = originalDatabaseFrom.call(this, table);
      if (table === 'web_research') {
        const originalUpsert = query.upsert.bind(query);
        query.upsert = (rows, options = {}) => {
          const row = Array.isArray(rows) ? rows[0] : rows;
          upsertAttempts.push({
            conflictTarget: options.onConflict,
            testRequest: row?.result?.testRequest,
            updatedAt: row?.updated_at
          });
          return originalUpsert(rows, options);
        };
      }
      return query;
    };

    const { default: researchHandler } = await import('../api/_routes/research.js');
    const request = () => ({
      method: 'POST',
      headers: { authorization: 'Bearer ' + TEST_ADMIN_TOKEN },
      query: {},
      body: { datasetId: Number(fixture.datasetId), companyId: Number(fixture.companyId) }
    });
    const responses = [responseRecorder(), responseRecorder()];
    const startedAt = Date.now();
    await Promise.all(responses.map(response => researchHandler(request(), response)));
    const finishedAt = Date.now();

    requireCheck(researchProviderCalls === 2, 'RESEARCH_PROVIDER_STUB_CALL_COUNT_MISMATCH');
    requireCheck(realAdapterCalls === 0, 'REAL_RESEARCH_ADAPTER_WAS_CALLED');
    requireCheck(responses.every(response => response.statusCode === 200 && response.payload?.success === true), 'CONCURRENT_RESEARCH_REQUEST_FAILED');
    requireCheck(upsertAttempts.length === 2, 'RESEARCH_UPSERT_CALL_COUNT_MISMATCH');
    requireCheck(upsertAttempts.every(attempt => attempt.conflictTarget === 'dataset_id,company_id'), 'RESEARCH_UPSERT_TARGET_MISMATCH');

    const responseRequests = responses.map(response => response.payload.data?.testRequest);
    requireCheck(new Set(responseRequests).size === 2, 'RESEARCH_RESPONSES_NOT_DISTINCT');
    requireCheck(upsertAttempts.every(attempt => responseRequests.includes(attempt.testRequest)), 'RESEARCH_UPSERT_RESULT_MISMATCH');
    requireCheck(upsertAttempts.every(attempt => Number.isFinite(Date.parse(attempt.updatedAt))), 'RESEARCH_UPSERT_TIMESTAMP_MISSING');

    const persisted = await pool.query(
      `SELECT id::text AS id, dataset_id::text AS dataset_id,
              company_id::text AS company_id, result, updated_at
         FROM public.web_research
        WHERE dataset_id = $1 AND company_id = $2`,
      [fixture.datasetId, fixture.companyId]
    );
    researchRowsObservedBeforeCleanup = persisted.rowCount;
    requireCheck(persisted.rowCount === 1, 'RESEARCH_PAIR_ROW_COUNT_MISMATCH');
    const researchRow = persisted.rows[0];
    fixture.researchIds = [researchRow.id];
    requireCheck(researchRow.dataset_id === fixture.datasetId && researchRow.company_id === fixture.companyId, 'RESEARCH_ROW_KEY_MISMATCH');
    requireCheck(researchRow.result?.testRunTag === fixture.tag, 'RESEARCH_ROW_TAG_MISMATCH');
    const persistedRequest = researchRow.result?.testRequest;
    requireCheck(responseRequests.includes(persistedRequest), 'RESEARCH_FINAL_RESULT_NOT_FROM_TEST_PROVIDER');
    const timestampAttempt = matchTimestampAttempt(upsertAttempts, persistedRequest);
    requireCheck(timestampAttempt, 'RESEARCH_FINAL_TIMESTAMP_ATTEMPT_MISSING');
    const persistedTimestamp = timestampEpochMillis(researchRow.updated_at);
    const attemptedTimestamp = timestampEpochMillis(timestampAttempt.updatedAt);
    timestampPairDiagnostics = createTimestampPairDiagnostic({
      persistedRequest,
      persistedUpdatedAt: researchRow.updated_at,
      timestampAttempt
    });
    requireCheck(Number.isFinite(persistedTimestamp) && persistedTimestamp >= startedAt && persistedTimestamp <= finishedAt, 'RESEARCH_UPDATED_AT_OUT_OF_RANGE');
    requireCheck(Number.isFinite(attemptedTimestamp) && persistedTimestamp === attemptedTimestamp, 'RESEARCH_RESULT_TIMESTAMP_PAIR_MISMATCH');
  } catch (error) {
    failureCode = safeErrorCode(error, 'TEST_FAILED');
  } finally {
    if (pool && targetVerified) {
      if (fixtureWriteAttempted) {
        cleanupAttempted = true;
        try {
          await cleanupExactIds(pool, fixture);
          cleanupVerified = true;
        } catch (error) {
          cleanupVerified = false;
          cleanupFailureCode = safeErrorCode(error, 'CLEANUP_FAILED');
        }
      }

      if (baselineBefore) {
        try {
          baselinePreserved = JSON.stringify(await snapshotDatasets(pool)) === JSON.stringify(baselineBefore);
          if (!baselinePreserved) cleanupFailureCode ||= 'BASELINE_DATASET_SNAPSHOT_MISMATCH';
        } catch (error) {
          cleanupFailureCode ||= safeErrorCode(error, 'BASELINE_VERIFICATION_FAILED');
        }
      }
    }

    if (database && originalDatabaseFrom) database.from = originalDatabaseFrom;
    if (researchProvider && originalResearchMethod) researchProvider.performResearch = originalResearchMethod;
    if (tavily && originalTavilySearch) tavily.search = originalTavilySearch;
    try { await database?.close(); } catch { cleanupFailureCode ||= 'APPLICATION_POOL_CLOSE_FAILED'; }
    try { await pool?.end(); } catch { cleanupFailureCode ||= 'TEST_POOL_CLOSE_FAILED'; }
    restoreEnvironment();
    await authServer.close();
  }

  const status = failureCode || cleanupFailureCode ? 'FAIL' : 'PASS';
  console.log(JSON.stringify({
    status,
    branchMarker: configuration.branch,
    database: configuration.databaseName,
    targetVerified,
    concurrentRequests: researchProviderCalls,
    realResearchAdapterCalls: realAdapterCalls,
    emailOperations: 0,
    researchRowsObservedBeforeCleanup,
    timestampPairDiagnostics,
    cleanupAttempted,
    cleanupVerified,
    baselineDatasetsPreserved: baselinePreserved,
    supervisorPersistenceSeparatelyCovered: false,
    failureCode,
    cleanupFailureCode
  }));
  if (status !== 'PASS') process.exitCode = 1;
}

await main();
