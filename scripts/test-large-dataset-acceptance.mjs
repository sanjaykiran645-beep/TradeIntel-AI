import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as XLSX from 'xlsx';
import { startTestAuthServer, TEST_ADMIN_TOKEN, TEST_ADMIN_USER_ID } from './_test-auth-server.mjs';
import { parseTradeFile } from '../src/lib/trade-file-parser.js';

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
  // Prevent unhandled error event on idle pool client reset
  if (err && (err.code === 'ECONNRESET' || err.message?.includes('socket') || err.message?.includes('closed'))) {
    return;
  }
  console.warn('Unexpected pool background error:', err?.message || err);
});

const [{ default: database }, datasetsModule, intelligenceModule, entityModule, leadModule, deleteModule, supervisorModule] = await Promise.all([
  import('../api/_db-client.js'),
  import('../api/_routes/datasets.js'),
  import('../api/_routes/intelligence.js'),
  import('../api/_pipeline-entities.js'),
  import('../api/_lead-qualification.js'),
  import('../api/_dataset-delete.js'),
  import('../api/_routes/supervisor.js')
]);

const datasetsHandler = datasetsModule.default;
const intelligenceHandler = intelligenceModule.default;
const supervisorHandler = supervisorModule.default;
const materializeTradeEntities = entityModule.materializeTradeEntities;
const deleteDatasetOwnedRows = deleteModule.deleteDatasetOwnedRows;
const DATASET_OWNED_TABLES_IN_DELETE_ORDER = deleteModule.DATASET_OWNED_TABLES_IN_DELETE_ORDER;

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

async function cleanupCreatedDatasets() {
  if (!createdDatasetIds.length) return;
  for (const table of DATASET_OWNED_TABLES_IN_DELETE_ORDER) {
    try {
      await pool.query(`DELETE FROM ${table} WHERE dataset_id = ANY($1)`, [createdDatasetIds]);
    } catch {
      // Table may not have dataset_id or be empty in this branch
    }
  }
  try {
    await pool.query('DELETE FROM datasets WHERE id = ANY($1)', [createdDatasetIds]);
  } catch (err) {
    console.warn('Batch dataset delete failed:', err.message);
  }
}

