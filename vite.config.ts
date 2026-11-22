import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Plugin, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function localApiPlugin(): Plugin {
  return {
    name: 'tradeintel-local-api',
    configureServer(server) {
      for (const envFile of ['.env.local', '.env.vercel.local']) {
        if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
          try {
            process.loadEnvFile(envFile);
          } catch {
            // Ignore malformed or already loaded env file
          }
        }
      }

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const rawUrl = req.url || '';
        if (!rawUrl.startsWith('/api/')) {
          next();
          return;
        }

        const parsedUrl = new URL(rawUrl, 'http://localhost');
        const routeMatch = /^\/api\/([a-zA-Z0-9_-]+)\/?$/.exec(parsedUrl.pathname);
        if (!routeMatch || routeMatch[1].startsWith('_')) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'API route not found' }));
          return;
        }

        let apiFile = resolve(process.cwd(), 'api', '_routes', `${routeMatch[1]}.js`);
        if (!existsSync(apiFile)) {
          apiFile = resolve(process.cwd(), 'api', `${routeMatch[1]}.js`);
        }
        if (!existsSync(apiFile)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `API handler not found: ${routeMatch[1]}` }));
          return;
        }

        try {
          const query: Record<string, string> = {};
          for (const [k, v] of parsedUrl.searchParams.entries()) {
            query[k] = v;
          }

          let body: unknown = undefined;
          if (req.method && !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const rawBody = Buffer.concat(chunks).toString('utf8');
            if (rawBody) {
              try {
                body = JSON.parse(rawBody);
              } catch {
                body = rawBody;
              }
            } else {
              body = {};
            }
          }

          const vercelReq = Object.assign(req, { query, body });
          const vercelRes = Object.assign(res, {
            status(code: number) {
              res.statusCode = code;
              return vercelRes;
            },
            json(payload: unknown) {
              if (!res.headersSent) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
              }
              res.end(JSON.stringify(payload));
              return vercelRes;
            }
          });

          const mod = await import(`${pathToFileURL(apiFile).href}?t=${Date.now()}`);
          if (typeof mod.default !== 'function') {
            throw new Error(`API module ${routeMatch[1]} does not export a default handler`);
          }
          await mod.default(vercelReq, vercelRes);
        } catch (err) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
          }
          const message = err instanceof Error ? err.message : 'Internal server error';
          res.end(JSON.stringify({ error: message }));
        }
      });
    }
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const plugins: PluginOption[] = [react(), tailwindcss(), localApiPlugin()];
  try {
    // @ts-expect-error -- this optional plugin is generated locally and is absent in standard checkouts
    const m = await import('./.vite-source-tags.js');
    plugins.push(m.sourceTags());
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }

  const env = loadEnv(mode, process.cwd(), ['VITE_', 'NEXT_PUBLIC_']);
  const processEnvDefines: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    processEnvDefines[`process.env.${key}`] = JSON.stringify(value);
  }

  return {
    plugins,
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    define: processEnvDefines,
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('node_modules')) {
              if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
                return 'vendor-react';
              }
              if (id.includes('@supabase')) {
                return 'vendor-supabase';
              }
              if (id.includes('lucide-react')) {
                return 'vendor-icons';
              }
            }
          }
        }
      }
    }
  };
})
