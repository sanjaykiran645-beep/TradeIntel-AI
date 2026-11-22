import database from './_db-client.js';

function requestedId(req) {
  const query = req?.query || {};
  const body = req?.body || {};
  return query.dataset_id ?? query.datasetId ?? body.dataset_id ?? body.datasetId ?? null;
}

export async function resolveDatasetId(req, { allowLatest = true } = {}) {
  const requested = requestedId(req);
  let dataset;
  if (requested !== null && requested !== '') {
    const id = Number(requested);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw Object.assign(new Error('dataset_id must be a positive integer.'), { code: 'INVALID_DATASET_ID', status: 400 });
    }
    const result = await database.from('datasets')
      .select('id,import_status')
      .eq('id', id)
      .maybeSingle();
    if (result.error) throw result.error;
    dataset = result.data;
    if (!dataset) throw Object.assign(new Error(`Dataset ${id} was not found.`), { code: 'DATASET_NOT_FOUND', status: 404 });
    if (dataset.import_status !== 'COMPLETED') {
      throw Object.assign(new Error(`Dataset ${id} is not fully imported yet.`), { code: 'DATASET_IMPORT_NOT_READY', status: 409 });
    }
    return Number(dataset.id);
  }
  if (!allowLatest) throw Object.assign(new Error('dataset_id is required for this operation.'), { code: 'DATASET_ID_REQUIRED', status: 400 });

  const result = await database.from('datasets')
    .select('id')
    .eq('import_status', 'COMPLETED')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw result.error;
  dataset = result.data;
  if (!dataset) throw Object.assign(new Error('No completed dataset is available yet.'), { code: 'NO_IMPORTED_DATASET', status: 404 });
  return Number(dataset.id);
}
