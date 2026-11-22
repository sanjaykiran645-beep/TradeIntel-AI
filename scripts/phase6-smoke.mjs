process.env.NODE_ENV = 'development';

import { startTestAuthServer, TEST_ADMIN_TOKEN } from './_test-auth-server.mjs';

const authServer = await startTestAuthServer();
process.env.SUPABASE_AUTH_URL = authServer.url;
process.env.SUPABASE_AUTH_ANON_KEY = 'offline-phase6-test-anon-key';

const [
  { default: research },
  { default: contacts },
  { default: emailEngine },
  { default: hostinger },
  { default: inbox },
  { default: supabase, dbConfigured },
  { getProviderCapabilities },
  { approvalBlocker, followUpStatusAfterDraft, smtpAcceptedByServer, isValidOutreachEmail, suppressionUpdateBlocker },
  { classifyReply, decideInboundSafety }
] = await Promise.all([
  import('../api/_routes/research.js'),
  import('../api/_routes/contacts.js'),
  import('../api/_routes/email-engine.js'),
  import('../api/_routes/hostinger.js'),
  import('../api/_routes/inbox.js'),
  import('../api/_db-client.js'),
  import('../api/_provider-capabilities.js'),
  import('../api/_outreach-guards.js'),
  import('../api/_routes/inbox.js')
]);

if (!dbConfigured || !supabase) throw new Error('Supabase server configuration is missing. Load .env.vercel.local before running this smoke test.');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; },
    end() { return this; }
  };
}

async function invoke(handler, method = 'GET', body = {}, query = {}) {
  const res = responseStub();
  await handler({ method, body, query, headers: { authorization: 'Bearer ' + TEST_ADMIN_TOKEN } }, res);
  return res;
}

async function count(table, filter) {
  let query = supabase.from(table).select('id', { count: 'exact', head: true });
  if (filter) query = query.eq(filter[0], filter[1]);
  const { count: total, error } = await query;
  if (error) throw error;
  return total || 0;
}

const [{ data: lead, error: leadError }, { data: dataset, error: datasetError }] = await Promise.all([
  supabase.from('leads').select('id,company_id,company_name,product_requirement,evidence').eq('intent_type', 'COMPANY_POTENTIAL').order('id', { ascending: true }).limit(1).maybeSingle(),
  supabase.from('datasets').select('id,detected_entities').eq('id', 9).maybeSingle()
]);
if (leadError) throw leadError;
if (datasetError) throw datasetError;
if (!lead) throw new Error('No persisted company-potential lead is available for the draft test.');
if (!dataset) throw new Error('Dataset 9 is missing.');

const before = {
  research: await count('web_research'),
  contacts: await count('contacts'),
  inbox: await count('inbox_messages'),
  sent: await count('outreach_emails', ['status', 'SENT'])
};

const providers = await getProviderCapabilities();
assert(!providers.research.implemented && !providers.research.configured, 'A research provider must not be reported as available.');
assert(!providers.contactDiscovery.implemented && !providers.contactDiscovery.configured, 'A contact discovery provider must not be reported as available.');
assert(!providers.smtp.configured && !providers.imap.configured, 'Hostinger credentials unexpectedly appear configured for this no-send test.');

const researchResult = await invoke(research, 'POST', { companyId: lead.company_id });
assert(researchResult.statusCode === 503 && researchResult.body?.status === 'BLOCKED', 'Research provider gate did not block the request.');

const contactResult = await invoke(contacts, 'POST', {});
assert(contactResult.statusCode === 503 && contactResult.body?.code === 'CONTACT_PROVIDER_NOT_CONFIGURED', 'Contact discovery gate did not block contact creation.');
const contactVerificationResult = await invoke(contacts, 'PUT', { id: -987654321, action: 'VERIFY' });
assert(contactVerificationResult.statusCode === 404, 'Contact verification must require an existing persisted contact.');
assert(!isValidOutreachEmail(null) && !isValidOutreachEmail(''), 'Missing email values must fail recipient validation.');
assert(Boolean(suppressionUpdateBlocker(false)), 'Suppression cannot be cleared through the contact endpoint.');

