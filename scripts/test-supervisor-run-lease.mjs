import assert from 'node:assert/strict';
import {
  claimSupervisorPipelineRun,
  createSupervisorRunLease,
  decideSupervisorRun,
  inspectSupervisorRunLease,
  SUPERVISOR_RUN_LEASE_TTL_MS
} from '../api/_supervisor-run-lease.js';

const timestamp = '2026-10-20T00:00:00.000Z';
const oldPipelineToken = '00000000-0000-4000-8000-000000000001';
const oldOwnerToken = '00000000-0000-4000-8000-000000000002';

function pathValue(object, path) {
  return String(path).split(/->>?/).filter(Boolean).reduce((value, key) => value?.[key], object);
}

class FakeDatasetClient {
  constructor(row) {
    this.row = structuredClone(row);
    this.updateCalls = 0;
  }

  from(table) {
    assert.equal(table, 'datasets');
    const query = { filters: [], payload: null };
    query.update = payload => { query.payload = structuredClone(payload); return query; };
    query.eq = (column, value) => { query.filters.push({ column, operator: 'eq', value }); return query; };
    query.is = (column, value) => { query.filters.push({ column, operator: 'is', value }); return query; };
    query.filter = (column, operator, value) => { query.filters.push({ column, operator, value }); return query; };
    query.select = () => query;
    query.maybeSingle = async () => {
      this.updateCalls++;
      const matches = query.filters.every(({ column, operator, value }) => {
        if (column === 'updated_at' && operator === 'eq') return this.row.updated_at === value;
        if (column === 'updated_at' && operator === 'is') return this.row.updated_at == null;
        if (column === 'id' && operator === 'eq') return String(this.row.id) === String(value);
        const actual = pathValue(this.row, column);
        if (operator === 'is') return actual == null;
        if (operator === 'eq') return String(actual) === String(value);
        if (operator === 'lte') return typeof actual === 'string' && actual <= value;
        return false;
      });
      if (!matches) return { data: null, error: null };
      Object.assign(this.row, query.payload);
      return { data: { id: this.row.id, updated_at: this.row.updated_at }, error: null };
    };
    return query;
  }
}

function runningRow(now) {
  return {
    id: 41,
    updated_at: timestamp,
    analysis_status: 'RUNNING',
    analysis_completed_at: null,
    detected_entities: {
      import: { status: 'COMPLETED' },
      retained: { keep: true },
      pipeline: {
        token: oldPipelineToken,
        status: 'RUNNING',
        updatedAt: timestamp,
        stages: { DATASET_VALIDATION: { status: 'COMPLETED' } },
        lease: createSupervisorRunLease(oldOwnerToken, oldPipelineToken, now)
      }
    }
  };
}

const initialNow = Date.parse(timestamp);
const activeNow = initialNow + 1_000;
const activePipeline = runningRow(initialNow).detected_entities.pipeline;
const activeDecision = decideSupervisorRun(activePipeline, true, activeNow);
assert.equal(activeDecision.action, 'DENY_ACTIVE', 'retry must not take over an active worker');
assert.equal(inspectSupervisorRunLease(activePipeline, activeNow).status, 'ACTIVE');
const activeRow = runningRow(initialNow);
const activeClient = new FakeDatasetClient(activeRow);
const activeAttempt = await claimSupervisorPipelineRun(activeClient, {
  datasetId: activeRow.id,
  currentEntities: structuredClone(activeRow.detected_entities),
  pipeline: { token: '00000000-0000-4000-8000-000000000009', status: 'RUNNING', stages: {} },
  previous: activeRow.detected_entities.pipeline,
  expectedUpdatedAt: activeRow.updated_at,
  currentDataset: activeRow,
  retry: true,
  now: activeNow
});
assert.equal(activeAttempt.decision.action, 'DENY_ACTIVE');
assert.equal(activeAttempt.claimed, null);
assert.equal(activeClient.updateCalls, 0, 'denying an active takeover does not write dataset state');
assert.deepEqual(activeClient.row, activeRow);

const expiredNow = initialNow + SUPERVISOR_RUN_LEASE_TTL_MS + 1;
const expiredRow = runningRow(initialNow);
const expiredDecision = decideSupervisorRun(expiredRow.detected_entities.pipeline, true, expiredNow);
assert.equal(expiredDecision.action, 'RECOVER_EXPIRED', 'a valid expired lease permits an explicit recovery attempt');

const recoveredToken = '00000000-0000-4000-8000-000000000003';
const recoveredOwner = '00000000-0000-4000-8000-000000000004';
const recoveredPipeline = {
  token: recoveredToken,
  status: 'RUNNING',
  updatedAt: new Date(expiredNow).toISOString(),
  lease: createSupervisorRunLease(recoveredOwner, recoveredToken, expiredNow),
  stages: {}
};
const recoveryClient = new FakeDatasetClient(expiredRow);
const recoveryAttempt = await claimSupervisorPipelineRun(recoveryClient, {
  datasetId: expiredRow.id,
  currentEntities: structuredClone(expiredRow.detected_entities),
  pipeline: recoveredPipeline,
  previous: expiredRow.detected_entities.pipeline,
  expectedUpdatedAt: expiredRow.updated_at,
  currentDataset: expiredRow,
  retry: true,
  now: expiredNow
});
assert.equal(recoveryAttempt.decision.action, 'RECOVER_EXPIRED');
assert.ok(recoveryAttempt.claimed, 'valid expired lease can be atomically reclaimed');
assert.equal(recoveryClient.row.detected_entities.pipeline.token, recoveredToken);
assert.equal(recoveryClient.row.detected_entities.retained.keep, true, 'unrelated metadata remains intact');

