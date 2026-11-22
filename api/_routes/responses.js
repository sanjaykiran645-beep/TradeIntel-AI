import supabase from '../_db-client.js';
import { apiErrorResponse, setCors, logAudit, requireAuth } from '../_utils.js';
import { resolveDatasetId } from '../_dataset-scope.js';

export function isSupportedResponseDraftMode(mode) {
  return mode === 'MANUAL' || mode === 'SUPERVISED' || mode === 'AUTHORIZED_AUTOMATION';
}

/**
 * RESPONSE GENERATION RULES:
 * - NOT a sales agent: never autonomously sell, negotiate, close deals, accept orders, promise delivery, sign contracts or make commercial commitments.
 * - Missing information or commercial commitments = HUMAN REVIEW REQUIRED.
 * - All generated drafts remain pending until a human explicitly approves them.
 * - Autonomous reply sending is not available.
 */

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const adminOnly = req.method === 'PUT' && req.body?.action === 'APPROVE';
  if (!(await requireAuth(req, res, { adminOnly }))) return;

  try {
    if (req.method === 'GET') {
      const datasetId = await resolveDatasetId(req);
      const { inboxMessageId } = req.query;
      let query = supabase.from('response_drafts').select('*').eq('dataset_id', datasetId).order('created_at', { ascending: false });
      if (inboxMessageId) query = query.eq('inbox_message_id', inboxMessageId);

      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json(data || []);
    }

    if (req.method === 'POST') {
      const datasetId = await resolveDatasetId(req);
      const { inboxMessageId, mode } = req.body || {};
      if (!inboxMessageId) return res.status(400).json({ error: 'inboxMessageId required' });

      // Fetch message and company
      const { data: msg, error: messageError } = await supabase
        .from('inbox_messages')
        .select('*, companies(*), contacts(*)')
        .eq('id', inboxMessageId)
        .eq('dataset_id', datasetId)
        .maybeSingle();

      if (messageError) throw messageError;
      if (!msg) return res.status(404).json({ error: 'Inbox message not found' });

      const intent = msg.intent || 'QUESTION';
      if (mode && !isSupportedResponseDraftMode(mode)) return res.status(400).json({ error: 'Unknown response mode.', code: 'INVALID_RESPONSE_MODE' });
      const sender = msg.sender_email;
      const entities = msg.extracted_entities || {};

      let requiresHuman = false;
      const reviewReasons = [];

      // Commercial commitment detection
      if (intent === 'PRICE_REQUEST' || intent === 'QUOTE_REQUEST' || intent === 'NEGOTIATION') {
        requiresHuman = true;
        reviewReasons.push('Commercial terms, pricing quotation and discounts require human authorization.');
      }
      if (intent === 'MEETING_REQUEST') {
        requiresHuman = true;
        reviewReasons.push('Meeting schedule requires human availability confirmation.');
      }
      if (intent === 'COMPLAINT' || intent === 'UNKNOWN') {
        requiresHuman = true;
        reviewReasons.push('Complaint or unclassified messages require a human response review.');
      }
      if (intent === 'NOT_INTERESTED' || intent === 'UNSUBSCRIBE' || intent === 'WRONG_RECIPIENT') {
        requiresHuman = true;
        reviewReasons.push('Contact-preference messages require human review before any response is sent.');
      }
      if (entities.quantity) {
        requiresHuman = true;
        reviewReasons.push(`Volume requirement (${entities.quantity}) requires supply feasibility review.`);
      }

      const activeMode = mode || 'SUPERVISED';

      // Safe Voyage International Business factual reply body
      let replyBody = '';
      if (intent === 'PRICE_REQUEST' || intent === 'QUOTE_REQUEST') {
        replyBody = `Dear Partner,

Thank you for your inquiry and interest in Voyage International Business.

We have received your request regarding procurement solutions and specifications. To ensure our export team provides you with an accurate quotation with full QA certifications, our senior trade director will review your exact requirements and revert with our formal commercial proposal.

In the meantime, please feel free to review our credentials at www.voyageib.com.

Best regards,

Voyage International Business
Procurement Operations Hub (Bengaluru) & European HQ (Krakow)
info@voyageib.com`;
      } else if (intent === 'CATALOG_REQUEST' || intent === 'PRODUCT_REQUEST') {
        replyBody = `Dear Partner,

Thank you for your message.

At Voyage International Business, we specialize in verified end-to-end sourcing with direct presence in both Bengaluru, India and Krakow, Poland. All shipments come with comprehensive Quality Assurance (QA) certifications tailored to international standards.

Our product specialist will share the detailed product specifications and export compliance documentation directly with you.

Looking forward to assisting your supply chain.

Best regards,

Voyage International Business
www.voyageib.com`;
      } else if (intent === 'COMPLAINT') {
        replyBody = `Dear Partner,\n\nThank you for bringing this to our attention. We have recorded your message for review by our team.\n\nBest regards,\nVoyage International Business`;
      } else if (intent === 'UNSUBSCRIBE' || intent === 'NOT_INTERESTED' || intent === 'WRONG_RECIPIENT') {
        replyBody = `Dear Partner,\n\nWe have recorded your contact preference and will not send further outreach about this inquiry.\n\nBest regards,\nVoyage International Business`;
      } else {
        replyBody = `Dear Partner,

Thank you for your response.

We have recorded your notes and our team is reviewing your requirements. We will be in touch shortly to assist you further.

Best regards,

Voyage International Business
www.voyageib.com`;
      }

      const { data: draft, error: dErr } = await supabase
        .from('response_drafts')
        .insert({
          dataset_id: datasetId,
          inbox_message_id: msg.id,
          recipient_email: sender,
          subject: String(msg.subject || '').startsWith('Re:') ? msg.subject : `Re: ${msg.subject || ''}`,
          body_text: replyBody,
          mode: activeMode,
          status: 'PENDING_APPROVAL',
          requires_human_review: requiresHuman,
          review_reasons: reviewReasons,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (dErr) throw dErr;

      await logAudit(req.user?.email, 'GENERATE_RESPONSE_DRAFT', 'response_drafts', draft.id, {
        intent,
        requiresHuman
      });

      return res.status(201).json(draft);
    }

    if (req.method === 'PUT') {
      const datasetId = await resolveDatasetId(req);
      const { id, action, editedBody } = req.body || {};
      if (!id || !action) return res.status(400).json({ error: 'id and action required' });

      if (action === 'APPROVE') {
        const { data, error } = await supabase
          .from('response_drafts')
          .update({
            status: 'APPROVED',
            body_text: editedBody || undefined
          })
          .eq('id', id)
          .eq('dataset_id', datasetId)
          .eq('status', 'PENDING_APPROVAL')
          .select()
          .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ error: 'Only a pending response draft can be approved.' });
        await logAudit(req.user?.email, 'APPROVE_RESPONSE_DRAFT', 'response_drafts', id);
        return res.status(200).json(data);
      }

      if (action === 'REJECT') {
        const { data, error } = await supabase
          .from('response_drafts')
          .update({ status: 'REJECTED' })
          .eq('id', id)
          .eq('dataset_id', datasetId)
          .eq('status', 'PENDING_APPROVAL')
          .select()
          .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ error: 'Only a pending response draft can be rejected.' });
        return res.status(200).json(data);
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(`[RESPONSES] request failed code=${err.code || 'DATABASE_ERROR'}`);
    return apiErrorResponse(res, err, 'RESPONSES_ERROR');
  }
}
