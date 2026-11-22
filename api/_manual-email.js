import { createHash, randomUUID } from 'node:crypto';
import supabase from './_db-client.js';
import { normalizeReplySubject } from './_mime-message.js';
import { followUpStatusAfterDraft, isEmailGloballySuppressed, isValidOutreachEmail } from './_outreach-guards.js';
import { persistExternalStage, stagePersistenceEvidence } from './_external-pipeline.js';
import { logAudit } from './_utils.js';

export const MANUAL_EMAIL_MODE = 'MANUAL GMAIL MODE';

export const COMMERCIAL_REPLY_INTENTS = [
  'INTERESTED',
  'PRICE_REQUEST',
  'QUOTE_REQUEST',
  'PRODUCT_REQUEST',
  'SAMPLE_REQUEST',
  'MEETING_REQUEST',
  'NEGOTIATION'
];

export function extractEmailAddress(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const angleMatch = raw.match(/<([^<>]+)>/);
  if (angleMatch?.[1]) return angleMatch[1].trim().toLowerCase();
  return raw.toLowerCase();
}

export function extractSenderDisplayName(rawSender, explicitName, fallbackEmail) {
  const trimmedExplicit = String(explicitName || '').trim();
  if (trimmedExplicit) return trimmedExplicit.slice(0, 160);
  const raw = String(rawSender || '').trim();
  if (raw.includes('<')) {
    const prefix = raw.split('<')[0].replace(/^\s*["']|["']\s*$/g, '').trim();
    if (prefix) return prefix.slice(0, 160);
  }
  return String(fallbackEmail || '').trim().toLowerCase();
}

export function buildGmailComposeUrl({ to, subject, body }) {
  const normalizedTo = extractEmailAddress(to);
  if (!isValidOutreachEmail(normalizedTo)) {
    throw Object.assign(
      new Error('A valid, verified recipient email address is required to build a Gmail compose URL.'),
      { code: 'INVALID_RECIPIENT_EMAIL', status: 400 }
    );
  }
  const normalizedSubject = String(subject ?? '').trim();
  if (!normalizedSubject) {
    throw Object.assign(
      new Error('A non-empty email subject is required to open Gmail compose.'),
      { code: 'MISSING_EMAIL_SUBJECT', status: 400 }
    );
  }
  const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalizedBody) {
    throw Object.assign(
      new Error('A non-empty personalized email body is required to open Gmail compose.'),
      { code: 'MISSING_EMAIL_BODY', status: 400 }
    );
  }

  return (
    'https://mail.google.com/mail/?view=cm&fs=1' +
    `&to=${encodeURIComponent(normalizedTo)}` +
    `&su=${encodeURIComponent(normalizedSubject)}` +
    `&body=${encodeURIComponent(normalizedBody)}`
  );
}

async function checkGlobalSuppression(email, db = supabase) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!isValidOutreachEmail(normalizedEmail)) return false;
  if (db === supabase) {
    return isEmailGloballySuppressed(normalizedEmail);
  }
  if (typeof db?.query === 'function') {
    const result = await db.query(
      'SELECT 1 FROM contacts WHERE lower(email) = $1 AND is_suppressed = true LIMIT 1',
      [normalizedEmail]
    );
    return Array.isArray(result?.rows) && result.rows.length > 0;
  }
  return false;
}

