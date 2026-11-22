import nodemailer from 'nodemailer';
import { setCors, requireAuth, getHostingerConfig, apiErrorResponse } from '../_utils.js';
import { assertResponseDraftSendReady, sendApprovedResponseDraft } from '../_response-draft-sender.js';
import { createGmailApiTransport } from '../_gmail-oauth.js';

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

export function createResponseSendHandler({
  setCorsFn = setCors,
  requireAuthFn = requireAuth,
  getHostingerConfigFn = getHostingerConfig,
  apiErrorResponseFn = apiErrorResponse,
  assertReadyFn = assertResponseDraftSendReady,
  sendDraftFn = sendApprovedResponseDraft,
  createTransporterFn = options => options?.provider === 'GMAIL_OAUTH'
    ? createGmailApiTransport({ oauthConfig: options.oauth })
    : nodemailer.createTransport(options),
  env = process.env
} = {}) {
  return async function handler(req, res) {
    setCorsFn(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!(await requireAuthFn(req, res, { adminOnly: true }))) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (Object.keys(body).some(key => key !== 'id') || !/^[1-9]\d*$/.test(String(body.id || ''))) {
      return res.status(400).json({ error: 'Provide only a valid response-draft id.' });
    }
    if (env.EMAIL_SENDING_ENABLED !== 'true') {
      return res.status(503).json({ error: 'Email sending is disabled on the server.', code: 'EMAIL_SENDING_DISABLED' });
    }

    try {
      // This is an uncached, read-only check of the migration ledger and the
      // effective database boundary. It runs before SMTP configuration or a
      // transporter can be created.
      await assertReadyFn();
      const config = await getHostingerConfigFn();
      if (!config.smtpConfigured || !config.smtp) {
        return res.status(503).json({ error: config.smtpReason || 'SMTP is not configured.', code: 'SMTP_NOT_CONFIGURED' });
      }

      const transporter = createTransporterFn({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: { user: config.smtp.user, pass: config.smtp.pass },
        connectionTimeout: 10000,
        provider: config.provider || config.smtp.provider,
        oauth: config.smtp.oauth
      });

      const result = await sendDraftFn({
        draftId: String(body.id),
        actorEmail: req.user?.email || null,
        sendMail: draft => transporter.sendMail({
          from: `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
          to: draft.recipient_email,
          subject: draft.subject,
          text: draft.body_text,
          html: `<pre style="font-family: Arial, sans-serif; white-space: pre-wrap;">${escapeHtml(draft.body_text)}</pre>`
        })
      });

      return res.status(200).json({
        success: result.outcome === 'SENT',
        send_state: result.outcome,
        send_error: result.sendError,
        smtp_code: result.smtpCode,
        smtp_stage: result.smtpStage,
        provider_message_id: result.providerMessageId,
        attempt_id: result.attemptId,
        ...(result.outcome === 'UNKNOWN' ? { message: 'Acceptance is uncertain. This draft is blocked pending manual reconciliation; do not retry.' } : {})
      });
    } catch (error) {
      if (error?.code === 'REPLY_SENDER_NOT_READY') {
        return res.status(503).json({ error: 'Reply sending is disabled because database safeguards are not verified.', code: error.code });
      }
      if (error?.code === 'RESPONSE_DRAFT_BLOCKED' || error?.code === 'RESPONSE_DRAFT_NOT_CLAIMED') {
        return res.status(error.status || 409).json({ error: error.message, code: error.code });
      }
      if (error?.code === 'RESPONSE_DRAFT_FINALIZATION_UNCONFIRMED') {
        return res.status(503).json({
          error: 'The send outcome could not be durably recorded. The attempt remains blocked; do not retry.',
          code: error.code,
          smtp_accepted: Boolean(error.smtpAccepted)
        });
      }
      return apiErrorResponseFn(res, error, 'RESPONSE_DRAFT_SEND_ERROR');
    }
  };
}

export default createResponseSendHandler();
