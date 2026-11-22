import assert from 'node:assert/strict';
import {
  createUnauthorizedSessionHandler,
  invalidateOnHttp401,
  rejectApiResponse,
  runUiAction,
  signOutOrThrow
} from '../src/lib/api-auth-errors.js';

let signOutCalls = 0;
let invalidationCalls = 0;
let releaseSignOut;
const signOutGate = new Promise(resolve => { releaseSignOut = resolve; });
const invalidateSession = createUnauthorizedSessionHandler({
  signOut: async () => {
    signOutCalls += 1;
    await signOutGate;
  },
  onInvalidated: () => { invalidationCalls += 1; }
});

const unauthorizedResponse = () => rejectApiResponse(
  { ok: false, status: 401 },
  { error: 'Session expired', code: 'INVALID_SESSION' },
  { endpoint: '/api/contacts', method: 'GET', onUnauthorized: invalidateSession }
);

const firstUnauthorized = unauthorizedResponse();
const secondUnauthorized = unauthorizedResponse();
await Promise.resolve();
assert.equal(signOutCalls, 1, 'concurrent 401s share one local sign-out');
releaseSignOut();
const unauthorizedResults = await Promise.allSettled([firstUnauthorized, secondUnauthorized]);
for (const result of unauthorizedResults) {
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason.status, 401);
  assert.equal(result.reason.code, 'INVALID_SESSION');
  assert.equal(result.reason.message, 'Session expired');
}
assert.equal(invalidationCalls, 1, 'concurrent 401s notify auth state once');

let parserFailureInvalidations = 0;
await invalidateOnHttp401(401, async () => { parserFailureInvalidations += 1; });
await invalidateOnHttp401(502, async () => { parserFailureInvalidations += 1; });
assert.equal(parserFailureInvalidations, 1, 'non-JSON 401 responses invalidate; non-401 responses do not');

let ordinaryErrorInvalidations = 0;
for (const status of [400, 403, 500]) {
  await assert.rejects(
    rejectApiResponse(
      { ok: false, status },
      { error: `HTTP ${status}`, code: 'REQUEST_FAILED' },
      {
        endpoint: '/api/example',
        method: 'POST',
        onUnauthorized: () => { ordinaryErrorInvalidations += 1; }
      }
    ),
    error => error.status === status && error.message === `HTTP ${status}`
  );
}
assert.equal(ordinaryErrorInvalidations, 0, 'ordinary 4xx and 5xx errors preserve the session');

let failedActionMessage = null;
await runUiAction(
  async () => { throw new Error('Permission denied. Sign in with an authorized account.'); },
  message => { failedActionMessage = message; }
);
assert.equal(failedActionMessage, 'Permission denied. Sign in with an authorized account.');

let successActionError = null;
const actionResult = await runUiAction(async () => 'saved', message => { successActionError = message; });
assert.equal(actionResult, 'saved');
assert.equal(successActionError, null, 'successful UI actions remain successful');

await assert.rejects(
  signOutOrThrow(async () => ({ error: new Error('Sign-out failed') })),
  /Sign-out failed/
);
assert.deepEqual(
  await signOutOrThrow(async () => ({ data: { user: null }, error: null })),
  { user: null }
);

console.log('Authenticated-session error regressions passed.');
