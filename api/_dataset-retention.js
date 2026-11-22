import { randomUUID } from 'node:crypto';
import supabase, { dbConfigured } from './_db-client.js';
import { deleteDatasetOwnedRows, isProtectedDatasetId } from './_dataset-delete.js';
import { deriveAnalysisStatus } from './_analysis-status.js';
import { deleteSourceObject, verifyDatasetSourceObjectOwnership } from './_object-storage.js';
import { prepareDatasetSourceObjectCleanup } from './_dataset-storage-cleanup.js';
import { datasetSourceCleanupMarkerMatches } from './_storage-target.js';
import { filterDatasetStateVersion, nextDatasetStateVersion } from './_dataset-state-version.js';

const PAGE_SIZE = 1000;
const DELETE_BATCH_SIZE = 500;
const DEFAULT_MAX_ACTIVE_DATASETS = 1;
const RETENTION_LOCK_KEY = 'dataset_replacement_cleanup_lock';
const RETENTION_LOCK_TTL_MS = 30 * 60 * 1000;
const MAX_READ_RETRIES = 2;

export function maxActiveDatasets(value = process.env.MAX_ACTIVE_DATASETS) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : DEFAULT_MAX_ACTIVE_DATASETS;
}

export function isSupabaseDatabaseTarget(value = process.env.DATABASE_URL) {
  if (!value) return false;
  try {
    const hostname = new URL(String(value)).hostname.toLowerCase();
    return hostname === 'supabase.co' || hostname.endsWith('.supabase.co') ||
      hostname === 'supabase.com' || hostname.endsWith('.supabase.com');
  } catch {
    return false;
  }
}

function asDatasetId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function completedTime(dataset) {
  const value = Date.parse(
    dataset?.analysis_completed_at ||
    dataset?.detected_entities?.pipeline?.stages?.PANDAS_ANALYSIS?.completedAt ||
    dataset?.detected_entities?.pipeline?.completedAt ||
    dataset?.created_at || ''
  );
  return Number.isFinite(value) ? value : 0;
}

function newestFirst(a, b) {
  return completedTime(b) - completedTime(a) || Number(b.id) - Number(a.id);
}

export function isValidatedImportedDataset(dataset) {
  const state = dataset?.detected_entities?.import;
  const counts = state?.actualCounts;
  const expectedRows = Number(state?.expectedRows ?? dataset?.total_rows);
  if (state?.status !== 'COMPLETED' || !counts || !Number.isSafeInteger(expectedRows) || expectedRows <= 0) return false;
  const totalRows = Number(counts.totalRows);
  const validRows = Number(counts.validRows);
  const duplicateRows = Number(counts.duplicateRows);
  const errorRows = Number(counts.errorRows);
  const normalizedRows = Number(counts.normalizedRows);
  return totalRows === expectedRows &&
    Number(dataset?.total_rows ?? expectedRows) === expectedRows &&
    [validRows, duplicateRows, errorRows, normalizedRows].every(Number.isSafeInteger) &&
    validRows + duplicateRows + errorRows === totalRows &&
    normalizedRows === validRows;
}

export function isCompletedAnalysis(dataset) {
  const entities = dataset?.detected_entities;
  const pipeline = entities?.pipeline;
  if (entities?.import?.status !== 'COMPLETED' || !pipeline) return false;
  if (dataset.import_status && dataset.import_status !== 'COMPLETED') return false;
  if (dataset.analysis_status && dataset.analysis_status !== 'COMPLETED') return false;
  if (['FAILED', 'BLOCKED', 'REVIEW_REQUIRED', 'RUNNING'].includes(dataset.status)) return false;
  if (pipeline.status && pipeline.status !== 'COMPLETED') return false;
  if (entities?.retentionCleanup?.status === 'RUNNING') return false;
  return deriveAnalysisStatus(pipeline) === 'COMPLETED';
}

