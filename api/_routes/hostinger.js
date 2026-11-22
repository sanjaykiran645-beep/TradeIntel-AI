import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import supabase from '../_db-client.js';
import { normalizeDatabaseError, setCors, logAudit, getHostingerConfig, requireAuth } from '../_utils.js';
import { persistExternalStage } from '../_external-pipeline.js';
import { followUpStatusAfterDraft, isEmailGloballySuppressed, isValidOutreachEmail, smtpAcceptedByServer } from '../_outreach-guards.js';
import { classifyReplySmtpOutcome } from '../_response-draft-sender.js';
import { resolveDatasetId } from '../_dataset-scope.js';
import { createGmailApiTransport, verifyGmailInboundConnection } from '../_gmail-oauth.js';

export function createOutboundMailTransport(smtpConfig = {}, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  if (smtpConfig?.provider === 'GMAIL_OAUTH' || smtpConfig?.oauth) {
    return createGmailApiTransport({
      oauthConfig: smtpConfig.oauth || smtpConfig,
      env,
      fetchFn
    });
  }
  return nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.pass
    },
    connectionTimeout: smtpConfig.connectionTimeout || 10000
  });
}

export function classifyHostingerSendFailure(error, recipient) {
  const outcome = classifyReplySmtpOutcome({ error, recipient });
  return {
    ...outcome,
    recordStatus: outcome.outcome === 'FAILED' ? 'FAILED' : 'UNKNOWN'
  };
}

export function hostingerSentDisposition({ followUpPersisted = true, crmPersisted = true, auditPersisted = true, pipelinePersisted = true } = {}) {
  const warnings = [];
  if (!followUpPersisted) warnings.push('Follow-up scheduling needs review.');
  if (!crmPersisted) warnings.push('The CRM activity needs review.');
  if (!auditPersisted) warnings.push('The send audit record needs review.');
  if (!pipelinePersisted) warnings.push('The SMTP workflow status needs review.');
  return {
    success: true,
    ok: true,
    status: warnings.length ? 'SENT_WITH_WARNINGS' : 'SENT',
    send_state: 'SENT',
    warnings
  };
}

function hostingerStagePersistenceEvidence(result) {
  return result?.persisted
    ? { persisted: true, datasetId: result.datasetId }
    : { persisted: false, blocker: 'Workflow status could not be confirmed. Review the saved send status before taking further action.' };
}

