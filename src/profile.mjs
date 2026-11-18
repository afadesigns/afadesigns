import { terminalTemplate } from './template.mjs';

export const SNAPSHOT_KEY = 'github-profile:v1';
const API = 'https://api.github.com';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 100;
const SNAPSHOT_FIELDS = ['followers', 'repositories', 'schemaVersion', 'stars', 'updatedAt', 'username'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const account = value => typeof value === 'string' && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value);

export class ProfileError extends Error {
  constructor(code) { super(code); this.name = 'ProfileError'; this.code = code; }
}

function requireValue(condition, code) {
  if (!condition) throw new ProfileError(code);
}

async function requestJson(url, token, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'AFADesign-profile-statistics',
      },
    });
    if (response.status !== 200 || response.redirected) {
      await response.body?.cancel();
      throw new ProfileError('github_request_failed');
    }
    const contentType = response.headers.get('content-type') ?? '';
    requireValue(/^application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/i.test(contentType), 'invalid_github_response');
    const sizeHeader = response.headers.get('content-length');
    if (sizeHeader !== null && /^\d+$/.test(sizeHeader) && Number(sizeHeader) > MAX_BODY_BYTES) {
      await response.body?.cancel();
      throw new ProfileError('github_response_too_large');
    }
    requireValue(response.body, 'invalid_github_response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        requireValue(bytes <= MAX_BODY_BYTES, 'github_response_too_large');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return { data: JSON.parse(text), link: response.headers.get('link') };
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw new ProfileError('github_request_failed');
  }
}

function nextPage(link, currentPage) {
  if (!link) return null;
  requireValue(link.length <= 8192, 'invalid_pagination');
  let next = null;
  for (const part of link.split(/,\s*(?=<)/)) {
    const match = part.match(/^\s*<([^>]+)>\s*;\s*rel="([a-z ]+)"\s*$/);
    requireValue(match, 'invalid_pagination');
    if (!match[2].split(' ').includes('next')) continue;
    requireValue(next === null, 'invalid_pagination');
    let url;
    try { url = new URL(match[1]); } catch { throw new ProfileError('invalid_pagination'); }
    const entries = [...url.searchParams.entries()];
    requireValue(
      url.origin === API && url.pathname === '/user/repos' && !url.username && !url.password && !url.hash &&
      entries.length === 4 && new Set(entries.map(([key]) => key)).size === 4 &&
      url.searchParams.get('affiliation') === 'owner' && url.searchParams.get('visibility') === 'all' &&
      url.searchParams.get('per_page') === '100' && url.searchParams.get('page') === String(currentPage + 1),
      'invalid_pagination',
    );
    next = url.href;
  }
  return next;
}

/** Collect complete owned-repository aggregates. Nothing raw is persisted. */
export async function collectStats({ token, username = 'afadesigns', fetchImpl = fetch, now = () => new Date() }) {
  requireValue(account(username), 'invalid_configuration');
  requireValue(typeof token === 'string' && token.length > 0 && !/\s/.test(token), 'missing_github_credential');
  const owner = username.toLowerCase();
  const { data: user } = await requestJson(`${API}/user`, token, fetchImpl);
  requireValue(user && typeof user.login === 'string' && user.login.toLowerCase() === owner, 'identity_mismatch');
  requireValue(count(user.followers) && count(user.public_repos), 'invalid_github_response');
  requireValue(count(user.owned_private_repos), 'private_coverage_unverified');
  let url = `${API}/user/repos?affiliation=owner&visibility=all&per_page=100&page=1`;
  let stars = 0;
  let publicCount = 0;
  const ids = new Set();
  for (let page = 1; url !== null; page++) {
    requireValue(page <= MAX_PAGES, 'pagination_limit');
    const { data, link } = await requestJson(url, token, fetchImpl);
    requireValue(Array.isArray(data) && data.length <= 100, 'invalid_github_response');
    for (const repo of data) {
      requireValue(
        repo && Number.isSafeInteger(repo.id) && repo.id > 0 && !ids.has(repo.id) &&
        typeof repo.owner?.login === 'string' && repo.owner.login.toLowerCase() === owner &&
        typeof repo.private === 'boolean' && typeof repo.fork === 'boolean' && count(repo.stargazers_count),
        'invalid_repository_record',
      );
      ids.add(repo.id);
      stars += repo.stargazers_count;
      requireValue(count(stars), 'invalid_repository_record');
      if (!repo.private) publicCount++;
    }
    url = nextPage(link, page);
    requireValue(url === null || data.length > 0, 'incomplete_inventory');
  }
  requireValue(publicCount === user.public_repos, 'incomplete_inventory');
  requireValue(ids.size === user.public_repos + user.owned_private_repos, 'incomplete_inventory');
  const instant = now();
  requireValue(instant instanceof Date && Number.isFinite(instant.valueOf()), 'invalid_configuration');
  return { schemaVersion: 1, username: owner, followers: user.followers, stars, repositories: ids.size, updatedAt: instant.toISOString() };
}

/** Replace the last good snapshot only after the complete collection succeeds. */
export async function refreshStats(env, options = {}) {
  const snapshot = await collectStats({
    token: env.GITHUB_TOKEN,
    username: env.GITHUB_USERNAME ?? 'afadesigns',
    ...options,
  });
  await env.PROFILE_STATS.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
  return snapshot;
}

/** Strictly accept only the intended public aggregate schema. */
export function validateSnapshot(value, username = 'afadesigns', now = new Date()) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'invalid_snapshot');
  requireValue(Object.keys(value).sort().join(',') === SNAPSHOT_FIELDS.join(','), 'invalid_snapshot');
  requireValue(
    account(username) && value.schemaVersion === 1 && value.username === username.toLowerCase() &&
    count(value.followers) && count(value.stars) && count(value.repositories) && typeof value.updatedAt === 'string',
    'invalid_snapshot',
  );
  const instant = new Date(value.updatedAt);
  requireValue(Number.isFinite(instant.valueOf()) && instant.toISOString() === value.updatedAt && instant.valueOf() <= now.valueOf() + 300_000, 'invalid_snapshot');
  return { schemaVersion: 1, username: value.username, followers: value.followers, stars: value.stars, repositories: value.repositories, updatedAt: value.updatedAt };
}

export function renderSvg(stats) {
  if (stats !== null) validateSnapshot(stats, stats?.username);
  const stamp = stats ? `GitHub stats updated: ${stats.updatedAt};` : 'GitHub stats unavailable;';
  const line = stats
    ? `followers: ${stats.followers}   ·   stars: ${stats.stars}   ·   Repositories: ${stats.repositories}`
    : 'followers: —   ·   stars: —   ·   Repositories: —';
  return terminalTemplate
    .replace('GitHub stats snapshot: 2026-10-04;', stamp)
    .replace('followers: 7   ·   stars: 47   ·   Repositories: 24', line);
}
