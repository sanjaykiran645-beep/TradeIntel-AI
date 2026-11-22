import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startTestAuthServer, TEST_ADMIN_TOKEN, TEST_ADMIN_USER_ID, TEST_USER_TOKEN } from './_test-auth-server.mjs';

const authEnvironmentKeys = ['SUPABASE_AUTH_URL', 'SUPABASE_AUTH_ANON_KEY', 'ADMIN_SUPABASE_USER_ID'];
const previousAuthEnvironment = Object.fromEntries(authEnvironmentKeys.map(key => [key, process.env[key]]));
const authServer = await startTestAuthServer();
Object.assign(process.env, {
  SUPABASE_AUTH_URL: authServer.url,
  SUPABASE_AUTH_ANON_KEY: 'offline-gmail-oauth-integration-test-key',
  ADMIN_SUPABASE_USER_ID: TEST_ADMIN_USER_ID
});

const [
  {
    GMAIL_OAUTH_SCOPES,
    GMAIL_OAUTH_SETTINGS_KEY,
    GMAIL_OAUTH_STATE_COOKIE,
    buildRfc2822MimeMessage,
    buildSanitizedGmailOAuthSummary,
    createGmailApiTransport,
    createGmailOAuthAuthorizationRequest,
    exchangeGmailAuthorizationCode,
    fetchGmailInboundMessages,
    getGoogleOAuthClientConfig,
    getValidGmailAccessToken,
    resetGmailOAuthRefreshGuards,
    sanitizeOAuthText,
    validateGmailOAuthState,
    validateGoogleOAuthRedirectUri
  },
  { decryptHostingerConfig, encryptHostingerConfig },
  { getHostingerConfig },
  { classifyHostingerSendFailure },
  { createResponseSendHandler },
  { processInboundMimeItems }
] = await Promise.all([
  import('../api/_gmail-oauth.js'),
  import('../api/_hostinger-crypto.js'),
  import('../api/_utils.js'),
  import('../api/_routes/hostinger.js'),
  import('../api/_routes/response-send.js'),
  import('../api/_routes/inbox.js')
]);

const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const TEST_CLIENT_ID = '1234567890-synthetic.apps.googleusercontent.com';
const TEST_CLIENT_SECRET = 'GOCSPX-synthetic-secret-value-9999';
const TEST_REDIRECT_URI = 'http://localhost:3000/admin';
const TEST_ACCESS_TOKEN = 'ya29.a0AfH6SMB_synthetic_access_token_secret_12345';
const TEST_REFRESH_TOKEN = '1//0g_synthetic_refresh_token_secret_67890';

const baseOAuthEnv = {
  NODE_ENV: 'development',
  EMAIL_SENDING_ENABLED: 'false',
  EMAIL_PROVIDER: 'gmail_oauth',
  GOOGLE_OAUTH_CLIENT_ID: TEST_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: TEST_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI: TEST_REDIRECT_URI,
  HOSTINGER_CONFIG_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY
};

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    json(payload) { this.payload = payload; return this; },
    end() { return this; }
  };
}

