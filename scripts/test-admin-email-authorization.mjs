import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startTestAuthServer, TEST_ADMIN_TOKEN, TEST_ADMIN_USER_ID, TEST_USER_TOKEN } from './_test-auth-server.mjs';

const envKeys = ['SUPABASE_AUTH_URL', 'SUPABASE_AUTH_ANON_KEY', 'ADMIN_SUPABASE_USER_ID'];
const previousEnvironment = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const authServer = await startTestAuthServer();
Object.assign(process.env, {
  SUPABASE_AUTH_URL: authServer.url,
  SUPABASE_AUTH_ANON_KEY: 'offline-admin-authorization-test-key',
  ADMIN_SUPABASE_USER_ID: TEST_ADMIN_USER_ID
});

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(payload) { this.payload = payload; return this; },
    end() { return this; }
  };
}

let databaseRef = null;
let originalDatabaseFrom = null;
let originalDatabaseQuery = null;
let nodemailerRef = null;
let originalCreateTransport = null;

async function invoke(handler, token, method, body = {}) {
  const res = responseStub();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  await handler({ method, body, headers, query: {} }, res);
  return res;
}

try {
  // Assert the guards before invoking handlers, so a regression fails closed in this test
  // without allowing the request to proceed into database or provider code.
  const [emailEngineSource, responsesSource, hostingerSource, responseSendSource] = await Promise.all([
    readFile(new URL('../api/_routes/email-engine.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/_routes/responses.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/_routes/hostinger.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/_routes/response-send.js', import.meta.url), 'utf8')
  ]);
  assert.match(emailEngineSource, /const adminOnly = req\.method === 'PUT' && req\.body\?\.action === 'APPROVE';\s*if \(!\(await requireAuth\(req, res, \{ adminOnly \}\)\)\) return;/);
  assert.match(responsesSource, /const adminOnly = req\.method === 'PUT' && req\.body\?\.action === 'APPROVE';\s*if \(!\(await requireAuth\(req, res, \{ adminOnly \}\)\)\) return;/);
  assert.match(hostingerSource, /requireAuth\(req, res, \{ adminOnly: req\.method === 'POST' \}\)/);
  assert.match(responseSendSource, /requireAuthFn\(req, res, \{ adminOnly: true \}\)/);
  assert.match(responseSendSource, /await assertReadyFn\(\)/);
  assert.ok(responseSendSource.indexOf('requireAuthFn(req, res, { adminOnly: true })') < responseSendSource.indexOf('assertReadyFn()'));
  assert.ok(responseSendSource.indexOf('assertReadyFn()') < responseSendSource.indexOf('createTransporterFn({'));

  const [{ default: emailEngine }, { default: responses }, { default: hostinger }, { default: responseSend }, { requireAuth }, guards, { default: database }] = await Promise.all([
    import('../api/_routes/email-engine.js'),
    import('../api/_routes/responses.js'),
    import('../api/_routes/hostinger.js'),
    import('../api/_routes/response-send.js'),
    import('../api/_utils.js'),
    import('../api/_outreach-guards.js'),
    import('../api/_db-client.js')
  ]);

  let databaseOperations = 0;
  databaseRef = database;
  originalDatabaseFrom = database.from;
  originalDatabaseQuery = database.query;
  nodemailerRef = (await import('nodemailer')).default;
  originalCreateTransport = nodemailerRef.createTransport;
  let smtpTransportCalls = 0;
  database.from = table => {
    databaseOperations += 1;
    throw new Error(`Database access blocked by offline authorization test: ${table}`);
  };
  database.query = () => {
    databaseOperations += 1;
    throw new Error('Database access blocked by offline authorization test.');
  };
  nodemailerRef.createTransport = (...args) => {
    smtpTransportCalls += 1;
    return originalCreateTransport(...args);
  };

  for (const [handler, method, body] of [
    [emailEngine, 'PUT', { action: 'APPROVE', id: 1 }],
    [responses, 'PUT', { action: 'APPROVE', id: 1 }],
    [responseSend, 'POST', { id: '1' }],
    [hostinger, 'POST', { outreachId: 1 }]
  ]) {
    const denied = await invoke(handler, TEST_USER_TOKEN, method, body);
    assert.equal(denied.statusCode, 403, 'a verified non-admin must be denied before database/provider work');
    assert.equal(denied.payload?.code, 'FORBIDDEN');

    const unauthenticated = await invoke(handler, null, method, body);
    assert.equal(unauthenticated.statusCode, 401, 'an unauthenticated request must be denied');
    assert.equal(unauthenticated.payload?.code, 'AUTHENTICATION_REQUIRED');
  }
  assert.equal(databaseOperations, 0, 'denied admin-only routes must not access the database');
  assert.equal(smtpTransportCalls, 0, 'denied admin-only routes must not create an SMTP transport');

  const adminReq = { headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } };
  const adminRes = responseStub();
  assert.equal(await requireAuth(adminReq, adminRes, { adminOnly: true }), true);
  assert.equal(adminReq.user.app_metadata.role, 'admin');

  const userReq = { headers: { authorization: `Bearer ${TEST_USER_TOKEN}` } };
  const userRes = responseStub();
  assert.equal(await requireAuth(userReq, userRes, { adminOnly: true }), false);
  assert.equal(userRes.statusCode, 403, 'user_metadata.role must not grant admin access');

  const forgedRecipient = await invoke(responseSend, TEST_ADMIN_TOKEN, 'POST', { id: '1', recipient_email: 'attacker@example.invalid' });
  assert.equal(forgedRecipient.statusCode, 400, 'sender requests must reject client-supplied recipient and SMTP metadata');
  assert.equal(databaseOperations, 0, 'invalid sender parameters must be rejected before database or SMTP work');
  assert.equal(smtpTransportCalls, 0, 'invalid sender parameters must not create an SMTP transport');

  assert.match(hostingerSource, /EMAIL_SENDING_ENABLED === 'true'/);
  assert.match(hostingerSource, /emailRow\.status !== 'APPROVED' \|\| !emailRow\.approved_at \|\| !emailRow\.validation_passed/);
  assert.match(hostingerSource, /verification_status !== 'VERIFIED' \|\| emailRow\.contacts\.is_suppressed/);
  assert.match(hostingerSource, /\.eq\('status', 'APPROVED'\)/);
  assert.equal(guards.approvalBlocker({
    status: 'APPROVAL_REQUIRED',
    validation_passed: true,
    recipient_email: 'buyer@example.invalid',
    contacts: { verification_status: 'VERIFIED', is_suppressed: false, email: 'buyer@example.invalid' }
  }), null);
  assert.ok(guards.approvalBlocker({
    status: 'APPROVAL_REQUIRED',
    validation_passed: true,
    recipient_email: 'buyer@example.invalid',
    contacts: { verification_status: 'UNVERIFIED', is_suppressed: false, email: 'buyer@example.invalid' }
  }));
  assert.equal(guards.smtpAcceptedByServer(null, 'buyer@example.invalid'), false);
  assert.equal(guards.smtpAcceptedByServer({ response: '250 accepted', accepted: ['other@example.invalid'] }, 'buyer@example.invalid'), false);
  assert.equal(guards.smtpAcceptedByServer({ response: '250 2.0.0 accepted', accepted: ['buyer@example.invalid'] }, 'buyer@example.invalid'), true);
  assert.equal(guards.smtpAcceptedByServer({ response: '550 rejected', accepted: ['buyer@example.invalid'] }, 'buyer@example.invalid'), false);
  assert.equal(guards.smtpAcceptedByServer({ response: 'accepted', accepted: ['buyer@example.invalid'] }, 'buyer@example.invalid'), false);

  console.log('Admin-only email action regression passed; existing approval and SMTP safeguards remain enforced.');
} finally {
  if (databaseRef && originalDatabaseFrom && originalDatabaseQuery) {
    databaseRef.from = originalDatabaseFrom;
    databaseRef.query = originalDatabaseQuery;
  }
  if (nodemailerRef && originalCreateTransport) nodemailerRef.createTransport = originalCreateTransport;
  await authServer.close();
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
