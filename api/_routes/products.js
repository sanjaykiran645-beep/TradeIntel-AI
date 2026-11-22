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
      const query = req.query || {};
      const page = Number(query.page ?? 1);
      const pageSize = Number(query.pageSize ?? 50);
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        return res.status(400).json({ error: 'page must be a positive integer and pageSize must be between 1 and 100.', code: 'INVALID_PAGINATION' });
      }
      const search = String(query.search || '').trim().slice(0, 200).replace(/[\\%_]/g, '\\$&');
      const searchPattern = search ? `%${search}%` : null;
      const where = `dataset_id = $1
        AND ($2::text IS NULL OR name ILIKE $2 ESCAPE '\\' OR category ILIKE $2 ESCAPE '\\')`;
      const [countResult, pageResult] = await Promise.all([
        supabase.query(
          `SELECT COUNT(*)::bigint AS count FROM products WHERE ${where}`,
          [datasetId, searchPattern]
        ),
        supabase.query(
          `SELECT id, name, category, hs_code, total_demand_qty, total_demand_val,
                  frequency, top_markets, top_buyers, top_suppliers, growth_trend, recency_date
             FROM products
            WHERE ${where}
            ORDER BY frequency DESC, id ASC
            LIMIT $3 OFFSET $4`,
          [datasetId, searchPattern, pageSize, (page - 1) * pageSize]
        )
      ]);
      const total = Number(countResult.rows[0]?.count || 0);
      return res.status(200).json({
        data: pageResult.rows,
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(`[PRODUCTS] request failed code=${err.code || 'DATABASE_ERROR'}`);
    return apiErrorResponse(res, err, 'PRODUCTS_ERROR');
  }
}
