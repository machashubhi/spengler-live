// Cloudflare Worker: serves /data/<match>.json from the private R2 bucket. Everything else is a static asset
// (public/), served by Cloudflare without running this code (see run_worker_first in wrangler.jsonc).
//
// The match files are Wisehockey data, so they never go to GitHub and the bucket is not public. This
// endpoint only answers fetches made by pages on this site (Sec-Fetch-Site) or by hosts listed in
// ALLOWED_ORIGINS, which stops casual hot-linking and direct downloads. A browser still has to receive the
// data to draw it, so this is a deterrent, not DRM.
const PATH = /^\/data\/([a-z0-9-]+)\.json$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url), m = PATH.exec(url.pathname);
    if (!m) return env.ASSETS.fetch(req);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 });

    const origin = req.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const partner = origin && origin !== url.origin && allowed.includes(origin);
    const site = req.headers.get('Sec-Fetch-Site');
    if (!partner && site !== 'same-origin' && site !== 'same-site') return new Response('Forbidden', { status: 403 });

    const obj = await env.MATCH_DATA.get(`${m[1]}.json`, { onlyIf: req.headers });
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers({
      'Content-Type': 'application/json', ETag: obj.httpEtag, 'Cache-Control': 'private, max-age=300', Vary: 'Origin, Sec-Fetch-Site',
    });
    if (partner) headers.set('Access-Control-Allow-Origin', origin);
    return 'body' in obj ? new Response(obj.body, { headers }) : new Response(null, { status: 304, headers });
  },
};
