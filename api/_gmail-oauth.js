import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { decryptHostingerConfig, encryptHostingerConfig } from './_hostinger-crypto.js';
import { isValidOutreachEmail } from './_outreach-guards.js';

export const GMAIL_OAUTH_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly'
]);

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_OAUTH_SETTINGS_KEY = 'gmail_oauth_config';
export const GMAIL_OAUTH_STATE_COOKIE = '__ti_gmail_oauth_nonce';

const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 15 * 1000;
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;
const PLACEHOLDER_PATTERN = /^(?:your-|placeholder|changeme|example|replace-me|todo|<)/i;
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Single-flight and backoff state keyed by SHA-256 hash of the refresh token.
// Prevents concurrent duplicate refreshes and tight retry loops on failure.
const refreshGuardMap = new Map();

export function resetGmailOAuthRefreshGuards() {
  refreshGuardMap.clear();
}

function tokenKeyHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

export function isPlaceholderValue(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (PLACEHOLDER_PATTERN.test(text)) return true;
  if (/your-google-oauth-client|your-client-id|your-client-secret|your-mailbox@example\.com|your-oauth-proxy\.example\.com/i.test(text)) return true;
  return false;
}

export function sanitizeOAuthText(input, extraSecrets = []) {
  if (input === null || input === undefined) return '';
  let text = String(input);

  const secretsToRedact = [
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    process.env.HOSTINGER_SMTP_PASS,
    process.env.HOSTINGER_IMAP_PASS,
    process.env.HOSTINGER_CONFIG_ENCRYPTION_KEY,
    ...extraSecrets
  ].filter(Boolean);

  for (const secret of secretsToRedact) {
    const trimmed = String(secret).trim();
    if (trimmed.length >= 4) {
      text = text.split(trimmed).join('[REDACTED]');
    }
  }

  // Redact OAuth tokens, authorization headers, and sensitive query parameters
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, '[REDACTED_ACCESS_TOKEN]')
    .replace(/\b1\/\/[A-Za-z0-9._-]+/g, '[REDACTED_REFRESH_TOKEN]')
    .replace(/((?:access_token|refresh_token|client_secret|code|code_verifier|id_token)=)[^&\s"']+/gi, '$1[REDACTED]');

  return text;
}

export function createSanitizedOAuthError(message, code = 'OAUTH_ERROR', status = 400, extraSecrets = []) {
  const err = new Error(sanitizeOAuthText(message, extraSecrets));
  err.code = code;
  err.status = status;
  return err;
}

export function isGmailOAuthModeRequested(env = process.env, oauthDatabaseConfig = null) {
  const explicitProvider = String(env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (explicitProvider === 'gmail_oauth' || explicitProvider === 'gmail') return true;
  if (explicitProvider === 'hostinger') return false;

  if (oauthDatabaseConfig && typeof oauthDatabaseConfig === 'object' && !oauthDatabaseConfig.disconnected) {
    return true;
  }

  const hasClientId = Boolean(String(env.GOOGLE_OAUTH_CLIENT_ID || '').trim() && !isPlaceholderValue(env.GOOGLE_OAUTH_CLIENT_ID));
  const hasClientSecret = Boolean(String(env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim() && !isPlaceholderValue(env.GOOGLE_OAUTH_CLIENT_SECRET));
  const hasRedirectUri = Boolean(String(env.GOOGLE_OAUTH_REDIRECT_URI || '').trim() && !isPlaceholderValue(env.GOOGLE_OAUTH_REDIRECT_URI));
  return hasClientId || hasClientSecret || hasRedirectUri;
}

export function validateGoogleOAuthRedirectUri(redirectUri, env = process.env) {
  const candidate = String(redirectUri ?? env.GOOGLE_OAUTH_REDIRECT_URI ?? '').trim();
  if (!candidate || isPlaceholderValue(candidate)) {
    throw createSanitizedOAuthError(
      'GOOGLE_OAUTH_REDIRECT_URI is not configured.',
      'OAUTH_REDIRECT_URI_MISSING',
      400
    );
  }
  if (candidate.includes('*')) {
    throw createSanitizedOAuthError(
      'Wildcard redirect URIs are not permitted for Gmail OAuth.',
      'OAUTH_REDIRECT_URI_INVALID',
      400
    );
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw createSanitizedOAuthError(
      'GOOGLE_OAUTH_REDIRECT_URI must be a valid absolute URL.',
      'OAUTH_REDIRECT_URI_INVALID',
      400
    );
  }

  if (parsed.username || parsed.password || parsed.hash) {
    throw createSanitizedOAuthError(
      'GOOGLE_OAUTH_REDIRECT_URI must not contain credentials or URL fragments.',
      'OAUTH_REDIRECT_URI_INVALID',
      400
    );
  }

  const isProduction = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';
  const isLocalhost = LOCALHOST_HOSTS.has(parsed.hostname.toLowerCase());

  if (parsed.protocol !== 'https:') {
    if (isProduction || parsed.protocol !== 'http:' || !isLocalhost) {
      throw createSanitizedOAuthError(
        'GOOGLE_OAUTH_REDIRECT_URI must use HTTPS (or http://localhost outside production).',
        'OAUTH_REDIRECT_URI_INVALID',
        400
      );
    }
  }

  // Build explicit allowlist from server configuration
  const configuredPrimary = String(env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  const configuredAdditional = String(env.GOOGLE_OAUTH_ALLOWED_REDIRECT_URIS || '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item && !item.includes('*') && !isPlaceholderValue(item));

  const allowlistRaw = [
    ...(configuredPrimary && !isPlaceholderValue(configuredPrimary) ? [configuredPrimary] : []),
    ...configuredAdditional
  ];

  const normalizedAllowlist = new Set();
  for (const item of allowlistRaw) {
    try {
      normalizedAllowlist.add(new URL(item).href);
    } catch {
      // Ignore malformed entries in allowlist
    }
  }

  if (normalizedAllowlist.size === 0 || !normalizedAllowlist.has(parsed.href)) {
    throw createSanitizedOAuthError(
      'The provided OAuth redirect URI is not in the server allowlist.',
      'OAUTH_REDIRECT_URI_NOT_ALLOWED',
      400
    );
  }

  return parsed.href;
}

export function getGoogleOAuthClientConfig(env = process.env) {
  const clientId = String(env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  const redirectUriRaw = String(env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();

  const missing = [];
  if (!clientId || isPlaceholderValue(clientId)) missing.push('GOOGLE_OAUTH_CLIENT_ID');
  if (!clientSecret || isPlaceholderValue(clientSecret)) missing.push('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!redirectUriRaw || isPlaceholderValue(redirectUriRaw)) missing.push('GOOGLE_OAUTH_REDIRECT_URI');

  if (missing.length > 0) {
    return {
      configured: false,
      clientId: null,
      clientSecret: null,
      redirectUri: null,
      errorCode: 'OAUTH_CLIENT_CREDENTIALS_MISSING',
      reason: `Gmail OAuth 2.0 client configuration is incomplete. Missing: ${missing.join(', ')}.`
    };
  }

  try {
    const redirectUri = validateGoogleOAuthRedirectUri(redirectUriRaw, env);
    return {
      configured: true,
      clientId,
      clientSecret,
      redirectUri,
      errorCode: null,
      reason: null
    };
  } catch (error) {
    return {
      configured: false,
      clientId: null,
      clientSecret: null,
      redirectUri: null,
      errorCode: error.code || 'OAUTH_REDIRECT_URI_INVALID',
      reason: error.message
    };
  }
}

export function verifyGrantedGmailScopes(scopeInput) {
  const granted = Array.isArray(scopeInput)
    ? scopeInput.map(s => String(s || '').trim()).filter(Boolean)
    : String(scopeInput || '')
        .split(/[\s,]+/)
        .map(s => s.trim())
        .filter(Boolean);
  const grantedSet = new Set(granted);
  const missingScopes = GMAIL_OAUTH_SCOPES.filter(required => !grantedSet.has(required));
  return {
    ok: missingScopes.length === 0,
    grantedScopes: [...grantedSet],
    missingScopes
  };
}

export function parseCookieHeader(cookieHeader) {
  const cookies = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (name) cookies[name] = val;
  }
  return cookies;
}

export function buildGmailOAuthCookieHeader(nonce, env = process.env) {
  const isProduction = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';
  const parts = [
    `${GMAIL_OAUTH_STATE_COOKIE}=${nonce}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(STATE_TTL_MS / 1000)}`
  ];
  if (isProduction) parts.push('Secure');
  return parts.join('; ');
}

export function clearGmailOAuthCookieHeader(env = process.env) {
  const isProduction = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';
  const parts = [
    `${GMAIL_OAUTH_STATE_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0'
  ];
  if (isProduction) parts.push('Secure');
  return parts.join('; ');
}

export function createGmailOAuthAuthorizationRequest({
  adminUserId,
  redirectUri,
  env = process.env,
  keyValue = env.HOSTINGER_CONFIG_ENCRYPTION_KEY,
  now = Date.now()
} = {}) {
  const normalizedAdminId = String(adminUserId || '').trim();
  if (!normalizedAdminId) {
    throw createSanitizedOAuthError(
      'Authenticated administrator identity is required to start Gmail OAuth.',
      'OAUTH_ADMIN_REQUIRED',
      403
    );
  }

  const clientConfig = getGoogleOAuthClientConfig(env);
  if (!clientConfig.configured) {
    throw createSanitizedOAuthError(
      clientConfig.reason,
      clientConfig.errorCode || 'OAUTH_CLIENT_CREDENTIALS_MISSING',
      503
    );
  }

  const targetRedirectUri = redirectUri
    ? validateGoogleOAuthRedirectUri(redirectUri, env)
    : clientConfig.redirectUri;

  const nonce = randomBytes(32).toString('hex');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const expiresAt = now + STATE_TTL_MS;

  const encryptedEnvelope = encryptHostingerConfig({
    kind: 'gmail_oauth_state',
    version: 1,
    nonce,
    codeVerifier,
    adminUserId: normalizedAdminId,
    redirectUri: targetRedirectUri,
    issuedAt: now,
    expiresAt
  }, keyValue);

  const state = Buffer.from(JSON.stringify(encryptedEnvelope), 'utf8').toString('base64url');

  const params = new URLSearchParams({
    client_id: clientConfig.clientId,
    redirect_uri: targetRedirectUri,
    response_type: 'code',
    scope: GMAIL_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  return {
    authorizationUrl: `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`,
    state,
    nonce,
    csrfCookie: buildGmailOAuthCookieHeader(nonce, env),
    redirectUri: targetRedirectUri,
    scopes: [...GMAIL_OAUTH_SCOPES],
    expiresAt: new Date(expiresAt).toISOString()
  };
}

export function validateGmailOAuthState({
  state,
  expectedAdminUserId,
  cookieNonce = null,
  requireCookieNonce = false,
  env = process.env,
  keyValue = env.HOSTINGER_CONFIG_ENCRYPTION_KEY,
  now = Date.now()
} = {}) {
  const rawState = String(state || '').trim();
  if (!rawState) {
    throw createSanitizedOAuthError(
      'Missing OAuth state parameter.',
      'OAUTH_STATE_MISSING',
      400
    );
  }

  let envelope;
  try {
    const decoded = Buffer.from(rawState, 'base64url').toString('utf8');
    envelope = JSON.parse(decoded);
  } catch {
    throw createSanitizedOAuthError(
      'Invalid or malformed OAuth state parameter.',
      'OAUTH_STATE_INVALID',
      400
    );
  }

  let decrypted;
  try {
    decrypted = decryptHostingerConfig(envelope, keyValue);
  } catch (error) {
    if (error?.code === 'HOSTINGER_ENCRYPTION_KEY_NOT_CONFIGURED') throw error;
    throw createSanitizedOAuthError(
      'OAuth state verification failed; state signature is invalid.',
      'OAUTH_STATE_INVALID',
      400
    );
  }

  const payload = decrypted?.value;
  if (
    decrypted?.storage !== 'ENCRYPTED' ||
    !payload ||
    payload.kind !== 'gmail_oauth_state' ||
    payload.version !== 1 ||
    typeof payload.nonce !== 'string' ||
    typeof payload.codeVerifier !== 'string' ||
    !payload.adminUserId ||
    !payload.redirectUri
  ) {
    throw createSanitizedOAuthError(
      'OAuth state payload is invalid.',
      'OAUTH_STATE_INVALID',
      400
    );
  }

  if (!Number.isFinite(Number(payload.expiresAt)) || Number(payload.expiresAt) <= now) {
    throw createSanitizedOAuthError(
      'The OAuth authorization session has expired. Start a new Gmail connection request.',
      'OAUTH_STATE_EXPIRED',
      400
    );
  }

  if (
    !expectedAdminUserId ||
    String(payload.adminUserId).trim().toLowerCase() !== String(expectedAdminUserId).trim().toLowerCase()
  ) {
    throw createSanitizedOAuthError(
      'The OAuth state does not belong to the authenticated administrator.',
      'OAUTH_STATE_ADMIN_MISMATCH',
      403
    );
  }

  const validatedRedirectUri = validateGoogleOAuthRedirectUri(payload.redirectUri, env);

  if (requireCookieNonce || (cookieNonce !== null && cookieNonce !== undefined && String(cookieNonce).trim() !== '')) {
    const providedBuf = Buffer.from(String(cookieNonce || ''), 'utf8');
    const expectedBuf = Buffer.from(String(payload.nonce), 'utf8');
    if (providedBuf.length === 0 || providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      throw createSanitizedOAuthError(
        'OAuth CSRF nonce validation failed.',
        'OAUTH_CSRF_MISMATCH',
        400
      );
    }
  }

  return {
    nonce: payload.nonce,
    codeVerifier: payload.codeVerifier,
    adminUserId: payload.adminUserId,
    redirectUri: validatedRedirectUri,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt
  };
}

export async function fetchGmailUserProfile({ accessToken, fetchFn = globalThis.fetch }) {
  const token = String(accessToken || '').trim();
  if (!token) {
    throw createSanitizedOAuthError('Missing OAuth access token for profile check.', 'OAUTH_ACCESS_TOKEN_MISSING', 401);
  }

  let res;
  try {
    res = await fetchFn(`${GMAIL_API_BASE}/profile`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });
  } catch (error) {
    throw createSanitizedOAuthError(
      `Gmail API profile check failed due to a network error: ${error?.message || 'network failure'}`,
      'OAUTH_TRANSIENT_FAILURE',
      503,
      [token]
    );
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.status === 429) {
    throw createSanitizedOAuthError('Gmail API rate limit reached during profile verification.', 'OAUTH_RATE_LIMITED', 429, [token]);
  }
  if (res.status >= 500) {
    throw createSanitizedOAuthError('Gmail API is temporarily unavailable.', 'OAUTH_TRANSIENT_FAILURE', 503, [token]);
  }
  if (res.status === 401 || res.status === 403) {
    throw createSanitizedOAuthError(
      'Gmail API rejected the access token or required permissions are missing.',
      res.status === 401 ? 'OAUTH_TOKEN_UNAUTHORIZED' : 'OAUTH_INSUFFICIENT_SCOPES',
      res.status,
      [token]
    );
  }
  if (!res.ok || !body?.emailAddress) {
    throw createSanitizedOAuthError('Could not verify the Gmail mailbox profile.', 'OAUTH_PROFILE_FAILED', 502, [token]);
  }

  return {
    emailAddress: String(body.emailAddress).trim().toLowerCase(),
    messagesTotal: Number(body.messagesTotal) || 0,
    threadsTotal: Number(body.threadsTotal) || 0,
    historyId: body.historyId ? String(body.historyId) : null
  };
}

export async function exchangeGmailAuthorizationCode({
  code,
  state,
  oauthError = null,
  oauthErrorDescription = null,
  expectedAdminUserId,
  cookieNonce = null,
  requireCookieNonce = false,
  existingTokenRecord = null,
  fromName = 'Voyage International Business',
  env = process.env,
  keyValue = env.HOSTINGER_CONFIG_ENCRYPTION_KEY,
  fetchFn = globalThis.fetch,
  now = Date.now()
} = {}) {
  // Always validate state first to prevent CSRF via forged error callbacks
  const verifiedState = validateGmailOAuthState({
    state,
    expectedAdminUserId,
    cookieNonce,
    requireCookieNonce,
    env,
    keyValue,
    now
  });

  if (oauthError) {
    const errCode = String(oauthError).trim().toLowerCase();
    if (errCode === 'access_denied') {
      throw createSanitizedOAuthError(
        'Google authorization was cancelled or denied by the user.',
        'OAUTH_CONSENT_DENIED',
        400
      );
    }
    throw createSanitizedOAuthError(
      `Google authorization returned an error (${sanitizeOAuthText(oauthErrorDescription || oauthError)}).`,
      'OAUTH_CALLBACK_ERROR',
      400
    );
  }

  const authCode = String(code || '').trim();
  if (!authCode) {
    throw createSanitizedOAuthError(
      'Missing authorization code in Google OAuth callback.',
      'OAUTH_CODE_MISSING',
      400
    );
  }

  const clientConfig = getGoogleOAuthClientConfig(env);
  if (!clientConfig.configured) {
    throw createSanitizedOAuthError(
      clientConfig.reason,
      clientConfig.errorCode || 'OAUTH_CLIENT_CREDENTIALS_MISSING',
      503
    );
  }

  const tokenParams = new URLSearchParams({
    client_id: clientConfig.clientId,
    client_secret: clientConfig.clientSecret,
    code: authCode,
    code_verifier: verifiedState.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: verifiedState.redirectUri
  });

  let tokenRes;
  try {
    tokenRes = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: tokenParams.toString()
    });
  } catch (error) {
    throw createSanitizedOAuthError(
      `Google token endpoint request failed: ${error?.message || 'network failure'}`,
      'OAUTH_TRANSIENT_FAILURE',
      503,
      [clientConfig.clientSecret, authCode, verifiedState.codeVerifier]
    );
  }

  let tokenBody = null;
  try {
    tokenBody = await tokenRes.json();
  } catch {
    tokenBody = null;
  }

  if (tokenRes.status === 429) {
    throw createSanitizedOAuthError(
      'Google OAuth token endpoint rate limit exceeded. Wait before retrying.',
      'OAUTH_RATE_LIMITED',
      429,
      [clientConfig.clientSecret, authCode]
    );
  }
  if (tokenRes.status >= 500) {
    throw createSanitizedOAuthError(
      'Google OAuth token service is temporarily unavailable.',
      'OAUTH_TRANSIENT_FAILURE',
      503,
      [clientConfig.clientSecret, authCode]
    );
  }
  if (!tokenRes.ok || !tokenBody?.access_token) {
    const providerErr = String(tokenBody?.error || 'invalid_grant');
    throw createSanitizedOAuthError(
      `Google OAuth authorization code exchange failed (${providerErr}).`,
      'OAUTH_CODE_EXCHANGE_FAILED',
      400,
      [clientConfig.clientSecret, authCode, verifiedState.codeVerifier]
    );
  }

  const accessToken = String(tokenBody.access_token).trim();
  const refreshToken = String(tokenBody.refresh_token || existingTokenRecord?.refreshToken || '').trim();
  if (!refreshToken) {
    throw createSanitizedOAuthError(
      'Google did not return a refresh token. Re-authorize with offline access and consent prompt.',
      'OAUTH_REFRESH_TOKEN_MISSING',
      400,
      [accessToken, clientConfig.clientSecret]
    );
  }

  const scopeValue = tokenBody.scope || existingTokenRecord?.scope || '';
  const scopeCheck = verifyGrantedGmailScopes(scopeValue);
  if (!scopeCheck.ok) {
    throw createSanitizedOAuthError(
      `Google account authorization did not grant all required Gmail scopes. Missing: ${scopeCheck.missingScopes.join(', ')}.`,
      'OAUTH_INSUFFICIENT_SCOPES',
      400,
      [accessToken, refreshToken, clientConfig.clientSecret]
    );
  }

  const profile = await fetchGmailUserProfile({ accessToken, fetchFn });
  const expiresInSeconds = Number(tokenBody.expires_in) || 3599;
  const expiryDate = now + expiresInSeconds * 1000;
  const timestamp = new Date(now).toISOString();

  const tokenRecord = {
    provider: 'GMAIL_OAUTH',
    email: profile.emailAddress,
    fromEmail: profile.emailAddress,
    fromName: String(fromName || existingTokenRecord?.fromName || 'Voyage International Business').trim(),
    refreshToken,
    accessToken,
    expiryDate,
    scope: scopeCheck.grantedScopes.join(' '),
    tokenType: String(tokenBody.token_type || 'Bearer'),
    connectedAt: existingTokenRecord?.connectedAt || timestamp,
    updatedAt: timestamp
  };

  const encryptedRecord = encryptHostingerConfig(tokenRecord, keyValue);

  return {
    encryptedRecord,
    summary: {
      connected: true,
      status: 'AUTHORIZED',
      email: profile.emailAddress,
      fromName: tokenRecord.fromName,
      scopes: scopeCheck.grantedScopes,
      missingScopes: [],
      tokenStatus: 'VALID',
      credentialStorage: 'ENCRYPTED',
      connectedAt: tokenRecord.connectedAt,
      updatedAt: tokenRecord.updatedAt
    }
  };
}

export async function getValidGmailAccessToken({
  tokenRecord,
  env = process.env,
  fetchFn = globalThis.fetch,
  now = Date.now(),
  onTokenRefreshed = null
} = {}) {
  if (!tokenRecord || typeof tokenRecord !== 'object' || tokenRecord.disconnected) {
    throw createSanitizedOAuthError(
      'Gmail OAuth is not authorized. Complete administrator authorization first.',
      'OAUTH_NOT_AUTHORIZED',
      503
    );
  }

  const refreshToken = String(tokenRecord.refreshToken || '').trim();
  if (!refreshToken || isPlaceholderValue(refreshToken)) {
    throw createSanitizedOAuthError(
      'Gmail OAuth refresh token is missing. Re-authorize the Gmail account in Admin Settings.',
      'OAUTH_REFRESH_TOKEN_MISSING',
      503
    );
  }

  const scopeCheck = verifyGrantedGmailScopes(tokenRecord.scope);
  if (!scopeCheck.ok) {
    throw createSanitizedOAuthError(
      `Gmail OAuth is missing required scopes: ${scopeCheck.missingScopes.join(', ')}.`,
      'OAUTH_INSUFFICIENT_SCOPES',
      503,
      [refreshToken, tokenRecord.accessToken]
    );
  }

  const cachedAccess = String(tokenRecord.accessToken || '').trim();
  const cachedExpiry = Number(tokenRecord.expiryDate) || 0;
  if (cachedAccess && cachedExpiry - ACCESS_TOKEN_EXPIRY_BUFFER_MS > now) {
    return {
      accessToken: cachedAccess,
      expiryDate: cachedExpiry,
      scope: scopeCheck.grantedScopes,
      email: tokenRecord.email || null,
      refreshed: false
    };
  }

  const clientConfig = getGoogleOAuthClientConfig(env);
  if (!clientConfig.configured) {
    throw createSanitizedOAuthError(
      clientConfig.reason,
      clientConfig.errorCode || 'OAUTH_CLIENT_CREDENTIALS_MISSING',
      503,
      [refreshToken]
    );
  }

  const guardKey = tokenKeyHash(refreshToken);
  const existingGuard = refreshGuardMap.get(guardKey);

  if (existingGuard?.inFlightPromise) {
    return existingGuard.inFlightPromise;
  }

  if (existingGuard?.revoked) {
    throw createSanitizedOAuthError(
      'Gmail OAuth refresh token has been revoked or expired. Re-authorize the Gmail account in Admin Settings.',
      'OAUTH_TOKEN_REVOKED',
      503,
      [refreshToken]
    );
  }

  if (existingGuard?.lastFailureAt && now - existingGuard.lastFailureAt < REFRESH_COOLDOWN_MS) {
    throw createSanitizedOAuthError(
      'Gmail OAuth token refresh failed recently; backing off to prevent repeated refresh retries.',
      existingGuard.lastErrorCode || 'OAUTH_REFRESH_BACKOFF',
      503,
      [refreshToken]
    );
  }

  if (existingGuard?.cachedAccessToken && existingGuard.cachedExpiryDate - ACCESS_TOKEN_EXPIRY_BUFFER_MS > now) {
    return {
      accessToken: existingGuard.cachedAccessToken,
      expiryDate: existingGuard.cachedExpiryDate,
      scope: scopeCheck.grantedScopes,
      email: tokenRecord.email || null,
      refreshed: false
    };
  }

  const refreshOperation = (async () => {
    const params = new URLSearchParams({
      client_id: clientConfig.clientId,
      client_secret: clientConfig.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });

    let res;
    try {
      res = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body: params.toString()
      });
    } catch (error) {
      refreshGuardMap.set(guardKey, {
        lastFailureAt: now,
        lastErrorCode: 'OAUTH_TRANSIENT_FAILURE'
      });
      throw createSanitizedOAuthError(
        `Gmail OAuth token refresh failed due to a network error: ${error?.message || 'network failure'}`,
        'OAUTH_TRANSIENT_FAILURE',
        503,
        [refreshToken, clientConfig.clientSecret]
      );
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (res.status === 429) {
      refreshGuardMap.set(guardKey, {
        lastFailureAt: now,
        lastErrorCode: 'OAUTH_RATE_LIMITED'
      });
      throw createSanitizedOAuthError(
        'Google OAuth token refresh rate limit exceeded.',
        'OAUTH_RATE_LIMITED',
        429,
        [refreshToken, clientConfig.clientSecret]
      );
    }

    if (res.status >= 500) {
      refreshGuardMap.set(guardKey, {
        lastFailureAt: now,
        lastErrorCode: 'OAUTH_TRANSIENT_FAILURE'
      });
      throw createSanitizedOAuthError(
        'Google OAuth token endpoint is temporarily unavailable.',
        'OAUTH_TRANSIENT_FAILURE',
        503,
        [refreshToken, clientConfig.clientSecret]
      );
    }

    if (!res.ok || !body?.access_token) {
      const oauthErr = String(body?.error || '').toLowerCase();
      const isRevoked = oauthErr === 'invalid_grant' || res.status === 400 || res.status === 401;
      refreshGuardMap.set(guardKey, {
        revoked: isRevoked,
        lastFailureAt: now,
        lastErrorCode: isRevoked ? 'OAUTH_TOKEN_REVOKED' : 'OAUTH_REFRESH_FAILED'
      });
      throw createSanitizedOAuthError(
        isRevoked
          ? 'Gmail OAuth refresh token has been revoked or expired. Re-authorize the Gmail account in Admin Settings.'
          : 'Gmail OAuth access token refresh failed.',
        isRevoked ? 'OAUTH_TOKEN_REVOKED' : 'OAUTH_REFRESH_FAILED',
        503,
        [refreshToken, clientConfig.clientSecret]
      );
    }

    const newAccessToken = String(body.access_token).trim();
    const expiresIn = Number(body.expires_in) || 3599;
    const newExpiryDate = now + expiresIn * 1000;
    const updatedScope = body.scope ? String(body.scope) : tokenRecord.scope;
    const updatedScopeCheck = verifyGrantedGmailScopes(updatedScope);
    if (!updatedScopeCheck.ok) {
      refreshGuardMap.set(guardKey, {
        revoked: true,
        lastFailureAt: now,
        lastErrorCode: 'OAUTH_INSUFFICIENT_SCOPES'
      });
      throw createSanitizedOAuthError(
        `Refreshed Gmail token is missing required scopes: ${updatedScopeCheck.missingScopes.join(', ')}.`,
        'OAUTH_INSUFFICIENT_SCOPES',
        503,
        [newAccessToken, refreshToken, clientConfig.clientSecret]
      );
    }

    refreshGuardMap.set(guardKey, {
      cachedAccessToken: newAccessToken,
      cachedExpiryDate: newExpiryDate,
      lastFailureAt: null,
      revoked: false
    });

    tokenRecord.accessToken = newAccessToken;
    tokenRecord.expiryDate = newExpiryDate;
    tokenRecord.scope = updatedScopeCheck.grantedScopes.join(' ');
    tokenRecord.updatedAt = new Date(now).toISOString();

    if (typeof onTokenRefreshed === 'function') {
      try {
        await onTokenRefreshed({
          ...tokenRecord,
          accessToken: newAccessToken,
          expiryDate: newExpiryDate
        });
      } catch {
        // Non-fatal: in-memory refreshed token remains valid for the current operation
      }
    }

    return {
      accessToken: newAccessToken,
      expiryDate: newExpiryDate,
      scope: updatedScopeCheck.grantedScopes,
      email: tokenRecord.email || null,
      refreshed: true
    };
  })();

  refreshGuardMap.set(guardKey, { ...existingGuard, inFlightPromise: refreshOperation });
  try {
    return await refreshOperation;
  } finally {
    const current = refreshGuardMap.get(guardKey);
    if (current?.inFlightPromise === refreshOperation) {
      delete current.inFlightPromise;
    }
  }
}

export async function revokeGmailOAuthToken({
  tokenRecord,
  fetchFn = globalThis.fetch
} = {}) {
  const tokenToRevoke = String(tokenRecord?.refreshToken || tokenRecord?.accessToken || '').trim();
  if (!tokenToRevoke || isPlaceholderValue(tokenToRevoke)) {
    return { revoked: false, status: 'NO_TOKEN' };
  }

  const guardKey = tokenKeyHash(tokenRecord?.refreshToken || tokenToRevoke);
  refreshGuardMap.delete(guardKey);

  try {
    const res = await fetchFn(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ token: tokenToRevoke }).toString()
    });
    return {
      revoked: res.ok || res.status === 400,
      status: res.ok ? 'REVOKED' : 'REVOKE_ATTEMPTED'
    };
  } catch (error) {
    throw createSanitizedOAuthError(
      `Failed to contact Google token revocation endpoint: ${error?.message || 'network failure'}`,
      'OAUTH_REVOKE_FAILED',
      502,
      [tokenToRevoke]
    );
  }
}

function sanitizeHeaderValue(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function extractAddress(value) {
  const angle = String(value || '').match(/<([^>]+)>/)?.[1]?.trim();
  return (angle || String(value || '').trim()).toLowerCase();
}

export function buildRfc2822MimeMessage({
  from,
  to,
  subject,
  text,
  inReplyTo = null,
  references = null,
  messageId = null,
  date = new Date()
}) {
  const senderAddress = extractAddress(from);
  const recipientAddress = extractAddress(to);
  if (!isValidOutreachEmail(recipientAddress)) {
    throw Object.assign(new Error('Invalid recipient email address.'), {
      code: 'EENVELOPE',
      responseCode: 550,
      command: 'RCPT TO'
    });
  }

  const domainPart = senderAddress.includes('@') ? senderAddress.split('@')[1] : 'gmail.com';
  const rfcMessageId = messageId
    ? sanitizeHeaderValue(messageId)
    : `<${randomUUID()}@${domainPart}>`;

  const headers = [
    `From: ${sanitizeHeaderValue(from)}`,
    `To: ${recipientAddress}`,
    `Subject: ${sanitizeHeaderValue(subject)}`,
    `Date: ${new Date(date).toUTCString()}`,
    `Message-ID: ${rfcMessageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit'
  ];

  if (inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeaderValue(inReplyTo)}`);
  if (references) headers.push(`References: ${sanitizeHeaderValue(references)}`);

  const normalizedBody = String(text || '').replace(/\r?\n/g, '\r\n');
  const rawMime = `${headers.join('\r\n')}\r\n\r\n${normalizedBody}`;
  return {
    rawBase64Url: Buffer.from(rawMime, 'utf8').toString('base64url'),
    rfcMessageId,
    senderAddress,
    recipientAddress,
    rawMime
  };
}

export function createGmailApiTransport({
  oauthConfig,
  env = process.env,
  fetchFn = globalThis.fetch,
  nowFn = () => Date.now()
} = {}) {
  return {
    async verify() {
      const tokenState = await getValidGmailAccessToken({
        tokenRecord: oauthConfig,
        env,
        fetchFn,
        now: nowFn()
      });
      const profile = await fetchGmailUserProfile({
        accessToken: tokenState.accessToken,
        fetchFn
      });
      if (oauthConfig?.email && profile.emailAddress !== String(oauthConfig.email).trim().toLowerCase()) {
        throw createSanitizedOAuthError(
          'Authenticated Gmail profile does not match the configured OAuth mailbox address.',
          'OAUTH_MAILBOX_MISMATCH',
          403,
          [tokenState.accessToken]
        );
      }
      return true;
    },

    async sendMail(mailOptions = {}) {
      // Defense-in-depth safety gate: never allow outbound transmission when EMAIL_SENDING_ENABLED !== 'true'
      if (env.EMAIL_SENDING_ENABLED !== 'true') {
        throw Object.assign(
          new Error('Outbound email sending is disabled because EMAIL_SENDING_ENABLED is not true.'),
          { code: 'ECONNREFUSED', command: 'CONN' }
        );
      }

      // Pre-submission phase: obtain OAuth token and build MIME message BEFORE contacting Gmail send endpoint.
      // Any failure here is a definite pre-submission failure (no message was sent).
      let tokenState;
      try {
        tokenState = await getValidGmailAccessToken({
          tokenRecord: oauthConfig,
          env,
          fetchFn,
          now: nowFn()
        });
      } catch (authError) {
        throw Object.assign(
          new Error(sanitizeOAuthText(authError?.message || 'Gmail OAuth pre-submission authentication failed.')),
          { code: 'ECONNREFUSED', command: 'CONN', oauthCode: authError?.code || 'OAUTH_ERROR' }
        );
      }

      const fromHeader = mailOptions.from || (oauthConfig?.fromName && oauthConfig?.email
        ? `"${oauthConfig.fromName}" <${oauthConfig.email}>`
        : oauthConfig?.email || '');

      let mimePayload;
      try {
        mimePayload = buildRfc2822MimeMessage({
          from: fromHeader,
          to: mailOptions.to,
          subject: mailOptions.subject,
          text: mailOptions.text,
          inReplyTo: mailOptions.inReplyTo,
          references: mailOptions.references,
          messageId: mailOptions.messageId
        });
      } catch (validationError) {
        throw Object.assign(
          new Error(sanitizeOAuthText(validationError?.message || 'Invalid outbound message parameters.')),
          {
            code: 'EENVELOPE',
            responseCode: 550,
            command: 'RCPT TO'
          }
        );
      }

      const requestBody = { raw: mimePayload.rawBase64Url };
      if (mailOptions.gmailThreadId) {
        requestBody.threadId = String(mailOptions.gmailThreadId);
      }

      let res;
      try {
        res = await fetchFn(`${GMAIL_API_BASE}/messages/send`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenState.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(requestBody)
        });
      } catch (networkError) {
        // Submission was attempted over the network; outcome is uncertain.
        throw Object.assign(
          new Error(sanitizeOAuthText(networkError?.message || 'Network failure during Gmail API send.', [tokenState.accessToken])),
          { code: 'ETIMEDOUT', command: 'DATA' }
        );
      }

      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (res.ok && body?.id) {
        return {
          messageId: mimePayload.rfcMessageId,
          gmailMessageId: String(body.id),
          gmailThreadId: body.threadId ? String(body.threadId) : null,
          response: `250 2.0.0 OK Gmail API id=${body.id}`,
          responseCode: 250,
          command: 'DATA',
          accepted: [mimePayload.recipientAddress],
          rejected: [],
          envelope: {
            from: mimePayload.senderAddress,
            to: [mimePayload.recipientAddress]
          }
        };
      }

      // 400 / 401 / 403 / 404 indicate Gmail API definitively rejected the request without sending.
      if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
        const isRecipientIssue = res.status === 400;
        throw Object.assign(
          new Error('Gmail API definitively rejected the message before acceptance.'),
          {
            code: 'EGMAILREJECTED',
            responseCode: isRecipientIssue ? 550 : 554,
            command: isRecipientIssue ? 'RCPT TO' : 'DATA',
            rejected: isRecipientIssue ? [mimePayload.recipientAddress] : []
          }
        );
      }

      // 429 or 5xx after POST /messages/send is treated as uncertain acceptance (never auto-retry).
      throw Object.assign(
        new Error('Gmail API returned an ambiguous response during message transmission.'),
        { code: 'ETIMEDOUT', command: 'DATA' }
      );
    }
  };
}

export async function verifyGmailInboundConnection({
  oauthConfig,
  env = process.env,
  fetchFn = globalThis.fetch,
  nowFn = () => Date.now()
} = {}) {
  const tokenState = await getValidGmailAccessToken({
    tokenRecord: oauthConfig,
    env,
    fetchFn,
    now: nowFn()
  });
  const profile = await fetchGmailUserProfile({
    accessToken: tokenState.accessToken,
    fetchFn
  });
  return {
    connected: true,
    emailAddress: profile.emailAddress
  };
}

export async function fetchGmailInboundMessages({
  oauthConfig,
  env = process.env,
  fetchFn = globalThis.fetch,
  nowFn = () => Date.now(),
  maxResults = 50,
  query = 'in:inbox -from:me'
} = {}) {
  const tokenState = await getValidGmailAccessToken({
    tokenRecord: oauthConfig,
    env,
    fetchFn,
    now: nowFn()
  });

  const listParams = new URLSearchParams({
    q: query,
    maxResults: String(Math.min(Math.max(Number(maxResults) || 50, 1), 100))
  });

  const listRes = await fetchFn(`${GMAIL_API_BASE}/messages?${listParams.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tokenState.accessToken}`,
      Accept: 'application/json'
    }
  });

  if (listRes.status === 429) {
    throw createSanitizedOAuthError('Gmail API rate limit reached while listing inbox messages.', 'OAUTH_RATE_LIMITED', 429, [tokenState.accessToken]);
  }
  if (!listRes.ok) {
    throw createSanitizedOAuthError(
      `Gmail API message list request failed with HTTP ${listRes.status}.`,
      'GMAIL_INBOX_LIST_FAILED',
      502,
      [tokenState.accessToken]
    );
  }

  const listBody = await listRes.json();
  const summaries = Array.isArray(listBody?.messages) ? listBody.messages : [];
  const items = [];

  for (const item of summaries) {
    const gmailId = String(item?.id || '').trim();
    if (!gmailId) continue;

    const msgRes = await fetchFn(
      `${GMAIL_API_BASE}/messages/${encodeURIComponent(gmailId)}?format=raw`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokenState.accessToken}`,
          Accept: 'application/json'
        }
      }
    );

    if (!msgRes.ok) {
      throw createSanitizedOAuthError(
        `Gmail API message fetch failed with HTTP ${msgRes.status}.`,
        'GMAIL_INBOX_FETCH_FAILED',
        502,
        [tokenState.accessToken]
      );
    }

    const msgData = await msgRes.json();
    if (!msgData?.raw) continue;

    const rawBuffer = Buffer.from(String(msgData.raw), 'base64url');
    const internalDateMs = Number(msgData.internalDate);
    const receivedDate = Number.isFinite(internalDateMs) && internalDateMs > 0
      ? new Date(internalDateMs)
      : null;

    items.push({
      source: rawBuffer,
      gmailMessageId: String(msgData.id || gmailId),
      gmailThreadId: msgData.threadId ? String(msgData.threadId) : (item.threadId ? String(item.threadId) : null),
      labelIds: Array.isArray(msgData.labelIds) ? msgData.labelIds : [],
      envelope: {
        date: receivedDate
      }
    });
  }

  return items;
}

export function buildSanitizedGmailOAuthSummary({
  env = process.env,
  oauthRecord = null,
  credentialStorage = 'NOT_CONFIGURED',
  configurationError = null
} = {}) {
  const clientConfig = getGoogleOAuthClientConfig(env);
  const emailSendingEnabled = env.EMAIL_SENDING_ENABLED === 'true';

  if (configurationError) {
    return {
      provider: 'Gmail API (OAuth 2.0)',
      clientConfigured: clientConfig.configured,
      connected: false,
      status: 'CONFIGURATION_ERROR',
      errorCode: configurationError.code || 'CONFIGURATION_ERROR',
      reason: sanitizeOAuthText(configurationError.message || 'Gmail OAuth configuration could not be verified.'),
      email: null,
      scopes: [],
      requiredScopes: [...GMAIL_OAUTH_SCOPES],
      missingScopes: [...GMAIL_OAUTH_SCOPES],
      credentialStorage,
      emailSendingEnabled
    };
  }

  if (!clientConfig.configured) {
    return {
      provider: 'Gmail API (OAuth 2.0)',
      clientConfigured: false,
      connected: false,
      status: 'NOT_CONFIGURED',
      errorCode: clientConfig.errorCode,
      reason: clientConfig.reason,
      email: null,
      scopes: [],
      requiredScopes: [...GMAIL_OAUTH_SCOPES],
      missingScopes: [...GMAIL_OAUTH_SCOPES],
      credentialStorage,
      emailSendingEnabled
    };
  }

  if (!oauthRecord || typeof oauthRecord !== 'object' || oauthRecord.disconnected) {
    return {
      provider: 'Gmail API (OAuth 2.0)',
      clientConfigured: true,
      redirectUri: clientConfig.redirectUri,
      connected: false,
      status: 'AUTHORIZATION_REQUIRED',
      errorCode: 'OAUTH_REFRESH_TOKEN_MISSING',
      reason: 'Gmail OAuth 2.0 client credentials are configured. Complete administrator Google authorization to store an encrypted refresh token.',
      email: null,
      scopes: [],
      requiredScopes: [...GMAIL_OAUTH_SCOPES],
      missingScopes: [...GMAIL_OAUTH_SCOPES],
      credentialStorage,
      emailSendingEnabled
    };
  }

  const hasRefreshToken = Boolean(String(oauthRecord.refreshToken || '').trim() && !isPlaceholderValue(oauthRecord.refreshToken));
  const scopeCheck = verifyGrantedGmailScopes(oauthRecord.scope);

  if (!hasRefreshToken) {
    return {
      provider: 'Gmail API (OAuth 2.0)',
      clientConfigured: true,
      redirectUri: clientConfig.redirectUri,
      connected: false,
      status: 'REFRESH_TOKEN_MISSING',
      errorCode: 'OAUTH_REFRESH_TOKEN_MISSING',
      reason: 'Stored Gmail OAuth configuration is missing a refresh token. Re-authorize with offline consent.',
      email: oauthRecord.email || null,
      scopes: scopeCheck.grantedScopes,
      requiredScopes: [...GMAIL_OAUTH_SCOPES],
      missingScopes: scopeCheck.missingScopes,
      credentialStorage,
      emailSendingEnabled
    };
  }

  if (!scopeCheck.ok) {
    return {
      provider: 'Gmail API (OAuth 2.0)',
      clientConfigured: true,
      redirectUri: clientConfig.redirectUri,
      connected: false,
      status: 'INSUFFICIENT_SCOPES',
      errorCode: 'OAUTH_INSUFFICIENT_SCOPES',
      reason: `Stored Gmail OAuth authorization is missing required scopes: ${scopeCheck.missingScopes.join(', ')}.`,
      email: oauthRecord.email || null,
      scopes: scopeCheck.grantedScopes,
      requiredScopes: [...GMAIL_OAUTH_SCOPES],
      missingScopes: scopeCheck.missingScopes,
      credentialStorage,
      emailSendingEnabled
    };
  }

  return {
    provider: 'Gmail API (OAuth 2.0)',
    clientConfigured: true,
    redirectUri: clientConfig.redirectUri,
    connected: true,
    status: 'AUTHORIZED',
    errorCode: null,
    reason: null,
    email: oauthRecord.email || null,
    fromName: oauthRecord.fromName || 'Voyage International Business',
    scopes: scopeCheck.grantedScopes,
    requiredScopes: [...GMAIL_OAUTH_SCOPES],
    missingScopes: [],
    credentialStorage,
    connectedAt: oauthRecord.connectedAt || null,
    updatedAt: oauthRecord.updatedAt || null,
    emailSendingEnabled
  };
}
