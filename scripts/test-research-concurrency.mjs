import assert from 'node:assert/strict';
import {
  createTimestampPairDiagnostic,
  matchTimestampAttempt,
  timestampEpochMillis
} from './_research-concurrency-test-utils.mjs';
import { startTestAuthServer, TEST_ADMIN_TOKEN, TEST_ADMIN_USER_ID } from './_test-auth-server.mjs';

const authServer = await startTestAuthServer();
const testEnvironment = {
  NODE_ENV: 'development',
  RESEARCH_API_KEY: 'offline-regression-test-key',
  SUPABASE_AUTH_URL: authServer.url,
  SUPABASE_AUTH_ANON_KEY: 'offline-regression-test-anon-key',
  ADMIN_SUPABASE_USER_ID: TEST_ADMIN_USER_ID
};
const previousEnvironment = Object.fromEntries(
  Object.keys(testEnvironment).map(key => [key, process.env[key]])
);
for (const [key, value] of Object.entries(testEnvironment)) process.env[key] = value;

let database;
let researchProvider;
let tavily;
let originalDatabaseFrom;
let originalResearchProvider;
let originalTavilySearch;

function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function createFakeDatabase() {
  const state = {
    datasets: [{
      id: 41,
      import_status: 'COMPLETED',
      detected_entities: {},
      analysis_status: 'NOT_STARTED',
      analysis_completed_at: null
    }],
    companies: [{ id: 73, dataset_id: 41, name: 'Concurrency Fixture Co' }],
    webResearch: [],
    legacyReadCount: 0,
    legacyReadBarrier: barrier(),
    conflictTargets: [],
    writes: [],
    upsertAttempts: [],
    upsertCompletionOrder: [],
    secondRequestWriteComplete: barrier()
  };

  function matches(row, filters) {
    return filters.every(({ column, operator, value }) => {
      if (column === 'detected_entities->pipeline->>updatedAt') {
        const actual = row.detected_entities?.pipeline?.updatedAt ?? null;
        return operator === 'is' ? actual === value : actual === value;
      }
      const actual = row[column];
      if (operator === 'is') return actual === value;
      return actual === value || String(actual) === String(value);
    });
  }

  function singleResult(rows, singleMode) {
    if (singleMode === 'maybeSingle') return rows[0] ?? null;
    if (singleMode === 'single') return rows[0] ?? null;
    return rows;
  }

  class FakeQuery {
    constructor(table) {
      this.table = table;
      this.action = 'select';
      this.values = null;
      this.filters = [];
      this.singleMode = null;
      this.onConflict = null;
    }

    select() { return this; }
    eq(column, value) { this.filters.push({ column, operator: 'eq', value }); return this; }
    is(column, value) { this.filters.push({ column, operator: 'is', value }); return this; }
    filter(column, operator, value) { this.filters.push({ column, operator, value }); return this; }
    order() { return this; }
    limit() { return this; }
    maybeSingle() { this.singleMode = 'maybeSingle'; return this; }
    single() { this.singleMode = 'single'; return this; }
    insert(rows) { this.action = 'insert'; this.values = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows, options = {}) {
      this.action = 'upsert';
      this.values = Array.isArray(rows) ? rows : [rows];
      this.onConflict = options.onConflict;
      return this;
    }
    update(values) { this.action = 'update'; this.values = values; return this; }

    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }

    async execute() {
      if (this.table === 'datasets' && this.action === 'select') {
        const rows = state.datasets.filter(row => matches(row, this.filters));
        return { data: clone(singleResult(rows, this.singleMode)), error: null };
      }
      if (this.table === 'companies' && this.action === 'select') {
        const rows = state.companies.filter(row => matches(row, this.filters));
        return { data: clone(singleResult(rows, this.singleMode)), error: null };
      }
      if (this.table === 'system_settings' && this.action === 'select') {
        return { data: null, error: null };
      }
      if (this.table === 'web_research' && this.action === 'select') {
        const rows = state.webResearch.filter(row => matches(row, this.filters));
        const isLegacyExistenceCheck = this.filters.some(filter => filter.column === 'dataset_id') &&
          this.filters.some(filter => filter.column === 'company_id');
        if (isLegacyExistenceCheck) {
          // Snapshot before the barrier: both old check-then-insert callers see the same empty state.
          const snapshot = clone(singleResult(rows, this.singleMode));
          state.legacyReadCount++;
          const wave = state.legacyReadBarrier;
          if (state.legacyReadCount % 2 === 0) {
            wave.release();
            state.legacyReadBarrier = barrier();
          }
          await wave.promise;
          return { data: snapshot, error: null };
        }
        return { data: clone(singleResult(rows, this.singleMode)), error: null };
      }
      if (this.table === 'web_research' && this.action === 'insert') {
        const row = clone(this.values[0]);
        const conflict = state.webResearch.some(existing =>
          existing.dataset_id === row.dataset_id && existing.company_id === row.company_id
        );
        if (conflict) {
          return { data: null, error: { code: '23505', status: 500, message: 'Unique research pair already exists.' } };
        }
        row.id = state.webResearch.length + 1;
        state.webResearch.push(row);
        state.writes.push(clone(row));
        return { data: [clone(row)], error: null };
      }
      if (this.table === 'web_research' && this.action === 'upsert') {
        state.conflictTargets.push(this.onConflict);
        const row = clone(this.values[0]);
        state.upsertAttempts.push({ testRequest: row.result?.testRequest, updatedAt: row.updated_at });
        if (row.result?.testRequest === 1) await state.secondRequestWriteComplete.promise;
        const existing = state.webResearch.find(item =>
          item.dataset_id === row.dataset_id && item.company_id === row.company_id
        );
        if (existing) Object.assign(existing, row);
        else {
          row.id = state.webResearch.length + 1;
          state.webResearch.push(row);
        }
        const saved = existing || row;
        state.writes.push(clone(saved));
        state.upsertCompletionOrder.push(row.result?.testRequest);
        if (row.result?.testRequest === 2) state.secondRequestWriteComplete.release();
        return { data: null, error: null };
      }
      if (this.table === 'datasets' && this.action === 'update') {
        const dataset = state.datasets.find(row => matches(row, this.filters));
        if (!dataset) return { data: null, error: null };
        Object.assign(dataset, clone(this.values));
        return { data: singleResult([{ id: dataset.id }], this.singleMode), error: null };
      }
      throw new Error(`Unexpected fake database operation: ${this.action} ${this.table}`);
    }
  }

  return {
    state,
    from(table) { return new FakeQuery(table); }
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; }
  };
}

