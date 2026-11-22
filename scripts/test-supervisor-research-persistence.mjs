import assert from 'node:assert/strict';
import { persistSupervisorResearch } from '../api/_supervisor-research-persistence.js';

const datasetId = 'offline-dataset';
const companyId = 'offline-company';
const researchResult = { status: 'COMPLETED', source: 'deterministic-offline-stub', summary: 'Synthetic result.' };

function createHarness(writeResult) {
  const calls = { provider: [], upsert: [] };
  const provider = {
    async performResearch(...args) {
      calls.provider.push(args);
      return { data: researchResult };
    }
  };
  const database = {
    from(table) {
      assert.equal(table, 'web_research');
      return {
        async upsert(row, options) {
          calls.upsert.push({ row, options });
          return writeResult;
        }
      };
    }
  };
  return { calls, database, provider };
}

{
  const writeError = { code: 'OFFLINE_WRITE_FAILURE' };
  const harness = createHarness({ error: writeError });
  let processed = 0;
  let caughtError;

  try {
    processed += await persistSupervisorResearch({
      database: harness.database,
      provider: harness.provider,
      datasetId,
      companyId
    });
  } catch (error) {
    caughtError = error;
  }

  assert.equal(caughtError, writeError, 'returned database errors must propagate');
  assert.equal(processed, 0, 'failed persistence must not increment processed count');
  assert.equal(harness.calls.upsert.length, 1);
}

{
  const harness = createHarness({ error: null });
  const processed = await persistSupervisorResearch({
    database: harness.database,
    provider: harness.provider,
    datasetId,
    companyId
  });

  assert.equal(processed, 1, 'successful persistence contributes one processed item');
  assert.deepEqual(harness.calls.provider, [[datasetId, { id: companyId, name: '' }]]);
  assert.equal(harness.calls.upsert.length, 1);
  assert.deepEqual(harness.calls.upsert[0].row, {
    dataset_id: datasetId,
    company_id: companyId,
    result: researchResult,
    updated_at: harness.calls.upsert[0].row.updated_at
  });
  assert.equal(Number.isNaN(Date.parse(harness.calls.upsert[0].row.updated_at)), false);
  assert.deepEqual(harness.calls.upsert[0].options, { onConflict: 'dataset_id,company_id' });
}

for (const data of [
  { status: 'FAILED', reason: 'provider error' },
  { status: 'NOT_CONFIGURED' },
  { status: 'UNRECOGNIZED' }
]) {
  const harness = createHarness({ error: null });
  harness.provider.performResearch = async () => ({ data });
  await assert.rejects(() => persistSupervisorResearch({
    database: harness.database,
    provider: harness.provider,
    datasetId,
    companyId
  }), /completed result/i);
  assert.equal(harness.calls.upsert.length, 0, `${data.status} must not be persisted as successful research`);
}

console.log('Supervisor research persistence offline regression passed.');
