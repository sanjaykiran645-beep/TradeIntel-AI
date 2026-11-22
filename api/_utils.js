import database from './_db-client.js';
import supabaseAuth, { authConfigured } from './_auth-client.js';
import { decryptHostingerConfig } from './_hostinger-crypto.js';
import {
  GMAIL_OAUTH_SETTINGS_KEY,
  buildSanitizedGmailOAuthSummary,
  isGmailOAuthModeRequested
} from './_gmail-oauth.js';

const DATABASE_TIMEOUT_CODES = new Set(['57014']);
const DATABASE_UNAVAILABLE_CODES = new Set(['PGRST002', '57P03', '57P01', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']);
const DATABASE_SCHEMA_CODES = new Set(['42P01', '42703', '42804', 'PGRST204', 'PGRST205', 'PGRST206']);
const SUPABASE_USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeDatabaseError(error, fallbackMessage = 'Database request failed.', fallbackCode = 'DATABASE_ERROR') {
  const sourceCode = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').trim();
  const lowered = message.toLowerCase();
  const status = Number(error?.status) || 0;

  let code = sourceCode || fallbackCode;
  let httpStatus = status >= 400 && status <= 599 ? status : 500;

  if (sourceCode === 'DATABASE_TIMEOUT' || DATABASE_TIMEOUT_CODES.has(sourceCode) || /statement timeout|canceling statement|cancelling statement/i.test(message)) {
    code = 'DATABASE_TIMEOUT';
    httpStatus = 504;
  } else if (
    DATABASE_UNAVAILABLE_CODES.has(sourceCode) ||
    (status >= 502 && (!sourceCode || sourceCode.startsWith('PGRST') || sourceCode.startsWith('DATABASE_'))) ||
    /fetch failed|network error|connection refused|socket hang up/i.test(lowered)
  ) {
    code = 'DATABASE_UNAVAILABLE';
    httpStatus = 503;
  } else if (DATABASE_SCHEMA_CODES.has(sourceCode)) {
    code = 'DATABASE_SCHEMA_ERROR';
    httpStatus = 500;
  }

  const normalized = new Error(message || `${fallbackMessage} (${code}).`);
  normalized.code = code;
  normalized.status = httpStatus;
  if (error?.details) normalized.details = error.details;
  if (error?.hint) normalized.hint = error.hint;
  return normalized;
}

export function isDatabaseFailure(error) {
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status) || 0;
  const message = String(error?.message || '').toLowerCase();
  return DATABASE_TIMEOUT_CODES.has(code) ||
    DATABASE_UNAVAILABLE_CODES.has(code) ||
    DATABASE_SCHEMA_CODES.has(code) ||
    /^PGRST/.test(code) || /^57P/.test(code) || /^42/.test(code) || /^427/.test(code) ||
    status >= 500 ||
    /fetch failed|network error|connection refused|socket hang up/i.test(message);
}

export function apiErrorResponse(res, error, fallbackCode = 'API_ERROR') {
  const normalized = normalizeDatabaseError(error, 'API request failed.', fallbackCode);
  const code = normalized.code || fallbackCode;
  const status = Number(normalized.status) >= 400 && Number(normalized.status) <= 599
    ? normalized.status
    : 500;
  return res.status(status).json({
    success: false,
    error: normalized.message || `${fallbackCode}.`,
    code,
    ...(normalized.details ? { details: normalized.details } : {}),
    ...(normalized.hint ? { hint: normalized.hint } : {})
  });
}

const LOCAL_DEV_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * Returns the request Origin only when it is explicitly allowed.
 * The application frontend calls relative /api URLs (same-origin), so no CORS header is
 * needed for normal operation. Cross-origin access is granted only to origins listed in
 * CORS_ALLOWED_ORIGINS (comma separated), plus localhost origins outside production.
 */
export function resolveAllowedCorsOrigin(origin, env = process.env) {
  const candidate = String(origin || '').trim();
  if (!candidate) return null;
  const configured = String(env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim().replace(/\/+$/, ''))
    .filter(value => value && value !== '*');
  if (configured.includes(candidate.replace(/\/+$/, ''))) return candidate;
  const isProduction = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';
  if (!isProduction && LOCAL_DEV_ORIGIN_PATTERN.test(candidate)) return candidate;
  return null;
}

export function setCors(res) {
  // Responses vary by Origin; never emit a wildcard.
  res.setHeader('Vary', 'Origin');
  const allowedOrigin = resolveAllowedCorsOrigin(res.req?.headers?.origin);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
}

export async function requireAuth(req, res, { adminOnly = false } = {}) {
  const configuredAdminId = String(process.env.ADMIN_SUPABASE_USER_ID || '').trim();
  if (!configuredAdminId) {
    res.status(503).json({
      success: false,
      error: 'The designated administrator identity is not configured on the server.',
      code: 'ADMIN_ID_NOT_CONFIGURED'
    });
    return false;
  }
  if (!SUPABASE_USER_ID_PATTERN.test(configuredAdminId)) {
    res.status(503).json({
      success: false,
      error: 'The designated administrator identity configuration is invalid.',
      code: 'ADMIN_ID_CONFIGURATION_INVALID'
    });
    return false;
  }

  if (!authConfigured) {
    res.status(503).json({
      success: false,
      error: 'The existing authentication provider is not configured.',
      code: 'AUTH_PROVIDER_NOT_CONFIGURED'
    });
    return false;
  }

  const authorization = req.headers?.authorization || '';
  const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];

  if (!token) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
      code: 'AUTHENTICATION_REQUIRED'
    });
    return false;
  }

  let user;

  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);

    if (error) {
      const normalized = normalizeDatabaseError(error, 'Supabase authentication service is unavailable.');
      if (normalized.code.startsWith('DATABASE_')) {
        res.status(normalized.status || 503).json({
          success: false,
          error: normalized.message,
          code: normalized.code
        });
        return false;
      }
    }

    if (error || !data.user) {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired session',
        code: 'INVALID_SESSION'
      });
      return false;
    }

    user = data.user;
  } catch (error) {
    const normalized = normalizeDatabaseError(error, 'Supabase authentication service is unavailable.');
    res.status(normalized.status || 503).json({
      success: false,
      error: normalized.message,
      code: normalized.code
    });
    return false;
  }

  if (
    String(user.id || '').toLowerCase() !== configuredAdminId.toLowerCase() ||
    user.app_metadata?.role !== 'admin'
  ) {
    res.status(403).json({
      success: false,
      error: 'The designated administrator account is required.',
      code: 'FORBIDDEN'
    });
    return false;
  }

  if (adminOnly && user.app_metadata?.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Administrator access required',
      code: 'FORBIDDEN'
    });
    return false;
  }

  req.user = user;
  return true;
}

