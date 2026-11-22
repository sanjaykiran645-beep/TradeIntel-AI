import assert from 'node:assert/strict';
import { classifyResearchProviderResult, performResearch } from '../api/_research-provider.js';

assert.equal(classifyResearchProviderResult({ answer: 'none', sources: [] }).status, 'NO_EVIDENCE');
assert.equal(classifyResearchProviderResult({ answer: 'malformed response' }).status, 'FAILED');
assert.equal(classifyResearchProviderResult({ sources: [{ url: 'javascript:alert(1)' }] }).status, 'FAILED');
const completed = classifyResearchProviderResult({ answer: 'result', score: 0.8, sources: [{ url: 'https://example.invalid', title: 'Source', snippet: 'Evidence' }] });
assert.equal(completed.status, 'COMPLETED');
assert.equal(completed.sources.length, 1);

const configuredCapabilities = async () => ({ research: { configured: true } });
const noEvidence = await performResearch('dataset', { name: 'Example' }, {
  getCapabilities: configuredCapabilities,
  search: async () => ({ sources: [] }),
  wait: async () => {},
  maxRetries: 1
});
assert.equal(noEvidence.data.status, 'NO_EVIDENCE');
assert.equal(noEvidence.requestCount, 1);

let failedAttempts = 0;
const failed = await performResearch('dataset', { name: 'Example' }, {
  getCapabilities: configuredCapabilities,
  search: async () => { failedAttempts++; throw Object.assign(new Error('private provider response'), { code: 503 }); },
  wait: async () => {},
  maxRetries: 1
});
assert.equal(failedAttempts, 2);
assert.equal(failed.requestCount, 2);
assert.equal(failed.data.status, 'FAILED');
assert.match(failed.data.reason, /failed/i);
assert.equal(JSON.stringify(failed).includes('private provider response'), false);

const unconfigured = await performResearch('dataset', { name: 'Example' }, {
  getCapabilities: async () => ({ research: { configured: false } }),
  search: async () => { throw new Error('Must not call provider'); }
});
assert.equal(unconfigured.data.status, 'NOT_CONFIGURED');
assert.equal(unconfigured.requestCount, 0);

console.log('Offline research provider outcome classification passed: empty results stay distinct from configuration and provider failures.');