// ---------------------------------------------------------------------------
// 1. OAuth state validation, PKCE, CSRF nonce, and invalid callback rejection
// ---------------------------------------------------------------------------
{
  const now = 1_700_000_000_000;
  const authReq = createGmailOAuthAuthorizationRequest({
    adminUserId: TEST_ADMIN_USER_ID,
    env: baseOAuthEnv,
    keyValue: TEST_ENCRYPTION_KEY,
    now
  });

  const parsedAuthUrl = new URL(authReq.authorizationUrl);
  assert.equal(parsedAuthUrl.origin + parsedAuthUrl.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(parsedAuthUrl.searchParams.get('client_id'), TEST_CLIENT_ID);
  assert.equal(parsedAuthUrl.searchParams.get('redirect_uri'), TEST_REDIRECT_URI);
  assert.equal(parsedAuthUrl.searchParams.get('response_type'), 'code');
  assert.equal(parsedAuthUrl.searchParams.get('access_type'), 'offline');
  assert.equal(parsedAuthUrl.searchParams.get('prompt'), 'consent');
  assert.equal(parsedAuthUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(parsedAuthUrl.searchParams.get('code_challenge')?.length >= 43);
  assert.deepEqual(parsedAuthUrl.searchParams.get('scope')?.split(' '), [...GMAIL_OAUTH_SCOPES]);
  assert.match(authReq.csrfCookie, new RegExp(`${GMAIL_OAUTH_STATE_COOKIE}=${authReq.nonce}`));
  assert.match(authReq.csrfCookie, /HttpOnly/);

  // Valid state + matching CSRF nonce succeeds
  const verified = validateGmailOAuthState({
    state: authReq.state,
    expectedAdminUserId: TEST_ADMIN_USER_ID,
    cookieNonce: authReq.nonce,
    requireCookieNonce: true,
    env: baseOAuthEnv,
    keyValue: TEST_ENCRYPTION_KEY,
    now: now + 5000
  });
  assert.equal(verified.adminUserId, TEST_ADMIN_USER_ID);
  assert.equal(verified.redirectUri, TEST_REDIRECT_URI);
  assert.ok(verified.codeVerifier.length >= 43);

  // Missing state rejected
  assert.throws(
    () => validateGmailOAuthState({ state: '', expectedAdminUserId: TEST_ADMIN_USER_ID, env: baseOAuthEnv, keyValue: TEST_ENCRYPTION_KEY }),
    err => err.code === 'OAUTH_STATE_MISSING'
  );

  // Tampered state rejected
  assert.throws(
    () => validateGmailOAuthState({ state: authReq.state.slice(0, -4) + 'XXXX', expectedAdminUserId: TEST_ADMIN_USER_ID, env: baseOAuthEnv, keyValue: TEST_ENCRYPTION_KEY, now }),
    err => err.code === 'OAUTH_STATE_INVALID'
  );

  // Expired state rejected
  assert.throws(
    () => validateGmailOAuthState({ state: authReq.state, expectedAdminUserId: TEST_ADMIN_USER_ID, env: baseOAuthEnv, keyValue: TEST_ENCRYPTION_KEY, now: now + 11 * 60 * 1000 }),
    err => err.code === 'OAUTH_STATE_EXPIRED'
  );

  // Wrong administrator user ID rejected
  assert.throws(
    () => validateGmailOAuthState({ state: authReq.state, expectedAdminUserId: '99999999-9999-4999-8999-999999999999', env: baseOAuthEnv, keyValue: TEST_ENCRYPTION_KEY, now }),
    err => err.code === 'OAUTH_STATE_ADMIN_MISMATCH' && err.status === 403
  );

  // Mismatched CSRF cookie nonce rejected
  assert.throws(
    () => validateGmailOAuthState({
      state: authReq.state,
      expectedAdminUserId: TEST_ADMIN_USER_ID,
      cookieNonce: 'wrong-nonce',
      requireCookieNonce: true,
      env: baseOAuthEnv,
      keyValue: TEST_ENCRYPTION_KEY,
      now
    }),
    err => err.code === 'OAUTH_CSRF_MISMATCH'
  );

  // User denied consent on callback rejected cleanly
  await assert.rejects(
    () => exchangeGmailAuthorizationCode({
      code: '',
      state: authReq.state,
      oauthError: 'access_denied',
      expectedAdminUserId: TEST_ADMIN_USER_ID,
      cookieNonce: authReq.nonce,
      env: baseOAuthEnv,
      keyValue: TEST_ENCRYPTION_KEY,
      now
    }),
    err => err.code === 'OAUTH_CONSENT_DENIED'
  );
}

// ---------------------------------------------------------------------------
// 2. Redirect URI validation
// ---------------------------------------------------------------------------
{
  assert.equal(validateGoogleOAuthRedirectUri(TEST_REDIRECT_URI, baseOAuthEnv), TEST_REDIRECT_URI);

  // Non-allowlisted redirect URI rejected
  assert.throws(
    () => validateGoogleOAuthRedirectUri('https://attacker.example.invalid/callback', baseOAuthEnv),
    err => err.code === 'OAUTH_REDIRECT_URI_NOT_ALLOWED'
  );

  // Wildcard redirect URI rejected
  assert.throws(
    () => validateGoogleOAuthRedirectUri('https://*.example.com/admin', {
      ...baseOAuthEnv,
      GOOGLE_OAUTH_REDIRECT_URI: 'https://*.example.com/admin'
    }),
    err => err.code === 'OAUTH_REDIRECT_URI_INVALID'
  );

  // Plain HTTP non-localhost rejected even in development
  assert.throws(
    () => validateGoogleOAuthRedirectUri('http://app.example.com/admin', {
      ...baseOAuthEnv,
      GOOGLE_OAUTH_REDIRECT_URI: 'http://app.example.com/admin'
    }),
    err => err.code === 'OAUTH_REDIRECT_URI_INVALID'
  );

  // Plain HTTP localhost rejected in production
  assert.throws(
    () => validateGoogleOAuthRedirectUri('http://localhost:3000/admin', {
      ...baseOAuthEnv,
      NODE_ENV: 'production'
    }),
    err => err.code === 'OAUTH_REDIRECT_URI_INVALID'
  );

  // Embedded credentials or fragments rejected
  assert.throws(
    () => validateGoogleOAuthRedirectUri('https://user:pass@app.example.com/admin', {
      ...baseOAuthEnv,
      GOOGLE_OAUTH_REDIRECT_URI: 'https://user:pass@app.example.com/admin'
    }),
    err => err.code === 'OAUTH_REDIRECT_URI_INVALID'
  );
}

// ---------------------------------------------------------------------------
// 3. Missing client ID or client secret & no silent downgrade to App Password
// ---------------------------------------------------------------------------
{
  const missingSecretConfig = getGoogleOAuthClientConfig({
    ...baseOAuthEnv,
    GOOGLE_OAUTH_CLIENT_SECRET: ''
  });
  assert.equal(missingSecretConfig.configured, false);
  assert.equal(missingSecretConfig.errorCode, 'OAUTH_CLIENT_CREDENTIALS_MISSING');
  assert.match(missingSecretConfig.reason, /GOOGLE_OAUTH_CLIENT_SECRET/);

  const missingIdConfig = getGoogleOAuthClientConfig({
    ...baseOAuthEnv,
    GOOGLE_OAUTH_CLIENT_ID: 'your-google-oauth-client-id.apps.googleusercontent.com'
  });
  assert.equal(missingIdConfig.configured, false);
  assert.equal(missingIdConfig.errorCode, 'OAUTH_CLIENT_CREDENTIALS_MISSING');
  assert.match(missingIdConfig.reason, /GOOGLE_OAUTH_CLIENT_ID/);

  // Even when HOSTINGER_SMTP_USER and HOSTINGER_SMTP_PASS are present in env,
  // Gmail OAuth mode NEVER silently downgrades to an App Password.
  const mockDbEmpty = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() { return { data: null, error: null }; }
              };
            }
          };
        }
      };
    }
  };

  const noDowngradeConfig = await getHostingerConfig({
    env: {
      ...baseOAuthEnv,
      GOOGLE_OAUTH_CLIENT_SECRET: '',
      HOSTINGER_SMTP_HOST: 'smtp.gmail.com',
      HOSTINGER_SMTP_PORT: '465',
      HOSTINGER_SMTP_USER: 'legacy@gmail.com',
      HOSTINGER_SMTP_PASS: 'legacyapppassword'
    },
    databaseClient: mockDbEmpty
  });
  assert.equal(noDowngradeConfig.provider, 'GMAIL_OAUTH');
  assert.equal(noDowngradeConfig.configured, false);
  assert.equal(noDowngradeConfig.smtpConfigured, false);
  assert.equal(noDowngradeConfig.imapConfigured, false);
  assert.equal(noDowngradeConfig.smtp, null);
  assert.equal(noDowngradeConfig.imap, null);
  assert.match(noDowngradeConfig.smtpReason, /GOOGLE_OAUTH_CLIENT_SECRET/);
}

