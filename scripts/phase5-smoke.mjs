process.env.NODE_ENV = 'development';

import { startTestAuthServer, TEST_ADMIN_TOKEN } from './_test-auth-server.mjs';

const authServer = await startTestAuthServer();
process.env.SUPABASE_AUTH_URL = authServer.url;
process.env.SUPABASE_AUTH_ANON_KEY = 'offline-phase5-test-anon-key';

const [{ default: supervisor }, { default: dashboard }, { default: leadsApi }, { default: emailEngine }, { default: research }, { default: supabase, dbConfigured }] = await Promise.all([
  import('../api/_routes/supervisor.js'),
  import('../api/_routes/dashboard.js'),
  import('../api/_routes/leads.js'),
  import('../api/_routes/email-engine.js'),
  import('../api/_routes/research.js'),
  import('../api/_db-client.js')
]);

if (!dbConfigured || !supabase) throw new Error('Supabase server configuration is missing. Load .env.vercel.local before running this integration smoke test.');

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; },
    end() { return this; }
  };
}

async function invoke(handler, method = 'GET', body = {}, query = {}) {
  const res = responseStub();
  await handler({ method, body, query, headers: { authorization: 'Bearer ' + TEST_ADMIN_TOKEN } }, res);
  return res;
}

const { data: dataset, error: datasetError } = await supabase.from('datasets').select('id,valid_rows').eq('id', 9).maybeSingle();
if (datasetError) throw datasetError;
if (!dataset) throw new Error('Dataset 9 was not found.');

const { count: sentBefore, error: sentBeforeError } = await supabase.from('outreach_emails').select('id', { count: 'exact', head: true }).eq('status', 'SENT');
if (sentBeforeError) throw sentBeforeError;

const pipelineResponse = process.env.PHASE5_SKIP_PIPELINE === '1'
  ? await invoke(supervisor)
  : await invoke(supervisor, 'POST', { dataset_id: 9, retry: true });
if (![200, 207].includes(pipelineResponse.statusCode)) throw new Error(`Supervisor returned HTTP ${pipelineResponse.statusCode}: ${pipelineResponse.body?.error || 'unknown error'}`);
const persistedPipeline = pipelineResponse.body?.pipeline || pipelineResponse.body?.latestPipeline;
if (!persistedPipeline) throw new Error('Supervisor did not return persisted pipeline state.');

const { data: persistedDataset, error: persistedDatasetError } = await supabase.from('datasets').select('detected_entities').eq('id', 9).single();
if (persistedDatasetError) throw persistedDatasetError;
const savedPipeline = persistedDataset.detected_entities?.pipeline;
if (!savedPipeline || savedPipeline.runId !== persistedPipeline.runId) throw new Error('Supervisor results were not persisted on dataset 9.');
const stagesMissingTimestamps = Object.entries(savedPipeline.stages || {})
  .filter(([, stage]) => !stage.startedAt || !stage.updatedAt || !stage.completedAt)
  .map(([name]) => name);
if (stagesMissingTimestamps.length) throw new Error(`Pipeline stages missing persisted timestamps: ${stagesMissingTimestamps.join(', ')}.`);
const pandasEvidence = savedPipeline.stages?.PANDAS_ANALYSIS?.evidence?.analysis;
if (savedPipeline.stages?.PANDAS_ANALYSIS?.status === 'COMPLETED' && pandasEvidence?.recordsProcessed !== dataset.valid_rows) {
  throw new Error('Pandas result does not match the persisted dataset row count.');
}
const pipelineDraftPreview = savedPipeline.stages?.EMAIL_DRAFT?.evidence?.nonSendablePreview;
if (savedPipeline.stages?.EMAIL_DRAFT?.status === 'REVIEW_REQUIRED' && (!pipelineDraftPreview || pipelineDraftPreview.sendable !== false || pipelineDraftPreview.recipientEmail !== null)) {
  throw new Error('The persisted pipeline is missing its addressless, non-sendable draft preview.');
}

const dashboardResponse = await invoke(dashboard);
if (dashboardResponse.statusCode !== 200) throw new Error(`Dashboard smoke failed with HTTP ${dashboardResponse.statusCode}.`);
const supervisorRead = await invoke(supervisor);
if (supervisorRead.statusCode !== 200 || supervisorRead.body.latestPipeline?.runId !== savedPipeline.runId) throw new Error('Supervisor GET did not return the persisted run.');
const leadsResponse = await invoke(leadsApi);
if (leadsResponse.statusCode !== 200) throw new Error(`Leads API smoke failed with HTTP ${leadsResponse.statusCode}.`);

const persistedPotentialLeads = (leadsResponse.body || []).filter(lead => lead.evidence?.source === 'company_potential');
const { count: potentialLeadCount, error: potentialLeadError } = await supabase
  .from('leads')
  .select('id', { count: 'exact', head: true })
  .eq('intent_type', 'COMPANY_POTENTIAL');