export default async function handler(req, res) {
  let activeStage = null;
  let activeDatasetId = null;
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!(await requireAuth(req, res, { adminOnly: req.method === 'POST' }))) return;

  try {
    const config = await getHostingerConfig();
    const emailSendingEnabled = process.env.EMAIL_SENDING_ENABLED === 'true' && config.smtpConfigured;
    if (config.configurationError) {
      return res.status(config.configurationError.status || 503).json({
        success: false,
        status: 'BLOCKED',
        error: 'Hostinger configuration could not be verified; review the server-side settings and diagnostics.',
        code: config.configurationError.code
      });
    }

    // GET: SMTP and IMAP connection checks only. This endpoint never sends email.
    if (req.method === 'GET') {
      activeStage = 'SMTP';
      let smtpStatus = 'NOT CONFIGURED';
      let smtpError = null;
      let imapStatus = 'NOT CONFIGURED';
      let imapError = null;
      if (config.smtpConfigured) {
        try {
          const transporter = createOutboundMailTransport({
            ...config.smtp,
            connectionTimeout: 8000
          });

          await transporter.verify();
          smtpStatus = 'VERIFIED_CONNECTED';
        } catch (connectionError) {
          smtpStatus = 'FAILED';
          smtpError = 'SMTP connection check failed; review the server configuration.';
        }
      }
      if (config.imapConfigured) {
        if (config.provider === 'GMAIL_OAUTH') {
          try {
            await verifyGmailInboundConnection({ oauthConfig: config.imap.oauth });
            imapStatus = 'VERIFIED_CONNECTED';
          } catch (connectionError) {
            imapStatus = 'FAILED';
            imapError = 'IMAP connection check failed; review the server configuration.';
          }
        } else {
          const client = new ImapFlow({
            host: config.imap.host,
            port: config.imap.port,
            secure: config.imap.secure,
            auth: { user: config.imap.user, pass: config.imap.pass },
            logger: false,
            connectionTimeout: 8000
          });
          try {
            await client.connect();
            await client.mailboxOpen('INBOX', { readOnly: true });
            imapStatus = 'VERIFIED_CONNECTED';
          } catch (connectionError) {
            imapStatus = 'FAILED';
            imapError = 'IMAP connection check failed; review the server configuration.';
          } finally {
            try { await client.logout(); } catch { /* connection may not have completed */ }
          }
        }
      }

      const smtpPipelineStatus = smtpStatus === 'FAILED' ? 'FAILED' : smtpStatus === 'NOT CONFIGURED' ? 'BLOCKED' : 'REVIEW_REQUIRED';
      const imapPipelineStatus = imapStatus === 'FAILED' ? 'FAILED' : imapStatus === 'NOT CONFIGURED' ? 'BLOCKED' : 'REVIEW_REQUIRED';
      const [smtpPersistence, imapPersistence] = await Promise.all([
        persistExternalStage('SMTP', smtpPipelineStatus, {
          reason: smtpStatus === 'VERIFIED_CONNECTED' ? 'SMTP connection verified. No email was sent by this diagnostic.' : config.smtpReason || smtpError,
          blocker: smtpStatus === 'VERIFIED_CONNECTED' ? 'A validated draft and explicit human send action are still required.' : config.smtpReason || null,
          error: smtpError ? { message: smtpError } : null,
          evidence: { configured: config.smtpConfigured, connectionVerified: smtpStatus === 'VERIFIED_CONNECTED', emailSendingEnabled, outboundSent: false }
        }),
        persistExternalStage('INBOX', imapPipelineStatus, {
          reason: imapStatus === 'VERIFIED_CONNECTED' ? 'IMAP connection verified. No mailbox messages were processed by this diagnostic.' : config.imapReason || imapError,
          blocker: imapStatus === 'VERIFIED_CONNECTED' ? 'Inbox synchronization requires an explicit IMAP sync action.' : config.imapReason || null,
          error: imapError ? { message: imapError } : null,
          evidence: { configured: config.imapConfigured, connectionVerified: imapStatus === 'VERIFIED_CONNECTED', messagesProcessed: 0 }
        })
      ]);
      const hasFailure = smtpStatus === 'FAILED' || imapStatus === 'FAILED';
      const bothConnected = smtpStatus === 'VERIFIED_CONNECTED' && imapStatus === 'VERIFIED_CONNECTED';
      const oneConnected = smtpStatus === 'VERIFIED_CONNECTED' || imapStatus === 'VERIFIED_CONNECTED';
      const anyConfigured = config.smtpConfigured || config.imapConfigured;
      return res.status(200).json({
        status: hasFailure ? 'FAILED' : bothConnected ? 'CONNECTED' : oneConnected ? 'PARTIALLY CONNECTED' : anyConfigured ? 'FAILED' : 'NOT CONFIGURED',
        emailMode: emailSendingEnabled
          ? (config.provider === 'GMAIL_OAUTH' ? 'GMAIL OAUTH MODE' : 'HOSTINGER SMTP MODE')
          : 'MANUAL GMAIL MODE',
        manualGmailMode: !emailSendingEnabled,
        provider: config.provider || 'HOSTINGER',
        configured: config.smtpConfigured,
        smtpConfigured: config.smtpConfigured,
        emailSendingEnabled,
        imapConfigured: config.imapConfigured,
        smtpStatus,
        imapStatus,
        smtpError,
        imapError,
        gmailOAuth: config.gmailOAuth || null,
        smtpPersistence: hostingerStagePersistenceEvidence(smtpPersistence),
        imapPersistence: hostingerStagePersistenceEvidence(imapPersistence),
        checkedAt: new Date().toISOString()
      });
    }

    // POST: Real Hostinger SMTP Send
    if (req.method === 'POST') {
      activeStage = 'SMTP';
      activeDatasetId = await resolveDatasetId(req);
      const { outreachId } = req.body || {};
      const userEmail = req.user?.email || null;

      if (!emailSendingEnabled) {
        const reason = 'Outbound email sending is disabled. Set EMAIL_SENDING_ENABLED=true only after an explicit operational approval; no email was sent.';
        const persistence = await persistExternalStage('SMTP', 'BLOCKED', {
          reason,
          blocker: 'EMAIL_SENDING_ENABLED is not true.',
          evidence: { configured: config.smtpConfigured, emailSendingEnabled: false, outboundSent: false }
        }, activeDatasetId);
        return res.status(403).json({
          success: false,
          status: 'BLOCKED',
          error: reason,
          code: 'EMAIL_SENDING_DISABLED',
          persistence: hostingerStagePersistenceEvidence(persistence)
        });
      }

      if (!config.smtpConfigured) {
        const reason = 'Hostinger SMTP is not configured. No email was sent.';
        const persistence = await persistExternalStage('SMTP', 'BLOCKED', { reason, blocker: config.smtpReason, evidence: { configured: false, outboundSent: false } });
        return res.status(400).json({
          success: false,
          status: 'BLOCKED',
          error: reason,
          code: 'SMTP_NOT_CONFIGURED',
          persistence: hostingerStagePersistenceEvidence(persistence)
        });
      }

      let emailRow = null;
      if (outreachId) {
        const { data: found } = await supabase
          .from('outreach_emails')
          .select('*, companies(*), contacts(*)')
          .eq('id', outreachId).eq('dataset_id', activeDatasetId)
          .single();
        emailRow = found;
      }

      if (!emailRow) {
        const reason = 'Approved outreach draft not found. No email was sent.';
        const persistence = await persistExternalStage('SMTP', 'BLOCKED', { reason, blocker: reason, evidence: { outboundSent: false, outreachRecordFound: false } });
        return res.status(404).json({ error: reason, persistence: hostingerStagePersistenceEvidence(persistence) });
      }

      const toAddress = emailRow.recipient_email;
      const subject = emailRow.subject;
      const textBody = emailRow.body_text;

      // Enforce status check
      if (emailRow.status !== 'APPROVED' || !emailRow.approved_at || !emailRow.validation_passed) {
        const reason = `Cannot send: current status is '${emailRow.status}'. A validated draft with recorded human approval is required.`;
        const persistence = await persistExternalStage('SMTP', 'BLOCKED', { reason, blocker: reason, evidence: { outboundSent: false, humanApprovalRecorded: Boolean(emailRow.approved_at) } });
        return res.status(400).json({
          error: reason,
          persistence: hostingerStagePersistenceEvidence(persistence)
        });
      }

      if (!emailRow.contacts || emailRow.contacts.verification_status !== 'VERIFIED' || emailRow.contacts.is_suppressed || emailRow.contacts.email !== toAddress || !isValidOutreachEmail(toAddress)) {
        const reason = 'Cannot send: the persisted verified contact is missing, suppressed, or does not match the recipient address.';
        const persistence = await persistExternalStage('SMTP', 'BLOCKED', { reason, blocker: reason, evidence: { outboundSent: false, contactGatePassed: false } });
        return res.status(400).json({ error: reason, persistence: hostingerStagePersistenceEvidence(persistence) });
      }

      if (await isEmailGloballySuppressed(toAddress)) {
        const reason = 'Cannot send: this recipient email is suppressed in the shared workspace.';
        const persistence = await persistExternalStage('SMTP', 'BLOCKED', {
          reason,
          blocker: reason,
          evidence: { outboundSent: false, recipientSuppressed: true }
        }, activeDatasetId);
        return res.status(409).json({ error: reason, code: 'RECIPIENT_SUPPRESSED', persistence: hostingerStagePersistenceEvidence(persistence) });
      }

      if (emailRow) {
        const { data: stoppedFollowUp, error: stopCheckError } = await supabase
          .from('follow_up_queue')
          .select('id,status')
          .eq('outreach_id', emailRow.id).eq('dataset_id', activeDatasetId)
          .in('status', ['STOPPED_REPLY_RECEIVED', 'STOPPED_UNSUBSCRIBED', 'STOPPED_BOUNCE', 'STOPPED_CONVERTED', 'STOPPED_MANUAL'])
          .maybeSingle();
        if (stopCheckError) throw stopCheckError;
        if (stoppedFollowUp) {
          const reason = `Cannot send: follow-up sequence is ${stoppedFollowUp.status}.`;
          const persistence = await persistExternalStage('SMTP', 'BLOCKED', { reason, blocker: reason, evidence: { outboundSent: false, followUpStopped: true } });
          return res.status(400).json({ error: reason, persistence: hostingerStagePersistenceEvidence(persistence) });
        }
      }

      // Atomically claim the approved draft so concurrent requests cannot send it twice.
      if (emailRow) {
        const { data: sendingClaim, error: stateError } = await supabase
          .from('outreach_emails')
          .update({ status: 'SENDING' })
          .eq('id', emailRow.id).eq('dataset_id', activeDatasetId)
          .eq('status', 'APPROVED')
          .select('id')
          .maybeSingle();
        if (stateError) throw stateError;
        if (!sendingClaim) {
          const reason = 'This draft is no longer approved for transmission.';
          const persistence = await persistExternalStage('SMTP', 'BLOCKED', { reason, blocker: reason, evidence: { outboundSent: false, approvalClaimed: false } });
          return res.status(409).json({ error: reason, persistence: hostingerStagePersistenceEvidence(persistence) });
        }
      }

      await persistExternalStage('SMTP', 'RUNNING', {
        recordsProcessed: 1,
        reason: 'A validated, human-approved message is being handed to the configured SMTP server.',
        evidence: { outboundSent: false, humanApprovalRecorded: true, recipientValidated: true }
      });

      const transporter = createOutboundMailTransport({
        ...config.smtp,
        connectionTimeout: 10000
      });

      let sendResult;
      try {
        sendResult = await transporter.sendMail({
          from: `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
          to: toAddress,
          subject,
          text: textBody,
          html: `<pre style="font-family: Arial, sans-serif; white-space: pre-wrap; font-size: 14px; line-height: 1.6;">${textBody}</pre>`
        });
        if (!smtpAcceptedByServer(sendResult, toAddress)) {
          throw new Error('SMTP did not confirm acceptance of the recipient with a server response.');
        }
      } catch (sendErr) {
        const failure = classifyHostingerSendFailure(sendErr, toAddress);
        let failurePersisted = false;
        if (emailRow) {
          const failedAt = new Date().toISOString();
          const priorEvidence = emailRow.personalization_evidence && typeof emailRow.personalization_evidence === 'object'
            ? emailRow.personalization_evidence
            : {};
          try {
            const { data: outcomeRow, error: updateError } = await supabase
              .from('outreach_emails')
              .update({
                status: failure.recordStatus,
                validation_errors: [failure.sendError],
                personalization_evidence: {
                  ...priorEvidence,
                  smtpAttempt: {
                    status: failure.outcome,
                    attemptedAt: failedAt,
                    outcomeEvidence: failure.outcomeEvidence,
                    smtpCode: failure.smtpCode,
                    smtpStage: failure.smtpStage,
                    error: failure.sendError
                  }
                }
              })
              .eq('id', emailRow.id).eq('dataset_id', activeDatasetId).eq('status', 'SENDING')
              .select('id').maybeSingle();
            if (updateError || !outcomeRow) {
              console.error(`[HOSTINGER] SMTP outcome persistence failed code=${normalizeDatabaseError(updateError).code}`);
            } else {
              failurePersisted = true;
            }
          } catch (updateError) {
            console.error(`[HOSTINGER] SMTP outcome persistence failed code=${normalizeDatabaseError(updateError).code}`);
          }
        }
        let failureAuditPersisted = !emailRow;
        if (emailRow) {
          const audit = await logAudit(userEmail, failure.outcome === 'UNKNOWN' ? 'HOSTINGER_SEND_OUTCOME_UNKNOWN' : 'HOSTINGER_SEND_FAILED', 'outreach_emails', emailRow.id, {
            outcome: failure.outcome,
            outcomeEvidence: failure.outcomeEvidence,
            smtpCode: failure.smtpCode,
            smtpStage: failure.smtpStage,
            error: failure.sendError
          });
          failureAuditPersisted = audit?.persisted === true;
        }
        const uncertain = failure.outcome === 'UNKNOWN';
        let persistence = null;
        try {
          persistence = await persistExternalStage('SMTP', uncertain || !failurePersisted ? 'BLOCKED' : 'FAILED', {
            recordsProcessed: 1,
            reason: !failurePersisted
              ? 'The SMTP outcome could not be durably saved. The draft remains blocked; verify provider state before any further action.'
              : uncertain
                ? 'SMTP acceptance is uncertain. The outreach record is blocked pending manual reconciliation.'
                : 'The SMTP server definitively rejected the message before acceptance.',
            error: { code: failure.sendError },
            evidence: {
              outboundSent: false,
              serverAcceptedRecipient: false,
              outcome: failure.outcome,
              outcomeEvidence: failure.outcomeEvidence,
              smtpCode: failure.smtpCode,
              smtpStage: failure.smtpStage,
              outcomePersisted: failurePersisted
            }
          }, activeDatasetId);
        } catch (pipelineError) {
          console.error(`[HOSTINGER] SMTP outcome pipeline persistence failed code=${normalizeDatabaseError(pipelineError).code}`);
        }
        return res.status(502).json({
          error: !failurePersisted
            ? 'The SMTP outcome could not be saved. The draft remains blocked; verify provider state before taking further action.'
            : uncertain
              ? 'SMTP acceptance is uncertain. The draft remains blocked; do not send it again until provider state is reconciled.'
              : 'The SMTP server definitively rejected the message before acceptance.',
          status: failurePersisted ? failure.outcome : 'PERSISTENCE_FAILED',
          auditPersisted: failureAuditPersisted,
          persistence: hostingerStagePersistenceEvidence(persistence)
        });
      }

      // Real server confirmation verified!
      const messageId = sendResult.messageId || null;
      const sentAt = new Date().toISOString();

      if (emailRow) {
        const evidence = emailRow.personalization_evidence && typeof emailRow.personalization_evidence === 'object'
          ? emailRow.personalization_evidence
          : {};
        let sentStateError = null;
        try {
          const { data: sentRow, error } = await supabase.from('outreach_emails').update({
            status: 'SENT',
            message_id: messageId,
            sent_at: sentAt,
            personalization_evidence: {
              ...evidence,
              smtpAttempt: { status: 'SENT', attemptedAt: sentAt },
              smtpConfirmation: {
                response: sendResult.response,
                envelope: sendResult.envelope,
                accepted: sendResult.accepted,
                rejected: sendResult.rejected,
                messageId,
                ...(sendResult.gmailMessageId ? { gmailMessageId: sendResult.gmailMessageId } : {}),
                ...(sendResult.gmailThreadId ? { gmailThreadId: sendResult.gmailThreadId } : {}),
                sentAt
              }
            }
          }).eq('id', emailRow.id).eq('dataset_id', activeDatasetId).eq('status', 'SENDING')
            .select('id').maybeSingle();
          sentStateError = error || (!sentRow ? Object.assign(new Error('The sending claim is no longer owned by this request.'), { code: 'OUTREACH_SEND_CLAIM_LOST' }) : null);
        } catch (error) {
          sentStateError = error;
        }
        if (sentStateError) {
          console.error(`[HOSTINGER] SMTP acceptance state persistence failed code=${normalizeDatabaseError(sentStateError).code}`);
          try {
            await persistExternalStage('SMTP', 'BLOCKED', {
              recordsProcessed: 1,
              reason: 'SMTP accepted the email, but its SENT state could not be persisted. Do not retry automatically.',
              error: { code: normalizeDatabaseError(sentStateError).code },
              evidence: { outboundSent: true, serverAcceptedRecipient: true, statePersisted: false, messageId }
            }, activeDatasetId);
          } catch (pipelineError) {
            console.error(`[HOSTINGER] acceptance persistence diagnostic failed code=${normalizeDatabaseError(pipelineError).code}`);
          }
          return res.status(500).json({
            success: false,
            status: 'PERSISTENCE_FAILED',
            smtpAccepted: true,
            error: 'SMTP accepted the email, but its SENT status could not be saved. Do not retry automatically.',
            messageId
          });
        }

        let followUpPersisted = true;
        try {
          const { data: followUpDraft, error: followUpLookupError } = await supabase
            .from('follow_up_queue')
            .select('id,sequence_step')
            .eq('outreach_id', emailRow.id).eq('dataset_id', activeDatasetId)
            .eq('status', 'DRAFTED')
            .maybeSingle();

          if (followUpLookupError) {
            followUpPersisted = false;
          } else if (followUpDraft) {
            const step = String(Number.parseInt(followUpDraft.sequence_step, 10) || 0);
            const { error: queueUpdateError } = await supabase
              .from('follow_up_queue')
              .update({ status: followUpStatusAfterDraft({ draftCreated: true, smtpAccepted: true }), sequence_step: step })
              .eq('id', followUpDraft.id).eq('dataset_id', activeDatasetId);
            if (queueUpdateError) {
              followUpPersisted = false;
            } else if (Number(step) < 3) {
              const scheduledDate = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();
              const { error: nextError } = await supabase.from('follow_up_queue').insert({
                dataset_id: activeDatasetId,
                outreach_id: emailRow.id,
                company_id: emailRow.company_id,
                contact_id: emailRow.contact_id,
                sequence_step: step,
                scheduled_for: scheduledDate,
                status: 'WAITING',
                created_at: new Date().toISOString()
              });
              if (nextError) followUpPersisted = false;
            }
          } else {
            // This was the initial approved outreach; schedule the first follow-up.
            const scheduledDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
            const { error: queueInsertError } = await supabase.from('follow_up_queue').insert({
              dataset_id: activeDatasetId,
              outreach_id: emailRow.id,
              company_id: emailRow.company_id,
              contact_id: emailRow.contact_id,
              sequence_step: '1',
              scheduled_for: scheduledDate,
              status: 'WAITING',
              created_at: new Date().toISOString()
            });
            if (queueInsertError) followUpPersisted = false;
          }
        } catch (followUpError) {
          followUpPersisted = false;
          console.error(`[HOSTINGER] follow-up persistence failed code=${normalizeDatabaseError(followUpError).code}`);
        }

        // Log CRM activity
        let crmPersisted = true;
        try {
          const { error: activityError } = await supabase.from('crm_activities').insert({
            company_id: emailRow.company_id,
            contact_id: emailRow.contact_id,
            activity_type: 'EMAIL_SENT',
            title: 'Sent via Hostinger SMTP',
            description: 'SMTP accepted the message for the intended recipient.',
            source: 'EMAIL',
            metadata: { messageId, sentAt },
            created_at: new Date().toISOString()
          });
          if (activityError) crmPersisted = false;
        } catch (activityError) {
          crmPersisted = false;
          console.error(`[HOSTINGER] CRM activity persistence failed code=${normalizeDatabaseError(activityError).code}`);
        }

        let auditPersisted = false;
        try {
          const audit = await logAudit(userEmail, 'SEND_HOSTINGER_EMAIL', 'outreach_emails', emailRow.id, {
            messageId,
            outcome: 'SMTP_ACCEPTED'
          });
          auditPersisted = audit?.persisted === true;
        } catch (auditError) {
          console.error(`[HOSTINGER] send audit persistence failed code=${normalizeDatabaseError(auditError).code}`);
        }

        emailRow.sendFollowUpPersisted = followUpPersisted;
        emailRow.sendCrmPersisted = crmPersisted;
        emailRow.sendAuditPersisted = auditPersisted;

      }

      let smtpPersistence = null;
      try {
        smtpPersistence = await persistExternalStage('SMTP', 'COMPLETED', {
          recordsProcessed: 1,
          recordsProduced: 1,
          evidence: { outboundSent: true, serverAcceptedRecipient: true, messageId, sentAt }
        });
      } catch (pipelineError) {
        console.error(`[HOSTINGER] SMTP pipeline persistence failed code=${normalizeDatabaseError(pipelineError).code}`);
      }
      let followUpStagePersisted = true;
      if (emailRow && emailRow.sendFollowUpPersisted === false) {
        try {
          const followUpStage = await persistExternalStage('FOLLOW_UP', 'REVIEW_REQUIRED', {
            reason: 'SMTP accepted the email, but follow-up scheduling needs review.',
            blocker: 'Follow-up scheduling could not be confirmed.',
            evidence: { outreachId: emailRow.id, smtpAccepted: true }
          }, activeDatasetId);
          followUpStagePersisted = followUpStage?.persisted === true;
        } catch (pipelineError) {
          followUpStagePersisted = false;
          console.error(`[HOSTINGER] follow-up workflow status persistence failed code=${normalizeDatabaseError(pipelineError).code}`);
        }
      }

      const disposition = hostingerSentDisposition({
        followUpPersisted: emailRow?.sendFollowUpPersisted !== false && followUpStagePersisted,
        crmPersisted: emailRow?.sendCrmPersisted !== false,
        auditPersisted: emailRow?.sendAuditPersisted !== false,
        pipelinePersisted: smtpPersistence?.persisted === true
      });
      return res.status(200).json({
        ...disposition,
        message: disposition.warnings.length
          ? 'SMTP accepted the email and SENT state was saved. Do not resend. Review the listed workflow records.'
          : 'SMTP accepted the email and SENT state was saved. This confirms acceptance, not delivery.',
        messageId,
        sentAt,
        persistence: { persisted: smtpPersistence?.persisted === true }
      });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const errorCode = String(err?.code || '').toUpperCase();
    const databaseFailure = /^(PGRST|57P|42|427|428|DATABASE_)/.test(errorCode) || errorCode === '57014' ||
      (err instanceof TypeError && /fetch failed|network error/i.test(err.message || ''));
    if (activeStage && !databaseFailure) {
      try {
        await persistExternalStage(activeStage, 'FAILED', {
          reason: 'Hostinger operation failed; consult server-side diagnostics.',
          error: { code: /^[A-Z0-9_-]{1,64}$/.test(errorCode) ? errorCode : 'HOSTINGER_ERROR' }
        });
      } catch (stageError) {
        console.error(`[HOSTINGER] failure state persistence failed code=${stageError.code || 'DATABASE_ERROR'}`);
      }
    }
    const normalized = databaseFailure
      ? normalizeDatabaseError(err, 'Database request failed.')
      : { code: 'SMTP_UNAVAILABLE', status: 502, message: 'Hostinger operation failed. Review the server-side diagnostic code.' };
    const code = databaseFailure ? normalized.code : 'SMTP_UNAVAILABLE';
    const status = databaseFailure ? normalized.status : 502;
    console.error(`[HOSTINGER] operation failed stage=${activeStage || 'CONFIGURATION'} code=${code}`);
    return res.status(status).json({ success: false, status: 'FAILED', stage: activeStage, error: databaseFailure ? 'Database operation failed; review server-side diagnostics.' : 'Hostinger operation failed; review server-side diagnostics.', code });
  }
}
