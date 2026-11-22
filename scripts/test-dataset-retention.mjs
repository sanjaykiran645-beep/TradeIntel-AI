import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  cleanupCompletedAnalysisDatasets,
  isCompletedAnalysis,
  isSupabaseDatabaseTarget,
  isValidatedImportedDataset,
  maxActiveDatasets,
  planCompletedAnalysisRetention
} from '../api/_dataset-retention.js';
import { DATASET_OWNED_TABLES_IN_DELETE_ORDER, deleteDatasetOwnedRows } from '../api/_dataset-delete.js';
import { createDatasetStorageCleanupMarker, datasetSourceCleanupMarkerMatches, inspectStorageKeyTarget, storageTargetFingerprint } from '../api/_storage-target.js';

const requiredStages = [
  'DATASET_VALIDATION',
  'ENTITY_AGGREGATION',
  'INTELLIGENCE',
  'PANDAS_ANALYSIS',
  'SQL_RISK_ANALYSIS',
  'LEAD_QUALIFICATION',
  'FINAL_RESULTS'
];

const tableNames = [
  'datasets', 'raw_records', 'normalized_records', 'companies', 'products',
  'markets', 'company_potential', 'leads', 'contacts', 'web_research',
  'outreach_emails', 'follow_up_queue', 'inbox_messages', 'response_drafts',
  'agent_runs', 'crm_activities', 'audit_logs', 'system_settings'
];

function getPath(object, path) {
  return String(path).split(/->>?/).filter(Boolean).reduce((value, key) => value?.[key], object);
}

class FakeQuery {
  constructor(database, table) {
    this.database = database;
    this.table = table;
    this.action = 'select';
    this.filters = [];
    this.ordering = null;
    this.window = null;
    this.limitCount = null;
    this.payload = null;
    this.countMode = false;
    this.headOnly = false;
    this.returning = false;
  }

  select(_columns, options = {}) {
    if (this.action === 'select') {
      this.countMode = options.count === 'exact';
      this.headOnly = options.head === true;
    } else {
      this.returning = true;
    }
    return this;
  }

  order(column, options = {}) { this.ordering = { column, ascending: options.ascending !== false }; return this; }
  range(from, to) { this.window = { from, to }; return this; }
  limit(count) { this.limitCount = count; return this; }
  eq(column, value) { this.filters.push({ column, operator: 'eq', value }); return this; }
  is(column, value) { this.filters.push({ column, operator: 'is', value }); return this; }
  in(column, value) { this.filters.push({ column, operator: 'in', value }); return this; }
  filter(column, operator, value) { this.filters.push({ column, operator, value }); return this; }
  update(payload) { this.action = 'update'; this.payload = payload; return this; }
  delete() { this.action = 'delete'; return this; }
  insert(payload) { this.action = 'insert'; this.payload = payload; return this; }

  matches(row) {
    return this.filters.every(({ column, operator, value }) => {
      const actual = String(column).includes('->') ? getPath(row, column) : row[column];
      if (operator === 'eq') return String(actual) === String(value);
      if (operator === 'is') return value === null ? actual == null : actual === value;
      if (operator === 'in') return value.includes(actual);
      return false;
    });
  }

