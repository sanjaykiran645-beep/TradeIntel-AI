import { createDatasetStorageCleanupMarker } from './_storage-target.js';
import { filterDatasetStateVersion, nextDatasetStateVersion } from './_dataset-state-version.js';

/**
 * Verify an object's dataset association, then persist a retry marker before
 * destructive cleanup. The marker lives in the existing detected_entities JSONB.
 */
export async function prepareDatasetSourceObjectCleanup(client, dataset, datasetReferences, verifyOwnership) {
  if (!dataset?.storage_key) return { proof: null, marker: null };
  if (!client || typeof verifyOwnership !== 'function') {
    throw Object.assign(new Error('Source object cleanup could not be verified.'), { code: 'SOURCE_OBJECT_OWNERSHIP_UNVERIFIED', status: 503 });
  }

  let references = datasetReferences;
  if (!Array.isArray(references)) {
    const result = await client.from('datasets')
      .select('id,storage_key')
      .eq('storage_key', dataset.storage_key);
    if (result.error) throw result.error;
    references = result.data || [];
  }

  const proof = await verifyOwnership(dataset, references);
  const marker = createDatasetStorageCleanupMarker(dataset);
  if (!marker.datasetId || !marker.contentHash || !Number.isSafeInteger(marker.originalSizeBytes) || marker.originalSizeBytes <= 0) {
    throw Object.assign(new Error('Source object cleanup metadata is incomplete; dataset records were preserved.'), { code: 'SOURCE_OBJECT_OWNERSHIP_UNVERIFIED', status: 503 });
  }

  const detectedEntities = dataset.detected_entities && typeof dataset.detected_entities === 'object'
    ? dataset.detected_entities
    : {};
  const nextEntities = { ...detectedEntities, sourceObjectCleanup: marker };
  const updatedAt = nextDatasetStateVersion(dataset.updated_at, Date.parse(marker.verifiedAt));
  let update = client.from('datasets')
    .update({ detected_entities: nextEntities, updated_at: updatedAt })
    .eq('id', dataset.id)
    .eq('storage_key', dataset.storage_key)
    .eq('content_hash', dataset.content_hash)
    .eq('original_size_bytes', dataset.original_size_bytes);
  update = filterDatasetStateVersion(update, dataset.updated_at);
  const result = await update.select('id,updated_at').maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) {
    throw Object.assign(new Error('Dataset storage metadata changed before cleanup; no dataset-owned rows were deleted.'), { code: 'SOURCE_OBJECT_OWNERSHIP_CHANGED', status: 409 });
  }

  dataset.detected_entities = nextEntities;
  dataset.updated_at = result.data.updated_at || updatedAt;
  return { proof, marker };
}
