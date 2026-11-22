import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startTestAuthServer, TEST_ADMIN_TOKEN, TEST_ADMIN_USER_ID } from './_test-auth-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testEnvPath = path.join(root, '.env.test.local');
let testEnvironmentReady = true;
if (!existsSync(testEnvPath)) {
  console.error('TEST_CONFIGURATION_UNAVAILABLE: .env.test.local is required for the synthetic end-to-end test.');
  testEnvironmentReady = false;
} else {
  try {
    process.loadEnvFile(testEnvPath);
  } catch {
    console.error('TEST_CONFIGURATION_UNAVAILABLE: .env.test.local could not be loaded.');
    testEnvironmentReady = false;
  }
}

const expectedTestDatabaseHost = 'ep-hidden-wind-b4x5ff13-pooler.c-6.us-east-2.aws.neon.tech';
const databaseUrl = process.env.DATABASE_URL;
let databaseTargetsTestBranch = false;
try {
  const parsedDatabaseUrl = new URL(databaseUrl);
  const hasHostOverride = [...parsedDatabaseUrl.searchParams.keys()].some(key => ['host', 'hostaddr'].includes(key.toLowerCase()));
  databaseTargetsTestBranch =
    ['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol) &&
    parsedDatabaseUrl.hostname === expectedTestDatabaseHost &&
    !hasHostOverride;
} catch {
  // Invalid or missing URLs are rejected below without exposing their contents.
}

if (!testEnvironmentReady) {
  process.exitCode = 1;
} else if (process.env.DATABASE_TEST_CONFIRM !== 'CREATE_AND_DELETE_TEST_DATA') {
  console.error('REFUSED: Set DATABASE_TEST_CONFIRM=CREATE_AND_DELETE_TEST_DATA to run the tagged synthetic end-to-end test.');
  process.exitCode = 1;
} else if (process.env.NEON_BRANCH !== 'tradeintel-test') {
  console.error('TEST_CONFIGURATION_UNAVAILABLE: NEON_BRANCH must be tradeintel-test.');
  process.exitCode = 1;
} else if (!databaseTargetsTestBranch) {
  console.error('TEST_DATABASE_REFUSED: DATABASE_URL must target the dedicated test Neon endpoint.');
  process.exitCode = 1;
} else {
  const priorNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const authServer = await startTestAuthServer();
  process.env.SUPABASE_AUTH_URL = authServer.url;
  process.env.SUPABASE_AUTH_ANON_KEY = 'offline-synthetic-test-anon-key';
  process.env.ADMIN_SUPABASE_USER_ID = TEST_ADMIN_USER_ID;

  const { Pool } = pg;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10000,
    query_timeout: 30000,
    idleTimeoutMillis: 5000
  });
  const tag = randomUUID();
  const filename = `tradeintel-synthetic-e2e-${tag}.csv`;
  const testUserEmail = `tradeintel-e2e-${tag}@example.invalid`;
  const productName = 'Synthetic Resin';
  const companyNames = {
    qualified: `Synthetic Buyer A ${tag}`,
    insufficientTransactions: `Synthetic Buyer B ${tag}`,
    insufficientScore: `Synthetic Buyer C ${tag}`
  };
  const now = Date.now();
  const tradeRow = (company, offset, { country = 'Synthetic Market', explicitZeroInr = false } = {}) => {
    const row = {
      'Importer Name': company,
      'Product Description': productName,
      Sbill_Date: new Date(now - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      Quantity: String(100 + offset),
      Unit: 'kg'
    };
    if (country !== null) row.Country = country;
    if (explicitZeroInr) row['Total FOB Value in INR'] = '0';
    return row;
  };

  const sourceRows = [
    ...Array.from({ length: 10 }, (_, index) => tradeRow(companyNames.qualified, index)),
    ...Array.from({ length: 9 }, (_, index) => tradeRow(companyNames.insufficientTransactions, index)),
    ...Array.from({ length: 10 }, (_, index) => tradeRow(companyNames.insufficientScore, index, { country: null, explicitZeroInr: true }))
  ];
  sourceRows.push({ ...sourceRows[0] });
  sourceRows.push({
    'Importer Name': companyNames.qualified,
    Sbill_Date: new Date(now).toISOString().slice(0, 10),
    Quantity: '5',
    Unit: 'kg'
  });

  const sourceHasher = createHash('sha256');
  for (const row of sourceRows) sourceHasher.update(JSON.stringify(row) ?? 'null').update('\n');
  const contentHash = sourceHasher.digest('hex');
  const stages = {};
  let currentStage = 'preflight';
  let testDatasetId = null;
  let baselineDatasetIds = [];
  let userError = null;
  let cleanupError = null;
  let database = null;
  let datasetsHandler;
  let intelligenceHandler;
  let emailEngineHandler;
  let authConfigured = false;
  let retentionIsSupabase = false;
  let materializeTradeEntities;
  let qualifyCompaniesFromPotential;
  let deleteDatasetOwnedRows;

  function mark(name, details = {}) {
    stages[name] = { status: 'PASS', ...details };
  }

  function responseFor() {
    return {
      statusCode: 200,
      headers: {},
      payload: undefined,
      setHeader(name, value) { this.headers[name] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
      end() { this.ended = true; return this; }
    };
  }

  async function invoke(handler, method, body = {}, query = {}) {
    const response = responseFor();
    await handler({
      method,
      body,
      query,
      headers: { authorization: 'Bearer ' + TEST_ADMIN_TOKEN },
      socket: { remoteAddress: '127.0.0.1' }
    }, response);
    return response;
  }

  function assertApiSuccess(response, expectedStatus, label) {
    assert.equal(response.statusCode, expectedStatus, `${label} returned HTTP ${response.statusCode}`);
    assert.ok(response.payload && typeof response.payload === 'object', `${label} did not return a JSON response`);
  }

  try {
    const databaseUrl = process.env.DATABASE_URL;
    const { isSupabaseDatabaseTarget } = await import('../api/_dataset-retention.js');
    retentionIsSupabase = isSupabaseDatabaseTarget(databaseUrl);
    if (retentionIsSupabase) {
      throw Object.assign(new Error('Synthetic cleanup is disabled for Supabase database hosts.'), { code: 'SUPABASE_DATABASE_PROTECTED' });
    }

    const sequence = await pool.query("SELECT nextval(pg_get_serial_sequence('public.datasets', 'id'))::bigint AS reserved_id");
    let reservedDatasetId = Number(sequence.rows[0]?.reserved_id);
    while (Number.isSafeInteger(reservedDatasetId) && reservedDatasetId < 9) {
      const next = await pool.query("SELECT nextval(pg_get_serial_sequence('public.datasets', 'id'))::bigint AS reserved_id");
      reservedDatasetId = Number(next.rows[0]?.reserved_id);
    }
    assert.ok(Number.isSafeInteger(reservedDatasetId) && reservedDatasetId >= 9, 'Could not reserve past protected dataset id 9.');

    const baseline = await pool.query('SELECT id FROM datasets ORDER BY id');
    baselineDatasetIds = baseline.rows.map(row => String(row.id));
    const collision = await pool.query(
      `SELECT count(*)::int AS count
         FROM datasets
        WHERE filename = $1 OR content_hash = $2`,
      [filename, contentHash]
    );
    assert.equal(Number(collision.rows[0]?.count || 0), 0, 'The random tagged dataset filename or hash already exists.');

    const auditCollision = await pool.query('SELECT count(*)::int AS count FROM audit_logs WHERE user_email = $1', [testUserEmail]);
    assert.equal(Number(auditCollision.rows[0]?.count || 0), 0, 'The random test audit identity already exists.');
    mark('preflight', { existingDatasetsPreserved: baselineDatasetIds.length, protectedDatasetIdAvoided: true });

    const [{ default: dbClient }, datasetsModule, intelligenceModule, emailModule, authModule, entityModule, leadModule, deleteModule] = await Promise.all([
      import('../api/_db-client.js'),
      import('../api/_routes/datasets.js'),
      import('../api/_routes/intelligence.js'),
      import('../api/_routes/email-engine.js'),
      import('../api/_auth-client.js'),
      import('../api/_pipeline-entities.js'),
      import('../api/_lead-qualification.js'),
      import('../api/_dataset-delete.js')
    ]);
    database = dbClient;
    datasetsHandler = datasetsModule.default;
    intelligenceHandler = intelligenceModule.default;
    emailEngineHandler = emailModule.default;
    authConfigured = authModule.authConfigured;
    materializeTradeEntities = entityModule.materializeTradeEntities;
    qualifyCompaniesFromPotential = leadModule.qualifyCompaniesFromPotential;
    deleteDatasetOwnedRows = deleteModule.deleteDatasetOwnedRows;
    assert.equal(authConfigured, true, 'Existing Supabase Auth configuration is required for the local API handlers.');
    await database.healthcheck();

    currentStage = 'import';
    const imported = await invoke(datasetsHandler, 'POST', {
      filename,
      fileType: 'csv',
      rows: sourceRows,
      userEmail: testUserEmail
    });
    assertApiSuccess(imported, 201, 'Synthetic dataset import');
    assert.equal(imported.payload.success, true);
    testDatasetId = Number(imported.payload.dataset?.id || imported.payload.summary?.datasetId);
    assert.ok(Number.isSafeInteger(testDatasetId) && testDatasetId > 0 && testDatasetId !== 9, 'Import did not return a cleanable synthetic dataset id.');
    assert.equal(imported.payload.dataset?.filename, filename);
    assert.equal(imported.payload.summary?.totalRows, 31);
    assert.equal(imported.payload.summary?.validRows, 29);
    assert.equal(imported.payload.summary?.duplicateRows, 1);
    assert.equal(imported.payload.summary?.errorRows, 1);
    assert.equal(imported.payload.summary?.normalizedRowsInserted, 29);
    assert.equal(imported.payload.retention?.status, 'WAITING_FOR_ANALYSIS', 'Import attempted replacement cleanup before core analysis completed.');
    mark('import', { totalRows: 31, validUniqueRows: 29, duplicateRows: 1, invalidRows: 1 });

    currentStage = 'normalization_and_deduplication';
    const persistedImport = await pool.query(
      `SELECT d.import_status, d.content_hash,
              (SELECT count(*)::int FROM raw_records r WHERE r.dataset_id = d.id) AS raw_count,
              (SELECT count(*)::int FROM raw_records r WHERE r.dataset_id = d.id AND r.is_duplicate) AS duplicate_count,
              (SELECT count(*)::int FROM raw_records r WHERE r.dataset_id = d.id AND NOT r.is_valid) AS invalid_count,
              (SELECT count(*)::int FROM raw_records r WHERE r.dataset_id = d.id AND r.is_duplicate AND r.duplicate_of_row_index = 1) AS duplicate_link_count,
              (SELECT count(*)::int FROM normalized_records n WHERE n.dataset_id = d.id) AS normalized_count
         FROM datasets d WHERE d.id = $1`,
      [testDatasetId]
    );
    assert.equal(persistedImport.rowCount, 1);
    assert.equal(persistedImport.rows[0].import_status, 'COMPLETED');
    assert.equal(persistedImport.rows[0].content_hash, contentHash);
    assert.equal(Number(persistedImport.rows[0].raw_count), 31);
    assert.equal(Number(persistedImport.rows[0].duplicate_count), 1);
    assert.equal(Number(persistedImport.rows[0].invalid_count), 1);
    assert.equal(Number(persistedImport.rows[0].duplicate_link_count), 1);
    assert.equal(Number(persistedImport.rows[0].normalized_count), 29);
    mark('normalization_and_deduplication', { rawRows: 31, normalizedRows: 29, duplicateLinkedToFirstRow: true, invalidRowExcluded: true });

    currentStage = 'entity_aggregation';
    const entities = await materializeTradeEntities(testDatasetId);
    assert.equal(entities.completeDatasetCount, 1);
    assert.equal(entities.companies, 3);
    const companiesResult = await pool.query(
      `SELECT id, name, country, total_transactions, total_value, primary_products
         FROM companies WHERE dataset_id = $1 ORDER BY name`,
      [testDatasetId]
    );
    const companies = new Map(companiesResult.rows.map(row => [row.name, row]));
    const qualifiedCompany = companies.get(companyNames.qualified);
    const transactionsCompany = companies.get(companyNames.insufficientTransactions);
    const scoreCompany = companies.get(companyNames.insufficientScore);
    assert.ok(qualifiedCompany && transactionsCompany && scoreCompany, 'Entity aggregation did not produce all three synthetic companies.');
    assert.equal(Number(qualifiedCompany.total_transactions), 10);
    assert.equal(Number(transactionsCompany.total_transactions), 9);
    assert.equal(Number(scoreCompany.total_transactions), 10);
    assert.equal(qualifiedCompany.total_value, null, 'Missing transaction value should remain unavailable.');
    assert.equal(Number(scoreCompany.total_value), 0, 'Explicit zero INR should remain a supported zero.');
    mark('entity_aggregation', { companies: 3, qualifyingCompanyTransactions: 10, transactionThresholdCase: 9, scoreThresholdCase: 10 });

    currentStage = 'potential_scoring';
    const companyIds = [...companies.values()].map(company => Number(company.id));
    const scoringResponse = await invoke(intelligenceHandler, 'POST', { datasetId: testDatasetId, companyIds, userEmail: testUserEmail });
    assertApiSuccess(scoringResponse, 207, 'Company potential scoring route');
    const scoring = scoringResponse.payload;
    assert.equal(scoring.scored, 3);
    const scores = new Map(scoring.data.map(row => [Number(row.company_id), row]));
    const qualifiedScore = scores.get(Number(qualifiedCompany.id));
    const transactionThresholdScore = scores.get(Number(transactionsCompany.id));
    const scoreThresholdScore = scores.get(Number(scoreCompany.id));
    assert.ok(qualifiedScore && transactionThresholdScore && scoreThresholdScore);
    assert.ok(Number(qualifiedScore.total_score) >= 75);
    assert.ok(Number(transactionThresholdScore.total_score) >= 75);
    assert.equal(Number(transactionsCompany.total_transactions), 9);
    assert.equal(Number(scoreCompany.total_transactions), 10);
    assert.ok(Number(scoreThresholdScore.total_score) < 75);
    assert.equal(qualifiedScore.commercial_relevance_score, null);
    assert.equal(qualifiedScore.growth_score, null);
    assert.equal(qualifiedScore.supplier_diversification_score, null);
    assert.equal(qualifiedScore.engagement_score, null);
    assert.equal(qualifiedScore.evidence_breakdown.factors.commercialRelevance.status, 'UNAVAILABLE');
    assert.equal(qualifiedScore.evidence_breakdown.factors.growth.status, 'UNAVAILABLE');
    assert.equal(qualifiedScore.evidence_breakdown.factors.supplierDiversification.status, 'UNAVAILABLE');
    assert.equal(qualifiedScore.evidence_breakdown.factors.engagement.status, 'UNAVAILABLE');
    mark('potential_scoring', {
      companiesScored: 3,
      supportedLeadScore: Number(qualifiedScore.total_score),
      missingFactorsRemainNull: true,
      explicitZeroValuePreserved: Number(scoreCompany.total_value) === 0
    });

    currentStage = 'lead_qualification';
    const qualification = await qualifyCompaniesFromPotential(companyIds, testDatasetId, testUserEmail);
    assert.equal(qualification.candidates, 1, 'Only the company meeting both potential thresholds should qualify.');
    assert.equal(qualification.produced, 1);
    assert.equal(Number(qualification.qualifiedPotential[0]?.company_id), Number(qualifiedCompany.id));
    const leadsResult = await pool.query(
      `SELECT l.id, l.company_id, l.score, c.total_transactions, cp.total_score
         FROM leads l
         JOIN companies c ON c.dataset_id = l.dataset_id AND c.id = l.company_id
         JOIN company_potential cp ON cp.dataset_id = l.dataset_id AND cp.company_id = l.company_id
        WHERE l.dataset_id = $1 AND l.intent_type = 'COMPANY_POTENTIAL'`,
      [testDatasetId]
    );
    assert.equal(leadsResult.rowCount, 1);
    assert.equal(Number(leadsResult.rows[0].company_id), Number(qualifiedCompany.id));
    assert.ok(Number(leadsResult.rows[0].total_score) >= 75 && Number(leadsResult.rows[0].total_transactions) >= 10);
    const lead = leadsResult.rows[0];
    mark('lead_qualification', {
      produced: 1,
      scoreThreshold: '>=75',
      transactionThreshold: '>=10',
      rejectedHighScoreBelowTransactions: true,
      rejectedTenTransactionsBelowScore: true
    });

    currentStage = 'email_draft_rules';
    const lowScoreDraftAttempt = await invoke(emailEngineHandler, 'POST', { datasetId: testDatasetId, companyId: scoreCompany.id });
    assertApiSuccess(lowScoreDraftAttempt, 409, 'Below-score draft attempt');
    assert.equal(lowScoreDraftAttempt.payload.status, 'REVIEW_REQUIRED');
    const lowTransactionsDraftAttempt = await invoke(emailEngineHandler, 'POST', { datasetId: testDatasetId, companyId: transactionsCompany.id });
    assertApiSuccess(lowTransactionsDraftAttempt, 409, 'Below-transaction draft attempt');
    assert.equal(lowTransactionsDraftAttempt.payload.status, 'REVIEW_REQUIRED');

    const previews = await invoke(emailEngineHandler, 'POST', { datasetId: testDatasetId, action: 'GENERATE_DATASET_PREVIEWS' });
    assertApiSuccess(previews, 200, 'Dataset lead preview generation');
    assert.equal(previews.payload.success, true);
    assert.equal(previews.payload.qualifiedLeads, 1);
    assert.equal(previews.payload.generated, 1);
    assert.equal(previews.payload.sendable, false);
    assert.equal(previews.payload.sent, false);

    const noContactAttempt = await invoke(emailEngineHandler, 'POST', { datasetId: testDatasetId, leadId: lead.id });
    assertApiSuccess(noContactAttempt, 409, 'No-verified-contact draft attempt');
    assert.equal(noContactAttempt.payload.status, 'REVIEW_REQUIRED');
    assert.equal(noContactAttempt.payload.preview?.sendable, false);
    assert.equal(noContactAttempt.payload.preview?.recipientAssigned, false);
    assert.equal(noContactAttempt.payload.preview?.recipientEmail, null);
    const noContactDraftCount = await pool.query('SELECT count(*)::int AS count FROM outreach_emails WHERE dataset_id = $1', [testDatasetId]);
    assert.equal(Number(noContactDraftCount.rows[0].count), 0, 'No verified contact must not create a sendable outreach draft.');

    currentStage = 'verified_contact_draft';
    const syntheticContactEmail = `review-only-${tag}@example.invalid`;
    const contact = await database.from('contacts').insert({
      dataset_id: testDatasetId,
      company_id: qualifiedCompany.id,
      name: 'Synthetic Test Contact',
      role: 'Synthetic test fixture',
      email: syntheticContactEmail,
      source: 'SYNTHETIC_TEST_FIXTURE',
      source_url: null,
      verification_status: 'VERIFIED',
      confidence: 1,
      is_suppressed: false
    }).select('id').single();
    assert.equal(contact.error, null);
    assert.ok(contact.data?.id);

    const draftResponse = await invoke(emailEngineHandler, 'POST', { datasetId: testDatasetId, leadId: lead.id });
    assertApiSuccess(draftResponse, 201, 'Verified-contact draft generation');
    assert.equal(draftResponse.payload.status, 'APPROVAL_REQUIRED');
    assert.equal(draftResponse.payload.recipient_email, syntheticContactEmail);
    assert.equal(draftResponse.payload.validation_passed, true);
    assert.equal(draftResponse.payload.approved_at, null);
    assert.equal(draftResponse.payload.sent_at, null);
    assert.equal(draftResponse.payload.message_id, null);
    const outbound = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'SENT' OR sent_at IS NOT NULL)::int AS sent_count,
              count(*) FILTER (WHERE status = 'APPROVAL_REQUIRED' AND approved_at IS NULL)::int AS review_count
         FROM outreach_emails WHERE dataset_id = $1`,
      [testDatasetId]
    );
    assert.equal(Number(outbound.rows[0].total), 1);
    assert.equal(Number(outbound.rows[0].sent_count), 0);
    assert.equal(Number(outbound.rows[0].review_count), 1);
    mark('email_draft_rules', {
      nonqualifyingCompaniesBlocked: 2,
      noContactPreviewNonSendable: true,
      verifiedSyntheticContactDraft: 'APPROVAL_REQUIRED',
      sentEmails: 0,
      humanApprovalStillRequired: true
    });
  } catch (error) {
    userError = error;
    stages[currentStage] = { status: 'FAIL', code: String(error?.code || 'ASSERTION_FAILED') };
  } finally {
    try {
      if (database) {
        const matches = await pool.query(
          `SELECT id, filename, content_hash
             FROM datasets
            WHERE filename = $1 OR content_hash = $2
            ORDER BY id`,
          [filename, contentHash]
        );
        for (const row of matches.rows) {
          if (row.filename !== filename || row.content_hash !== contentHash || Number(row.id) === 9) {
            throw Object.assign(new Error('Refusing cleanup because the dataset does not match this run’s unique tag.'), { code: 'TEST_CLEANUP_IDENTITY_MISMATCH' });
          }
          await deleteDatasetOwnedRows(database, Number(row.id), { batchSize: 100 });
          const removedAudits = await pool.query('DELETE FROM audit_logs WHERE user_email = $1', [testUserEmail]);
          const removedDataset = await pool.query(
            'DELETE FROM datasets WHERE id = $1 AND filename = $2 AND content_hash = $3 RETURNING id',
            [row.id, filename, contentHash]
          );
          if (removedDataset.rowCount !== 1) throw Object.assign(new Error('Could not remove the exact tagged synthetic dataset.'), { code: 'TEST_DATASET_CLEANUP_FAILED' });
          stages.cleanupAuditRowsRemoved = Number(removedAudits.rowCount || 0);
        }

        const remains = await pool.query(
          `SELECT (SELECT count(*)::int FROM datasets WHERE filename = $1 OR content_hash = $2) AS dataset_count,
                  (SELECT count(*)::int FROM audit_logs WHERE user_email = $3) AS audit_count`,
          [filename, contentHash, testUserEmail]
        );
        assert.equal(Number(remains.rows[0].dataset_count), 0);
        assert.equal(Number(remains.rows[0].audit_count), 0);

        const ownedTables = [
          'follow_up_queue', 'response_drafts', 'inbox_messages', 'outreach_emails', 'leads',
          'company_potential', 'web_research', 'crm_activities', 'contacts', 'normalized_records',
          'raw_records', 'companies', 'products', 'markets', 'agent_runs'
        ];
        for (const table of ownedTables) {
          const remaining = await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE dataset_id = $1`, [testDatasetId]);
          assert.equal(Number(remaining.rows[0].count), 0, `Synthetic rows remain in ${table}.`);
        }
        const preserved = await pool.query('SELECT count(*)::int AS count FROM datasets WHERE id = ANY($1::bigint[])', [baselineDatasetIds]);
        assert.equal(Number(preserved.rows[0].count), baselineDatasetIds.length, 'An existing dataset disappeared during the test.');
        mark('cleanup', {
          taggedDatasetRemoved: true,
          datasetOwnedRowsRemoved: ownedTables.length,
          taggedAuditRowsRemoved: Number(stages.cleanupAuditRowsRemoved || 0),
          existingDatasetsPreserved: baselineDatasetIds.length
        });
      }
    } catch (error) {
      cleanupError = error;
      stages.cleanup = { status: 'FAIL', code: String(error?.code || 'TEST_CLEANUP_FAILED') };
    }

    await database?.close();
    await pool.end();
    await authServer.close();
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
  }

  const report = {
    status: userError || cleanupError ? 'FAIL' : 'PASS',
    workflowStages: stages,
    externalResearchCalls: 0,
    emailsSent: 0,
    testDatasetCreated: Boolean(testDatasetId),
    cleanupVerified: !cleanupError && stages.cleanup?.status === 'PASS'
  };
  console.log(JSON.stringify(report));
  if (userError || cleanupError) process.exitCode = 1;
}
