import database from './_db-client.js';

function riskLevel(counts) {
  if (counts.suppressed_contact_count > 0) return 'HIGH';
  if (counts.approved_draft_count > 0 && counts.sent_email_count === 0) return 'MEDIUM';
  if (counts.sent_email_count > 0 && counts.existing_lead_count > 0) return 'MEDIUM';
  return 'LOW';
}

export async function readQualifiedPotential(companyIds, datasetId) {
  if (!Number.isSafeInteger(Number(datasetId)) || Number(datasetId) <= 0) {
    throw Object.assign(new Error('A dataset_id is required for SQL risk analysis.'), { code: 'DATASET_ID_REQUIRED', status: 400 });
  }
  if (!companyIds?.length) return [];
  const { rows } = await database.query(
    `SELECT cp.id, cp.dataset_id, cp.company_id, cp.total_score, cp.category,
            cp.product_fit_score, cp.activity_score, cp.recency_score,
            cp.market_fit_score, cp.commercial_relevance_score, cp.growth_score,
            cp.supplier_diversification_score, cp.engagement_score,
            cp.evidence_breakdown, cp.calculated_at
       FROM company_potential cp
       JOIN companies c ON c.dataset_id = cp.dataset_id AND c.id = cp.company_id
      WHERE cp.dataset_id = $1
        AND c.dataset_id = $1
        AND c.id = ANY($2::bigint[])
        AND cp.total_score >= 75
        AND c.total_transactions >= 10
      ORDER BY cp.total_score DESC, cp.company_id ASC`,
    [datasetId, companyIds]
  );
  return rows;
}

export async function analyzeSqlRiskAndSafety(companyIds = [], datasetId) {
  const targetIds = [...new Set((companyIds || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!Number.isSafeInteger(Number(datasetId)) || Number(datasetId) <= 0) {
    throw Object.assign(new Error('A dataset_id is required for SQL risk analysis.'), { code: 'DATASET_ID_REQUIRED', status: 400 });
  }
  const { rows } = await database.query(
    `WITH target_companies AS (
       SELECT id, total_transactions FROM companies WHERE dataset_id = $1 AND id = ANY($2::bigint[])
     )
     SELECT
       (SELECT count(*)::bigint FROM target_companies) AS target_company_count,
       (SELECT count(*)::bigint
          FROM company_potential cp JOIN target_companies c ON c.id = cp.company_id
         WHERE cp.dataset_id = $1 AND cp.total_score >= 75 AND c.total_transactions >= 10) AS qualified_potential_count,
       (SELECT count(*)::bigint
          FROM leads l JOIN target_companies c ON c.id = l.company_id
         WHERE l.dataset_id = $1) AS existing_lead_count,
       (SELECT count(*)::bigint
          FROM contacts c JOIN target_companies t ON t.id = c.company_id
         WHERE c.dataset_id = $1 AND c.is_suppressed = true) AS suppressed_contact_count,
       (SELECT count(*)::bigint
          FROM contacts c JOIN target_companies t ON t.id = c.company_id
         WHERE c.dataset_id = $1 AND c.verification_status = 'VERIFIED' AND c.is_suppressed = false) AS verified_unsuppressed_contact_count,
       (SELECT count(*)::bigint
          FROM outreach_emails e JOIN target_companies c ON c.id = e.company_id
         WHERE e.dataset_id = $1 AND e.status = 'APPROVED') AS approved_draft_count,
       (SELECT count(*)::bigint
          FROM outreach_emails e JOIN target_companies c ON c.id = e.company_id
         WHERE e.dataset_id = $1 AND e.status = 'SENT') AS sent_email_count`,
    [datasetId, targetIds]
  );
  const raw = rows[0] || {};
  const counts = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Number(value || 0)]));
  const qualifiedPotential = await readQualifiedPotential(targetIds, datasetId);
  const findings = [
    ...(counts.existing_lead_count ? [{ code: 'EXISTING_LEADS', count: counts.existing_lead_count, action: 'Check the dataset-scoped deduplication key before creating a lead.' }] : []),
    ...(counts.suppressed_contact_count ? [{ code: 'SUPPRESSED_CONTACTS', count: counts.suppressed_contact_count, action: 'Suppressed contacts must never receive outreach.' }] : []),
    ...(!counts.verified_unsuppressed_contact_count ? [{ code: 'NO_VERIFIED_CONTACTS', count: 0, action: 'Email generation requires a VERIFIED, unsuppressed contact in this dataset.' }] : []),
    ...(counts.approved_draft_count ? [{ code: 'APPROVED_DRAFTS', count: counts.approved_draft_count, action: 'An explicit human send action is still required.' }] : []),
    ...(counts.sent_email_count ? [{ code: 'CONFIRMED_SENT_EMAILS', count: counts.sent_email_count, action: 'Follow-ups require live reply and suppression checks.' }] : [])
  ];

  return {
    status: 'COMPLETED',
    source: 'Managed PostgreSQL parameterized SQL',
    queryMode: 'SQL',
    datasetId: Number(datasetId),
    datasetScope: 'dataset_id and a dataset-owned company_id set are applied to every risk count.',
    targetCompanyCount: counts.target_company_count,
    qualifiedPotentialCount: counts.qualified_potential_count,
    existingLeadCount: counts.existing_lead_count,
    suppressedContactCount: counts.suppressed_contact_count,
    verifiedUnsuppressedContactCount: counts.verified_unsuppressed_contact_count,
    approvedDraftCount: counts.approved_draft_count,
    sentEmailCount: counts.sent_email_count,
    riskLevel: riskLevel(counts),
    qualificationRule: 'company_potential.total_score >= 75 AND companies.total_transactions >= 10',
    findings,
    qualifiedPotential
  };
}