// ---------------------------------------------------------------------------
// 4. Missing refresh token, insufficient scopes, revoked token, & backoff
// ---------------------------------------------------------------------------
{
  const now = 1_700_000_000_000;
  const authReq = createGmailOAuthAuthorizationRequest({
    adminUserId: TEST_ADMIN_USER_ID,
    env: baseOAuthEnv,
    keyValue: TEST_ENCRYPTION_KEY,
    now
  });

  // Token exchange returning no refresh_token must be rejected
  await assert.rejects(
    () => exchangeGmailAuthorizationCode({
      code: 'auth-code-no-refresh',
      state: authReq.state,
      expectedAdminUserId: TEST_ADMIN_USER_ID,
      cookieNonce: authReq.nonce,
      env: baseOAuthEnv,
      keyValue: TEST_ENCRYPTION_KEY,
      now,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: TEST_ACCESS_TOKEN,
            expires_in: 3599,
            scope: GMAIL_OAUTH_SCOPES.join(' ')
          };
        }
      })
    }),
    err => err.code === 'OAUTH_REFRESH_TOKEN_MISSING'
  );

  // Token exchange missing required Gmail scopes must be rejected
  await assert.rejects(
    () => exchangeGmailAuthorizationCode({
      code: 'auth-code-missing-scope',
      state: authReq.state,
      expectedAdminUserId: TEST_ADMIN_USER_ID,
      cookieNonce: authReq.nonce,
      env: baseOAuthEnv,
      keyValue: TEST_ENCRYPTION_KEY,
      now,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: TEST_ACCESS_TOKEN,
            refresh_token: TEST_REFRESH_TOKEN,
            expires_in: 3599,
            scope: 'https://www.googleapis.com/auth/gmail.readonly'
          };
        }
      })
    }),
    err => err.code === 'OAUTH_INSUFFICIENT_SCOPES'
  );

  // Full valid code exchange encrypts token record and returns sanitized summary
  const validExchange = await exchangeGmailAuthorizationCode({
    code: 'auth-code-valid',
    state: authReq.state,
    expectedAdminUserId: TEST_ADMIN_USER_ID,
    cookieNonce: authReq.nonce,
    env: baseOAuthEnv,
    keyValue: TEST_ENCRYPTION_KEY,
    now,
    fetchFn: async url => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: TEST_ACCESS_TOKEN,
              refresh_token: TEST_REFRESH_TOKEN,
              expires_in: 3600,
              scope: GMAIL_OAUTH_SCOPES.join(' '),
              token_type: 'Bearer'
            };
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { emailAddress: 'tradeintel-ops@gmail.com', messagesTotal: 12, threadsTotal: 8 };
        }
      };
    }
  });
  assert.equal(validExchange.summary.connected, true);
  assert.equal(validExchange.summary.email, 'tradeintel-ops@gmail.com');
  assert.equal(JSON.stringify(validExchange.summary).includes(TEST_ACCESS_TOKEN), false);
  assert.equal(JSON.stringify(validExchange.summary).includes(TEST_REFRESH_TOKEN), false);
  const decryptedRecord = decryptHostingerConfig(validExchange.encryptedRecord, TEST_ENCRYPTION_KEY);
  assert.equal(decryptedRecord.storage, 'ENCRYPTED');
  assert.equal(decryptedRecord.value.refreshToken, TEST_REFRESH_TOKEN);

  // Revoked token (invalid_grant) marks guard and prevents tight retry loop
  resetGmailOAuthRefreshGuards();
  let revokedFetchCalls = 0;
  const expiredRecord = {
    provider: 'GMAIL_OAUTH',
    email: 'tradeintel-ops@gmail.com',
    refreshToken: '1//0g_revoked_refresh_token_test',
    accessToken: 'ya29.expired_token',
    expiryDate: now - 10_000,
    scope: GMAIL_OAUTH_SCOPES.join(' ')
  };
  await assert.rejects(
    () => getValidGmailAccessToken({
      tokenRecord: expiredRecord,
      env: baseOAuthEnv,
      now,
      fetchFn: async () => {
        revokedFetchCalls += 1;
        return {
          ok: false,
          status: 400,
          async json() { return { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }; }
        };
      }
    }),
    err => err.code === 'OAUTH_TOKEN_REVOKED'
  );
  assert.equal(revokedFetchCalls, 1);

  // Second immediate call must NOT call Google's token endpoint again (no tight retry loop)
  await assert.rejects(
    () => getValidGmailAccessToken({
      tokenRecord: expiredRecord,
      env: baseOAuthEnv,
      now: now + 1000,
      fetchFn: async () => {
        revokedFetchCalls += 1;
        return { ok: true, status: 200, async json() { return {}; } };
      }
    }),
    err => err.code === 'OAUTH_TOKEN_REVOKED'
  );
  assert.equal(revokedFetchCalls, 1, 'revoked token must not be retried in a loop');

  // Transient 503 failure enforces cooldown backoff
  resetGmailOAuthRefreshGuards();
  let transientCalls = 0;
  const transientRecord = {
    ...expiredRecord,
    refreshToken: '1//0g_transient_refresh_token_test'
  };
  await assert.rejects(
    () => getValidGmailAccessToken({
      tokenRecord: transientRecord,
      env: baseOAuthEnv,
      now,
      fetchFn: async () => {
        transientCalls += 1;
        return { ok: false, status: 503, async json() { return { error: 'temporarily_unavailable' }; } };
      }
    }),
    err => err.code === 'OAUTH_TRANSIENT_FAILURE'
  );
  await assert.rejects(
    () => getValidGmailAccessToken({
      tokenRecord: transientRecord,
      env: baseOAuthEnv,
      now: now + 2000,
      fetchFn: async () => {
        transientCalls += 1;
        return { ok: true, status: 200, async json() { return {}; } };
      }
    }),
    err => err.code === 'OAUTH_TRANSIENT_FAILURE'
  );
  assert.equal(transientCalls, 1, 'cooldown guard must block repeated refresh retries within backoff window');
}

