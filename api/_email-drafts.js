import supabase from './_db-client.js';
import { isEmailGloballySuppressed, isValidOutreachEmail } from './_outreach-guards.js';
import { isCurrentlyQualifiedPotential } from './_lead-qualification.js';

const PREVIEW_BATCH_SIZE = 250;

function htmlEscape(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function leadProducts(lead, company) {
  const evidenced = lead?.evidence?.companyEvidence?.products;
  const products = Array.isArray(evidenced) && evidenced.length
    ? evidenced
    : Array.isArray(company.primary_products) ? company.primary_products : [];
  return [...new Set(products.filter(product => typeof product === 'string' && product.trim()).map(product => product.trim()))];
}

export function buildPersonalizedEmailCopy({ companyName, country, products, recipientName = 'Procurement Team' }) {
  const evidencedProducts = [...new Set((products || []).filter(product => typeof product === 'string' && product.trim()).map(product => product.trim()))];
  if (!companyName || !evidencedProducts.length) return null;
  const productFocus = evidencedProducts[0];
  const marketEvidence = country ? ` in ${country}` : '';
  return {
    productFocus,
    subject: `Sourcing inquiry: ${productFocus}`,
    bodyText: `Dear ${recipientName},

Our trade records list ${companyName} with activity in ${evidencedProducts.slice(0, 3).join(', ')}${marketEvidence}. I am reaching out from Voyage International Business to ask whether ${productFocus} is currently relevant to your sourcing plans.

If it would be useful, I can share information for your review.

Best regards,
Voyage International Business`
  };
}

export function buildLeadDraftPreview(lead) {
  const evidence = lead?.evidence?.companyEvidence || {};
  const products = Array.isArray(evidence.products) && evidence.products.length
    ? evidence.products
    : String(lead?.product_requirement || '').split(',').map(value => value.trim()).filter(Boolean);
  const copy = buildPersonalizedEmailCopy({
    companyName: evidence.name || lead?.company_name,
    country: evidence.country,
    products
  });
  if (!copy) return null;
  return {
    leadId: lead.id,
    companyId: lead.company_id,
    recipientAssigned: false,
    recipientEmail: null,
    sendable: false,
    ...copy,
    evidence: {
      source: lead.evidence?.source || 'LEAD_RECORD',
      potentialId: lead.evidence?.potentialId || null,
      potentialCategory: lead.evidence?.potentialCategory || null,
      score: lead.evidence?.score ?? lead.score,
      products: products.slice(0, 3),
      country: evidence.country || null
    }
  };
}

export async function generateDatasetLeadPreviews({ datasetId, riskSignals = [] }) {
  if (!Number.isSafeInteger(Number(datasetId)) || Number(datasetId) <= 0) {
    throw Object.assign(new Error('A dataset_id is required for dataset-scoped draft generation.'), { code: 'DATASET_ID_REQUIRED', status: 400 });
  }
  const { rows: [initialCounts] } = await supabase.query(
    `SELECT COUNT(*) AS lead_count,
            COUNT(*) FILTER (WHERE evidence ? 'pitchingEmailPreview') AS existing_preview_count
       FROM leads l
       JOIN companies c ON c.dataset_id = l.dataset_id AND c.id = l.company_id
       JOIN company_potential cp ON cp.dataset_id = l.dataset_id AND cp.company_id = l.company_id
      WHERE l.dataset_id = $1
        AND l.intent_type = 'COMPANY_POTENTIAL'
        AND cp.total_score >= 75
        AND c.total_transactions >= 10`,
    [datasetId]
  );
  const riskByCompany = new Map((riskSignals || []).map(signal => [String(signal.companyId), signal]));
  let lastId = 0;
  let generated = 0;
  let skippedMissingProductEvidence = 0;
  let skippedUsableContact = 0;

  while (true) {
    const { rows } = await supabase.query(
      `SELECT l.id,
              l.company_id,
              l.company_name,
              l.product_requirement,
              l.score,
              l.evidence,
              c.country,
              c.primary_products,
              (SELECT EXISTS (
                 SELECT 1
                   FROM contacts contact
                  WHERE contact.dataset_id = l.dataset_id
                    AND contact.company_id = l.company_id
                    AND contact.verification_status = 'VERIFIED'
                    AND contact.is_suppressed = false
                    AND contact.email IS NOT NULL
               )) AS has_verified_contact,
              (SELECT EXISTS (
                 SELECT 1
                   FROM web_research research
                  WHERE research.dataset_id = l.dataset_id
                    AND research.company_id = l.company_id
               )) AS has_research
         FROM leads l
         JOIN companies c ON c.dataset_id = l.dataset_id AND c.id = l.company_id
         JOIN company_potential cp ON cp.dataset_id = l.dataset_id AND cp.company_id = l.company_id
        WHERE l.dataset_id = $1
          AND l.intent_type = 'COMPANY_POTENTIAL'
          AND cp.total_score >= 75
          AND c.total_transactions >= 10
          AND l.id > $2
          AND NOT (COALESCE(l.evidence, '{}'::jsonb) ? 'pitchingEmailPreview')
        ORDER BY l.id
        LIMIT $3`,
      [datasetId, lastId, PREVIEW_BATCH_SIZE]
    );
    if (!rows.length) break;

    const updates = [];
    for (const row of rows) {
      lastId = Number(row.id);
      if (row.has_verified_contact) {
        skippedUsableContact += 1;
        continue;
      }
      const priorEvidence = row.evidence && typeof row.evidence === 'object' ? row.evidence : {};
      const priorCompanyEvidence = priorEvidence.companyEvidence && typeof priorEvidence.companyEvidence === 'object'
        ? priorEvidence.companyEvidence
        : {};
      const fallbackProducts = Array.isArray(row.primary_products) ? row.primary_products : [];
      const lead = {
        id: row.id,
        company_id: row.company_id,
        company_name: priorCompanyEvidence.name || row.company_name,
        product_requirement: row.product_requirement,
        score: row.score,
        evidence: {
          ...priorEvidence,
          companyEvidence: {
            ...priorCompanyEvidence,
            name: priorCompanyEvidence.name || row.company_name,
            country: priorCompanyEvidence.country || row.country || null,
            products: Array.isArray(priorCompanyEvidence.products) && priorCompanyEvidence.products.length
              ? priorCompanyEvidence.products
              : fallbackProducts
          }
        }
      };
      const preview = buildLeadDraftPreview(lead);
      if (!preview) {
        skippedMissingProductEvidence += 1;
        continue;
      }

      const contactStatus = row.has_verified_contact ? 'CONTACT_AVAILABLE' : 'CONTACT_UNAVAILABLE';
      const researchStatus = row.has_research ? 'RESEARCH_AVAILABLE' : 'RESEARCH_UNAVAILABLE';
      const riskEvidence = riskByCompany.get(String(row.company_id)) || null;
      const now = new Date().toISOString();
      const nonSendablePreview = {
        ...preview,
        status: 'PREVIEW',
        reason: 'No verified, unsuppressed business contact is available for this company. Contact discovery is not configured.',
        contactStatus,
        researchStatus,
        sendable: false,
        recipientAssigned: false,
        recipientEmail: null,
        emailSendingStatus: 'NOT_SENT',
        riskEvidence,
        generatedAt: now
      };
      const existingEnrichment = priorEvidence.businessEnrichment && typeof priorEvidence.businessEnrichment === 'object'
        ? priorEvidence.businessEnrichment
        : {};
      updates.push({
        id: row.id,
        preview: nonSendablePreview,
        enrichment: {
          ...existingEnrichment,
          leadStatus: existingEnrichment.leadStatus || 'QUALIFIED',
          qualificationRule: existingEnrichment.qualificationRule || priorEvidence.qualificationRule || null,
          contactStatus: existingEnrichment.contactStatus || contactStatus,
          contactStatusReason: existingEnrichment.contactStatusReason || (row.has_verified_contact ? null : 'No verified, unsuppressed contact with an address is available.'),
          researchStatus: existingEnrichment.researchStatus || researchStatus,
          researchStatusReason: existingEnrichment.researchStatusReason || (row.has_research ? null : 'No company research records exist and no research provider is configured.'),
          riskStatus: riskEvidence ? 'AVAILABLE' : 'UNAVAILABLE',
          riskEvidence: existingEnrichment.riskEvidence || riskEvidence,
          updatedAt: now
        }
      });
    }

    if (updates.length) {
      const { rows: saved } = await supabase.query(
        `WITH incoming AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb)
             AS item(id bigint, preview jsonb, enrichment jsonb)
         )
         UPDATE leads AS lead
            SET evidence = COALESCE(lead.evidence, '{}'::jsonb)
              || jsonb_build_object(
                   'pitchingEmailPreview', incoming.preview,
                   'businessEnrichment',
                     COALESCE(lead.evidence->'businessEnrichment', '{}'::jsonb) || incoming.enrichment
                 )
           FROM incoming
          WHERE lead.id = incoming.id
            AND lead.dataset_id = $2
            AND NOT (COALESCE(lead.evidence, '{}'::jsonb) ? 'pitchingEmailPreview')
         RETURNING lead.id`,
        [JSON.stringify(updates), datasetId]
      );
      generated += saved.length;
    }
    if (rows.length < PREVIEW_BATCH_SIZE) break;
  }

  return {
    qualifiedLeads: Number(initialCounts?.lead_count || 0),
    existingPreviews: Number(initialCounts?.existing_preview_count || 0),
    generated,
    skippedMissingProductEvidence,
    skippedUsableContact
  };
}

export async function generatePersonalizedDraft({ leadId, companyId, contactId, datasetId, userEmail }) {
  if (!datasetId) return { status: 'REVIEW_REQUIRED', reason: 'A dataset_id is required for dataset-scoped draft generation.' };
  let lead = null;
  if (leadId) {
    const { data, error } = await supabase.from('leads').select('*').eq('id', leadId).eq('dataset_id', datasetId).maybeSingle();
    if (error) throw error;
    if (!data) return { status: 'REVIEW_REQUIRED', reason: `Lead ${leadId} was not found.` };
    lead = data;
    companyId = data.company_id;
    contactId = contactId || data.contact_id;
  }

  if (!companyId) return { status: 'REVIEW_REQUIRED', reason: 'A persisted lead or company is required.' };
  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('id,name,country,primary_products,total_transactions')
    .eq('id', companyId)
    .eq('dataset_id', datasetId)
    .maybeSingle();
  if (companyError) throw companyError;
  if (!company) return { status: 'REVIEW_REQUIRED', reason: `Company ${companyId} was not found.` };

  const { data: potential, error: potentialError } = await supabase
    .from('company_potential')
    .select('total_score')
    .eq('dataset_id', datasetId)
    .eq('company_id', company.id)
    .maybeSingle();
  if (potentialError) throw potentialError;
  if (!isCurrentlyQualifiedPotential(potential?.total_score, company.total_transactions)) {
    return {
      status: 'REVIEW_REQUIRED',
      reason: 'Personalized email drafting is limited to the current qualification rule: total_score >= 75 and total_transactions >= 10.'
    };
  }

  const products = leadProducts(lead, company);
  if (!products.length) {
    return { status: 'REVIEW_REQUIRED', reason: 'The lead/company record has no product evidence for truthful personalization.' };
  }

  let contactQuery = supabase.from('contacts').select('id,company_id,name,role,email,source,verification_status,confidence,is_suppressed,suppression_reason');
  contactQuery = contactQuery.eq('dataset_id', datasetId);
  if (contactId) contactQuery = contactQuery.eq('id', contactId).eq('company_id', company.id);
  else contactQuery = contactQuery.eq('company_id', company.id).eq('verification_status', 'VERIFIED').eq('is_suppressed', false);
  const { data: contact, error: contactError } = await contactQuery.limit(1).maybeSingle();
  if (contactError) throw contactError;
  if (!contact) {
    const reason = 'Verified contact required before sending. No existing verified business contact is available; contact discovery is not configured.';
    const preview = lead ? buildLeadDraftPreview({ ...lead, company_name: company.name }) : null;
    let persistedPreview = preview;
    if (lead && preview) {
      persistedPreview = { ...preview, status: 'PREVIEW', reason, generatedAt: new Date().toISOString() };
      const { error: previewSaveError } = await supabase
        .from('leads')
        .update({ evidence: { ...(lead.evidence || {}), pitchingEmailPreview: persistedPreview } })
        .eq('id', lead.id)
        .eq('dataset_id', datasetId);
      if (previewSaveError) throw previewSaveError;
    }
    return {
      status: 'REVIEW_REQUIRED',
      reason,
      preview: persistedPreview
    };
  }
  if (contact.verification_status !== 'VERIFIED' || contact.is_suppressed || !isValidOutreachEmail(contact.email)) {
    return { status: 'REVIEW_REQUIRED', reason: 'The selected contact is unverified, suppressed, or has an invalid address.' };
  }
  if (await isEmailGloballySuppressed(contact.email)) {
    return { status: 'REVIEW_REQUIRED', reason: 'This email address is suppressed in the shared workspace and cannot be used for outreach.' };
  }

  const { data: researchRecord, error: researchError } = await supabase.from('web_research')
    .select('provider,source_url,result,researched_at')
    .eq('dataset_id', datasetId)
    .eq('company_id', company.id)
    .order('researched_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (researchError) throw researchError;
  const researchResult = researchRecord?.result && typeof researchRecord.result === 'object' ? researchRecord.result : {};
  const researchEvidence = researchRecord ? {
    provider: researchRecord.provider || null,
    researchedAt: researchRecord.researched_at || null,
    summary: researchResult.summary || researchResult.answer || null,
    sourceUrls: [...new Set([
      researchRecord.source_url,
      ...(Array.isArray(researchResult.sources) ? researchResult.sources.map(source => source?.url) : [])
    ].filter(value => typeof value === 'string' && value.startsWith('https://')))]
  } : null;

  const recipientName = contact.name?.trim() || 'Procurement Team';
  const copy = buildPersonalizedEmailCopy({ companyName: company.name, country: company.country, products, recipientName });
  const { productFocus, subject, bodyText } = copy;
  const evidence = {
    source: lead ? 'LEAD_AND_COMPANY_RECORDS' : 'COMPANY_RECORDS',
    leadId: lead?.id || null,
    potentialId: lead?.evidence?.potentialId || null,
    companyId: company.id,
    companyName: company.name,
    country: company.country || null,
    products,
    contactId: contact.id,
    contactVerificationStatus: contact.verification_status,
    contactSource: contact.source || null,
    researchEvidence,
    researchUsedInBody: false,
    basis: researchEvidence
      ? 'Persisted company/product evidence, public research references for human review, and an existing VERIFIED, unsuppressed contact.'
      : 'Persisted company/product evidence and an existing VERIFIED, unsuppressed contact.'
  };

  if (lead) {
    const { data: priorDrafts, error: priorError } = await supabase
      .from('outreach_emails')
      .select('id,personalization_evidence')
      .eq('company_id', company.id)
      .eq('dataset_id', datasetId)
      .eq('contact_id', contact.id)
      .in('status', ['APPROVAL_REQUIRED', 'APPROVED', 'OPENED_IN_GMAIL', 'MANUALLY_CONFIRMED_SENT', 'SENT', 'REPLIED']);
    if (priorError) throw priorError;
    const prior = (priorDrafts || []).find(row => Number(row.personalization_evidence?.leadId) === Number(lead.id));
    if (prior) return { status: 'EXISTS', draftId: prior.id, reason: 'A persisted outreach record already exists for this lead and contact.' };
  }

  const { data: draft, error: draftError } = await supabase
    .from('outreach_emails')
    .insert({
      dataset_id: datasetId,
      lead_id: lead?.id || null,
      company_id: company.id,
      contact_id: contact.id,
      company_name: company.name,
      contact_name: recipientName,
      recipient_email: contact.email,
      product_focus: productFocus,
      subject,
      body_text: bodyText,
      body_html: `<pre style="font-family: inherit; white-space: pre-wrap;">${htmlEscape(bodyText)}</pre>`,
      personalization_evidence: evidence,
      status: 'APPROVAL_REQUIRED',
      validation_passed: true,
      validation_errors: [],
      created_at: new Date().toISOString()
    })
    .select()
    .single();
  if (draftError) throw draftError;

  const { error: activityError } = await supabase.from('crm_activities').insert({
    dataset_id: datasetId,
    company_id: company.id,
    contact_id: contact.id,
    activity_type: 'EMAIL_GENERATED',
    title: `Evidence-based outreach draft: ${company.name}`,
    description: `Created a human-approval-required draft using persisted product evidence (${productFocus}).`,
    source: 'DATASET',
    metadata: { outreachId: draft.id, leadId: lead?.id || null, contactId: contact.id },
    created_at: new Date().toISOString()
  });
  if (activityError) console.error('Could not record draft activity:', activityError.message);

  return { status: 'COMPLETED', draft, userEmail };
}
