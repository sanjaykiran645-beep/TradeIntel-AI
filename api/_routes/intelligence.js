import supabase from '../_db-client.js';
import { apiErrorResponse, setCors, logAudit, requireAuth } from '../_utils.js';
import { resolveDatasetId } from '../_dataset-scope.js';
import { commercialRelevanceFactor } from '../_trade-evidence.js';

const DATA_PAGE_SIZE = 1000;
const ID_QUERY_BATCH_SIZE = 300;
const WRITE_BATCH_SIZE = 250;

function chunks(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

function throwDatabaseError(error) {
  throw Object.assign(new Error(error.message || error.code || 'Database request failed.'), {
    code: error.code || 'DATABASE_ERROR',
    details: error.details,
    hint: error.hint
  });
}

async function readCompanies({ datasetId, companyId, companyIds } = {}) {
  const companies = [];
  if (!Number.isSafeInteger(Number(datasetId)) || Number(datasetId) <= 0) {
    throw Object.assign(new Error('A dataset_id is required for dataset-scoped intelligence.'), { code: 'DATASET_ID_REQUIRED', status: 400 });
  }

  if (companyId) {
    const { data, error } = await supabase.from('companies').select('*').eq('id', companyId).eq('dataset_id', datasetId).singleAttempt();
    if (error) throwDatabaseError(error);
    return data || [];
  }

  if (Array.isArray(companyIds)) {
    if (!companyIds.length) return [];
    for (const batch of chunks([...new Set(companyIds)], ID_QUERY_BATCH_SIZE)) {
      const { data, error } = await supabase.from('companies').select('*').eq('dataset_id', datasetId).in('id', batch).singleAttempt();
      if (error) throwDatabaseError(error);
      companies.push(...(data || []));
    }
    return companies;
  }

  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('companies')
      .select('*')
      .eq('dataset_id', datasetId)
      .order('id', { ascending: true })
      .range(offset, offset + DATA_PAGE_SIZE - 1)
      .singleAttempt();
    if (error) throwDatabaseError(error);
    const page = data || [];
    companies.push(...page);
    if (page.length < DATA_PAGE_SIZE) break;
    offset += page.length;
  }
  return companies;
}

export async function readCompanySignalIds(table, companyIds, datasetId, configure = query => query) {
  const ids = new Set();
  for (const batch of chunks(companyIds, ID_QUERY_BATCH_SIZE)) {
    let offset = 0;
    while (true) {
      let query = supabase
        .from(table)
        .select('id,company_id')
        .eq('dataset_id', datasetId)
        .in('company_id', batch)
        .order('id', { ascending: true })
        .range(offset, offset + DATA_PAGE_SIZE - 1)
        .singleAttempt();
      query = configure(query);
      const { data, error } = await query;
      if (error) throwDatabaseError(error);
      const page = data || [];
      for (const row of page) ids.add(row.company_id);
      if (page.length < DATA_PAGE_SIZE) break;
      offset += page.length;
    }
  }
  return ids;
}

async function readExistingPotentialIds(companyIds, datasetId) {
  const existing = new Map();
  for (const batch of chunks(companyIds, ID_QUERY_BATCH_SIZE)) {
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('company_potential')
        .select('id,company_id')
        .eq('dataset_id', datasetId)
        .in('company_id', batch)
        .order('id', { ascending: true })
        .range(offset, offset + DATA_PAGE_SIZE - 1)
        .singleAttempt();
      if (error) throwDatabaseError(error);
      const page = data || [];
      for (const row of page) {
        if (existing.has(row.company_id)) {
          const conflict = new Error(`Duplicate potential rows exist for company ${row.company_id}; refusing an ambiguous update.`);
          conflict.code = 'POTENTIAL_KEY_CONFLICT';
          throw conflict;
        }
        existing.set(row.company_id, row.id);
      }
      if (page.length < DATA_PAGE_SIZE) break;
      offset += page.length;
    }
  }
  return existing;
}