// Keep the previous analysis until the replacement has completed its core
// analysis stages. A verified import alone is not a safe replacement.
export function planCompletedAnalysisRetention(datasets, currentDatasetId, options = {}) {
  const currentId = asDatasetId(currentDatasetId);
  const current = (datasets || []).find(dataset => asDatasetId(dataset.id) === currentId);
  const maxActive = maxActiveDatasets(options.maxActiveDatasets ?? process.env.MAX_ACTIVE_DATASETS);
  if (!currentId || !current || !isValidatedImportedDataset(current)) {
    return {
      status: 'IMPORT_NOT_VALIDATED',
      currentDatasetId: currentId,
      maxActiveDatasets: maxActive,
      completedAnalysisCount: (datasets || []).filter(isCompletedAnalysis).length,
      candidates: []
    };
  }
  if (!isCompletedAnalysis(current)) {
    return {
      status: 'ANALYSIS_NOT_COMPLETED',
      currentDatasetId: currentId,
      maxActiveDatasets: maxActive,
      completedAnalysisCount: (datasets || []).filter(isCompletedAnalysis).length,
      candidates: []
    };
  }

  const recoverableOwners = new Set(options.recoverableCleanupOwners || []);
  const completedForRetention = dataset => {
    if (isCompletedAnalysis(dataset)) return true;
    const cleanup = dataset?.detected_entities?.retentionCleanup;
    return cleanup?.status === 'RUNNING' && recoverableOwners.has(cleanup.ownerToken) &&
      isCompletedAnalysis({
        ...dataset,
        detected_entities: { ...dataset.detected_entities, retentionCleanup: { ...cleanup, status: 'FAILED' } }
      });
  };
  const previousCompleted = (datasets || [])
    .filter(dataset => asDatasetId(dataset.id) !== currentId && completedForRetention(dataset))
    .slice()
    .sort(newestFirst);
  const protectedPrevious = previousCompleted.filter(dataset => isProtectedDatasetId(dataset.id));
  const eligiblePrevious = previousCompleted.filter(dataset => !isProtectedDatasetId(dataset.id));
  const previousToKeep = Math.max(0, maxActive - 1);
  const candidates = eligiblePrevious
    .slice(previousToKeep)
    .reverse()
    .map(dataset => ({
      id: Number(dataset.id),
      filename: dataset.filename || null,
      completedAt: dataset.analysis_completed_at || dataset.detected_entities?.pipeline?.updatedAt || dataset.created_at || null,
      reason: 'REPLACED_AFTER_SUCCESSFUL_ANALYSIS',
      estimatedRows: Number(dataset.total_rows || 0)
    }));

  return {
    status: candidates.length ? 'READY' : 'NO_CLEANUP_REQUIRED',
    currentDatasetId: currentId,
    maxActiveDatasets: maxActive,
    completedAnalysisCount: previousCompleted.length,
    previousAnalysesToKeep: previousToKeep + protectedPrevious.length,
    projectedRetainedDatasetCount: 1 + protectedPrevious.length + Math.min(eligiblePrevious.length, previousToKeep),
    candidates
  };
}

function requireClient(client) {
  if (!client) throw Object.assign(new Error('PostgreSQL database client is not configured.'), { code: 'DATABASE_NOT_CONFIGURED' });
}

function blockedDatabaseTarget(client) {
  if (client !== supabase) return null;
  if (!dbConfigured) return { code: 'DATABASE_NOT_CONFIGURED', reason: 'Set DATABASE_URL to a managed PostgreSQL target before dataset replacement cleanup.' };
  if (isSupabaseDatabaseTarget()) return { code: 'SUPABASE_DATABASE_PROTECTED', reason: 'Automatic dataset replacement is disabled for Supabase database hosts.' };
  return null;
}

