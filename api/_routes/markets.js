import supabase from '../_db-client.js';
import { apiErrorResponse, setCors, requireAuth } from '../_utils.js';
import { resolveDatasetId } from '../_dataset-scope.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!(await requireAuth(req, res))) return;

  try {
    if (req.method === 'GET') {
      const datasetId = await resolveDatasetId(req);
      const { data, error } = await supabase
        .from('markets')
        .select('*')
        .eq('dataset_id', datasetId)
        .order('total_trade_volume', { ascending: false });

      if (error) throw error;
      return res.status(200).json(data || []);
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(`[MARKETS] request failed code=${err.code || 'DATABASE_ERROR'}`);
    return apiErrorResponse(res, err, 'MARKETS_ERROR');
  }
}
