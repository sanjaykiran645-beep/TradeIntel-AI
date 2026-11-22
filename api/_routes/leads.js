import { createHash } from 'node:crypto';
import database from '../_db-client.js';
import { apiErrorResponse, setCors, logAudit, requireAuth } from '../_utils.js';
import { resolveDatasetId } from '../_dataset-scope.js';
import { isCurrentlyQualifiedPotential } from '../_lead-qualification.js';

const LEAD_PAGE_SIZE = 1000;

async function readLeadsForDataset(datasetId, { offset = 0, limit = null, count = false } = {}) {
  let query = database.from('leads')
    .select('*, companies(*), contacts(*)', count ? { count: 'exact' } : undefined)
    .eq('dataset_id', datasetId)
    .order('score', { ascending: false });
  if (limit !== null) query = query.range(offset, offset + limit - 1);
  else query = query.range(offset, offset + LEAD_PAGE_SIZE - 1);
  return query;
}

async function classifyLeadRows(rows, datasetId) {
  const companyIds = [...new Set((rows || [])
    .filter(lead => lead.intent_type === 'COMPANY_POTENTIAL')
    .map(lead => Number(lead.company_id))
    .filter(id => Number.isSafeInteger(id) && id > 0))];
  const potentialByCompany = new Map();
  if (companyIds.length) {
    const { data, error } = await database.from('company_potential')
      .select('company_id,total_score')
      .eq('dataset_id', datasetId)
      .in('company_id', companyIds);
    if (error) throw error;
    for (const row of data || []) potentialByCompany.set(Number(row.company_id), Number(row.total_score));
  }

  return (rows || []).map(lead => {
    if (lead.intent_type !== 'COMPANY_POTENTIAL') {
      return { ...lead, qualification_class: 'COMMERCIAL_REPLY', current_rule_qualified: null };
    }
    const currentPotentialScore = potentialByCompany.get(Number(lead.company_id));
    const qualified = isCurrentlyQualifiedPotential(currentPotentialScore, lead.companies?.total_transactions);
    return {
      ...lead,
      current_potential_score: currentPotentialScore ?? null,
      current_rule_qualified: qualified,
      qualification_class: qualified ? 'CURRENT_RULE' : 'HISTORICAL_LEGACY'
    };
  });
}

