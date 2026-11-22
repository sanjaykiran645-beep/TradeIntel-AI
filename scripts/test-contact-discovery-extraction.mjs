import assert from 'node:assert/strict';
import { extractPublicEmailCandidates, isPublicHttpsUrl } from '../api/_contact-discovery.js';

// 1. isPublicHttpsUrl validation
assert.equal(isPublicHttpsUrl('https://example.com/contact'), true);
assert.equal(isPublicHttpsUrl('http://example.com/contact'), false); // Must be HTTPS
assert.equal(isPublicHttpsUrl('https://127.0.0.1/contact'), false); // No private IP
assert.equal(isPublicHttpsUrl('https://localhost/contact'), false); // No localhost
assert.equal(isPublicHttpsUrl('ftp://example.com'), false);
assert.equal(isPublicHttpsUrl(''), false);

// 2. Candidate extraction & deduplication
const mockTavilyResponse = {
  results: [
    {
      url: 'https://acme-trade.com/about',
      content: 'Contact our procurement director at procurement@acme-trade.com or info@acme-trade.com for quotes.',
      score: 0.92
    },
    {
      url: 'https://acme-trade.com/support',
      content: 'Reach info@acme-trade.com (duplicate) or sales@acme-trade.com',
      score: 0.85
    },
    {
      url: 'http://insecure-site.com/contact', // Insecure HTTP, must be ignored
      content: 'insecure@insecure-site.com',
      score: 0.70
    },
    {
      url: 'https://spam-tracker.com',
      content: 'Do not contact abuse@example or invalid-email@ or test-domain-not-email',
      score: 0.40
    }
  ]
};

const candidates = extractPublicEmailCandidates(mockTavilyResponse);
assert.equal(candidates.length, 3, 'Should extract exactly 3 unique valid HTTPS candidate emails');
assert.equal(candidates[0].email, 'procurement@acme-trade.com');
assert.equal(candidates[0].source_url, 'https://acme-trade.com/about');
assert.equal(candidates[0].confidence, 0.92);

assert.equal(candidates[1].email, 'info@acme-trade.com');
assert.equal(candidates[1].source_url, 'https://acme-trade.com/about');

assert.equal(candidates[2].email, 'sales@acme-trade.com');
assert.equal(candidates[2].source_url, 'https://acme-trade.com/support');

// Empty response case
assert.deepEqual(extractPublicEmailCandidates({ results: [] }), []);
assert.deepEqual(extractPublicEmailCandidates({}), []);

console.log('Contact discovery extraction and deduplication offline tests passed.');