try {
  console.log('================================================================');
  console.log('TRADEINTEL AI: LARGE DATASET PIPELINE ACCEPTANCE TEST SUITE');
  console.log('================================================================\n');

  // --------------------------------------------------------------------------
  // TEST 1: SMALL 10-ROW DATASET (End-to-End Import, Dedup & Analysis)
  // --------------------------------------------------------------------------
  console.log('>>> TEST 1: Small dataset with exactly 10 source rows...');
  const t1Tag = randomUUID();
  const t1Filename = `test-10-rows-${t1Tag}.csv`;
  const t1Rows = [
    { 'Importer Name': `Alpha Global ${t1Tag}`, 'Product Description': 'Industrial Widgets', Country: 'Germany', Quantity: '100', 'Total FOB Value in INR': '500000', Sbill_Date: '2026-01-10' },
    { 'Importer Name': `Alpha Global ${t1Tag}`, 'Product Description': 'Industrial Widgets', Country: 'Germany', Quantity: '120', 'Total FOB Value in INR': '600000', Sbill_Date: '2026-01-11' },
    { 'Importer Name': `Beta Trade ${t1Tag}`, 'Product Description': 'Steel Fasteners', Country: 'Japan', Quantity: '500', 'Total FOB Value in INR': '1200000', Sbill_Date: '2026-01-12' },
    { 'Importer Name': `Beta Trade ${t1Tag}`, 'Product Description': 'Steel Fasteners', Country: 'Japan', Quantity: '550', 'Total FOB Value in INR': '1300000', Sbill_Date: '2026-01-13' },
    { 'Importer Name': `Gamma Imports ${t1Tag}`, 'Product Description': 'Electronic Sensors', Country: 'USA', Quantity: '50', 'Total FOB Value in INR': '800000', Sbill_Date: '2026-01-14' },
    { 'Importer Name': `Gamma Imports ${t1Tag}`, 'Product Description': 'Electronic Sensors', Country: 'USA', Quantity: '60', 'Total FOB Value in INR': '900000', Sbill_Date: '2026-01-15' },
    { 'Importer Name': `Delta Corp ${t1Tag}`, 'Product Description': 'Ceramic Valves', Country: 'France', Quantity: '200', 'Total FOB Value in INR': '400000', Sbill_Date: '2026-01-16' },
    { 'Importer Name': `Epsilon Ltd ${t1Tag}`, 'Product Description': 'Precision Cables', Country: 'UK', Quantity: '300', 'Total FOB Value in INR': '750000', Sbill_Date: '2026-01-17' },
    // Duplicate of row 0
    { 'Importer Name': `Alpha Global ${t1Tag}`, 'Product Description': 'Industrial Widgets', Country: 'Germany', Quantity: '100', 'Total FOB Value in INR': '500000', Sbill_Date: '2026-01-10' },
    // Invalid row (missing product description)
    { 'Importer Name': `Zeta Corp ${t1Tag}`, Country: 'Italy', Quantity: '10', 'Total FOB Value in INR': '100000', Sbill_Date: '2026-01-18' }
  ];
  assert.equal(t1Rows.length, 10, 'Test 1 must contain exactly 10 data rows');

  const t1Start = Date.now();
  const t1ImportRes = await invoke(datasetsHandler, 'POST', {
    filename: t1Filename,
    fileType: 'csv',
    rows: t1Rows
  });
  assert.equal(t1ImportRes.statusCode, 201, 'Test 1 import must return HTTP 201');
  const t1DatasetId = t1ImportRes.payload.dataset?.id || t1ImportRes.payload.summary?.datasetId;
  createdDatasetIds.push(t1DatasetId);

  // Reconcile 10 source rows
  assert.equal(t1ImportRes.payload.summary.totalRows, 10, 'Expected 10 total source rows');
  assert.equal(t1ImportRes.payload.summary.validRows, 8, 'Expected 8 valid unique rows');
  assert.equal(t1ImportRes.payload.summary.duplicateRows, 1, 'Expected 1 duplicate row');
  assert.equal(t1ImportRes.payload.summary.errorRows, 1, 'Expected 1 error row');

  // Verify direct database counts
  const t1DbRaw = await pool.query('SELECT count(*)::int AS count FROM raw_records WHERE dataset_id = $1', [t1DatasetId]);
  const t1DbNorm = await pool.query('SELECT count(*)::int AS count FROM normalized_records WHERE dataset_id = $1', [t1DatasetId]);
  const t1DbDup = await pool.query('SELECT count(*)::int AS count FROM raw_records WHERE dataset_id = $1 AND is_duplicate = true', [t1DatasetId]);
  const t1DbErr = await pool.query('SELECT count(*)::int AS count FROM raw_records WHERE dataset_id = $1 AND is_valid = false', [t1DatasetId]);

  assert.equal(t1DbRaw.rows[0].count, 10, 'DB raw_records must equal 10');
  assert.equal(t1DbNorm.rows[0].count, 8, 'DB normalized_records must equal 8');
  assert.equal(t1DbDup.rows[0].count, 1, 'DB duplicates must equal 1');
  assert.equal(t1DbErr.rows[0].count, 1, 'DB invalid rows must equal 1');

  // Run full analysis on 10-row dataset
  const t1Entities = await materializeTradeEntities(t1DatasetId);
  assert.equal(t1Entities.companies, 5, 'Expected 5 unique companies from 8 valid records');
  assert.equal(t1Entities.products, 5, 'Expected 5 unique products');

  const t1ScoreRes = await invoke(intelligenceHandler, 'POST', { datasetId: t1DatasetId, companyIds: t1Entities.targetCompanyIds });
  assert.ok([200, 207].includes(t1ScoreRes.statusCode), 'Intelligence scoring should return 200 or 207');
  assert.equal(t1ScoreRes.payload.scored, 5, 'All 5 companies must be scored');

  const t1Duration = Date.now() - t1Start;
  console.log(`[PASS] Test 1: 10 source rows reconciled (8 valid, 1 dup, 1 err, 5 companies, 5 products, 5 scored) in ${t1Duration}ms\n`);

  // --------------------------------------------------------------------------
  // TEST 2: 10,000-ROW CSV WITH UNICODE, QUOTES, COMMAS, CHUNKED IMPORT & RECOVERY
  // --------------------------------------------------------------------------
  console.log('>>> TEST 2: CSV with 10,000 data rows (Unicode, quotes, chunked batches)...');
  const t2Tag = randomUUID();
  const t2Filename = `test-10000-rows-${t2Tag}.csv`;
  const t2Lines = [
    'company_name,product_name,country,quantity,total_fob_value_in_inr,sbill_date,currency'
  ];

  // Generate 9,996 unique valid rows + 2 duplicates + 2 invalid rows = exactly 10,000 rows
  const companiesPool = Array.from({ length: 50 }, (_, i) => `Company ${i} Café & Co. — ☕ ${t2Tag}`);
  const productsPool = ['Industrial Resin', 'Organic Cotton Fabric', 'Electronic Transceiver', 'Stainless Fasteners', 'Ceramic Insulators'];
  const countriesPool = ['Germany', 'USA', 'Japan', 'France', 'United Kingdom', 'Brazil', 'South Korea'];

  for (let i = 0; i < 9996; i++) {
    const comp = companiesPool[i % companiesPool.length];
    const prod = productsPool[i % productsPool.length];
    const country = countriesPool[i % countriesPool.length];
    const qty = 100 + (i % 500);
    const val = 10000 + (i * 25);
    const date = '2026-02-15';
    // Test quoted fields containing commas
    t2Lines.push(`"${comp}","${prod}, Grade ${i % 3}","${country}",${qty},${val},${date},INR`);
  }
  // 2 Duplicates of row 0
  t2Lines.push(t2Lines[1]);
  t2Lines.push(t2Lines[2]);
  // 2 Invalid rows (one missing company, one missing product)
  t2Lines.push(`"","Invalid Missing Company Item",France,50,10000,2026-02-15,INR`);
  t2Lines.push(`"Orphaned Buyer Inc ${t2Tag}","",Germany,50,10000,2026-02-15,INR`);

  const t2CsvContent = t2Lines.join('\n');
  const t2CsvBytes = new TextEncoder().encode(t2CsvContent);
  assert.equal(t2Lines.length - 1, 10000, 'Test 2 must generate exactly 10,000 data rows');

  // Verify file parser handles Unicode and all 10,000 rows
  const t2ParseStart = Date.now();
  const t2Parsed = parseTradeFile({
    fileName: t2Filename,
    fileSize: t2CsvBytes.byteLength,
    sourceBytes: t2CsvBytes.buffer
  });
  const t2ParseDuration = Date.now() - t2ParseStart;
  assert.equal(t2Parsed.rows.length, 10000, 'Parser must parse all 10,000 rows');
  assert.equal(t2Parsed.validRows, 9996, 'Expected 9,996 valid unique rows');
  assert.equal(t2Parsed.duplicateRows, 2, 'Expected 2 duplicate rows');
  assert.equal(t2Parsed.errorRows, 2, 'Expected 2 error rows');
  assert.ok(t2Parsed.rows[0].company_name.includes('Café & Co. — ☕'), 'Unicode must be preserved without corruption');
  console.log(`  Parsed 10,000 CSV rows in ${t2ParseDuration}ms (${Math.round(10000 / (t2ParseDuration / 1000))} rows/sec)`);

  // SHA-256 upload hash
  const t2UploadHash = createHash('sha256').update(t2CsvBytes).digest('hex');

  // Step 1: PREPARE_UPLOAD
  const t2PrepRes = await invoke(datasetsHandler, 'POST', {
    action: 'PREPARE_UPLOAD',
    filename: t2Filename,
    contentType: 'text/csv',
    sizeBytes: t2CsvBytes.byteLength,
    contentHash: t2UploadHash
  });
  assert.equal(t2PrepRes.statusCode, 200);

  // Step 2: START_IMPORT
  const t2StartImportRes = await invoke(datasetsHandler, 'POST', {
    action: 'START_IMPORT',
    filename: t2Filename,
    fileType: 'csv',
    expectedRows: t2Parsed.rows.length,
    columns: t2Parsed.columns,
    uploadHash: t2UploadHash,
    originalSizeBytes: t2CsvBytes.byteLength
  });
  assert.equal(t2StartImportRes.statusCode, 201);
  const t2DatasetId = t2StartImportRes.payload.datasetId;
  createdDatasetIds.push(t2DatasetId);

  // Step 3: APPEND_IMPORT_BATCH in 10 chunks of 1000 rows
  console.log('  Persisting 10,000 rows in bounded batches of 1,000...');
  const t2PersistStart = Date.now();
  const CHUNK_SIZE = 1000;
  for (let offset = 0; offset < t2Parsed.rows.length; offset += CHUNK_SIZE) {
    const chunkRows = t2Parsed.rows.slice(offset, offset + CHUNK_SIZE);
    const chunkRes = await invoke(datasetsHandler, 'POST', {
      action: 'APPEND_IMPORT_BATCH',
      datasetId: t2DatasetId,
      uploadHash: t2UploadHash,
      startRowIndex: offset,
      rows: chunkRows
    });
    assert.equal(chunkRes.statusCode, 200, `Batch at offset ${offset} failed with HTTP ${chunkRes.statusCode}`);
    assert.equal(chunkRes.payload.nextRowIndex, offset + chunkRows.length);
  }
  const t2PersistDuration = Date.now() - t2PersistStart;
  console.log(`  Persisted 10,000 rows in ${t2PersistDuration}ms (${Math.round(10000 / (t2PersistDuration / 1000))} rows/sec)`);

  // Step 4: COMPLETE_IMPORT & Reconcile
  const t2CompleteRes = await invoke(datasetsHandler, 'POST', {
    action: 'COMPLETE_IMPORT',
    datasetId: t2DatasetId,
    uploadHash: t2UploadHash
  });
  assert.equal(t2CompleteRes.statusCode, 201, 'Complete import must return HTTP 201');
  const t2Sum = t2CompleteRes.payload.summary;
  assert.equal(t2Sum.totalRows, 10000, 'Reconciled total rows must equal 10,000');
  assert.equal(t2Sum.validRows, 9996, 'Reconciled valid rows must equal 9,996');
  assert.equal(t2Sum.duplicateRows, 2, 'Reconciled duplicate rows must equal 2');
  assert.equal(t2Sum.errorRows, 2, 'Reconciled error rows must equal 2');
  assert.equal(t2Sum.rawRowsInserted, 10000, 'Persisted raw rows must equal 10,000');
  assert.equal(t2Sum.normalizedRowsInserted, 9996, 'Persisted normalized rows must equal 9,996');

  // Verify idempotency: re-importing the same file must not create duplicates
  const t2DuplicateImportRes = await invoke(datasetsHandler, 'POST', {
    action: 'PREPARE_UPLOAD',
    filename: t2Filename,
    contentType: 'text/csv',
    sizeBytes: t2CsvBytes.byteLength,
    contentHash: t2UploadHash
  });
  assert.equal(t2DuplicateImportRes.payload.alreadyImported, true, 'Re-importing exact file must detect already-imported status');

  // Direct database query verification
  const t2DbRaw = await pool.query('SELECT count(*)::int AS count FROM raw_records WHERE dataset_id = $1', [t2DatasetId]);
  const t2DbNorm = await pool.query('SELECT count(*)::int AS count FROM normalized_records WHERE dataset_id = $1', [t2DatasetId]);
  const t2DbDup = await pool.query('SELECT count(*)::int AS count FROM raw_records WHERE dataset_id = $1 AND is_duplicate = true', [t2DatasetId]);
  const t2DbErr = await pool.query('SELECT count(*)::int AS count FROM raw_records WHERE dataset_id = $1 AND is_valid = false', [t2DatasetId]);
  assert.equal(t2DbRaw.rows[0].count, 10000, 'Independent SQL query confirms 10,000 raw rows in DB');
  assert.equal(t2DbNorm.rows[0].count, 9996, 'Independent SQL query confirms 9,996 normalized rows in DB');
  assert.equal(t2DbDup.rows[0].count, 2, 'Independent SQL query confirms 2 duplicates in DB');
  assert.equal(t2DbErr.rows[0].count, 2, 'Independent SQL query confirms 2 error rows in DB');

  // Step 5: Full Dataset Analysis & Scoring across all 10,000 rows
  console.log('  Running full-dataset entity aggregation and potential scoring...');
  const t2AnalysisStart = Date.now();
  const t2Entities = await materializeTradeEntities(t2DatasetId);
  assert.equal(t2Entities.companies, 50, 'All 50 unique companies must be aggregated across 9,996 normalized rows');
  assert.equal(t2Entities.products, 15, 'All 15 products must be cataloged');

  const t2ScoreRes = await invoke(intelligenceHandler, 'POST', { datasetId: t2DatasetId, companyIds: t2Entities.targetCompanyIds });
  assert.ok([200, 207].includes(t2ScoreRes.statusCode));
  assert.equal(t2ScoreRes.payload.scored, 50, 'All 50 companies must be scored');

  const t2AnalysisDuration = Date.now() - t2AnalysisStart;
  console.log(`  Aggregated and scored 10,000-row dataset in ${t2AnalysisDuration}ms`);

  // Step 6: Verify API pagination
  const [{ default: companiesHandler }, { default: productsHandler }] = await Promise.all([
    import('../api/_routes/companies.js'),
    import('../api/_routes/products.js')
  ]);
  const p1Res = await invoke(companiesHandler, 'GET', {}, { dataset_id: String(t2DatasetId), page: '1', pageSize: '20' });
  assert.equal(p1Res.statusCode, 200);
  assert.equal(p1Res.payload.total, 50, 'Companies API total must reflect all 50 companies, not just page size');
  assert.equal(p1Res.payload.data.length, 20, 'Page 1 must return exactly 20 companies');
  assert.equal(p1Res.payload.totalPages, 3);

  const prodRes = await invoke(productsHandler, 'GET', {}, { dataset_id: String(t2DatasetId), page: '1', pageSize: '10' });
  assert.equal(prodRes.statusCode, 200);
  assert.equal(prodRes.payload.total, 15, 'Products API total must reflect all 15 products');
  assert.equal(prodRes.payload.data.length, 10);

  console.log(`[PASS] Test 2: 10,000-row CSV fully parsed, persisted, reconciled, and analyzed with 0 lost rows\n`);

  // --------------------------------------------------------------------------
  // TEST 3: 10,000-ROW MULTI-WORKSHEET XLSX WORKBOOK
  // --------------------------------------------------------------------------
  console.log('>>> TEST 3: Multi-worksheet XLSX with 10,000 data rows (3 worksheets)...');
  const t3Tag = randomUUID();
  const t3Filename = `test-10000-multi-${t3Tag}.xlsx`;
  const wb3 = XLSX.utils.book_new();

  // Create 3 worksheets: Sheet1 (3500 rows), Sheet2 (3500 rows), Sheet3 (3000 rows) = 10,000 rows
  const sheetConfigs = [
    { name: 'Division_North', count: 3500 },
    { name: 'Division_South', count: 3500 },
    { name: 'Division_International', count: 3000 }
  ];

  let cumulativeIndex = 0;
  for (const cfg of sheetConfigs) {
    const sheetData = [
      ['Importer Name', 'Product Description', 'Country', 'Quantity', 'Total FOB Value in INR', 'Sbill_Date', 'Currency']
    ];
    for (let j = 0; j < cfg.count; j++) {
      cumulativeIndex++;
      sheetData.push([
        `Multi Company ${cumulativeIndex % 40} Ltd ${t3Tag}`,
        `Commodity ${cumulativeIndex % 10}`,
        countriesPool[cumulativeIndex % countriesPool.length],
        String(200 + (cumulativeIndex % 100)),
        String(15000 + (cumulativeIndex * 10)),
        '2026-02-18',
        'INR'
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    XLSX.utils.book_append_sheet(wb3, ws, cfg.name);
  }

  const t3XlsxBuffer = XLSX.write(wb3, { type: 'array', bookType: 'xlsx' });
  console.log(`  Generated multi-sheet XLSX workbook: ${(t3XlsxBuffer.byteLength / (1024 * 1024)).toFixed(2)} MB`);

  // Parse multi-sheet XLSX
  const t3ParseStart = Date.now();
  const t3Parsed = parseTradeFile({
    fileName: t3Filename,
    fileSize: t3XlsxBuffer.byteLength,
    sourceBytes: t3XlsxBuffer
  });
  const t3ParseDuration = Date.now() - t3ParseStart;
  assert.equal(t3Parsed.sheetCount, 3, 'All 3 worksheets must be parsed');
  assert.equal(t3Parsed.rows.length, 10000, 'All 10,000 data rows across all 3 sheets must be parsed');
  assert.equal(t3Parsed.validRows, 10000, 'All 10,000 rows should be valid');
  console.log(`  Parsed 10,000 XLSX rows across 3 worksheets in ${t3ParseDuration}ms (${Math.round(10000 / (t3ParseDuration / 1000))} rows/sec)`);

  const t3UploadHash = createHash('sha256').update(new Uint8Array(t3XlsxBuffer)).digest('hex');

  const t3StartImportRes = await invoke(datasetsHandler, 'POST', {
    action: 'START_IMPORT',
    filename: t3Filename,
    fileType: 'xlsx',
    expectedRows: t3Parsed.rows.length,
    columns: t3Parsed.columns,
    uploadHash: t3UploadHash,
    originalSizeBytes: t3XlsxBuffer.byteLength
  });
  assert.equal(t3StartImportRes.statusCode, 201);
  const t3DatasetId = t3StartImportRes.payload.datasetId;
  createdDatasetIds.push(t3DatasetId);

  // Append batches of 1,000
  console.log('  Persisting 10,000 multi-sheet XLSX rows in bounded batches of 1,000...');
  const t3PersistStart = Date.now();
  for (let offset = 0; offset < t3Parsed.rows.length; offset += CHUNK_SIZE) {
    const chunkRows = t3Parsed.rows.slice(offset, offset + CHUNK_SIZE);
    const chunkRes = await invoke(datasetsHandler, 'POST', {
      action: 'APPEND_IMPORT_BATCH',
      datasetId: t3DatasetId,
      uploadHash: t3UploadHash,
      startRowIndex: offset,
      rows: chunkRows
    });
    assert.equal(chunkRes.statusCode, 200);
  }
  const t3PersistDuration = Date.now() - t3PersistStart;
  console.log(`  Persisted in ${t3PersistDuration}ms (${Math.round(10000 / (t3PersistDuration / 1000))} rows/sec)`);

  // Complete & verify
  const t3CompleteRes = await invoke(datasetsHandler, 'POST', {
    action: 'COMPLETE_IMPORT',
    datasetId: t3DatasetId,
    uploadHash: t3UploadHash
  });
  assert.equal(t3CompleteRes.statusCode, 201);
  assert.equal(t3CompleteRes.payload.summary.totalRows, 10000);
  assert.equal(t3CompleteRes.payload.summary.validRows, 10000);

  // Direct SQL verification
  const t3DbRaw = await pool.query('SELECT count(*)::int AS count FROM raw_records WHERE dataset_id = $1', [t3DatasetId]);
  const t3DbNorm = await pool.query('SELECT count(*)::int AS count FROM normalized_records WHERE dataset_id = $1', [t3DatasetId]);
  assert.equal(t3DbRaw.rows[0].count, 10000, 'DB confirms 10,000 raw records from multi-worksheet XLSX');
  assert.equal(t3DbNorm.rows[0].count, 10000, 'DB confirms 10,000 normalized records from multi-worksheet XLSX');

  // Entity materialization & scoring
  const t3Entities = await materializeTradeEntities(t3DatasetId);
  assert.equal(t3Entities.companies, 40, 'All 40 unique companies materialized from multi-sheet XLSX');
  assert.equal(t3Entities.products, 10, 'All 10 commodities cataloged');

  const t3ScoreRes = await invoke(intelligenceHandler, 'POST', { datasetId: t3DatasetId, companyIds: t3Entities.targetCompanyIds });
  assert.equal(t3ScoreRes.payload.scored, 40, 'All 40 companies scored');

  console.log(`[PASS] Test 3: 10,000-row multi-worksheet XLSX fully parsed, persisted, reconciled, and analyzed\n`);

  console.log('================================================================');
  console.log('ALL LARGE DATASET ACCEPTANCE TESTS PASSED SUCCESSFULLY (100%)');
  console.log('================================================================');
} finally {
  console.log('\nCleaning up synthetic non-production test datasets...');
  await cleanupCreatedDatasets();
  console.log('Cleanup completed safely.');
  await pool.end();
  await authServer.close();
}