// ---------------------------------------------------------------------------
// 5. Sanitization of errors and tokens
// ---------------------------------------------------------------------------
{
  const dirtyText = `Failed with Bearer ${TEST_ACCESS_TOKEN} and refresh_token=${TEST_REFRESH_TOKEN} and secret=${TEST_CLIENT_SECRET}`;
  const cleaned = sanitizeOAuthText(dirtyText, [TEST_CLIENT_SECRET]);
  assert.equal(cleaned.includes(TEST_ACCESS_TOKEN), false);
  assert.equal(cleaned.includes(TEST_REFRESH_TOKEN), false);
  assert.equal(cleaned.includes(TEST_CLIENT_SECRET), false);
  assert.match(cleaned, /\[REDACTED\]/);

  const summary = buildSanitizedGmailOAuthSummary({
    env: baseOAuthEnv,
    oauthRecord: {
      provider: 'GMAIL_OAUTH',
      email: 'ops@example.com',
      refreshToken: TEST_REFRESH_TOKEN,
      accessToken: TEST_ACCESS_TOKEN,
      scope: GMAIL_OAUTH_SCOPES.join(' ')
    },
    credentialStorage: 'ENCRYPTED'
  });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(TEST_ACCESS_TOKEN), false);
  assert.equal(serialized.includes(TEST_REFRESH_TOKEN), false);
  assert.equal(serialized.includes(TEST_CLIENT_SECRET), false);
}

