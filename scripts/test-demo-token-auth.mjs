import assert from 'node:assert/strict';
import {
  startTestAuthServer,
  TEST_ADMIN_TOKEN,
  TEST_ADMIN_USER_ID,
  TEST_OTHER_ADMIN_TOKEN,
  TEST_USER_TOKEN
} from './_test-auth-server.mjs';

const envKeys = ['SUPABASE_AUTH_URL', 'SUPABASE_AUTH_ANON_KEY', 'ADMIN_SUPABASE_USER_ID', 'NODE_ENV', 'VERCEL_ENV'];
const previousEnvironment = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const authServer = await startTestAuthServer();
Object.assign(process.env, {
  SUPABASE_AUTH_URL: authServer.url,
  SUPABASE_AUTH_ANON_KEY: 'offline-test-anon-key',
  ADMIN_SUPABASE_USER_ID: TEST_ADMIN_USER_ID
});

function responseStub() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

async function authenticate(requireAuth, token, { adminOnly = false, nodeEnv, vercelEnv } = {}) {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  if (vercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = vercelEnv;

  const req = { headers: token ? { authorization: 'Bearer ' + token } : {} };
  const res = responseStub();
  const allowed = await requireAuth(req, res, { adminOnly });
  return { allowed, req, res };
}

try {
  const { requireAuth } = await import('../api/_utils.js');

  const missingSession = await authenticate(requireAuth, null, { nodeEnv: 'production' });
  assert.equal(missingSession.allowed, false, 'a missing bearer session must be denied');
  assert.equal(missingSession.res.statusCode, 401);
  assert.equal(missingSession.res.payload?.code, 'AUTHENTICATION_REQUIRED');

  for (const environment of [
    { nodeEnv: 'development', vercelEnv: 'production' },
    { nodeEnv: 'production', vercelEnv: 'development' },
    { nodeEnv: 'production', vercelEnv: 'preview' }
  ]) {
    const demoAttempt = await authenticate(requireAuth, 'local-demo-token', environment);
    assert.equal(demoAttempt.allowed, false, 'the demo token must never authenticate');
    assert.equal(demoAttempt.res.statusCode, 401);
    assert.equal(demoAttempt.req.user, undefined, 'the demo token must not create a synthetic identity');
  }

  const invalid = await authenticate(requireAuth, 'invalid-offline-token', { nodeEnv: 'production' });
  assert.equal(invalid.allowed, false, 'invalid Supabase tokens must remain rejected');
  assert.equal(invalid.res.statusCode, 401);

  const userSession = await authenticate(requireAuth, TEST_USER_TOKEN, { nodeEnv: 'development' });
  assert.equal(userSession.allowed, false, 'a verified non-admin must not access the application in development');
  assert.equal(userSession.res.statusCode, 403);
  assert.equal(userSession.res.payload?.code, 'FORBIDDEN');
  assert.equal(userSession.req.user, undefined, 'client-controlled user_metadata.role must not grant access');

  const differentAdmin = await authenticate(requireAuth, TEST_OTHER_ADMIN_TOKEN, { nodeEnv: 'production' });
  assert.equal(differentAdmin.allowed, false, 'another account with trusted admin role must not access the application');
  assert.equal(differentAdmin.res.statusCode, 403);
  assert.equal(differentAdmin.req.user, undefined);

  const userCannotAdmin = await authenticate(requireAuth, TEST_USER_TOKEN, {
    adminOnly: true,
    nodeEnv: 'production'
  });
  assert.equal(userCannotAdmin.allowed, false, 'user_metadata.role must not grant admin access');
  assert.equal(userCannotAdmin.res.statusCode, 403);

  const adminSession = await authenticate(requireAuth, TEST_ADMIN_TOKEN, {
    adminOnly: true,
    nodeEnv: 'production'
  });
  assert.equal(adminSession.allowed, true, 'server-returned app_metadata admin role must remain valid');
  assert.equal(adminSession.req.user.app_metadata.role, 'admin');

  delete process.env.ADMIN_SUPABASE_USER_ID;
  const missingAdminId = await authenticate(requireAuth, TEST_ADMIN_TOKEN, { nodeEnv: 'production' });
  assert.equal(missingAdminId.allowed, false);
  assert.equal(missingAdminId.res.statusCode, 503);
  assert.equal(missingAdminId.res.payload?.code, 'ADMIN_ID_NOT_CONFIGURED');

  process.env.ADMIN_SUPABASE_USER_ID = 'malformed-admin-id';
  const malformedAdminId = await authenticate(requireAuth, TEST_ADMIN_TOKEN, { nodeEnv: 'production' });
  assert.equal(malformedAdminId.allowed, false);
  assert.equal(malformedAdminId.res.statusCode, 503);
  assert.equal(malformedAdminId.res.payload?.code, 'ADMIN_ID_CONFIGURATION_INVALID');

  console.log('Supabase token verification and designated-admin checks passed against the local auth stub.');
} finally {
  await authServer.close();
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
