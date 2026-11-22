import supabase from './_db-client.js';
import { readQualifiedPotential } from './_sql-risk-analysis.js';

const COMPANY_BATCH_SIZE = 300;
const INSERT_BATCH_SIZE = 200;

export function isCurrentlyQualifiedPotential(totalScore, totalTransactions) {
  return Number(totalScore) >= 75 && Number(totalTransactions) >= 10;
}

function chunks(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

async function readCompanies(companyIds, datasetId) {
  const companies = [];
  for (const batch of chunks(companyIds, COMPANY_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('companies')
      .select('id,name,country,primary_products,total_transactions,total_value,last_activity_date,roles')
      .eq('dataset_id', datasetId)
      .in('id', batch);
    if (error) throw error;
    companies.push(...(data || []));
  }
  return companies;
}

export async function qualifyCompaniesFromPotential(companyIds, datasetId, userEmail) {
  const targetIds = [...new Set(companyIds)];
  const [potentialRows, companies] = await Promise.all([
    readQualifiedPotential(targetIds, datasetId),
    readCompanies(targetIds, datasetId)
  ]);
  const companyById = new Map(companies.map(company => [company.id, company]));
  const existingLeadIds = new Set();

  for (const batch of chunks(targetIds, COMPANY_BATCH_SIZE)) {
    const { data, error } = await supabase.from('leads').select('company_id').eq('dataset_id', datasetId).eq('intent_type', 'COMPANY_POTENTIAL').in('company_id', batch);
    if (error) throw error;
    for (const lead of data || []) existingLeadIds.add(lead.company_id);
  }

  const leadRows = [];
  for (const potential of potentialRows) {
    if (existingLeadIds.has(potential.company_id)) continue;
    const company = companyById.get(potential.company_id);
    if (!company) continue;
    const products = Array.isArray(company.primary_products)
      ? company.primary_products.filter(value => typeof value === 'string' && value.trim())
      : [];
    const recordedProducts = Array.isArray(potential.evidence_breakdown?.products)
      ? potential.evidence_breakdown.products.filter(value => typeof value === 'string' && value.trim())
      : [];
    const evidencedProducts = [...new Set([...recordedProducts, ...products])];
    if (!evidencedProducts.length) continue;

    leadRows.push({
      dataset_id: datasetId,
      dedup_key: `COMPANY_POTENTIAL:${company.id}`,
      company_id: company.id,
      contact_id: null,
      company_name: company.name,
      contact_name: null,
      product_requirement: evidencedProducts.slice(0, 5).join(', '),
      intent_type: 'COMPANY_POTENTIAL',
      evidence: {
        source: 'company_potential',
        qualificationRule: 'Business rule: total_score >= 75 and total_transactions >= 10 with at least one evidenced product',
        potentialId: potential.id,
        potentialCategory: potential.category,
        score: potential.total_score,
        calculatedAt: potential.calculated_at,
        factors: {
          productFit: potential.product_fit_score,
          activity: potential.activity_score,
          recency: potential.recency_score,
          marketFit: potential.market_fit_score,
          commercialRelevance: potential.commercial_relevance_score,
          growth: potential.growth_score,
          supplierDiversification: potential.supplier_diversification_score,
          engagement: potential.engagement_score
        },
        potentialEvidence: potential.evidence_breakdown || {},
        companyEvidence: {
          name: company.name,
          country: company.country,
          products: evidencedProducts,
          transactions: company.total_transactions,
          tradeValue: company.total_value,
          lastActivityDate: company.last_activity_date,
          roles: company.roles
        }
      },
      score: potential.total_score,
      confidence: null,
      recommended_human_action: 'Review the recorded company-potential factors, verify current business fit, and wait for public research and a verified contact before outreach.',
      status: 'NEW',
      created_at: new Date().toISOString()
    });
  }

  let produced = 0;
  for (const batch of chunks(leadRows, INSERT_BATCH_SIZE)) {
    const { data, error } = await supabase.from('leads').insert(batch).select('id,company_id');
    if (error) throw error;
    produced += data?.length || 0;
  }

  return {
    candidates: potentialRows.length,
    produced,
    skippedExisting: potentialRows.length - leadRows.length,
    qualifiedPotential: potentialRows,
    userEmail
  };
}
