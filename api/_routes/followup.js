import supabase from '../_db-client.js';
import { apiErrorResponse, isDatabaseFailure, setCors, logAudit, requireAuth } from '../_utils.js';
import { persistExternalStage, stagePersistenceEvidence } from '../_external-pipeline.js';
import { followUpStatusAfterDraft, isValidOutreachEmail } from '../_outreach-guards.js';
import { resolveDatasetId } from '../_dataset-scope.js';

/**
 * CADENCE: INITIAL → WAIT (3 days) → FOLLOW-UP 1 → WAIT (4 days) → FOLLOW-UP 2 → STOP.
 * Stop Conditions:
 * - Reply received
 * - Bounced
 * - Unsubscribe / suppression
 * - Lead already converted
 * - Human intervened
 */

export default async function handler(req, res) {
  let followupStarted = false;
  let activeDatasetId = null;
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!(await requireAuth(req, res))) return;

  try {
    if (req.method === 'GET') {
      activeDatasetId = await resolveDatasetId(req);
      let followupQuery = supabase
        .from('follow_up_queue')
        .select('*, outreach_emails(*), companies(*), contacts(*)')
        .eq('dataset_id', activeDatasetId)
        .order('scheduled_for', { ascending: true });
      if (req.query?.companyId) followupQuery = followupQuery.eq('company_id', req.query.companyId);
      const { data, error } = await followupQuery;

      if (error) throw error;
      return res.status(200).json(data || []);
    }

    // POST: Process follow-up queue cycle
    if (req.method === 'POST') {
      activeDatasetId = await resolveDatasetId(req);
      followupStarted = true;

      const { data: queue, error: qErr } = await supabase
        .from('follow_up_queue')
        .select('*, outreach_emails(*), companies(*), contacts(*)')
        .eq('dataset_id', activeDatasetId)
        .eq('status', 'WAITING');

      if (qErr) throw qErr;

      let processed = 0;
      let stopped = 0;

      for (const item of queue || []) {
        const currentStep = Number.parseInt(item.sequence_step, 10);
        if (!Number.isFinite(currentStep)) {
          const { data: stoppedItem, error: stateError } = await supabase.from('follow_up_queue').update({
            status: 'FAILED',
            reason_stopped: 'sequence_step is not a valid numeric step.'
          }).eq('id', item.id).eq('dataset_id', activeDatasetId).eq('status', 'WAITING').select('id').maybeSingle();
          if (stateError) throw stateError;
          if (stoppedItem) stopped++;
          continue;
        }

        // 1. Check if reply received
        const { data: replies, error: repliesError } = await supabase
          .from('inbox_messages')
          .select('id')
          .eq('dataset_id', activeDatasetId)
          .eq('outreach_id', item.outreach_id);
        if (repliesError) throw repliesError;

        if (replies && replies.length > 0) {
          const { data: stoppedItem, error: stateError } = await supabase.from('follow_up_queue').update({
            status: 'STOPPED_REPLY_RECEIVED',
            reason_stopped: 'Reply received from prospect. Automated follow-ups terminated.'
          }).eq('id', item.id).eq('dataset_id', activeDatasetId).eq('status', 'WAITING').select('id').maybeSingle();
          if (stateError) throw stateError;
          if (stoppedItem) stopped++;
          continue;
        }

        if (item.outreach_emails?.status === 'BOUNCED') {
          const { data: stoppedItem, error: stateError } = await supabase.from('follow_up_queue').update({
            status: 'STOPPED_BOUNCE',
            reason_stopped: 'A delivery failure was received for this outreach. Follow-ups terminated.'
          }).eq('id', item.id).eq('dataset_id', activeDatasetId).eq('status', 'WAITING').select('id').maybeSingle();
          if (stateError) throw stateError;
          if (stoppedItem) stopped++;
          continue;
        }

        const { data: convertedLead, error: conversionError } = await supabase.from('leads')
          .select('id')
          .eq('dataset_id', activeDatasetId)
          .eq('company_id', item.company_id)
          .eq('status', 'CONVERTED')
          .limit(1)
          .maybeSingle();
        if (conversionError) throw conversionError;
        if (convertedLead) {
          const { data: stoppedItem, error: stateError } = await supabase.from('follow_up_queue').update({
            status: 'STOPPED_CONVERTED',
            reason_stopped: 'The lead is already converted. Follow-ups terminated.'
          }).eq('id', item.id).eq('dataset_id', activeDatasetId).eq('status', 'WAITING').select('id').maybeSingle();
          if (stateError) throw stateError;
          if (stoppedItem) stopped++;
          continue;
        }

        // 2. Check if contact is suppressed
        if (item.contacts && item.contacts.is_suppressed) {
          const { data: stoppedItem, error: stateError } = await supabase.from('follow_up_queue').update({
            status: 'STOPPED_UNSUBSCRIBED',
            reason_stopped: 'Recipient is suppressed or unsubscribed.'
          }).eq('id', item.id).eq('dataset_id', activeDatasetId).eq('status', 'WAITING').select('id').maybeSingle();
          if (stateError) throw stateError;
          if (stoppedItem) stopped++;
          continue;
        }

        if (!item.contacts || item.contacts.verification_status !== 'VERIFIED' || !isValidOutreachEmail(item.contacts.email)) {
          const { data: stoppedItem, error: stateError } = await supabase.from('follow_up_queue').update({
            status: 'STOPPED_MANUAL',
            reason_stopped: 'A verified contact with a syntactically valid email address is unavailable.'
          }).eq('id', item.id).eq('dataset_id', activeDatasetId).eq('status', 'WAITING').select('id').maybeSingle();
          if (stateError) throw stateError;
          if (stoppedItem) stopped++;
          continue;
        }

        // 3. Check sequence limit
        if (currentStep >= 3) {
          const { data: stoppedItem, error: stateError } = await supabase.from('follow_up_queue').update({
            status: 'STOPPED_MANUAL',
            reason_stopped: 'Maximum follow-up sequence completed (INITIAL -> FOLLOW-UP 1 -> FOLLOW-UP 2 -> STOP).'
          }).eq('id', item.id).eq('dataset_id', activeDatasetId).eq('status', 'WAITING').select('id').maybeSingle();
          if (stateError) throw stateError;
          if (stoppedItem) stopped++;
          continue;
        }

        // Check if scheduled time has passed
        if (new Date(item.scheduled_for) <= new Date()) {
          const { data: claimed, error: claimError } = await supabase
            .from('follow_up_queue')
            .update({ status: 'PROCESSING' })
            .eq('id', item.id).eq('dataset_id', activeDatasetId)
            .eq('status', 'WAITING')
            .select('id')
            .maybeSingle();
          if (claimError) throw claimError;
          if (!claimed) continue;

          // Generate follow-up draft
          const nextStep = currentStep + 1;
          const compName = item.companies?.name || item.outreach_emails?.company_name;
          const primaryItem = item.outreach_emails?.product_focus || item.companies?.primary_products?.[0];
          if (!compName || !primaryItem) {
            await supabase.from('follow_up_queue').update({
              status: 'STOPPED_MANUAL',
              reason_stopped: 'Company or product evidence from the original outreach is unavailable.'
            }).eq('id', item.id).eq('dataset_id', activeDatasetId).eq('status', 'PROCESSING');
            stopped++;
            continue;
          }

          const followUpSubject = `Following up: ${primaryItem}`;
          const followUpBody = `Dear ${item.contacts?.name || 'Procurement Team'},

I am following up on my previous note about ${primaryItem}, which appeared in the trade records used for my earlier message.

Would it be useful for me to share more information for your review? If this is not relevant, please let me know and I will stop following up.

Best regards,
Voyage International Business`;

          const { data: priorDraft, error: priorDraftError } = await supabase
            .from('outreach_emails')
            .select('id')
            .eq('company_id', item.company_id)
            .eq('dataset_id', activeDatasetId)
            .eq('contact_id', item.contact_id)
            .eq('status', 'APPROVAL_REQUIRED')
            .filter('personalization_evidence->>followUpQueueId', 'eq', String(item.id))
            .maybeSingle();
          if (priorDraftError) throw priorDraftError;

          const draftResult = priorDraft
            ? { data: priorDraft, error: null }
            : await supabase.from('outreach_emails').insert({
              dataset_id: activeDatasetId,
              lead_id: null,
              company_id: item.company_id,
              contact_id: item.contact_id,
              company_name: compName,
              contact_name: item.contacts?.name || 'Procurement Team',
              recipient_email: item.contacts?.email || '',
              product_focus: primaryItem,
              subject: followUpSubject,
              body_text: followUpBody,
              body_html: `<pre style="font-family: inherit; white-space: pre-wrap;">${followUpBody}</pre>`,
              personalization_evidence: {
                sequenceStep: nextStep,
                followUpQueueId: item.id,
                verifiedProduct: primaryItem,
                companyEvidence: { companyId: item.company_id, companyName: compName },
                basis: 'Original sent outreach and persisted company product evidence'
              },
              status: 'APPROVAL_REQUIRED',
              validation_passed: true,
              created_at: new Date().toISOString()
            }).select('id').single();
          if (draftResult.error) {
            await supabase.from('follow_up_queue').update({
              status: 'FAILED',
              reason_stopped: draftResult.error.message
            }).eq('id', item.id).eq('dataset_id', activeDatasetId);
            throw draftResult.error;
          }

          // A draft is awaiting human approval. The SMTP route marks it SENT
          // only after the server accepts it and schedules the next step.
          const { data: queueRow, error: queueError } = await supabase.from('follow_up_queue').update({
            status: followUpStatusAfterDraft({ draftCreated: true }),
            sequence_step: String(nextStep),
            outreach_id: draftResult.data.id
          }).eq('id', item.id).eq('dataset_id', activeDatasetId).eq('status', 'PROCESSING').select('id').maybeSingle();
          if (queueError) throw queueError;
          if (!queueRow) {
            await supabase.from('outreach_emails').update({
              status: 'DRAFT',
              validation_errors: ['Follow-up stopped because a reply or suppression arrived during draft generation.']
            }).eq('id', draftResult.data.id).eq('dataset_id', activeDatasetId);
            stopped++;
            continue;
          }

          processed++;
        }
      }

      await logAudit(req.user?.email, 'PROCESS_FOLLOWUP_QUEUE', 'follow_up_queue', '', { processed, stopped });
      const status = processed ? 'REVIEW_REQUIRED' : stopped ? 'REVIEW_REQUIRED' : 'COMPLETED';
      const reason = processed
        ? 'Follow-up drafts were created and each requires human approval before SMTP transmission.'
        : stopped
          ? 'Follow-up queue items were stopped by reply, suppression, contact, or sequence safety checks.'
          : null;
      const persistence = await persistExternalStage('FOLLOW_UP', status, {
        recordsProcessed: (queue || []).length,
        recordsProduced: processed,
        reason,
        blocker: processed ? 'Human approval and a successful SMTP acceptance are required before a follow-up becomes SENT.' : stopped ? 'Review stopped queue items before further outreach.' : null,
        evidence: { draftsCreated: processed, stopped, queueItemsRead: (queue || []).length, sentByDraftCreation: false }
      }, activeDatasetId);
      return res.status(200).json({ success: true, ok: true, draftsCreated: processed, stopped, persistence: stagePersistenceEvidence(persistence) });
    }

    // PUT: Manually cancel/stop follow-up
    if (req.method === 'PUT') {
      activeDatasetId = await resolveDatasetId(req);
      const { id, reason } = req.body;
      const { data, error } = await supabase
        .from('follow_up_queue')
        .update({
          status: 'STOPPED_MANUAL',
          reason_stopped: reason || 'Manually stopped by human operator'
        })
        .eq('id', id)
        .eq('dataset_id', activeDatasetId)
        .select()
        .single();

      if (error) throw error;
      return res.status(200).json(data);
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (followupStarted && !isDatabaseFailure(err)) {
      try {
        await persistExternalStage('FOLLOW_UP', 'FAILED', {
          reason: err.message || 'Follow-up processing failed.',
          error: { code: err.code || 'FOLLOW_UP_ERROR', message: err.message || 'Follow-up processing failed.' }
        }, activeDatasetId);
      } catch (stageError) {
        console.error(`[FOLLOW_UP] failure state persistence failed code=${stageError.code || 'DATABASE_ERROR'}`);
      }
    }
    console.error(`[FOLLOW_UP] request failed code=${err.code || 'DATABASE_ERROR'}`);
    return apiErrorResponse(res, err, 'FOLLOW_UP_ERROR');
  }
}
