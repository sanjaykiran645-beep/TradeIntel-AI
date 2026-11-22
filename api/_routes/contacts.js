import database from '../_db-client.js';
import { apiErrorResponse, setCors, logAudit, requireAuth } from '../_utils.js';
import { persistExternalStage, stagePersistenceEvidence } from '../_external-pipeline.js';
import { resolveDatasetId } from '../_dataset-scope.js';
import { discoverPublicContacts, getContactDiscoveryConfiguration, isPublicHttpsUrl } from '../_contact-discovery.js';
import { isEmailGloballySuppressed, isValidOutreachEmail, suppressionUpdateBlocker } from '../_outreach-guards.js';

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function emailProtectionRows(emails, datasetId, companyId) {
  const normalized = [...new Set(emails.map(email => String(email || '').trim().toLowerCase()).filter(Boolean))];
  if (!normalized.length) return new Map();
  const { rows } = await database.query(
    `SELECT lower(email) AS normalized_email,
            bool_or(is_suppressed) AS is_suppressed,
            bool_or(dataset_id = $2 AND company_id = $3) AS same_company_contact
       FROM contacts
      WHERE lower(email) = ANY($1::text[])
      GROUP BY lower(email)`,
    [normalized, datasetId, companyId]
  );
  return new Map(rows.map(row => [row.normalized_email, row]));
}

async function findQualifiedLead(leadId, datasetId) {
  const { rows } = await database.query(
    `SELECT l.id AS lead_id,
            l.company_id,
            c.name AS company_name,
            c.country,
            c.total_transactions,
            p.total_score
       FROM leads l
       JOIN companies c
         ON c.dataset_id = l.dataset_id AND c.id = l.company_id
       JOIN company_potential p
         ON p.dataset_id = l.dataset_id AND p.company_id = l.company_id
      WHERE l.dataset_id = $1 AND l.id = $2
      LIMIT 1`,
    [datasetId, leadId]
  );
  return rows[0] || null;
}

async function addManualContact({ req, res, datasetId, body }) {
  const companyId = positiveId(body.company_id ?? body.companyId);
  const name = String(body.name || '').trim();
  const role = String(body.role || '').trim() || null;
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim() || null;
  const sourceUrl = String(body.source_url || body.sourceUrl || '').trim();

  if (!companyId || !name || !email || !sourceUrl) {
    return res.status(400).json({ success: false, error: 'company_id, name, email, and source_url are required.', code: 'CONTACT_INPUT_INVALID' });
  }
  if (!isValidOutreachEmail(email)) {
    return res.status(400).json({ success: false, error: 'A syntactically valid public business email is required.', code: 'CONTACT_EMAIL_INVALID' });
  }
  if (!isPublicHttpsUrl(sourceUrl)) {
    return res.status(400).json({ success: false, error: 'A public HTTPS source URL is required.', code: 'CONTACT_SOURCE_INVALID' });
  }
  if (phone && phone.length > 80) {
    return res.status(400).json({ success: false, error: 'Phone number is too long.', code: 'CONTACT_PHONE_INVALID' });
  }

  const { data: company, error: companyError } = await database.from('companies')
    .select('id,name')
    .eq('id', companyId)
    .eq('dataset_id', datasetId)
    .maybeSingle();
  if (companyError) throw companyError;
  if (!company) return res.status(404).json({ success: false, error: 'Company was not found in the selected dataset.', code: 'COMPANY_NOT_IN_DATASET' });

  const protections = await emailProtectionRows([email], datasetId, companyId);
  const existing = protections.get(email);
  if (existing?.is_suppressed) {
    return res.status(409).json({ success: false, error: 'This address is suppressed in the shared workspace and cannot be re-added.', code: 'CONTACT_SUPPRESSED' });
  }
  if (existing?.same_company_contact) {
    return res.status(409).json({ success: false, error: 'This address already exists for the selected company.', code: 'CONTACT_DUPLICATE' });
  }

  const discoveredAt = new Date().toISOString();
  const { rows } = await database.query(
    `INSERT INTO contacts
       (dataset_id, company_id, name, role, email, phone, source, source_url,
        discovery_provider, discovered_at, verification_status, confidence,
        is_suppressed, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'MANUAL_PUBLIC_SOURCE', $7,
             NULL, $8, 'UNVERIFIED', NULL, false, $8)
     RETURNING *`,
    [datasetId, company.id, name, role, email, phone, sourceUrl, discoveredAt]
  );
  const contact = rows[0];
  await logAudit(req.user?.email, 'ADD_UNVERIFIED_PUBLIC_CONTACT', 'contacts', contact.id, { datasetId, companyId: company.id, sourceUrl });
  return res.status(201).json({ success: true, status: 'UNVERIFIED', contact });
}

