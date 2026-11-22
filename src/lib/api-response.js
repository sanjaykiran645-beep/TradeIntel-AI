export async function validateApiResponse(response, endpoint, method) {
  const contentType = response.headers.get('content-type') || '';
  const body = await response.clone().text();
  const isJson = /(?:application|text)\/(?:[a-z0-9.+-]*\+)?json\b/i.test(contentType);

  if (!isJson) {
    const error = new Error(
      `API ${method} ${endpoint} returned non-JSON (HTTP ${response.status}, ${contentType || 'no content-type'}): ${body.slice(0, 500)}`
    );
    error.code = 'NON_JSON_RESPONSE';
    error.status = response.status;
    error.endpoint = endpoint;
    throw error;
  }

  try {
    return JSON.parse(body);
  } catch (cause) {
    const error = new Error(`API ${method} ${endpoint} returned malformed JSON (HTTP ${response.status}).`, { cause });
    error.code = 'INVALID_JSON_RESPONSE';
    error.status = response.status;
    error.endpoint = endpoint;
    throw error;
  }
}