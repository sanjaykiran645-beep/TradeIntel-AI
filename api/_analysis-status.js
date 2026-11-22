const ANALYSIS_STAGES = [
  'DATASET_VALIDATION',
  'ENTITY_AGGREGATION',
  'PANDAS_ANALYSIS',
  'INTELLIGENCE',
  'SQL_RISK_ANALYSIS',
  'LEAD_QUALIFICATION'
];

function persistedScoringEvidenceIsComplete(stage) {
  const evidence = stage?.evidence || {};
  const expectedScores = Number(stage?.recordsProcessed);
  return Number.isFinite(expectedScores) &&
    Number(evidence.persistedScores) === expectedScores &&
    Number(evidence.invalidScores) === 0 &&
    evidence.weightedSumValidated === true;
}

function stageIsComplete(id, stage) {
  if (stage?.status === 'COMPLETED') return true;
  return id === 'INTELLIGENCE' &&
    stage?.status === 'REVIEW_REQUIRED' &&
    persistedScoringEvidenceIsComplete(stage);
}

export function deriveAnalysisStatus(pipeline = {}) {
  const stages = pipeline?.stages || {};
  const analysisStages = ANALYSIS_STAGES.map(id => [id, stages[id]]);

  if (analysisStages.some(([, stage]) => stage?.status === 'FAILED')) return 'FAILED';
  if (analysisStages.some(([, stage]) => stage?.status === 'BLOCKED')) return 'BLOCKED';
  if (analysisStages.some(([, stage]) => stage?.status === 'RUNNING')) return 'RUNNING';

  if (analysisStages.every(([id, stage]) => stageIsComplete(id, stage))) return 'COMPLETED';
  if (analysisStages.some(([, stage]) => stage?.status === 'REVIEW_REQUIRED')) return 'REVIEW_REQUIRED';
  return pipeline?.status === 'RUNNING' ? 'RUNNING' : 'QUEUED';
}
