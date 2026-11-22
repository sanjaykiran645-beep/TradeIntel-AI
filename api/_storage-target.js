import { createHash } from 'node:crypto';

export function storageTargetFingerprint(endpointValue, bucketValue) {
  const endpoint = String(endpointValue || '').trim();
  const bucket = String(bucketValue || '').trim();
  if (!endpoint || !bucket) return { status: 'MISSING', fingerprint: null };

  try {
    const parsed = new URL(endpoint);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return { status: 'UNVERIFIED', fingerprint: null };
    }
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    const canonicalEndpoint = `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${path}`;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ endpoint: canonicalEndpoint, bucket }))
      .digest('hex');
    return { status: 'VERIFIED', fingerprint };
  } catch {
    return { status: 'UNVERIFIED', fingerprint: null };
  }
}

export function resolveStorageConfiguration({ endpoint, bucket, accessKeyId, secretAccessKey } = {}) {
  if (![endpoint, bucket, accessKeyId, secretAccessKey].every(value => typeof value === 'string' && value.trim())) {
    return { status: 'MISSING', fingerprint: null };
  }
  return storageTargetFingerprint(endpoint, bucket);
}

export function inspectStorageKeyTarget(storageKey, target) {
  if (!target || target.status === 'MISSING') return { status: 'MISSING' };
  if (target.status !== 'VERIFIED' || !target.fingerprint) return { status: 'UNVERIFIED' };
  if (typeof storageKey !== 'string' || !storageKey.startsWith('source-uploads/')) return { status: 'UNVERIFIED' };

  const parts = storageKey.split('/');
  const recordedTarget = parts[1] || '';
  if (!/^[a-f0-9]{64}$/i.test(recordedTarget)) return { status: 'UNVERIFIED' };
  const generatedKeyPattern = /^source-uploads\/([a-f0-9]{64})\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([a-zA-Z0-9._-]{1,120})$/;
  const generatedKey = generatedKeyPattern.exec(storageKey);
  if (!generatedKey || generatedKey[3] === '.' || generatedKey[3] === '..') return { status: 'INVALID' };
  return generatedKey[1] === target.fingerprint
    ? { status: 'MATCH' }
    : { status: 'MISMATCH' };
}

function normalizedDatasetId(value) {
  if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'bigint') return null;
  try {
    const id = BigInt(value);
    return id > 0n ? id.toString() : null;
  } catch {
    return null;
  }
}

export function inspectDatasetStorageOwnership(dataset, datasetReferences, target, objectMetadata) {
  const key = dataset?.storage_key;
  const targetResult = inspectStorageKeyTarget(key, target);
  if (targetResult.status !== 'MATCH') return targetResult;

  const datasetId = normalizedDatasetId(dataset?.id);
  const references = Array.isArray(datasetReferences)
    ? datasetReferences.filter(row => row?.storage_key === key)
    : [];
  if (!datasetId || references.length !== 1 || normalizedDatasetId(references[0]?.id) !== datasetId) {
    return { status: 'WRONG_DATASET' };
  }

  const expectedHash = typeof dataset?.content_hash === 'string' ? dataset.content_hash.trim().toLowerCase() : '';
  const expectedSize = Number(dataset?.original_size_bytes);
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    return { status: 'UNVERIFIED' };
  }
  if (!objectMetadata || typeof objectMetadata !== 'object') {
    const pendingMatches = datasetSourceCleanupMarkerMatches(dataset);
    return pendingMatches ? { status: 'MATCH', objectAbsent: true } : { status: 'UNVERIFIED' };
  }

  const actualHash = String(objectMetadata.Metadata?.['content-sha256'] || '').toLowerCase();
  const actualSize = Number(objectMetadata.ContentLength);
  if (!/^[a-f0-9]{64}$/.test(actualHash) || !Number.isSafeInteger(actualSize)) return { status: 'UNVERIFIED' };
  if (actualHash !== expectedHash || actualSize !== expectedSize) return { status: 'CONTENT_MISMATCH' };
  return { status: 'MATCH', objectAbsent: false };
}

export function datasetSourceCleanupMarkerMatches(dataset) {
  const pending = dataset?.detected_entities?.sourceObjectCleanup;
  const expectedHash = typeof dataset?.content_hash === 'string' ? dataset.content_hash.trim().toLowerCase() : '';
  const expectedSize = Number(dataset?.original_size_bytes);
  const datasetId = normalizedDatasetId(dataset?.id);
  return Boolean(datasetId && /^[a-f0-9]{64}$/.test(expectedHash) && Number.isSafeInteger(expectedSize) && expectedSize > 0 &&
    pending?.status === 'PENDING' &&
    normalizedDatasetId(pending.datasetId) === datasetId &&
    pending.storageKey === dataset.storage_key &&
    String(pending.contentHash || '').toLowerCase() === expectedHash &&
    Number(pending.originalSizeBytes) === expectedSize);
}

export function createDatasetStorageCleanupMarker(dataset, verifiedAt = new Date().toISOString()) {
  return {
    status: 'PENDING',
    datasetId: normalizedDatasetId(dataset?.id),
    storageKey: dataset?.storage_key || null,
    contentHash: String(dataset?.content_hash || '').trim().toLowerCase(),
    originalSizeBytes: Number(dataset?.original_size_bytes),
    verifiedAt
  };
}

export function assertStorageKeyTarget(storageKey, target) {
  const result = inspectStorageKeyTarget(storageKey, target);
  if (result.status === 'MATCH') return result;

  const code = result.status === 'MISSING'
    ? 'OBJECT_STORAGE_NOT_CONFIGURED'
    : result.status === 'MISMATCH'
      ? 'OBJECT_STORAGE_TARGET_MISMATCH'
      : result.status === 'INVALID'
        ? 'SOURCE_STORAGE_KEY_INVALID'
        : 'OBJECT_STORAGE_TARGET_UNVERIFIED';
  throw Object.assign(new Error('Object storage target configuration is missing, changed, or could not be verified.'), {
    code,
    status: result.status === 'INVALID' ? 400 : 503
  });
}

export function sanitizeStorageProviderError(error) {
  if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
    return { message: 'The source object was not found in private storage.', code: 'OBJECT_STORAGE_OBJECT_NOT_FOUND', status: 409 };
  }
  if (['TimeoutError', 'RequestTimeout', 'ECONNRESET', 'ECONNREFUSED'].includes(error?.code) || error?.$retryable) {
    return { message: 'Private object storage is temporarily unavailable.', code: 'OBJECT_STORAGE_UNAVAILABLE', status: 503 };
  }
  return { message: 'Private object storage request failed.', code: 'OBJECT_STORAGE_ERROR', status: 502 };
}

