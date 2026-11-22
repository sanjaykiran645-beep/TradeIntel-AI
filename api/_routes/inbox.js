import { ImapFlow } from 'imapflow';
import supabase from '../_db-client.js';
import { parseMimeMessage, normalizeReplySubject } from '../_mime-message.js';
import { normalizeDatabaseError, setCors, logAudit, getHostingerConfig, requireAuth } from '../_utils.js';
import { persistExternalStage, stagePersistenceEvidence } from '../_external-pipeline.js';
import { resolveDatasetId } from '../_dataset-scope.js';
import { isValidOutreachEmail } from '../_outreach-guards.js';
import { fetchGmailInboundMessages, sanitizeOAuthText } from '../_gmail-oauth.js';
import { importManualReply } from '../_manual-email.js';

const COMMERCIAL_INTENTS = ['INTERESTED', 'PRICE_REQUEST', 'QUOTE_REQUEST', 'PRODUCT_REQUEST', 'SAMPLE_REQUEST', 'MEETING_REQUEST', 'NEGOTIATION'];

export const REPLY_INTENTS = [
  'INTERESTED', 'PRICE_REQUEST', 'QUOTE_REQUEST', 'PRODUCT_REQUEST', 'CATALOG_REQUEST',
  'SAMPLE_REQUEST', 'MEETING_REQUEST', 'NEGOTIATION', 'QUESTION', 'FOLLOW_UP_REQUIRED',
  'NOT_INTERESTED', 'UNSUBSCRIBE', 'COMPLAINT', 'WRONG_RECIPIENT', 'OUT_OF_OFFICE', 'UNKNOWN'
];

export function classifyReply(subject, body) {
  const text = `${subject} ${body}`.toLowerCase();
  if (text.includes('unsubscribe') || text.includes('remove me') || text.includes('opt out') || text.includes('stop sending')) return 'UNSUBSCRIBE';
  if (text.includes('out of office') || text.includes('autoreply') || text.includes('on leave') || text.includes('away from my desk')) return 'OUT_OF_OFFICE';
  if (text.includes('wrong person') || text.includes('not working here') || text.includes('wrong recipient')) return 'WRONG_RECIPIENT';
  if (text.includes('not interested') || text.includes('no need') || text.includes("don't contact") || /\bpass\b/.test(text)) return 'NOT_INTERESTED';
  if (text.includes('complaint') || text.includes('poor service') || text.includes('unacceptable') || text.includes('misleading') || text.includes('formal grievance')) return 'COMPLAINT';
  if (text.includes('sample') || text.includes('specimen') || text.includes('lab test sample')) return 'SAMPLE_REQUEST';
  if (text.includes('catalog') || text.includes('brochure') || text.includes('spec sheet') || text.includes('datasheet')) return 'CATALOG_REQUEST';
  if (/\b(?:quote|quotation|rfq|proforma)\b/.test(text)) return 'QUOTE_REQUEST';
  if (/\b(?:price|pricing|rate|cost|cif|fob)\b/.test(text)) return 'PRICE_REQUEST';
  if (text.includes('meet') || text.includes('call') || text.includes('zoom') || text.includes('teams') || text.includes('schedule a time') || text.includes('discussion')) return 'MEETING_REQUEST';
  if (text.includes('negotiat') || text.includes('discount') || text.includes('payment term') || text.includes('target price')) return 'NEGOTIATION';
  if (text.includes('specification') || text.includes('certif') || text.includes('qa') || text.includes('inquiry') || text.includes('can you supply') || text.includes('available')) return 'PRODUCT_REQUEST';
  if (text.includes('interested') || text.includes('tell me more') || text.includes('sounds good') || text.includes('welcome') || text.includes('pleased')) return 'INTERESTED';
  if (text.includes('?')) return 'QUESTION';
  if (/follow[ -]?up|check back|reach out (?:again|later)|contact me (?:in|after)/.test(text)) return 'FOLLOW_UP_REQUIRED';
  return 'UNKNOWN';
}

export function isDeliveryFailureMessage(subject, body, sender) {
  const text = `${subject || ''} ${body || ''}`;
  const failureLanguage = /undeliverable|delivery failed|delivery failure|could not be delivered|returned mail|failure notice|delivery status notification.{0,50}(?:failure|failed)/i.test(text);
  const deliveryStatusFields = /(?:final-recipient|original-recipient|undelivered-to|diagnostic-code|status:\s*5\.)/i.test(text);
  const automatedSender = /(?:mailer-daemon|postmaster)/i.test(String(sender || ''));
  return failureLanguage && (automatedSender || deliveryStatusFields);
}

