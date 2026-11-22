import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load local environment files if present (for local testing of the server)
for (const envFile of ['.env.local', '.env.vercel.local']) {
  if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envFile);
    } catch {
      // Ignore if not present or malformed
    }
  }
}

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const DIST_DIR = resolve(__dirname, 'dist');
const PORT = Number(process.env.PORT) || 10000;
const HOST = process.env.HOST || '0.0.0.0';

// Optional built-in Supabase-compatible admin auth (used when ADMIN_AUTH_EMAIL & ADMIN_AUTH_PASSWORD are set)
const ADMIN_AUTH_EMAIL = String(process.env.ADMIN_AUTH_EMAIL || '').trim().toLowerCase();
const ADMIN_AUTH_PASSWORD = String(process.env.ADMIN_AUTH_PASSWORD || '');
const ADMIN_AUTH_USER_ID = String(process.env.ADMIN_SUPABASE_USER_ID || '55d9581c-fbbe-4e84-9acd-49e13d9c1a2c').trim();
const ADMIN_AUTH_ENABLED = Boolean(ADMIN_AUTH_EMAIL && ADMIN_AUTH_PASSWORD);
const ADMIN_AUTH_SECRET = String(
  process.env.ADMIN_AUTH_SECRET || process.env.JWT_SECRET || `${ADMIN_AUTH_USER_ID}:${ADMIN_AUTH_PASSWORD}`
);

