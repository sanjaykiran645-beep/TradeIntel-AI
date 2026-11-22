import { apiErrorResponse, setCors } from './_utils.js';

const ROUTE_HANDLERS = {
  admin: () => import('./_routes/admin.js'),
  companies: () => import('./_routes/companies.js'),
  contacts: () => import('./_routes/contacts.js'),
  crm: () => import('./_routes/crm.js'),
  dashboard: () => import('./_routes/dashboard.js'),
  datasets: () => import('./_routes/datasets.js'),
  'email-engine': () => import('./_routes/email-engine.js'),
  followup: () => import('./_routes/followup.js'),
  hostinger: () => import('./_routes/hostinger.js'),
  inbox: () => import('./_routes/inbox.js'),
  intelligence: () => import('./_routes/intelligence.js'),
  leads: () => import('./_routes/leads.js'),
  markets: () => import('./_routes/markets.js'),
  products: () => import('./_routes/products.js'),
  research: () => import('./_routes/research.js'),
  'response-send': () => import('./_routes/response-send.js'),
  responses: () => import('./_routes/responses.js'),
  supervisor: () => import('./_routes/supervisor.js')
};

export function getRouteHandler(routeName) {
  return ROUTE_HANDLERS[routeName] || null;
}

export const SUPPORTED_ROUTES = Object.keys(ROUTE_HANDLERS);

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 1. Resolve route name from Vercel dynamic param or request URL
  let routeName = '';
  const routeParam = req.query?.route;
  if (Array.isArray(routeParam) && routeParam.length > 0) {
    routeName = String(routeParam[0] || '').trim();
  } else if (typeof routeParam === 'string' && routeParam.trim()) {
    routeName = routeParam.trim().split('/')[0];
  }

  if (!routeName) {
    const rawUrl = req.url || '';
    const pathname = rawUrl.split('?')[0];
    const match = /^\/api\/([a-zA-Z0-9_-]+)/.exec(pathname);
    routeName = match?.[1] || '';
  }

  const loader = ROUTE_HANDLERS[routeName];
  if (!loader) {
    return res.status(404).json({
      success: false,
      error: `API route '/api/${routeName || 'unknown'}' not found.`,
      code: 'ROUTE_NOT_FOUND'
    });
  }

  try {
    const module = await loader();
    const endpoint = module.default;
    return await endpoint(req, res);
  } catch (error) {
    console.error(`[API GATEWAY] Dispatch error for route=${routeName}:`, error);
    return apiErrorResponse(res, error, 'GATEWAY_DISPATCH_ERROR');
  }
}
