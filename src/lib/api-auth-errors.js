export const AUTH_SESSION_INVALIDATED_EVENT = 'tradeintel:auth-session-invalidated';

export function createUnauthorizedSessionHandler({ signOut, onInvalidated }) {
  let inFlight = null;

  return async function invalidateUnauthorizedSession() {
    if (inFlight) return inFlight;

    const current = (async () => {
      try {
        await signOut();
      } catch {
        // The UI still needs to leave the authenticated workspace if cleanup fails.
      }

      try {
        onInvalidated();
      } catch {
        // Preserve the original API 401 even if local notification fails.
      }
    })();

    inFlight = current;
    try {
      await current;
    } finally {
      if (inFlight === current) inFlight = null;
    }
  };
}

export async function invalidateOnHttp401(status, onUnauthorized) {
  if (status !== 401 || typeof onUnauthorized !== 'function') return;

  try {
    await onUnauthorized();
  } catch {
    // API error handling must retain the server response as the primary error.
  }
}

export async function rejectApiResponse(response, payload, { endpoint, method, onUnauthorized } = {}) {
  const error = new Error(
    payload?.error || `API ${method} ${endpoint} failed with HTTP ${response.status}.`
  );

  error.code = payload?.code || 'HTTP_ERROR';
  error.status = response.status;
  error.endpoint = endpoint;
  error.payload = payload;

  await invalidateOnHttp401(response.status, onUnauthorized);
  throw error;
}

export async function runUiAction(action, onError) {
  try {
    return await action();
  } catch (error) {
    onError(error?.message || 'The request failed. Please try again.');
    return undefined;
  }
}

export async function signOutOrThrow(signOut) {
  const result = await signOut();
  if (result?.error) throw result.error;
  return result?.data;
}
