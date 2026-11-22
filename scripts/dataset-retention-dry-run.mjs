import { previewCompletedAnalysisRetention } from '../api/_dataset-retention.js';

try {
  const datasetId = Number(process.argv[2] || process.env.DATASET_REPLACEMENT_PREVIEW_ID);
  if (!Number.isSafeInteger(datasetId) || datasetId <= 0) {
    throw Object.assign(new Error('Usage: node scripts/dataset-retention-dry-run.mjs <validated-import-dataset-id>'), { code: 'CURRENT_DATASET_REQUIRED' });
  }
  const result = await previewCompletedAnalysisRetention(datasetId);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'BLOCKED',
    error: error.message || 'Retention preview failed.',
    code: error.code || null
  }, null, 2));
  process.exitCode = 1;
}