async function readSupplierDiversification(companyIds, datasetId) {
  const result = await supabase.query(`
    WITH mapped_rows AS (
      SELECT
        c.id AS company_id,
        NULLIF(BTRIM(r.raw_data->>'IEC'), '') AS supplier_iec,
        NULLIF(BTRIM(r.raw_data->>'Exporter_Name'), '') AS exporter_name
      FROM normalized_records n
      JOIN raw_records r
        ON r.dataset_id = n.dataset_id
       AND r.row_index = n.source_row_index
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
        AND c.id = ANY($2::bigint[])
    ),
    supplier_counts AS (
      SELECT company_id, supplier_iec, COUNT(*)::numeric AS transaction_count
      FROM mapped_rows
      WHERE supplier_iec IS NOT NULL
      GROUP BY company_id, supplier_iec
    ),
    supplier_shares AS (
      SELECT
        company_id,
        transaction_count / SUM(transaction_count) OVER (PARTITION BY company_id) AS transaction_share
      FROM supplier_counts
    ),
    supplier_factors AS (
      SELECT
        company_id,
        COUNT(*)::integer AS supplier_count,
        SUM(transaction_share * transaction_share) AS sum_squared_share
      FROM supplier_shares
      GROUP BY company_id
    ),
    row_coverage AS (
      SELECT
        company_id,
        COUNT(*)::integer AS source_transaction_count,
        COUNT(*) FILTER (WHERE supplier_iec IS NULL)::integer AS missing_iec_count
      FROM mapped_rows
      GROUP BY company_id
    ),
    multi_exporter_iec AS (
      SELECT supplier_iec
      FROM mapped_rows
      WHERE supplier_iec IS NOT NULL
      GROUP BY supplier_iec
      HAVING COUNT(DISTINCT exporter_name) > 1
    )
    SELECT
      coverage.company_id,
      coverage.source_transaction_count,
      coverage.missing_iec_count,
      COALESCE(factors.supplier_count, 0)::integer AS supplier_count,
      factors.sum_squared_share,
      (SELECT COUNT(*)::integer FROM multi_exporter_iec) AS multi_exporter_iec_count
    FROM row_coverage coverage
    LEFT JOIN supplier_factors factors USING (company_id)
  `, [datasetId, companyIds]);
  return result.rows;
}

/** 
 * Authoritative 8-factor Customer Potential calculation.
 * Product Fit (20), Activity (15), Recency (15), Market Fit (10),
 * Commercial Relevance (15), Growth (10), Supplier Diversification (5),
 * Engagement/Intent (10).
 */
