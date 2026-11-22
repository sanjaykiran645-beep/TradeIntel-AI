import assert from 'node:assert/strict';
import {
  startTestAuthServer,
  TEST_ADMIN_TOKEN,
  TEST_ADMIN_USER_ID,
  TEST_USER_TOKEN
} from './_test-auth-server.mjs';

const authEnvKeys = ['SUPABASE_AUTH_URL', 'SUPABASE_AUTH_ANON_KEY', 'ADMIN_SUPABASE_USER_ID', 'EMAIL_SENDING_ENABLED'];
const previousEnv = Object.fromEntries(authEnvKeys.map(key => [key, process.env[key]]));
const authServer = await startTestAuthServer();
Object.assign(process.env, {
  SUPABASE_AUTH_URL: authServer.url,
  SUPABASE_AUTH_ANON_KEY: 'offline-manual-gmail-fallback-test-key',
  ADMIN_SUPABASE_USER_ID: TEST_ADMIN_USER_ID,
  EMAIL_SENDING_ENABLED: 'false'
});

const [
  {
    MANUAL_EMAIL_MODE,
    buildGmailComposeUrl,
    confirmManualGmailSent,
    importManualReply,
    openGmailComposeForOutreach,
    validateManualReplyInput
  },
  { classifyReply, decideInboundSafety, default: inboxHandler },
  { default: emailEngineHandler },
  { default: adminHandler },
  { default: hostingerHandler },
  { default: database }
] = await Promise.all([
  import('../api/_manual-email.js'),
  import('../api/_routes/inbox.js'),
  import('../api/_routes/email-engine.js'),
  import('../api/_routes/admin.js'),
  import('../api/_routes/hostinger.js'),
  import('../api/_db-client.js')
]);

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    json(payload) { this.payload = payload; return this; },
    end() { return this; }
  };
}

let outboundSendAttempts = 0;
const nodemailer = (await import('nodemailer')).default;
const originalCreateTransport = nodemailer.createTransport;
nodemailer.createTransport = () => {
  outboundSendAttempts += 1;
  throw new Error('Unexpected SMTP transport creation during manual Gmail fallback test.');
};

