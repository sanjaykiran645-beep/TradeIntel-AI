import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  assertStorageKeyTarget,
  inspectDatasetStorageOwnership,
  resolveStorageConfiguration,
  sanitizeStorageProviderError
} from './_storage-target.js';

const endpoint = String(process.env.OBJECT_STORAGE_ENDPOINT || '').trim();
const bucket = String(process.env.OBJECT_STORAGE_BUCKET || '').trim();
const accessKeyId = String(process.env.OBJECT_STORAGE_ACCESS_KEY || '').trim();
const secretAccessKey = String(process.env.OBJECT_STORAGE_SECRET_KEY || '').trim();
const region = String(process.env.OBJECT_STORAGE_REGION || 'auto').trim();
const storageTarget = resolveStorageConfiguration({ endpoint, bucket, accessKeyId, secretAccessKey });

export const objectStorageConfigured = storageTarget.status === 'VERIFIED';

export function assertSourceObjectTarget(storageKey) {
  if (storageTarget.status === 'MISSING') {
    throw Object.assign(new Error('Private source-file storage is not configured.'), { code: 'OBJECT_STORAGE_NOT_CONFIGURED', status: 503 });
  }
  if (storageTarget.status !== 'VERIFIED') {
    throw Object.assign(new Error('Private source-file storage target could not be verified.'), { code: 'OBJECT_STORAGE_TARGET_UNVERIFIED', status: 503 });
  }
  return assertStorageKeyTarget(storageKey, storageTarget);
}

let client = null;
const ownershipProofs = new WeakMap();

function getClient() {
  if (!objectStorageConfigured) {
    throw Object.assign(new Error('Private object storage is not configured.'), {
      code: 'OBJECT_STORAGE_NOT_CONFIGURED',
      status: 503
    });
  }
  if (!client) {
    client = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 2
    });
  }
  return client;
}

function safeFilename(value) {
  const basename = String(value || 'source-file').replace(/\\/g, '/').split('/').pop() || 'source-file';
  return basename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'source-file';
}

function safeDiagnosticValue(value, fallback = 'unknown') {
  const text = String(value || '');
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(text) ? text : fallback;
}

function storageError(error, operation) {
  const safe = sanitizeStorageProviderError(error);
  const errorType = safeDiagnosticValue(error?.constructor?.name);
  const httpStatus = Number(error?.$metadata?.httpStatusCode);
  const status = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : 'unknown';
  console.error(`[OBJECT_STORAGE] operation=${operation} errorType=${errorType} httpStatus=${status}`);
  return Object.assign(new Error(safe.message), { code: safe.code, status: safe.status });
}

export async function createSourceUpload({ filename, contentType, sizeBytes, contentHash }) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw Object.assign(new Error('A positive source file size is required.'), { code: 'SOURCE_FILE_SIZE_INVALID', status: 400 });
  }
  if (!/^[a-f0-9]{64}$/i.test(String(contentHash || ''))) {
    throw Object.assign(new Error('A SHA-256 source file hash is required.'), { code: 'SOURCE_FILE_HASH_INVALID', status: 400 });
  }
  try {
    const key = `source-uploads/${storageTarget.fingerprint}/${randomUUID()}/${safeFilename(filename)}`;
    const expiresIn = Math.max(60, Math.min(900, Number.parseInt(process.env.OBJECT_STORAGE_PRESIGN_TTL_SECONDS || '900', 10) || 900));
    const headers = {
      'Content-Type': contentType || 'application/octet-stream',
      'x-amz-meta-content-sha256': String(contentHash).toLowerCase()
    };
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: headers['Content-Type'],
      Metadata: { 'content-sha256': String(contentHash).toLowerCase() }
    });
    const uploadUrl = await getSignedUrl(getClient(), command, { expiresIn });
    return { uploadUrl, storageKey: key, headers, expiresIn };
  } catch (error) {
    if (error?.code === 'OBJECT_STORAGE_NOT_CONFIGURED' && error?.message === 'Private object storage is not configured.') throw error;
    throw storageError(error, 'presign');
  }
}