// ---------------------------------------------------------------------------
// 6. Unauthorized administrative access to OAuth endpoints
// ---------------------------------------------------------------------------
{
  const [{ default: adminHandler }, { default: database }] = await Promise.all([
    import('../api/_routes/admin.js'),
    import('../api/_db-client.js')
  ]);
  const originalFrom = database.from;
  let dbCalls = 0;
  database.from = () => {
    dbCalls += 1;
    throw new Error('Database must not be called for unauthorized admin OAuth requests');
  };

  try {
    for (const action of ['START_GMAIL_OAUTH', 'COMPLETE_GMAIL_OAUTH', 'CHECK_GMAIL_OAUTH', 'DISCONNECT_GMAIL_OAUTH']) {
      const unauthRes = responseStub();
      await adminHandler({ method: 'POST', headers: {}, body: { action, payload: {} }, query: {} }, unauthRes);
      assert.equal(unauthRes.statusCode, 401);
      assert.equal(unauthRes.payload?.code, 'AUTHENTICATION_REQUIRED');

      const nonAdminRes = responseStub();
      await adminHandler({
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_USER_TOKEN}` },
        body: { action, payload: {} },
        query: {}
      }, nonAdminRes);
      assert.equal(nonAdminRes.statusCode, 403);
      assert.equal(nonAdminRes.payload?.code, 'FORBIDDEN');
    }
    assert.equal(dbCalls, 0);
  } finally {
    database.from = originalFrom;
  }
}

// ---------------------------------------------------------------------------
// 7. Outbound sending blocked while EMAIL_SENDING_ENABLED=false
// ---------------------------------------------------------------------------
{
  resetGmailOAuthRefreshGuards();
  let fetchCalled = false;
  const transport = createGmailApiTransport({
    oauthConfig: {
      provider: 'GMAIL_OAUTH',
      email: 'ops@gmail.com',
      refreshToken: TEST_REFRESH_TOKEN,
      accessToken: TEST_ACCESS_TOKEN,
      expiryDate: Date.now() + 3600_000,
      scope: GMAIL_OAUTH_SCOPES.join(' ')
    },
    env: { ...baseOAuthEnv, EMAIL_SENDING_ENABLED: 'false' },
    fetchFn: async () => {
      fetchCalled = true;
      throw new Error('Network fetch must not be invoked when EMAIL_SENDING_ENABLED=false');
    }
  });

  await assert.rejects(
    () => transport.sendMail({
      from: '"Voyage" <ops@gmail.com>',
      to: 'buyer@example.invalid',
      subject: 'Blocked Send',
      text: 'Must not be transmitted'
    }),
    err => err.code === 'ECONNREFUSED' && err.command === 'CONN'
  );
  assert.equal(fetchCalled, false, 'Gmail API sendMail must block before any network call when EMAIL_SENDING_ENABLED=false');

  // Also verify response-send handler blocks when EMAIL_SENDING_ENABLED=false
  let readyChecked = false;
  const disabledResponseSend = createResponseSendHandler({
    setCorsFn() {},
    requireAuthFn: async () => true,
    env: { EMAIL_SENDING_ENABLED: 'false' },
    assertReadyFn: async () => { readyChecked = true; }
  });
  const resDisabled = responseStub();
  await disabledResponseSend({ method: 'POST', body: { id: '12' }, user: { email: 'admin@example.invalid' } }, resDisabled);
  assert.equal(resDisabled.statusCode, 503);
  assert.equal(resDisabled.payload?.code, 'EMAIL_SENDING_DISABLED');
  assert.equal(readyChecked, false);
}

// ---------------------------------------------------------------------------
// 8, 9, 10. Outbound approval, verified/unsuppressed recipient, & duplicate-send prevention
// ---------------------------------------------------------------------------
{
  const prevEnv = {
    EMAIL_SENDING_ENABLED: process.env.EMAIL_SENDING_ENABLED,
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    HOSTINGER_CONFIG_ENCRYPTION_KEY: process.env.HOSTINGER_CONFIG_ENCRYPTION_KEY
  };

  const encryptedOAuthRecord = encryptHostingerConfig({
    provider: 'GMAIL_OAUTH',
    email: 'ops@gmail.com',
    fromEmail: 'ops@gmail.com',
    fromName: 'Voyage International Business',
    refreshToken: TEST_REFRESH_TOKEN,
    accessToken: TEST_ACCESS_TOKEN,
    expiryDate: Date.now() + 3600_000,
    scope: GMAIL_OAUTH_SCOPES.join(' ')
  }, TEST_ENCRYPTION_KEY);

  Object.assign(process.env, {
    EMAIL_SENDING_ENABLED: 'false',
    EMAIL_PROVIDER: 'gmail_oauth',
    GOOGLE_OAUTH_CLIENT_ID: TEST_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: TEST_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: TEST_REDIRECT_URI,
    HOSTINGER_CONFIG_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY
  });

  const [{ default: hostingerHandler }, { default: database }] = await Promise.all([
    import('../api/_routes/hostinger.js'),
    import('../api/_db-client.js')
  ]);

  const originalFrom = database.from;
  const originalQuery = database.query;

  let currentDraftRow = null;
  let globalSuppressed = false;
  let claimSucceeded = true;

  database.query = async sql => {
    if (String(sql).includes('FROM contacts WHERE lower(email)')) {
      return { rows: globalSuppressed ? [{ '?column?': 1 }] : [] };
    }
    return { rows: [] };
  };

  database.from = table => {
    if (table === 'system_settings') {
      return {
        select() {
          return {
            eq(_col, key) {
              return {
                async maybeSingle() {
                  if (key === GMAIL_OAUTH_SETTINGS_KEY) return { data: { value: encryptedOAuthRecord }, error: null };
                  return { data: null, error: null };
                }
              };
            }
          };
        }
      };
    }
    if (table === 'datasets') {
      return {
        select() {
          const chain = {
            eq() { return chain; },
            in() { return chain; },
            is() { return chain; },
            filter() { return chain; },
            order() { return chain; },
            limit() { return chain; },
            async maybeSingle() {
              return {
                data: {
                  id: 41,
                  import_status: 'COMPLETED',
                  analysis_status: 'COMPLETED',
                  detected_entities: {},
                  updated_at: '2026-10-22T00:00:00.000Z'
                },
                error: null
              };
            }
          };
          return chain;
        },
        update() {
          const chain = {
            eq() { return chain; },
            is() { return chain; },
            filter() { return chain; },
            select() { return { async maybeSingle() { return { data: { id: 41 }, error: null }; } }; }
          };
          return chain;
        }
      };
    }
    if (table === 'outreach_emails') {
      return {
        select() {
          const chain = {
            eq() { return chain; },
            async single() { return { data: currentDraftRow, error: null }; }
          };
          return chain;
        },
        update() {
          const chain = {
            eq() { return chain; },
            select() {
              return {
                async maybeSingle() {
                  return { data: claimSucceeded ? { id: currentDraftRow?.id } : null, error: null };
                }
              };
            }
          };
          return chain;
        }
      };
    }
    if (table === 'follow_up_queue') {
      return {
        select() {
          const chain = {
            eq() { return chain; },
            in() { return chain; },
            async maybeSingle() { return { data: null, error: null }; }
          };
          return chain;
        }
      };
    }
    throw new Error(`Unexpected table in offline guard test: ${table}`);
  };

  try {
    // 7b. POST /api/hostinger blocked when EMAIL_SENDING_ENABLED=false
    const blockedFlagRes = responseStub();
    await hostingerHandler({
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: { outreachId: 101 },
      query: { dataset_id: '41' }
    }, blockedFlagRes);
    assert.equal(blockedFlagRes.statusCode, 403);
    assert.equal(blockedFlagRes.payload?.code, 'EMAIL_SENDING_DISABLED');

    // Temporarily test downstream guards in memory with EMAIL_SENDING_ENABLED='true'
    // while blocking all external fetch calls so no network request can ever occur.
    process.env.EMAIL_SENDING_ENABLED = 'true';

    // 8. Unapproved outreach blocked
    currentDraftRow = {
      id: 101,
      dataset_id: 41,
      recipient_email: 'buyer@example.invalid',
      subject: 'Test Subject',
      body_text: 'Test Body',
      status: 'APPROVAL_REQUIRED',
      approved_at: null,
      validation_passed: true,
      contacts: { email: 'buyer@example.invalid', verification_status: 'VERIFIED', is_suppressed: false }
    };
    const unapprovedRes = responseStub();
    await hostingerHandler({
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: { outreachId: 101 },
      query: { dataset_id: '41' }
    }, unapprovedRes);
    assert.equal(unapprovedRes.statusCode, 400);
    assert.match(unapprovedRes.payload?.error, /human approval is required/i);

    // 9a. Unverified contact blocked
    currentDraftRow = {
      ...currentDraftRow,
      status: 'APPROVED',
      approved_at: new Date().toISOString(),
      contacts: { email: 'buyer@example.invalid', verification_status: 'UNVERIFIED', is_suppressed: false }
    };
    const unverifiedRes = responseStub();
    await hostingerHandler({
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: { outreachId: 101 },
      query: { dataset_id: '41' }
    }, unverifiedRes);
    assert.equal(unverifiedRes.statusCode, 400);
    assert.match(unverifiedRes.payload?.error, /verified contact/i);

    // 9b. Suppressed contact blocked
    currentDraftRow = {
      ...currentDraftRow,
      contacts: { email: 'buyer@example.invalid', verification_status: 'VERIFIED', is_suppressed: true }
    };
    const suppressedRes = responseStub();
    await hostingerHandler({
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: { outreachId: 101 },
      query: { dataset_id: '41' }
    }, suppressedRes);
    assert.equal(suppressedRes.statusCode, 400);
    assert.match(suppressedRes.payload?.error, /suppressed/i);

    // 9c. Globally suppressed email blocked
    currentDraftRow = {
      ...currentDraftRow,
      contacts: { email: 'buyer@example.invalid', verification_status: 'VERIFIED', is_suppressed: false }
    };
    globalSuppressed = true;
    const globalSuppressedRes = responseStub();
    await hostingerHandler({
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: { outreachId: 101 },
      query: { dataset_id: '41' }
    }, globalSuppressedRes);
    assert.equal(globalSuppressedRes.statusCode, 409);
    assert.equal(globalSuppressedRes.payload?.code, 'RECIPIENT_SUPPRESSED');
    globalSuppressed = false;

    // 10. Duplicate-send atomic SENDING claim prevention
    claimSucceeded = false;
    const duplicateClaimRes = responseStub();
    await hostingerHandler({
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: { outreachId: 101 },
      query: { dataset_id: '41' }
    }, duplicateClaimRes);
    assert.equal(duplicateClaimRes.statusCode, 409);
    assert.match(duplicateClaimRes.payload?.error, /no longer approved/i);

    // Verify ambiguous Gmail API timeout during send classifies as UNKNOWN so it cannot be retried
    const ambiguousClassification = classifyHostingerSendFailure(
      Object.assign(new Error('Network timeout during Gmail API send'), { code: 'ETIMEDOUT', command: 'DATA' }),
      'buyer@example.invalid'
    );
    assert.equal(ambiguousClassification.outcome, 'UNKNOWN');
    assert.equal(ambiguousClassification.recordStatus, 'UNKNOWN');
  } finally {
    process.env.EMAIL_SENDING_ENABLED = 'false';
    database.from = originalFrom;
    database.query = originalQuery;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// 11, 12, 13. Inbound duplicate idempotency, thread matching, bounce & unsubscribe mocks
// ---------------------------------------------------------------------------
{
  const inboxRows = [];
  const contactState = {
    'buyer@acme.invalid': {
      id: 10,
      dataset_id: 41,
      company_id: 20,
      name: 'Alice Buyer',
      email: 'buyer@acme.invalid',
      is_suppressed: false,
      verification_status: 'VERIFIED'
    },
    'optout@acme.invalid': {
      id: 11,
      dataset_id: 41,
      company_id: 21,
      name: 'Bob Optout',
      email: 'optout@acme.invalid',
      is_suppressed: false,
      verification_status: 'VERIFIED'
    }
  };
  const outreachRows = [
    {
      id: 501,
      dataset_id: 41,
      lead_id: 301,
      company_id: 20,
      contact_id: 10,
      recipient_email: 'buyer@acme.invalid',
      subject: 'Synthetic Resin Supply Inquiry',
      message_id: '<outreach-501@gmail.com>',
      status: 'SENT',
      personalization_evidence: {
        smtpConfirmation: {
          gmailMessageId: '18f0000000000501',
          gmailThreadId: 'thread-gmail-501'
        }
      }
    }
  ];
  const followUpUpdates = [];
  const leadInserts = [];

  const mockInboundDb = {
    async query(sql, params) {
      if (String(sql).includes('UPDATE contacts') && String(sql).includes('is_suppressed = true')) {
        const email = params[0].toLowerCase();
        if (contactState[email]) contactState[email].is_suppressed = true;
      }
      if (String(sql).includes('UPDATE follow_up_queue')) {
        followUpUpdates.push({ email: params[0], status: params[1], reason: params[2] });
      }
      if (String(sql).includes('FROM outreach_emails')) {
        const recipient = params[1].toLowerCase();
        return { rows: outreachRows.filter(r => r.recipient_email === recipient && r.status === 'SENT') };
      }
      if (String(sql).includes("SET verification_status = 'BOUNCED'")) {
        const email = params[0].toLowerCase();
        if (contactState[email]) contactState[email].verification_status = 'BOUNCED';
      }
      return { rows: [] };
    },
    from(table) {
      if (table === 'inbox_messages') {
        return {
          select() {
            return {
              eq(_col, val) {
                return {
                  async maybeSingle() {
                    return { data: inboxRows.find(r => r.message_id === val) || null, error: null };
                  }
                };
              }
            };
          },
          insert(row) {
            const saved = { id: inboxRows.length + 1, ...row };
            inboxRows.push(saved);
            return {
              select() {
                return {
                  async single() { return { data: saved, error: null }; }
                };
              }
            };
          },
          update(patch) {
            return {
              eq(_c, id) {
                return {
                  eq() {
                    const row = inboxRows.find(r => r.id === id);
                    if (row) Object.assign(row, patch);
                    return Promise.resolve({ error: null });
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'contacts') {
        return {
          select() {
            const chain = {
              _email: null,
              eq(col, val) {
                if (col === 'email') chain._email = String(val).toLowerCase();
                return chain;
              },
              async maybeSingle() {
                return { data: contactState[chain._email] || null, error: null };
              }
            };
            return chain;
          }
        };
      }
      if (table === 'outreach_emails') {
        return {
          select() {
            const chain = {
              _recipient: null,
              eq(col, val) {
                if (col === 'recipient_email') chain._recipient = String(val).toLowerCase();
                return chain;
              },
              in() { return chain; },
              order() { return chain; },
              async limit() {
                return { data: outreachRows.filter(r => r.recipient_email === chain._recipient), error: null };
              }
            };
            return chain;
          },
          update(patch) {
            const chain = {
              _id: null,
              eq(col, val) {
                if (col === 'id') chain._id = val;
                const row = outreachRows.find(r => r.id === chain._id);
                if (row && patch) Object.assign(row, patch);
                return chain;
              },
              error: null
            };
            return chain;
          }
        };
      }
      if (table === 'companies') {
        return {
          select() {
            const chain = {
              eq() { return chain; },
              async maybeSingle() { return { data: { name: 'Acme Imports Ltd' }, error: null }; }
            };
            return chain;
          }
        };
      }
      if (table === 'company_potential') {
        return {
          select() {
            const chain = {
              eq() { return chain; },
              async maybeSingle() { return { data: { total_score: 84 }, error: null }; }
            };
            return chain;
          }
        };
      }
      if (table === 'leads') {
        return {
          async insert(row) {
            leadInserts.push(row);
            return { error: null };
          }
        };
      }
      throw new Error(`Unexpected table in inbound mock test: ${table}`);
    }
  };

  // Build synthetic raw MIME messages as returned by Gmail API users.messages.get?format=raw
  const replyMime = buildRfc2822MimeMessage({
    from: '"Alice Buyer" <buyer@acme.invalid>',
    to: 'ops@gmail.com',
    subject: 'Re: Synthetic Resin Supply Inquiry',
    text: 'We are interested! Please send your price quote for 20 metric tons.',
    inReplyTo: '<outreach-501@gmail.com>',
    references: '<outreach-501@gmail.com>',
    messageId: '<reply-alice-1@acme.invalid>'
  });

  const unsubscribeMime = buildRfc2822MimeMessage({
    from: '"Bob Optout" <optout@acme.invalid>',
    to: 'ops@gmail.com',
    subject: 'Re: Outreach',
    text: 'Please unsubscribe and remove me from your mailing list.',
    messageId: '<unsub-bob-1@acme.invalid>'
  });

  const selfSentMime = buildRfc2822MimeMessage({
    from: '"Voyage" <ops@gmail.com>',
    to: 'buyer@acme.invalid',
    subject: 'Synthetic Resin Supply Inquiry',
    text: 'Outbound message stored in Gmail mailbox',
    messageId: '<outreach-501@gmail.com>'
  });

  const unknownSenderMime = buildRfc2822MimeMessage({
    from: '"Stranger" <stranger@unknown.invalid>',
    to: 'ops@gmail.com',
    subject: 'Re: Synthetic Resin Supply Inquiry',
    text: 'Please send me a quote for 500 tons immediately.',
    inReplyTo: '<outreach-501@gmail.com>',
    messageId: '<stranger-1@unknown.invalid>'
  });

  const fetchedItems = await fetchGmailInboundMessages({
    oauthConfig: {
      provider: 'GMAIL_OAUTH',
      email: 'ops@gmail.com',
      refreshToken: TEST_REFRESH_TOKEN,
      accessToken: TEST_ACCESS_TOKEN,
      expiryDate: Date.now() + 3600_000,
      scope: GMAIL_OAUTH_SCOPES.join(' ')
    },
    env: baseOAuthEnv,
    fetchFn: async url => {
      const urlStr = String(url);
      if (urlStr.includes('/messages?')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              messages: [
                { id: 'gmail-id-reply-1', threadId: 'thread-gmail-501' },
                { id: 'gmail-id-reply-1', threadId: 'thread-gmail-501' }, // duplicate Gmail ID in batch
                { id: 'gmail-id-dup-rfc', threadId: 'thread-gmail-501' }, // duplicate RFC Message-ID
                { id: 'gmail-id-unsub-1', threadId: 'thread-gmail-999' },
                { id: 'gmail-id-self-1', threadId: 'thread-gmail-501' },
                { id: 'gmail-id-stranger-1', threadId: 'thread-gmail-501' }
              ]
            };
          }
        };
      }
      const rawMap = {
        'gmail-id-reply-1': { id: 'gmail-id-reply-1', threadId: 'thread-gmail-501', internalDate: '1700000010000', raw: replyMime.rawBase64Url },
        'gmail-id-dup-rfc': { id: 'gmail-id-dup-rfc', threadId: 'thread-gmail-501', internalDate: '1700000010000', raw: replyMime.rawBase64Url },
        'gmail-id-unsub-1': { id: 'gmail-id-unsub-1', threadId: 'thread-gmail-999', internalDate: '1700000020000', raw: unsubscribeMime.rawBase64Url },
        'gmail-id-self-1': { id: 'gmail-id-self-1', threadId: 'thread-gmail-501', internalDate: '1700000005000', raw: selfSentMime.rawBase64Url },
        'gmail-id-stranger-1': { id: 'gmail-id-stranger-1', threadId: 'thread-gmail-501', internalDate: '1700000030000', raw: unknownSenderMime.rawBase64Url }
      };
      const matchId = Object.keys(rawMap).find(k => urlStr.includes(k));
      return {
        ok: true,
        status: 200,
        async json() { return rawMap[matchId]; }
      };
    }
  });

  const config = {
    provider: 'GMAIL_OAUTH',
    imap: { user: 'ops@gmail.com' }
  };

  const syncResult = await processInboundMimeItems({
    items: fetchedItems,
    config,
    datasetId: 41,
    db: mockInboundDb
  });

  assert.equal(syncResult.synced, 3, 'reply, unsubscribe, and stranger message recorded once each; self-sent and duplicates skipped');
  assert.equal(syncResult.genuineReplies, 1, 'only the verified contact reply is counted as a genuineReply');
  assert.equal(syncResult.unsubscribes, 1, 'unsubscribe from known contact is counted');

  // Verify thread_<outreach_id> convention and RFC Message-ID preservation
  const savedReply = inboxRows.find(r => r.message_id === '<reply-alice-1@acme.invalid>');
  assert.ok(savedReply);
  assert.equal(savedReply.thread_id, 'thread_501');
  assert.equal(savedReply.outreach_id, 501);
  assert.equal(savedReply.extracted_entities.gmailMessageId, 'gmail-id-reply-1');
  assert.equal(savedReply.extracted_entities.gmailThreadId, 'thread-gmail-501');
  assert.equal(outreachRows[0].status, 'REPLIED');
  assert.equal(leadInserts.length, 1, 'only the genuine reply from verified contact creates a commercial lead');
  assert.equal(leadInserts[0].evidence.source, 'GENUINE_GMAIL_API_REPLY');

  // Verify unsubscribe suppressed contact and stopped follow-ups
  assert.equal(contactState['optout@acme.invalid'].is_suppressed, true);
  assert.ok(followUpUpdates.some(u => u.email === 'optout@acme.invalid' && u.status === 'STOPPED_UNSUBSCRIBED'));
  assert.ok(followUpUpdates.some(u => u.email === 'buyer@acme.invalid' && u.status === 'STOPPED_REPLY_RECEIVED'));

  // Verify stranger message was not linked to outreach 501 despite forged In-Reply-To
  const savedStranger = inboxRows.find(r => r.message_id === '<stranger-1@unknown.invalid>');
  assert.ok(savedStranger);
  assert.equal(savedStranger.outreach_id, null);
  assert.equal(savedStranger.thread_id, 'thread_<stranger-1@unknown.invalid>');

  // Re-running the exact same batch is 100% idempotent (0 newly synced)
  const secondRun = await processInboundMimeItems({
    items: fetchedItems,
    config,
    datasetId: 41,
    db: mockInboundDb
  });
  assert.equal(secondRun.synced, 0);
}

// ---------------------------------------------------------------------------
// 14. Existing Hostinger configuration and behavior remain compatible
// ---------------------------------------------------------------------------
{
  const mockHostingerDb = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() { return { data: null, error: null }; }
              };
            }
          };
        }
      };
    }
  };

  const hostingerConfig = await getHostingerConfig({
    env: {
      HOSTINGER_SMTP_HOST: 'smtp.hostinger.com',
      HOSTINGER_SMTP_PORT: '465',
      HOSTINGER_SMTP_USER: 'sales@voyageib.com',
      HOSTINGER_SMTP_PASS: 'hostinger-secret',
      HOSTINGER_IMAP_HOST: 'imap.hostinger.com',
      HOSTINGER_IMAP_PORT: '993'
    },
    databaseClient: mockHostingerDb
  });

  assert.equal(hostingerConfig.provider, 'HOSTINGER');
  assert.equal(hostingerConfig.configured, true);
  assert.equal(hostingerConfig.smtpConfigured, true);
  assert.equal(hostingerConfig.imapConfigured, true);
  assert.equal(hostingerConfig.smtp.host, 'smtp.hostinger.com');
  assert.equal(hostingerConfig.imap.host, 'imap.hostinger.com');
  assert.equal(hostingerConfig.imap.credentialSource, 'ENV_SMTP_FALLBACK');
}

await authServer.close();
for (const [k, v] of Object.entries(previousAuthEnvironment)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

console.log('All 14 offline Gmail OAuth 2.0 integration, security, outbound guard, and inbound reply tests passed.');