  async execute(single = false) {
    const rows = this.database[this.table];
    if (!rows) return { data: null, error: { code: '42P01', message: 'Unknown table ' + this.table } };

    if (this.action === 'insert') {
      const entries = Array.isArray(this.payload) ? this.payload : [this.payload];
      if (this.table === 'system_settings' && entries.some(entry => rows.some(row => row.key === entry.key))) {
        return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      const inserted = entries.map(entry => ({ id: this.database.nextId++, ...structuredClone(entry) }));
      rows.push(...inserted);
      return { data: this.returning ? (single ? inserted[0] || null : inserted) : null, error: null };
    }

    if (this.action === 'select') {
      let matching = rows.filter(row => this.matches(row));
      if (this.ordering) {
        const { column, ascending } = this.ordering;
        matching.sort((a, b) => ((a[column] ?? 0) < (b[column] ?? 0) ? -1 : (a[column] ?? 0) > (b[column] ?? 0) ? 1 : 0) * (ascending ? 1 : -1));
      }
      const count = this.countMode ? matching.length : null;
      if (this.window) matching = matching.slice(this.window.from, this.window.to + 1);
      if (this.limitCount !== null) matching = matching.slice(0, this.limitCount);
      return { data: this.headOnly ? null : structuredClone(single ? matching[0] || null : matching), count, error: null };
    }

    if (this.action === 'update') {
      const changed = rows.filter(row => this.matches(row));
      for (const row of changed) Object.assign(row, structuredClone(this.payload));
      return { data: this.returning ? (single ? changed[0] || null : changed) : null, error: null };
    }

    if (this.database.failDelete?.table === this.table && this.database.failDelete.remaining > 0) {
      this.database.failDelete.remaining -= 1;
      return { data: null, error: { code: '57014', message: 'simulated delete failure' } };
    }

    const deleted = rows.filter(row => this.matches(row));
    this.database[this.table] = rows.filter(row => !this.matches(row));
    if (this.table === 'datasets') {
      const removed = new Set(deleted.map(row => Number(row.id)));
      for (const audit of this.database.audit_logs) if (removed.has(Number(audit.dataset_id))) audit.dataset_id = null;
    }
    return { data: this.returning ? (single ? deleted[0] || null : deleted) : null, error: null };
  }

  maybeSingle() { return this.execute(true); }
  single() { return this.execute(true); }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
}

class FakeDatabaseClient {
  constructor(database) { this.database = database; }
  from(table) { return new FakeQuery(this.database, table); }
}

function completedDataset(id, date) {
  const stages = Object.fromEntries(requiredStages.map(stage => [stage, {
    status: 'COMPLETED',
    startedAt: date,
    completedAt: date,
    recordsProcessed: 1,
    recordsProduced: 1,
    evidence: { persisted: true }
  }]));
  return {
    id,
    filename: 'analysis-' + id + '.xlsx',
    total_rows: 1,
    import_status: 'COMPLETED',
    analysis_status: 'COMPLETED',
    status: 'COMPLETED',
    created_at: date,
    detected_entities: {
      import: {
        status: 'COMPLETED',
        expectedRows: 1,
        actualCounts: { totalRows: 1, validRows: 1, duplicateRows: 0, errorRows: 0, normalizedRows: 1 }
      },
      pipeline: { status: 'COMPLETED', token: 'pipeline-' + id, completedAt: date, stages }
    }
  };
}

function importedDataset(id, date, status = 'COMPLETED') {
  return {
    id,
    filename: 'new-analysis-' + id + '.xlsx',
    total_rows: 1,
    import_status: status,
    analysis_status: 'QUEUED',
    status: 'IMPORTED',
    created_at: date,
    detected_entities: {
      import: {
        status,
        expectedRows: 1,
        actualCounts: { totalRows: 1, validRows: 1, duplicateRows: 0, errorRows: 0, normalizedRows: 1 }
      }
    }
  };
}

function makeDatabase(datasets) {
  const db = Object.fromEntries(tableNames.map(table => [table, []]));
  db.nextId = 10000;
  db.datasets.push(...structuredClone(datasets));
  for (const dataset of datasets) {
    const id = Number(dataset.id);
    if (dataset.detected_entities?.import?.status !== 'COMPLETED') continue;
    db.raw_records.push({ id: 'raw-' + id, dataset_id: id, row_index: 1, is_valid: true, is_duplicate: false });
    db.normalized_records.push({ id: 'norm-' + id, dataset_id: id, source_row_index: 1 });
  }
  return db;
}

function addOwnedRecords(db, datasetId, base) {
  db.companies.push({ id: base + 1, dataset_id: datasetId, name: 'Company ' + datasetId });
  db.products.push({ id: base + 2, dataset_id: datasetId, name: 'Product ' + datasetId });
  db.markets.push({ id: base + 3, dataset_id: datasetId, country: 'Country ' + datasetId });
  db.company_potential.push({ id: base + 4, dataset_id: datasetId, company_id: base + 1 });
  db.contacts.push({ id: base + 5, dataset_id: datasetId, company_id: base + 1, email: null });
  db.web_research.push({ id: base + 6, dataset_id: datasetId, company_id: base + 1, result: {} });
  db.leads.push({ id: base + 7, dataset_id: datasetId, company_id: base + 1 });
  db.outreach_emails.push({ id: base + 8, dataset_id: datasetId, company_id: base + 1 });
  db.follow_up_queue.push({ id: base + 9, dataset_id: datasetId, outreach_id: base + 8, company_id: base + 1 });
  db.agent_runs.push({ id: base + 10, dataset_id: datasetId, status: 'COMPLETED' });
  db.crm_activities.push({ id: base + 11, dataset_id: datasetId, company_id: base + 1 });
  const message = { id: base + 12, dataset_id: datasetId, message_id: 'message-' + datasetId };
  db.inbox_messages.push(message);
  db.response_drafts.push({ id: base + 13, dataset_id: datasetId, inbox_message_id: message.id });
  db.response_drafts.push({ id: base + 14, dataset_id: null, inbox_message_id: message.id });
}

const storageTarget = storageTargetFingerprint('https://storage.example.test', 'tradeintel-files');
const lifecycleStorageKey = `source-uploads/${storageTarget.fingerprint}/123e4567-e89b-42d3-a456-426614174000/source.csv`;
const lifecycleHash = 'f'.repeat(64);

function addSourceObject(dataset, objects, { present = true } = {}) {
  dataset.storage_key = lifecycleStorageKey;
  dataset.content_hash = lifecycleHash;
  dataset.original_size_bytes = 456;
  if (present) objects.set(lifecycleStorageKey, { contentHash: lifecycleHash, sizeBytes: 456 });
}

function objectStorageDependencies(objects, deleteMode = 'success') {
  let deleteCalls = 0;
  return {
    get deleteCalls() { return deleteCalls; },
    async verifyDatasetSourceObjectOwnership(dataset, references) {
      const matches = references.filter(row => row.storage_key === dataset.storage_key);
      assert.equal(matches.length, 1);
      assert.equal(Number(matches[0].id), Number(dataset.id));
      const object = objects.get(dataset.storage_key);
      if (!object) {
        assert.equal(datasetSourceCleanupMarkerMatches(dataset), true);
        return { storageKey: dataset.storage_key, datasetId: String(dataset.id), objectAbsent: true };
      }
      assert.equal(object.contentHash, dataset.content_hash);
      assert.equal(object.sizeBytes, Number(dataset.original_size_bytes));
      return { storageKey: dataset.storage_key, datasetId: String(dataset.id), objectAbsent: false };
    },
    async deleteSourceObject(dataset, proof) {
      assert.equal(proof.storageKey, dataset.storage_key);
      assert.equal(proof.datasetId, String(dataset.id));
      if (proof.objectAbsent) return { deleted: true, alreadyAbsent: true, storageKey: dataset.storage_key };
      deleteCalls += 1;
      if (deleteMode === 'fail-before-delete') throw Object.assign(new Error('simulated storage timeout'), { code: 'OBJECT_STORAGE_UNAVAILABLE' });
      objects.delete(dataset.storage_key);
      if (deleteMode === 'ambiguous-success') throw Object.assign(new Error('simulated lost delete response'), { code: 'OBJECT_STORAGE_UNAVAILABLE' });
      return { deleted: true, storageKey: dataset.storage_key };
    }
  };
}

function lifecycleDatabase({ objectPresent = true } = {}) {
  const previousDataset = completedDataset(1, '2024-01-01T00:00:00.000Z');
  const currentDataset = completedDataset(2, '2024-02-01T00:00:00.000Z');
  const objects = new Map();
  addSourceObject(previousDataset, objects, { present: objectPresent });
  const db = makeDatabase([previousDataset, currentDataset]);
  return { db, objects };
}

const datasetSource = fs.readFileSync(new URL('../api/_routes/datasets.js', import.meta.url), 'utf8');
const supervisorSource = fs.readFileSync(new URL('../api/_routes/supervisor.js', import.meta.url), 'utf8');
const supervisorLeaseSource = fs.readFileSync(new URL('../api/_supervisor-run-lease.js', import.meta.url), 'utf8');
const retentionSource = fs.readFileSync(new URL('../api/_dataset-retention.js', import.meta.url), 'utf8');
const externalPipelineSource = fs.readFileSync(new URL('../api/_external-pipeline.js', import.meta.url), 'utf8');
const storageCleanupSource = fs.readFileSync(new URL('../api/_dataset-storage-cleanup.js', import.meta.url), 'utf8');
const envExample = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

assert.equal(maxActiveDatasets('1'), 1);
assert.equal(maxActiveDatasets(''), 1);
assert.equal(envExample.includes('MAX_ACTIVE_DATASETS=1'), true);
assert.equal(isSupabaseDatabaseTarget('postgresql://user:placeholder@db.example.supabase.co:5432/postgres'), true);
assert.equal(isSupabaseDatabaseTarget('postgresql://user:placeholder@ep-example.us-east-2.aws.neon.tech:5432/neondb'), false);
assert.deepEqual(DATASET_OWNED_TABLES_IN_DELETE_ORDER, [
  'follow_up_queue', 'response_drafts', 'inbox_messages', 'outreach_emails',
  'leads', 'company_potential', 'web_research', 'crm_activities', 'contacts',
  'normalized_records', 'raw_records', 'companies', 'products', 'markets', 'agent_runs'
]);
assert.equal(datasetSource.includes('MAX_IMPORT_CHUNK_ROWS = 1000'), true);
assert.equal(datasetSource.includes('MAX_IMPORT_CHUNK_BYTES = 3 * 1024 * 1024'), true);
assert.equal(datasetSource.includes('allRecords = allRecords.slice'), false);
assert.equal(datasetSource.includes('records = records.slice'), false);
assert.equal(datasetSource.includes('actualCounts.totalRows !== expectedRows'), true);
assert.equal(datasetSource.includes('actualCounts.totalRows !== allRecords.length'), true);
assert.equal(retentionSource.includes('DATASET_RETENTION_MAX_BYTES'), false);
assert.equal(retentionSource.includes('DATASET_RETENTION_AUTOMATIC'), false);
assert.equal(supervisorSource.includes('cleanupCompletedAnalysisDatasets'), true);
assert.equal(supervisorSource.includes("retentionRequired: saved.analysisStatus === 'COMPLETED'"), true);
assert.equal(supervisorSource.includes('runCompletedAnalysisRetention(datasetId)'), true);
assert.equal(datasetSource.includes('filterDatasetStateVersion'), true);
assert.equal(supervisorSource.includes('compareAndSetSupervisorPipeline'), true);
assert.equal(supervisorLeaseSource.includes('filterDatasetStateVersion'), true);
assert.equal(externalPipelineSource.includes('filterDatasetStateVersion'), true);
assert.equal(retentionSource.includes('filterDatasetStateVersion'), true);
assert.equal(storageCleanupSource.includes('filterDatasetStateVersion'), true);

const one = completedDataset(1, '2024-01-01T00:00:00.000Z');
assert.equal(isCompletedAnalysis(one), true);
assert.equal(isCompletedAnalysis({ ...one, analysis_status: 'REVIEW_REQUIRED' }), false);
assert.equal(isCompletedAnalysis({ ...one, detected_entities: { ...one.detected_entities, pipeline: { ...one.detected_entities.pipeline, status: 'REVIEW_REQUIRED' } } }), false);
assert.equal(isCompletedAnalysis({ ...one, status: 'FAILED' }), false);
assert.equal(isCompletedAnalysis({ ...one, analysis_status: 'RUNNING' }), false);
assert.equal(isValidatedImportedDataset(importedDataset(2, '2024-01-02T00:00:00.000Z')), true);
assert.deepEqual(planCompletedAnalysisRetention([one], 1).candidates, []);
const failedPrevious = structuredClone(one);
failedPrevious.id = 8;
failedPrevious.analysis_status = 'FAILED';
failedPrevious.status = 'FAILED';
const reviewPrevious = structuredClone(one);
reviewPrevious.id = 9;
reviewPrevious.analysis_status = 'REVIEW_REQUIRED';
reviewPrevious.status = 'REVIEW_REQUIRED';
const runningPrevious = structuredClone(one);
runningPrevious.id = 10;
runningPrevious.analysis_status = 'RUNNING';
runningPrevious.status = 'ANALYZING';
runningPrevious.detected_entities.pipeline.status = 'RUNNING';
assert.deepEqual(
  planCompletedAnalysisRetention([one, failedPrevious, reviewPrevious, runningPrevious, completedDataset(11, '2024-02-01T00:00:00.000Z')], 11).candidates.map(item => item.id),
  [1]
);
const largeImport = importedDataset(148015, '2024-01-03T00:00:00.000Z');
largeImport.total_rows = 148015;
largeImport.detected_entities.import.expectedRows = 148015;
largeImport.detected_entities.import.actualCounts = {
  totalRows: 148015,
  validRows: 148015,
  duplicateRows: 0,
  errorRows: 0,
  normalizedRows: 148015
};
assert.equal(isValidatedImportedDataset(largeImport), true);

const onlyDatasetDb = makeDatabase([one]);
const onlyDatasetResult = await cleanupCompletedAnalysisDatasets(1, new FakeDatabaseClient(onlyDatasetDb));
assert.equal(onlyDatasetResult.status, 'COMPLETED');
assert.equal(onlyDatasetDb.datasets.length, 1);
assert.equal(onlyDatasetDb.datasets[0].id, 1);

const failedUpload = importedDataset(2, '2024-01-02T00:00:00.000Z', 'FAILED');
const failedUploadDb = makeDatabase([one, failedUpload]);
const failedUploadResult = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(failedUploadDb));
assert.equal(failedUploadResult.status, 'IMPORT_NOT_VALIDATED');
assert.equal(failedUploadDb.datasets.some(dataset => dataset.id === 1), true);
assert.equal(failedUploadDb.raw_records.some(row => row.dataset_id === 1), true);
assert.equal(failedUploadDb.normalized_records.some(row => row.dataset_id === 1), true);

