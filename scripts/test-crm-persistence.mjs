import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestAuthServer, TEST_ADMIN_TOKEN, TEST_ADMIN_USER_ID } from './_test-auth-server.mjs';

process.loadEnvFile('.env.test.local');
const expectedHost = 'ep-hidden-wind-b4x5ff13-pooler.c-6.us-east-2.aws.neon.tech';
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== expectedHost || process.env.NEON_BRANCH !== 'tradeintel-test') {
  console.error('REFUSED: Not test branch');
  process.exit(1);
}

async function runCrmTest() {
  const authServer = await startTestAuthServer();
  process.env.SUPABASE_AUTH_URL = authServer.url;
  process.env.SUPABASE_AUTH_ANON_KEY = 'test-anon-key';
  process.env.ADMIN_SUPABASE_USER_ID = TEST_ADMIN_USER_ID;

  const { default: db } = await import('../api/_db-client.js');
  const { default: crmHandler } = await import('../api/_routes/crm.js');

  const tag = randomUUID();

  // 1. Create a synthetic dataset row
  const dsRes = await db.from('datasets').insert({
    filename: 'synthetic-crm-test-' + tag + '.csv',
    file_type: 'csv',
    status: 'IMPORTED',
    import_status: 'COMPLETED'
  }).select('id').single();

  const datasetId = dsRes.data.id;
  console.log('Created synthetic dataset for CRM verification, id:', datasetId);

  try {
    // 2. Invoke CRM POST handler
    const postReq = {
      method: 'POST',
      body: {
        title: 'Lead Follow-up Note',
        description: 'Client confirmed receipt of sample request.',
        activity_type: 'NOTE_ADDED',
        source: 'USER_PROVIDED',
        metadata: { tag }
      },
      query: { dataset_id: String(datasetId) },
      headers: { authorization: 'Bearer ' + TEST_ADMIN_TOKEN }
    };
    let postStatusCode = 200;
    let postData = null;
    const postRes = {
      setHeader() { return this; },
      status(c) { postStatusCode = c; return this; },
      json(d) { postData = d; return this; }
    };

    await crmHandler(postReq, postRes);
    console.log('CRM POST status:', postStatusCode, 'created id:', postData?.id);
    assert.equal(postStatusCode, 201, 'CRM POST failed');
    assert.ok(postData?.id, 'No activity ID returned');

    // 3. Invoke CRM GET handler
    const getReq = {
      method: 'GET',
      query: { dataset_id: String(datasetId) },
      headers: { authorization: 'Bearer ' + TEST_ADMIN_TOKEN }
    };
    let getStatusCode = 200;
    let getData = null;
    const getRes = {
      setHeader() { return this; },
      status(c) { getStatusCode = c; return this; },
      json(d) { getData = d; return this; }
    };
    await crmHandler(getReq, getRes);
    console.log('CRM GET status:', getStatusCode, 'records count:', getData?.length);
    assert.equal(getStatusCode, 200, 'CRM GET failed');
    assert.equal(getData?.length, 1, 'Expected 1 CRM record');
    assert.equal(getData[0].title, 'Lead Follow-up Note');

    console.log('CRM_DATABASE_PERSISTENCE_TEST: REAL PASS');
  } finally {
    // Cleanup synthetic records
    await db.from('crm_activities').delete().eq('dataset_id', datasetId);
    await db.from('datasets').delete().eq('id', datasetId);
    console.log('Cleaned up synthetic test records.');
    await db.close();
    await authServer.close();
  }
}

runCrmTest().catch(err => {
  console.error('CRM test error:', err);
  process.exit(1);
});