export async function analyzeDatasetConcentrationRisk(datasetId) {
  if (!Number.isSafeInteger(Number(datasetId)) || Number(datasetId) <= 0) {
    throw Object.assign(new Error('A dataset_id is required for concentration risk analysis.'), { code: 'DATASET_ID_REQUIRED', status: 400 });
  }
  const { rows } = await database.query(
    `WITH target_companies AS (
       SELECT id FROM companies WHERE dataset_id = $1
     ),
     lead_companies AS (
       SELECT DISTINCT company_id
         FROM leads
        WHERE dataset_id = $1 AND intent_type = 'COMPANY_POTENTIAL'
     ),
     mapped_transactions AS (
       SELECT c.id AS company_id,
              NULLIF(LOWER(BTRIM(n.country)), '') AS market_key,
              CASE
                WHEN NULLIF(BTRIM(n.product_name), '') IS NOT NULL
                THEN LOWER(BTRIM(n.product_name)) || '|' || LOWER(BTRIM(n.category))
                ELSE NULL
              END AS product_key
         FROM normalized_records n
         JOIN companies c
           ON c.dataset_id = n.dataset_id
          AND (
            (n.company_id IS NOT NULL AND c.id = n.company_id)
            OR (
              n.company_id IS NULL
              AND c.normalized_name = CASE
                WHEN REGEXP_REPLACE(LOWER(BTRIM(n.company_name)), '[^a-z0-9]', '', 'g') <> ''
                  THEN REGEXP_REPLACE(LOWER(BTRIM(n.company_name)), '[^a-z0-9]', '', 'g')
                ELSE LOWER(BTRIM(n.company_name))
              END
            )
          )
        WHERE n.dataset_id = $1
     ),
     market_counts AS (
       SELECT company_id, market_key, COUNT(*)::numeric AS transaction_count
         FROM mapped_transactions
        WHERE market_key IS NOT NULL AND market_key NOT IN ('unknown', 'global')
        GROUP BY company_id, market_key
     ),
     market_hhi AS (
       SELECT company_id,
              COUNT(*)::integer AS category_count,
              SUM(transaction_count * transaction_count) / POWER(SUM(transaction_count), 2) AS hhi,
              MAX(transaction_count) / SUM(transaction_count) AS top_share
         FROM market_counts
        GROUP BY company_id
     ),
     product_counts AS (
       SELECT company_id, product_key, COUNT(*)::numeric AS transaction_count
         FROM mapped_transactions
        WHERE product_key IS NOT NULL
        GROUP BY company_id, product_key
     ),
     product_hhi AS (
       SELECT company_id,
              COUNT(*)::integer AS category_count,
              SUM(transaction_count * transaction_count) / POWER(SUM(transaction_count), 2) AS hhi,
              MAX(transaction_count) / SUM(transaction_count) AS top_share
         FROM product_counts
        GROUP BY company_id
     ),
     supplier_hhi AS (
       SELECT company_id,
              CASE
                WHEN evidence_breakdown #>> '{factors,supplierDiversification,status}' = 'AVAILABLE'
                 AND jsonb_typeof(evidence_breakdown #> '{factors,supplierDiversification,evidence,sumSquaredShare}') = 'number'
                THEN (evidence_breakdown #>> '{factors,supplierDiversification,evidence,sumSquaredShare}')::numeric
                ELSE NULL
              END AS hhi
         FROM company_potential
        WHERE dataset_id = $1
     ),
     company_signals AS (
       SELECT c.id AS company_id,
              market_hhi.hhi AS market_hhi,
              market_hhi.top_share AS market_top_share,
              market_hhi.category_count AS market_count,
              product_hhi.hhi AS product_hhi,
              product_hhi.top_share AS product_top_share,
              product_hhi.category_count AS product_count,
              supplier_hhi.hhi AS supplier_hhi
         FROM target_companies c
         LEFT JOIN market_hhi ON market_hhi.company_id = c.id
         LEFT JOIN product_hhi ON product_hhi.company_id = c.id
         LEFT JOIN supplier_hhi ON supplier_hhi.company_id = c.id
     ),
     metric_summary AS (
       SELECT
         COUNT(*) AS target_company_count,
         COUNT(market_hhi) AS market_available_count,
         COUNT(*) - COUNT(market_hhi) AS market_unavailable_count,
         AVG(market_hhi) AS market_average_hhi,
         MAX(market_hhi) AS market_maximum_hhi,
         MAX(market_top_share) AS market_maximum_top_share,
         COUNT(product_hhi) AS product_available_count,
         COUNT(*) - COUNT(product_hhi) AS product_unavailable_count,
         AVG(product_hhi) AS product_average_hhi,
         MAX(product_hhi) AS product_maximum_hhi,
         MAX(product_top_share) AS product_maximum_top_share,
         COUNT(supplier_hhi) AS supplier_available_count,
         COUNT(*) - COUNT(supplier_hhi) AS supplier_unavailable_count,
         AVG(supplier_hhi) AS supplier_average_hhi,
         MAX(supplier_hhi) AS supplier_maximum_hhi
       FROM company_signals
     )
     SELECT
       jsonb_build_object(
         'targetCompanyCount', target_company_count,
         'marketConcentration', jsonb_build_object(
           'status', CASE WHEN market_available_count > 0 THEN 'AVAILABLE' ELSE 'UNAVAILABLE' END,
           'metric', 'Herfindahl-Hirschman Index (HHI)',
           'basis', 'Share of normalized transactions by normalized country text within the matched company',
           'scale', '0 to 1; no risk threshold applied',
           'companiesAvailable', market_available_count,
           'companiesUnavailable', market_unavailable_count,
           'averageHHI', market_average_hhi,
           'maximumHHI', market_maximum_hhi,
           'maximumTopMarketShare', market_maximum_top_share
         ),
         'productConcentration', jsonb_build_object(
           'status', CASE WHEN product_available_count > 0 THEN 'AVAILABLE' ELSE 'UNAVAILABLE' END,
           'metric', 'Herfindahl-Hirschman Index (HHI)',
           'basis', 'Share of normalized transactions by normalized product name and category within the matched company',
           'scale', '0 to 1; no risk threshold applied',
           'companiesAvailable', product_available_count,
           'companiesUnavailable', product_unavailable_count,
           'averageHHI', product_average_hhi,
           'maximumHHI', product_maximum_hhi,
           'maximumTopProductShare', product_maximum_top_share
         ),
         'supplierConcentration', jsonb_build_object(
           'status', CASE WHEN supplier_available_count > 0 THEN 'AVAILABLE' ELSE 'UNAVAILABLE' END,
           'metric', 'Herfindahl-Hirschman Index (HHI)',
           'basis', 'Existing evidence-weighted Supplier Diversification factor, using transaction share by IEC',
           'identityField', 'IEC',
           'scale', '0 to 1; no risk threshold applied',
           'companiesAvailable', supplier_available_count,
           'companiesUnavailable', supplier_unavailable_count,
           'averageHHI', supplier_average_hhi,
           'maximumHHI', supplier_maximum_hhi,
           'identityCaveat', 'Some IECs are associated with multiple exporter names; IEC remains the identity and exporter names are not used to resolve identity.'
         )
       ) AS summary,
       COALESCE(
         (SELECT jsonb_agg(jsonb_build_object(
            'companyId', s.company_id,
            'marketConcentration', jsonb_build_object(
              'status', CASE WHEN s.market_hhi IS NULL THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
              'metric', 'transaction_count_hhi',
              'value', s.market_hhi,
              'topShare', s.market_top_share,
              'categoryCount', s.market_count
            ),
            'productConcentration', jsonb_build_object(
              'status', CASE WHEN s.product_hhi IS NULL THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
              'metric', 'transaction_count_hhi',
              'value', s.product_hhi,
              'topShare', s.product_top_share,
              'categoryCount', s.product_count
            ),
            'supplierConcentration', jsonb_build_object(
              'status', CASE WHEN s.supplier_hhi IS NULL THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
              'metric', 'iec_transaction_share_hhi',
              'value', s.supplier_hhi,
              'identityField', 'IEC'
            )
          ) ORDER BY s.company_id)
            FROM company_signals s
            JOIN lead_companies l ON l.company_id = s.company_id),
          '[]'::jsonb
       ) AS lead_signals
     FROM metric_summary`,
    [datasetId]
  );
  return rows[0] || { summary: null, lead_signals: [] };
}
