import assert from 'node:assert/strict';
import { resolveAllowedCorsOrigin, setCors } from '../api/_utils.js';

function fakeResponse(origin) {
  const headers = {};
  return {
    req: { headers: origin === undefined ? {} : { origin } },
    headers,
    setHeader(name, value) { headers[name] = value; }
  };
}

const prod = { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://app.example.test/, https://staging.example.test' };
const dev = { NODE_ENV: 'development' };

// Never a wildcard, even if one is configured.
assert.equal(resolveAllowedCorsOrigin('https://evil.example', { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: '*' }), null);
assert.equal(resolveAllowedCorsOrigin('*', { NODE_ENV: 'development', CORS_ALLOWED_ORIGINS: '*' }), null);

// Production: only explicitly configured origins; localhost is not allowed.
assert.equal(resolveAllowedCorsOrigin('https://app.example.test', prod), 'https://app.example.test');
assert.equal(resolveAllowedCorsOrigin('https://staging.example.test', prod), 'https://staging.example.test');
assert.equal(resolveAllowedCorsOrigin('https://evil.example', prod), null);
assert.equal(resolveAllowedCorsOrigin('http://localhost:3000', prod), null);
assert.equal(resolveAllowedCorsOrigin('https://app.example.test.evil.example', prod), null);
assert.equal(resolveAllowedCorsOrigin('', prod), null);

// Development: localhost origins work so local startup keeps working.
assert.equal(resolveAllowedCorsOrigin('http://localhost:5173', dev), 'http://localhost:5173');
assert.equal(resolveAllowedCorsOrigin('http://127.0.0.1:3000', dev), 'http://127.0.0.1:3000');
assert.equal(resolveAllowedCorsOrigin('https://evil.example', dev), null);
assert.equal(resolveAllowedCorsOrigin('http://localhost.evil.example', dev), null);

// setCors: same-origin / no Origin gets no ACAO header but still varies by Origin.
const previousNodeEnv = process.env.NODE_ENV;
const previousVercelEnv = process.env.VERCEL_ENV;
const previousAllowed = process.env.CORS_ALLOWED_ORIGINS;
try {
  process.env.NODE_ENV = 'production';
  delete process.env.VERCEL_ENV;
  process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.test';

  const sameOrigin = fakeResponse(undefined);
  setCors(sameOrigin);
  assert.equal(sameOrigin.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(sameOrigin.headers.Vary, 'Origin');

  const allowed = fakeResponse('https://app.example.test');
  setCors(allowed);
  assert.equal(allowed.headers['Access-Control-Allow-Origin'], 'https://app.example.test');
  assert.notEqual(allowed.headers['Access-Control-Allow-Origin'], '*');
  assert.match(allowed.headers['Access-Control-Allow-Headers'], /Authorization/);

  const blocked = fakeResponse('https://evil.example');
  setCors(blocked);
  assert.equal(blocked.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(blocked.headers['Access-Control-Allow-Methods'], undefined);

  // A response object without a request (older mocks) must not throw.
  const bare = { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
  setCors(bare);
  assert.equal(bare.headers['Access-Control-Allow-Origin'], undefined);
} finally {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previousVercelEnv;
  if (previousAllowed === undefined) delete process.env.CORS_ALLOWED_ORIGINS; else process.env.CORS_ALLOWED_ORIGINS = previousAllowed;
}

console.log('CORS policy checks passed: no wildcard, allow-list only, localhost only outside production, same-origin unaffected.');
