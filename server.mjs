import { createServer } from 'node:http';
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