export async function verifySourceObject({ storageKey, sizeBytes, contentHash }) {
  assertSourceObjectTarget(storageKey);
  try {
    const result = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
    const actualHash = result.Metadata?.['content-sha256'];
    if (Number(result.ContentLength) !== Number(sizeBytes) || actualHash !== String(contentHash).toLowerCase()) {
      throw Object.assign(new Error('The object size or content hash does not match the import request.'), { code: 'SOURCE_OBJECT_MISMATCH', status: 409 });
    }
    return {
      sizeBytes: Number(result.ContentLength),
      etag: result.ETag || null,
      contentType: result.ContentType || null
    };
  } catch (error) {
    if (error?.code === 'SOURCE_OBJECT_MISMATCH') throw error;
    throw storageError(error, 'verify');
  }
}

function ownershipError(status) {
  const mapping = {
    INVALID: ['SOURCE_STORAGE_KEY_INVALID', 'The source object key is outside the generated upload format.', 400],
    MISMATCH: ['OBJECT_STORAGE_TARGET_MISMATCH', 'The source object belongs to a different storage target.', 409],
    WRONG_DATASET: ['SOURCE_OBJECT_OWNERSHIP_MISMATCH', 'The source object is not uniquely associated with this dataset.', 409],
    CONTENT_MISMATCH: ['SOURCE_OBJECT_CONTENT_MISMATCH', 'The source object does not match this dataset stored size and hash.', 409],
    UNVERIFIED: ['SOURCE_OBJECT_OWNERSHIP_UNVERIFIED', 'Source object ownership could not be verified; dataset records were preserved.', 503],
    MISSING: ['OBJECT_STORAGE_NOT_CONFIGURED', 'Private source-file storage is not configured.', 503]
  };
  const [code, message, httpStatus] = mapping[status] || mapping.UNVERIFIED;
  return Object.assign(new Error(message), { code, status: httpStatus });
}

export async function verifyDatasetSourceObjectOwnership(dataset, datasetReferences) {
  if (!dataset?.storage_key) return null;
  assertSourceObjectTarget(dataset.storage_key);
  const datasetId = String(dataset.id ?? '');
  const referenceRows = Array.isArray(datasetReferences) ? datasetReferences : [];
  const sameKeyReferences = referenceRows.filter(row => row?.storage_key === dataset.storage_key);
  if (sameKeyReferences.length !== 1) {
    throw ownershipError('WRONG_DATASET');
  }

  let objectMetadata;
  try {
    objectMetadata = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: dataset.storage_key }));
  } catch (error) {
    if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
      objectMetadata = null;
    } else {
      throw storageError(error, 'ownership_check');
    }
  }
  const ownership = inspectDatasetStorageOwnership(dataset, referenceRows, storageTarget, objectMetadata);
  if (ownership.status !== 'MATCH') throw ownershipError(ownership.status);
  const proof = Object.freeze({});
  ownershipProofs.set(proof, { storageKey: dataset.storage_key, datasetId, objectAbsent: ownership.objectAbsent === true });
  return proof;
}

export async function deleteSourceObject(dataset, ownershipProof = null) {
  const storageKey = dataset?.storage_key;
  if (!storageKey) return { deleted: false, reason: 'NO_STORAGE_KEY' };
  assertSourceObjectTarget(storageKey);
  const proof = ownershipProof && ownershipProofs.get(ownershipProof);
  if (!proof || proof.storageKey !== storageKey || proof.datasetId !== String(dataset.id ?? '')) throw ownershipError('UNVERIFIED');
  if (proof.objectAbsent) return { deleted: true, alreadyAbsent: true, storageKey };
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    return { deleted: true, storageKey };
  } catch (error) {
    throw storageError(error, 'delete');
  }
}