export async function validateManualSendEligibility({ draft, datasetId, db = supabase }) {
  if (!draft) {
    return {
      ok: false,
      status: 404,
      code: 'OUTREACH_NOT_FOUND',
      reason: 'Outreach draft not found in the active dataset.'
    };
  }

  if (['SENT', 'MANUALLY_CONFIRMED_SENT', 'REPLIED'].includes(draft.status)) {
    return {
      ok: false,
      status: 409,
      code: 'DUPLICATE_SEND_BLOCKED',
      reason: `Duplicate send protection: this outreach email is already in status '${draft.status}' and cannot be sent or confirmed again.`
    };
  }

  if (['SENDING', 'UNKNOWN', 'BOUNCED', 'FAILED'].includes(draft.status)) {
    return {
      ok: false,
      status: 409,
      code: 'INVALID_OUTREACH_STATE',
      reason: `Cannot proceed: outreach email status is '${draft.status}'.`
    };
  }

  if (!['APPROVED', 'OPENED_IN_GMAIL'].includes(draft.status) || !draft.approved_at || !draft.validation_passed) {
    return {
      ok: false,
      status: 400,
      code: 'APPROVAL_REQUIRED_FOR_MANUAL_SEND',
      reason: `Cannot proceed: current status is '${draft.status}'. A validated draft with recorded human approval is required before manual Gmail sending.`
    };
  }

  const recipientEmail = String(draft.recipient_email || '').trim().toLowerCase();
  const contact = draft.contacts || draft.contact || null;
  const contactEmail = String(contact?.email || '').trim().toLowerCase();

  if (contact?.is_suppressed) {
    return {
      ok: false,
      status: 409,
      code: 'RECIPIENT_SUPPRESSED',
      reason: 'Cannot send: the recipient contact is suppressed or unsubscribed.'
    };
  }

  if (
    !contact ||
    contact.verification_status !== 'VERIFIED' ||
    !contactEmail ||
    contactEmail !== recipientEmail ||
    !isValidOutreachEmail(recipientEmail)
  ) {
    return {
      ok: false,
      status: 400,
      code: 'UNVERIFIED_OR_INVALID_CONTACT',
      reason: 'Cannot send: the persisted verified contact is missing, unverified, or does not match a valid recipient email address.'
    };
  }

  if (await checkGlobalSuppression(recipientEmail, db)) {
    return {
      ok: false,
      status: 409,
      code: 'RECIPIENT_SUPPRESSED',
      reason: 'Cannot send: this recipient email is suppressed in the shared workspace.'
    };
  }

  const { data: stoppedFollowUp, error: stopCheckError } = await db
    .from('follow_up_queue')
    .select('id,status')
    .eq('outreach_id', draft.id)
    .eq('dataset_id', datasetId)
    .in('status', ['STOPPED_REPLY_RECEIVED', 'STOPPED_UNSUBSCRIBED', 'STOPPED_BOUNCE', 'STOPPED_CONVERTED', 'STOPPED_MANUAL'])
    .maybeSingle();
  if (stopCheckError) throw stopCheckError;

  if (stoppedFollowUp) {
    return {
      ok: false,
      status: 409,
      code: 'SEQUENCE_STOPPED',
      reason: `Cannot send: follow-up sequence is ${stoppedFollowUp.status}.`
    };
  }

  return { ok: true, recipientEmail, contact };
}

export async function openGmailComposeForOutreach({
  draft,
  datasetId,
  actorEmail,
  db = supabase,
  logAuditFn = logAudit,
  persistStageFn = persistExternalStage
}) {
  const eligibility = await validateManualSendEligibility({ draft, datasetId, db });
  if (!eligibility.ok) {
    return {
      ok: false,
      statusCode: eligibility.status,
      payload: {
        success: false,
        status: 'BLOCKED',
        code: eligibility.code,
        error: eligibility.reason
      }
    };
  }

  const composeUrl = buildGmailComposeUrl({
    to: draft.recipient_email,
    subject: draft.subject,
    body: draft.body_text
  });

  const openedAt = new Date().toISOString();
  const priorEvidence = draft.personalization_evidence && typeof draft.personalization_evidence === 'object'
    ? draft.personalization_evidence
    : {};
  const priorManual = priorEvidence.manualGmail && typeof priorEvidence.manualGmail === 'object'
    ? priorEvidence.manualGmail
    : {};

  const updatedEvidence = {
    ...priorEvidence,
    manualGmail: {
      ...priorManual,
      mode: MANUAL_EMAIL_MODE,
      composeOpenedAt: openedAt,
      openedBy: actorEmail || 'admin',
      openCount: Number(priorManual.openCount || 0) + 1,
      sentConfirmed: false,
      deliveryVerified: false,
      notice: 'Opening Gmail compose does NOT mean the email was sent. Confirm manually only after you click Send in Gmail.'
    }
  };

  const { data: updatedDraft, error: updateError } = await db
    .from('outreach_emails')
    .update({
      status: 'OPENED_IN_GMAIL',
      personalization_evidence: updatedEvidence
    })
    .eq('id', draft.id)
    .eq('dataset_id', datasetId)
    .in('status', ['APPROVED', 'OPENED_IN_GMAIL'])
    .select()
    .maybeSingle();

  if (updateError) throw updateError;
  if (!updatedDraft) {
    return {
      ok: false,
      statusCode: 409,
      payload: {
        success: false,
        status: 'BLOCKED',
        code: 'OUTREACH_STATE_CONFLICT',
        error: 'Outreach draft status changed before the Gmail compose state could be saved.'
      }
    };
  }

  await logAuditFn(actorEmail, 'OPEN_GMAIL_COMPOSE', 'outreach_emails', draft.id, {
    mode: MANUAL_EMAIL_MODE,
    openedAt,
    sent: false
  });

  const stageResult = await persistStageFn('SMTP', 'REVIEW_REQUIRED', {
    recordsProcessed: 1,
    recordsProduced: 0,
    reason: 'Approved outreach opened in Gmail compose window. Opening Gmail does not mean the email was sent; awaiting manual send confirmation.',
    blocker: 'Operator must send the message in Gmail and explicitly confirm manual send.',
    evidence: {
      mode: MANUAL_EMAIL_MODE,
      outreachId: draft.id,
      composeOpenedAt: openedAt,
      outboundSent: false,
      manualConfirmationRequired: true
    }
  }, datasetId);

  return {
    ok: true,
    statusCode: 200,
    payload: {
      success: true,
      status: 'OPENED_IN_GMAIL',
      send_state: 'OPENED_IN_GMAIL',
      sent: false,
      deliveryVerified: false,
      mode: MANUAL_EMAIL_MODE,
      composeUrl,
      notice: 'Opening Gmail does NOT mean the email was sent. Review and send the email in your Gmail tab, then click "Confirm Manually Sent" to record your manual confirmation.',
      outreach: updatedDraft,
      persistence: stagePersistenceEvidence(stageResult)
    }
  };
}