try {
  ({ default: database } = await import('../api/_db-client.js'));
  ({ default: researchProvider } = await import('../api/_research-provider.js'));
  ({ default: tavily } = await import('../api/providers/_tavily.js'));
  const postgresTypes = (await import('pg')).default.types;
  const { default: researchHandler } = await import('../api/_routes/research.js');

  originalDatabaseFrom = database.from;
  originalResearchProvider = researchProvider.performResearch;
  originalTavilySearch = tavily.search;

  const fakeDatabase = createFakeDatabase();
  database.from = table => fakeDatabase.from(table);

  // Reproduce the old race as a control: both reads snapshot absence before either insert starts.
  const legacyReads = await Promise.all([
    database.from('web_research').select('id').eq('dataset_id', 41).eq('company_id', 73).maybeSingle(),
    database.from('web_research').select('id').eq('dataset_id', 41).eq('company_id', 73).maybeSingle()
  ]);
  assert.deepEqual(legacyReads.map(result => result.data), [null, null]);
  assert.equal(fakeDatabase.state.legacyReadCount, 2);
  const legacyInserts = await Promise.all([
    database.from('web_research').insert({ dataset_id: 41, company_id: 73, result: { legacy: 1 } }),
    database.from('web_research').insert({ dataset_id: 41, company_id: 73, result: { legacy: 2 } })
  ]);
  assert.equal(legacyInserts.filter(result => result.error?.code === '23505').length, 1);
  assert.equal(fakeDatabase.state.webResearch.length, 1);

  // Start the actual handler race from an empty table after the controlled legacy reproduction.
  fakeDatabase.state.webResearch.length = 0;
  fakeDatabase.state.writes.length = 0;
  fakeDatabase.state.upsertAttempts.length = 0;
  fakeDatabase.state.upsertCompletionOrder.length = 0;
  let providerCalls = 0;
  const providerGate = barrier();
  let tavilyCalls = 0;
  researchProvider.performResearch = async () => {
    const sequence = ++providerCalls;
    if (providerCalls === 2) providerGate.release();
    await providerGate.promise;
    return { data: { status: 'COMPLETED', fixture: `research-result-${sequence}`, testRequest: sequence } };
  };
  tavily.search = async () => {
    tavilyCalls++;
    throw new Error('The real Tavily adapter was reached by the offline test.');
  };

  const request = () => ({
    method: 'POST',
    headers: { authorization: 'Bearer ' + TEST_ADMIN_TOKEN },
    query: {},
    body: { datasetId: 41, companyId: 73 }
  });
  const responseA = responseRecorder();
  const responseB = responseRecorder();
  const startedAt = Date.now();
  await Promise.all([
    researchHandler(request(), responseA),
    researchHandler(request(), responseB)
  ]);

  assert.equal(providerCalls, 2, 'both requests must reach the deterministic provider stub');
  assert.equal(tavilyCalls, 0, 'the Tavily adapter must not be called');
  assert.equal(responseA.statusCode, 200, JSON.stringify(responseA.body));
  assert.equal(responseB.statusCode, 200, JSON.stringify(responseB.body));
  assert.equal(responseA.body.success, true);
  assert.equal(responseB.body.success, true);
  assert.notDeepEqual(responseA.body.data, responseB.body.data);
  assert.deepEqual(fakeDatabase.state.conflictTargets, ['dataset_id,company_id', 'dataset_id,company_id']);
  assert.equal(fakeDatabase.state.legacyReadCount, 2, 'the fixed handler must not repeat the old existence check');
  assert.equal(fakeDatabase.state.webResearch.length, 1, 'the pair must have exactly one persisted row');
  const [persistedResearch] = fakeDatabase.state.webResearch;
  assert.equal(persistedResearch.dataset_id, 41);
  assert.equal(persistedResearch.company_id, 73);
  assert.ok(['research-result-1', 'research-result-2'].includes(persistedResearch.result.fixture));
  assert.ok(Number.isFinite(Date.parse(persistedResearch.updated_at)), 'updated_at must be set by each upsert');
  assert.ok(Date.parse(persistedResearch.updated_at) >= startedAt);
  assert.equal(fakeDatabase.state.writes.length, 2, 'both concurrent writes should complete');
  assert.deepEqual(fakeDatabase.state.upsertCompletionOrder, [2, 1], 'writes must complete opposite to request marker order');
  assert.equal(persistedResearch.result.testRequest, fakeDatabase.state.writes.at(-1).result.testRequest);
  assert.equal(persistedResearch.updated_at, fakeDatabase.state.writes.at(-1).updated_at);
  const pairedAttempt = matchTimestampAttempt(fakeDatabase.state.upsertAttempts, persistedResearch.result.testRequest);
  assert.ok(pairedAttempt, 'the persisted result marker must select exactly one upsert attempt');
  assert.equal(pairedAttempt.testRequest, persistedResearch.result.testRequest);
  assert.equal(persistedResearch.result.fixture, `research-result-${pairedAttempt.testRequest}`);
  const pairDiagnostic = createTimestampPairDiagnostic({
    persistedRequest: persistedResearch.result.testRequest,
    persistedUpdatedAt: persistedResearch.updated_at,
    timestampAttempt: pairedAttempt
  });
  assert.equal(pairDiagnostic.differenceMs, 0, 'matching result and timestamp must have zero delta under reversed write order');
  assert.equal(pairDiagnostic.persistedRequestMarker, pairDiagnostic.attemptedRequestMarker);

  researchProvider.performResearch = async () => ({
    data: { status: 'FAILED', reason: 'offline fixture provider failure' },
    requestCount: 3
  });
  const failedResponse = responseRecorder();
  await researchHandler(request(), failedResponse);
  assert.equal(failedResponse.statusCode, 502);
  assert.equal(failedResponse.body.success, false);
  assert.equal(failedResponse.body.status, 'FAILED');
  assert.equal(failedResponse.body.code, 'RESEARCH_PROVIDER_FAILED');
  assert.equal(fakeDatabase.state.webResearch.length, 1, 'provider failure must not be persisted as research evidence');
  assert.equal(fakeDatabase.state.writes.length, 2, 'provider failure must not create a successful research write');

  const driverDate = postgresTypes.getTypeParser(1184)('2026-01-01 00:00:00.007+00');
  const driverDateInput = '2026-01-01T00:00:00.007Z';
  assert.ok(driverDate instanceof Date, 'node-postgres must parse timestamptz as a Date');
  const driverDateDiagnostic = createTimestampPairDiagnostic({
    persistedRequest: 2,
    persistedUpdatedAt: driverDate,
    timestampAttempt: { testRequest: 2, updatedAt: driverDateInput }
  });
  assert.equal(Date.parse(driverDateInput) - Date.parse(driverDate), 7, 'Date.parse(Date) must reproduce the observed loss of fractional seconds');
  assert.equal(timestampEpochMillis(driverDate), Date.parse(driverDateInput), 'Date values must retain millisecond precision via getTime()');
  assert.equal(driverDateDiagnostic.differenceMs, 0, 'a node-postgres Date value must compare at millisecond precision');
  assert.equal(driverDateDiagnostic.persistedUpdatedAt, '2026-01-01T00:00:00.007Z');

  const mismatchDiagnostic = createTimestampPairDiagnostic({
    persistedRequest: 1,
    persistedUpdatedAt: '2026-01-01T00:00:00.010Z',
    timestampAttempt: { testRequest: 1, updatedAt: '2026-01-01T00:00:00.007Z' }
  });
  assert.equal(mismatchDiagnostic.differenceMs, 3, 'diagnostics must preserve a nonzero timestamp mismatch');
  assert.equal(matchTimestampAttempt([
    { testRequest: 1, updatedAt: '2026-01-01T00:00:00.007Z' },
    { testRequest: 1, updatedAt: '2026-01-01T00:00:00.008Z' }
  ], 1), null, 'ambiguous markers must not select an arbitrary attempt');

  console.log('Offline concurrent research persistence regression passed (legacy 23505 race reproduced; reversed upsert order preserved result/timestamp pairing; Tavily calls: 0).');
} finally {
  await authServer.close();
  if (database && originalDatabaseFrom) database.from = originalDatabaseFrom;
  if (researchProvider && originalResearchProvider) researchProvider.performResearch = originalResearchProvider;
  if (tavily && originalTavilySearch) tavily.search = originalTavilySearch;
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
