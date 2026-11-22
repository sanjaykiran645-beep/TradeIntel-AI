// Shared, dependency-free helpers for consuming the API's real response contracts.
// Endpoints return either a plain array, a `{ data, page, total, totalPages }` page, or an error
// object; pages must never assume one shape.

/** Returns an array from a plain array or a `{ data: [...] }` page; anything else is an empty list. */
export function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

/** Normalizes a paged payload (or plain array) into `{ rows, total, totalPages }`. */
export function asPage(payload) {
  const rows = asList(payload);
  if (Array.isArray(payload)) {
    return { rows, total: rows.length, totalPages: rows.length ? 1 : 0 };
  }
  const total = Number.isFinite(Number(payload?.total)) ? Number(payload.total) : rows.length;
  const totalPages = Number.isFinite(Number(payload?.totalPages))
    ? Number(payload.totalPages)
    : (rows.length ? 1 : 0);
  return { rows, total, totalPages };
}

/**
 * Turns an error thrown by `apiFetch` into UI-ready text, keeping intentional business-rule
 * conflicts (HTTP 409) distinguishable from genuine failures. This never hides a safeguard:
 * a 409 is reported with the server's reason and its code.
 */
export function describeApiError(error, fallback = 'The request failed.') {
  const status = Number(error?.status) || null;
  const code = error?.code || error?.payload?.code || null;
  const reason = error?.payload?.reason || error?.payload?.error || error?.message || fallback;
  if (status === 409) {
    return {
      kind: 'SAFEGUARD',
      status,
      code,
      text: `${reason}${code ? ` (${code})` : ''}`,
      preview: error?.payload?.preview || null
    };
  }
  if (status === 401) return { kind: 'AUTH', status, code, text: 'Your session expired. Sign in again.', preview: null };
  if (status === 403) return { kind: 'FORBIDDEN', status, code, text: reason, preview: null };
  return { kind: 'ERROR', status, code, text: reason, preview: null };
}

/** Maps a stored `web_research` row (`result` JSON contract or legacy columns) to a display model. */
export function toResearchView(row) {
  if (!row) {
    return { present: false, status: 'NOT_RESEARCHED', sources: [], summary: null, confidence: null, query: null, researchedAt: null, reason: null, officialWebsite: null, publicEmail: null, publicPhone: null, headquarters: null };
  }
  const result = row && typeof row.result === 'object' && row.result ? row.result : null;
  const status = String(result?.status || row?.verification_status || (row?.id ? 'COMPLETED' : 'NOT_RESEARCHED'));
  const rawSources = result?.sources || (row?.source_url ? [{ url: row.source_url, title: row.source_url }] : []);
  const sources = Array.isArray(rawSources)
    ? rawSources.filter(source => /^https?:\/\//i.test(String(source?.url || '')))
    : [];
  const confidence = Number.isFinite(Number(result?.confidence))
    ? Number(result.confidence)
    : Number.isFinite(Number(row?.confidence))
      ? Number(row.confidence)
      : null;
  const summary = (typeof result?.summary === 'string' && result.summary.trim())
    ? result.summary.trim()
    : (typeof row?.business_summary === 'string' && row.business_summary.trim())
      ? row.business_summary.trim()
      : null;

  return {
    present: true,
    status,
    summary,
    sources,
    confidence,
    query: typeof result?.query === 'string' ? result.query : null,
    researchedAt: row?.researched_at || row?.updated_at || null,
    reason: typeof result?.reason === 'string' ? result.reason : null,
    officialWebsite: result?.official_website || row?.official_website || (sources[0]?.url || null),
    publicEmail: result?.public_email || row?.public_email || null,
    publicPhone: result?.public_phone || row?.public_phone || null,
    headquarters: result?.headquarters || row?.headquarters || null
  };
}

/** Elapsed-time label such as `1m 05s`. */
export function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}