function isRetryableDatabaseError(error) {
  const code = String(error?.code || '');
  const status = Number(error?.status || 0);
  return code === 'PGRST002' || code === '57014' || status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readWithRetry(operation) {
  for (let attempt = 0; attempt <= MAX_READ_RETRIES; attempt++) {
    const result = await operation();
    if (!result.error || !isRetryableDatabaseError(result.error) || attempt === MAX_READ_RETRIES) return result;
    await sleep(250 * (2 ** attempt));
  }
}

async function readAllDatasets(client) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await readWithRetry(() => client
      .from('datasets')
      .select('id,filename,total_rows,storage_key,content_hash,original_size_bytes,created_at,updated_at,import_status,analysis_status,analysis_completed_at,detected_entities')
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1));
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    offset += page.length;
  }
}

async function exactCount(client, table, datasetId = null, predicates = []) {
  const { count, error } = await readWithRetry(() => {
    let query = client.from(table).select('id', { count: 'exact', head: true });
    if (datasetId !== null) query = query.eq('dataset_id', datasetId);
    for (const [column, value] of predicates) query = query.eq(column, value);
    return query;
  });
  if (error) throw error;
  return Number(count || 0);
}

async function countImportRows(client, datasetId) {
  const [totalRows, validRows, duplicateRows, errorRows, normalizedRows] = await Promise.all([
    exactCount(client, 'raw_records', datasetId),
    exactCount(client, 'raw_records', datasetId, [['is_valid', true], ['is_duplicate', false]]),
    exactCount(client, 'raw_records', datasetId, [['is_duplicate', true]]),
    exactCount(client, 'raw_records', datasetId, [['is_valid', false]]),
    exactCount(client, 'normalized_records', datasetId)
  ]);
  return { totalRows, validRows, duplicateRows, errorRows, normalizedRows };
}

function countsReconcile(dataset, actualCounts) {
  const expectedRows = Number(dataset?.detected_entities?.import?.expectedRows ?? dataset?.total_rows);
  const storedCounts = dataset?.detected_entities?.import?.actualCounts || {};
  const sameCounts = ['totalRows', 'validRows', 'duplicateRows', 'errorRows', 'normalizedRows']
    .every(key => Number(storedCounts[key]) === Number(actualCounts[key]));
  return isValidatedImportedDataset(dataset) &&
    actualCounts.totalRows === expectedRows &&
    actualCounts.validRows + actualCounts.duplicateRows + actualCounts.errorRows === expectedRows &&
    actualCounts.normalizedRows === actualCounts.validRows &&
    sameCounts;
}

async function countSnapshot(client) {
  const [datasets, rawRecords, normalizedRecords] = await Promise.all([
    exactCount(client, 'datasets'),
    exactCount(client, 'raw_records'),
    exactCount(client, 'normalized_records')
  ]);
  return { datasets, rawRecords, normalizedRecords };
}

function makeRetentionLock(token, released = false) {
  const now = Date.now();
  return {
    token,
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(released ? 0 : now + RETENTION_LOCK_TTL_MS).toISOString(),
    ...(released ? { releasedAt: new Date(now).toISOString() } : {})
  };
}

async function acquireGlobalRetentionLock(client) {
  const token = randomUUID();
  const value = makeRetentionLock(token);
  const insert = await client.from('system_settings').insert({
    category: 'maintenance', key: RETENTION_LOCK_KEY, value, updated_at: value.startedAt
  }).select('id,value').maybeSingle();
  if (!insert.error && insert.data) return { id: insert.data.id, token };
  if (!insert.error) throw Object.assign(new Error('Dataset replacement lock insert returned no row.'), { code: 'RETENTION_LOCK_UNVERIFIED' });
  if (insert.error.code !== '23505') throw insert.error;

  const { data: existing, error: readError } = await readWithRetry(() => client.from('system_settings')
    .select('id,value').eq('key', RETENTION_LOCK_KEY).maybeSingle());
  if (readError) throw readError;
  if (!existing) throw Object.assign(new Error('Replacement lock conflict occurred, but its row could not be found.'), { code: 'RETENTION_LOCK_CONFLICT' });
  const expiration = Date.parse(existing.value?.expiresAt || '');
  if (!Number.isFinite(expiration) || expiration > Date.now()) return null;

  const updated = await client.from('system_settings')
    .update({ value, updated_at: value.startedAt })
    .eq('id', existing.id)
    .filter('value->>token', 'eq', existing.value?.token || '')
    .select('id').maybeSingle();
  if (updated.error) throw updated.error;
  return updated.data ? { id: updated.data.id, token, recoveryFrom: existing.value } : null;
}