export function extractBouncedRecipient(body) {
  const match = String(body || '').match(/^\s*(?:Final-Recipient|Original-Recipient|Undelivered-To|Failed-Recipient)\s*:\s*(?:rfc822;\s*)?<?([^<>\s;]+@[^<>\s;]+)>?/im);
  const recipient = match?.[1]?.trim().toLowerCase() || '';
  return isValidOutreachEmail(recipient) ? recipient : null;
}

export function decideInboundSafety({ intent, contact, outreach }) {
  const unsubscribe = intent === 'UNSUBSCRIBE' && Boolean(contact);
  const genuineReply = Boolean(outreach && contact && !contact.is_suppressed);
  return {
    unsubscribe,
    genuineReply,
    stopFollowUps: unsubscribe || genuineReply,
    suppressContact: unsubscribe
  };
}

function extractEntities(text) {
  const entities = { product: null, quantity: null, requirement: null, price_request: false, timeline: null, urgency: 'NORMAL', location: null, action: 'REVIEW' };
  const lower = text.toLowerCase();
  if (lower.includes('urgent') || lower.includes('asap') || lower.includes('immediately')) entities.urgency = 'HIGH';
  if (lower.includes('price') || lower.includes('quot') || lower.includes('cost')) entities.price_request = true;
  const quantity = text.match(/(\d+[\d,.]*)\s*(mt|metric tons|tons|kg|units|pcs|pieces|containers|pallets)/i);
  if (quantity) entities.quantity = quantity[0];
  const timeline = text.match(/(next week|end of month|q[1-4]|immediately|by\s+[a-z]+|\d+\s+days)/i);
  if (timeline) entities.timeline = timeline[0];
  return entities;
}

function emailFromHeader(value) {
  return String(value || '').match(/<([^>]+)>/)?.[1]?.trim().toLowerCase()
    || String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase()
    || '';
}

function nameFromHeader(value, fallback) {
  const name = String(value || '').split('<')[0].replace(/^\s*"|"\s*$/g, '').trim();
  return name || fallback;
}

export function referencesMessage(message, outreach) {
  const references = `${message.inReplyTo || ''} ${message.references || ''}`.toLowerCase();
  const outboundMessageId = String(outreach.message_id || '').toLowerCase();
  if (outboundMessageId && references.includes(outboundMessageId)) return true;
  const outboundGmailThreadId = String(outreach.personalization_evidence?.smtpConfirmation?.gmailThreadId || '').trim();
  const inboundGmailThreadId = String(message.gmailThreadId || '').trim();
  if (outboundGmailThreadId && inboundGmailThreadId && outboundGmailThreadId === inboundGmailThreadId) return true;
  if (String(message.inReplyTo || message.references || '').trim()) return false;
  return Boolean(normalizeReplySubject(message.subject) && normalizeReplySubject(message.subject) === normalizeReplySubject(outreach.subject));
}

async function findContact(sender, datasetId, db = supabase) {
  const { data, error } = await db.from('contacts').select('id,dataset_id,company_id,name,email,is_suppressed,verification_status').eq('dataset_id', datasetId).eq('email', sender).maybeSingle();
  if (error) throw error;
  return data;
}

export async function findMatchingOutreach(sender, message, contact, datasetId, db = supabase) {
  if (!contact || contact.verification_status !== 'VERIFIED') return null;
  const { data, error } = await db
    .from('outreach_emails')
    .select('id,dataset_id,lead_id,company_id,contact_id,recipient_email,subject,message_id,status,personalization_evidence')
    .eq('dataset_id', datasetId)
    .eq('recipient_email', sender)
    .eq('contact_id', contact.id)
    .in('status', ['SENT', 'MANUALLY_CONFIRMED_SENT', 'REPLIED'])
    .order('id', { ascending: false })
    .limit(50);
  if (error) throw error;
  const rows = data || [];
  const referenceIds = `${message.inReplyTo || ''} ${message.references || ''}`.toLowerCase();
  if (referenceIds.trim()) return rows.find(row => referencesMessage(message, row)) || null;
  if (message.gmailThreadId) {
    const threadMatch = rows.find(row =>
      String(row.personalization_evidence?.smtpConfirmation?.gmailThreadId || '').trim() === String(message.gmailThreadId).trim()
    );
    if (threadMatch) return threadMatch;
  }
  const subjectMatches = rows.filter(row => referencesMessage(message, row));
  return subjectMatches.length === 1 ? subjectMatches[0] : null;
}

