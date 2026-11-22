import supabase from './_db-client.js';
import { getProviderCapabilities } from './_provider-capabilities.js';
import tavily from './providers/_tavily.js';

// Module‑level counters for quota tracking
let providerRequestCount = 0;

/**
 * Reset the internal request counter. Intended for test harnesses only.
 * Exported as __resetProviderRequestCount.
 */
export function __resetProviderRequestCount() {
  providerRequestCount = 0;
}

export function classifyResearchProviderResult(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.sources)) {
    return { status: 'FAILED', reason: 'Research provider returned an invalid response format.' };
  }
  if (result.sources.length === 0) {
    return { status: 'NO_EVIDENCE' };
  }
  const sources = result.sources.flatMap(source => {
    try {
      const url = new URL(String(source?.url || ''));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
      return [{ url: url.toString(), title: source.title || null, snippet: source.snippet || null }];
    } catch {
      return [];
    }
  });
  if (!sources.length) {
    return { status: 'FAILED', reason: 'Research provider returned no sources with valid URLs.' };
  }
  return {
    status: 'COMPLETED',
    summary: result.answer || null,
    sources,
    confidence: Number.isFinite(result.score) ? result.score : null,
    raw: result
  };
}

/**
 * Builds a search query that is specific to the selected company. The company's own name is
 * quoted so a provider cannot silently substitute a similarly named entity, and the dataset's
 * country (when known) disambiguates same-named businesses. Nothing is invented: absent fields
 * are simply omitted.
 */
export function buildResearchQuery(company = {}) {
  const name = String(company.name || company.domain || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  if (!name) return '';
  const country = String(company.country || '').trim().slice(0, 80);
  return [`"${name}"`, country, 'company official website products'].filter(Boolean).join(' ');
}

/**
 * Perform research for a single company.
 * Returns an object { data, requestCount } where `data` is the JSON payload to store in `web_research`.
 */
export async function performResearch(datasetId, company, options = {}) {
  const getCapabilities = options.getCapabilities || getProviderCapabilities;
  const searchProvider = options.search || ((query, parameters) => tavily.search(query, parameters));
  const wait = options.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const capabilities = await getCapabilities();
  const config = capabilities.research;
  const quotaLimit = Number(process.env.RESEARCH_QUOTA_LIMIT) || 2800;

  if (!config.configured) {
    // Provider not configured – caller should have blocked earlier.
    return { data: { status: 'NOT_CONFIGURED' }, requestCount: 0 };
  }

  // Enforce hard request quota before making a call.
  if (providerRequestCount >= quotaLimit) {
    throw new Error('RESEARCH_QUOTA_EXCEEDED');
  }

  const maxRetries = Number(options.maxRetries ?? process.env.RESEARCH_MAX_RETRIES) || 2;
  const timeoutMs = Number(options.timeoutMs ?? process.env.RESEARCH_TIMEOUT_MS) || 15000;
  const backoffBase = Number(options.backoffBase ?? process.env.RESEARCH_BACKOFF_BASE_MS) || 800;
  const ratelimitBackoff = Number(options.ratelimitBackoff ?? process.env.RESEARCH_RATELIMIT_BACKOFF_MS) || 2000;

  const query = buildResearchQuery(company);
  if (!query) {
    return { data: { status: 'FAILED', reason: 'The company has no name to research.' }, requestCount: 0 };
  }
  const withProvenance = (data, startedAt) => ({
    ...data,
    query,
    provider: 'tavily',
    durationMs: Date.now() - startedAt
  });
  const startedAt = Date.now();

  let attempt = 0;
  while (attempt <= maxRetries) {
    attempt++;
    // track request (including retries)
    providerRequestCount++;
    if (providerRequestCount > quotaLimit) {
      throw new Error('RESEARCH_QUOTA_EXCEEDED');
    }
    let timeout;
    let retryDelay = null;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      const result = await searchProvider(query, { signal: controller.signal });

      // Expect Tavily to return { answer, sources[] }
      return { data: withProvenance(classifyResearchProviderResult(result), startedAt), requestCount: attempt };
    } catch (err) {
      // Network error, timeout, or HTTP error
      const isRateLimit = err.code === 429 || (err.response && err.response.status === 429);
      if (attempt > maxRetries) {
        return {
          data: withProvenance({ status: 'FAILED', reason: 'Research provider request failed after the configured retries.' }, startedAt),
          requestCount: attempt
        };
      }
      retryDelay = isRateLimit ? ratelimitBackoff : backoffBase * Math.pow(2, attempt - 1);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (retryDelay !== null) await wait(retryDelay);
  }
  // Should never reach here
  return {
    data: { status: 'FAILED', reason: 'Research provider request could not be completed.' },
    requestCount: maxRetries + 1
  };
}

// Export a simple API used by supervisor
export default { performResearch };