const mismatchDb = makeDatabase([one, importedDataset(2, '2024-01-02T00:00:00.000Z')]);
mismatchDb.normalized_records = mismatchDb.normalized_records.filter(row => row.dataset_id !== 2);
const mismatchResult = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(mismatchDb));
assert.equal(mismatchResult.status, 'IMPORT_COUNT_MISMATCH');
assert.equal(mismatchDb.datasets.some(dataset => dataset.id === 1), true);

const busyDb = makeDatabase([one, completedDataset(2, '2024-01-02T00:00:00.000Z')]);
busyDb.system_settings.push({
  id: 900,
  category: 'maintenance',
  key: 'dataset_replacement_cleanup_lock',
  value: { token: 'other-run', expiresAt: new Date(Date.now() + 60000).toISOString() }
});
const busyResult = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(busyDb));
assert.equal(busyResult.status, 'SKIPPED_BUSY');
assert.equal(busyDb.datasets.some(dataset => dataset.id === 1), true);

const previous = completedDataset(1, '2024-01-01T00:00:00.000Z');
const next = completedDataset(2, '2024-02-01T00:00:00.000Z');
const replaceDb = makeDatabase([previous, next]);
addOwnedRecords(replaceDb, 1, 100);
addOwnedRecords(replaceDb, 2, 200);
replaceDb.contacts.push({ id: 300, dataset_id: null, company_id: null, email: 'shared@example.invalid' });
replaceDb.web_research.push({ id: 301, dataset_id: null, company_id: null, result: { shared: true } });
replaceDb.crm_activities.push({ id: 302, dataset_id: null, company_id: null, description: 'shared activity' });
replaceDb.inbox_messages.push({ id: 303, dataset_id: null, message_id: 'shared-message' });
replaceDb.response_drafts.push({ id: 304, dataset_id: null, inbox_message_id: 303 });
replaceDb.audit_logs.push({ id: 305, dataset_id: 1, action: 'old analysis audit' });
replaceDb.audit_logs.push({ id: 306, dataset_id: null, action: 'global audit' });
replaceDb.system_settings.push({ id: 307, category: 'global', key: 'app_mode', value: { keep: true } });
const reviewDataset = structuredClone(one);
reviewDataset.id = 4;
reviewDataset.status = 'REVIEW_REQUIRED';
reviewDataset.analysis_status = 'REVIEW_REQUIRED';
reviewDataset.detected_entities.pipeline.status = 'REVIEW_REQUIRED';
replaceDb.datasets.push(reviewDataset);
replaceDb.raw_records.push({ id: 'raw-review', dataset_id: 4, row_index: 1, is_valid: true, is_duplicate: false });
replaceDb.normalized_records.push({ id: 'norm-review', dataset_id: 4, source_row_index: 1 });

