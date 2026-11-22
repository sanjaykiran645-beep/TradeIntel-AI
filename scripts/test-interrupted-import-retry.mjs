import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startTestAuthServer, TEST_ADMIN_TOKEN, TEST_ADMIN_USER_ID } from './_test-auth-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testEnvPath = path.join(root, '.env.test.local');

if (!existsSync(testEnvPath)) {
  console.error('TEST_CONFIGURATION_UNAVAILABLE: .env.test.local is required.');
  process.exit(1);
}

process.loadEnvFile(testEnvPath);

if (process.env.DATABASE_TEST_CONFIRM !== 'CREATE_AND_DELETE_TEST_DATA' || process.env.NEON_BRANCH !== 'tradeintel-test') {
  console.error('REFUSED: Must target tradeintel-test with confirmation flag.');
  process.exit(1);
}

process.env.NODE_ENV = 'development';
const authServer = await startTestAuthServer();
process.env.SUPABASE_AUTH_URL = authServer.url;
process.env.SUPABASE_AUTH_ANON_KEY = 'offline-synthetic-test-anon-key';
process.env.ADMIN_SUPABASE_USER_ID = TEST_ADMIN_USER_ID;

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 10000,
  query_timeout: 60000,
  idleTimeoutMillis: 5000
});
pool.on('error', (err) => {
  if (err && (err.code === 'ECONNRESET' || err.message?.includes('socket') || err.message?.includes('closed'))) return;
  console.warn('Unexpected pool background error:', err?.message || err);
});

const [{ default: datasetsHandler }, { default: supervisorHandler }, { DATASET_OWNED_TABLES_IN_DELETE_ORDER }] = await Promise.all([
  import('../api/_routes/datasets.js'),
  import('../api/_routes/supervisor.js'),
  import('../api/_dataset-delete.js')
]);

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    end() { this.ended = true; return this; }
  };
}

async function invoke(handler, method, body = {}, query = {}) {
  const response = responseStub();
  await handler({
    method,
    body,
    query,
    headers: { authorization: 'Bearer ' + TEST_ADMIN_TOKEN },
    socket: { remoteAddress: '127.0.0.1' },
    user: { email: 'test-runner@tradeintel.internal', role: 'admin' }
  }, response);
  return response;
}

const createdDatasetIds = [];

async function cleanup() {
  if (!createdDatasetIds.length) return;
  for (const table of DATASET_OWNED_TABLES_IN_DELETE_ORDER) {
    try {
      await pool.query(`DELETE FROM ${table} WHERE dataset_id = ANY($1)`, [createdDatasetIds]);
    } catch {}
  }
  try {
    await pool.query('DELETE FROM datasets WHERE id = ANY($1)', [createdDatasetIds]);
  } catch (err) {
    console.warn('Batch dataset delete failed:', err.message);
  }
}