if (potentialLeadError) throw potentialLeadError;
if (persistedPotentialLeads.length !== (potentialLeadCount || 0)) throw new Error(`Leads API returned ${persistedPotentialLeads.length} potential leads while SQL count found ${potentialLeadCount}.`);
if (dashboardResponse.body?.metrics?.qualifiedLeads !== (potentialLeadCount || 0)) throw new Error('Dashboard lead count does not match the persisted leads table.');
const qualification = savedPipeline.stages?.LEAD_QUALIFICATION;
if (qualification?.status === 'COMPLETED' && (potentialLeadCount || 0) < qualification.recordsProduced) throw new Error('Qualification completed but fewer evidence-backed potential leads are persisted than the stage reported.');

const researchCompanyId = persistedPotentialLeads[0]?.company_id;
let researchCheck = { status: 'SKIPPED', reason: 'No qualified lead was produced.' };
if (researchCompanyId) {
  const researchResponse = await invoke(research, 'POST', { companyId: researchCompanyId });
  if (researchResponse.statusCode !== 503 || researchResponse.body?.status !== 'BLOCKED') throw new Error('Research provider absence was not returned as an explicit blocker.');
  researchCheck = { status: researchResponse.body.status, reason: researchResponse.body.error };
}

let draftCheck = { status: 'SKIPPED', reason: 'No qualified lead was produced.' };
if (persistedPotentialLeads[0]) {
  const draftResponse = await invoke(emailEngine, 'POST', { leadId: persistedPotentialLeads[0].id });
  if (![201, 200, 409].includes(draftResponse.statusCode)) throw new Error(`Email draft smoke returned HTTP ${draftResponse.statusCode}.`);
  if (draftResponse.body?.status === 'SENT') throw new Error('Email draft test unexpectedly reports a send.');
  if (draftResponse.body?.preview) {
    const preview = draftResponse.body.preview;
    if (preview.sendable !== false || preview.recipientAssigned || preview.recipientEmail) throw new Error('Addressless preview must remain non-sendable and must not invent a recipient.');
    const lead = persistedPotentialLeads[0];
    if (!preview.bodyText.includes(lead.company_name) || !(lead.evidence?.companyEvidence?.products || []).some(product => preview.bodyText.includes(product))) {
      throw new Error('Personalized preview is not grounded in the persisted lead/company/product evidence.');
    }
  }
  draftCheck = {
    status: draftResponse.body?.status || draftResponse.body?.status,
    httpStatus: draftResponse.statusCode,
    reason: draftResponse.body?.reason || null,
    previewCreated: Boolean(draftResponse.body?.preview),
    previewSendable: draftResponse.body?.preview?.sendable ?? null,
    previewEvidence: draftResponse.body?.preview?.evidence || null
  };
}

const { count: sentAfter, error: sentAfterError } = await supabase.from('outreach_emails').select('id', { count: 'exact', head: true }).eq('status', 'SENT');
if (sentAfterError) throw sentAfterError;
if (sentAfter !== sentBefore) throw new Error('A sent-email count changed during the no-send smoke test.');

const statuses = Object.fromEntries(Object.entries(savedPipeline.stages || {}).map(([id, stage]) => [id, stage.status]));
console.log(JSON.stringify({
  apiSmoke: 'COMPLETED',
  datasetId: 9,
  datasetRowsExpected: dataset.valid_rows,
  supervisorStatus: savedPipeline.status,
  runId: savedPipeline.runId,
  stages: statuses,
  pandas: {
    status: savedPipeline.stages?.PANDAS_ANALYSIS?.status,
    recordsProcessed: savedPipeline.stages?.PANDAS_ANALYSIS?.recordsProcessed,
    persistedAnalysisRecords: pandasEvidence?.recordsProcessed || 0,
    blocker: savedPipeline.stages?.PANDAS_ANALYSIS?.blocker || null,
    error: savedPipeline.stages?.PANDAS_ANALYSIS?.error || null
  },
  sqlRisk: savedPipeline.stages?.SQL_RISK_ANALYSIS?.evidence || null,
  leadQualification: {
    status: qualification?.status,
    recordsProcessed: qualification?.recordsProcessed,
    recordsProduced: qualification?.recordsProduced,
    evidenceBackedLeadsPersisted: potentialLeadCount || 0,
    leadsApiReturned: persistedPotentialLeads.length
  },
  researchCheck,
  emailDraftCheck: draftCheck,
  persistedDraftPreview: pipelineDraftPreview ? { sendable: pipelineDraftPreview.sendable, recipientAssigned: pipelineDraftPreview.recipientAssigned, subject: pipelineDraftPreview.subject, evidence: pipelineDraftPreview.evidence } : null,
  dashboardPersistedLeadCount: dashboardResponse.body.metrics.qualifiedLeads,
  sentEmailsBeforeAndAfter: [sentBefore || 0, sentAfter || 0]
}));
await authServer.close();
