import fetch from 'node-fetch';

const API_ENDPOINT = 'https://api.tavily.com/search';

/**
 * Perform a Tavily search.
 * @param {string} query - Search query string.
 * @param {object} options - Optional fetch options (e.g., abort signal).
 * @returns {Promise<object>} Parsed JSON response from Tavily.
 */
export async function search(query, options = {}) {
  const apiKey = process.env.RESEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY_NOT_CONFIGURED');
  }
  const { signal, ...parameters } = options;
  const payload = { query, ...parameters };
  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const err = new Error(`Tavily request failed with status ${response.status}`);
    err.code = response.status;
    throw err;
  }
  const data = await response.json();
  if (data && Array.isArray(data.results) && !Array.isArray(data.sources)) {
    data.sources = data.results.map(r => ({
      url: r.url,
      title: r.title,
      snippet: r.content || r.snippet || null,
      score: r.score
    }));
  }
  return data;
}

// Default export for compatibility with default import style
export default { search };