const oldRawBefore = replaceDb.raw_records.filter(row => row.dataset_id === 1).length;
const oldNormalizedBefore = replaceDb.normalized_records.filter(row => row.dataset_id === 1).length;
const replaceResult = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(replaceDb));
assert.equal(replaceResult.status, 'COMPLETED');
assert.equal(replaceResult.countDeltasMatch, true);
assert.deepEqual(replaceResult.deleted.map(item => item.id), [1]);
assert.equal(replaceResult.deleted[0].rawRecords, oldRawBefore);
assert.equal(replaceResult.deleted[0].normalizedRecords, oldNormalizedBefore);
assert.equal(replaceDb.datasets.some(dataset => dataset.id === 1), false);
assert.equal(replaceDb.datasets.some(dataset => dataset.id === 2), true);
assert.equal(replaceDb.datasets.some(dataset => dataset.id === 4), true);
assert.equal(replaceDb.raw_records.some(row => row.dataset_id === 4), true);
assert.equal(replaceDb.normalized_records.some(row => row.dataset_id === 4), true);
for (const table of DATASET_OWNED_TABLES_IN_DELETE_ORDER) assert.equal(replaceDb[table].some(row => row.dataset_id === 1), false, table + ' old rows removed');
assert.equal(replaceDb.response_drafts.some(row => row.inbox_message_id === 112 && row.dataset_id === null), false);
assert.equal(replaceDb.contacts.some(row => row.id === 300), true);
assert.equal(replaceDb.web_research.some(row => row.id === 301), true);
assert.equal(replaceDb.crm_activities.some(row => row.id === 302), true);
assert.equal(replaceDb.inbox_messages.some(row => row.id === 303), true);
assert.equal(replaceDb.response_drafts.some(row => row.id === 304), true);
assert.equal(replaceDb.audit_logs.some(row => row.id === 305 && row.dataset_id === null), true);
assert.equal(replaceDb.audit_logs.some(row => row.id === 306), true);
assert.equal(replaceDb.system_settings.some(row => row.id === 307), true);
assert.equal(replaceDb.system_settings.some(row => row.key === 'dataset_replacement_cleanup_lock' && Date.parse(row.value.expiresAt) < Date.now()), true);
assert.equal(replaceResult.countDeltasMatch, true);

