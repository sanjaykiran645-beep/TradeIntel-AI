import assert from 'node:assert/strict';
import {
  assertDatabaseTargetConsistency,
  inspectDatabaseTargetConsistency,
  selectedDatabaseTargetSources
} from '../api/_database-target.js';
import {
  assertStorageKeyTarget,
  inspectDatasetStorageOwnership,
  inspectStorageKeyTarget,
  resolveStorageConfiguration,
  sanitizeStorageProviderError,
  storageTargetFingerprint
} from '../api/_storage-target.js';

const apiUrl = 'postgresql://db-a.example.test:5432/tradeintel';
const matchingTargets = {
  DATABASE_URL: apiUrl,
  DATABASE_DIRECT_URL: 'postgresql://db-a.example.test:5432/tradeintel?sslmode=verify-full',
  PYTHON_DATABASE_URL: 'postgresql://db-a.example.test/tradeintel'
};

assert.equal(inspectDatabaseTargetConsistency(matchingTargets).status, 'MATCH');
assert.doesNotThrow(() => assertDatabaseTargetConsistency(matchingTargets));

assert.deepEqual(selectedDatabaseTargetSources({
  DATABASE_URL: apiUrl,
  DATABASE_DIRECT_URL: 'postgresql://direct.example.test/tradeintel',
  PYTHON_DATABASE_URL: 'postgresql://python.example.test/tradeintel'
}), {
  node: 'DATABASE_URL',
  python: 'PYTHON_DATABASE_URL',
  migration: 'DATABASE_DIRECT_URL'
});
assert.deepEqual(selectedDatabaseTargetSources({
  DATABASE_URL: apiUrl,
  DATABASE_DIRECT_URL: 'postgresql://direct.example.test/tradeintel'
}), {
  node: 'DATABASE_URL',
  python: 'DATABASE_DIRECT_URL',
  migration: 'DATABASE_DIRECT_URL'
});

assert.equal(inspectDatabaseTargetConsistency({
  DATABASE_URL: apiUrl,
  DATABASE_DIRECT_URL: 'postgresql://db-a.example.test:5432/otherdb'
}).status, 'MISMATCH');
assert.throws(() => assertDatabaseTargetConsistency({
  DATABASE_URL: apiUrl,
  DATABASE_DIRECT_URL: 'postgresql://db-a.example.test:5432/otherdb'
}), error => error.code === 'DATABASE_TARGET_MISMATCH');

assert.equal(inspectDatabaseTargetConsistency({
  DATABASE_URL: apiUrl,
  DATABASE_DIRECT_URL: 'postgresql://pool.example.test:6432/tradeintel'
}).status, 'UNVERIFIED');
assert.equal(inspectDatabaseTargetConsistency({
  DATABASE_URL: apiUrl,
  DATABASE_DIRECT_URL: 'postgresql://db-a.example.test/tradeintel?host=override.example.test&port=6432'
}).status, 'UNVERIFIED');
assert.equal(inspectDatabaseTargetConsistency({
  DATABASE_URL: apiUrl,
  PYTHON_DATABASE_URL: 'postgresql://db-a.example.test:5432/tradeintel?hostaddr=10.0.0.2'
}).status, 'UNVERIFIED');
assert.equal(inspectDatabaseTargetConsistency({
  DATABASE_URL: apiUrl,
  PYTHON_DATABASE_URL: apiUrl,
  PGHOSTADDR: '10.0.0.2'
}).status, 'UNVERIFIED');
assert.equal(inspectDatabaseTargetConsistency({
  DATABASE_URL: apiUrl,
  DATABASE_DIRECT_URL: 'postgresql://pool.example.test:6432/tradeintel',
  DATABASE_URL_TARGET_ID: 'same-database',
  DATABASE_DIRECT_URL_TARGET_ID: 'same-database'
}).status, 'UNVERIFIED');
assert.equal(inspectDatabaseTargetConsistency({
  DATABASE_URL: apiUrl,
  DATABASE_DIRECT_URL: 'postgresql://pool.example.test:6432/tradeintel',
  DATABASE_URL_TARGET_ID: 'database-a',
  DATABASE_DIRECT_URL_TARGET_ID: 'database-b'
}).status, 'MISMATCH');
assert.equal(inspectDatabaseTargetConsistency({
  DATABASE_URL: apiUrl,
  DATABASE_DIRECT_URL: 'postgresql://db-a.example.test/tradeintel',
  DATABASE_URL_TARGET_ID: 'same-database',
  DATABASE_DIRECT_URL_TARGET_ID: 'same-database'
}).status, 'MATCH');
assert.equal(inspectDatabaseTargetConsistency({
  DATABASE_URL: apiUrl,
  DATABASE_DIRECT_URL: 'postgresql://pool.example.test:6432/otherdb',
  DATABASE_URL_TARGET_ID: 'same-database',
  DATABASE_DIRECT_URL_TARGET_ID: 'same-database'
}).status, 'MISMATCH');
assert.equal(inspectDatabaseTargetConsistency({
  DATABASE_URL: 'postgresql://[2001:0db8:0:0:0:0:0:1]/tradeintel',
  DATABASE_DIRECT_URL: 'postgresql://[2001:db8::1]:5432/tradeintel'
}).status, 'MATCH');
assert.equal(inspectDatabaseTargetConsistency({
  DATABASE_URL: apiUrl,
  DATABASE_DIRECT_URL: 'postgresql://db-a.example.test/trade%2Fintele'
}).status, 'UNVERIFIED');