async function renewGlobalRetentionLock(client, lock) {
  const value = makeRetentionLock(lock.token);
  const { data, error } = await client.from('system_settings')
    .update({ value, updated_at: value.startedAt })
    .eq('id', lock.id).filter('value->>token', 'eq', lock.token)
    .select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Dataset replacement lock was lost.'), { code: 'RETENTION_LOCK_LOST' });
}

function startGlobalRetentionHeartbeat(client, lock) {
  let failure = null;
  let tail = Promise.resolve();
  const renew = () => {
    const request = tail.then(async () => {
      if (failure) throw failure;
      await renewGlobalRetentionLock(client, lock);
    });
    tail = request.catch(error => { failure = error; });
    return request;
  };
  const interval = setInterval(() => { renew().catch(() => {}); }, Math.max(1000, Math.floor(RETENTION_LOCK_TTL_MS / 3)));
  interval.unref?.();
  return {
    renew,
    async stop() {
      clearInterval(interval);
      await tail;
    }
  };
}

async function releaseGlobalRetentionLock(client, lock) {
  const value = makeRetentionLock(lock.token, true);
  const { data, error } = await client.from('system_settings')
    .update({ value, updated_at: value.releasedAt })
    .eq('id', lock.id).filter('value->>token', 'eq', lock.token)
    .select('id').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function writeRetentionAudit(client, dataset, details) {
  const { error } = await client.from('audit_logs').insert({
    action: 'REPLACE_COMPLETED_DATASET',
    entity_type: 'dataset',
    entity_id: String(dataset.id),
    details: {
      datasetId: Number(dataset.id),
      filename: dataset.filename || null,
      reason: details.reason,
      completedAt: details.completedAt || null,
      deletedByTable: details.deletedByTable || {},
      cleanupStatus: details.cleanupStatus,
      error: details.error || null
    },
    created_at: new Date().toISOString()
  });
  if (error) throw Object.assign(new Error(`Replacement audit log failed: ${error.message || error.code || 'database error'}`), { code: error.code || 'RETENTION_AUDIT_FAILED' });
}

export async function previewCompletedAnalysisRetention(currentDatasetId = null, client = supabase) {
  requireClient(client);
  const blocked = blockedDatabaseTarget(client);
  if (blocked) return { status: 'BLOCKED', currentDatasetId: asDatasetId(currentDatasetId), reason: blocked.reason, blocker: blocked.code, candidates: [], recoveredStorageBytes: null };
  if (!asDatasetId(currentDatasetId)) return { status: 'CURRENT_DATASET_REQUIRED', candidates: [], recoveredStorageBytes: null };

  const [datasets, totals] = await Promise.all([readAllDatasets(client), countSnapshot(client)]);
  const current = datasets.find(dataset => Number(dataset.id) === Number(currentDatasetId));
  if (!current || !isValidatedImportedDataset(current)) {
    return { status: 'IMPORT_NOT_VALIDATED', currentDatasetId: Number(currentDatasetId), candidates: [], countsBefore: totals, countsAfter: totals, recoveredStorageBytes: null };
  }
  const actualCounts = await countImportRows(client, currentDatasetId);
  if (!countsReconcile(current, actualCounts)) {
    return { status: 'IMPORT_COUNT_MISMATCH', currentDatasetId: Number(currentDatasetId), actualCounts, expectedCounts: current.detected_entities.import.actualCounts, candidates: [], countsBefore: totals, countsAfter: totals, recoveredStorageBytes: null };
  }

  const plan = planCompletedAnalysisRetention(datasets, currentDatasetId);
  return {
    ...plan,
    status: plan.status,
    countsBefore: totals,
    countsAfter: totals,
    verifiedImportCounts: actualCounts,
    recoveredStorageBytes: null,
    storageMeasurement: 'Database filesystem space reclaimed by PostgreSQL was not measured.'
  };
}

async function acquireCleanupLock(client, dataset, globalLock, recoverOwnerToken = null) {
  const datasetId = asDatasetId(dataset.id);
  const entities = dataset.detected_entities || {};
  const pipeline = entities.pipeline || {};
  const priorCleanup = entities.retentionCleanup || {};
  if (!datasetId || !pipeline.token) return null;
  if (recoverOwnerToken) {
    if (priorCleanup.status !== 'RUNNING' || priorCleanup.ownerToken !== recoverOwnerToken) return null;
  } else if (priorCleanup.status === 'RUNNING') {
    return null;
  }

  const token = randomUUID();
  const lockedEntities = {
    ...entities,
    retentionCleanup: { status: 'RUNNING', token, ownerToken: globalLock.token, startedAt: new Date().toISOString() }
  };
  const updatedAt = nextDatasetStateVersion(dataset.updated_at);
  let update = client.from('datasets')
    .update({ detected_entities: lockedEntities, updated_at: updatedAt })
    .eq('id', datasetId);
  update = filterDatasetStateVersion(update, dataset.updated_at)
    .filter('detected_entities->pipeline->>token', 'eq', pipeline.token)
    .filter('detected_entities->pipeline->>status', 'eq', pipeline.status);
  if (recoverOwnerToken) {
    update = update.filter('detected_entities->retentionCleanup->>status', 'eq', 'RUNNING')
      .filter('detected_entities->retentionCleanup->>ownerToken', 'eq', recoverOwnerToken)
      .filter('detected_entities->retentionCleanup->>token', 'eq', priorCleanup.token);
  }
  const { data, error } = await update.select('id,updated_at').maybeSingle();
  if (error) throw error;
  return data ? { token, ownerToken: globalLock.token, originalEntities: entities, updatedAt: data.updated_at || updatedAt } : null;
}

async function removeLockedDataset(client, datasetId, token, ownerToken) {
  const { data, error } = await client.from('datasets')
    .delete().eq('id', datasetId)
    .filter('detected_entities->retentionCleanup->>ownerToken', 'eq', ownerToken)
    .filter('detected_entities->retentionCleanup->>token', 'eq', token)
    .select('id').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function releaseCleanupLock(client, datasetId, token, ownerToken, originalEntities, expectedUpdatedAt, failure) {
  const restoredEntities = {
    ...originalEntities,
    retentionCleanup: { status: 'FAILED', updatedAt: new Date().toISOString(), error: failure?.message || 'Cleanup did not remove the dataset.' }
  };
  let update = client.from('datasets').update({ detected_entities: restoredEntities, updated_at: nextDatasetStateVersion(expectedUpdatedAt) })
    .eq('id', datasetId);
  update = filterDatasetStateVersion(update, expectedUpdatedAt)
    .filter('detected_entities->retentionCleanup->>ownerToken', 'eq', ownerToken)
    .filter('detected_entities->retentionCleanup->>token', 'eq', token);
  const { data, error } = await update.select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Dataset retention lock changed before its failure state could be restored.'), { code: 'RETENTION_LOCK_LOST' });
}

async function releaseAbandonedCleanupLock(client, dataset, ownerToken, failure) {
  const entities = dataset.detected_entities || {};
  const cleanup = entities.retentionCleanup || {};
  if (cleanup.status !== 'RUNNING' || cleanup.ownerToken !== ownerToken || !cleanup.token) return false;
  const restoredEntities = {
    ...entities,
    retentionCleanup: { status: 'FAILED', updatedAt: new Date().toISOString(), error: failure?.message || 'Interrupted cleanup was revalidated but could not resume.' }
  };
  let update = client.from('datasets').update({ detected_entities: restoredEntities, updated_at: nextDatasetStateVersion(dataset.updated_at) })
    .eq('id', dataset.id);
  update = filterDatasetStateVersion(update, dataset.updated_at)
    .filter('detected_entities->retentionCleanup->>status', 'eq', 'RUNNING')
    .filter('detected_entities->retentionCleanup->>ownerToken', 'eq', ownerToken)
    .filter('detected_entities->retentionCleanup->>token', 'eq', cleanup.token);
  const { data, error } = await update.select('id').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function cleanupCompletedAnalysisDatasets(currentDatasetId = null, client = supabase, dependencies = {}) {
  requireClient(client);
  const blocked = blockedDatabaseTarget(client);
  if (blocked) return { status: 'BLOCKED', currentDatasetId: asDatasetId(currentDatasetId), reason: blocked.reason, blocker: blocked.code, deleted: [], failed: [], recoveredStorageBytes: null };

  const preview = await previewCompletedAnalysisRetention(currentDatasetId, client);
  if (preview.status === 'IMPORT_NOT_VALIDATED' || preview.status === 'IMPORT_COUNT_MISMATCH' || preview.status === 'ANALYSIS_NOT_COMPLETED' || preview.status === 'CURRENT_DATASET_REQUIRED' || preview.status === 'BLOCKED') {
    return { ...preview, deleted: [], failed: [] };
  }

  const globalLock = await acquireGlobalRetentionLock(client);
  if (!globalLock) return { ...preview, status: 'SKIPPED_BUSY', deleted: [], failed: [], reason: 'Another replacement cleanup owns the lock.' };
  const heartbeat = startGlobalRetentionHeartbeat(client, globalLock);
  const prepareStorageCleanup = dependencies.prepareDatasetSourceObjectCleanup || prepareDatasetSourceObjectCleanup;
  const verifyOwnership = dependencies.verifyDatasetSourceObjectOwnership || verifyDatasetSourceObjectOwnership;
  const removeSourceObject = dependencies.deleteSourceObject || deleteSourceObject;
  const removeOwnedRows = dependencies.deleteDatasetOwnedRows || deleteDatasetOwnedRows;
  const afterStage = dependencies.afterStage;

  const deleted = [];
  const failed = [];
  try {
    await heartbeat.renew();
    const freshDatasets = await readAllDatasets(client);
    const current = freshDatasets.find(row => Number(row.id) === Number(currentDatasetId));
    const freshCounts = current ? await countImportRows(client, currentDatasetId) : null;
    if (!current || !countsReconcile(current, freshCounts) || !isCompletedAnalysis(current)) {
      return { ...preview, status: current ? 'ANALYSIS_NOT_COMPLETED' : 'CURRENT_DATASET_REQUIRED', deleted, failed };
    }
    const recoveryFromToken = globalLock.recoveryFrom?.token || null;
    const recoverableOwners = recoveryFromToken ? [recoveryFromToken] : [];
    const freshPlan = planCompletedAnalysisRetention(freshDatasets, currentDatasetId, { recoverableCleanupOwners: recoverableOwners });
    const unrecoverableRunning = freshDatasets.filter(row => Number(row.id) !== Number(currentDatasetId) &&
      row?.detected_entities?.retentionCleanup?.status === 'RUNNING' &&
      !recoverableOwners.includes(row.detected_entities.retentionCleanup.ownerToken));
    for (const row of unrecoverableRunning) {
      failed.push({ id: Number(row.id), cleanupStatus: 'RECOVERY_UNVERIFIED', error: 'A previous retention lock is not linked to the expired global lease; its dataset and object were preserved.' });
    }
    for (const planned of freshPlan.candidates) {
      let dataset = null;
      let datasetLock = null;
      let recoveryOwnerForDataset = null;
      let deletedByTable = {};
      try {
        await heartbeat.renew();
        const datasets = await readAllDatasets(client);
        const current = datasets.find(row => Number(row.id) === Number(currentDatasetId));
        const liveImportCounts = current ? await countImportRows(client, currentDatasetId) : null;
        if (!current || !countsReconcile(current, liveImportCounts) || !isCompletedAnalysis(current)) {
          throw Object.assign(new Error('The replacement import no longer reconciles or its core analysis is not complete.'), { code: 'ANALYSIS_NOT_COMPLETED' });
        }
        const livePlan = planCompletedAnalysisRetention(datasets, currentDatasetId, { recoverableCleanupOwners: recoverableOwners });
        if (!livePlan.candidates.some(candidate => candidate.id === planned.id)) {
          throw Object.assign(new Error(`Previous dataset ${planned.id} is no longer a safe completed-analysis deletion candidate.`), { code: 'DATASET_REPLACEMENT_CANDIDATE_CHANGED' });
        }
        dataset = datasets.find(row => Number(row.id) === planned.id);
        const cleanupState = dataset?.detected_entities?.retentionCleanup;
        const recovering = cleanupState?.status === 'RUNNING' && recoverableOwners.includes(cleanupState.ownerToken);
        recoveryOwnerForDataset = recovering ? recoveryFromToken : null;
        if (!dataset || (!isCompletedAnalysis(dataset) && !recovering) || planned.id === Number(currentDatasetId)) {
          throw Object.assign(new Error(`Dataset ${planned.id} is no longer a completed previous analysis.`), { code: 'DATASET_NOT_SAFE_TO_DELETE' });
        }
        if (recovering && dataset.storage_key && !datasetSourceCleanupMarkerMatches(dataset)) {
          throw Object.assign(new Error('Interrupted cleanup has no matching persisted source-object marker; dataset records were preserved.'), { code: 'SOURCE_OBJECT_OWNERSHIP_UNVERIFIED', status: 503 });
        }
        const storageCleanup = dataset.storage_key
          ? await prepareStorageCleanup(client, dataset, datasets, verifyOwnership)
          : { proof: null, marker: null };
        if (typeof afterStage === 'function') await afterStage('MARKER_PERSISTED', dataset);
        await heartbeat.renew();
        datasetLock = await acquireCleanupLock(client, dataset, globalLock, recovering ? recoveryFromToken : null);
        if (!datasetLock) throw Object.assign(new Error(`Could not claim previous dataset ${planned.id} for replacement cleanup.`), { code: 'DATASET_CLEANUP_LOCKED' });
        if (typeof afterStage === 'function') await afterStage('RETENTION_LOCKED', dataset);

        const before = {
          rawRecords: await exactCount(client, 'raw_records', planned.id),
          normalizedRecords: await exactCount(client, 'normalized_records', planned.id)
        };
        const removed = await removeOwnedRows(client, planned.id, {
          batchSize: DELETE_BATCH_SIZE,
          beforeBatch: async () => heartbeat.renew(),
          onBatch: async () => heartbeat.renew()
        });
        deletedByTable = removed.deletedByTable;
        if (typeof afterStage === 'function') await afterStage('OWNED_ROWS_REMOVED', dataset);
        if (Object.values(removed.remainingByTable).some(count => count !== 0)) {
          throw Object.assign(new Error(`Dataset ${planned.id} still has dataset-linked records after cleanup.`), { code: 'DATASET_DELETE_VERIFICATION_FAILED' });
        }
        await heartbeat.renew();
        const sourceObject = dataset.storage_key
          ? await removeSourceObject(dataset, storageCleanup.proof)
          : { deleted: false, reason: 'NO_STORAGE_KEY' };
        if (typeof afterStage === 'function') await afterStage('SOURCE_OBJECT_REMOVED', dataset);
        await heartbeat.renew();
        if (!await removeLockedDataset(client, planned.id, datasetLock.token, datasetLock.ownerToken)) {
          throw Object.assign(new Error(`Dataset ${planned.id} no longer held the cleanup lock; its metadata was retained.`), { code: 'RETENTION_LOCK_LOST' });
        }
        const deletedEntry = {
          id: planned.id,
          reason: planned.reason,
          completedAt: planned.completedAt,
          rawRecords: before.rawRecords,
          normalizedRecords: before.normalizedRecords,
          deletedByTable,
          sourceObjectDeleted: sourceObject.deleted,
          cleanupStatus: 'COMPLETED'
        };
        deleted.push(deletedEntry);
        try { await writeRetentionAudit(client, dataset, deletedEntry); }
        catch (auditError) { deletedEntry.auditError = auditError.message || auditError.code || 'Audit write failed.'; }
      } catch (error) {
        if (datasetLock && dataset) {
          try { await releaseCleanupLock(client, planned.id, datasetLock.token, datasetLock.ownerToken, datasetLock.originalEntities, datasetLock.updatedAt, error); }
          catch (releaseError) { error.message = `${error.message}; cleanup state restore failed: ${releaseError.message || releaseError.code}`; }
        } else if (dataset && recoveryOwnerForDataset) {
          try { await releaseAbandonedCleanupLock(client, dataset, recoveryOwnerForDataset, error); }
          catch (releaseError) { error.message = `${error.message}; abandoned cleanup state restore failed: ${releaseError.message || releaseError.code}`; }
        }
        failed.push({ id: planned.id, cleanupStatus: 'FAILED', deletedByTable, error: error.message || error.code || 'Dataset replacement cleanup failed.' });
        break;
      }
    }

    let countsAfter = null;
    let countDeltasMatch = false;
    try {
      countsAfter = await countSnapshot(client);
      const expectedRaw = deleted.reduce((sum, item) => sum + item.rawRecords, 0);
      const expectedNormalized = deleted.reduce((sum, item) => sum + item.normalizedRecords, 0);
      countDeltasMatch = countsAfter.datasets === preview.countsBefore.datasets - deleted.length &&
        countsAfter.rawRecords === preview.countsBefore.rawRecords - expectedRaw &&
        countsAfter.normalizedRecords === preview.countsBefore.normalizedRecords - expectedNormalized;
      if (!countDeltasMatch) failed.push({ cleanupStatus: 'VERIFICATION_FAILED', error: 'Database count changes do not match the verified deletion counts.' });
    } catch (error) {
      failed.push({ cleanupStatus: 'VERIFICATION_FAILED', error: error.message || error.code || 'Could not verify post-cleanup counts.' });
    }
    const allCandidatesDeleted = deleted.length === freshPlan.candidates.length;
    const status = failed.length
      ? (deleted.length ? 'PARTIAL' : failed.every(item => item.cleanupStatus === 'RECOVERY_UNVERIFIED') ? 'RECOVERY_UNVERIFIED' : 'FAILED')
      : allCandidatesDeleted && countDeltasMatch ? 'COMPLETED' : 'COMPLETED_UNVERIFIED';
    return { ...preview, status, deleted, failed, countsAfter, countDeltasMatch, recoveredStorageBytes: null };
  } finally {
    try {
      await heartbeat.stop();
    } catch (error) {
      console.error(`[RETENTION] heartbeat stop failed: ${error.code || 'LOCK_RENEW_FAILED'}`);
    }
    try {
      const released = await releaseGlobalRetentionLock(client, globalLock);
      if (!released) console.error('[RETENTION] Replacement lock was not released by its owner.');
    } catch (error) {
      console.error(`[RETENTION] Replacement lock release failed: ${error.code || 'LOCK_RELEASE_FAILED'}`);
    }
  }
}