const analysisFailure = replaceDb.datasets.find(dataset => dataset.id === 2);
analysisFailure.analysis_status = 'FAILED';
analysisFailure.status = 'FAILED';
analysisFailure.detected_entities.pipeline = {
  status: 'FAILED',
  token: 'failed-new-run',
  stages: Object.fromEntries(requiredStages.map(stage => [stage, { status: stage === 'FINAL_RESULTS' ? 'FAILED' : 'COMPLETED' }]))
};
assert.equal(isCompletedAnalysis(analysisFailure), false);
const afterAnalysisFailure = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(replaceDb));
assert.equal(afterAnalysisFailure.status, 'ANALYSIS_NOT_COMPLETED');
assert.equal(replaceDb.datasets.some(dataset => dataset.id === 2), true);
assert.equal(replaceDb.raw_records.some(row => row.dataset_id === 2), true);

const repeatTwo = completedDataset(2, '2024-02-01T00:00:00.000Z');
const repeatThree = completedDataset(3, '2024-03-01T00:00:00.000Z');
const repeatDb = makeDatabase([repeatTwo, repeatThree]);
addOwnedRecords(repeatDb, 2, 400);
addOwnedRecords(repeatDb, 3, 500);
const repeatResult = await cleanupCompletedAnalysisDatasets(3, new FakeDatabaseClient(repeatDb));
assert.equal(repeatResult.status, 'COMPLETED');
assert.deepEqual(repeatResult.deleted.map(item => item.id), [2]);
assert.equal(repeatDb.datasets.some(dataset => dataset.id === 2), false);
assert.equal(repeatDb.datasets.some(dataset => dataset.id === 3), true);