export async function logAudit(
  userEmail,
  action,
  entityType,
  entityId,
  details = {},
  ip = '127.0.0.1'
) {
  try {
    const { error } = await database.from('audit_logs').insert({
      user_email: userEmail || 'system@voyageib.com',
      action,
      entity_type: entityType,
      entity_id: String(entityId || ''),
      details,
      ip_address: ip,
      created_at: new Date().toISOString()
    });
    if (error) {
      console.error(`[AUDIT] write failed action=${action} code=${normalizeDatabaseError(error).code}`);
      return { persisted: false, code: normalizeDatabaseError(error).code };
    }
    return { persisted: true };
  } catch (err) {
    console.error(`[AUDIT] write failed action=${action} code=${normalizeDatabaseError(err).code}`);
    return { persisted: false, code: normalizeDatabaseError(err).code };
  }
}

export async function getHostingerConfig({ env = process.env, databaseClient = database } = {}) {
  const envSmtp = {
    host: env.HOSTINGER_SMTP_HOST,
    port: env.HOSTINGER_SMTP_PORT,
    user: env.HOSTINGER_SMTP_USER,
    pass: env.HOSTINGER_SMTP_PASS
  };
  const envImap = {
    host: env.HOSTINGER_IMAP_HOST,
    port: env.HOSTINGER_IMAP_PORT,
    user: env.HOSTINGER_IMAP_USER,
    pass: env.HOSTINGER_IMAP_PASS
  };

  let databaseConfig = null;
  let credentialStorage = 'NOT_CONFIGURED';
  let oauthDatabaseConfig = null;
  let oauthCredentialStorage = 'NOT_CONFIGURED';
  let configurationError = null;
  try {
    const { data, error } = await databaseClient
      .from('system_settings')
      .select('value')
      .eq('key', 'hostinger_config')
      .maybeSingle();

    if (error) throw error;
    if (data?.value && typeof data.value === 'object') {
      const decrypted = decryptHostingerConfig(data.value, env.HOSTINGER_CONFIG_ENCRYPTION_KEY);
      databaseConfig = decrypted.value;
      credentialStorage = decrypted.storage;
    }

    const { data: oauthData, error: oauthError } = await databaseClient
      .from('system_settings')
      .select('value')
      .eq('key', GMAIL_OAUTH_SETTINGS_KEY)
      .maybeSingle();

    if (oauthError) throw oauthError;
    if (oauthData?.value && typeof oauthData.value === 'object') {
      const decryptedOAuth = decryptHostingerConfig(oauthData.value, env.HOSTINGER_CONFIG_ENCRYPTION_KEY);
      oauthDatabaseConfig = decryptedOAuth.value;
      oauthCredentialStorage = decryptedOAuth.storage;
    }
  } catch (err) {
    configurationError = normalizeDatabaseError(err, 'Could not read email configuration.');
    console.warn(`[HOSTINGER CONFIG] configuration read failed code=${configurationError.code}`);
  }

  const gmailOAuth = buildSanitizedGmailOAuthSummary({
    env,
    oauthRecord: oauthDatabaseConfig,
    credentialStorage: oauthCredentialStorage,
    configurationError
  });

  // When Gmail OAuth 2.0 mode is active, never silently downgrade to an App Password or unauthenticated SMTP/IMAP.
  if (isGmailOAuthModeRequested(env, oauthDatabaseConfig)) {
    const oauthReady = Boolean(!configurationError && gmailOAuth.connected && oauthDatabaseConfig);
    const oauthEmail = oauthReady ? String(oauthDatabaseConfig.email || '').trim().toLowerCase() : null;
    const fromEmail = oauthReady ? String(oauthDatabaseConfig.fromEmail || oauthEmail).trim().toLowerCase() : null;
    const fromName = oauthReady ? String(oauthDatabaseConfig.fromName || 'Voyage International Business').trim() : null;

    const smtp = oauthReady ? {
      provider: 'GMAIL_OAUTH',
      host: 'gmail.googleapis.com',
      port: 443,
      secure: true,
      user: oauthEmail,
      pass: null,
      fromEmail,
      fromName,
      oauth: oauthDatabaseConfig
    } : null;

    const imap = oauthReady ? {
      provider: 'GMAIL_OAUTH',
      host: 'gmail.googleapis.com',
      port: 443,
      secure: true,
      user: oauthEmail,
      pass: null,
      credentialSource: 'GMAIL_OAUTH',
      oauth: oauthDatabaseConfig
    } : null;

    const oauthBlockerReason = oauthReady
      ? null
      : configurationError
        ? `Gmail OAuth configuration could not be verified (${configurationError.code}).`
        : gmailOAuth.reason || 'Gmail OAuth 2.0 authorization is incomplete.';

    return {
      provider: 'GMAIL_OAUTH',
      configured: oauthReady,
      smtpConfigured: oauthReady,
      imapConfigured: oauthReady,
      credentialStorage: oauthCredentialStorage,
      databaseStatus: configurationError?.code.startsWith('DATABASE_') ? configurationError.code : 'AVAILABLE',
      configurationError: configurationError ? {
        code: configurationError.code,
        status: configurationError.status,
        message: configurationError.message
      } : null,
      source: oauthReady ? 'GMAIL_OAUTH_SETTINGS' : 'GMAIL_OAUTH',
      smtp,
      imap,
      gmailOAuth,
      reason: oauthBlockerReason,
      smtpReason: oauthBlockerReason,
      imapReason: oauthBlockerReason
    };
  }

  const smtpUser = envSmtp.user || databaseConfig?.smtpUser;
  const smtpPass = envSmtp.pass || databaseConfig?.smtpPass;
  const smtpConfigured = Boolean(smtpUser && smtpPass);
  const smtp = smtpConfigured ? {
    provider: 'HOSTINGER',
    host: envSmtp.host || databaseConfig?.smtpHost || 'smtp.hostinger.com',
    port: Number(envSmtp.port || databaseConfig?.smtpPort) || 465,
    secure: Number(envSmtp.port || databaseConfig?.smtpPort) === 587 ? false : true,
    user: smtpUser,
    pass: smtpPass,
    fromEmail: databaseConfig?.fromEmail || smtpUser,
    fromName: databaseConfig?.fromName || 'Voyage International Business'
  } : null;

  const explicitImapUser = envImap.user || databaseConfig?.imapUser;
  const explicitImapPass = envImap.pass || databaseConfig?.imapPass;
  const imapUser = explicitImapUser || smtpUser;
  const imapPass = explicitImapPass || smtpPass;
  const imapConfigured = Boolean(imapUser && imapPass);
  const imap = imapConfigured ? {
    provider: 'HOSTINGER',
    host: envImap.host || databaseConfig?.imapHost || 'imap.hostinger.com',
    port: Number(envImap.port || databaseConfig?.imapPort) || 993,
    secure: true,
    user: imapUser,
    pass: imapPass,
    credentialSource: explicitImapUser && explicitImapPass
      ? (envImap.user && envImap.pass ? 'ENV_IMAP' : 'DATABASE_IMAP')
      : smtpUser && smtpPass
        ? (envSmtp.user && envSmtp.pass ? 'ENV_SMTP_FALLBACK' : 'DATABASE_SMTP_FALLBACK')
        : null
  } : null;

  return {
    provider: 'HOSTINGER',
    configured: smtpConfigured,
    smtpConfigured,
    imapConfigured,
    credentialStorage,
    databaseStatus: configurationError?.code.startsWith('DATABASE_') ? configurationError.code : 'AVAILABLE',
    configurationError: configurationError ? {
      code: configurationError.code,
      status: configurationError.status,
      message: configurationError.message
    } : null,
    source: envSmtp.user && envSmtp.pass || envImap.user && envImap.pass ? 'ENV' : databaseConfig ? 'DATABASE_SETTINGS' : null,
    smtp,
    imap,
    gmailOAuth,
    reason: smtpConfigured || imapConfigured
      ? null
      : configurationError
        ? `Hostinger configuration could not be verified (${configurationError.code}).`
        : 'Hostinger SMTP and IMAP credentials are not configured in environment or database settings.',
    smtpReason: smtpConfigured ? null : configurationError
      ? `Hostinger SMTP configuration could not be verified (${configurationError.code}).`
      : 'Hostinger SMTP credentials are not configured in environment or database settings.',
    imapReason: imapConfigured ? null : configurationError
      ? `Hostinger IMAP configuration could not be verified (${configurationError.code}).`
      : 'Hostinger IMAP credentials are not configured in environment or database settings.'
  };
}
