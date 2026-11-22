import supabase from './_db-client.js';

/**
 * Count a dataset's raw rows with PostgREST's exact head-count endpoint.
 * Scanning validity flags by primary-key pages times out near the end of the
 * table, while this exact dataset count is supported by the current REST API.
 */
export async function countRawRecordsForDataset(datasetId) {
  const { count, error } = await supabase
    .from('raw_records')
    .select('id', { count: 'exact', head: true })
    .eq('dataset_id', datasetId);

  if (error) throw error;
  return count || 0;
}