const competingRow = runningRow(initialNow);
const competitorA = {
  token: '00000000-0000-4000-8000-000000000005', status: 'RUNNING',
  updatedAt: new Date(expiredNow).toISOString(),
  lease: createSupervisorRunLease('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000005', expiredNow),
  stages: {}
};
const competitorB = {
  token: '00000000-0000-4000-8000-000000000007', status: 'RUNNING',
  updatedAt: new Date(expiredNow).toISOString(),
  lease: createSupervisorRunLease('00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000007', expiredNow),
  stages: {}
};
const competingClient = new FakeDatasetClient(competingRow);
const claimArgs = pipeline => claimSupervisorPipelineRun(competingClient, {
  datasetId: competingRow.id,
  currentEntities: structuredClone(competingRow.detected_entities),
  pipeline,
  previous: competingRow.detected_entities.pipeline,
  expectedUpdatedAt: competingRow.updated_at,
  currentDataset: competingRow,
  retry: true,
  now: expiredNow
});
const competingResults = await Promise.all([claimArgs(competitorA), claimArgs(competitorB)]);
assert.equal(competingResults.filter(result => result.claimed).length, 1, 'only one of two recovery claims may win the dataset version CAS');

const missingLeasePipeline = { ...activePipeline, lease: undefined };
assert.equal(decideSupervisorRun(missingLeasePipeline, true, expiredNow).action, 'DENY_UNVERIFIED');
const ambiguousLeasePipeline = {
  ...activePipeline,
  lease: { ...activePipeline.lease, pipelineToken: '00000000-0000-4000-8000-000000000099' }
};
assert.equal(decideSupervisorRun(ambiguousLeasePipeline, true, expiredNow).action, 'DENY_UNVERIFIED');
const malformedDatePipeline = {
  ...activePipeline,
  lease: { ...activePipeline.lease, expiresAt: 'not-a-timestamp' }
};
assert.equal(decideSupervisorRun(malformedDatePipeline, true, expiredNow).action, 'DENY_UNVERIFIED');
const legacyRow = { ...activeRow, detected_entities: { ...activeRow.detected_entities, pipeline: missingLeasePipeline } };
const legacyClient = new FakeDatasetClient(legacyRow);
const legacyAttempt = await claimSupervisorPipelineRun(legacyClient, {
  datasetId: legacyRow.id,
  currentEntities: structuredClone(legacyRow.detected_entities),
  pipeline: { token: '00000000-0000-4000-8000-000000000010', status: 'RUNNING', stages: {} },
  previous: missingLeasePipeline,
  expectedUpdatedAt: legacyRow.updated_at,
  currentDataset: legacyRow,
  retry: true,
  now: expiredNow
});
assert.equal(legacyAttempt.decision.action, 'DENY_UNVERIFIED');
assert.equal(legacyAttempt.claimed, null);
assert.equal(legacyClient.updateCalls, 0, 'legacy or ambiguous lease states are left untouched');
const ambiguousRow = { ...activeRow, detected_entities: { ...activeRow.detected_entities, pipeline: ambiguousLeasePipeline } };
const ambiguousClient = new FakeDatasetClient(ambiguousRow);
const ambiguousAttempt = await claimSupervisorPipelineRun(ambiguousClient, {
  datasetId: ambiguousRow.id,
  currentEntities: structuredClone(ambiguousRow.detected_entities),
  pipeline: { token: '00000000-0000-4000-8000-000000000013', status: 'RUNNING', stages: {} },
  previous: ambiguousLeasePipeline,
  expectedUpdatedAt: ambiguousRow.updated_at,
  currentDataset: ambiguousRow,
  retry: true,
  now: expiredNow
});
assert.equal(ambiguousAttempt.decision.action, 'DENY_UNVERIFIED');
assert.equal(ambiguousAttempt.claimed, null);
assert.equal(ambiguousClient.updateCalls, 0, 'ambiguous lease state is left unchanged');

const completedPipeline = { token: oldPipelineToken, status: 'COMPLETED', stages: { FINAL_RESULTS: { status: 'COMPLETED' } } };
assert.equal(decideSupervisorRun(completedPipeline, false, expiredNow).action, 'RETURN_COMPLETED', 'normal successful repeat requests retain their completed response path');
assert.equal(decideSupervisorRun(null, false, expiredNow).action, 'START_NEW', 'a fresh successful run retains the normal claim path');
const freshClient = new FakeDatasetClient({ id: 42, updated_at: timestamp, detected_entities: {}, analysis_status: 'NOT_STARTED' });
const freshToken = '00000000-0000-4000-8000-000000000011';
const freshOwner = '00000000-0000-4000-8000-000000000012';
const freshRow = freshClient.row;
const freshClaim = await claimSupervisorPipelineRun(freshClient, {
  datasetId: freshRow.id,
  currentEntities: {},
  pipeline: {
    token: freshToken,
    status: 'RUNNING',
    updatedAt: timestamp,
    lease: createSupervisorRunLease(freshOwner, freshToken, expiredNow),
    stages: {}
  },
  expectedUpdatedAt: freshRow.updated_at,
  currentDataset: freshRow,
  retry: false,
  now: expiredNow
});
assert.equal(freshClaim.decision.action, 'START_NEW');
assert.ok(freshClaim.claimed, 'a fresh pipeline still follows its normal successful claim path');

console.log('Supervisor run lease offline checks passed.');