export async function confirmManualGmailSent({
  draft,
  datasetId,
  actorEmail,
  operatorNote = '',
  db = supabase,
  logAuditFn = logAudit,
  persistStageFn = persistExternalStage
}) {
  const eligibility = await validateManualSendEligibility({ draft, datasetId, db });
  if (!eligibility.ok) {
    return {
      ok: false,
      statusCode: eligibility.status,
      payload: {
        success: false,
        status: 'BLOCKED',
        code: eligibility.code,
        error: eligibility.reason
      }
    };
  }

  const confirmedAt = new Date().toISOString();
  const messageId = draft.message_id || `<manual-gmail-${draft.id}-${randomUUID()}@manual.tradeintel>`;
  const sanitizedNote = String(operatorNote || '').trim().slice(0, 500) ||
    'Operator manually asserted that this approved outreach email was sent via Gmail compose. Not independently verified by SMTP or Gmail API.';

  const priorEvidence = draft.personalization_evidence && typeof draft.personalization_evidence === 'object'
    ? draft.personalization_evidence
    : {};
  const priorManual = priorEvidence.manualGmail && typeof priorEvidence.manualGmail === 'object'
    ? priorEvidence.manualGmail
    : {};

  const updatedEvidence = {
    ...priorEvidence,
    manualGmail: {
      ...priorManual,
      mode: MANUAL_EMAIL_MODE,
      sentConfirmed: true,
      confirmedAt,
      confirmedBy: actorEmail || 'admin',
      deliveryVerified: false
    },
    manualConfirmation: {
      mode: MANUAL_EMAIL_MODE,
      status: 'MANUALLY_CONFIRMED_SENT',
      confirmationType: 'MANUAL_USER_ASSERTION',
      deliveryVerified: false,
      smtpAccepted: false,
      oauthSent: false,
      assertedBy: actorEmail || 'admin',
      confirmedAt,
      messageId,
      operatorNote: sanitizedNote
    }
  };

  const { data: confirmedRow, error: updateError } = await db
    .from('outreach_emails')
    .update({
      status: 'MANUALLY_CONFIRMED_SENT',
      message_id: messageId,
      sent_at: confirmedAt,
      personalization_evidence: updatedEvidence
    })
    .eq('id', draft.id)
    .eq('dataset_id', datasetId)
    .in('status', ['APPROVED', 'OPENED_IN_GMAIL'])
    .select()
    .maybeSingle();

  if (updateError) throw updateError;
  if (!confirmedRow) {
    return {
      ok: false,
      statusCode: 409,
      payload: {
        success: false,
        status: 'BLOCKED',
        code: 'DUPLICATE_SEND_BLOCKED',
        error: 'Duplicate send protection: this outreach draft is no longer eligible for manual confirmation.'
      }
    };
  }

  const warnings = [];
  let followUpPersisted = true;
  try {
    const { data: followUpDraft, error: followUpLookupError } = await db
      .from('follow_up_queue')
      .select('id,sequence_step')
      .eq('outreach_id', draft.id)
      .eq('dataset_id', datasetId)
      .eq('status', 'DRAFTED')
      .maybeSingle();

    if (followUpLookupError) {
      followUpPersisted = false;
    } else if (followUpDraft) {
      const step = String(Number.parseInt(followUpDraft.sequence_step, 10) || 0);
      const { error: queueUpdateError } = await db
        .from('follow_up_queue')
        .update({ status: followUpStatusAfterDraft({ draftCreated: true, smtpAccepted: true }), sequence_step: step })
        .eq('id', followUpDraft.id)
        .eq('dataset_id', datasetId);
      if (queueUpdateError) {
        followUpPersisted = false;
      } else if (Number(step) < 3) {
        const scheduledDate = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();
        const { error: nextError } = await db.from('follow_up_queue').insert({
          dataset_id: datasetId,
          outreach_id: draft.id,
          company_id: draft.company_id,
          contact_id: draft.contact_id,
          sequence_step: step,
          scheduled_for: scheduledDate,
          status: 'WAITING',
          created_at: new Date().toISOString()
        });
        if (nextError) followUpPersisted = false;
      }
    } else {
      const scheduledDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const { error: queueInsertError } = await db.from('follow_up_queue').insert({
        dataset_id: datasetId,
        outreach_id: draft.id,
        company_id: draft.company_id,
        contact_id: draft.contact_id,
        sequence_step: '1',
        scheduled_for: scheduledDate,
        status: 'WAITING',
        created_at: new Date().toISOString()
      });
      if (queueInsertError) followUpPersisted = false;
    }
  } catch {
    followUpPersisted = false;
  }
  if (!followUpPersisted) warnings.push('Follow-up scheduling needs review.');

  let crmPersisted = true;
  try {
    const { error: activityError } = await db.from('crm_activities').insert({
      dataset_id: datasetId,
      company_id: draft.company_id,
      contact_id: draft.contact_id,
      activity_type: 'EMAIL_MANUALLY_CONFIRMED_SENT',
      title: 'Manually confirmed sent via Gmail',
      description: 'Operator asserted that the approved outreach was sent in Gmail compose (manual assertion, not independently verified delivery).',
      source: 'MANUAL_GMAIL',
      metadata: {
        outreachId: draft.id,
        messageId,
        confirmedAt,
        confirmationType: 'MANUAL_USER_ASSERTION',
        deliveryVerified: false,
        operatorNote: sanitizedNote
      },
      created_at: new Date().toISOString()
    });
    if (activityError) crmPersisted = false;
  } catch {
    crmPersisted = false;
  }
  if (!crmPersisted) warnings.push('The CRM activity record needs review.');

  const auditResult = await logAuditFn(actorEmail, 'CONFIRM_MANUAL_GMAIL_SEND', 'outreach_emails', draft.id, {
    mode: MANUAL_EMAIL_MODE,
    confirmationType: 'MANUAL_USER_ASSERTION',
    deliveryVerified: false,
    messageId,
    confirmedAt
  });
  if (!auditResult?.persisted) warnings.push('The manual confirmation audit record needs review.');

  const stageResult = await persistStageFn('SMTP', 'COMPLETED', {
    recordsProcessed: 1,
    recordsProduced: 1,
    reason: 'Operator manually confirmed sending the approved outreach via Gmail compose. Recorded as a manual assertion, not independently verified delivery.',
    evidence: {
      mode: MANUAL_EMAIL_MODE,
      outreachId: draft.id,
      messageId,
      confirmedAt,
      confirmationType: 'MANUAL_USER_ASSERTION',
      deliveryVerified: false,
      automaticSendUsed: false
    }
  }, datasetId);

  return {
    ok: true,
    statusCode: 200,
    payload: {
      success: true,
      ok: true,
      status: 'MANUALLY_CONFIRMED_SENT',
      send_state: 'MANUALLY_CONFIRMED_SENT',
      confirmationType: 'MANUAL_USER_ASSERTION',
      deliveryVerified: false,
      mode: MANUAL_EMAIL_MODE,
      messageId,
      sentAt: confirmedAt,
      warnings,
      message: 'Manual send confirmation recorded as an operator assertion (not independently verified SMTP/API delivery).',
      outreach: confirmedRow,
      persistence: stagePersistenceEvidence(stageResult)
    }
  };
}

