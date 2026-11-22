import { deriveAnalysisStatus } from './_analysis-status.js';
import { filterDatasetStateVersion, nextDatasetStateVersion } from './_dataset-state-version.js';

export const SUPERVISOR_RUN_LEASE_TTL_MS = 30 * 60 * 1000;
export const SUPERVISOR_RUN_HEARTBEAT_MS = Math.max(1000, Math.floor(SUPERVISOR_RUN_LEASE_TTL_MS / 3));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSupervisorRunLease(ownerToken, pipelineToken, now = Date.now()) {
  const heartbeatAt = new Date(now).toISOString();
  return {
    ownerToken,
    pipelineToken,
    heartbeatAt,
    expiresAt: new Date(now + SUPERVISOR_RUN_LEASE_TTL_MS).toISOString()
  };
}

export function inspectSupervisorRunLease(pipeline, now = Date.now()) {
  const lease = pipeline?.lease;
  const heartbeat = Date.parse(lease?.heartbeatAt || '');
  const expiration = Date.parse(lease?.expiresAt || '');
  const valid = typeof pipeline?.token === 'string' && UUID_PATTERN.test(pipeline.token) &&
    typeof lease?.ownerToken === 'string' && UUID_PATTERN.test(lease.ownerToken) &&
    lease.pipelineToken === pipeline.token &&
    Number.isFinite(heartbeat) && Number.isFinite(expiration) &&
    new Date(heartbeat).toISOString() === lease.heartbeatAt &&
    new Date(expiration).toISOString() === lease.expiresAt &&
    expiration - heartbeat === SUPERVISOR_RUN_LEASE_TTL_MS;

  if (!valid) return { status: 'UNVERIFIED' };
  return {
    status: expiration <= now ? 'EXPIRED' : 'ACTIVE',
    ownerToken: lease.ownerToken,
    pipelineToken: pipeline.token,
    heartbeatAt: lease.heartbeatAt,
    expiresAt: lease.expiresAt
  };
}

export function decideSupervisorRun(previous, retry, now = Date.now()) {
  if (previous?.status === 'COMPLETED' && retry !== true) return { action: 'RETURN_COMPLETED' };
  if (previous?.status !== 'RUNNING') return { action: 'START_NEW' };

  const lease = inspectSupervisorRunLease(previous, now);
  if (lease.status === 'ACTIVE') {
    return retry === true ? { action: 'DENY_ACTIVE', lease } : { action: 'RETURN_RUNNING', lease };
  }
  if (lease.status === 'EXPIRED') {
    return retry === true ? { action: 'RECOVER_EXPIRED', lease } : { action: 'RECOVERY_AVAILABLE', lease };
  }
  return { action: 'DENY_UNVERIFIED' };
}

export async function claimSupervisorPipelineRun(client, {
  datasetId,
  currentEntities,
  pipeline,
  previous = null,
  expectedUpdatedAt,
  currentDataset,
  retry = false,
  now = Date.now()
}) {
  const decision = decideSupervisorRun(previous, retry, now);
  if (!['START_NEW', 'RECOVER_EXPIRED'].includes(decision.action)) {
    return { decision, claimed: null };
  }

  const expectedLeaseOwnerToken = typeof previous?.lease?.ownerToken === 'string'
    ? previous.lease.ownerToken
    : null;
  const recoveryExpiresBefore = decision.action === 'RECOVER_EXPIRED'
    ? new Date(now).toISOString()
    : null;
  const claimed = await compareAndSetSupervisorPipeline(client, {
    datasetId,
    currentEntities,
    pipeline,
    expectedPipelineToken: previous?.token ?? null,
    expectedLeaseOwnerToken,
    expectedUpdatedAt,
    currentDataset,
    recoveryExpiresBefore,
    now
  });
  return { decision, claimed };
}

/**
 * Persist a supervisor claim or heartbeat using the same dataset version CAS
 * used by the other detected_entities writers. Recovery additionally checks
 * the old lease expiry in the atomic update predicate.
 */
export async function compareAndSetSupervisorPipeline(client, {
  datasetId,
  currentEntities,
  pipeline,
  expectedPipelineToken = null,
  expectedLeaseOwnerToken = null,
  expectedUpdatedAt,
  currentDataset,
  recoveryExpiresBefore = null,
  now = Date.now()
}) {
  const analysisStatus = deriveAnalysisStatus(pipeline);
  const analysisTerminal = ['COMPLETED', 'FAILED', 'BLOCKED', 'REVIEW_REQUIRED'].includes(analysisStatus);
  const analysisCompletedAt = analysisStatus === 'COMPLETED'
    ? (currentDataset?.analysis_status === 'COMPLETED' ? currentDataset.analysis_completed_at || pipeline.updatedAt : pipeline.updatedAt)
    : analysisTerminal ? pipeline.updatedAt : null;
  const updatedAt = nextDatasetStateVersion(expectedUpdatedAt, now);

  let update = client.from('datasets').update({
    detected_entities: { ...currentEntities, pipeline },
    updated_at: updatedAt,
    status: pipeline.status,
    analysis_status: analysisStatus,
    analysis_completed_at: analysisCompletedAt
  }).eq('id', datasetId);
  update = filterDatasetStateVersion(update, expectedUpdatedAt)
    .filter('detected_entities->pipeline->>token', expectedPipelineToken === null ? 'is' : 'eq', expectedPipelineToken)
    .filter('detected_entities->pipeline->lease->>ownerToken', expectedLeaseOwnerToken === null ? 'is' : 'eq', expectedLeaseOwnerToken);
  if (recoveryExpiresBefore) {
    update = update.filter('detected_entities->pipeline->lease->>expiresAt', 'lte', recoveryExpiresBefore);
  }

  const { data, error } = await update.select('id,updated_at').maybeSingle();
  if (error) throw error;
  return data ? { updatedAt: data.updated_at || updatedAt, analysisStatus } : null;
}
