import { randomUUID } from 'node:crypto';
import { isValidOutreachEmail, smtpAcceptedByServer } from './_outreach-guards.js';
import { responseDraftSendRepository } from './_reply-draft-send-db.js';

const CONTACT_PREFERENCE_INTENTS = new Set(['UNSUBSCRIBE', 'NOT_INTERESTED', 'WRONG_RECIPIENT']);
const DEFINITIVE_PRE_SUBMISSION_CODES = new Set(['ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND']);
const SMTP_COMMANDS = new Map([
  ['CONN', 'CONNECT'], ['AUTH', 'AUTH'], ['MAIL FROM', 'MAIL_FROM'],
  ['RCPT TO', 'RCPT_TO'], ['DATA', 'DATA']
]);

function parseSmtpCode(value) {
  const direct = Number(value);
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;
  const match = String(value || '').match(/^\s*([1-5]\d\d)\b/);
  return match ? Number(match[1]) : null;
}

function smtpStage(command) {
  const normalized = String(command || '').trim().toUpperCase();
  return SMTP_COMMANDS.get(normalized) || 'UNKNOWN';
}

export function responseDraftSendBlocker(draft) {
  if (!draft) return 'Response draft not found.';
  if (draft.status !== 'APPROVED') return 'Only an approved response draft can be sent.';
  if (!isValidOutreachEmail(draft.recipient_email)) return 'The saved recipient address is invalid.';
  if (!String(draft.subject || '').trim() || !String(draft.body_text || '').trim()) return 'The saved subject and message body are required.';
  if (!draft.inbox_sender_email || draft.inbox_sender_email.trim().toLowerCase() !== draft.recipient_email.trim().toLowerCase()) {
    return 'The saved recipient does not match the linked inbox conversation.';
  }
  if (!draft.linked_contact_id || draft.contact_verification_status !== 'VERIFIED' || draft.contact_is_suppressed) {
    return 'A linked, verified, unsuppressed contact is required.';
  }
  if (!draft.linked_contact_email || draft.linked_contact_email.trim().toLowerCase() !== draft.recipient_email.trim().toLowerCase()) {
    return 'The saved recipient does not match the linked verified contact.';
  }
  if (draft.globally_suppressed) return 'The recipient is suppressed and cannot receive a reply.';
  if (draft.linked_outreach_status === 'BOUNCED') return 'The linked outreach has bounced; this recipient is blocked.';
  if (CONTACT_PREFERENCE_INTENTS.has(String(draft.inbox_intent || '').toUpperCase())) {
    return 'This contact-preference message is blocked from sending.';
  }
  return null;
}

export function classifyReplySmtpOutcome({ result, error, recipient }) {
  const code = parseSmtpCode(error?.responseCode ?? result?.responseCode ?? error?.response ?? result?.response);
  let stage = smtpStage(error?.command || result?.command);

  if (!error && smtpAcceptedByServer(result, recipient) && code >= 200 && code < 300) {
    return {
      outcome: 'SENT', smtpCode: code, smtpStage: 'ACCEPTED',
      outcomeEvidence: 'SMTP_ACCEPTED_INTENDED_RECIPIENT',
      sendError: null, providerMessageId: result.messageId ? String(result.messageId).slice(0, 512) : null
    };
  }

  const acceptedRecipient = (result?.accepted || []).some(address =>
    String(address).trim().toLowerCase() === String(recipient || '').trim().toLowerCase()
  );
  const rejectedRecipient = (result?.rejected || []).some(address =>
    String(address).trim().toLowerCase() === String(recipient || '').trim().toLowerCase()
  );
  if (rejectedRecipient && code >= 400 && code < 600) stage = 'RECIPIENT_REJECTED';
  if (!acceptedRecipient && code >= 400 && code < 600 && stage !== 'UNKNOWN') {
    return {
      outcome: 'FAILED', smtpCode: code, smtpStage: stage,
      outcomeEvidence: stage === 'RECIPIENT_REJECTED' || stage === 'RCPT_TO'
        ? 'SMTP_RECIPIENT_REJECTED'
        : 'SMTP_SERVER_REJECTED',
      sendError: `SMTP_REJECTED_${stage}_${code}`, providerMessageId: null
    };
  }

  const errorCode = String(error?.code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 48);
  if (!acceptedRecipient && stage === 'CONNECT' && DEFINITIVE_PRE_SUBMISSION_CODES.has(errorCode)) {
    return {
      outcome: 'FAILED', smtpCode: null, smtpStage: 'PRE_SUBMISSION',
      outcomeEvidence: 'SMTP_PRE_SUBMISSION_FAILURE',
      sendError: `SMTP_NOT_SUBMITTED_${errorCode}`, providerMessageId: null
    };
  }

  return {
    outcome: 'UNKNOWN', smtpCode: null, smtpStage: stage,
    outcomeEvidence: 'SMTP_ACCEPTANCE_UNCERTAIN',
    sendError: `SMTP_OUTCOME_UNKNOWN${errorCode ? `_${errorCode}` : ''}`,
    providerMessageId: null
  };
}