const batchDb = makeDatabase([completedDataset(10, '2024-01-01T00:00:00.000Z'), importedDataset(11, '2024-02-01T00:00:00.000Z')]);
batchDb.raw_records = Array.from({ length: 1101 }, (_, index) => ({ id: 'raw-' + index, dataset_id: 10, row_index: index + 1, is_valid: true, is_duplicate: false }));
batchDb.normalized_records = Array.from({ length: 1101 }, (_, index) => ({ id: 'normalized-' + index, dataset_id: 10, source_row_index: index + 1 }));
const batchDelete = await deleteDatasetOwnedRows(new FakeDatabaseClient(batchDb), 10, { batchSize: 500 });
assert.equal(batchDelete.remainingByTable.raw_records, 0);
assert.equal(batchDelete.remainingByTable.normalized_records, 0);
assert.equal(batchDelete.deletedByTable.raw_records, 1101);
assert.equal(batchDelete.deletedByTable.normalized_records, 1101);
assert.equal(batchDb.raw_records.some(row => row.dataset_id === 10), false);
assert.equal(batchDb.normalized_records.some(row => row.dataset_id === 10), false);

const partialFailureDb = makeDatabase([previous, completedDataset(2, '2024-02-01T00:00:00.000Z')]);
partialFailureDb.failDelete = { table: 'normalized_records', remaining: 2 };
const partialFailure = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(partialFailureDb));
assert.equal(partialFailure.status, 'FAILED');
assert.equal(partialFailureDb.datasets.some(dataset => dataset.id === 1), true);
assert.equal(partialFailureDb.datasets.some(dataset => dataset.id === 2), true);

for (const interruptedStage of ['MARKER_PERSISTED', 'RETENTION_LOCKED', 'OWNED_ROWS_REMOVED', 'SOURCE_OBJECT_REMOVED']) {
  const { db, objects } = lifecycleDatabase();
  const storageDeps = objectStorageDependencies(objects);
  const interrupted = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(db), {
    ...storageDeps,
    afterStage(stage) {
      if (stage === interruptedStage) throw Object.assign(new Error(`simulated interruption after ${stage}`), { code: 'SIMULATED_INTERRUPTION' });
    }
  });
  assert.equal(interrupted.status, 'FAILED', interruptedStage);
  const retained = db.datasets.find(dataset => dataset.id === 1);
  assert.ok(retained, interruptedStage + ' retained dataset metadata');
  assert.equal(retained.detected_entities.sourceObjectCleanup.status, 'PENDING', interruptedStage + ' retained recovery marker');
  const retried = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(db), storageDeps);
  assert.equal(retried.status, 'COMPLETED', interruptedStage + ' retry');
  assert.equal(db.datasets.some(dataset => dataset.id === 1), false, interruptedStage + ' retry removed metadata');
  assert.equal(objects.has(lifecycleStorageKey), false, interruptedStage + ' retry removed object');
}

