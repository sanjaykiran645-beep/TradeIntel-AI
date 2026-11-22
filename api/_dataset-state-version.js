/**
 * Compare-and-set versioning for full detected_entities snapshots.
 * Every snapshot writer must advance updated_at so a stale reader cannot
 * replace a newer JSON document.
 */
export function nextDatasetStateVersion(previousVersion, now = Date.now()) {
  const previousTime = Date.parse(previousVersion || '');
  const timestamp = Number.isFinite(previousTime)
    ? Math.max(Number(now), previousTime + 1)
    : Number(now);
  return new Date(timestamp).toISOString();
}

export function filterDatasetStateVersion(query, previousVersion) {
  return previousVersion == null
    ? query.is('updated_at', null)
    : query.eq('updated_at', previousVersion);
}

export function datasetStateConflict(datasetId) {
  return Object.assign(new Error(`Dataset ${datasetId} changed while its metadata was being saved; retry from a fresh read.`), {
    code: 'DATASET_STATE_CONFLICT',
    status: 409
  });
}