assert.equal(inspectDatabaseTargetConsistency({ DATABASE_URL: 'not-a-postgres-url' }).status, 'UNVERIFIED');
assert.throws(() => assertDatabaseTargetConsistency({}), error => error.code === 'DATABASE_TARGET_MISSING');
assert.equal(inspectDatabaseTargetConsistency({}).status, 'MISSING');

const originalStorageTarget = storageTargetFingerprint('https://storage.example.test/', 'tradeintel-files');
const normalizedStorageTarget = storageTargetFingerprint('https://storage.example.test', 'tradeintel-files');
assert.equal(originalStorageTarget.status, 'VERIFIED');
assert.equal(originalStorageTarget.fingerprint, normalizedStorageTarget.fingerprint);
assert.equal(storageTargetFingerprint('', 'tradeintel-files').status, 'MISSING');
assert.equal(storageTargetFingerprint('not-a-url', 'tradeintel-files').status, 'UNVERIFIED');
assert.equal(storageTargetFingerprint('https://storage.example.test/?route=private', 'tradeintel-files').status, 'UNVERIFIED');
assert.equal(resolveStorageConfiguration({ endpoint: 'https://storage.example.test', bucket: 'tradeintel-files' }).status, 'MISSING');

const generatedKey = `source-uploads/${originalStorageTarget.fingerprint}/123e4567-e89b-42d3-a456-426614174000/file.csv`;
assert.equal(inspectStorageKeyTarget(generatedKey, originalStorageTarget).status, 'MATCH');
assert.equal(inspectStorageKeyTarget(`${generatedKey}/extra`, originalStorageTarget).status, 'INVALID');
assert.equal(inspectStorageKeyTarget(`source-uploads/${'0'.repeat(64)}/123e4567-e89b-42d3-a456-426614174000/file.csv`, originalStorageTarget).status, 'MISMATCH');
assert.equal(inspectStorageKeyTarget(generatedKey, storageTargetFingerprint('https://other.example.test', 'tradeintel-files')).status, 'MISMATCH');
assert.equal(inspectStorageKeyTarget(generatedKey, storageTargetFingerprint('https://storage.example.test', 'other-bucket')).status, 'MISMATCH');
assert.equal(inspectStorageKeyTarget('source-uploads/legacy-id/file.csv', originalStorageTarget).status, 'UNVERIFIED');
assert.equal(inspectStorageKeyTarget(generatedKey, storageTargetFingerprint('', '')).status, 'MISSING');
assert.throws(() => assertStorageKeyTarget(generatedKey, storageTargetFingerprint('https://other.example.test', 'tradeintel-files')),
  error => error.code === 'OBJECT_STORAGE_TARGET_MISMATCH');
assert.throws(() => assertStorageKeyTarget('source-uploads/legacy-id/file.csv', originalStorageTarget),
  error => error.code === 'OBJECT_STORAGE_TARGET_UNVERIFIED');

const datasetRow = {
  id: 41,
  storage_key: generatedKey,
  content_hash: 'a'.repeat(64),
  original_size_bytes: 123
};
const storageReferences = [{ id: 41, storage_key: generatedKey }];
const matchingObjectMetadata = { ContentLength: 123, Metadata: { 'content-sha256': 'a'.repeat(64) } };
assert.equal(inspectDatasetStorageOwnership(datasetRow, storageReferences, originalStorageTarget, matchingObjectMetadata).status, 'MATCH');
assert.equal(inspectDatasetStorageOwnership(datasetRow, [{ id: 42, storage_key: generatedKey }], originalStorageTarget, matchingObjectMetadata).status, 'WRONG_DATASET');
assert.equal(inspectDatasetStorageOwnership(datasetRow, [...storageReferences, { id: 42, storage_key: generatedKey }], originalStorageTarget, matchingObjectMetadata).status, 'WRONG_DATASET');
assert.equal(inspectDatasetStorageOwnership(datasetRow, storageReferences, originalStorageTarget, { ContentLength: 123, Metadata: { 'content-sha256': 'b'.repeat(64) } }).status, 'CONTENT_MISMATCH');
const pendingDatasetRow = {
  ...datasetRow,
  detected_entities: { sourceObjectCleanup: {
    status: 'PENDING', datasetId: '41', storageKey: generatedKey,
    contentHash: 'a'.repeat(64), originalSizeBytes: 123
  } }
};
assert.deepEqual(inspectDatasetStorageOwnership(pendingDatasetRow, storageReferences, originalStorageTarget, null), { status: 'MATCH', objectAbsent: true });
assert.equal(inspectDatasetStorageOwnership(datasetRow, storageReferences, originalStorageTarget, null).status, 'UNVERIFIED');

const sanitizedProviderError = sanitizeStorageProviderError({
  name: 'Error',
  code: 'SomeProviderError',
  message: 'request failed with sensitive connection details'
});
assert.equal(sanitizedProviderError.code, 'OBJECT_STORAGE_ERROR');
assert.equal(sanitizedProviderError.message.includes('sensitive'), false);

console.log('Offline database and storage target checks passed.');