for (const deleteMode of ['fail-before-delete', 'ambiguous-success']) {
  const { db, objects } = lifecycleDatabase();
  const firstAttemptDeps = objectStorageDependencies(objects, deleteMode);
  const failedAttempt = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(db), firstAttemptDeps);
  assert.equal(failedAttempt.status, 'FAILED', deleteMode);
  assert.ok(db.datasets.find(dataset => dataset.id === 1), deleteMode + ' retained dataset metadata');
  assert.equal(db.datasets.find(dataset => dataset.id === 1).detected_entities.sourceObjectCleanup.status, 'PENDING');
  assert.equal(objects.has(lifecycleStorageKey), deleteMode === 'fail-before-delete');
  const retryDeps = objectStorageDependencies(objects);
  const retryResult = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(db), retryDeps);
  assert.equal(retryResult.status, 'COMPLETED', deleteMode + ' retry');
  assert.equal(db.datasets.some(dataset => dataset.id === 1), false, deleteMode + ' retry removed metadata');
  assert.equal(objects.has(lifecycleStorageKey), false, deleteMode + ' retry left no object');
  assert.equal(retryDeps.deleteCalls, deleteMode === 'ambiguous-success' ? 0 : 1);
}

const finalDeleteScenario = lifecycleDatabase();
finalDeleteScenario.db.failDelete = { table: 'datasets', remaining: 1 };
const finalDeleteDeps = objectStorageDependencies(finalDeleteScenario.objects);
const finalDeleteFailure = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(finalDeleteScenario.db), finalDeleteDeps);
assert.equal(finalDeleteFailure.status, 'FAILED');
assert.ok(finalDeleteScenario.db.datasets.find(dataset => dataset.id === 1));
assert.equal(finalDeleteScenario.objects.has(lifecycleStorageKey), false);
const finalDeleteRetry = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(finalDeleteScenario.db), finalDeleteDeps);
assert.equal(finalDeleteRetry.status, 'COMPLETED');
assert.equal(finalDeleteScenario.db.datasets.some(dataset => dataset.id === 1), false);

const recoveredScenario = lifecycleDatabase({ objectPresent: false });
const recoverableDataset = recoveredScenario.db.datasets.find(dataset => dataset.id === 1);
recoverableDataset.detected_entities.sourceObjectCleanup = createDatasetStorageCleanupMarker(recoverableDataset, '2026-10-20T00:00:00.000Z');
recoverableDataset.detected_entities.retentionCleanup = {
  status: 'RUNNING', token: 'orphan-cleanup-token', ownerToken: 'expired-global-token', startedAt: '2026-10-20T00:00:00.000Z'
};
recoveredScenario.db.system_settings.push({
  id: 901, category: 'maintenance', key: 'dataset_replacement_cleanup_lock',
  value: { token: 'expired-global-token', startedAt: '2026-10-20T00:00:00.000Z', expiresAt: '2026-10-20T00:01:00.000Z' }
});
const recoveryDeps = objectStorageDependencies(recoveredScenario.objects);
const recoveredResult = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(recoveredScenario.db), recoveryDeps);
assert.equal(recoveredResult.status, 'COMPLETED');
assert.equal(recoveredResult.deleted[0].id, 1);
assert.equal(recoveredScenario.db.datasets.some(dataset => dataset.id === 1), false);
assert.equal(recoveryDeps.deleteCalls, 0, 'absent object recovery must not issue another delete');

const missingMarkerScenario = lifecycleDatabase();
const missingMarkerDataset = missingMarkerScenario.db.datasets.find(dataset => dataset.id === 1);
missingMarkerDataset.detected_entities.retentionCleanup = {
  status: 'RUNNING', token: 'orphan-cleanup-token', ownerToken: 'expired-global-token', startedAt: '2026-10-20T00:00:00.000Z'
};
missingMarkerScenario.db.system_settings.push({
  id: 904, category: 'maintenance', key: 'dataset_replacement_cleanup_lock',
  value: { token: 'expired-global-token', expiresAt: '2026-10-20T00:01:00.000Z' }
});
const missingMarkerResult = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(missingMarkerScenario.db), objectStorageDependencies(missingMarkerScenario.objects));
assert.equal(missingMarkerResult.status, 'FAILED');
assert.equal(missingMarkerScenario.db.datasets.find(dataset => dataset.id === 1).detected_entities.retentionCleanup.status, 'FAILED');
assert.equal(missingMarkerScenario.db.datasets.find(dataset => dataset.id === 1).detected_entities.sourceObjectCleanup, undefined);
assert.equal(missingMarkerScenario.db.raw_records.some(row => row.dataset_id === 1), true);
assert.equal(missingMarkerScenario.objects.has(lifecycleStorageKey), true);

