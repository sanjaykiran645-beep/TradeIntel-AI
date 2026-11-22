import supabase from './supabase';
import { validateApiResponse } from './api-response';
import {
  AUTH_SESSION_INVALIDATED_EVENT,
  createUnauthorizedSessionHandler,
  invalidateOnHttp401,
  rejectApiResponse
} from './api-auth-errors';

const invalidateUnauthorizedSession = createUnauthorizedSessionHandler({
  signOut: async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) throw error;
  },
  onInvalidated: () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
    }
  }
});

export default async function apiFetch(input, init = {}) {
  const endpoint = typeof input === 'string' ? input : input.url;
  const method = (
    init.method ||
    (input instanceof Request ? input.method : 'GET')
  ).toUpperCase();

  const startedAt = performance.now();
  const headers = new Headers(init.headers);

  // Use the same verified Supabase session in development and production.
  if (supabase) {
    const { data, error } = await supabase.auth.getSession();

    if (!error && data.session?.access_token) {
      headers.set(
        'Authorization',
        `Bearer ${data.session.access_token}`
      );
    }
  }

  let response;

  try {
    response = await fetch(input, {
      ...init,
      headers
    });
  } catch (cause) {
    const error = new Error(
      `API ${method} ${endpoint} network error: ${cause.message}`,
      { cause }
    );

    error.code = 'NETWORK_ERROR';

    if (import.meta.env.DEV) {
      console.error(
        `[API] ${method} ${endpoint} status=NETWORK_ERROR code=${error.code}`
      );
    }

    throw error;
  }

  const durationMs = Math.round(performance.now() - startedAt);

  let payload;

  try {
    payload = await validateApiResponse(
      response,
      endpoint,
      method
    );
  } catch (error) {
    await invalidateOnHttp401(response.status, invalidateUnauthorizedSession);

    if (import.meta.env.DEV) {
      console.error(
        `[API] ${method} ${endpoint} status=${response.status} duration=${durationMs}ms code=${error.code || 'INVALID_RESPONSE'}`
      );
    }

    throw error;
  }

  if (import.meta.env.DEV) {
    const log = response.ok
      ? console.info
      : console.warn;

    log(
      `[API] ${method} ${endpoint} status=${response.status} duration=${durationMs}ms${
        payload?.code
          ? ` code=${payload.code}`
          : ''
      }`
    );
  }

  if (!response.ok) {
    await rejectApiResponse(response, payload, {
      endpoint,
      method,
      onUnauthorized: invalidateUnauthorizedSession
    });
  }

  return response;
}
