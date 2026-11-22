import assert from 'node:assert/strict';
import { prepareDatasetSourceObjectCleanup } from '../api/_dataset-storage-cleanup.js';
import { filterDatasetStateVersion, nextDatasetStateVersion } from '../api/_dataset-state-version.js';

const key = `source-uploads/${'a'.repeat(64)}/123e4567-e89b-42d3-a456-426614174000/source.csv`;
const dataset = {
  id: 73,
  storage_key: key,
  content_hash: 'b'.repeat(64),
  original_size_bytes: 456,
  updated_at: '2026-10-20T00:00:00.000Z',
  detected_entities: { pipeline: { status: 'COMPLETED', token: 'kept' } }
};
const referenceRows = [{ id: 73, storage_key: key }];

function makeClient({ updateResult = { data: { id: 73 }, error: null } } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, 'datasets');
      const query = {
        select(columns) { calls.push({ type: 'select', columns }); return this; },
        update(values) { calls.push({ type: 'update', values }); return this; },
        eq(column, value) { calls.push({ type: 'eq', column, value }); return this; },
        async maybeSingle() { return updateResult; }
      };
      return query;
    }
  };
}

const client = makeClient();
const mutableDataset = structuredClone(dataset);
const proof = Object.freeze({ verified: true });
const prepared = await prepareDatasetSourceObjectCleanup(
  client,
  mutableDataset,
  referenceRows,
  async (candidate, references) => {
    assert.equal(candidate.id, 73);
    assert.deepEqual(references, referenceRows);
    return proof;
  }
);
assert.equal(prepared.proof, proof);
assert.equal(prepared.marker.status, 'PENDING');
assert.equal(prepared.marker.storageKey, key);
assert.equal(mutableDataset.detected_entities.sourceObjectCleanup.status, 'PENDING');
assert.equal(mutableDataset.detected_entities.pipeline.token, 'kept');
assert.equal(client.calls.some(call => call.type === 'update'), true);
assert.equal(client.calls.some(call => call.type === 'eq' && call.column === 'storage_key' && call.value === key), true);
assert.equal(client.calls.some(call => call.type === 'eq' && call.column === 'updated_at' && call.value === dataset.updated_at), true);

let writesAfterFailedVerification = 0;
const failedClient = makeClient();
await assert.rejects(
  prepareDatasetSourceObjectCleanup(failedClient, dataset, referenceRows, async () => {
    throw Object.assign(new Error('ownership check failed'), { code: 'SOURCE_OBJECT_OWNERSHIP_UNVERIFIED' });
  }),
  error => error.code === 'SOURCE_OBJECT_OWNERSHIP_UNVERIFIED'
);
writesAfterFailedVerification = failedClient.calls.filter(call => call.type === 'update').length;
assert.equal(writesAfterFailedVerification, 0);

const conflictClient = makeClient({ updateResult: { data: null, error: null } });
await assert.rejects(
  prepareDatasetSourceObjectCleanup(conflictClient, structuredClone(dataset), referenceRows, async () => proof),
  error => error.code === 'SOURCE_OBJECT_OWNERSHIP_CHANGED'
);

class VersionedDatasetClient {
  constructor(row) { this.row = row; }
  from(table) {
    assert.equal(table, 'datasets');
    const query = { filters: [], payload: null };
    query.update = payload => { query.payload = payload; return query; };
    query.eq = (column, value) => { query.filters.push({ column, value, isNull: false }); return query; };
    query.is = (column, value) => { query.filters.push({ column, value, isNull: true }); return query; };
    query.select = () => query;
    query.maybeSingle = async () => {
      const matches = query.filters.every(filter => {
        const value = this.row[filter.column];
        return filter.isNull ? value == null : String(value) === String(filter.value);
      });
      if (!matches) return { data: null, error: null };
      Object.assign(this.row, structuredClone(query.payload));
      return { data: { id: this.row.id, updated_at: this.row.updated_at }, error: null };
    };
    return query;
  }
}

const staleSnapshot = structuredClone(dataset);
staleSnapshot.updated_at = '2026-10-20T00:00:00.000Z';
const guardedRow = {
  ...structuredClone(staleSnapshot),
  updated_at: '2026-10-21T00:00:00.000Z',
  detected_entities: {
    ...structuredClone(staleSnapshot.detected_entities),
    sourceObjectCleanup: {
      status: 'PENDING', datasetId: '73', storageKey: key,
      contentHash: 'b'.repeat(64), originalSizeBytes: 456, verifiedAt: '2026-10-21T00:00:00.000Z'
    },
    retentionCleanup: { status: 'RUNNING', token: 'active-retention', ownerToken: 'active-global' }
  }
};
const guardedClient = new VersionedDatasetClient(guardedRow);
await assert.rejects(
  prepareDatasetSourceObjectCleanup(guardedClient, staleSnapshot, referenceRows, async () => proof),
  error => error.code === 'SOURCE_OBJECT_OWNERSHIP_CHANGED'
);
assert.equal(guardedRow.detected_entities.sourceObjectCleanup.status, 'PENDING');
assert.equal(guardedRow.detected_entities.retentionCleanup.token, 'active-retention');

const staleNormalEntities = structuredClone(staleSnapshot.detected_entities);
const staleNormalVersion = nextDatasetStateVersion(staleSnapshot.updated_at);
let staleNormalWrite = guardedClient.from('datasets').update({ detected_entities: staleNormalEntities, updated_at: staleNormalVersion }).eq('id', 73);
staleNormalWrite = filterDatasetStateVersion(staleNormalWrite, staleSnapshot.updated_at);
assert.equal((await staleNormalWrite.select('id').maybeSingle()).data, null);
assert.equal(guardedRow.detected_entities.sourceObjectCleanup.status, 'PENDING');
assert.equal(guardedRow.detected_entities.retentionCleanup.token, 'active-retention');

console.log('Offline storage cleanup safety checks passed.');