async function readLeadClassificationCounts(datasetId) {
  const { rows } = await database.query(
    `SELECT
       COUNT(*) FILTER (WHERE l.intent_type = 'COMPANY_POTENTIAL' AND cp.total_score >= 75 AND c.total_transactions >= 10) AS current_rule_leads,
       COUNT(*) FILTER (WHERE l.intent_type = 'COMPANY_POTENTIAL' AND NOT COALESCE(cp.total_score >= 75 AND c.total_transactions >= 10, false)) AS historical_legacy_leads,
       COUNT(*) FILTER (WHERE l.intent_type <> 'COMPANY_POTENTIAL') AS commercial_reply_leads
     FROM leads l
     LEFT JOIN companies c ON c.dataset_id = l.dataset_id AND c.id = l.company_id
     LEFT JOIN company_potential cp ON cp.dataset_id = l.dataset_id AND cp.company_id = l.company_id
     WHERE l.dataset_id = $1`,
    [datasetId]
  );
  return Object.fromEntries(Object.entries(rows[0] || {}).map(([key, value]) => [key, Number(value || 0)]));
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!(await requireAuth(req, res))) return;

  try {
    if (req.method === 'GET') {
      const datasetId = await resolveDatasetId(req);
      const queryParams = req.query || {};
      const hasPagination = queryParams.page !== undefined || queryParams.pageSize !== undefined || queryParams.dataset_id !== undefined || queryParams.datasetId !== undefined;

      if (hasPagination) {
        const page = Number(queryParams.page ?? 1);
        const pageSize = Number(queryParams.pageSize ?? 20);
        if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
          return res.status(400).json({ error: 'page must be a positive integer and pageSize must be between 1 and 100.', code: 'INVALID_PAGINATION' });
        }
        const offset = (page - 1) * pageSize;
        const [{ data, count, error }, classificationCounts] = await Promise.all([
          readLeadsForDataset(datasetId, { offset, limit: pageSize, count: true }),
          readLeadClassificationCounts(datasetId)
        ]);
        if (error) throw error;
        return res.status(200).json({
          data: await classifyLeadRows(data || [], datasetId),
          page,
          pageSize,
          total: Number(count || 0),
          totalPages: Math.ceil(Number(count || 0) / pageSize),
          ...classificationCounts,
          datasetId
        });
      }

      const rows = [];
      let offset = 0;
      while (true) {
        const { data, error } = await readLeadsForDataset(datasetId, { offset });
        if (error) throw error;
        const page = data || [];
        rows.push(...page);
        if (page.length < LEAD_PAGE_SIZE) break;
        offset += page.length;
      }
      // Optional per-company scope (Customer 360): filter before the costlier classification step.
      const scopedCompanyId = queryParams.companyId;
      const scopedRows = scopedCompanyId
        ? rows.filter(row => String(row.company_id) === String(scopedCompanyId))
        : rows;
      return res.status(200).json(await classifyLeadRows(scopedRows, datasetId));
    }

    if (req.method === 'POST') {
      const { companyId, contactId, productRequirement, intentType, evidence, score, confidence, recommendedAction } = req.body || {};
      if (!companyId || !productRequirement?.trim() || !intentType || !evidence || typeof evidence !== 'object' || Array.isArray(evidence) || !Object.keys(evidence).length || !String(evidence.source || '').trim()) {
        return res.status(400).json({ error: 'companyId, productRequirement, intentType, and non-empty source evidence are required.' });
      }
      const numericScore = Number(score);
      if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 100) {
        return res.status(400).json({ error: 'A persisted score between 0 and 100 is required.' });
      }
      const numericConfidence = confidence == null ? null : Number(confidence);
      if (numericConfidence !== null && (!Number.isFinite(numericConfidence) || numericConfidence < 0 || numericConfidence > 1)) {
        return res.status(400).json({ error: 'Confidence must be between 0 and 1, or omitted when it has not been estimated.' });
      }

      const datasetId = await resolveDatasetId(req);
      const { data: company, error: companyError } = await database.from('companies')
        .select('id,name')
        .eq('id', companyId)
        .eq('dataset_id', datasetId)
        .maybeSingle();
      if (companyError) throw companyError;
      if (!company) return res.status(404).json({ error: 'Company was not found in the selected dataset.', code: 'COMPANY_NOT_IN_DATASET' });

      let contactName = null;
      if (contactId) {
        const { data: contact, error: contactError } = await database.from('contacts')
          .select('id,name,company_id,is_suppressed')
          .eq('id', contactId)
          .eq('dataset_id', datasetId)
          .maybeSingle();
        if (contactError) throw contactError;
        if (!contact || Number(contact.company_id) !== Number(company.id) || contact.is_suppressed) {
          return res.status(400).json({ error: 'Contact must be an existing, unsuppressed contact for the selected dataset and company.' });
        }
        contactName = contact.name;
      }

      const dedupKey = createHash('sha256').update([
        datasetId,
        company.id,
        String(intentType).trim().toUpperCase(),
        String(evidence.source).trim(),
        evidence.inboxMessageId || '',
        String(productRequirement).trim().toLowerCase()
      ].join(':')).digest('hex');
      const { data: existing, error: duplicateError } = await database.from('leads')
        .select('id')
        .eq('dataset_id', datasetId)
        .eq('dedup_key', dedupKey)
        .maybeSingle();
      if (duplicateError) throw duplicateError;
      if (existing) return res.status(200).json({ success: true, duplicate: true, id: existing.id, datasetId });

      const { data, error } = await database.from('leads')
        .insert({
          dataset_id: datasetId,
          dedup_key: dedupKey,
          company_id: company.id,
          contact_id: contactId || null,
          company_name: company.name,
          contact_name: contactName,
          product_requirement: productRequirement.trim(),
          intent_type: intentType,
          evidence,
          score: numericScore,
          confidence: numericConfidence,
          recommended_human_action: recommendedAction || 'Review the supplied source evidence before taking commercial action.',
          status: 'NEW',
          created_at: new Date().toISOString()
        })
        .select()
        .single();
      if (error) throw error;

      await logAudit(req.user?.email, 'CREATE_EVIDENCED_LEAD', 'leads', data.id, { datasetId, company: company.name, score: numericScore, evidenceSource: evidence.source });
      return res.status(201).json(data);
    }

    if (req.method === 'PUT') {
      const { id, status } = req.body || {};
      if (!id || !status) return res.status(400).json({ error: 'id and status required' });
      const datasetId = await resolveDatasetId(req);
      const { data, error } = await database.from('leads')
        .update({ status })
        .eq('id', id)
        .eq('dataset_id', datasetId)
        .select()
        .single();
      if (error) throw error;
      await logAudit(req.user?.email, 'UPDATE_LEAD_STATUS', 'leads', id, { datasetId, status });
      return res.status(200).json(data);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error(`[LEADS] request failed code=${error.code || 'DATABASE_ERROR'}`);
    return apiErrorResponse(res, error, 'LEADS_ERROR');
  }
}
