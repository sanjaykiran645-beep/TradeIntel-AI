import assert from 'node:assert/strict';
import { buildResearchQuery, classifyResearchProviderResult } from '../api/_research-provider.js';
import { asList, asPage, describeApiError, toResearchView } from '../src/lib/api-data.js';

console.log('--- 1. Testing buildResearchQuery & Research Contract ---');
const q1 = buildResearchQuery({ name: 'Acme International Exports Ltd', country: 'India' });
assert.equal(q1, '"Acme International Exports Ltd" India company official website products');

const q2 = buildResearchQuery({ name: 'Global Solvents B.V.', country: '' });
assert.equal(q2, '"Global Solvents B.V." company official website products');

const qEmpty = buildResearchQuery({});
assert.equal(qEmpty, '');

const classified = classifyResearchProviderResult({
  answer: 'Leading exporter of industrial grade chemicals.',
  score: 0.94,
  sources: [
    { url: 'https://example.com/company', title: 'Official Site', snippet: 'About us snippet' }
  ]
});
assert.equal(classified.status, 'COMPLETED');
assert.equal(classified.sources.length, 1);
assert.equal(classified.sources[0].url, 'https://example.com/company');
assert.equal(classified.confidence, 0.94);
console.log('✓ buildResearchQuery and Tavily classification contract verified.');

console.log('--- 2. Testing toResearchView & describeApiError ---');
const rViewJson = toResearchView({
  company_id: 101,
  result: {
    status: 'COMPLETED',
    summary: 'Export specialist in Europe.',
    confidence: 0.88,
    query: '"EuroTrade" Germany company official website products',
    sources: [{ url: 'https://eurotrade.de', title: 'EuroTrade Home' }]
  }
});
assert.equal(rViewJson.present, true);
assert.equal(rViewJson.status, 'COMPLETED');
assert.equal(rViewJson.summary, 'Export specialist in Europe.');
assert.equal(rViewJson.confidence, 0.88);
assert.equal(rViewJson.sources[0].url, 'https://eurotrade.de');

const rViewLegacy = toResearchView({
  company_id: 102,
  verification_status: 'VERIFIED',
  business_summary: 'Legacy summary text',
  official_website: 'https://legacy.com',
  source_url: 'https://legacy.com/about'
});
assert.equal(rViewLegacy.present, true);
assert.equal(rViewLegacy.summary, 'Legacy summary text');
assert.equal(rViewLegacy.officialWebsite, 'https://legacy.com');

const rViewEmpty = toResearchView(null);
assert.equal(rViewEmpty.present, false);
assert.equal(rViewEmpty.status, 'NOT_RESEARCHED');

// Test 409 safeguard error description
const err409 = new Error('API POST /api/email-engine failed with HTTP 409.');
err409.status = 409;
err409.payload = {
  success: false,
  status: 'REVIEW_REQUIRED',
  error: 'A verified contact is required before sending; previews are not sendable.',
  reason: 'A verified contact is required before sending; previews are not sendable.',
  code: 'DRAFT_REVIEW_REQUIRED',
  preview: { subject: 'Partnership Inquiry', body: 'Dear Team...' }
};

const desc = describeApiError(err409);
assert.equal(desc.kind, 'SAFEGUARD');
assert.equal(desc.status, 409);
assert.match(desc.text, /A verified contact is required/);
assert.equal(desc.preview.subject, 'Partnership Inquiry');
console.log('✓ toResearchView and describeApiError contracts verified.');

console.log('--- 3. Testing asList and asPage contracts ---');
assert.deepEqual(asList([1, 2, 3]), [1, 2, 3]);
assert.deepEqual(asList({ data: ['a', 'b'] }), ['a', 'b']);
assert.deepEqual(asList(null), []);
assert.deepEqual(asList({ unexpected: true }), []);

const p1 = asPage({ data: ['item1', 'item2'], total: 42, totalPages: 5 });
assert.equal(p1.total, 42);
assert.equal(p1.totalPages, 5);
assert.equal(p1.rows.length, 2);
console.log('✓ asList and asPage normalization verified.');

console.log('\nAll master repair unit and contract verification checks passed successfully.');