const activeLeaseScenario = lifecycleDatabase();
const activeLockedDataset = activeLeaseScenario.db.datasets.find(dataset => dataset.id === 1);
activeLockedDataset.detected_entities.retentionCleanup = {
  status: 'RUNNING', token: 'active-cleanup-token', ownerToken: 'active-global-token', startedAt: '2026-10-20T00:00:00.000Z'
};
activeLeaseScenario.db.system_settings.push({
  id: 902, category: 'maintenance', key: 'dataset_replacement_cleanup_lock',
  value: { token: 'active-global-token', startedAt: '2026-10-21T00:00:00.000Z', expiresAt: new Date(Date.now() + 60_000).toISOString() }
});
const activeLeaseResult = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(activeLeaseScenario.db), objectStorageDependencies(activeLeaseScenario.objects));
assert.equal(activeLeaseResult.status, 'SKIPPED_BUSY');
assert.equal(activeLeaseScenario.db.datasets.some(dataset => dataset.id === 1), true);
assert.equal(activeLeaseScenario.objects.has(lifecycleStorageKey), true);

const unlinkedLockScenario = lifecycleDatabase();
const unlinkedDataset = unlinkedLockScenario.db.datasets.find(dataset => dataset.id === 1);
unlinkedDataset.detected_entities.sourceObjectCleanup = createDatasetStorageCleanupMarker(unlinkedDataset, '2026-10-20T00:00:00.000Z');
unlinkedDataset.detected_entities.retentionCleanup = { status: 'RUNNING', token: 'unlinked-cleanup-token', startedAt: '2026-10-20T00:00:00.000Z' };
unlinkedLockScenario.db.system_settings.push({
  id: 903, category: 'maintenance', key: 'dataset_replacement_cleanup_lock',
  value: { token: 'expired-global-token', expiresAt: '2026-10-20T00:01:00.000Z' }
});
const unlinkedResult = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(unlinkedLockScenario.db), objectStorageDependencies(unlinkedLockScenario.objects));
assert.equal(unlinkedResult.status, 'RECOVERY_UNVERIFIED');
assert.equal(unlinkedLockScenario.db.datasets.some(dataset => dataset.id === 1), true);
assert.equal(unlinkedLockScenario.objects.has(lifecycleStorageKey), true);

const legacyKeyScenario = lifecycleDatabase();
const legacyDataset = legacyKeyScenario.db.datasets.find(dataset => dataset.id === 1);
legacyDataset.storage_key = 'source-uploads/legacy-id/source.csv';
const legacyObjects = legacyKeyScenario.objects;
const legacyResult = await cleanupCompletedAnalysisDatasets(2, new FakeDatabaseClient(legacyKeyScenario.db), {
  async verifyDatasetSourceObjectOwnership(dataset, references) {
    assert.equal(inspectStorageKeyTarget(dataset.storage_key, storageTarget).status, 'UNVERIFIED');
    throw Object.assign(new Error('Legacy source-object key cannot be verified.'), { code: 'SOURCE_OBJECT_OWNERSHIP_UNVERIFIED' });
  },
  async deleteSourceObject() { assert.fail('unverified legacy object must not be deleted'); }
});
assert.equal(legacyResult.status, 'FAILED');
assert.ok(legacyKeyScenario.db.datasets.find(dataset => dataset.id === 1));
assert.equal(legacyKeyScenario.db.datasets.find(dataset => dataset.id === 1).detected_entities.sourceObjectCleanup, undefined);
assert.equal(legacyKeyScenario.db.raw_records.some(row => row.dataset_id === 1), true);
assert.equal(legacyObjects.has(lifecycleStorageKey), true);

console.log(JSON.stringify({
  status: 'PASS',
  cases: [
    'single completed dataset preserved',
    'Supabase database hosts are protected from automatic deletion',
    'failed upload preserves previous dataset',
    'row-count mismatch blocks replacement cleanup',
    'concurrent cleanup lock preserves previous dataset',
    'completed replacement replaces the prior completed dataset',
    'dataset-owned records removed and shared/global records preserved',
    'analysis failure preserves the new dataset',
    'repeated replacement cycle succeeds',
    'dataset-owned deletion is batched and leaves no orphans',
    'failed cleanup retains dataset metadata',
    'interruption after each cleanup stage can be retried safely',
    'object deletion before failure and ambiguous success recover idempotently',
    'expired retention lease is recoverable while an active lease is not stolen',
    'unlinked cleanup locks and legacy object keys remain protected',
    '148015-plus rows remain supported without a total row cap'
  ],
  maxActiveDatasets: maxActiveDatasets('1'),
  actualDatabaseAccess: false
}, null, 2));