try {
  // -------------------------------------------------------------------------
  // 1. Recipient, Subject, and Body Gmail Compose URL Encoding & Validation
  // -------------------------------------------------------------------------
  {
    const composeUrl = buildGmailComposeUrl({
      to: '  "Procurement Lead" <Buyer+Asia@Example.com> ',
      subject: 'Sourcing inquiry: 100% Pure Resin & Polymer #42?',
      body: 'Dear Team,\r\n\r\nWe noticed 50% growth & $100/mt savings.\r\nBest regards,\r\nVoyage'
    });
    const parsed = new URL(composeUrl);
    assert.equal(parsed.origin + parsed.pathname, 'https://mail.google.com/mail/');
    assert.equal(parsed.searchParams.get('view'), 'cm');
    assert.equal(parsed.searchParams.get('fs'), '1');
    assert.equal(parsed.searchParams.get('to'), 'buyer+asia@example.com');
    assert.equal(parsed.searchParams.get('su'), 'Sourcing inquiry: 100% Pure Resin & Polymer #42?');
    assert.equal(
      parsed.searchParams.get('body'),
      'Dear Team,\n\nWe noticed 50% growth & $100/mt savings.\nBest regards,\nVoyage'
    );

    assert.throws(
      () => buildGmailComposeUrl({ to: 'invalid-email', subject: 'Hello', body: 'World' }),
      err => err.code === 'INVALID_RECIPIENT_EMAIL' && err.status === 400
    );
    assert.throws(
      () => buildGmailComposeUrl({ to: 'buyer@example.com', subject: '   ', body: 'World' }),
      err => err.code === 'MISSING_EMAIL_SUBJECT' && err.status === 400
    );
    assert.throws(
      () => buildGmailComposeUrl({ to: 'buyer@example.com', subject: 'Hello', body: '' }),
      err => err.code === 'MISSING_EMAIL_BODY' && err.status === 400
    );
  }

  // -------------------------------------------------------------------------
  // 2. Admin Authorization Enforcement on Manual Send & Manual Reply Import
  // -------------------------------------------------------------------------
  {
    const originalFrom = database.from;
    const originalQuery = database.query;
    let dbCalls = 0;
    database.from = () => {
      dbCalls += 1;
      throw new Error('Database must not be queried before admin authorization check');
    };
    database.query = () => {
      dbCalls += 1;
      throw new Error('Database must not be queried before admin authorization check');
    };

    try {
      for (const [handler, method, body] of [
        [emailEngineHandler, 'PUT', { id: 1, action: 'OPEN_GMAIL_COMPOSE' }],
        [emailEngineHandler, 'PUT', { id: 1, action: 'CONFIRM_MANUAL_SENT' }],
        [inboxHandler, 'POST', { action: 'IMPORT_MANUAL_REPLY', payload: { senderEmail: 'a@b.com', subject: 'Hi', bodyText: 'Body' } }]
      ]) {
        const unauthRes = responseStub();
        await handler({ method, body, headers: {}, query: {} }, unauthRes);
        assert.equal(unauthRes.statusCode, 401);
        assert.equal(unauthRes.payload?.code, 'AUTHENTICATION_REQUIRED');

        const nonAdminRes = responseStub();
        await handler({ method, body, headers: { authorization: `Bearer ${TEST_USER_TOKEN}` }, query: {} }, nonAdminRes);
        assert.equal(nonAdminRes.statusCode, 403);
        assert.equal(nonAdminRes.payload?.code, 'FORBIDDEN');
      }
      assert.equal(dbCalls, 0, 'Zero DB queries may occur when unauthenticated or non-admin');
    } finally {
      database.from = originalFrom;
      database.query = originalQuery;
    }
  }

  // -------------------------------------------------------------------------
  // 3. Approval, Suppression, Contact Verification, Status Tracking & Duplicate Send Guards
  // -------------------------------------------------------------------------
  {
    const auditEntries = [];
    const stageEntries = [];
    const followUpRows = [];
    const crmRows = [];
    let globallySuppressedEmails = new Set();

    const outreachStore = new Map([
      [101, {
        id: 101,
        dataset_id: 41,
        company_id: 20,
        contact_id: 10,
        company_name: 'Global Polymers GmbH',
        contact_name: 'Hans Meyer',
        recipient_email: 'hans@polymers.invalid',
        product_focus: 'Polyethylene Granules',
        subject: 'Sourcing inquiry: Polyethylene Granules',
        body_text: 'Dear Hans Meyer,\n\nWe saw your activity in Polyethylene Granules.',
        status: 'APPROVAL_REQUIRED',
        validation_passed: true,
        approved_at: null,
        sent_at: null,
        message_id: null,
        personalization_evidence: {},
        contacts: {
          id: 10,
          company_id: 20,
          name: 'Hans Meyer',
          email: 'hans@polymers.invalid',
          verification_status: 'VERIFIED',
          is_suppressed: false
        }
      }]
    ]);

    const mockDb = {
      async query(sql, params) {
        if (String(sql).includes('FROM contacts WHERE lower(email) = $1 AND is_suppressed = true')) {
          return { rows: globallySuppressedEmails.has(String(params[0]).toLowerCase()) ? [{ '?column?': 1 }] : [] };
        }
        return { rows: [] };
      },
      from(table) {
        if (table === 'follow_up_queue') {
          return {
            select() {
              const chain = {
                _outreachId: null,
                _statuses: null,
                eq(col, val) {
                  if (col === 'outreach_id') chain._outreachId = val;
                  if (col === 'status') chain._statuses = [val];
                  return chain;
                },
                in(_col, vals) {
                  chain._statuses = vals;
                  return chain;
                },
                async maybeSingle() {
                  const found = followUpRows.find(
                    r => r.outreach_id === chain._outreachId && (!chain._statuses || chain._statuses.includes(r.status))
                  );
                  return { data: found || null, error: null };
                }
              };
              return chain;
            },
            async insert(row) {
              followUpRows.push({ id: followUpRows.length + 1, ...row });
              return { error: null };
            },
            update(patch) {
              const chain = {
                eq() { return chain; },
                then(resolve) { resolve({ error: null }); }
              };
              void patch;
              return chain;
            }
          };
        }
        if (table === 'outreach_emails') {
          return {
            update(patch) {
              const chain = {
                _id: null,
                _allowedStatuses: null,
                eq(col, val) {
                  if (col === 'id') chain._id = val;
                  return chain;
                },
                in(_col, vals) {
                  chain._allowedStatuses = vals;
                  return chain;
                },
                select() {
                  return {
                    async maybeSingle() {
                      const existing = outreachStore.get(chain._id);
                      if (!existing || (chain._allowedStatuses && !chain._allowedStatuses.includes(existing.status))) {
                        return { data: null, error: null };
                      }
                      const updated = { ...existing, ...patch };
                      outreachStore.set(chain._id, updated);
                      return { data: updated, error: null };
                    }
                  };
                }
              };
              return chain;
            }
          };
        }
        if (table === 'crm_activities') {
          return {
            async insert(row) {
              crmRows.push({ id: crmRows.length + 1, ...row });
              return { error: null };
            }
          };
        }
        throw new Error(`Unexpected table in manual send test: ${table}`);
      }
    };

    const mockAudit = async (actor, action, entity, id, details) => {
      auditEntries.push({ actor, action, entity, id, details });
      return { persisted: true };
    };
    const mockPersistStage = async (stage, status, details, datasetId) => {
      stageEntries.push({ stage, status, details, datasetId });
      return { persisted: true, datasetId };
    };

    // 3a. Unapproved draft (APPROVAL_REQUIRED) is blocked for both compose & confirm
    const unapprovedCompose = await openGmailComposeForOutreach({
      draft: outreachStore.get(101),
      datasetId: 41,
      actorEmail: 'admin@voyageib.com',
      db: mockDb,
      logAuditFn: mockAudit,
      persistStageFn: mockPersistStage
    });
    assert.equal(unapprovedCompose.ok, false);
    assert.equal(unapprovedCompose.statusCode, 400);
    assert.equal(unapprovedCompose.payload.code, 'APPROVAL_REQUIRED_FOR_MANUAL_SEND');

    const unapprovedConfirm = await confirmManualGmailSent({
      draft: outreachStore.get(101),
      datasetId: 41,
      actorEmail: 'admin@voyageib.com',
      db: mockDb,
      logAuditFn: mockAudit,
      persistStageFn: mockPersistStage
    });
    assert.equal(unapprovedConfirm.ok, false);
    assert.equal(unapprovedConfirm.statusCode, 400);
    assert.equal(unapprovedConfirm.payload.code, 'APPROVAL_REQUIRED_FOR_MANUAL_SEND');

    // Approve the draft in memory
    outreachStore.set(101, {
      ...outreachStore.get(101),
      status: 'APPROVED',
      approved_at: '2026-10-22T15:00:00.000Z'
    });

    // 3b. Suppressed contact is blocked
    const suppressedDraft = {
      ...outreachStore.get(101),
      contacts: { ...outreachStore.get(101).contacts, is_suppressed: true }
    };
    const suppressedAttempt = await openGmailComposeForOutreach({
      draft: suppressedDraft,
      datasetId: 41,
      actorEmail: 'admin@voyageib.com',
      db: mockDb,
      logAuditFn: mockAudit,
      persistStageFn: mockPersistStage
    });
    assert.equal(suppressedAttempt.ok, false);
    assert.equal(suppressedAttempt.statusCode, 409);
    assert.equal(suppressedAttempt.payload.code, 'RECIPIENT_SUPPRESSED');

    // 3c. Global workspace suppression is blocked
    globallySuppressedEmails.add('hans@polymers.invalid');
    const globalSuppressedAttempt = await openGmailComposeForOutreach({
      draft: outreachStore.get(101),
      datasetId: 41,
      actorEmail: 'admin@voyageib.com',
      db: mockDb,
      logAuditFn: mockAudit,
      persistStageFn: mockPersistStage
    });
    assert.equal(globalSuppressedAttempt.ok, false);
    assert.equal(globalSuppressedAttempt.statusCode, 409);
    assert.equal(globalSuppressedAttempt.payload.code, 'RECIPIENT_SUPPRESSED');
    globallySuppressedEmails.clear();

    // 3d. Opening Gmail compose sets status to OPENED_IN_GMAIL and NEVER marks as sent
    const openedResult = await openGmailComposeForOutreach({
      draft: outreachStore.get(101),
      datasetId: 41,
      actorEmail: 'admin@voyageib.com',
      db: mockDb,
      logAuditFn: mockAudit,
      persistStageFn: mockPersistStage
    });
    assert.equal(openedResult.ok, true);
    assert.equal(openedResult.statusCode, 200);
    assert.equal(openedResult.payload.status, 'OPENED_IN_GMAIL');
    assert.equal(openedResult.payload.sent, false);
    assert.equal(openedResult.payload.deliveryVerified, false);
    assert.match(openedResult.payload.notice, /does NOT mean the email was sent/i);
    assert.match(openedResult.payload.composeUrl, /^https:\/\/mail\.google\.com\/mail\/\?view=cm&fs=1/);
    assert.equal(outreachStore.get(101).status, 'OPENED_IN_GMAIL');
    assert.equal(outreachStore.get(101).sent_at, null, 'sent_at must remain null when Gmail compose is merely opened');

    // 3e. Manual confirmation step transitions to MANUALLY_CONFIRMED_SENT as an operator assertion
    const confirmedResult = await confirmManualGmailSent({
      draft: outreachStore.get(101),
      datasetId: 41,
      actorEmail: 'admin@voyageib.com',
      operatorNote: 'Sent manually via Gmail web tab',
      db: mockDb,
      logAuditFn: mockAudit,
      persistStageFn: mockPersistStage
    });
    assert.equal(confirmedResult.ok, true);
    assert.equal(confirmedResult.statusCode, 200);
    assert.equal(confirmedResult.payload.status, 'MANUALLY_CONFIRMED_SENT');
    assert.equal(confirmedResult.payload.confirmationType, 'MANUAL_USER_ASSERTION');
    assert.equal(confirmedResult.payload.deliveryVerified, false);
    assert.equal(outreachStore.get(101).status, 'MANUALLY_CONFIRMED_SENT');
    assert.ok(outreachStore.get(101).sent_at, 'sent_at recorded upon manual confirmation');
    assert.equal(
      outreachStore.get(101).personalization_evidence.manualConfirmation.confirmationType,
      'MANUAL_USER_ASSERTION'
    );
    assert.equal(
      outreachStore.get(101).personalization_evidence.manualConfirmation.deliveryVerified,
      false
    );
    assert.equal(followUpRows.length, 1, 'initial follow-up scheduled after manual confirmation');
    assert.equal(crmRows.length, 1, 'CRM activity logged for manual confirmation');
    assert.equal(crmRows[0].activity_type, 'EMAIL_MANUALLY_CONFIRMED_SENT');
    assert.equal(crmRows[0].metadata.deliveryVerified, false);

    // 3f. Duplicate-send protection blocks second confirmation or re-opening in Gmail
    const duplicateConfirm = await confirmManualGmailSent({
      draft: outreachStore.get(101),
      datasetId: 41,
      actorEmail: 'admin@voyageib.com',
      db: mockDb,
      logAuditFn: mockAudit,
      persistStageFn: mockPersistStage
    });
    assert.equal(duplicateConfirm.ok, false);
    assert.equal(duplicateConfirm.statusCode, 409);
    assert.equal(duplicateConfirm.payload.code, 'DUPLICATE_SEND_BLOCKED');

    const duplicateOpen = await openGmailComposeForOutreach({
      draft: outreachStore.get(101),
      datasetId: 41,
      actorEmail: 'admin@voyageib.com',
      db: mockDb,
      logAuditFn: mockAudit,
      persistStageFn: mockPersistStage
    });
    assert.equal(duplicateOpen.ok, false);
    assert.equal(duplicateOpen.statusCode, 409);
    assert.equal(duplicateOpen.payload.code, 'DUPLICATE_SEND_BLOCKED');
  }

  // -------------------------------------------------------------------------
  // 4. Manual Reply Import: Validation, Ambiguous Match Selection, Deduplication,
  //    AI Classification, Unsubscribe Suppression, Lead & CRM History Creation
  // -------------------------------------------------------------------------
  {
    assert.throws(
      () => validateManualReplyInput({ senderEmail: 'not-an-email', subject: 'Re: Hi', bodyText: 'Hello' }),
      err => err.code === 'INVALID_SENDER_EMAIL'
    );
    assert.throws(
      () => validateManualReplyInput({ senderEmail: 'buyer@acme.com', subject: '', bodyText: 'Hello' }),
      err => err.code === 'MISSING_REPLY_SUBJECT'
    );
    assert.throws(
      () => validateManualReplyInput({ senderEmail: 'buyer@acme.com', subject: 'Re: Hi', bodyText: '   ' }),
      err => err.code === 'MISSING_REPLY_BODY'
    );
    assert.throws(
      () => validateManualReplyInput({ senderEmail: 'buyer@acme.com', subject: 'Re: Hi', bodyText: 'Hello', receivedAt: 'invalid-date' }),
      err => err.code === 'INVALID_RECEIVED_DATE'
    );

    const contacts = [
      {
        id: 10,
        dataset_id: 41,
        company_id: 20,
        name: 'Hans Meyer',
        email: 'hans@polymers.invalid',
        is_suppressed: false,
        verification_status: 'VERIFIED'
      },
      {
        id: 11,
        dataset_id: 41,
        company_id: 21,
        name: 'Clara Optout',
        email: 'clara@chem.invalid',
        is_suppressed: false,
        verification_status: 'VERIFIED'
      }
    ];

    // Two distinct confirmed outreach threads to the same recipient (Hans Meyer) with different product subjects
    const outreachRows = [
      {
        id: 201,
        dataset_id: 41,
        lead_id: 301,
        company_id: 20,
        contact_id: 10,
        company_name: 'Global Polymers GmbH',
        contact_name: 'Hans Meyer',
        recipient_email: 'hans@polymers.invalid',
        product_focus: 'Polyethylene Granules',
        subject: 'Sourcing inquiry: Polyethylene Granules',
        status: 'MANUALLY_CONFIRMED_SENT',
        sent_at: '2026-10-20T10:00:00.000Z',
        personalization_evidence: {}
      },
      {
        id: 202,
        dataset_id: 41,
        lead_id: 302,
        company_id: 20,
        contact_id: 10,
        company_name: 'Global Polymers GmbH',
        contact_name: 'Hans Meyer',
        recipient_email: 'hans@polymers.invalid',
        product_focus: 'PVC Resin SG5',
        subject: 'Sourcing inquiry: PVC Resin SG5',
        status: 'MANUALLY_CONFIRMED_SENT',
        sent_at: '2026-10-21T10:00:00.000Z',
        personalization_evidence: {}
      },
      {
        id: 203,
        dataset_id: 41,
        lead_id: 303,
        company_id: 21,
        contact_id: 11,
        company_name: 'ChemWorks AG',
        contact_name: 'Clara Optout',
        recipient_email: 'clara@chem.invalid',
        product_focus: 'Caustic Soda Flakes',
        subject: 'Sourcing inquiry: Caustic Soda Flakes',
        status: 'MANUALLY_CONFIRMED_SENT',
        sent_at: '2026-10-21T12:00:00.000Z',
        personalization_evidence: {}
      }
    ];

    const inboxRows = [];
    const leadRows = [];
    const crmRows = [];
    const stoppedFollowUps = [];

    const mockReplyDb = {
      async query(sql, params) {
        if (String(sql).includes('UPDATE contacts') && String(sql).includes('is_suppressed = true')) {
          const targetEmail = String(params[0]).toLowerCase();
          const c = contacts.find(item => item.email === targetEmail);
          if (c) c.is_suppressed = true;
        }
        return { rows: [] };
      },
      from(table) {
        if (table === 'inbox_messages') {
          return {
            select() {
              const chain = {
                _messageId: null,
                _senderEmail: null,
                eq(col, val) {
                  if (col === 'message_id') chain._messageId = val;
                  if (col === 'sender_email') chain._senderEmail = String(val).toLowerCase();
                  return chain;
                },
                async maybeSingle() {
                  return {
                    data: inboxRows.find(r => r.message_id === chain._messageId) || null,
                    error: null
                  };
                },
                then(resolve) {
                  const matches = inboxRows.filter(r => r.sender_email === chain._senderEmail);
                  resolve({ data: matches, error: null });
                }
              };
              return chain;
            },
            insert(row) {
              const saved = { id: inboxRows.length + 1, ...row };
              inboxRows.push(saved);
              return {
                select() {
                  return {
                    async single() {
                      return { data: saved, error: null };
                    }
                  };
                }
              };
            }
          };
        }
        if (table === 'contacts') {
          return {
            select() {
              const chain = {
                _email: null,
                eq(col, val) {
                  if (col === 'email') chain._email = String(val).toLowerCase();
                  return chain;
                },
                then(resolve) {
                  resolve({
                    data: contacts.filter(c => c.email === chain._email),
                    error: null
                  });
                }
              };
              return chain;
            }
          };
        }
        if (table === 'outreach_emails') {
          return {
            select() {
              const chain = {
                eq() { return chain; },
                in() { return chain; },
                order() { return chain; },
                async limit() {
                  return { data: outreachRows, error: null };
                }
              };
              return chain;
            },
            update(patch) {
              const chain = {
                _id: null,
                eq(col, val) {
                  if (col === 'id') chain._id = val;
                  const row = outreachRows.find(r => r.id === chain._id);
                  if (row && patch) Object.assign(row, patch);
                  return chain;
                },
                in() { return chain; },
                then(resolve) { resolve({ error: null }); }
              };
              return chain;
            }
          };
        }
        if (table === 'follow_up_queue') {
          return {
            update(patch) {
              const chain = {
                _outreachId: null,
                eq(col, val) {
                  if (col === 'outreach_id') chain._outreachId = val;
                  return chain;
                },
                in() {
                  stoppedFollowUps.push({ outreachId: chain._outreachId, ...patch });
                  return Promise.resolve({ error: null });
                }
              };
              return chain;
            }
          };
        }
        if (table === 'companies') {
          return {
            select() {
              const chain = {
                eq() { return chain; },
                async maybeSingle() {
                  return { data: { name: 'Global Polymers GmbH' }, error: null };
                }
              };
              return chain;
            }
          };
        }
        if (table === 'company_potential') {
          return {
            select() {
              const chain = {
                eq() { return chain; },
                async maybeSingle() {
                  return { data: { total_score: 88 }, error: null };
                }
              };
              return chain;
            }
          };
        }
        if (table === 'leads') {
          return {
            async insert(row) {
              leadRows.push({ id: leadRows.length + 1, ...row });
              return { error: null };
            }
          };
        }
        if (table === 'crm_activities') {
          return {
            async insert(row) {
              crmRows.push({ id: crmRows.length + 1, ...row });
              return { error: null };
            }
          };
        }
        throw new Error(`Unexpected table in manual reply import test: ${table}`);
      }
    };

    const mockStopFollowUps = async (email, status, reason) => {
      stoppedFollowUps.push({ email, status, reason });
    };

    // 4a. Ambiguous reply matching: Hans replies with a generic subject ("Pricing & availability")
    //     when 2 outreach threads (201 and 202) were sent to Hans. Must return 409 AMBIGUOUS_OUTREACH_MATCH!
    const ambiguousReply = await importManualReply({
      payload: {
        senderEmail: 'hans@polymers.invalid',
        senderName: 'Hans Meyer',
        subject: 'Re: Pricing & availability for Q4',
        bodyText: 'Please share your CIF Hamburg price quote for 40 metric tons next week.',
        receivedAt: '2026-10-22T12:00:00.000Z'
      },
      datasetId: 41,
      actorEmail: 'admin@voyageib.com',
      classifyReplyFn: classifyReply,
      decideInboundSafetyFn: decideInboundSafety,
      stopEmailFollowUpsFn: mockStopFollowUps,
      db: mockReplyDb,
      logAuditFn: async () => ({ persisted: true }),
      persistStageFn: async () => ({ persisted: true, datasetId: 41 })
    });

    assert.equal(ambiguousReply.ok, false);
    assert.equal(ambiguousReply.statusCode, 409);
    assert.equal(ambiguousReply.payload.code, 'AMBIGUOUS_OUTREACH_MATCH');
    assert.equal(ambiguousReply.payload.candidates.length, 2);
    assert.deepEqual(
      ambiguousReply.payload.candidates.map(c => c.outreachId),
      [201, 202]
    );
    assert.equal(inboxRows.length, 0, 'Ambiguous match must not insert inbox message before operator selection');

    // 4b. Operator selects outreach #202 and resubmits -> succeeds, marks #202 REPLIED, stops follow-ups, creates lead & CRM activity
    const resolvedReply = await importManualReply({
      payload: {
        senderEmail: 'hans@polymers.invalid',
        senderName: 'Hans Meyer',
        subject: 'Re: Pricing & availability for Q4',
        bodyText: 'Please share your CIF Hamburg price quote for 40 metric tons next week.',
        receivedAt: '2026-10-22T12:00:00.000Z',
        selectedOutreachId: 202
      },
      datasetId: 41,
      actorEmail: 'admin@voyageib.com',
      classifyReplyFn: classifyReply,
      decideInboundSafetyFn: decideInboundSafety,
      stopEmailFollowUpsFn: mockStopFollowUps,
      db: mockReplyDb,
      logAuditFn: async () => ({ persisted: true }),
      persistStageFn: async () => ({ persisted: true, datasetId: 41 })
    });

    assert.equal(resolvedReply.ok, true);
    assert.equal(resolvedReply.statusCode, 201);
    assert.equal(resolvedReply.payload.intent, 'QUOTE_REQUEST');
    assert.equal(resolvedReply.payload.associatedOutreachId, 202);
    assert.equal(resolvedReply.payload.extractedEntities.quantity, '40 metric tons');
    assert.equal(resolvedReply.payload.extractedEntities.timeline, 'next week');
    assert.equal(resolvedReply.payload.leadCreated, true);
    assert.equal(outreachRows.find(r => r.id === 202).status, 'REPLIED');
    assert.equal(outreachRows.find(r => r.id === 201).status, 'MANUALLY_CONFIRMED_SENT');
    assert.equal(leadRows.length, 1);
    assert.equal(leadRows[0].evidence.source, 'MANUAL_GMAIL_REPLY_IMPORT');
    assert.equal(crmRows.length, 1);
    assert.equal(crmRows[0].activity_type, 'REPLY_RECEIVED');

    // 4c. Duplicate reply import detection (identical sender, normalized subject, and body)
    const duplicateImport = await importManualReply({
      payload: {
        senderEmail: 'hans@polymers.invalid',
        senderName: 'Hans Meyer',
        subject: 'FW: Re: Pricing & availability for Q4',
        bodyText: 'Please share your CIF Hamburg price quote   for 40 metric tons next week.',
        receivedAt: '2026-10-22T12:05:00.000Z',
        selectedOutreachId: 202
      },
      datasetId: 41,
      actorEmail: 'admin@voyageib.com',
      classifyReplyFn: classifyReply,
      decideInboundSafetyFn: decideInboundSafety,
      stopEmailFollowUpsFn: mockStopFollowUps,
      db: mockReplyDb,
      logAuditFn: async () => ({ persisted: true }),
      persistStageFn: async () => ({ persisted: true, datasetId: 41 })
    });

    assert.equal(duplicateImport.ok, false);
    assert.equal(duplicateImport.statusCode, 409);
    assert.equal(duplicateImport.payload.code, 'DUPLICATE_REPLY_IMPORT');
    assert.equal(inboxRows.length, 1, 'Duplicate reply must not create a second inbox row');

    // 4d. Unsubscribe reply import suppresses contact and stops follow-ups
    const unsubscribeImport = await importManualReply({
      payload: {
        senderEmail: 'clara@chem.invalid',
        senderName: 'Clara Optout',
        subject: 'Re: Sourcing inquiry: Caustic Soda Flakes',
        bodyText: 'Please unsubscribe me and remove me from your mailing list.',
        receivedAt: '2026-10-22T13:00:00.000Z'
      },
      datasetId: 41,
      actorEmail: 'admin@voyageib.com',
      classifyReplyFn: classifyReply,
      decideInboundSafetyFn: decideInboundSafety,
      stopEmailFollowUpsFn: mockStopFollowUps,
      db: mockReplyDb,
      logAuditFn: async () => ({ persisted: true }),
      persistStageFn: async () => ({ persisted: true, datasetId: 41 })
    });

    assert.equal(unsubscribeImport.ok, true);
    assert.equal(unsubscribeImport.statusCode, 201);
    assert.equal(unsubscribeImport.payload.intent, 'UNSUBSCRIBE');
    assert.equal(unsubscribeImport.payload.unsubscribe, true);
    assert.equal(contacts.find(c => c.email === 'clara@chem.invalid').is_suppressed, true);
    assert.ok(stoppedFollowUps.some(s => s.status === 'STOPPED_UNSUBSCRIBED'));
  }

  // -------------------------------------------------------------------------
  // 5. Verify Admin & Hostinger Endpoints Report MANUAL GMAIL MODE and No Outbound Sends
  // -------------------------------------------------------------------------
  {
    const originalFrom = database.from;
    database.from = table => {
      if (table === 'system_settings') {
        return {
          select() {
            const chain = {
              eq() {
                return {
                  async maybeSingle() { return { data: null, error: null }; }
                };
              },
              then(resolve) { resolve({ data: [], error: null }); }
            };
            return chain;
          }
        };
      }
      if (table === 'datasets') {
        return {
          select() {
            const chain = {
              eq() { return chain; },
              order() { return chain; },
              limit() { return chain; },
              async maybeSingle() { return { data: null, error: null }; }
            };
            return chain;
          }
        };
      }
      throw new Error(`Unexpected table in admin mode check: ${table}`);
    };

    try {
      const adminRes = responseStub();
      await adminHandler({
        method: 'GET',
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
        query: {}
      }, adminRes);
      assert.equal(adminRes.statusCode, 200);
      assert.equal(adminRes.payload?.emailMode, MANUAL_EMAIL_MODE);
      assert.equal(adminRes.payload?.manualGmailMode, true);
      assert.equal(adminRes.payload?.automaticEmailSendingEnabled, false);

      const hostingerRes = responseStub();
      await hostingerHandler({
        method: 'GET',
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
        query: {}
      }, hostingerRes);
      assert.equal(hostingerRes.statusCode, 200);
      assert.equal(hostingerRes.payload?.emailMode, MANUAL_EMAIL_MODE);
      assert.equal(hostingerRes.payload?.manualGmailMode, true);
      assert.equal(hostingerRes.payload?.emailSendingEnabled, false);
    } finally {
      database.from = originalFrom;
    }
  }

  assert.equal(outboundSendAttempts, 0, 'Zero outbound email sends may occur during tests');
  console.log('All manual Gmail compose, manual send confirmation, and manual reply import tests passed.');
} finally {
  nodemailer.createTransport = originalCreateTransport;
  await authServer.close();
  for (const [k, v] of Object.entries(previousEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
