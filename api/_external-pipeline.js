import supabase from './_db-client.js';
import { deriveAnalysisStatus } from './_analysis-status.js';
import { filterDatasetStateVersion, nextDatasetStateVersion } from './_dataset-state-version.js';

function statusFromStages(stages) {
  const statuses = Object.values(stages || {}).map(stage => stage?.status);
  if (!statuses.length) return 'QUEUED';
  if (statuses.includes('FAILED')) return 'FAILED';
  if (statuses.includes('BLOCKED')) return 'BLOCKED';
  if (statuses.includes('REVIEW_REQUIRED')) return 'REVIEW_REQUIRED';
  if (statuses.includes('RUNNING')) return 'RUNNING';
  const requiredStages = [
    'DATASET_VALIDATION', 'ENTITY_AGGREGATION', 'INTELLIGENCE', 'PANDAS_ANALYSIS',
    'SQL_RISK_ANALYSIS', 'LEAD_QUALIFICATION', 'RESEARCH', 'CONTACT_DISCOVERY',
    'EMAIL_DRAFT', 'HUMAN_APPROVAL', 'SMTP', 'INBOX', 'FOLLOW_UP', 'FINAL_RESULTS'
  ];
  return requiredStages.every(stage => stages[stage]?.status === 'COMPLETED') ? 'COMPLETED' : 'QUEUED';
}

function stageSnapshot(status, details, previous, now) {
  return {
    status,
    startedAt: previous?.startedAt || now,
    updatedAt: now,
    completedAt: status === 'RUNNING' ? null : now,
    recordsProcessed: details.recordsProcessed ?? 0,
    recordsProduced: details.recordsProduced ?? 0,
    reason: details.reason || null,
    blocker: details.blocker || null,
    error: details.error || null,
    evidence: details.evidence || null
  };
}

/** Persist external-stage state in the existing datasets.detected_entities.pipeline JSON. */
export async function persistExternalStage(stage, status, details = {}, targetDatasetId = null) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let datasetQuery = supabase.from('datasets').select('id,detected_entities,analysis_status,analysis_completed_at,updated_at');
    if (targetDatasetId !== null) datasetQuery = datasetQuery.eq('id', targetDatasetId);
    else datasetQuery = datasetQuery.eq('import_status', 'COMPLETED').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
    const { data: dataset, error: readError } = await datasetQuery.maybeSingle();
    if (readError) return { persisted: false, reason: readError.message };
    if (!dataset) return { persisted: false, reason: 'No persisted dataset is available for pipeline state.' };

    const entities = dataset.detected_entities && typeof dataset.detected_entities === 'object'
      ? dataset.detected_entities
      : {};
    if (entities.retentionCleanup?.status === 'RUNNING') {
      return { persisted: false, reason: 'Dataset retention cleanup currently owns this dataset state.' };
    }
    const priorPipeline = entities.pipeline && typeof entities.pipeline === 'object' ? entities.pipeline : null;
    const priorUpdatedAt = priorPipeline?.updatedAt || null;
    const now = new Date().toISOString();
    const stages = { ...(priorPipeline?.stages || {}) };
    stages[stage] = stageSnapshot(status, details, stages[stage], now);
    const pipeline = {
      ...(priorPipeline || {}),
      runId: priorPipeline?.runId || null,
      datasetId: dataset.id,
      status: statusFromStages(stages),
      startedAt: priorPipeline?.startedAt || now,
      updatedAt: now,
      stages
    };

    const analysisStatus = deriveAnalysisStatus(pipeline);
    const analysisTerminal = ['COMPLETED', 'FAILED', 'BLOCKED', 'REVIEW_REQUIRED'].includes(analysisStatus);
    let update = supabase
      .from('datasets')
      .update({
        detected_entities: { ...entities, pipeline },
        updated_at: nextDatasetStateVersion(dataset.updated_at),
        status: pipeline.status,
        analysis_status: analysisStatus,
        analysis_completed_at: analysisStatus === 'COMPLETED'
          ? (dataset.analysis_status === 'COMPLETED' ? dataset.analysis_completed_at || now : now)
          : analysisTerminal ? now : null
      })
      .eq('id', dataset.id);
    update = filterDatasetStateVersion(update, dataset.updated_at);
    update = priorUpdatedAt
      ? update.filter('detected_entities->pipeline->>updatedAt', 'eq', priorUpdatedAt)
      : update.filter('detected_entities->pipeline->>updatedAt', 'is', null);
    const { data: saved, error: updateError } = await update.select('id').maybeSingle();
    if (updateError) return { persisted: false, reason: updateError.message };
    if (saved) return { persisted: true, datasetId: dataset.id, stage, status };
  }

  return { persisted: false, reason: 'Pipeline state changed repeatedly while the stage result was being saved.' };
}

export function stagePersistenceEvidence(result) {
  return result?.persisted
    ? { persisted: true, datasetId: result.datasetId }
    : { persisted: false, blocker: result?.reason || 'Pipeline stage state could not be persisted.' };
}