async function stopEmailFollowUps(email, status, reason, db = supabase) {
  if (!email) return;
  await db.query(
    `UPDATE follow_up_queue AS queue
        SET status = $2, reason_stopped = $3
       FROM contacts AS contact
      WHERE queue.dataset_id = contact.dataset_id
        AND queue.contact_id = contact.id
        AND lower(contact.email) = lower($1)
        AND queue.status IN ('WAITING', 'DRAFTED', 'PROCESSING')`,
    [email, status, reason]
  );
}

async function persistDeliveryFailure(message, messageId, sender, recipient, config, datasetId, receivedAt, db = supabase) {
  const { rows } = await db.query(
    `SELECT id, dataset_id, company_id, contact_id, recipient_email, subject
       FROM outreach_emails
      WHERE dataset_id = $1
        AND lower(recipient_email) = lower($2)
        AND status = 'SENT'
      ORDER BY id DESC
      LIMIT 1`,
    [datasetId, recipient]
  );
  const outreach = rows[0];
  if (!outreach) return false;

  const { data: savedMessage, error: messageError } = await db.from('inbox_messages').insert({
    dataset_id: datasetId,
    thread_id: `thread_${outreach.id}`,
    message_id: messageId,
    sender_email: sender,
    sender_name: sender,
    recipient_email: config.imap.user,
    subject: message.subject,
    body_text: message.bodyText,
    intent: 'UNKNOWN',
    extracted_entities: {
      deliveryFailure: true,
      failedRecipient: recipient,
      ...(message.gmailMessageId ? { gmailMessageId: message.gmailMessageId } : {}),
      ...(message.gmailThreadId ? { gmailThreadId: message.gmailThreadId } : {})
    },
    outreach_id: outreach.id,
    company_id: outreach.company_id,
    contact_id: outreach.contact_id,
    received_at: receivedAt || new Date().toISOString(),
    is_read: false,
    created_at: new Date().toISOString()
  }).select('id').single();
  if (messageError) throw messageError;

  const { error: outreachError } = await db.from('outreach_emails')
    .update({ status: 'BOUNCED' })
    .eq('id', outreach.id)
    .eq('dataset_id', datasetId)
    .eq('status', 'SENT');
  if (outreachError) throw outreachError;

  if (outreach.contact_id) {
    await db.query(
      `UPDATE contacts SET verification_status = 'BOUNCED' WHERE lower(email) = lower($1)`,
      [recipient]
    );
    await stopEmailFollowUps(recipient, 'STOPPED_BOUNCE', `Delivery failure received for ${recipient}; follow-ups stopped.`, db);
  } else {
    const { error: queueError } = await db.from('follow_up_queue')
      .update({ status: 'STOPPED_BOUNCE', reason_stopped: `Delivery failure received for ${recipient}; follow-ups stopped.` })
      .eq('outreach_id', outreach.id)
      .eq('dataset_id', datasetId)
      .in('status', ['WAITING', 'DRAFTED', 'PROCESSING']);
    if (queueError) throw queueError;
  }

  return Boolean(savedMessage);
}