const draftResult = await invoke(emailEngine, 'POST', { leadId: lead.id });
assert([200, 201, 409].includes(draftResult.statusCode), `Email draft endpoint returned HTTP ${draftResult.statusCode}.`);
assert(draftResult.body?.status !== 'SENT', 'Draft generation must never report an email as sent.');
if (draftResult.body?.preview) {
  const preview = draftResult.body.preview;
  assert(preview.sendable === false && preview.recipientEmail === null && preview.recipientAssigned === false, 'Addressless preview must remain non-sendable.');
  assert(preview.bodyText.includes(lead.company_name), 'Personalized preview must include the persisted lead company.');
  const products = lead.evidence?.companyEvidence?.products || String(lead.product_requirement || '').split(',').map(value => value.trim()).filter(Boolean);
  assert(products.some(product => preview.bodyText.includes(product)), 'Personalized preview must use persisted product evidence.');
} else {
  assert(draftResult.body?.status === 'APPROVAL_REQUIRED' && draftResult.body?.validation_passed === true, 'A sendable draft must be persisted as approval-required.');
  assert(Boolean(draftResult.body?.recipient_email) && draftResult.body?.personalization_evidence?.leadId === lead.id, 'A sendable draft must use a verified persisted recipient and the tested lead.');
}

const approvalFixtureBlocker = approvalBlocker({
  status: 'APPROVAL_REQUIRED',
  validation_passed: true,
  recipient_email: null,
  contacts: { verification_status: 'UNVERIFIED', is_suppressed: false, email: null }
});
assert(Boolean(approvalFixtureBlocker), 'Approval guard accepted a draft without a verified recipient.');
const approvalResult = await invoke(emailEngine, 'PUT', { id: -987654321, action: 'APPROVE' });
assert(approvalResult.statusCode === 404, 'Approval route must reject an absent persisted draft.');

const smtpDiagnostics = await invoke(hostinger, 'GET');
assert(smtpDiagnostics.statusCode === 200 && smtpDiagnostics.body?.smtpStatus === 'NOT CONFIGURED', 'SMTP diagnostics did not report the missing provider gate.');
assert(smtpDiagnostics.body?.imapStatus === 'NOT CONFIGURED', 'IMAP diagnostics did not report the missing provider gate.');
const smtpSendGate = await invoke(hostinger, 'POST', {});
assert(smtpSendGate.statusCode === 400 && smtpSendGate.body?.status === 'BLOCKED', 'SMTP send endpoint must fail closed without credentials.');

const imapSyncGate = await invoke(inbox, 'POST', {});
assert(imapSyncGate.statusCode === 503 && imapSyncGate.body?.status === 'BLOCKED', 'IMAP inbox sync must fail closed without credentials.');
const syntheticInjectionGate = await invoke(inbox, 'POST', { manualReply: true });
assert(syntheticInjectionGate.statusCode === 409 && syntheticInjectionGate.body?.code === 'MANUAL_REPLY_DISABLED', 'Manual reply injection must remain disabled.');
// Re-assert the missing-IMAP gate last so the persisted stage records current config, not the rejected synthetic request.
const finalImapSyncGate = await invoke(inbox, 'POST', {});
assert(finalImapSyncGate.statusCode === 503 && finalImapSyncGate.body?.status === 'BLOCKED', 'Final IMAP configuration gate did not remain blocked.');

// Non-production in-memory fixture only. It is never passed to IMAP or persisted.
const unsubscribeIntent = classifyReply('', 'Please unsubscribe me.');
const unsubscribeDecision = decideInboundSafety({ intent: unsubscribeIntent, contact: { is_suppressed: false }, outreach: null });
assert(unsubscribeDecision.suppressContact && unsubscribeDecision.stopFollowUps, 'Unsubscribe safety decision must suppress and stop future follow-ups.');
const genuineReplyDecision = decideInboundSafety({ intent: 'PRICE_REQUEST', contact: { is_suppressed: false }, outreach: { id: 1 } });
assert(genuineReplyDecision.genuineReply && genuineReplyDecision.stopFollowUps, 'A matched genuine reply must stop follow-ups.');

const smtpAcceptanceFixture = smtpAcceptedByServer(null, null);
assert(!smtpAcceptanceFixture, 'An absent SMTP response must never be treated as server acceptance.');
assert(followUpStatusAfterDraft({ draftCreated: true }) === 'DRAFTED', 'Follow-up draft creation must only produce DRAFTED.');
assert(followUpStatusAfterDraft({ draftCreated: true, smtpAccepted: smtpAcceptanceFixture }) === 'DRAFTED', 'Follow-up must not transition to SENT without actual SMTP acceptance.');

