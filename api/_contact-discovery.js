import { isIP } from 'node:net';
import tavily from './providers/_tavily.js';
import { isValidOutreachEmail } from './_outreach-guards.js';

const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MAX_RESULTS = 5;
const MAX_CONTACTS = 20;

export function getContactDiscoveryConfiguration() {
  const configuredProvider = String(
    process.env.CONTACT_DISCOVERY_PROVIDER || (process.env.RESEARCH_API_KEY ? 'TAVILY' : '')
  ).trim().toUpperCase();
  if (!configuredProvider) {
    return {
      provider: null,
      implemented: true,
      configured: false,
      reason: 'Set CONTACT_DISCOVERY_PROVIDER=TAVILY to enable one-company public web discovery. No search is run by default.'
    };
  }
  if (configuredProvider !== 'TAVILY') {
    return {
      provider: configuredProvider,
      implemented: false,
      configured: false,
      reason: `Contact discovery provider ${configuredProvider} is not implemented.`
    };
  }
  if (!process.env.RESEARCH_API_KEY) {
    return {
      provider: 'TAVILY',
      implemented: true,
      configured: false,
      reason: 'Tavily contact discovery requires the existing server-side RESEARCH_API_KEY.'
    };
  }
  return { provider: 'TAVILY', implemented: true, configured: true, reason: null };
}

export function isPublicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return url.protocol === 'https:' &&
      !url.username && !url.password &&
      !isIP(hostname) &&
      hostname !== 'localhost' &&
      !hostname.endsWith('.localhost') &&
      !hostname.endsWith('.local');
  } catch {
    return false;
  }
}

export function extractPublicEmailCandidates(response) {
  const results = Array.isArray(response?.results)
    ? response.results
    : Array.isArray(response?.sources)
      ? response.sources
      : [];
  const candidates = new Map();

  for (const result of results.slice(0, MAX_RESULTS)) {
    const sourceUrl = String(result?.url || '').trim();
    if (!isPublicHttpsUrl(sourceUrl)) continue;
    const sourceText = [result?.content, result?.snippet]
      .filter(value => typeof value === 'string')
      .join('\n');
    for (const match of sourceText.matchAll(EMAIL_PATTERN)) {
      const email = String(match[0] || '').replace(/[.,;:!?)}\]]+$/g, '').toLowerCase();
      if (!isValidOutreachEmail(email) || candidates.has(email)) continue;
      const score = Number(result?.score);
      candidates.set(email, {
        email,
        name: null,
        role: null,
        source_url: sourceUrl,
        confidence: Number.isFinite(score) && score >= 0 && score <= 1 ? score : null
      });
      if (candidates.size >= MAX_CONTACTS) break;
    }
    if (candidates.size >= MAX_CONTACTS) break;
  }

  return [...candidates.values()];
}

export async function discoverPublicContacts(company) {
  const configuration = getContactDiscoveryConfiguration();
  if (!configuration.configured) {
    return { status: 'NOT_CONFIGURED', provider: configuration.provider, contacts: [], reason: configuration.reason };
  }
  const companyName = String(company?.name || '').trim();
  if (!companyName) {
    return { status: 'FAILED', provider: configuration.provider, contacts: [], reason: 'A persisted company name is required.' };
  }

  const location = String(company?.country || '').trim();
  const query = `"${companyName}" ${location} official business contact email procurement sales`;
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(30000, Number.parseInt(process.env.CONTACT_DISCOVERY_TIMEOUT_MS || '15000', 10) || 15000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await tavily.search(query, {
      search_depth: 'basic',
      max_results: MAX_RESULTS,
      include_answer: false,
      include_raw_content: false,
      signal: controller.signal
    });
    const contacts = extractPublicEmailCandidates(result);
    return {
      status: contacts.length ? 'COMPLETED' : 'NO_CONTACTS_FOUND',
      provider: configuration.provider,
      contacts,
      requestCount: 1,
      reason: contacts.length ? null : 'No public business email address was present in the returned source snippets.'
    };
  } finally {
    clearTimeout(timeout);
  }
}
