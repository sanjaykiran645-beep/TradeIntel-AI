import supabase from '../_db-client.js';
import { apiErrorResponse, setCors, requireAuth } from '../_utils.js';
import { persistExternalStage, stagePersistenceEvidence } from '../_external-pipeline.js';
import { resolveDatasetId } from '../_dataset-scope.js';
import { getProviderCapabilities } from '../_provider-capabilities.js';
import researchProvider from '../_research-provider.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!(await requireAuth(req, res))) return;

  try {
    if (req.method === 'GET') {
      const { companyId } = req.query;
      const datasetId = await resolveDatasetId(req);
      let query = supabase.from('web_research').select('*').eq('dataset_id', datasetId).order('researched_at', { ascending: false });
      if (companyId) query = query.eq('company_id', companyId);

      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json(data || []);
    }

    if (req.method === 'POST') {
      const datasetId = await resolveDatasetId(req);
      const companyId = Number(req.body?.companyId ?? req.body?.company_id);
      if (!Number.isSafeInteger(companyId) || companyId <= 0) {
        return res.status(400).json({ error: 'A valid companyId is required.', code: 'COMPANY_ID_REQUIRED' });
      }

      // Check provider configuration
      const capabilities = await getProviderCapabilities();
      if (!(capabilities.research && capabilities.research.configured)) {
        const reason = 'No real web research provider or provider credentials are configured. No research records were created.';
        const persistedStage = await persistExternalStage('RESEARCH', 'BLOCKED', {
          reason,
          blocker: 'Research provider not configured.',
          evidence: { provider: null, providerConfigured: false, recordsCreated: 0 }
        }, datasetId);
        return res.status(503).json({
          success: false,
          status: 'BLOCKED',
          stage: 'RESEARCH',
          error: reason,
          code: 'RESEARCH_PROVIDER_NOT_CONFIGURED',
          persistence: stagePersistenceEvidence(persistedStage)
        });
      }

      const { data: company, error: companyError } = await supabase.from('companies')
        .select('id,name,country')
        .eq('id', companyId)
        .eq('dataset_id', datasetId)
        .maybeSingle();
      if (companyError) throw companyError;
      if (!company) return res.status(404).json({ error: 'Company was not found in the selected dataset.', code: 'COMPANY_NOT_IN_DATASET' });

      // Perform research via provider
      const { data, requestCount = 0 } = await researchProvider.performResearch(datasetId, company);
      if (!data || !['COMPLETED', 'NO_EVIDENCE'].includes(data.status)) {
        const configured = data?.status === 'NOT_CONFIGURED';
        const status = configured ? 'BLOCKED' : 'FAILED';
        const reason = configured
          ? 'Research provider is not configured. No research result was saved.'
          : 'Research provider failed or returned an unrecognized result. No research result was saved.';
        const persistence = await persistExternalStage('RESEARCH', status, {
          recordsProcessed: requestCount,
          recordsProduced: 0,
          reason,
          blocker: configured ? 'Research provider is not configured.' : 'Research provider result was not confirmed.',
          error: configured ? null : { code: 'RESEARCH_PROVIDER_FAILED' },
          evidence: { providerConfigured: !configured, providerResultAccepted: false, recordsCreated: 0 }
        }, datasetId);
        return res.status(configured ? 503 : 502).json({
          success: false,
          status,
          stage: 'RESEARCH',
          error: reason,
          code: configured ? 'RESEARCH_PROVIDER_NOT_CONFIGURED' : 'RESEARCH_PROVIDER_FAILED',
          persistence: stagePersistenceEvidence(persistence)
        });
      }
      const { error: researchWriteError } = await supabase.from('web_research')
        .upsert({
          dataset_id: datasetId,
          company_id: companyId,
          result: data,
          updated_at: new Date().toISOString()
        }, { onConflict: 'dataset_id,company_id' });
      if (researchWriteError) throw researchWriteError;
      const noEvidence = data.status === 'NO_EVIDENCE';
      const persistedStage = await persistExternalStage('RESEARCH', noEvidence ? 'REVIEW_REQUIRED' : 'COMPLETED', {
        recordsProcessed: requestCount,
        recordsProduced: 1,
        reason: noEvidence ? 'The research provider completed the search but returned no supporting sources.' : null,
        evidence: { providerConfigured: true, providerResultAccepted: true, evidenceFound: !noEvidence }
      }, datasetId);
      return res.status(200).json({
        success: true,
        status: noEvidence ? 'NO_EVIDENCE' : 'COMPLETED',
        company_id: companyId,
        company_name: company.name,
        data,
        persistence: stagePersistenceEvidence(persistedStage)
      });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(`[RESEARCH] request failed code=${err.code || 'DATABASE_ERROR'}`);
    return apiErrorResponse(res, err, 'RESEARCH_ERROR');
  }
}