export function createResponseDraftSender({ repository = responseDraftSendRepository, idFactory = randomUUID } = {}) {
  return async function sendApprovedResponseDraft({ draftId, actorEmail, sendMail }) {
    const draft = await repository.inspect(draftId);
    const blocker = responseDraftSendBlocker(draft);
    if (blocker) throw Object.assign(new Error(blocker), { code: 'RESPONSE_DRAFT_BLOCKED', status: draft ? 409 : 404 });

    const attemptId = idFactory();
    const claimed = await repository.claim(draftId, attemptId, actorEmail);
    if (!claimed) {
      throw Object.assign(new Error('The draft is no longer eligible to send. SENDING, SENT, UNKNOWN, and unapproved drafts cannot be reclaimed.'), {
        code: 'RESPONSE_DRAFT_NOT_CLAIMED', status: 409
      });
    }

    // Repeat persisted safety checks immediately before SMTP. A change after
    // claim is recorded as definite non-submission, never as an SMTP outcome.
    const current = await repository.inspect(draftId);
    const currentBlocker = responseDraftSendBlocker(current) || (
      !current ||
      String(current.dataset_id) !== String(claimed.dataset_id) ||
      String(current.inbox_message_id) !== String(claimed.inbox_message_id) ||
      String(current.recipient_email || '').trim().toLowerCase() !== String(claimed.recipient_email || '').trim().toLowerCase() ||
      current.subject !== claimed.subject ||
      current.body_text !== claimed.body_text
        ? 'The draft identity changed after it was claimed.'
        : null
    );
    let smtpResult = null;
    let smtpError = null;
    if (currentBlocker) {
      smtpError = Object.assign(new Error(currentBlocker), { command: 'CONN', code: 'EPOLICYBLOCK' });
    } else {
      try {
        smtpResult = await sendMail(claimed);
      } catch (error) {
        smtpError = error;
      }
    }

    let outcome = classifyReplySmtpOutcome({ result: smtpResult, error: smtpError, recipient: claimed.recipient_email });
    if (currentBlocker) {
      outcome = {
        outcome: 'FAILED', smtpCode: null, smtpStage: 'PRE_SUBMISSION',
        outcomeEvidence: 'SMTP_PRE_SUBMISSION_FAILURE',
        sendError: 'SEND_BLOCKED_AFTER_CLAIM', providerMessageId: null
      };
    }

    let persisted;
    try {
      persisted = await repository.finalize({ draftId, attemptId, actorEmail, ...outcome });
    } catch {
      throw Object.assign(new Error('The SMTP outcome could not be durably recorded. This attempt remains blocked; do not retry it.'), {
        code: 'RESPONSE_DRAFT_FINALIZATION_UNCONFIRMED', status: 503,
        smtpAccepted: outcome.outcome === 'SENT'
      });
    }
    if (!persisted) {
      throw Object.assign(new Error('The SMTP outcome could not be durably recorded. This attempt remains blocked; do not retry it.'), {
        code: 'RESPONSE_DRAFT_FINALIZATION_UNCONFIRMED', status: 503,
        smtpAccepted: outcome.outcome === 'SENT'
      });
    }
    return { attemptId, ...outcome };
  };
}

export const sendApprovedResponseDraft = createResponseDraftSender();

export async function assertResponseDraftSendReady() {
  return responseDraftSendRepository.assertReady();
}