export function extractReplyEntities(text) {
  const entities = {
    product: null,
    quantity: null,
    requirement: null,
    price_request: false,
    timeline: null,
    urgency: 'NORMAL',
    location: null,
    action: 'REVIEW'
  };
  const body = String(text || '');
  const lower = body.toLowerCase();
  if (lower.includes('urgent') || lower.includes('asap') || lower.includes('immediately')) entities.urgency = 'HIGH';
  if (lower.includes('price') || lower.includes('quot') || lower.includes('cost')) entities.price_request = true;
  const quantity = body.match(/(\d+[\d,.]*)\s*(mt|metric tons|tons|kg|units|pcs|pieces|containers|pallets)/i);
  if (quantity) entities.quantity = quantity[0];
  const timeline = body.match(/(next week|end of month|q[1-4]|immediately|by\s+[a-z]+|\d+\s+days)/i);
  if (timeline) entities.timeline = timeline[0];
  return entities;
}

export function validateManualReplyInput(payload = {}) {
  const senderEmail = extractEmailAddress(payload.senderEmail || payload.sender_email || payload.from);
  if (!isValidOutreachEmail(senderEmail)) {
    throw Object.assign(
      new Error('Please enter a valid sender email address (for example, buyer@company.com).'),
      { code: 'INVALID_SENDER_EMAIL', status: 400 }
    );
  }

  const subject = String(payload.subject ?? '').trim();
  if (!subject) {
    throw Object.assign(
      new Error('Please provide the incoming email subject.'),
      { code: 'MISSING_REPLY_SUBJECT', status: 400 }
    );
  }
  if (subject.length > 500) {
    throw Object.assign(
      new Error('Subject line cannot exceed 500 characters.'),
      { code: 'SUBJECT_TOO_LONG', status: 400 }
    );
  }

  const bodyText = String(payload.bodyText ?? payload.body_text ?? payload.body ?? '').replace(/\r\n/g, '\n').trim();
  if (!bodyText) {
    throw Object.assign(
      new Error('Please paste the incoming email body text.'),
      { code: 'MISSING_REPLY_BODY', status: 400 }
    );
  }
  if (bodyText.length > 50000) {
    throw Object.assign(
      new Error('Reply body text cannot exceed 50,000 characters.'),
      { code: 'BODY_TOO_LONG', status: 400 }
    );
  }

  let receivedAt = new Date().toISOString();
  const rawReceivedAt = payload.receivedAt ?? payload.received_at;
  if (rawReceivedAt !== undefined && rawReceivedAt !== null && String(rawReceivedAt).trim() !== '') {
    const parsedDate = new Date(String(rawReceivedAt).trim());
    if (Number.isNaN(parsedDate.getTime())) {
      throw Object.assign(
        new Error('Received date is not a valid date/time format.'),
        { code: 'INVALID_RECEIVED_DATE', status: 400 }
      );
    }
    if (parsedDate.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      throw Object.assign(
        new Error('Received date cannot be more than 24 hours in the future.'),
        { code: 'INVALID_RECEIVED_DATE', status: 400 }
      );
    }
    receivedAt = parsedDate.toISOString();
  }

  const senderName = extractSenderDisplayName(
    payload.senderEmail || payload.sender_email || payload.from,
    payload.senderName || payload.sender_name,
    senderEmail
  );

  const rawExternalId = String(payload.externalMessageId || payload.messageId || '').trim();
  const normalizedSubject = normalizeReplySubject(subject);
  const normalizedBodyForHash = bodyText.replace(/\s+/g, ' ').toLowerCase();
  const contentFingerprint = createHash('sha256')
    .update(`${senderEmail}|${normalizedSubject}|${normalizedBodyForHash}`)
    .digest('hex')
    .slice(0, 32);

  const messageId = rawExternalId
    ? (rawExternalId.startsWith('<') && rawExternalId.endsWith('>') ? rawExternalId : `<${rawExternalId.replace(/[<>\s]/g, '')}>`)
    : `<manual-reply-${contentFingerprint}@manual.gmail.tradeintel>`;

  const selectedOutreachId = payload.selectedOutreachId !== undefined && payload.selectedOutreachId !== null && String(payload.selectedOutreachId).trim() !== ''
    ? Number(payload.selectedOutreachId)
    : null;

  if (selectedOutreachId !== null && (!Number.isSafeInteger(selectedOutreachId) || selectedOutreachId <= 0)) {
    throw Object.assign(
      new Error('Selected outreach thread ID must be a positive integer.'),
      { code: 'INVALID_OUTREACH_SELECTION', status: 400 }
    );
  }

  return {
    senderEmail,
    senderName,
    subject,
    normalizedSubject,
    bodyText,
    receivedAt,
    messageId,
    contentFingerprint,
    selectedOutreachId
  };
}

