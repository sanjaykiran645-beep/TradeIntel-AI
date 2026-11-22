import { randomUUID } from 'node:crypto';
import supabase from '../_db-client.js';
import { calculatePotentialScores } from './intelligence.js';
import { materializeTradeEntities } from '../_pipeline-entities.js';
import { countRawRecordsForDataset } from '../_dataset-counts.js';
import { analyzePersistedDatasetWithPandas } from '../_python-analysis.js';
import { analyzeSqlRiskAndSafety } from '../_sql-risk-analysis.js';
import { qualifyCompaniesFromPotential } from '../_lead-qualification.js';
import { POTENTIAL_SCORE_VALIDATION_SQL } from '../_potential-score-validation.js';
import { cleanupCompletedAnalysisDatasets } from '../_dataset-retention.js';
import {
  claimSupervisorPipelineRun,
  compareAndSetSupervisorPipeline,
  createSupervisorRunLease,
  decideSupervisorRun,
  SUPERVISOR_RUN_HEARTBEAT_MS
} from '../_supervisor-run-lease.js';
import { buildLeadDraftPreview, generatePersonalizedDraft } from '../_email-drafts.js';
import { apiErrorResponse, normalizeDatabaseError, setCors, getHostingerConfig, requireAuth } from '../_utils.js';
import { getProviderCapabilities } from '../_provider-capabilities.js';
import researchProvider from '../_research-provider.js';
import { persistSupervisorResearch } from '../_supervisor-research-persistence.js';

const STAGE_DEFINITIONS = [
  ['DATASET_VALIDATION', 'Dataset persistence validation'],
  ['ENTITY_AGGREGATION', 'Company, product, and market aggregation'],
  ['INTELLIGENCE', 'Existing eight-factor company potential scoring'],
  ['PANDAS_ANALYSIS', 'Python/Pandas analysis of persisted normalized rows'],
  ['SQL_RISK_ANALYSIS', 'SQL-backed qualification and outreach safety checks'],
  ['LEAD_QUALIFICATION', 'Persist company-potential-qualified leads with evidence'],
  ['RESEARCH', 'Public web research'],
  ['CONTACT_DISCOVERY', 'Verified public business contact discovery'],
  ['EMAIL_DRAFT', 'Evidence-based email draft generation'],
  ['HUMAN_APPROVAL', 'Human approval before transmission'],
  ['SMTP', 'Human-approved SMTP transmission'],
  ['INBOX', 'Genuine IMAP reply synchronization'],
  ['FOLLOW_UP', 'Reply- and suppression-aware follow-up cadence'],
  ['FINAL_RESULTS', 'Persisted leads and dashboard result confirmation']
];

const COMPANY_FILTER_BATCH_SIZE = 300;