async function persistInboundMessage(message, messageId, sender, senderName, contact, outreach, config, datasetId, db = supabase) {
  const intent = classifyReply(message.subject, message.bodyText);
  const safety = decideInboundSafety({ intent, contact, outreach });
  const entities = {
    ...extractEntities(message.bodyText),
    ...(message.gmailMessageId ? { gmailMessageId: message.gmailMessageId } : {}),
    ...(message.gmailThreadId ? { gmailThreadId: message.gmailThreadId } : {})
  };
  const companyId = contact?.company_id || outreach?.company_id || null;
  const contactId = contact?.id || outreach?.contact_id || null;
  const genuineReply = safety.genuineReply;
  const { data: savedMessage, error } = await db.from('inbox_messages').insert({
    dataset_id: datasetId,
    thread_id: outreach ? `thread_${outreach.id}` : `thread_${messageId}`,
    message_id: messageId,
    sender_email: sender,
    sender_name: senderName,
    recipient_email: config.imap.user,
    subject: message.subject,
    body_text: message.bodyText,
    intent,
    extracted_entities: entities,
    outreach_id: genuineReply ? outreach.id : null,
    company_id: companyId,
    contact_id: contactId,
    received_at: new Date().toISOString(),
    is_read: false,
    created_at: new Date().toISOString()
  }).select().single();
  if (error) throw error;

  if (safety.suppressContact) {
    await db.query(
      `UPDATE contacts
          SET is_suppressed = true,
              suppression_reason = 'Unsubscribe detected in a genuine inbound email.'
        WHERE lower(email) = lower($1)`,
      [sender]
    );
    await stopEmailFollowUps(sender, 'STOPPED_UNSUBSCRIBED', `Unsubscribe detected in genuine inbox message ${messageId}.`, db);
  } else if (genuineReply) {
    const { error: repliedError } = await db.from('outreach_emails').update({ status: 'REPLIED' }).eq('id', outreach.id).eq('dataset_id', datasetId).eq('status', 'SENT');
    if (repliedError) throw repliedError;
    await stopEmailFollowUps(sender, 'STOPPED_REPLY_RECEIVED', `Genuine reply received in inbox message ${messageId}.`, db);
  }

  if (genuineReply && COMMERCIAL_INTENTS.includes(intent)) {
    const { data: company, error: companyError } = await db.from('companies').select('name').eq('id', companyId).eq('dataset_id', datasetId).maybeSingle();
    if (companyError) throw companyError;
    const { data: potential, error: potentialError } = await db.from('company_potential').select('total_score').eq('dataset_id', datasetId).eq('company_id', companyId).maybeSingle();
    if (potentialError) throw potentialError;
    const { error: leadError } = await db.from('leads').insert({
      dataset_id: datasetId,
      dedup_key: `INBOX:${savedMessage.id}`,
      company_id: companyId,
      contact_id: contactId,
      company_name: company?.name || null,
      contact_name: contact.name || null,
      product_requirement: entities.quantity || `Reply intent: ${intent}`,
      intent_type: intent,
      evidence: {
        source: config.provider === 'GMAIL_OAUTH' ? 'GENUINE_GMAIL_API_REPLY' : 'GENUINE_IMAP_REPLY',
        inboxMessageId: savedMessage.id,
        messageId,
        subject: message.subject,
        snippet: message.bodyText.slice(0, 500),
        extractedEntities: entities
      },
      score: potential?.total_score ?? 0,
      confidence: null,
      recommended_human_action: `Review the genuine ${intent} reply and decide the next human action. Do not make autonomous commercial commitments.`,
      status: 'NEW',
      created_at: new Date().toISOString()
    });
    if (leadError) throw leadError;
  }

  return { savedMessage, intent, genuineReply, unsubscribe: intent === 'UNSUBSCRIBE' && Boolean(contact) };
}