export async function calculatePotentialScores({ datasetId, companyId, companyIds, userEmail } = {}) {
  const companies = await readCompanies({ datasetId, companyId, companyIds });
  if (!companies?.length) {
    return { status: 'REVIEW_REQUIRED', scored: 0, data: [], reason: 'No companies are available to score.' };
  }

  const targetCompanyIds = [...new Set(companies.map(company => company.id))];
  const [verifiedContacts, sentEmails, replies, existingPotential, supplierEvidenceRows] = await Promise.all([
    readCompanySignalIds('contacts', targetCompanyIds, datasetId, query => query.eq('verification_status', 'VERIFIED').eq('is_suppressed', false)),
    readCompanySignalIds('outreach_emails', targetCompanyIds, datasetId, query => query.eq('status', 'SENT')),
    readCompanySignalIds('inbox_messages', targetCompanyIds, datasetId, query => query.not('outreach_id', 'is', null)),
    readExistingPotentialIds(targetCompanyIds, datasetId),
    readSupplierDiversification(targetCompanyIds, datasetId)
  ]);
  const supplierEvidence = new Map(supplierEvidenceRows.map(row => [String(row.company_id), row]));

  const records = companies.map(company => {
    const hasVerifiedContacts = verifiedContacts.has(company.id);
    const hasSentEmails = sentEmails.has(company.id);
    const hasReplies = replies.has(company.id);
    const productsCount = (company.primary_products || []).length;
    const transactions = Number(company.total_transactions || 0);
    const transactionValue = company.total_value === null || company.total_value === undefined
      ? null
      : Number(company.total_value);

    const productFit = Math.min(20, productsCount * 6 + (productsCount > 0 ? 5 : 0));
    const activity = transactions >= 5 ? 15 : transactions >= 3 ? 12 : transactions >= 1 ? 8 : 0;

    let recency = 0;
    if (company.last_activity_date) {
      const daysAgo = (Date.now() - new Date(company.last_activity_date).getTime()) / (1000 * 60 * 60 * 24);
      if (Number.isFinite(daysAgo) && daysAgo >= 0) {
        if (daysAgo < 30) recency = 15;
        else if (daysAgo < 90) recency = 12;
        else if (daysAgo < 180) recency = 9;
        else recency = 5;
      }
    }

    const marketFit = company.country && !['unknown', 'global'].includes(String(company.country).trim().toLowerCase()) ? 10 : 0;
    const commercialFactor = commercialRelevanceFactor(transactions, transactionValue);

    const supplierRow = supplierEvidence.get(String(company.id));
    const sourceTransactions = Number(supplierRow?.source_transaction_count || 0);
    const missingIecCount = Number(supplierRow?.missing_iec_count || 0);
    const supplierCount = Number(supplierRow?.supplier_count || 0);
    const sumSquaredShare = Number(supplierRow?.sum_squared_share);
    const supplierAvailable = sourceTransactions > 0
      && missingIecCount === 0
      && supplierCount > 0
      && Number.isFinite(sumSquaredShare);
    const supplierDiversification = supplierAvailable
      ? Math.round(Math.max(0, Math.min(5, 5 * (1 - sumSquaredShare))) * 100) / 100
      : null;
    const engagementAvailable = hasReplies || hasSentEmails;
    const engagement = hasReplies ? 10 : hasSentEmails ? 6 : null;
    const growthReason = 'Insufficient comparable reporting periods for defensible period-over-period growth.';

    const factors = {
      productFit: {
        value: productsCount > 0 ? productFit : null,
        status: productsCount > 0 ? 'AVAILABLE' : 'UNAVAILABLE',
        weight: 20,
        evidence: { productCount: productsCount }
      },
      activity: {
        value: transactions > 0 ? activity : null,
        status: transactions > 0 ? 'AVAILABLE' : 'UNAVAILABLE',
        weight: 15,
        evidence: { transactions }
      },
      recency: {
        value: company.last_activity_date ? recency : null,
        status: company.last_activity_date ? 'AVAILABLE' : 'UNAVAILABLE',
        weight: 15,
        evidence: { lastActivityDate: company.last_activity_date || null }
      },
      marketFit: {
        value: marketFit,
        status: company.country && !['unknown', 'global'].includes(String(company.country).trim().toLowerCase()) ? 'AVAILABLE' : 'UNAVAILABLE',
        weight: 10,
        evidence: { country: company.country || null }
      },
      commercialRelevance: {
        value: commercialFactor.value,
        status: commercialFactor.status,
        weight: 15,
        reason: commercialFactor.reason,
        evidence: commercialFactor.evidence
      },
      growth: {
        value: null,
        status: 'UNAVAILABLE',
        weight: 10,
        reason: growthReason,
        evidence: { reportingPeriods: 1 }
      },
      supplierDiversification: {
        value: supplierDiversification,
        status: supplierAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
        weight: 5,
        reason: supplierAvailable ? null : 'Complete company-to-transaction IEC evidence is unavailable.',
        evidence: supplierAvailable ? {
          identityField: 'IEC',
          sourceTransactionCount: sourceTransactions,
          supplierCount,
          sumSquaredShare,
          formula: '5 × (1 − Σ(transaction share by supplier IEC i)^2)',
          multiExporterIecCount: Number(supplierRow.multi_exporter_iec_count || 0)
        } : {
          identityField: 'IEC',
          sourceTransactionCount: sourceTransactions,
          missingIecCount,
          supplierCount
        }
      },
      engagement: {
        value: engagement,
        status: engagementAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
        weight: 10,
        reason: engagementAvailable ? null : `No sent-email or genuine-reply evidence exists for this company in dataset ${datasetId}.`,
        evidence: { hasSentEmail: hasSentEmails, hasGenuineReply: hasReplies }
      }
    };
    const weightedContributions = {};
    let availableWeight = 0;
    let rawWeightedScore = 0;
    for (const [factorName, factor] of Object.entries(factors)) {
      const available = factor.status === 'AVAILABLE';
      weightedContributions[factorName] = available ? factor.value : null;
      if (available) {
        availableWeight += factor.weight;
        rawWeightedScore += factor.value;
      }
    }
    if (availableWeight === 0) {
      throw Object.assign(new Error(`No scoring factors have evidence for company ${company.id}.`), { code: 'NO_SCORING_EVIDENCE' });
    }
    rawWeightedScore = Math.round(rawWeightedScore * 100) / 100;
    const totalScore = Math.round((rawWeightedScore / availableWeight) * 10000) / 100;
    let category = 'LOW';
    if (productsCount === 0 && transactions === 0) category = 'INSUFFICIENT_DATA';
    else if (totalScore >= 80) category = 'VERY_HIGH';
    else if (totalScore >= 65) category = 'HIGH';
    else if (totalScore >= 50) category = 'MEDIUM';

    const record = {
      dataset_id: datasetId,
      company_id: company.id,
      product_fit_score: factors.productFit.value,
      activity_score: factors.activity.value,
      recency_score: factors.recency.value,
      market_fit_score: factors.marketFit.value,
      commercial_relevance_score: factors.commercialRelevance.value,
      growth_score: null,
      supplier_diversification_score: factors.supplierDiversification.value,
      engagement_score: factors.engagement.value,
      total_score: totalScore,
      category,
      evidence_breakdown: {
        products: company.primary_products || [],
        transactions,
        tradeVolume: transactionValue,
        hasVerifiedContacts,
        hasEngagedReplies: hasReplies,
        factorAvailability: {
          growth: { available: false, reason: growthReason },
          supplierDiversification: {
            available: supplierAvailable,
            reason: supplierAvailable ? null : 'Complete company-to-transaction IEC evidence is unavailable.'
          },
          engagement: {
            available: engagementAvailable,
            reason: engagementAvailable ? null : `No sent-email or genuine-reply evidence exists for this company in dataset ${datasetId}.`
          }
        },
        supplierIdentityCaveat: 'Some IECs are associated with multiple exporter names; IEC remains the supplier identity, with no exporter-name-based identity resolution.',
        factors,
        scoreMetadata: {
          modelWeight: 100,
          availableWeight,
          excludedWeight: 100 - availableWeight,
          evidenceCoveragePercent: availableWeight,
          rawWeightedScore,
          normalizedScore: totalScore,
          weightedContributions,
          normalizationFormula: 'sum(available factor point contributions) / availableWeight * 100'
        },
        formula: 'Evidence-weighted 8-factor score; unavailable factor weights are excluded from the denominator.'
      },
      calculated_at: new Date().toISOString()
    };
    const existingId = existingPotential.get(company.id);
    if (existingId !== undefined) record.id = existingId;
    return record;
  });

  const results = [];
  for (const batch of chunks(records, WRITE_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('company_potential')
      .upsert(batch, { onConflict: 'dataset_id,company_id', defaultToNull: false })
      .select();
    if (error) throwDatabaseError(error);
    results.push(...(data || []));
  }

  await logAudit(userEmail || 'system@voyageib.com', 'CALCULATE_POTENTIAL_SCORE', 'company_potential', '', { count: results.length });
  return {
    status: 'COMPLETED',
    scored: results.length,
    data: results,
    reason: 'Scores were persisted with evidence-weighted normalization. Growth remains unavailable without comparable reporting periods.'
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!(await requireAuth(req, res))) return;

  try {
    if (req.method === 'GET') {
      const datasetId = await resolveDatasetId(req);
      const { data, error } = await supabase
        .from('company_potential')
        .select('*, companies(*)')
        .eq('dataset_id', datasetId)
        .order('total_score', { ascending: false });
      if (error) throw error;
      return res.status(200).json(data || []);
    }

    if (req.method === 'POST') {
      const datasetId = await resolveDatasetId(req);
      const result = await calculatePotentialScores({
        datasetId,
        companyId: req.body?.companyId,
        companyIds: req.body?.companyIds,
        userEmail: req.user?.email
      });
      return res.status(200).json({ success: true, ok: true, ...result });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(`[INTELLIGENCE] request failed code=${err.code || 'DATABASE_ERROR'}`);
    return apiErrorResponse(res, err, 'INTELLIGENCE_ERROR');
  }
}