function formatOutreachCandidate(row) {
  return {
    outreachId: row.id,
    companyId: row.company_id || null,
    companyName: row.company_name || null,
    contactId: row.contact_id || null,
    contactName: row.contact_name || null,
    recipientEmail: row.recipient_email || null,
    productFocus: row.product_focus || null,
    subject: row.subject || '',
    status: row.status,
    sentAt: row.sent_at || row.created_at || null
  };
}

export async function resolveManualReplyAssociation({
  validated,
  datasetId,
  db = supabase
}) {
  const { data: contacts, error: contactError } = await db
    .from('contacts')
    .select('id,dataset_id,company_id,name,email,is_suppressed,verification_status')
    .eq('dataset_id', datasetId)
    .eq('email', validated.senderEmail);
  if (contactError) throw contactError;
  const contactList = Array.isArray(contacts) ? contacts : (contacts ? [contacts] : []);

  const { data: outreachRows, error: outreachError } = await db
    .from('outreach_emails')
    .select('id,dataset_id,lead_id,company_id,contact_id,company_name,contact_name,recipient_email,product_focus,subject,message_id,status,sent_at,created_at,personalization_evidence')
    .eq('dataset_id', datasetId)
    .in('status', ['SENT', 'MANUALLY_CONFIRMED_SENT', 'REPLIED'])
    .order('id', { ascending: false })
    .limit(100);
  if (outreachError) throw outreachError;
  const allSentOutreach = outreachRows || [];

  // If the admin explicitly selected an outreach thread to disambiguate
  if (validated.selectedOutreachId !== null) {
    const selected = allSentOutreach.find(row => Number(row.id) === validated.selectedOutreachId);
    if (!selected) {
      throw Object.assign(
        new Error(`Selected outreach thread #${validated.selectedOutreachId} was not found among sent or confirmed outreach in this dataset.`),
        { code: 'OUTREACH_THREAD_NOT_FOUND', status: 404 }
      );
    }
    const matchedContact = contactList.find(c => Number(c.id) === Number(selected.contact_id)) || contactList[0] || null;
    return {
      ambiguous: false,
      outreach: selected,
      contact: matchedContact,
      candidates: [formatOutreachCandidate(selected)]
    };
  }

  // Filter outreach rows sent to this exact sender email
  const recipientOutreach = allSentOutreach.filter(
    row => String(row.recipient_email || '').trim().toLowerCase() === validated.senderEmail
  );

  const recipientSubjectMatches = recipientOutreach.filter(
    row => validated.normalizedSubject && normalizeReplySubject(row.subject) === validated.normalizedSubject
  );

  // 1. Multiple outreach threads to the same recipient share the same normalized subject
  if (recipientSubjectMatches.length > 1) {
    return {
      ambiguous: true,
      reason: 'Multiple sent outreach threads to this recipient match the reply subject. Please select the exact outreach thread.',
      candidates: recipientSubjectMatches.map(formatOutreachCandidate),
      outreach: null,
      contact: contactList[0] || null
    };
  }

  // 2. Exactly 1 outreach thread to this recipient matches the normalized subject
  if (recipientSubjectMatches.length === 1) {
    const matchedOutreach = recipientSubjectMatches[0];
    const matchedContact = contactList.find(c => Number(c.id) === Number(matchedOutreach.contact_id)) || contactList[0] || null;
    return {
      ambiguous: false,
      outreach: matchedOutreach,
      contact: matchedContact,
      candidates: [formatOutreachCandidate(matchedOutreach)]
    };
  }

  // 3. No subject match for this recipient, but multiple outreach threads were sent to this recipient
  if (recipientOutreach.length > 1) {
    return {
      ambiguous: true,
      reason: 'Multiple outreach threads were sent to this sender address, and the reply subject does not uniquely match one thread. Please select the matching outreach thread.',
      candidates: recipientOutreach.map(formatOutreachCandidate),
      outreach: null,
      contact: contactList[0] || null
    };
  }

  // 4. Exactly 1 outreach thread was sent to this recipient
  if (recipientOutreach.length === 1) {
    const matchedOutreach = recipientOutreach[0];
    const matchedContact = contactList.find(c => Number(c.id) === Number(matchedOutreach.contact_id)) || contactList[0] || null;
    return {
      ambiguous: false,
      outreach: matchedOutreach,
      contact: matchedContact,
      candidates: [formatOutreachCandidate(matchedOutreach)]
    };
  }

  // 5. No outreach sent to this exact sender email; check if the reply subject matches sent outreach to another address (e.g., colleague reply)
  const crossRecipientSubjectMatches = allSentOutreach.filter(
    row => validated.normalizedSubject && normalizeReplySubject(row.subject) === validated.normalizedSubject
  );
  if (crossRecipientSubjectMatches.length >= 1) {
    return {
      ambiguous: true,
      reason: 'The sender email does not match the original outreach recipient, but the subject matches existing outreach thread(s). Please select the outreach thread to associate with this reply.',
      candidates: crossRecipientSubjectMatches.map(formatOutreachCandidate),
      outreach: null,
      contact: contactList[0] || null
    };
  }

  // 6. Multiple contacts share this email across different companies without an outreach thread
  if (contactList.length > 1) {
    return {
      ambiguous: true,
      reason: 'Multiple contact records match this sender email across companies. Please select the associated outreach thread.',
      candidates: allSentOutreach.slice(0, 10).map(formatOutreachCandidate),
      outreach: null,
      contact: contactList[0] || null
    };
  }

  return {
    ambiguous: false,
    outreach: null,
    contact: contactList[0] || null,
    candidates: []
  };
}