try {
  console.log('================================================================');
  console.log('TRADEINTEL AI: INTERRUPTED IMPORT, IDEMPOTENCY & RETRY TEST SUITE');
  console.log('================================================================\n');

  const tag = randomUUID();
  const filename = `test-interrupted-retry-${tag}.csv`;
  const totalRows = 30; // 3 chunks of 10 rows
  const rows = [];
  for (let i = 0; i < totalRows; i++) {
    rows.push({
      'Importer Name': `Retry Test Corp ${i % 5} ${tag}`,
      'Product Description': `Precision Sensor ${i % 3}`,
      Country: 'Germany',
      Quantity: String(100 + i),
      'Total FOB Value in INR': String(50000 + i * 1000),
      Sbill_Date: '2026-02-01',
      Currency: 'INR'
    });
  }

  const uploadHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');

  // Step 1: Start chunked import
  console.log('1. Initiating chunked import...');
  const startRes = await invoke(datasetsHandler, 'POST', {
    action: 'START_IMPORT',
    filename,
    fileType: 'csv',
    expectedRows: totalRows,
    columns: Object.keys(rows[0]),
    uploadHash,
    originalSizeBytes: 4096
  });
  assert.equal(startRes.statusCode, 201, 'START_IMPORT must return 201');
  const datasetId = startRes.payload.datasetId;
  createdDatasetIds.push(datasetId);
  console.log(`   Import started with datasetId=${datasetId}, nextRowIndex=${startRes.payload.nextRowIndex}`);

  // Step 2: Append Chunk 1 (rows 0..9)
  console.log('2. Appending batch 1 (rows 0..9)...');
  const chunk1Res = await invoke(datasetsHandler, 'POST', {
    action: 'APPEND_IMPORT_BATCH',
    datasetId,
    uploadHash,
    startRowIndex: 0,
    rows: rows.slice(0, 10)
  });
  assert.equal(chunk1Res.statusCode, 200);
  assert.equal(chunk1Res.payload.nextRowIndex, 10);
  assert.equal(chunk1Res.payload.processedRows, 10);

  // Step 3: Simulate interruption / out-of-order chunk submission
  console.log('3. Simulating network out-of-order submission (attempting rows 20..29 before 10..19)...');
  const outOfOrderRes = await invoke(datasetsHandler, 'POST', {
    action: 'APPEND_IMPORT_BATCH',
    datasetId,
    uploadHash,
    startRowIndex: 20,
    rows: rows.slice(20, 30)
  });
  assert.equal(outOfOrderRes.statusCode, 409, 'Must reject out-of-order batch with 409');
  assert.equal(outOfOrderRes.payload.code, 'IMPORT_OFFSET_CONFLICT');
  assert.equal(outOfOrderRes.payload.nextRowIndex, 10, 'Must instruct client to send row index 10');
  console.log('   Correctly rejected out-of-order batch; instructed nextRowIndex=10');

  // Step 4: Simulate client disconnect and resume via START_IMPORT
  console.log('4. Simulating client reconnect / resume via START_IMPORT...');
  const resumeRes = await invoke(datasetsHandler, 'POST', {
    action: 'START_IMPORT',
    filename,
    fileType: 'csv',
    expectedRows: totalRows,
    columns: Object.keys(rows[0]),
    uploadHash,
    originalSizeBytes: 4096
  });
  assert.equal(resumeRes.statusCode, 200, 'Resuming active import must return 200');
  assert.equal(resumeRes.payload.resumed, true, 'Must indicate resumed: true');
  assert.equal(resumeRes.payload.datasetId, datasetId);
  assert.equal(resumeRes.payload.nextRowIndex, 10, 'Must resume at nextRowIndex=10');
  console.log(`   Safely resumed dataset ${datasetId} at nextRowIndex=10`);

  // Step 5: Append Chunk 2 (rows 10..19)
  console.log('5. Appending batch 2 (rows 10..19)...');
  const chunk2Res = await invoke(datasetsHandler, 'POST', {
    action: 'APPEND_IMPORT_BATCH',
    datasetId,
    uploadHash,
    startRowIndex: 10,
    rows: rows.slice(10, 20)
  });
  assert.equal(chunk2Res.statusCode, 200);
  assert.equal(chunk2Res.payload.nextRowIndex, 20);

  // Step 6: Append Chunk 3 (rows 20..29)
  console.log('6. Appending final batch 3 (rows 20..29)...');
  const chunk3Res = await invoke(datasetsHandler, 'POST', {
    action: 'APPEND_IMPORT_BATCH',
    datasetId,
    uploadHash,
    startRowIndex: 20,
    rows: rows.slice(20, 30)
  });
  assert.equal(chunk3Res.statusCode, 200);
  assert.equal(chunk3Res.payload.nextRowIndex, 30);

  // Step 7: Complete Chunked Import
  console.log('7. Calling COMPLETE_IMPORT...');
  const completeRes = await invoke(datasetsHandler, 'POST', {
    action: 'COMPLETE_IMPORT',
    datasetId,
    uploadHash
  });
  assert.equal(completeRes.statusCode, 201);
  assert.equal(completeRes.payload.summary.totalRows, 30);
  assert.equal(completeRes.payload.summary.validRows, 30);
  console.log('   Completed import successfully. Total rows reconciled: 30');

  // Step 8: Test Idempotency - calling COMPLETE_IMPORT a second time
  console.log('8. Testing COMPLETE_IMPORT idempotency (calling again with same uploadHash)...');
  const secondCompleteRes = await invoke(datasetsHandler, 'POST', {
    action: 'COMPLETE_IMPORT',
    datasetId,
    uploadHash
  });
  assert.equal(secondCompleteRes.statusCode, 200);
  assert.equal(secondCompleteRes.payload.duplicateRequest, true, 'Second COMPLETE_IMPORT must return duplicateRequest=true');
  assert.equal(secondCompleteRes.payload.summary.totalRows, 30);

  // Step 9: Verify direct database counts - NO duplicate records inserted
  console.log('9. Verifying direct SQL counts in database...');
  const dbRaw = await pool.query('SELECT count(*)::int AS count FROM raw_records WHERE dataset_id = $1', [datasetId]);
  const dbNorm = await pool.query('SELECT count(*)::int AS count FROM normalized_records WHERE dataset_id = $1', [datasetId]);
  assert.equal(dbRaw.rows[0].count, 30, 'DB raw_records must be exactly 30 with 0 duplicates');
  assert.equal(dbNorm.rows[0].count, 30, 'DB normalized_records must be exactly 30 with 0 duplicates');
  console.log('   Verified: Exactly 30 raw records and 30 normalized records in DB (0 duplicates on retry)');

  // Step 10: Test analysis failure handling (calling supervisor with invalid dataset_id)
  console.log('10. Testing supervisor analysis failure handling with invalid dataset_id...');
  const invalidAnalysisRes = await invoke(supervisorHandler, 'POST', {
    dataset_id: 99999999,
    targetStage: 'SUPERVISOR'
  });
  assert.equal(invalidAnalysisRes.statusCode, 404, 'Invalid datasetId must return 404');
  assert.equal(invalidAnalysisRes.payload.success, false);
  console.log('   Analysis failure safely reported: HTTP 404 DATASET_NOT_FOUND without crash');

  console.log('\n[PASS] All interrupted import, idempotency, and error handling tests passed successfully.');
} finally {
  console.log('\nCleaning up synthetic test dataset...');
  await cleanup();
  console.log('Cleanup completed.');
  await pool.end();
  await authServer.close();
}
