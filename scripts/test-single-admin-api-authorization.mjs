import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { startTestAuthServer, TEST_ADMIN_USER_ID, TEST_OTHER_ADMIN_TOKEN } from './_test-auth-server.mjs';

const environmentKeys = ['SUPABASE_AUTH_URL', 'SUPABASE_AUTH_ANON_KEY', 'ADMIN_SUPABASE_USER_ID'];
const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const authServer = await startTestAuthServer();
Object.assign(process.env, {
  SUPABASE_AUTH_URL: authServer.url,
  SUPABASE_AUTH_ANON_KEY: 'offline-single-admin-test-key',
  ADMIN_SUPABASE_USER_ID: TEST_ADMIN_USER_ID
});

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    end() { return this; }
  };
}

const routeModules = [
  ['admin', '../api/_routes/admin.js'],
  ['companies', '../api/_routes/companies.js'],
  ['contacts', '../api/_routes/contacts.js'],
  ['crm', '../api/_routes/crm.js'],
  ['dashboard', '../api/_routes/dashboard.js'],
  ['datasets', '../api/_routes/datasets.js'],
  ['email-engine', '../api/_routes/email-engine.js'],
  ['followup', '../api/_routes/followup.js'],
  ['hostinger', '../api/_routes/hostinger.js'],
  ['inbox', '../api/_routes/inbox.js'],
  ['intelligence', '../api/_routes/intelligence.js'],
  ['leads', '../api/_routes/leads.js'],
  ['markets', '../api/_routes/markets.js'],
  ['products', '../api/_routes/products.js'],
  ['research', '../api/_routes/research.js'],
  ['responses', '../api/_routes/responses.js'], ['response-send', '../api/_routes/response-send.js'],
  ['supervisor', '../api/_routes/supervisor.js']
];
const apiDirectoryEntries = await readdir(new URL('../api/_routes/', import.meta.url), { withFileTypes: true });
const discoveredRouteNames = apiDirectoryEntries
  .filter(entry => entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_'))
  .map(entry => entry.name.slice(0, -3))
  .sort();
assert.deepEqual(routeModules.map(([name]) => name).sort(), discoveredRouteNames, 'the route fixture covers every top-level API handler');

const originalFetch = globalThis.fetch;
const blockedFetchAttempts = [];
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  if (!url.startsWith(authServer.url)) {
    blockedFetchAttempts.push(url);
    return Promise.reject(new Error('External fetch blocked by the offline authorization test.'));
  }
  return originalFetch(input, init);
};

let databaseCalls = 0;
let database;
let originalDatabaseFrom;
try {
  ({ default: database } = await import('../api/_db-client.js'));
  originalDatabaseFrom = database.from;
  database.from = table => {
    databaseCalls += 1;
    throw new Error(`Database access blocked in offline authorization test: ${table}`);
  };

  const handlers = await Promise.all(routeModules.map(async ([name, modulePath]) => {
    const { default: handler } = await import(modulePath);
    return [name, handler];
  }));

  for (const [name, handler] of handlers) {
    const response = responseStub();
    await handler({
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_OTHER_ADMIN_TOKEN}` },
      body: { dataset_id: 41, action: 'APPROVE' },
      query: {}
    }, response);
    assert.equal(response.statusCode, 403, `${name} must deny a different account with app_metadata.role=admin`);
    assert.equal(response.payload?.code, 'FORBIDDEN', `${name} must use the shared designated-admin guard`);
  }
  assert.equal(databaseCalls, 0, 'no top-level route may query the database before denying the wrong admin account');
  assert.deepEqual(blockedFetchAttempts, [], 'unauthorized route calls must not reach external providers');

  const [loginSource, authContextSource, googleAuthSource] = await Promise.all([
    readFile(new URL('../src/pages/Login.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/contexts/AuthContext.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/googleAuth.js', import.meta.url), 'utf8')
  ]);
  assert.doesNotMatch(loginSource, /auth\.signUp|isSignUp|Create Account|Don't have an account\? Sign up/i);
  assert.match(loginSource, /auth\.signInWithPassword/);
  assert.match(loginSource, /signInWithGoogle/);
  assert.match(authContextSource, /auth\.getSession\(\)/);
  assert.match(authContextSource, /auth\.onAuthStateChange/);
  assert.match(authContextSource, /signOutOrThrow/);
  assert.match(googleAuthSource, /auth\.setSession/);
  assert.match(googleAuthSource, /auth\.signInWithIdToken/);
  const availableRoutes = new Set(handlers.map(([name]) => name));
  const workflowStages = [
    ['TRADE DATA', 'datasets'], ['DATA PROCESSING', 'datasets'], ['BUSINESS INTELLIGENCE', 'intelligence'],
    ['CUSTOMER SCORING', 'intelligence'], ['QUALIFIED LEADS', 'leads'], ['RESEARCH', 'research'],
    ['CONTACTS', 'contacts'], ['PERSONALIZED OUTREACH', 'email-engine'], ['HUMAN APPROVAL', 'email-engine'],
    ['EMAIL', 'hostinger'], ['REPLIES', 'inbox'], ['AI RESPONSE', 'responses'], ['FOLLOW-UP', 'followup'],
    ['CRM', 'crm'], ['BUSINESS INSIGHTS', 'dashboard']
  ];
  assert.equal(workflowStages.length, 15);
  assert.deepEqual(workflowStages.filter(([, route]) => !availableRoutes.has(route)), [], 'all workflow stages retain their API route');

  console.log(`Single-admin authorization passed for ${handlers.length} top-level API handlers; no database/provider calls occurred.`);
} finally {
  if (database && originalDatabaseFrom) database.from = originalDatabaseFrom;
  globalThis.fetch = originalFetch;
  await authServer.close();
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
