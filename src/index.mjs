import { ProfileError, refreshStats, renderSvg, SNAPSHOT_KEY, validateSnapshot } from './profile.mjs';

async function imageResponse(request, env) {
  let snapshot = null;
  try {
    const raw = await env.PROFILE_STATS.get(SNAPSHOT_KEY);
    if (typeof raw === 'string' && raw.length <= 2048) {
      snapshot = validateSnapshot(JSON.parse(raw), env.GITHUB_USERNAME ?? 'afadesigns');
    }
  } catch { /* Keep failures private and render explicit unavailable values. */ }
  const body = renderSvg(snapshot);
  const bytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const tag = `"${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}"`;
  const stale = snapshot && Date.now() - Date.parse(snapshot.updatedAt) > 3 * 60 * 60 * 1000;
  const headers = new Headers({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': snapshot ? 'no-cache' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'X-Profile-Stats': snapshot ? (stale ? 'stale' : 'fresh') : 'unavailable',
    ETag: tag,
  });
  if (snapshot) headers.set('X-Profile-Stats-Updated', snapshot.updatedAt);
  else headers.set('Retry-After', '60');
  const matches = (request.headers.get('if-none-match') ?? '').split(',').some(item => item.trim() === '*' || item.trim().replace(/^W\//, '') === tag);
  if (snapshot && matches) return new Response(null, { status: 304, headers });
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : body, { status: snapshot ? 200 : 503, headers });
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/terminal.svg') return new Response('Not found\n', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed\n', { status: 405, headers: { Allow: 'GET, HEAD' } });
    return imageResponse(request, env);
  },
  async scheduled(_controller, env) {
    if (env.ENABLE_REFRESH !== 'true') return { skipped: true };
    try {
      const snapshot = await refreshStats(env);
      console.log(JSON.stringify({ event: 'profile_stats_updated', updatedAt: snapshot.updatedAt }));
      return { updatedAt: snapshot.updatedAt };
    } catch (error) {
      console.error(JSON.stringify({ event: 'profile_stats_refresh_failed', code: error instanceof ProfileError ? error.code : 'storage_failure' }));
      throw new Error('profile_stats_refresh_failed');
    }
  },
};
