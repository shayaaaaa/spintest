// Cloudflare Worker: a tiny CORS proxy for Ai Agent (Settings → Web → Your proxy URL).
// Deploy: dash.cloudflare.com → Workers & Pages → Create → Worker → paste this → Deploy.
// Optional: set a secret named TOKEN and append ?token=… to the proxy URL to keep it private.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
      'Access-Control-Expose-Headers': '*',
      'Access-Control-Max-Age': '86400',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (env.TOKEN && url.searchParams.get('token') !== env.TOKEN) return new Response('Forbidden', { status: 403, headers: cors });
    const target = url.searchParams.get('url');
    if (!target || !/^https?:\/\//.test(target)) return new Response('Usage: ?url=https://…', { status: 400, headers: cors });
    const headers = new Headers(request.headers);
    for (const h of ['host', 'origin', 'referer', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip']) headers.delete(h);
    const resp = await fetch(target, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'follow' });
    const out = new Headers(resp.headers);
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    out.delete('content-security-policy');
    out.delete('x-frame-options');
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out });
  },
};