function chunks(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

async function countRows(table, ...filters) {
  let query = supabase.from(table).select('id', { count: 'exact' }).limit(1);
  for (const filter of filters) if (filter) query = query.eq(filter[0], filter[1]);
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

async function countRowsForCompanies(table, companyIds, datasetId) {
  let total = 0;
  for (const batch of chunks(companyIds, COMPANY_FILTER_BATCH_SIZE)) {
    const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).eq('dataset_id', datasetId).in('company_id', batch);
    if (error) throw Object.assign(new Error(error.message || error.code || 'Database request failed.'), { code: error.code || 'DATABASE_ERROR' });
    total += count || 0;
  }
  return total;
}

async function readRowsForCompanies(table, columns, companyIds, datasetId, configure = query => query) {
  const rows = [];
  for (const batch of chunks(companyIds, COMPANY_FILTER_BATCH_SIZE)) {
    let query = supabase.from(table).select(columns).eq('dataset_id', datasetId).in('company_id', batch);
    query = configure(query);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

function stageResult(status, details = {}, previous = null) {
  const now = new Date().toISOString();
  const running = status === 'RUNNING';
  return {
    status,
    startedAt: previous?.startedAt || now,
    updatedAt: now,
    completedAt: running ? null : now,
    recordsProcessed: details.recordsProcessed ?? details.items ?? 0,
    recordsProduced: details.recordsProduced ?? 0,
    items: details.items ?? details.recordsProcessed ?? 0,
    reason: details.reason || null,
    blocker: details.blocker || null,
    error: details.error || null,
    evidence: details.evidence || null,
    ...details
  };
}

function stagesForResponse(stages = {}) {
  return STAGE_DEFINITIONS.map(([id, name]) => ({
    id,
    name,
    status: stages[id]?.status || 'QUEUED',
    items: stages[id]?.items || 0,
    recordsProcessed: stages[id]?.recordsProcessed || 0,
    recordsProduced: stages[id]?.recordsProduced || 0,
    startedAt: stages[id]?.startedAt || null,
    updatedAt: stages[id]?.updatedAt || null,
    completedAt: stages[id]?.completedAt || null,
    reason: stages[id]?.reason || null,
    blocker: stages[id]?.blocker || null,
    error: stages[id]?.error || null,
    evidence: stages[id]?.evidence || null
  }));
}

function overallStatus(stages) {
  const statuses = Object.values(stages).map(stage => stage.status);
  if (statuses.includes('FAILED')) return 'FAILED';
  if (statuses.includes('BLOCKED')) return 'BLOCKED';
  if (statuses.includes('REVIEW_REQUIRED')) return 'REVIEW_REQUIRED';
  if (statuses.length !== STAGE_DEFINITIONS.length || statuses.includes('QUEUED')) return 'QUEUED';
  return statuses.every(status => status === 'COMPLETED') ? 'COMPLETED' : 'REVIEW_REQUIRED';
}

function pipelineForResponse(pipeline) {
  if (!pipeline || typeof pipeline !== 'object') return pipeline;
  const visiblePipeline = { ...pipeline };
  delete visiblePipeline.lease;
  return visiblePipeline;
}

async function validateDatasetPersistence(dataset) {
  const [rawRows, normalizedRows, validRows, duplicateRows, invalidRows] = await Promise.all([
    countRawRecordsForDataset(dataset.id),
    countRows('normalized_records', ['dataset_id', dataset.id]),
    countRows('raw_records', ['dataset_id', dataset.id], ['is_valid', true], ['is_duplicate', false]),
    countRows('raw_records', ['dataset_id', dataset.id], ['is_duplicate', true]),
    countRows('raw_records', ['dataset_id', dataset.id], ['is_valid', false])
  ]);
  // Persist fresh metadata to ensure deterministic IMPORTING → RECONCILING → READY lifecycle.
  const { error: metaError } = await supabase.from('datasets').update({
    total_rows: rawRows,
    valid_rows: validRows,
    duplicate_rows: duplicateRows,
    error_rows: invalidRows,
    status: 'RECONCILING'
  }).eq('id', dataset.id);
  if (metaError) throw metaError;
  const matches =
    (validRows + duplicateRows + invalidRows === rawRows) &&
    normalizedRows === validRows;
  const expected = { totalRows: rawRows, validRows, duplicateRows, errorRows: invalidRows };
  const actual = { rawRows, normalizedRows, validRows, duplicateRows, invalidRows };
  return { matches, expected, actual };
}

async function updatePipeline(datasetId, currentEntities, pipeline, expectedToken, expectedLeaseOwnerToken, expectedUpdatedAt, recoveryExpiresBefore = null) {
  const { data: currentDataset, error: currentDatasetError } = await supabase.from('datasets')
    .select('analysis_status,analysis_completed_at')
    .eq('id', datasetId)
    .maybeSingle();
  if (currentDatasetError) throw currentDatasetError;
  const saved = await compareAndSetSupervisorPipeline(supabase, {
    datasetId,
    currentEntities,
    pipeline,
    expectedPipelineToken: expectedToken,
    expectedLeaseOwnerToken,
    expectedUpdatedAt,
    currentDataset,
    recoveryExpiresBefore
  });
  return saved
    ? { ...saved, retentionRequired: saved.analysisStatus === 'COMPLETED' }
    : null;
}

async function runCompletedAnalysisRetention(datasetId) {
  try {
    const retention = await cleanupCompletedAnalysisDatasets(datasetId);
    if (['FAILED', 'PARTIAL', 'COMPLETED_UNVERIFIED'].includes(retention.status)) {
      console.error(`[RETENTION] completed-analysis cleanup status=${retention.status} dataset=${datasetId}`);
    }
  } catch (retentionError) {
    console.error(`[RETENTION] completed-analysis cleanup failed dataset=${datasetId} code=${retentionError.code || 'RETENTION_ERROR'}`);
  }
}

async function getDataset(datasetId) {
  const { data, error } = await supabase
    .from('datasets')
    .select('id,filename,file_type,total_rows,valid_rows,duplicate_rows,error_rows,column_mapping,detected_entities,status,created_at,import_status,analysis_status,analysis_completed_at,updated_at')
    .eq('id', datasetId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createRun(datasetId, token) {
  const { data, error } = await supabase.from('agent_runs').insert({
    dataset_id: datasetId,
    idempotency_key: token,
    status: 'RUNNING',
    stage_state: {},
    started_at: new Date().toISOString()
  }).select('id,started_at').single();
  if (error) throw error;
  return data;
}

async function setRunResponse(res, statusCode, datasetId, pipeline) {
  return res.status(statusCode).json({
    success: pipeline.status === 'COMPLETED',
    datasetId,
    runId: pipeline.runId,
    status: pipeline.status,
    stages: stagesForResponse(pipeline.stages),
    pipeline: pipelineForResponse(pipeline)
  });
}

function setStage(pipeline, id, status, details = {}) {
  pipeline.stages[id] = stageResult(status, details, pipeline.stages[id]);
}

async function recordFinalResults(pipeline, targetCompanyIds, datasetId) {
  const [leadCount, totalLeadCount] = await Promise.all([
    targetCompanyIds.length ? countRowsForCompanies('leads', targetCompanyIds, datasetId) : 0,
    countRows('leads', ['dataset_id', datasetId])
  ]);
  setStage(pipeline, 'FINAL_RESULTS', 'COMPLETED', {
    recordsProcessed: leadCount,
    recordsProduced: leadCount,
    evidence: { persistedDatasetLeads: leadCount, persistedTotalLeads: totalLeadCount, dashboardSource: 'leads table' }
  });
}

async function runPipeline(req, res) {
  const datasetId = Number(req.body?.dataset_id ?? req.body?.datasetId);
  if (!Number.isSafeInteger(datasetId) || datasetId <= 0) {
    return res.status(400).json({ success: false, status: 'FAILED', error: 'A valid dataset_id is required.', code: 'DATASET_ID_REQUIRED' });
  }

  let dataset = await getDataset(datasetId);
  if (!dataset) return res.status(404).json({ success: false, status: 'FAILED', error: `Dataset ${datasetId} was not found.`, code: 'DATASET_NOT_FOUND' });

  const importStatus = dataset.detected_entities?.import?.status;
  if (importStatus !== 'COMPLETED') {
    return res.status(409).json({
      success: false,
      status: importStatus,
      datasetId,
      error: `Dataset ${datasetId} is not a successfully completed import; analysis cannot start yet.`,
      code: 'DATASET_IMPORT_NOT_READY'
    });
  }

  const currentEntities = dataset.detected_entities && typeof dataset.detected_entities === 'object' ? dataset.detected_entities : {};
  if (currentEntities.retentionCleanup?.status === 'RUNNING') {
    return res.status(409).json({
      success: false,
      status: 'REVIEW_REQUIRED',
      datasetId,
      error: `Dataset ${datasetId} is being removed by completed-analysis retention.`,
      code: 'DATASET_RETENTION_IN_PROGRESS'
    });
  }
  const previous = currentEntities.pipeline || null;
  const runDecisionAt = Date.now();
  const runDecision = decideSupervisorRun(previous, req.body?.retry === true, runDecisionAt);
  if (runDecision.action === 'RETURN_COMPLETED') return setRunResponse(res, 200, datasetId, previous);
  if (runDecision.action === 'RETURN_RUNNING') return setRunResponse(res, 202, datasetId, previous);
  if (runDecision.action === 'DENY_ACTIVE') {
    return res.status(409).json({
      success: false,
      status: 'RUNNING',
      datasetId,
      error: `The supervisor worker still holds an active lease until ${runDecision.lease.expiresAt}. Wait for it to expire before requesting recovery.`,
      code: 'PIPELINE_ALREADY_RUNNING',
      leaseExpiresAt: runDecision.lease.expiresAt
    });
  }
  if (runDecision.action === 'RECOVERY_AVAILABLE') {
    return res.status(409).json({
      success: false,
      status: 'RUNNING',
      datasetId,
      error: `The supervisor worker lease expired at ${runDecision.lease.expiresAt}. Set retry=true to request a compare-and-set recovery claim.`,
      code: 'PIPELINE_LEASE_EXPIRED',
      leaseExpiresAt: runDecision.lease.expiresAt
    });
  }
  if (runDecision.action === 'DENY_UNVERIFIED') {
    return res.status(409).json({
      success: false,
      status: 'RUNNING',
      datasetId,
      error: 'This RUNNING pipeline has no valid ownership lease. It was left unchanged; verify that its worker is stopped and reconcile the run before retrying.',
      code: 'PIPELINE_LEASE_UNVERIFIED'
    });
  }

  const resumeAfterEntityAggregation = req.body?.resumeAfterStage === 'ENTITY_AGGREGATION' &&
    previous?.status === 'REVIEW_REQUIRED' &&
    previous.pauseAfterStage === 'ENTITY_AGGREGATION' &&
    previous.stages?.DATASET_VALIDATION?.status === 'COMPLETED' &&
    previous.stages?.ENTITY_AGGREGATION?.status === 'COMPLETED' &&
    Number.isSafeInteger(Number(previous.runId));
  const resumeAfterPandasAnalysis = req.body?.resumeAfterStage === 'PANDAS_ANALYSIS' &&
    previous?.status === 'FAILED' &&
    previous.stages?.DATASET_VALIDATION?.status === 'COMPLETED' &&
    previous.stages?.ENTITY_AGGREGATION?.status === 'COMPLETED' &&
    previous.stages?.PANDAS_ANALYSIS?.status === 'FAILED' &&
    Number(previous.stages.PANDAS_ANALYSIS.attempt || 1) <= 2 &&
    Number.isSafeInteger(Number(previous.runId));
  const resumeAfterPandasSuccess = req.body?.resumeAfterStage === 'PANDAS_ANALYSIS' &&
    previous?.status === 'REVIEW_REQUIRED' &&
    previous.pauseAfterStage === 'PANDAS_ANALYSIS' &&
    previous.stages?.DATASET_VALIDATION?.status === 'COMPLETED' &&
    previous.stages?.ENTITY_AGGREGATION?.status === 'COMPLETED' &&
    previous.stages?.PANDAS_ANALYSIS?.status === 'COMPLETED' &&
    Number(previous.stages.PANDAS_ANALYSIS.recordsProcessed) === Number(dataset.valid_rows) &&
    Number(previous.stages.PANDAS_ANALYSIS.evidence?.analysis?.datasetId) === datasetId &&
    Number(previous.stages.PANDAS_ANALYSIS.evidence?.analysis?.recordsProcessed) === Number(dataset.valid_rows) &&
    Number.isSafeInteger(Number(previous.runId));
  const resumeAfterLeadQualification = req.body?.resumeAfterStage === 'LEAD_QUALIFICATION' &&
    previous?.status === 'REVIEW_REQUIRED' &&
    previous.pauseAfterStage === 'LEAD_QUALIFICATION' &&
    previous.stages?.DATASET_VALIDATION?.status === 'COMPLETED' &&
    previous.stages?.ENTITY_AGGREGATION?.status === 'COMPLETED' &&
    previous.stages?.PANDAS_ANALYSIS?.status === 'COMPLETED' &&
    previous.stages?.INTELLIGENCE?.status === 'COMPLETED' &&
    previous.stages?.SQL_RISK_ANALYSIS?.status === 'COMPLETED' &&
    previous.stages?.LEAD_QUALIFICATION?.status === 'COMPLETED' &&
    Number.isSafeInteger(Number(previous.runId));
  const resuming = resumeAfterEntityAggregation || resumeAfterPandasAnalysis || resumeAfterPandasSuccess || resumeAfterLeadQualification;
  if (req.body?.resumeAfterStage && !resuming) {
    return res.status(409).json({
      success: false,
      status: previous?.status || 'REVIEW_REQUIRED',
      datasetId,
      error: 'The persisted pipeline is not paused after the requested completed stage.',
      code: 'PIPELINE_RESUME_STATE_MISMATCH'
    });
  }

  const token = resuming ? previous.token : randomUUID();
  const leaseOwnerToken = randomUUID();
  const leaseCreatedAt = Date.now();
  const pipeline = resuming
    ? {
        ...previous,
        datasetId,
        lease: createSupervisorRunLease(leaseOwnerToken, token, leaseCreatedAt),
        status: 'RUNNING',
        updatedAt: new Date(leaseCreatedAt).toISOString(),
        completedAt: null,
        error: null,
        pauseAfterStage: null,
        pauseReason: null,
        stages: { ...previous.stages }
      }
    : {
        runId: null,
        datasetId,
        token,
        lease: createSupervisorRunLease(leaseOwnerToken, token, leaseCreatedAt),
        status: 'RUNNING',
        startedAt: new Date(leaseCreatedAt).toISOString(),
        updatedAt: new Date(leaseCreatedAt).toISOString(),
        stages: {}
      };
  if (resuming) {
    const { data: existingRun, error: existingRunError } = await supabase.from('agent_runs')
      .select('id,status,idempotency_key')
      .eq('id', Number(previous.runId))
      .eq('dataset_id', datasetId)
      .maybeSingle();
    if (existingRunError) throw existingRunError;
    const expectedRunStatus = resumeAfterPandasAnalysis ? 'FAILED' : 'REVIEW_REQUIRED';
    if (
      !existingRun ||
      existingRun.status !== expectedRunStatus ||
      existingRun.idempotency_key !== previous.token
    ) {
      return res.status(409).json({
        success: false,
        status: 'REVIEW_REQUIRED',
        datasetId,
        error: 'The existing agent run does not match the persisted pipeline checkpoint.',
        code: 'PIPELINE_RESUME_RUN_MISMATCH'
      });
    }
    pipeline.runId = Number(existingRun.id);
  }
  const claimResult = await claimSupervisorPipelineRun(supabase, {
    datasetId,
    currentEntities,
    pipeline,
    previous,
    expectedUpdatedAt: dataset.updated_at,
    currentDataset: dataset,
    retry: req.body?.retry === true,
    now: runDecisionAt
  });
  const claimed = claimResult.claimed;
  if (!claimed) {
    dataset = await getDataset(datasetId);
    const current = dataset?.detected_entities?.pipeline;
    if (req.body?.retry === true && current?.status === 'RUNNING') {
      return res.status(409).json({
        success: false,
        status: 'RUNNING',
        datasetId,
        error: 'Another supervisor worker changed or claimed this pipeline before recovery completed. Re-read its state before retrying.',
        code: 'PIPELINE_RECOVERY_CLAIM_CONFLICT'
      });
    }
    return current ? setRunResponse(res, current.status === 'RUNNING' ? 202 : 409, datasetId, current)
      : res.status(409).json({ success: false, status: 'RUNNING', error: 'Another request claimed this dataset pipeline.' });
  }

  let expectedUpdatedAt = claimed.updatedAt;
  let entities = { ...currentEntities, pipeline };
  let runId = null;
  let persistenceTail = Promise.resolve();
  let persistenceFailure = null;
  const persist = (heartbeatOnly = false) => {
    const request = persistenceTail.then(async () => {
      if (heartbeatOnly && pipeline.status !== 'RUNNING') return;
      if (persistenceFailure) throw persistenceFailure;

      try {
        const persistedAt = Date.now();
        pipeline.updatedAt = new Date(persistedAt).toISOString();
        pipeline.lease = pipeline.status === 'RUNNING'
          ? createSupervisorRunLease(leaseOwnerToken, token, persistedAt)
          : null;
        const pipelineSnapshot = structuredClone(pipeline);
        const entitiesSnapshot = structuredClone(entities);
        const savedPipeline = await updatePipeline(
          datasetId,
          entitiesSnapshot,
          pipelineSnapshot,
          token,
          leaseOwnerToken,
          expectedUpdatedAt
        );
        if (!savedPipeline) {
          throw Object.assign(new Error('The supervisor lease or dataset state changed during execution.'), { code: 'PIPELINE_LEASE_LOST', status: 409 });
        }
        expectedUpdatedAt = savedPipeline.updatedAt;
        entities = { ...entitiesSnapshot, pipeline: pipelineSnapshot };
        if (runId) {
          const terminal = ['COMPLETED', 'FAILED', 'BLOCKED', 'REVIEW_REQUIRED'].includes(pipelineSnapshot.status);
          const { data: savedRun, error: runError } = await supabase.from('agent_runs')
            .update({
              status: pipelineSnapshot.status,
              stage_state: pipelineSnapshot.stages,
              result: { datasetId, status: pipelineSnapshot.status, runId, updatedAt: pipelineSnapshot.updatedAt },
              error: pipelineSnapshot.error || null,
              completed_at: terminal ? pipelineSnapshot.updatedAt : null,
              updated_at: pipelineSnapshot.updatedAt
            })
            .eq('id', runId)
            .eq('dataset_id', datasetId)
            .select('id')
            .maybeSingle();
          if (runError) throw runError;
          if (!savedRun) throw Object.assign(new Error('Analysis run state could not be confirmed after its dataset state was saved.'), { code: 'AGENT_RUN_STATE_UNVERIFIED' });
        }
        return savedPipeline.retentionRequired;
      } catch (error) {
        persistenceFailure ||= error;
        throw error;
      }
    });
    persistenceTail = request.catch(() => {});
    return request.then(async retentionRequired => {
      if (retentionRequired) await runCompletedAnalysisRetention(datasetId);
    });
  };
  const leaseHeartbeat = setInterval(() => { persist(true).catch(() => {}); }, SUPERVISOR_RUN_HEARTBEAT_MS);
  leaseHeartbeat.unref?.();

  let targetCompanyIds = [];
  try {
    if (claimed.retentionRequired) await runCompletedAnalysisRetention(datasetId);
    if (resuming) {
      runId = pipeline.runId;
      const { rows } = await supabase.query(
        'SELECT id FROM companies WHERE dataset_id = $1 ORDER BY id',
        [datasetId]
      );
      targetCompanyIds = rows.map(company => Number(company.id));
      const expectedCompanies = Number(pipeline.stages.ENTITY_AGGREGATION.evidence?.targetCompanyCount);
      if (targetCompanyIds.length !== expectedCompanies) {
        throw Object.assign(new Error('Persisted companies no longer match the completed entity-aggregation checkpoint.'), {
          code: 'PIPELINE_RESUME_ENTITY_COUNT_MISMATCH',
          details: { expected: expectedCompanies, actual: targetCompanyIds.length }
        });
      }
    } else {
      const run = await createRun(datasetId, token);
      runId = run.id;
      pipeline.runId = run.id;
      pipeline.startedAt = run.started_at || pipeline.startedAt;
    }
    await persist();

    let validation = null;
    if (!resuming) {
      setStage(pipeline, 'DATASET_VALIDATION', 'RUNNING', { recordsProcessed: 0 });
      await persist();
      validation = await validateDatasetPersistence(dataset);
      setStage(pipeline, 'DATASET_VALIDATION', validation.matches ? 'COMPLETED' : 'BLOCKED', {
        recordsProcessed: validation.actual.rawRows,
        recordsProduced: validation.actual.normalizedRows,
        reason: validation.matches ? null : 'Persisted raw and normalized row counts do not reconcile with the dataset summary.',
        blocker: validation.matches ? null : 'Dataset row counts must reconcile before analysis.',
        evidence: validation
      });
      await persist();
    }

    if (validation && !validation.matches) {
      const blockedReason = 'Dataset validation failed; this stage was not attempted.';
      for (const [id] of STAGE_DEFINITIONS.slice(1)) {
        const status = ['RESEARCH', 'CONTACT_DISCOVERY', 'EMAIL_DRAFT', 'HUMAN_APPROVAL', 'FOLLOW_UP'].includes(id) ? 'REVIEW_REQUIRED' : 'BLOCKED';
        setStage(pipeline, id, status, { reason: blockedReason, blocker: blockedReason });
      }
      await recordFinalResults(pipeline, [], datasetId);
      pipeline.status = 'BLOCKED';
      await persist();
      return setRunResponse(res, 207, datasetId, pipeline);
    }

    if (!resuming) {
      setStage(pipeline, 'ENTITY_AGGREGATION', 'RUNNING', { recordsProcessed: validation.actual.normalizedRows });
      await persist();
      const materialized = await materializeTradeEntities(datasetId);
      targetCompanyIds = materialized.targetCompanyIds;
      setStage(pipeline, 'ENTITY_AGGREGATION', 'COMPLETED', {
        recordsProcessed: validation.actual.normalizedRows,
        recordsProduced: materialized.companies + materialized.products + materialized.markets,
        items: materialized.companies,
        companies: materialized.companies,
        products: materialized.products,
        markets: materialized.markets,
        evidence: { targetCompanyCount: targetCompanyIds.length, completeDatasetCount: materialized.completeDatasetCount, incompleteDatasetCount: materialized.incompleteDatasetCount, coverage: materialized.coverage }
      });
      await persist();
    }

    if (!resumeAfterPandasSuccess) {
      const pandasAttempt = resumeAfterPandasAnalysis
        ? Number(previous.stages.PANDAS_ANALYSIS.attempt || 1) + 1
        : 1;
      setStage(pipeline, 'PANDAS_ANALYSIS', 'RUNNING', { recordsProcessed: 0, attempt: pandasAttempt });
      await persist();
      const pandas = await analyzePersistedDatasetWithPandas(datasetId);
      setStage(pipeline, 'PANDAS_ANALYSIS', pandas.status, {
        attempt: pandasAttempt,
        recordsProcessed: pandas.recordsProcessed || 0,
        recordsProduced: pandas.status === 'COMPLETED' ? 1 : 0,
        reason: pandas.reason || null,
        blocker: pandas.status === 'BLOCKED' ? pandas.reason : null,
        error: pandas.error || null,
        evidence: pandas.status === 'COMPLETED'
          ? { source: pandas.source, recordsProcessed: pandas.recordsProcessed, analysis: pandas.analysis }
          : { source: pandas.source, recordsProcessed: pandas.recordsProcessed || 0 }
      });
      await persist();

      if (pandas.status !== 'COMPLETED') {
        const stoppedStatus = pandas.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED';
        const stopReason = pandas.reason || 'Python/Pandas analysis did not complete.';
        for (const [id] of STAGE_DEFINITIONS) {
          if (id !== 'DATASET_VALIDATION' && id !== 'ENTITY_AGGREGATION' && id !== 'PANDAS_ANALYSIS') {
            setStage(pipeline, id, 'BLOCKED', { reason: stopReason, blocker: 'Pipeline stopped after Python/Pandas analysis failure.' });
          }
        }
        pipeline.status = stoppedStatus;
        pipeline.error = pandas.error || { code: 'PYTHON_ANALYSIS_FAILED', message: stopReason };
        await persist();
        return setRunResponse(res, 207, datasetId, pipeline);
      }

      if (resumeAfterPandasAnalysis) {
        pipeline.status = 'REVIEW_REQUIRED';
        pipeline.pauseAfterStage = 'PANDAS_ANALYSIS';
        pipeline.pauseReason = 'The requested Python/Pandas retry completed; downstream stages were not started.';
        await persist();
        return setRunResponse(res, 207, datasetId, pipeline);
      }
    }

    setStage(pipeline, 'INTELLIGENCE', 'RUNNING', { recordsProcessed: targetCompanyIds.length });
    await persist();
    const intelligence = await calculatePotentialScores({ datasetId, companyIds: targetCompanyIds, userEmail: req.user?.email });
    const { rows: scoreValidationRows } = await supabase.query(
      POTENTIAL_SCORE_VALIDATION_SQL,
      [datasetId, targetCompanyIds]
    );
    const scoreValidation = scoreValidationRows[0] || {};
    const persistedScoreCount = Number(scoreValidation.score_count || 0);
    const invalidScoreCount = Number(scoreValidation.invalid_score_count || 0);
    if (
      intelligence.scored !== targetCompanyIds.length ||
      persistedScoreCount !== targetCompanyIds.length ||
      invalidScoreCount !== 0
    ) {
      throw Object.assign(new Error('Persisted company-potential scores failed row-count, range, or weighted-sum validation.'), {
        code: 'POTENTIAL_SCORE_VALIDATION_FAILED',
        details: { expected: targetCompanyIds.length, reported: intelligence.scored, persisted: persistedScoreCount, invalid: invalidScoreCount }
      });
    }
    const scoringPersisted = true;
    const categories = {};
    for (const score of intelligence.data || []) categories[score.category] = (categories[score.category] || 0) + 1;
    setStage(pipeline, 'INTELLIGENCE', intelligence.status, {
      recordsProcessed: targetCompanyIds.length,
      recordsProduced: intelligence.scored,
      reason: intelligence.reason || null,
      blocker: intelligence.status === 'REVIEW_REQUIRED' ? intelligence.reason : null,
      evidence: {
        categories,
        scoringRule: 'Existing eight-factor point contributions, whose maxima follow the requested 20/15/15/10/15/10/5/10 allocation.',
        persistedScores: persistedScoreCount,
        invalidScores: invalidScoreCount,
        scoreRange: { min: Number(scoreValidation.min_score), max: Number(scoreValidation.max_score) },
        weightedSumValidated: true,
        unavailableFactors: {
          growth: Number(scoreValidation.growth_zero_count || 0),
          supplierDiversification: Number(scoreValidation.supplier_diversification_zero_count || 0)
        }
      }
    });
    await persist();

    setStage(pipeline, 'SQL_RISK_ANALYSIS', 'RUNNING', { recordsProcessed: targetCompanyIds.length });
    await persist();
    const risk = await analyzeSqlRiskAndSafety(targetCompanyIds, datasetId);
    if (risk.status !== 'COMPLETED' || risk.targetCompanyCount !== targetCompanyIds.length) {
      throw Object.assign(new Error(`SQL risk analysis did not verify every Dataset ${datasetId} company.`), {
        code: 'SQL_RISK_VALIDATION_FAILED',
        details: { expected: targetCompanyIds.length, actual: risk.targetCompanyCount, status: risk.status }
      });
    }
    setStage(pipeline, 'SQL_RISK_ANALYSIS', risk.status, {
      recordsProcessed: targetCompanyIds.length,
      recordsProduced: risk.qualifiedPotentialCount,
      reason: risk.reason || null,
      blocker: risk.status === 'REVIEW_REQUIRED' ? risk.reason : null,
      evidence: {
        source: risk.source,
        queryMode: risk.queryMode,
        datasetScope: risk.datasetScope,
        qualificationRule: risk.qualificationRule,
        targetCompanyCount: risk.targetCompanyCount,
        qualifiedPotentialCount: risk.qualifiedPotentialCount,
        existingLeadCount: risk.existingLeadCount,
        suppressedContactCount: risk.suppressedContactCount,
        verifiedUnsuppressedContactCount: risk.verifiedUnsuppressedContactCount,
        approvedDraftCount: risk.approvedDraftCount,
        sentEmailCount: risk.sentEmailCount,
        findings: risk.findings
      }
    });
    await persist();
    const { data: savedRiskDataset, error: savedRiskError } = await supabase
      .from('datasets')
      .select('detected_entities')
      .eq('id', datasetId)
      .single();
    if (savedRiskError) throw savedRiskError;
    const savedRiskStage = savedRiskDataset.detected_entities?.pipeline?.stages?.SQL_RISK_ANALYSIS;
    if (
      savedRiskDataset.detected_entities?.pipeline?.runId !== runId ||
      savedRiskStage?.status !== 'COMPLETED' ||
      savedRiskStage?.evidence?.targetCompanyCount !== targetCompanyIds.length
    ) {
      throw Object.assign(new Error(`Persisted SQL risk evidence did not match the completed Dataset ${datasetId} stage.`), {
        code: 'SQL_RISK_PERSISTENCE_UNVERIFIED'
      });
    }

    if (!resumeAfterLeadQualification) {
    setStage(pipeline, 'LEAD_QUALIFICATION', 'RUNNING', { recordsProcessed: risk.qualifiedPotentialCount });
    await persist();
    const leadsBeforeQualification = await countRows('leads', ['dataset_id', datasetId], ['intent_type', 'COMPANY_POTENTIAL']);
    const qualification = scoringPersisted
      ? await qualifyCompaniesFromPotential(targetCompanyIds, datasetId, req.user?.email)
      : { candidates: risk.qualifiedPotentialCount, produced: 0, skippedExisting: 0, qualifiedPotential: [] };
    const qualificationStatus = !scoringPersisted
      ? 'BLOCKED'
      : qualification.candidates ? 'COMPLETED' : 'REVIEW_REQUIRED';
    setStage(pipeline, 'LEAD_QUALIFICATION', qualificationStatus, {
      recordsProcessed: qualification.candidates,
      recordsProduced: qualification.produced,
      items: qualification.produced,
      reason: !scoringPersisted
        ? 'Lead creation was stopped because the authoritative intelligence stage requires review.'
        : qualification.candidates ? null : 'No company-potential records meet the new qualification threshold (score >=75, transactions >=10, evidenced product).',
      blocker: !scoringPersisted
        ? 'Complete the evidence-backed eight-factor score before creating leads.'
        : qualification.candidates ? null : 'No qualifying potential records were found for this dataset.',
      evidence: {
        rule: 'company_potential.total_score >= 75 AND companies.total_transactions >= 10 AND at least one evidenced product exists',
        candidates: qualification.candidates,
        persistedLeadsCreated: qualification.produced,
        existingCompanyLeadsSkipped: qualification.skippedExisting,
          example: qualification.qualifiedPotential[0] ? {
            companyId: qualification.qualifiedPotential[0].company_id,
            potentialId: qualification.qualifiedPotential[0].id,
            category: qualification.qualifiedPotential[0].category,
            score: qualification.qualifiedPotential[0].total_score,
            factorScores: {
              productFit: qualification.qualifiedPotential[0].product_fit_score,
              activity: qualification.qualifiedPotential[0].activity_score,
              recency: qualification.qualifiedPotential[0].recency_score,
              marketFit: qualification.qualifiedPotential[0].market_fit_score,
              commercialRelevance: qualification.qualifiedPotential[0].commercial_relevance_score,
              growth: qualification.qualifiedPotential[0].growth_score,
              supplierDiversification: qualification.qualifiedPotential[0].supplier_diversification_score,
              engagement: qualification.qualifiedPotential[0].engagement_score
            },
            products: Array.isArray(qualification.qualifiedPotential[0].evidence_breakdown?.products)
              ? qualification.qualifiedPotential[0].evidence_breakdown.products.slice(0, 8)
              : []
          } : null
      }
    });
    await persist();
}

    if (resumeAfterPandasSuccess) {
      const persistedLeadCount = await countRows('leads', ['dataset_id', datasetId], ['intent_type', 'COMPANY_POTENTIAL']);
      if (persistedLeadCount !== leadsBeforeQualification + qualification.produced) {
        throw Object.assign(new Error(`Persisted Dataset ${datasetId} company-potential leads did not match the qualification result.`), {
          code: 'LEAD_PERSISTENCE_UNVERIFIED',
          details: { before: leadsBeforeQualification, reported: qualification.produced, persisted: persistedLeadCount }
        });
      }
      for (const [id] of STAGE_DEFINITIONS) {
        if (['RESEARCH', 'CONTACT_DISCOVERY', 'EMAIL_DRAFT', 'HUMAN_APPROVAL', 'SMTP', 'INBOX', 'FOLLOW_UP', 'FINAL_RESULTS'].includes(id)) {
          setStage(pipeline, id, 'BLOCKED', {
            reason: 'Pipeline paused after the explicitly requested lead-qualification stage.',
            blocker: 'Awaiting explicit authorization to continue beyond lead qualification.'
          });
        }
      }
      pipeline.status = 'REVIEW_REQUIRED';
      pipeline.pauseAfterStage = 'LEAD_QUALIFICATION';
      pipeline.pauseReason = 'Scoring, SQL risk analysis, and lead qualification completed; no research, contact discovery, email, retention, or follow-up stages were started.';
      await persist();
      return setRunResponse(res, 207, datasetId, pipeline);
    }

    // RESEARCH stage – execute if provider is configured
    const capabilities = await getProviderCapabilities();
    if (capabilities.research && capabilities.research.configured) {
      const qualified = qualification.qualifiedPotential || [];
      const companyIds = qualified.map(p => p.company_id);
      const batchSize = Number(process.env.RESEARCH_BATCH_SIZE) || 50;
      const maxConcurrency = Number(process.env.RESEARCH_MAX_CONCURRENCY) || 5;
      let processed = 0;
      for (let i = 0; i < companyIds.length; i += batchSize) {
        const batch = companyIds.slice(i, i + batchSize);
        let idx = 0;
        while (idx < batch.length) {
          const slice = batch.slice(idx, idx + maxConcurrency);
          await Promise.all(slice.map(async (companyId) => {
            processed += await persistSupervisorResearch({
              database: supabase,
              provider: researchProvider,
              datasetId,
              companyId
            });
          }));
          idx += maxConcurrency;
        }
      }
      setStage(pipeline, 'RESEARCH', 'COMPLETED', { recordsProcessed: processed, recordsProduced: processed });
    } else {
      setStage(pipeline, 'RESEARCH', 'BLOCKED', {
        recordsProcessed: qualification.candidates,
        reason: 'No real web research provider or provider credentials are configured. No research records were created.',
        blocker: 'Research provider not configured.'
      });
    }
    setStage(pipeline, 'CONTACT_DISCOVERY', 'BLOCKED', {
      recordsProcessed: qualification.candidates,
      reason: 'No contact discovery provider is configured. Only existing verified contacts can be used; no contact was invented.',
      blocker: 'Contact discovery provider not configured.',
      evidence: { providerConfigured: false, verifiedUnsuppressedContacts: risk.verifiedUnsuppressedContactCount }
    });
    await persist();

    const targetLeads = (intelligence.status === 'COMPLETED' || intelligence.scored > 0)
      ? await readRowsForCompanies('leads', 'id,company_id,contact_id', targetCompanyIds, datasetId, query => query.eq('intent_type', 'COMPANY_POTENTIAL'))
      : [];
    let draftPreview = null;
    if (targetLeads[0]) {
      const { data: previewLead, error: previewError } = await supabase
        .from('leads')
        .select('id,company_id,company_name,product_requirement,score,evidence')
        .eq('id', targetLeads[0].id)
        .eq('dataset_id', datasetId)
        .maybeSingle();
      if (previewError) throw previewError;
      draftPreview = buildLeadDraftPreview(previewLead);
    }
    const verifiedContacts = await readRowsForCompanies(
      'contacts',
      'id,company_id,verification_status,is_suppressed',
      targetCompanyIds,
      datasetId,
      query => query.eq('verification_status', 'VERIFIED').eq('is_suppressed', false)
    );
    const contactByCompany = new Map(verifiedContacts.map(contact => [contact.company_id, contact]));
    const contactById = new Map(verifiedContacts.map(contact => [contact.id, contact]));
    let draftsCreated = 0;
    let draftsExisting = 0;
    let leadsWithoutVerifiedContact = 0;
    for (const lead of targetLeads) {
      const contact = contactById.get(lead.contact_id) || contactByCompany.get(lead.company_id);
      if (!contact) {
        leadsWithoutVerifiedContact++;
        continue;
      }
      const result = await generatePersonalizedDraft({ datasetId, leadId: lead.id, contactId: contact.id, userEmail: req.user?.email });
      if (result.status === 'COMPLETED') draftsCreated++;
      else if (result.status === 'EXISTS') draftsExisting++;
    }
    const draftStatus = (intelligence.status !== 'COMPLETED' && !intelligence.scored)
      ? 'BLOCKED'
      : draftsCreated || draftsExisting ? 'COMPLETED' : 'REVIEW_REQUIRED';
    setStage(pipeline, 'EMAIL_DRAFT', draftStatus, {
      recordsProcessed: targetLeads.length,
      recordsProduced: draftsCreated,
      items: draftsCreated,
      reason: (intelligence.status !== 'COMPLETED' && !intelligence.scored)
        ? 'Email draft generation was stopped because the authoritative intelligence stage requires review.'
        : draftStatus === 'COMPLETED' ? null : 'A personalized, addressless copy preview was generated from persisted lead/company/product evidence, but no verified contact exists to create a sendable draft. No recipient was fabricated.',
      blocker: (intelligence.status !== 'COMPLETED' && !intelligence.scored)
        ? 'Complete evidence-backed intelligence and lead qualification first.'
        : draftStatus === 'COMPLETED' ? null : 'Verified contact required before email draft generation.',
      evidence: { eligibleLeads: targetLeads.length - leadsWithoutVerifiedContact, draftsCreated, existingDrafts: draftsExisting, leadsWithoutVerifiedContact, copyPreviewsGenerated: draftPreview ? 1 : 0, nonSendablePreview: draftPreview }
    });
    setStage(pipeline, 'HUMAN_APPROVAL', draftsCreated || draftsExisting ? 'REVIEW_REQUIRED' : 'BLOCKED', {
      recordsProcessed: draftsCreated + draftsExisting,
      recordsProduced: 0,
      reason: draftsCreated || draftsExisting ? 'Every draft requires explicit human approval before it can be sent.' : 'No email draft is ready for approval because there are no verified contacts.',
      blocker: draftsCreated || draftsExisting ? 'Human review and approval required.' : 'Email draft generation is waiting for a verified contact.',
      evidence: { draftsCreated, existingDrafts: draftsExisting, explicitHumanApprovalRequired: true, outboundSent: false }
    });
    await persist();

    const hostinger = await getHostingerConfig();
    setStage(pipeline, 'SMTP', hostinger.smtpConfigured ? 'REVIEW_REQUIRED' : 'BLOCKED', {
      recordsProcessed: 0,
      recordsProduced: 0,
      reason: hostinger.smtpConfigured
        ? 'SMTP is configured, but this supervisor never sends email; an approved draft must be sent by an explicit human action.'
        : 'Hostinger SMTP credentials are missing in environment and system settings.',
      blocker: hostinger.smtpConfigured ? 'Human approval and explicit send action required.' : 'Hostinger SMTP is not configured.',
      evidence: { smtpConfigured: hostinger.smtpConfigured, outboundSendAttempted: false, humanApprovalRequired: true }
    });
    setStage(pipeline, 'INBOX', hostinger.imapConfigured ? 'REVIEW_REQUIRED' : 'BLOCKED', {
      reason: hostinger.imapConfigured ? 'IMAP synchronization remains an explicit human-triggered operation.' : 'Hostinger IMAP credentials are missing in environment and system settings.',
      blocker: hostinger.imapConfigured ? 'Inbox sync is an explicit human-triggered operation.' : 'Hostinger IMAP is not configured.',
      evidence: { imapConfigured: hostinger.imapConfigured, mailboxMessagesProcessed: 0, syntheticInputUsed: false }
    });
    setStage(pipeline, 'FOLLOW_UP', risk.sentEmailCount ? 'REVIEW_REQUIRED' : 'BLOCKED', {
      recordsProcessed: risk.sentEmailCount,
      reason: risk.sentEmailCount ? 'Follow-ups are only prepared after a successful SMTP send and are stopped by genuine replies or suppression.' : 'No email has been confirmed SENT, so no follow-up was created.',
      blocker: risk.sentEmailCount ? 'Follow-ups require inbox checks and individual human approval.' : 'A confirmed SMTP send is required before follow-up scheduling.',
      evidence: { confirmedSentEmails: risk.sentEmailCount, followUpDraftsCreated: 0, sentRequiresSmtpConfirmation: true }
    });

    await recordFinalResults(pipeline, targetCompanyIds, datasetId);
    pipeline.status = overallStatus(pipeline.stages);
    await persist();
    return setRunResponse(res, pipeline.status === 'COMPLETED' ? 200 : 207, datasetId, pipeline);
  } catch (error) {
    pipeline.status = 'FAILED';
    const normalized = normalizeDatabaseError(error, 'Pipeline execution failed.');
    const message = normalized.message || 'Pipeline execution failed.';
    const code = normalized.code || 'PIPELINE_ERROR';
    pipeline.error = { code, message };
    const failedStage = Object.entries(pipeline.stages).find(([, value]) => value.status === 'RUNNING')?.[0] || 'SUPERVISOR';
    if (pipeline.stages[failedStage]) setStage(pipeline, failedStage, 'FAILED', { error: { code, message }, reason: message, blocker: null });
    if (!code.startsWith('DATABASE_') && code !== 'PIPELINE_LEASE_LOST' && code !== 'PIPELINE_STATE_CONFLICT') {
      try {
        await recordFinalResults(pipeline, targetCompanyIds, datasetId);
        await persist();
      } catch (persistError) {
        console.error(`[SUPERVISOR] failure state persistence failed code=${normalizeDatabaseError(persistError).code}`);
      }
    }
    console.error(`[SUPERVISOR] pipeline failed dataset=${datasetId} stage=${failedStage} code=${code}`);
    return setRunResponse(res, normalized.status || 500, datasetId, pipeline);
  } finally {
    clearInterval(leaseHeartbeat);
    await persistenceTail;
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!(await requireAuth(req, res))) return;

  try {
    if (req.method === 'GET') {
      const datasetsCount = await countRows('datasets');
      const tableCounts = await Promise.all([
        countRows('companies'), countRows('products'), countRows('web_research'),
        countRows('contacts'), countRows('outreach_emails'), countRows('inbox_messages'), countRows('follow_up_queue'), countRows('leads')
      ]);
      const [companiesCount, productsCount, researchCount, contactsCount, emailsCount, inboxCount, followUpCount, leadsCount] = tableCounts;
      const [{ data: latestDataset, error: datasetError }, { data: runs, error: runsError }] = await Promise.all([
        supabase.from('datasets')
          .select('id,detected_entities,created_at')
          .eq('import_status', 'COMPLETED')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase.from('agent_runs').select('id,started_at').order('started_at', { ascending: false }).limit(20)
      ]);
      if (datasetError) throw datasetError;
      if (runsError) throw runsError;
      const latestPipeline = pipelineForResponse(latestDataset?.detected_entities?.pipeline || null);
      const pipelineStages = latestPipeline
        ? stagesForResponse(latestPipeline.stages)
        : STAGE_DEFINITIONS.map(([id, name]) => ({ id, name, status: 'QUEUED', items: 0, recordsProcessed: 0, recordsProduced: 0 }));
      return res.status(200).json({
        success: true,
        pipelineStages,
        latestDatasetId: latestDataset?.id || null,
        latestPipeline,
        recentRuns: runs || [],
        systemStats: { datasetsCount, companiesCount, productsCount, researchCount, contactsCount, emailsCount, inboxCount, followUpCount, leadsCount }
      });
    }
    if (req.method === 'POST') return await runPipeline(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const normalized = normalizeDatabaseError(error, 'Supervisor database request failed.');
    console.error(`[SUPERVISOR] request failed status=${normalized.status} code=${normalized.code}`);
    return apiErrorResponse(res, normalized, 'SUPERVISOR_ERROR');
  }
}