export async function importManualReply({
  payload,
  datasetId,
  actorEmail,
  classifyReplyFn,
  decideInboundSafetyFn,
  stopEmailFollowUpsFn,
  db = supabase,
  logAuditFn = logAudit,
  persistStageFn = persistExternalStage
}) {
  const validated = validateManualReplyInput(payload);

  // Check for duplicate by message_id or identical sender + normalized subject + body in the same dataset
  const { data: existingById, error: existingIdError } = await db
    .from('inbox_messages')
    .select('id,message_id,sender_email,subject,received_at')
    .eq('message_id', validated.messageId)
    .maybeSingle();
  if (existingIdError) throw existingIdError;

  if (existingById) {
    return {
      ok: false,
      statusCode: 409,
      payload: {
        success: false,
        status: 'DUPLICATE',
        code: 'DUPLICATE_REPLY_IMPORT',
        error: 'Duplicate reply detected: this incoming message has already been imported.',
        existingMessageId: existingById.id
      }
    };
  }

  const { data: senderMessages, error: senderMsgError } = await db
    .from('inbox_messages')
    .select('id,message_id,sender_email,subject,body_text')
    .eq('dataset_id', datasetId)
    .eq('sender_email', validated.senderEmail);
  if (senderMsgError) throw senderMsgError;

  const normalizedIncomingBody = validated.bodyText.replace(/\s+/g, ' ').toLowerCase();
  const duplicateContent = (senderMessages || []).find(row =>
    normalizeReplySubject(row.subject) === validated.normalizedSubject &&
    String(row.body_text || '').trim().replace(/\s+/g, ' ').toLowerCase() === normalizedIncomingBody
  );

  if (duplicateContent) {
    return {
      ok: false,
      statusCode: 409,
      payload: {
        success: false,
        status: 'DUPLICATE',
        code: 'DUPLICATE_REPLY_IMPORT',
        error: 'Duplicate reply detected: an incoming reply from this sender with identical subject and body already exists.',
        existingMessageId: duplicateContent.id
      }
    };
  }

  const association = await resolveManualReplyAssociation({
    validated,
    datasetId,
    db
  });

  if (association.ambiguous) {
    return {
      ok: false,
      statusCode: 409,
      payload: {
        success: false,
        status: 'AMBIGUOUS_MATCH',
        code: 'AMBIGUOUS_OUTREACH_MATCH',
        error: association.reason,
        candidates: association.candidates
      }
    };
  }

  const { outreach, contact } = association;
  const intent = classifyReplyFn(validated.subject, validated.bodyText);
  const effectiveContact = contact || (outreach ? {
    id: outreach.contact_id,
    company_id: outreach.company_id,
    name: outreach.contact_name,
    email: outreach.recipient_email,
    is_suppressed: false,
    verification_status: 'VERIFIED'
  } : null);

  const safety = decideInboundSafetyFn({
    intent,
    contact: effectiveContact,
    outreach
  });

  const entities = {
    ...extractReplyEntities(validated.bodyText),
    importMode: MANUAL_EMAIL_MODE,
    importSource: 'MANUAL_ADMIN_PASTED_REPLY',
    importedBy: actorEmail || 'admin',
    importedAt: new Date().toISOString()
  };

  const companyId = contact?.company_id || outreach?.company_id || null;
  const contactId = contact?.id || outreach?.contact_id || null;
  const genuineReply = Boolean(outreach && (!contact || !contact.is_suppressed));

  const { data: savedMessage, error: insertError } = await db
    .from('inbox_messages')
    .insert({
      dataset_id: datasetId,
      thread_id: outreach ? `thread_${outreach.id}` : `thread_${validated.messageId}`,
      message_id: validated.messageId,
      sender_email: validated.senderEmail,
      sender_name: validated.senderName || contact?.name || validated.senderEmail,
      recipient_email: outreach?.personalization_evidence?.manualConfirmation?.assertedBy || actorEmail || 'manual-gmail@voyageib.com',
      subject: validated.subject,
      body_text: validated.bodyText,
      intent,
      extracted_entities: entities,
      outreach_id: genuineReply ? outreach.id : null,
      company_id: companyId,
      contact_id: contactId,
      received_at: validated.receivedAt,
      is_read: false,
      created_at: new Date().toISOString()
    })
    .select()
    .single();
  if (insertError) throw insertError;

  if (safety.suppressContact || intent === 'UNSUBSCRIBE') {
    await db.query(
      `UPDATE contacts
          SET is_suppressed = true,
              suppression_reason = 'Unsubscribe detected in a manually imported reply.'
        WHERE lower(email) = lower($1)`,
      [validated.senderEmail]
    );
    await stopEmailFollowUpsFn(
      validated.senderEmail,
      'STOPPED_UNSUBSCRIBED',
      `Unsubscribe detected in manually imported inbox message ${validated.messageId}.`,
      db
    );
    if (outreach) {
      await db
        .from('follow_up_queue')
        .update({
          status: 'STOPPED_UNSUBSCRIBED',
          reason_stopped: `Unsubscribe detected in manually imported inbox message ${validated.messageId}.`
        })
        .eq('outreach_id', outreach.id)
        .eq('dataset_id', datasetId)
        .in('status', ['WAITING', 'DRAFTED', 'PROCESSING']);
    }
  } else if (genuineReply && outreach) {
    const { error: repliedError } = await db
      .from('outreach_emails')
      .update({ status: 'REPLIED' })
      .eq('id', outreach.id)
      .eq('dataset_id', datasetId)
      .in('status', ['SENT', 'MANUALLY_CONFIRMED_SENT', 'REPLIED']);
    if (repliedError) throw repliedError;

    await stopEmailFollowUpsFn(
      validated.senderEmail,
      'STOPPED_REPLY_RECEIVED',
      `Reply received in manually imported inbox message ${validated.messageId}.`,
      db
    );
    await db
      .from('follow_up_queue')
      .update({
        status: 'STOPPED_REPLY_RECEIVED',
        reason_stopped: `Reply received in manually imported inbox message ${validated.messageId}.`
      })
      .eq('outreach_id', outreach.id)
      .eq('dataset_id', datasetId)
      .in('status', ['WAITING', 'DRAFTED', 'PROCESSING']);
  }

  let leadCreated = false;
  if (genuineReply && COMMERCIAL_REPLY_INTENTS.includes(intent) && companyId) {
    const { data: company } = await db
      .from('companies')
      .select('name')
      .eq('id', companyId)
      .eq('dataset_id', datasetId)
      .maybeSingle();
    const { data: potential } = await db
      .from('company_potential')
      .select('total_score')
      .eq('dataset_id', datasetId)
      .eq('company_id', companyId)
      .maybeSingle();
    const { error: leadError } = await db.from('leads').insert({
      dataset_id: datasetId,
      dedup_key: `INBOX:${savedMessage.id}`,
      company_id: companyId,
      contact_id: contactId,
      company_name: company?.name || outreach?.company_name || null,
      contact_name: contact?.name || outreach?.contact_name || validated.senderName,
      product_requirement: entities.quantity || `Reply intent: ${intent}`,
      intent_type: intent,
      evidence: {
        source: 'MANUAL_GMAIL_REPLY_IMPORT',
        inboxMessageId: savedMessage.id,
        messageId: validated.messageId,
        outreachId: outreach?.id || null,
        subject: validated.subject,
        snippet: validated.bodyText.slice(0, 500),
        extractedEntities: entities
      },
      score: potential?.total_score ?? 0,
      confidence: null,
      recommended_human_action: `Review the manually imported ${intent} reply and decide the next human action. Do not make autonomous commercial commitments.`,
      status: 'NEW',
      created_at: new Date().toISOString()
    });
    if (!leadError) leadCreated = true;
  }

  try {
    await db.from('crm_activities').insert({
      dataset_id: datasetId,
      company_id: companyId,
      contact_id: contactId,
      activity_type: 'REPLY_RECEIVED',
      title: `Manual reply imported (${intent})`,
      description: `Admin imported reply from ${validated.senderEmail}: "${validated.subject}".${outreach ? ` Associated with outreach #${outreach.id}.` : ''}`,
      source: 'MANUAL_GMAIL',
      metadata: {
        inboxMessageId: savedMessage.id,
        messageId: validated.messageId,
        outreachId: outreach?.id || null,
        intent,
        extractedEntities: entities,
        receivedAt: validated.receivedAt,
        leadCreated
      },
      created_at: new Date().toISOString()
    });
  } catch {
    // Non-fatal CRM activity logging
  }

  await logAuditFn(actorEmail, 'IMPORT_MANUAL_REPLY', 'inbox_messages', savedMessage.id, {
    mode: MANUAL_EMAIL_MODE,
    senderEmail: validated.senderEmail,
    intent,
    outreachId: outreach?.id || null,
    genuineReply,
    unsubscribe: Boolean(safety.suppressContact || intent === 'UNSUBSCRIBE')
  });

  const stageResult = await persistStageFn('INBOX', 'COMPLETED', {
    recordsProcessed: 1,
    recordsProduced: 1,
    reason: 'Admin manually imported a prospect reply and ran AI reply classification and CRM history updates.',
    evidence: {
      source: 'MANUAL_GMAIL_REPLY_IMPORT',
      mode: MANUAL_EMAIL_MODE,
      synced: 1,
      genuineReplies: genuineReply ? 1 : 0,
      unsubscribes: safety.suppressContact || intent === 'UNSUBSCRIBE' ? 1 : 0,
      outreachId: outreach?.id || null,
      intent
    }
  }, datasetId);

  return {
    ok: true,
    statusCode: 201,
    payload: {
      success: true,
      status: 'IMPORTED',
      mode: MANUAL_EMAIL_MODE,
      message: savedMessage,
      intent,
      extractedEntities: entities,
      associatedOutreachId: outreach?.id || null,
      companyId,
      contactId,
      genuineReply,
      unsubscribe: Boolean(safety.suppressContact || intent === 'UNSUBSCRIBE'),
      leadCreated,
      persistence: stagePersistenceEvidence(stageResult)
    }
  };
}
