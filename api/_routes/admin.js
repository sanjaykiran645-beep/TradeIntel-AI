import supabase from '../_db-client.js';
import { decryptHostingerConfig, encryptHostingerConfig } from '../_hostinger-crypto.js';
import { apiErrorResponse, normalizeDatabaseError, setCors, logAudit, getHostingerConfig, requireAuth } from '../_utils.js';
import { getProviderCapabilities } from '../_provider-capabilities.js';
import {
  GMAIL_OAUTH_SETTINGS_KEY,
  GMAIL_OAUTH_STATE_COOKIE,
  buildSanitizedGmailOAuthSummary,
  clearGmailOAuthCookieHeader,
  createGmailOAuthAuthorizationRequest,
  exchangeGmailAuthorizationCode,
  fetchGmailUserProfile,
  getValidGmailAccessToken,
  parseCookieHeader,
  revokeGmailOAuthToken,
  sanitizeOAuthText
} from '../_gmail-oauth.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!(await requireAuth(req, res, { adminOnly: true }))) return;

  try {
    if (req.method === 'GET') {
      const { section } = req.query;

      if (section === 'audit') {
        const { data, error } = await supabase
          .from('audit_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(100);
        if (error) throw error;
        return res.status(200).json(data || []);
      }

      // Fetch all system settings
      const { data: settings, error: settingsError } = await supabase.from('system_settings').select('*');
      if (settingsError) throw settingsError;
      const hostinger = await getHostingerConfig();
      const providers = await getProviderCapabilities(hostinger);

      const settingsMap = {};
      (settings || []).forEach(s => {
        if (s.key === 'hostinger_config') {
          settingsMap[s.key] = {
            configured: hostinger.configured,
            credentialStorage: hostinger.credentialStorage,
            host: hostinger.smtp?.host || null,
            port: hostinger.smtp?.port || null,
            user: hostinger.smtp?.user || null,
            fromEmail: hostinger.smtp?.fromEmail || null
          };
        } else if (s.key === GMAIL_OAUTH_SETTINGS_KEY) {
          settingsMap[s.key] = hostinger.gmailOAuth || {
            connected: false,
            status: 'NOT_CONFIGURED'
          };
        } else {
          settingsMap[s.key] = s.value;
        }
      });

      const automaticSendingEnabled = process.env.EMAIL_SENDING_ENABLED === 'true' && hostinger.smtpConfigured;
      const emailMode = automaticSendingEnabled
        ? (hostinger.provider === 'GMAIL_OAUTH' ? 'GMAIL OAUTH MODE' : 'HOSTINGER SMTP MODE')
        : 'MANUAL GMAIL MODE';

      return res.status(200).json({
        ok: true,
        emailMode,
        manualGmailMode: !automaticSendingEnabled,
        automaticEmailSendingEnabled: automaticSendingEnabled,
        settings: settingsMap,
        providers,
        emailProvider: hostinger.provider || 'HOSTINGER',
        gmailOAuth: hostinger.gmailOAuth || null,
        hostingerStatus: hostinger.configurationError?.code || (hostinger.configured ? 'CONFIGURED' : 'NOT CONFIGURED'),
        credentialStorage: hostinger.credentialStorage,
        hostingerDetails: hostinger.configured ? {
          provider: hostinger.provider || 'HOSTINGER',
          host: hostinger.smtp.host,
          port: hostinger.smtp.port,
          user: hostinger.smtp.user,
          fromEmail: hostinger.smtp.fromEmail,
          fromName: hostinger.smtp.fromName
        } : { reason: hostinger.reason },
        limits: settingsMap.sending_limits || {
          dailyMax: 100,
          hourlyMax: 20,
          cooldownSeconds: 60,
          approvalMode: 'SUPERVISED' // Response drafts still require explicit human approval.
        }
      });
    }

    if (req.method === 'POST') {
      const { action, payload } = req.body || {};

      if (action === 'START_GMAIL_OAUTH') {
        const authRequest = createGmailOAuthAuthorizationRequest({
          adminUserId: req.user?.id,
          redirectUri: payload?.redirectUri
        });
        res.setHeader('Set-Cookie', authRequest.csrfCookie);
        await logAudit(req.user?.email, 'START_GMAIL_OAUTH', 'system_settings', GMAIL_OAUTH_SETTINGS_KEY, {
          redirectUri: authRequest.redirectUri,
          scopes: authRequest.scopes
        });
        return res.status(200).json({
          ok: true,
          authorizationUrl: authRequest.authorizationUrl,
          redirectUri: authRequest.redirectUri,
          scopes: authRequest.scopes,
          expiresAt: authRequest.expiresAt
        });
      }

      if (action === 'COMPLETE_GMAIL_OAUTH') {
        res.setHeader('Set-Cookie', clearGmailOAuthCookieHeader());
        const cookies = parseCookieHeader(req.headers?.cookie);
        const cookieNonce = cookies[GMAIL_OAUTH_STATE_COOKIE] || payload?.csrfNonce || null;

        let existingTokenRecord = null;
        const { data: existingRow, error: existingErr } = await supabase
          .from('system_settings')
          .select('value')
          .eq('key', GMAIL_OAUTH_SETTINGS_KEY)
          .maybeSingle();
        if (existingErr) throw existingErr;
        if (existingRow?.value && typeof existingRow.value === 'object') {
          const decrypted = decryptHostingerConfig(existingRow.value);
          existingTokenRecord = decrypted.value;
        }

        const exchanged = await exchangeGmailAuthorizationCode({
          code: payload?.code,
          state: payload?.state,
          oauthError: payload?.error,
          oauthErrorDescription: payload?.errorDescription,
          expectedAdminUserId: req.user?.id,
          cookieNonce,
          existingTokenRecord,
          fromName: payload?.fromName || existingTokenRecord?.fromName || 'Voyage International Business'
        });

        const { data: savedRow, error: saveErr } = await supabase
          .from('system_settings')
          .upsert({
            category: 'gmail_oauth',
            key: GMAIL_OAUTH_SETTINGS_KEY,
            value: exchanged.encryptedRecord,
            updated_at: new Date().toISOString()
          }, { onConflict: 'key' })
          .select()
          .single();
        if (saveErr) throw saveErr;

        await logAudit(req.user?.email, 'COMPLETE_GMAIL_OAUTH', 'system_settings', savedRow.id, {
          email: exchanged.summary.email,
          scopes: exchanged.summary.scopes
        });

        return res.status(200).json({
          ok: true,
          message: 'Gmail OAuth 2.0 authorization verified and encrypted on the server.',
          gmailOAuth: exchanged.summary
        });
      }

      if (action === 'CHECK_GMAIL_OAUTH') {
        const { data: oauthRow, error: oauthErr } = await supabase
          .from('system_settings')
          .select('id,value')
          .eq('key', GMAIL_OAUTH_SETTINGS_KEY)
          .maybeSingle();
        if (oauthErr) throw oauthErr;

        let oauthRecord = null;
        let storageType = 'NOT_CONFIGURED';
        if (oauthRow?.value && typeof oauthRow.value === 'object') {
          const decrypted = decryptHostingerConfig(oauthRow.value);
          oauthRecord = decrypted.value;
          storageType = decrypted.storage;
        }

        const baseSummary = buildSanitizedGmailOAuthSummary({
          oauthRecord,
          credentialStorage: storageType
        });

        if (!baseSummary.connected) {
          return res.status(200).json({
            ok: false,
            gmailOAuth: {
              ...baseSummary,
              tokenStatus: 'NOT_VERIFIED'
            }
          });
        }

        const tokenState = await getValidGmailAccessToken({
          tokenRecord: oauthRecord,
          onTokenRefreshed: async updatedRecord => {
            const encryptedUpdated = encryptHostingerConfig(updatedRecord);
            await supabase
              .from('system_settings')
              .upsert({
                category: 'gmail_oauth',
                key: GMAIL_OAUTH_SETTINGS_KEY,
                value: encryptedUpdated,
                updated_at: new Date().toISOString()
              }, { onConflict: 'key' });
          }
        });

        const profile = await fetchGmailUserProfile({ accessToken: tokenState.accessToken });
        return res.status(200).json({
          ok: true,
          gmailOAuth: {
            ...baseSummary,
            email: profile.emailAddress,
            tokenStatus: 'VERIFIED_VALID',
            checkedAt: new Date().toISOString()
          }
        });
      }

      if (action === 'DISCONNECT_GMAIL_OAUTH') {
        const { data: oauthRow, error: oauthErr } = await supabase
          .from('system_settings')
          .select('id,value')
          .eq('key', GMAIL_OAUTH_SETTINGS_KEY)
          .maybeSingle();
        if (oauthErr) throw oauthErr;

        let oauthRecord = null;
        if (oauthRow?.value && typeof oauthRow.value === 'object') {
          try {
            const decrypted = decryptHostingerConfig(oauthRow.value);
            oauthRecord = decrypted.value;
          } catch {
            oauthRecord = null;
          }
        }

        let revokeResult = { revoked: false, status: 'NO_TOKEN' };
        if (oauthRecord) {
          try {
            revokeResult = await revokeGmailOAuthToken({ tokenRecord: oauthRecord });
          } catch {
            revokeResult = { revoked: false, status: 'REVOKE_FAILED_CLEARED_LOCALLY' };
          }
        }

        const disconnectedEnvelope = encryptHostingerConfig({
          provider: 'GMAIL_OAUTH',
          disconnected: true,
          updatedAt: new Date().toISOString()
        });

        const { data: updatedRow, error: updateErr } = await supabase
          .from('system_settings')
          .upsert({
            category: 'gmail_oauth',
            key: GMAIL_OAUTH_SETTINGS_KEY,
            value: disconnectedEnvelope,
            updated_at: new Date().toISOString()
          }, { onConflict: 'key' })
          .select()
          .single();
        if (updateErr) throw updateErr;

        await logAudit(req.user?.email, 'DISCONNECT_GMAIL_OAUTH', 'system_settings', updatedRow.id, {
          revocationStatus: revokeResult.status
        });

        return res.status(200).json({
          ok: true,
          message: 'Gmail OAuth integration disconnected and token revoked.',
          gmailOAuth: {
            connected: false,
            status: 'DISCONNECTED',
            revocationStatus: revokeResult.status
          }
        });
      }

      if (action === 'SAVE_HOSTINGER') {
        const { smtpHost, smtpPort, smtpUser, smtpPass, imapHost, imapPort, imapUser, imapPass, fromName, fromEmail } = payload;
        
        const hostingerValue = {
          smtpHost: smtpHost || 'smtp.hostinger.com',
          smtpPort: smtpPort || 465,
          smtpUser: smtpUser?.trim(),
          smtpPass: smtpPass?.trim(),
          imapHost: imapHost || 'imap.hostinger.com',
          imapPort: imapPort || 993,
          imapUser: imapUser?.trim() || smtpUser?.trim(),
          imapPass: imapPass?.trim() || smtpPass?.trim(),
          fromName: fromName || 'Voyage International Business',
          fromEmail: fromEmail?.trim() || smtpUser?.trim(),
          updatedAt: new Date().toISOString()
        };
        const encryptedValue = encryptHostingerConfig(hostingerValue);

        const { data, error } = await supabase
          .from('system_settings')
          .upsert({
            category: 'hostinger',
            key: 'hostinger_config',
            value: encryptedValue,
            updated_at: new Date().toISOString()
          }, { onConflict: 'key' })
          .select()
          .single();

        if (error) throw error;
        await logAudit(req.user?.email, 'SAVE_HOSTINGER_SETTINGS', 'system_settings', data.id, { user: smtpUser });

        return res.status(200).json({ ok: true, message: 'Hostinger configuration saved successfully' });
      }

      if (action === 'SAVE_LIMITS') {
        const { dailyMax, hourlyMax, approvalMode } = payload || {};
        const parsedDaily = Number(dailyMax);
        const parsedHourly = Number(hourlyMax);
        if (!Number.isSafeInteger(parsedDaily) || parsedDaily < 1) {
          return res.status(400).json({ error: 'dailyMax must be a positive integer.' });
        }
        if (!Number.isSafeInteger(parsedHourly) || parsedHourly < 1) {
          return res.status(400).json({ error: 'hourlyMax must be a positive integer.' });
        }
        const validModes = ['MANUAL', 'SUPERVISED', 'AUTHORIZED_AUTOMATION'];
        if (approvalMode && !validModes.includes(approvalMode)) {
          return res.status(400).json({ error: `approvalMode must be one of: ${validModes.join(', ')}.` });
        }
        const limitsValue = {
          dailyMax: parsedDaily,
          hourlyMax: parsedHourly,
          approvalMode: approvalMode || 'SUPERVISED'
        };
        const { data, error } = await supabase
          .from('system_settings')
          .upsert({
            category: 'limits',
            key: 'sending_limits',
            value: limitsValue,
            updated_at: new Date().toISOString()
          }, { onConflict: 'key' })
          .select()
          .single();

        if (error) throw error;
        await logAudit(req.user?.email, 'UPDATE_SENDING_LIMITS', 'system_settings', data.id, limitsValue);
        return res.status(200).json({ ok: true, data });
      }

      if (action === 'PURGE_TEST_DATA') {
        return res.status(409).json({
          success: false,
          error: 'Global purge is disabled because the existing schema does not prove dataset ownership and the action would delete Dataset 9 and shared records.',
          code: 'DESTRUCTIVE_PURGE_DISABLED'
        });
      }

      return res.status(400).json({ error: 'Unknown admin action' });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const normalized = normalizeDatabaseError(err, 'Admin request failed.');
    normalized.message = sanitizeOAuthText(normalized.message);
    console.error(`[ADMIN] request failed method=${req.method} code=${normalized.code}`);
    return apiErrorResponse(res, normalized, 'ADMIN_ERROR');
  }
}