async function discoverForQualifiedLead({ req, res, datasetId, body }) {
  const leadId = positiveId(body.leadId ?? body.lead_id);
  if (!leadId) return res.status(400).json({ success: false, error: 'A qualified leadId is required.', code: 'LEAD_ID_REQUIRED' });

  const lead = await findQualifiedLead(leadId, datasetId);
  if (!lead) return res.status(404).json({ success: false, error: 'Lead was not found in the selected dataset.', code: 'LEAD_NOT_FOUND' });
  if (Number(lead.total_score) < 75 || Number(lead.total_transactions) < 10) {
    return res.status(409).json({ success: false, error: 'Contact discovery is limited to leads meeting total_score >= 75 and total_transactions >= 10.', code: 'LEAD_NOT_QUALIFIED' });
  }

  const configuration = getContactDiscoveryConfiguration();
  if (!configuration.configured) {
    const reason = configuration.reason || 'Contact discovery provider is not configured.';
    const persistence = await persistExternalStage('CONTACT_DISCOVERY', 'BLOCKED', {
      reason,
      blocker: 'Contact discovery provider is not configured.',
      evidence: { provider: configuration.provider, providerConfigured: false, contactsCreated: 0 }
    }, datasetId);
    return res.status(503).json({
      success: false,
      status: 'NOT_CONFIGURED',
      stage: 'CONTACT_DISCOVERY',
      error: reason,
      code: 'CONTACT_PROVIDER_NOT_CONFIGURED',
      persistence: stagePersistenceEvidence(persistence)
    });
  }

  const recentAttempt = await database.from('audit_logs')
    .select('id,created_at')
    .eq('action', 'DISCOVER_PUBLIC_CONTACTS')
    .eq('entity_type', 'companies')
    .eq('entity_id', String(lead.company_id))
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .limit(1)
    .maybeSingle();
  if (recentAttempt.error) throw recentAttempt.error;
  if (recentAttempt.data) {
    return res.status(429).json({
      success: false,
      status: 'REVIEW_REQUIRED',
      error: 'One public contact search per qualified lead is allowed every 24 hours to protect the existing web-search quota.',
      code: 'CONTACT_DISCOVERY_COOLDOWN'
    });
  }

  const auditStart = await logAudit(req.user?.email, 'DISCOVER_PUBLIC_CONTACTS', 'companies', lead.company_id, {
    datasetId,
    companyId: lead.company_id,
    provider: configuration.provider,
    status: 'REQUESTED'
  });
  if (!auditStart.persisted) {
    return res.status(503).json({ success: false, status: 'BLOCKED', error: 'Contact discovery could not be audited, so no provider request was made.', code: 'CONTACT_DISCOVERY_AUDIT_UNAVAILABLE' });
  }

  let result;
  try {
    result = await discoverPublicContacts({ name: lead.company_name, country: lead.country });
  } catch (providerError) {
    const errorCode = String(providerError?.code || 'CONTACT_PROVIDER_ERROR').toUpperCase();
    const safeCode = /^[A-Z0-9_-]{1,64}$/.test(errorCode) ? errorCode : 'CONTACT_PROVIDER_ERROR';
    console.error(`[CONTACTS] discovery provider failed code=${safeCode}`);
    let persistence = null;
    try {
      persistence = await persistExternalStage('CONTACT_DISCOVERY', 'FAILED', {
        recordsProcessed: 0,
        recordsProduced: 0,
        reason: 'Public contact discovery provider failed. No contact candidates were saved.',
        blocker: 'Contact discovery provider failure requires review before another attempt.',
        error: { code: safeCode },
        evidence: { provider: configuration.provider, providerConfigured: true, contactsCreated: 0 }
      }, datasetId);
    } catch (pipelineError) {
      console.error(`[CONTACTS] discovery failure status persistence failed code=${String(pipelineError?.code || 'DATABASE_ERROR').replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || 'DATABASE_ERROR'}`);
    }
    const audit = await logAudit(req.user?.email, 'CONTACT_DISCOVERY_FAILED', 'companies', lead.company_id, {
      datasetId,
      provider: configuration.provider,
      outcome: 'FAILED',
      errorCode: safeCode
    });
    return res.status(502).json({
      success: false,
      status: 'FAILED',
      stage: 'CONTACT_DISCOVERY',
      error: 'Public contact discovery provider failed. No contact candidates were saved.',
      code: 'CONTACT_DISCOVERY_PROVIDER_FAILED',
      auditPersisted: audit?.persisted === true,
      persistence: { persisted: persistence?.persisted === true }
    });
  }
  if (result.status === 'NOT_CONFIGURED') {
    return res.status(503).json({ success: false, status: 'NOT_CONFIGURED', error: result.reason, code: 'CONTACT_PROVIDER_NOT_CONFIGURED' });
  }

  const emails = (result.contacts || []).map(contact => contact.email);
  const protections = await emailProtectionRows(emails, datasetId, Number(lead.company_id));
  const discoveredAt = new Date().toISOString();
  let created = 0;
  let suppressed = 0;
  let duplicates = 0;
  const createdContacts = [];

  for (const candidate of result.contacts || []) {
    const email = String(candidate.email || '').trim().toLowerCase();
    const existing = protections.get(email);
    if (existing?.is_suppressed) {
      suppressed += 1;
      continue;
    }
    if (existing?.same_company_contact) {
      duplicates += 1;
      continue;
    }
    const { rows } = await database.query(
      `INSERT INTO contacts
         (dataset_id, company_id, name, role, email, source, source_url,
          discovery_provider, discovered_at, verification_status, confidence,
          is_suppressed, created_at)
       VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7,
               'UNVERIFIED', $8, false, $7)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [datasetId, lead.company_id, email, `${result.provider}_PUBLIC_WEB`, candidate.source_url, result.provider, discoveredAt, candidate.confidence]
    );
    if (rows[0]) {
      created += 1;
      createdContacts.push(rows[0]);
    } else {
      duplicates += 1;
    }
  }

  await logAudit(req.user?.email, 'CONTACT_DISCOVERY_RESULT', 'companies', lead.company_id, {
    datasetId,
    companyId: lead.company_id,
    provider: result.provider,
    candidateCount: result.contacts?.length || 0,
    contactsCreated: created,
    suppressedSkipped: suppressed,
    duplicatesSkipped: duplicates
  });

  const reason = created
    ? 'Public email candidates were saved as UNVERIFIED. A human must review each HTTPS source before verification or outreach.'
    : result.reason || 'No eligible unsuppressed public email candidates were persisted.';
  const persistence = await persistExternalStage('CONTACT_DISCOVERY', 'REVIEW_REQUIRED', {
    recordsProcessed: result.contacts?.length || 0,
    recordsProduced: created,
    reason,
    blocker: 'Discovered contacts remain UNVERIFIED and cannot be used for outreach until human review.',
    evidence: {
      provider: result.provider,
      requestCount: result.requestCount || 0,
      candidatesFound: result.contacts?.length || 0,
      contactsCreated: created,
      suppressedSkipped: suppressed,
      duplicatesSkipped: duplicates,
      humanVerificationRequired: true,
      emailValidation: 'Syntactic format only'
    }
  }, datasetId);
  return res.status(200).json({
    success: true,
    status: 'REVIEW_REQUIRED',
    provider: result.provider,
    candidatesFound: result.contacts?.length || 0,
    contactsCreated: created,
    suppressedSkipped: suppressed,
    duplicatesSkipped: duplicates,
    contacts: createdContacts,
    reason,
    persistence: stagePersistenceEvidence(persistence)
  });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!(await requireAuth(req, res))) return;

  try {
    if (req.method === 'GET') {
      const { companyId } = req.query || {};
      const datasetId = await resolveDatasetId(req);
      let query = database.from('contacts')
        .select('*, companies(name, country, primary_products)')
        .eq('dataset_id', datasetId)
        .order('id', { ascending: false });
      if (companyId) query = query.eq('company_id', companyId);

      const { data, error } = await query;
      if (error) throw error;
      const normalized = (data || []).map(contact => ({
        ...contact,
        company_name: contact.company_name || contact.companies?.name || 'Company',
        company_country: contact.company_country || contact.companies?.country || null
      }));
      return res.status(200).json(normalized);
    }

    if (req.method === 'POST') {
      const datasetId = await resolveDatasetId(req);
      const body = req.body || {};
      const action = String(body.action || '').trim().toUpperCase();
      if (action === 'MANUAL_ADD') return await addManualContact({ req, res, datasetId, body });
      if (action === 'DISCOVER') return await discoverForQualifiedLead({ req, res, datasetId, body });
      return res.status(400).json({ success: false, error: 'action must be MANUAL_ADD or DISCOVER.', code: 'CONTACT_ACTION_INVALID' });
    }

    if (req.method === 'PUT') {
      const { id, is_suppressed, suppression_reason, action } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Contact ID required' });
      const datasetId = await resolveDatasetId(req);

      if (action === 'VERIFY') {
        const { data: existing, error: lookupError } = await database.from('contacts')
          .select('id,source_url,email,is_suppressed,verification_status')
          .eq('id', id).eq('dataset_id', datasetId).maybeSingle();
        if (lookupError) throw lookupError;
        if (!existing) return res.status(404).json({ error: 'Contact not found.' });
        if (!isValidOutreachEmail(existing.email) || existing.is_suppressed) return res.status(409).json({ error: 'A valid, unsuppressed email address is required before a human can verify this contact.' });
        if (await isEmailGloballySuppressed(existing.email)) return res.status(409).json({ error: 'This email address is suppressed in the shared workspace and cannot be verified.' });
        if (!isPublicHttpsUrl(existing.source_url)) return res.status(409).json({ error: 'A saved public HTTPS source URL is required before a human can verify this contact.' });
        const { data, error } = await database.from('contacts').update({ verification_status: 'VERIFIED' })
          .eq('id', id).eq('dataset_id', datasetId).select().single();
        if (error) throw error;
        await logAudit(req.user?.email, 'HUMAN_VERIFY_CONTACT', 'contacts', id, { source_url: existing.source_url });
        return res.status(200).json(data);
      }

      const suppressionBlocker = suppressionUpdateBlocker(is_suppressed);
      if (suppressionBlocker) return res.status(409).json({ error: suppressionBlocker });
      const { data: existing, error: lookupError } = await database.from('contacts')
        .select('id,email').eq('id', id).eq('dataset_id', datasetId).maybeSingle();
      if (lookupError) throw lookupError;
      if (!existing) return res.status(404).json({ error: 'Contact not found.' });

      const { rows } = await database.query(
        `UPDATE contacts
            SET is_suppressed = true,
                suppression_reason = COALESCE($2, 'Manually suppressed by user')
          WHERE lower(email) = lower($1)
          RETURNING id, dataset_id`,
        [existing.email, suppression_reason || null]
      );
      await logAudit(req.user?.email, 'SUPPRESS_CONTACT_EMAIL', 'contacts', id, { affectedContactRecords: rows.length });
      const { data, error } = await database.from('contacts').select('*').eq('id', id).eq('dataset_id', datasetId).single();
      if (error) throw error;
      return res.status(200).json(data);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(`[CONTACTS] request failed code=${err.code || 'DATABASE_ERROR'}`);
    return apiErrorResponse(res, err, 'CONTACTS_ERROR');
  }
}
