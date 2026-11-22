import supabase from '../_db-client.js';
import { generateDatasetLeadPreviews, generatePersonalizedDraft } from '../_email-drafts.js';
import { analyzeDatasetConcentrationRisk } from '../_sql-risk-analysis.js';
import { apiErrorResponse, isDatabaseFailure, setCors, logAudit, requireAuth } from '../_utils.js';
import { persistExternalStage, stagePersistenceEvidence } from '../_external-pipeline.js';
import { approvalBlocker, isEmailGloballySuppressed } from '../_outreach-guards.js';
import { resolveDatasetId } from '../_dataset-scope.js';
import { confirmManualGmailSent, openGmailComposeForOutreach } from '../_manual-email.js';

export default async function handler(req, res) {
  let activeStage = null;
  let activeDatasetId = null;
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const adminOnly = req.method === 'PUT' && req.body?.action === 'APPROVE';
  if (!(await requireAuth(req, res, { adminOnly }))) return;
  if (
    req.method === 'PUT' &&
    ['OPEN_GMAIL_COMPOSE', 'CONFIRM_MANUAL_SENT'].includes(req.body?.action) &&
    !(await requireAuth(req, res, { adminOnly: true }))
  ) {
    return;
  }

  try {
    if (req.method === 'GET') {
      const datasetId = await resolveDatasetId(req);
      activeDatasetId = datasetId;
      const { status, companyId } = req.query;
      let query = supabase.from('outreach_emails').select('*, companies(*), contacts(*)').eq('dataset_id', datasetId).order('id', { ascending: false });
      if (status) query = query.eq('status', status);
      if (companyId) query = query.eq('company_id', companyId);
      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json(data || []);
    }

    if (req.method === 'POST') {
      activeStage = 'EMAIL_DRAFT';
      const datasetId = await resolveDatasetId(req);
      activeDatasetId = datasetId;
      const { action, leadId, companyId, contactId } = req.body || {};
      if (action === 'GENERATE_DATASET_PREVIEWS') {
        const risk = await analyzeDatasetConcentrationRisk(datasetId);
        const { data: dataset, error: datasetError } = await supabase
          .from('datasets')
          .select('detected_entities')
          .eq('id', datasetId)
          .maybeSingle();
        if (datasetError) throw datasetError;
        if (!dataset) throw Object.assign(new Error(`Dataset ${datasetId} was not found.`), { code: 'DATASET_NOT_FOUND', status: 404 });
        const previousRisk = dataset.detected_entities?.pipeline?.stages?.SQL_RISK_ANALYSIS?.evidence || {};
        const riskPersistence = await persistExternalStage('SQL_RISK_ANALYSIS', 'COMPLETED', {
          recordsProcessed: Number(risk.summary?.targetCompanyCount || 0),
          recordsProduced: Number(risk.summary?.targetCompanyCount || 0),
          reason: 'Calculated descriptive market, product, and IEC supplier concentration indices. No default, credit, fraud, or geopolitical probability was inferred.',
          evidence: {
            ...previousRisk,
            source: 'Managed PostgreSQL normalized transactions and persisted IEC supplier factor evidence',
            concentrationMetrics: risk.summary,
            leadCompaniesWithRiskEvidence: (risk.lead_signals || []).length
          }
        }, datasetId);
        if (!riskPersistence.persisted) {
          throw Object.assign(new Error(riskPersistence.reason || 'Risk evidence could not be persisted.'), { code: 'RISK_EVIDENCE_PERSISTENCE_FAILED' });
        }

        const previews = await generateDatasetLeadPreviews({
          datasetId,
          riskSignals: risk.lead_signals || []
        });
        const reason = previews.skippedUsableContact
          ? 'Company-level previews were withheld for leads with a verified contact; use the existing contact-backed draft flow for those leads.'
          : 'Non-sendable, addressless previews use persisted company/product evidence. Contact and research providers are unavailable.';
        const persistedStage = await persistExternalStage('EMAIL_DRAFT', 'REVIEW_REQUIRED', {
          recordsProcessed: previews.qualifiedLeads,
          recordsProduced: previews.generated,
          reason,
          blocker: 'No verified contact is available for sending; previews are not sendable.',
          evidence: {
            qualifiedLeads: previews.qualifiedLeads,
            generatedCompanyLevelPreviews: previews.generated,
            existingPreviews: previews.existingPreviews,
            skippedMissingProductEvidence: previews.skippedMissingProductEvidence,
            skippedUsableContact: previews.skippedUsableContact,
            contactProviderConfigured: false,
            researchProviderConfigured: false,
            sendable: false,
            emailSendingEnabled: false,
            sent: false
          }
        }, datasetId);
        return res.status(200).json({
          success: true,
          status: 'REVIEW_REQUIRED',
          datasetId,
          riskSummary: risk.summary,
          ...previews,
          sendable: false,
          emailSendingEnabled: false,
          sent: false,
          persistence: {
            risk: stagePersistenceEvidence(riskPersistence),
            emailDraft: stagePersistenceEvidence(persistedStage)
          }
        });
      }
      if (!leadId && !companyId) return res.status(400).json({ error: 'leadId or companyId required' });
      const result = await generatePersonalizedDraft({ datasetId, leadId, companyId, contactId, userEmail: req.user?.email });
      if (result.status === 'REVIEW_REQUIRED') {
        const persistedStage = await persistExternalStage('EMAIL_DRAFT', 'REVIEW_REQUIRED', {
          recordsProcessed: 1,
          recordsProduced: 0,
          reason: result.reason,
          blocker: result.reason,
          evidence: result.preview ? { sendable: false, preview: result.preview } : { sendable: false }
        }, datasetId);
        // `error` mirrors `reason` so every client surfaces the actual business rule instead of a bare HTTP 409.
        return res.status(409).json({ success: false, status: result.status, error: result.reason, reason: result.reason, preview: result.preview || null, code: 'DRAFT_REVIEW_REQUIRED', persistence: stagePersistenceEvidence(persistedStage) });
      }
      if (result.status === 'EXISTS') {
        const persistedStage = await persistExternalStage('EMAIL_DRAFT', 'COMPLETED', {
          recordsProcessed: 1,
          recordsProduced: 0,
          reason: result.reason,
          evidence: { existingDraftId: result.draftId, created: false }
        }, datasetId);
        return res.status(200).json({ success: true, status: result.status, draftId: result.draftId, reason: result.reason, persistence: stagePersistenceEvidence(persistedStage) });
      }
      await persistExternalStage('EMAIL_DRAFT', 'COMPLETED', {
        recordsProcessed: 1,
        recordsProduced: 1,
        evidence: {
          outreachId: result.draft.id,
          leadId: result.draft.personalization_evidence?.leadId || null,
          sendable: true,
          approvalRequired: true,
          recipientEmailValidated: true
        }
      }, datasetId);
      return res.status(201).json(result.draft);
    }

    if (req.method === 'PUT') {
      activeStage = 'HUMAN_APPROVAL';
      const datasetId = await resolveDatasetId(req);
      activeDatasetId = datasetId;
      const { id, action } = req.body || {};
      if (!id || !action) return res.status(400).json({ error: 'id and action required' });

      const { data: draft, error: draftError } = await supabase
        .from('outreach_emails')
        .select('*, contacts(*)')
        .eq('id', id)
        .eq('dataset_id', datasetId)
        .maybeSingle();
      if (draftError) throw draftError;
      if (!draft) {
        const reason = 'Outreach draft not found; no approval was recorded.';
        const persistedStage = await persistExternalStage('HUMAN_APPROVAL', 'BLOCKED', {
          reason,
          blocker: reason,
          evidence: { approved: false, outreachRecordFound: false }
        }, datasetId);
        return res.status(404).json({ error: reason, persistence: stagePersistenceEvidence(persistedStage) });
      }

      if (action === 'APPROVE') {
        const blocker = approvalBlocker(draft);
        if (blocker) {
          const persistedStage = await persistExternalStage('HUMAN_APPROVAL', 'BLOCKED', {
            reason: blocker,
            blocker,
            evidence: { approved: false, outreachRecordFound: true, currentStatus: draft.status }
          }, datasetId);
          return res.status(409).json({ error: blocker, persistence: stagePersistenceEvidence(persistedStage) });
        }

        if (await isEmailGloballySuppressed(draft.recipient_email)) {
          const reason = 'Approval is blocked because the recipient email is suppressed in the shared workspace.';
          const persistedStage = await persistExternalStage('HUMAN_APPROVAL', 'BLOCKED', {
            reason,
            blocker: reason,
            evidence: { approved: false, recipientSuppressed: true }
          }, datasetId);
          return res.status(409).json({ error: reason, persistence: stagePersistenceEvidence(persistedStage) });
        }

        const { data: stoppedQueue, error: stopError } = await supabase
          .from('follow_up_queue')
          .select('id,status')
          .eq('outreach_id', id)
          .eq('dataset_id', datasetId)
          .in('status', ['STOPPED_REPLY_RECEIVED', 'STOPPED_UNSUBSCRIBED', 'STOPPED_BOUNCE', 'STOPPED_CONVERTED', 'STOPPED_MANUAL'])
          .limit(1)
          .maybeSingle();
        if (stopError) throw stopError;
        if (stoppedQueue) {
          const reason = `Approval is blocked because this sequence is ${stoppedQueue.status}.`;
          const persistedStage = await persistExternalStage('HUMAN_APPROVAL', 'BLOCKED', {
            reason,
            blocker: reason,
            evidence: { approved: false, sequenceStatus: stoppedQueue.status }
          }, datasetId);
          return res.status(409).json({ error: reason, persistence: stagePersistenceEvidence(persistedStage) });
        }

        const { data, error } = await supabase
          .from('outreach_emails')
          .update({ status: 'APPROVED', approved_by: req.user?.email || null, approved_at: new Date().toISOString() })
          .eq('id', id)
          .eq('dataset_id', datasetId)
          .eq('status', 'APPROVAL_REQUIRED')
          .select()
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          const reason = 'Draft status changed before approval was saved.';
          const persistedStage = await persistExternalStage('HUMAN_APPROVAL', 'BLOCKED', {
            reason,
            blocker: reason,
            evidence: { approved: false, statusConflict: true }
          }, datasetId);
          return res.status(409).json({ error: reason, persistence: stagePersistenceEvidence(persistedStage) });
        }
        await logAudit(req.user?.email, 'APPROVE_EMAIL', 'outreach_emails', id);
        await persistExternalStage('HUMAN_APPROVAL', 'COMPLETED', {
          recordsProcessed: 1,
          recordsProduced: 1,
          evidence: { approved: true, outreachId: data.id, approvalRecorded: true }
        }, datasetId);
        return res.status(200).json(data);
      }

      if (action === 'REJECT') {
        if (draft.status !== 'APPROVAL_REQUIRED') return res.status(409).json({ error: 'Only a draft awaiting approval can be rejected.' });
        const { data, error } = await supabase
          .from('outreach_emails')
          .update({ status: 'DRAFT', validation_errors: ['Rejected by reviewer for further editing'] })
          .eq('id', id)
          .eq('dataset_id', datasetId)
          .eq('status', 'APPROVAL_REQUIRED')
          .select()
          .single();
        if (error) throw error;
        await persistExternalStage('HUMAN_APPROVAL', 'REVIEW_REQUIRED', {
          recordsProcessed: 1,
          recordsProduced: 0,
          reason: 'Draft was rejected by a human reviewer and requires revision.',
          blocker: 'Human review required before any send.',
          evidence: { approved: false, outreachId: data.id, decision: 'REJECTED' }
        }, datasetId);
        return res.status(200).json(data);
      }

      if (action === 'OPEN_GMAIL_COMPOSE') {
        activeStage = 'SMTP';
        const outcome = await openGmailComposeForOutreach({
          draft,
          datasetId,
          actorEmail: req.user?.email || null,
          db: supabase
        });
        return res.status(outcome.statusCode).json(outcome.payload);
      }

      if (action === 'CONFIRM_MANUAL_SENT') {
        activeStage = 'SMTP';
        const outcome = await confirmManualGmailSent({
          draft,
          datasetId,
          actorEmail: req.user?.email || null,
          operatorNote: req.body?.operatorNote || req.body?.note || '',
          db: supabase
        });
        return res.status(outcome.statusCode).json(outcome.payload);
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    if (activeStage && !isDatabaseFailure(error)) {
      try {
        await persistExternalStage(activeStage, 'FAILED', {
          reason: error.message || 'External stage failed.',
          error: { code: error.code || 'EXTERNAL_STAGE_ERROR', message: error.message || 'External stage failed.' }
        }, activeDatasetId);
      } catch (stageError) {
        console.error(`[EMAIL_ENGINE] failure state persistence failed code=${stageError.code || 'DATABASE_ERROR'}`);
      }
    }
    console.error(`[EMAIL_ENGINE] request failed code=${error.code || 'DATABASE_ERROR'}`);
    return apiErrorResponse(res, error, 'EMAIL_ENGINE_ERROR');
  }
}