export async function processInboundMimeItems({ items, config, datasetId, db = supabase }) {
  let synced = 0;
  let genuineReplies = 0;
  let unsubscribes = 0;
  let bounces = 0;
  let skippedMessages = 0;
  const seenMessageIds = new Set();
  const seenGmailIds = new Set();
  const mailboxAddress = String(config?.imap?.user || '').trim().toLowerCase();

  for await (const item of items) {
    if (!item?.source) { skippedMessages++; continue; }
    if (item.gmailMessageId) {
      if (seenGmailIds.has(item.gmailMessageId)) {
        skippedMessages++;
        continue;
      }
      seenGmailIds.add(item.gmailMessageId);
    }

    const parsed = parseMimeMessage(item.source);
    if (item.gmailMessageId) parsed.gmailMessageId = String(item.gmailMessageId);
    if (item.gmailThreadId) parsed.gmailThreadId = String(item.gmailThreadId);

    // Preserve the RFC 2822 Message-ID header. Never confuse Gmail API message IDs with RFC 2822 Message-IDs.
    const messageId = parsed.messageId || item.envelope?.messageId || (item.gmailMessageId ? `<gmail-msg-${item.gmailMessageId}@gmail.api>` : '');
    const sender = emailFromHeader(parsed.from) || item.envelope?.from?.[0]?.address?.toLowerCase() || '';
    const subject = parsed.subject || item.envelope?.subject || '';
    parsed.subject = subject;
    if (!messageId || !sender || !parsed.bodyText.trim()) { skippedMessages++; continue; }

    // Skip outbound messages sent by the configured mailbox itself
    if (mailboxAddress && sender === mailboxAddress && !isDeliveryFailureMessage(subject, parsed.bodyText, sender)) {
      skippedMessages++;
      continue;
    }

    if (seenMessageIds.has(messageId)) {
      continue;
    }
    seenMessageIds.add(messageId);

    const { data: existing, error: duplicateError } = await db.from('inbox_messages').select('id').eq('message_id', messageId).maybeSingle();
    if (duplicateError) throw duplicateError;
    if (existing) continue;

    const bouncedRecipient = extractBouncedRecipient(parsed.bodyText);
    if (bouncedRecipient && isDeliveryFailureMessage(subject, parsed.bodyText, sender)) {
      const receivedAt = item.envelope?.date ? new Date(item.envelope.date).toISOString() : null;
      const recorded = await persistDeliveryFailure(parsed, messageId, sender, bouncedRecipient, config, datasetId, receivedAt, db);
      if (recorded) bounces++;
      else skippedMessages++;
      continue;
    }

    const contact = await findContact(sender, datasetId, db);
    const outreach = await findMatchingOutreach(sender, parsed, contact, datasetId, db);
    const received = item.envelope?.date;
    const result = await persistInboundMessage(parsed, messageId, sender, nameFromHeader(parsed.from, contact?.name || sender), contact, outreach, config, datasetId, db);
    if (received) {
      const { error: timestampError } = await db.from('inbox_messages').update({ received_at: new Date(received).toISOString() }).eq('id', result.savedMessage.id).eq('dataset_id', datasetId);
      if (timestampError) console.error('Could not update received timestamp:', timestampError.message);
    }
    synced++;
    if (result.genuineReply) genuineReplies++;
    if (result.unsubscribe) unsubscribes++;
  }

  return { synced, genuineReplies, unsubscribes, bounces, skippedMessages };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'POST' && req.body?.action === 'IMPORT_MANUAL_REPLY') {
    if (!(await requireAuth(req, res, { adminOnly: true }))) return;
  } else if (!(await requireAuth(req, res))) {
    return;
  }

  try {
    if (req.method === 'POST' && req.body?.action === 'IMPORT_MANUAL_REPLY') {
      const datasetId = await resolveDatasetId(req);
      try {
        const result = await importManualReply({
          payload: req.body?.payload || req.body || {},
          datasetId,
          actorEmail: req.user?.email || null,
          classifyReplyFn: classifyReply,
          decideInboundSafetyFn: decideInboundSafety,
          stopEmailFollowUpsFn: stopEmailFollowUps,
          db: supabase
        });
        return res.status(result.statusCode).json(result.payload);
      } catch (manualErr) {
        if (manualErr?.status && manualErr.status >= 400 && manualErr.status < 500) {
          return res.status(manualErr.status).json({
            success: false,
            status: 'INVALID_INPUT',
            code: manualErr.code || 'MANUAL_REPLY_VALIDATION_ERROR',
            error: manualErr.message
          });
        }
        throw manualErr;
      }
    }

    const config = await getHostingerConfig();
    if (req.method === 'GET') {
      const datasetId = await resolveDatasetId(req);
      const inboxCompanyId = req.query?.companyId;
      let inboxQuery = supabase.from('inbox_messages').select('*, companies(*), contacts(*)').eq('dataset_id', datasetId).order('received_at', { ascending: false });
      if (inboxCompanyId) inboxQuery = inboxQuery.eq('company_id', inboxCompanyId);
      const { data, error } = await inboxQuery;
      if (error) throw error;
      return res.status(200).json(data || []);
    }

    if (req.method === 'POST') {
      const datasetId = await resolveDatasetId(req);
    if (req.body?.manualReply) {
        const reason = 'Manual reply injection is disabled. Reply and unsubscribe state is created only from genuine IMAP messages.';
        const persistence = await persistExternalStage('INBOX', 'BLOCKED', {
          reason,
          blocker: reason,
          evidence: { mailboxMessagesProcessed: 0, manualInjectionAllowed: false }
        });
        return res.status(409).json({
          success: false,
          status: 'BLOCKED',
          error: reason,
          code: 'MANUAL_REPLY_DISABLED',
          persistence: stagePersistenceEvidence(persistence)
        });
      }
      if (!config.imapConfigured) {
        const reason = config.imapReason || 'Hostinger IMAP credentials are not configured.';
        const persistence = await persistExternalStage('INBOX', 'BLOCKED', { reason, blocker: reason, evidence: { configured: false, messagesProcessed: 0 } });
        return res.status(503).json({ success: false, status: 'BLOCKED', synced: 0, reason, persistence: stagePersistenceEvidence(persistence) });
      }

      let synced = 0;
      let genuineReplies = 0;
      let unsubscribes = 0;
      let bounces = 0;
      let skippedMessages = 0;
      const inboxSourceLabel = config.provider === 'GMAIL_OAUTH' ? 'GMAIL_OAUTH_MAILBOX' : 'IMAP_MAILBOX';
      await persistExternalStage('INBOX', 'RUNNING', {
        reason: 'Connecting to the configured mailbox and processing only genuine mailbox messages.',
        evidence: { configured: true, source: inboxSourceLabel, syntheticInputUsed: false }
      });

      if (config.provider === 'GMAIL_OAUTH') {
        try {
          const items = await fetchGmailInboundMessages({ oauthConfig: config.imap.oauth });
          const counts = await processInboundMimeItems({ items, config, datasetId, db: supabase });
          synced = counts.synced;
          genuineReplies = counts.genuineReplies;
          unsubscribes = counts.unsubscribes;
          bounces = counts.bounces;
          skippedMessages = counts.skippedMessages;
        } catch (gmailError) {
          const sanitizedMessage = sanitizeOAuthText(gmailError?.message || 'Gmail OAuth inbox sync failed.');
          const persistence = await persistExternalStage('INBOX', 'FAILED', {
            recordsProcessed: synced,
            reason: 'Gmail API mailbox processing failed.',
            error: { message: sanitizedMessage },
            evidence: { configured: true, source: inboxSourceLabel, genuineReplies, unsubscribes, bounces, skippedMessages }
          });
          return res.status(502).json({
            success: false,
            status: 'FAILED',
            error: `Gmail OAuth inbox sync error: ${sanitizedMessage}`,
            synced,
            persistence: stagePersistenceEvidence(persistence)
          });
        }
      } else {
        const client = new ImapFlow({
          host: config.imap.host,
          port: config.imap.port,
          secure: config.imap.secure,
          auth: { user: config.imap.user, pass: config.imap.pass },
          logger: false
        });
        try {
          await client.connect();
          const lock = await client.getMailboxLock('INBOX');
          try {
            const messages = client.fetch({ seq: '1:*' }, { envelope: true, source: true }, { uid: true });
            const counts = await processInboundMimeItems({ items: messages, config, datasetId, db: supabase });
            synced = counts.synced;
            genuineReplies = counts.genuineReplies;
            unsubscribes = counts.unsubscribes;
            bounces = counts.bounces;
            skippedMessages = counts.skippedMessages;
          } finally {
            lock.release();
          }
          await client.logout();
        } catch (imapError) {
          try { await client.logout(); } catch { /* connection may not have completed */ }
          const persistence = await persistExternalStage('INBOX', 'FAILED', {
            recordsProcessed: synced,
            reason: 'IMAP mailbox processing failed after the recorded number of actual mailbox messages.',
            error: { message: imapError.message },
            evidence: { configured: true, source: 'IMAP_MAILBOX', genuineReplies, unsubscribes, bounces, skippedMessages }
          });
          return res.status(502).json({ success: false, status: 'FAILED', error: `Hostinger IMAP sync error: ${imapError.message}`, synced, persistence: stagePersistenceEvidence(persistence) });
        }
      }

      await logAudit(req.user?.email, 'SYNC_IMAP_INBOX', 'inbox_messages', '', { synced, genuineReplies, unsubscribes, bounces, skippedMessages });
      const persistence = await persistExternalStage('INBOX', 'COMPLETED', {
        recordsProcessed: synced + skippedMessages,
        recordsProduced: synced,
        evidence: { source: inboxSourceLabel, syntheticInputUsed: false, synced, genuineReplies, unsubscribes, bounces, skippedMessages }
      });
      return res.status(200).json({
        success: true,
        status: 'COMPLETED',
        synced,
        genuineReplies,
        unsubscribes,
        bounces,
        skippedMessages,
        persistence: stagePersistenceEvidence(persistence),
        checkedAt: new Date().toISOString()
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const errorCode = String(error?.code || '').toUpperCase();
    const databaseFailure = /^(PGRST|57P|42|427|428|DATABASE_)/.test(errorCode) || errorCode === '57014' ||
      (error instanceof TypeError && /fetch failed|network error/i.test(error.message || ''));
    const normalized = databaseFailure
      ? normalizeDatabaseError(error, 'Database request failed.')
      : { code: 'IMAP_UNAVAILABLE', status: 502, message: error?.message || 'Hostinger IMAP synchronization failed.' };
    const code = databaseFailure ? normalized.code : 'IMAP_UNAVAILABLE';
    const status = databaseFailure ? normalized.status : 502;
    console.error(`[INBOX] request failed code=${code}`);
    return res.status(status).json({ success: false, status: 'FAILED', error: normalized.message, code });
  }
}