function base64UrlEncode(input) {
  return Buffer.from(typeof input === 'string' ? input : JSON.stringify(input))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signAdminJwt(payload) {
  const header = base64UrlEncode({ alg: 'HS256', typ: 'JWT' });
  const body = base64UrlEncode(payload);
  const sig = createHmac('sha256', ADMIN_AUTH_SECRET)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${body}.${sig}`;
}

function verifyAdminJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac('sha256', ADMIN_AUTH_SECRET)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const claims = JSON.parse(base64UrlDecode(body));
    if (claims.exp && Math.floor(Date.now() / 1000) > Number(claims.exp)) return null;
    return claims;
  } catch {
    return null;
  }
}

function safePasswordMatch(inputPassword, expectedPassword) {
  const a = Buffer.from(String(inputPassword || ''), 'utf8');
  const b = Buffer.from(String(expectedPassword || ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function buildAdminUser() {
  return {
    id: ADMIN_AUTH_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: ADMIN_AUTH_EMAIL,
    email_confirmed_at: '2026-01-01T00:00:00.000Z',
    phone: '',
    confirmed_at: '2026-01-01T00:00:00.000Z',
    app_metadata: { provider: 'email', providers: ['email'], role: 'admin' },
    user_metadata: { role: 'admin', email: ADMIN_AUTH_EMAIL },
    identities: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  };
}

function buildAdminSession() {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 86400;
  const expiresAt = now + expiresIn;
  const user = buildAdminUser();
  const accessToken = signAdminJwt({
    sub: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    app_metadata: user.app_metadata,
    user_metadata: user.user_metadata,
    iat: now,
    exp: expiresAt
  });
  const refreshToken = signAdminJwt({
    sub: user.id,
    type: 'refresh',
    iat: now,
    exp: now + 86400 * 30
  });
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: expiresAt,
    refresh_token: refreshToken,
    user
  };
}

async function handleBuiltInAuth(req, res, parsedUrl) {
  const method = (req.method || 'GET').toUpperCase();
  const pathname = parsedUrl.pathname;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/auth/v1/token' && method === 'POST') {
    const grantType = parsedUrl.searchParams.get('grant_type') || 'password';
    const body = await parseRequestBody(req);

    if (grantType === 'password') {
      const email = String(body?.email || '').trim().toLowerCase();
      const password = String(body?.password || '');
      if (email !== ADMIN_AUTH_EMAIL || !safePasswordMatch(password, ADMIN_AUTH_PASSWORD)) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Invalid login credentials',
          msg: 'Invalid login credentials'
        }));
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(buildAdminSession()));
      return;
    }

    if (grantType === 'refresh_token') {
      const claims = verifyAdminJwt(body?.refresh_token);
      if (!claims || claims.type !== 'refresh' || claims.sub !== ADMIN_AUTH_USER_ID) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Invalid refresh token',
          msg: 'Invalid refresh token'
        }));
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(buildAdminSession()));
      return;
    }

    res.writeHead(400, headers);
    res.end(JSON.stringify({ error: 'unsupported_grant_type', error_description: 'Unsupported grant type' }));
    return;
  }

  if (pathname === '/auth/v1/user' && method === 'GET') {
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    const claims = verifyAdminJwt(token);
    if (!claims || claims.sub !== ADMIN_AUTH_USER_ID) {
      res.writeHead(401, headers);
      res.end(JSON.stringify({ code: 401, error_code: 'bad_jwt', msg: 'Invalid JWT' }));
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(buildAdminUser()));
    return;
  }

  if (pathname === '/auth/v1/logout' && method === 'POST') {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({ code: 404, msg: 'Auth endpoint not found' }));
}

// Import the consolidated API gateway handler
const { default: gatewayHandler } = await import('./api/[...route].js');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
};

async function parseRequestBody(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes((req.method || '').toUpperCase())) {
    return {};
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString('utf8');
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function serveStatic(res, filePath) {
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable'
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // 1. Health check endpoints for Render
  if (pathname === '/healthz' || pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() }));
    return;
  }

  // 1b. Built-in Supabase-compatible Admin Auth (when ADMIN_AUTH_EMAIL & ADMIN_AUTH_PASSWORD are configured)
  if (ADMIN_AUTH_ENABLED && pathname.startsWith('/auth/v1/')) {
    await handleBuiltInAuth(req, res, parsedUrl);
    return;
  }

  // 2. API routing -> dispatch to the consolidated API gateway
  if (pathname.startsWith('/api/')) {
    try {
      const query = {};
      for (const [k, v] of parsedUrl.searchParams.entries()) {
        query[k] = v;
      }

      const body = await parseRequestBody(req);

      const vercelReq = Object.assign(req, {
        url: req.url,
        query,
        body,
        socket: req.socket,
        headers: req.headers
      });

      const vercelRes = Object.assign(res, {
        status(code) {
          res.statusCode = code;
          return vercelRes;
        },
        json(payload) {
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
          }
          res.end(JSON.stringify(payload));
          return vercelRes;
        },
        send(payload) {
          if (typeof payload === 'object') {
            return vercelRes.json(payload);
          }
          res.end(payload);
          return vercelRes;
        }
      });

      await gatewayHandler(vercelReq, vercelRes);
    } catch (err) {
      console.error('[RENDER SERVER] API gateway error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      }));
    }
    return;
  }

  // 3. Static asset serving from dist/
  if (existsSync(DIST_DIR)) {
    const safePath = pathname.replace(/^\/+/, '');
    const candidatePath = resolve(DIST_DIR, safePath);

    // Prevent directory traversal outside of DIST_DIR
    if (candidatePath.startsWith(DIST_DIR) && existsSync(candidatePath)) {
      try {
        const stats = statSync(candidatePath);
        if (stats.isFile()) {
          serveStatic(res, candidatePath);
          return;
        }
      } catch {
        // Fall through to index.html fallback
      }
    }

    // SPA fallback: Return index.html for all frontend routes
    const indexPath = join(DIST_DIR, 'index.html');
    if (existsSync(indexPath)) {
      serveStatic(res, indexPath);
      return;
    }
  }

  // 4. If dist is missing, inform the operator
  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('TradeIntel AI: Frontend bundle not built. Please run `npm run build` before starting the server.');
});

server.listen(PORT, HOST, () => {
  console.log(`[TRADEINTEL AI] Production server listening on http://${HOST}:${PORT}`);
  console.log(`[TRADEINTEL AI] Serving frontend from ${DIST_DIR}`);
});

// Graceful termination handling
const shutdown = () => {
  console.log('\n[TRADEINTEL AI] Gracefully shutting down server...');
  server.close(() => {
    console.log('[TRADEINTEL AI] Closed all connections. Exiting.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