const after = {
  research: await count('web_research'),
  contacts: await count('contacts'),
  inbox: await count('inbox_messages'),
  sent: await count('outreach_emails', ['status', 'SENT'])
};
assert(before.research === after.research, 'Research gate created a result without a provider.');
assert(before.contacts === after.contacts, 'Contact gate created a contact without a provider.');
assert(before.inbox === after.inbox, 'Reply fixtures must not create persisted mailbox messages.');
assert(before.sent === after.sent, 'No real email may be sent during development testing.');

const { data: savedDataset, error: savedDatasetError } = await supabase.from('datasets').select('detected_entities').eq('id', dataset.id).single();
if (savedDatasetError) throw savedDatasetError;
const stages = savedDataset.detected_entities?.pipeline?.stages || {};
assert(stages.RESEARCH?.status === 'BLOCKED', 'Research blocker was not persisted in the dataset pipeline state.');
assert(stages.CONTACT_DISCOVERY?.status === 'BLOCKED', 'Contact blocker was not persisted in the dataset pipeline state.');
assert(stages.HUMAN_APPROVAL?.status === 'BLOCKED', 'Approval blocker was not persisted in the dataset pipeline state.');
assert(stages.SMTP?.status === 'BLOCKED', 'SMTP blocker was not persisted in the dataset pipeline state.');
assert(stages.INBOX?.status === 'BLOCKED', 'IMAP blocker was not persisted in the dataset pipeline state.');
for (const stage of ['RESEARCH', 'CONTACT_DISCOVERY', 'EMAIL_DRAFT', 'HUMAN_APPROVAL', 'SMTP', 'INBOX']) {
  assert(stages[stage]?.startedAt && stages[stage]?.updatedAt && stages[stage]?.completedAt, `${stage} stage timestamps were not persisted.`);
  assert(stages[stage]?.reason || stages[stage]?.error, `${stage} stage reason/error was not persisted.`);
  assert(stages[stage]?.evidence, `${stage} stage evidence was not persisted.`);
}
assert(stages.FOLLOW_UP?.startedAt && stages.FOLLOW_UP?.updatedAt && stages.FOLLOW_UP?.completedAt, 'Follow-up stage timestamps from the persisted pipeline are missing.');

console.log(JSON.stringify({
  providers: {
    research: providers.research,
    contactDiscovery: providers.contactDiscovery,
    smtp: { provider: providers.smtp.provider, configured: providers.smtp.configured },
    imap: { provider: providers.imap.provider, configured: providers.imap.configured }
  },
  executed: {
    researchGate: { httpStatus: researchResult.statusCode, status: researchResult.body.status, persistence: researchResult.body.persistence },
    contactGate: { httpStatus: contactResult.statusCode, status: contactResult.body.status, persistence: contactResult.body.persistence },
    contactVerification: { httpStatus: contactVerificationResult.statusCode, nonexistentContactRejected: true, emptyAddressRejected: true, suppressionCannotBeCleared: true },
    emailDraft: { httpStatus: draftResult.statusCode, status: draftResult.body.status || draftResult.body.status, preview: Boolean(draftResult.body.preview), sendable: draftResult.body.preview?.sendable ?? Boolean(draftResult.body.recipient_email) },
    approvalGate: { httpStatus: approvalResult.statusCode, blockedWithoutPersistedDraft: true },
    smtpDryRun: { diagnostics: smtpDiagnostics.body.smtpStatus, sendGate: smtpSendGate.body.status, outboundSendCountBeforeAfter: [before.sent, after.sent] },
    imapConnectivity: { configured: false, status: finalImapSyncGate.body.status },
    replySuppressionUnitFixture: { unsubscribeStops: unsubscribeDecision.stopFollowUps, replyStops: genuineReplyDecision.stopFollowUps, persistedMessages: false },
    followUpTransition: { afterDraft: followUpStatusAfterDraft({ draftCreated: true }), afterDraftWithoutSmtpAcceptance: followUpStatusAfterDraft({ draftCreated: true, smtpAccepted: false }) }
  },
  persistedStages: Object.fromEntries(['RESEARCH', 'CONTACT_DISCOVERY', 'EMAIL_DRAFT', 'HUMAN_APPROVAL', 'SMTP', 'INBOX', 'FOLLOW_UP'].map(stage => [stage, {
    status: stages[stage]?.status || null,
    startedAt: stages[stage]?.startedAt || null,
    updatedAt: stages[stage]?.updatedAt || null,
    blocker: stages[stage]?.blocker || null
  }])),
  recordCountsBeforeAfter: { research: [before.research, after.research], contacts: [before.contacts, after.contacts], inbox: [before.inbox, after.inbox], sent: [before.sent, after.sent] }
}));
await authServer.close();
