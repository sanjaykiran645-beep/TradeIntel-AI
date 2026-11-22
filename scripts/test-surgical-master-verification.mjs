import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestAuthServer, TEST_ADMIN_TOKEN, TEST_ADMIN_USER_ID, TEST_USER_TOKEN } from './_test-auth-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testEnvPath = path.join(root, '.env.test.local');
if (existsSync(testEnvPath)) {
  process.loadEnvFile(testEnvPath);
}

const envKeys = ['SUPABASE_AUTH_URL', 'SUPABASE_AUTH_ANON_KEY', 'ADMIN_SUPABASE_USER_ID'];
const previousEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
const authServer = await startTestAuthServer();

Object.assign(process.env, {
  SUPABASE_AUTH_URL: authServer.url,
  SUPABASE_AUTH_ANON_KEY: 'offline-surgical-verification-anon-key',
  ADMIN_SUPABASE_USER_ID: TEST_ADMIN_USER_ID
});

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    setHeader(name, val) { this.headers[name] = val; return this; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.payload = data; return this; },
    end() { return this; }
  };
}

async function invoke(handler, token, method, { body = {}, query = {} } = {}) {
  const res = responseStub();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  await handler({ method, body, query, headers }, res);
  return res;
}

try {
  const [{ default: contactsHandler }, { default: companiesHandler }, { default: adminHandler }, { isSupportedResponseDraftMode }] = await Promise.all([
    import('../api/_routes/contacts.js'),
    import('../api/_routes/companies.js'),
    import('../api/_routes/admin.js'),
    import('../api/_routes/responses.js')
  ]);

  console.log('--- TEST 1: ISSUE 1 (CONTACTS DIRECTORY & DISCOVERY) ---');

  // 1.1: Unauthorized request rejection
  const unauthGet = await invoke(contactsHandler, null, 'GET');
  assert.equal(unauthGet.statusCode, 401, 'Unauthenticated GET /api/contacts must be rejected (401)');
  assert.equal(unauthGet.payload?.code, 'AUTHENTICATION_REQUIRED');

  const unauthPost = await invoke(contactsHandler, null, 'POST', { body: { name: 'Test' } });
  assert.equal(unauthPost.statusCode, 401, 'Unauthenticated POST /api/contacts must be rejected (401)');

  // 1.2: Authenticated contact listing
  const authGet = await invoke(contactsHandler, TEST_ADMIN_TOKEN, 'GET');
  assert.equal(authGet.statusCode, 200, 'Authenticated GET /api/contacts must succeed');
  assert.ok(Array.isArray(authGet.payload?.data || authGet.payload), 'Contacts response must be an array or paginated data array');

  // 1.3: Contact discovery from lead validation (missing lead/company fails gracefully)
  const discoverMissing = await invoke(contactsHandler, TEST_ADMIN_TOKEN, 'POST', {
    body: { action: 'DISCOVER_FROM_LEAD' }
  });
  assert.equal(discoverMissing.statusCode, 400, 'DISCOVER_FROM_LEAD without leadId/companyId must be rejected with 400');

  // 1.4: Manual contact creation validation (missing required fields)
  const manualMissing = await invoke(contactsHandler, TEST_ADMIN_TOKEN, 'POST', {
    body: { name: 'Alice Smith', email: 'not-an-email', company_id: 1 }
  });
  assert.equal(manualMissing.statusCode, 400, 'Invalid email in manual contact creation must be rejected with 400');

  console.log('✓ Contacts auth, listing, and validation safeguards passed.');

  console.log('--- TEST 2: ISSUE 2 (ORGANIZE LEADS AND OPPORTUNITIES) ---');

  // 2.1: Companies query with qualification filter
  const qualCompanies = await invoke(companiesHandler, TEST_ADMIN_TOKEN, 'GET', {
    query: { qualification: 'QUALIFIED' }
  });
  assert.equal(qualCompanies.statusCode, 200, 'GET /api/companies?qualification=QUALIFIED must succeed');
  assert.ok(Array.isArray(qualCompanies.payload?.data), 'Companies payload must include data array');
  for (const c of qualCompanies.payload.data) {
    assert.equal(c.is_qualified, true, 'Every record in QUALIFIED filter must have is_qualified === true');
    assert.ok(Number(c.potential?.total_score) >= 75, 'Qualified company must have score >= 75');
    assert.ok(Number(c.total_transactions) >= 10, 'Qualified company must have transactions >= 10');
  }

  // 2.2: Scored-only filter
  const scoredOnlyCompanies = await invoke(companiesHandler, TEST_ADMIN_TOKEN, 'GET', {
    query: { qualification: 'SCORED_ONLY' }
  });
  assert.equal(scoredOnlyCompanies.statusCode, 200, 'GET /api/companies?qualification=SCORED_ONLY must succeed');
  for (const c of scoredOnlyCompanies.payload.data) {
    assert.equal(c.is_qualified, false, 'Every record in SCORED_ONLY filter must have is_qualified === false');
  }

  console.log('✓ Opportunities qualification distinction, thresholds, and filters verified.');

  console.log('--- TEST 3: ISSUE 3 (AUTOMATION AUTHORIZATION) ---');

  // 3.1: Non-admin rejected from admin endpoints
  const nonAdminGet = await invoke(adminHandler, TEST_USER_TOKEN, 'GET');
  assert.equal(nonAdminGet.statusCode, 403, 'Non-admin user must be rejected from /api/admin (403)');
  assert.equal(nonAdminGet.payload?.code, 'FORBIDDEN');

  const nonAdminSave = await invoke(adminHandler, TEST_USER_TOKEN, 'POST', {
    body: { action: 'SAVE_LIMITS', payload: { dailyMax: 50, hourlyMax: 10, approvalMode: 'AUTHORIZED_AUTOMATION' } }
  });
  assert.equal(nonAdminSave.statusCode, 403, 'Non-admin user cannot modify automation limits (403)');

  // 3.2: Admin can save limits with AUTHORIZED_AUTOMATION
  const adminSave = await invoke(adminHandler, TEST_ADMIN_TOKEN, 'POST', {
    body: {
      action: 'SAVE_LIMITS',
      payload: { dailyMax: 100, hourlyMax: 20, approvalMode: 'AUTHORIZED_AUTOMATION' }
    }
  });
  assert.equal(adminSave.statusCode, 200, 'Admin can save AUTHORIZED_AUTOMATION mode');
  assert.equal(adminSave.payload?.data?.value?.approvalMode, 'AUTHORIZED_AUTOMATION');

  // 3.3: Invalid approvalMode rejected on backend
  const invalidModeSave = await invoke(adminHandler, TEST_ADMIN_TOKEN, 'POST', {
    body: {
      action: 'SAVE_LIMITS',
      payload: { dailyMax: 100, hourlyMax: 20, approvalMode: 'INVALID_MODE' }
    }
  });
  assert.equal(invalidModeSave.statusCode, 400, 'Backend must reject invalid approvalMode');

  // 3.4: Draft mode support verification
  assert.equal(isSupportedResponseDraftMode('MANUAL'), true);
  assert.equal(isSupportedResponseDraftMode('SUPERVISED'), true);
  assert.equal(isSupportedResponseDraftMode('AUTHORIZED_AUTOMATION'), true);
  assert.equal(isSupportedResponseDraftMode('UNSUPPORTED_RANDOM'), false);

  // 3.5: Verify email safety preserved
  assert.equal(process.env.EMAIL_SENDING_ENABLED, 'false', 'EMAIL_SENDING_ENABLED must remain strictly false');

  console.log('✓ Automation authorization, role guards, persistence, and email safety verified.');

  console.log('================================================================');
  console.log('SURGICAL MASTER PROMPT VERIFICATION: 100% PASSED');
  console.log('================================================================');
} finally {
  await authServer.close();
  Object.assign(process.env, previousEnv);
}
