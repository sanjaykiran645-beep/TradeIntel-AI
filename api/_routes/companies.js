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
      if (query.mode === 'picker') {
        const { rows } = await supabase.query(
          `SELECT id, name, country
             FROM companies
            WHERE dataset_id = $1
            ORDER BY total_value DESC, id ASC`,
          [datasetId]
        );
        return res.status(200).json(rows);
      }

      const page = Number(query.page ?? 1);
      const pageSize = Number(query.pageSize ?? 50);
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        return res.status(400).json({ error: 'page must be a positive integer and pageSize must be between 1 and 100.', code: 'INVALID_PAGINATION' });
      }
      const search = String(query.search || '').trim().slice(0, 200).replace(/[\\%_]/g, '\\$&');
      const searchPattern = search ? `%${search}%` : null;
      const category = query.category && query.category !== 'ALL' ? String(query.category) : null;
      if (category && !['VERY_HIGH', 'HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT_DATA'].includes(category)) {
        return res.status(400).json({ error: 'category is not a supported potential category.', code: 'INVALID_CATEGORY' });
      }
      const qualification = query.qualification && query.qualification !== 'ALL' ? String(query.qualification) : null;
      const sort = query.sort === 'score' ? 'score' : 'value';

      let qualCondition = '';
      if (qualification === 'QUALIFIED') {
        qualCondition = ' AND p.total_score >= 75 AND c.total_transactions >= 10';
      } else if (qualification === 'SCORED_ONLY') {
        qualCondition = ' AND (p.total_score IS NULL OR p.total_score < 75 OR c.total_transactions < 10)';
      }

      const where = `c.dataset_id = $1
        AND ($2::text IS NULL OR c.name ILIKE $2 ESCAPE '\\' OR COALESCE(c.country, '') ILIKE $2 ESCAPE '\\')
        AND ($3::text IS NULL OR p.category = $3)${qualCondition}`;
      const [countResult, pageResult] = await Promise.all([
        supabase.query(
          `SELECT COUNT(*)::bigint AS count
             FROM companies c
             LEFT JOIN company_potential p ON p.dataset_id = c.dataset_id AND p.company_id = c.id
            WHERE ${where}`,
          [datasetId, searchPattern, category]
        ),
        supabase.query(
          `SELECT c.id, c.name, c.country, c.industry, c.primary_products[1:4] AS primary_products,
                  c.total_transactions, c.total_value, c.last_activity_date, c.roles,
                  l.id AS lead_id, l.status AS lead_status,
                  COALESCE(p.total_score >= 75 AND c.total_transactions >= 10, false) AS is_qualified,
                  CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
                    'id', p.id, 'category', p.category, 'total_score', p.total_score,
                    'product_fit_score', p.product_fit_score, 'activity_score', p.activity_score,
                    'recency_score', p.recency_score, 'market_fit_score', p.market_fit_score,
                    'commercial_relevance_score', p.commercial_relevance_score, 'growth_score', p.growth_score,
                    'supplier_diversification_score', p.supplier_diversification_score, 'engagement_score', p.engagement_score
                  ) END AS potential
             FROM companies c
             LEFT JOIN company_potential p ON p.dataset_id = c.dataset_id AND p.company_id = c.id
             LEFT JOIN (
               SELECT DISTINCT ON (company_id) id, status, company_id, dataset_id
                 FROM leads
                ORDER BY company_id, id DESC
             ) l ON l.dataset_id = c.dataset_id AND l.company_id = c.id
            WHERE ${where}
            ORDER BY ${sort === 'score' ? 'p.total_score DESC NULLS LAST, ' : ''}c.total_value DESC, c.id ASC
            LIMIT $4 OFFSET $5`,
          [datasetId, searchPattern, category, pageSize, (page - 1) * pageSize]
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

    if (req.method === 'POST') {
      const { name, country, industry, primary_products, roles } = req.body;
      if (!name) return res.status(400).json({ error: 'Company name required' });
      const datasetId = await resolveDatasetId(req);

      const { data, error } = await supabase
        .from('companies')
        .insert({
          dataset_id: datasetId,
          name: name.trim(),
          normalized_name: name.trim().toLowerCase().replace(/[^a-z0-9]/g, ''),
          country: country || 'Global',
          industry: industry || 'Global Trade & Procurement',
          primary_products: primary_products || [],
          total_transactions: 1,
          total_value: 0,
          roles: roles || ['buyer'],
          status: 'ACTIVE',
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;
      return res.status(201).json(data);
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(`[COMPANIES] request failed code=${err.code || 'DATABASE_ERROR'}`);
    return apiErrorResponse(res, err, 'COMPANIES_ERROR');
  }
}
