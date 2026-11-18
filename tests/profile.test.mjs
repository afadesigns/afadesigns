import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectStats, refreshStats, renderSvg, validateSnapshot, SNAPSHOT_KEY } from '../src/profile.mjs';
import worker from '../src/index.mjs';
import { terminalTemplate } from '../src/template.mjs';

const NOW = '2026-11-18T20:00:00.000Z';
const USERNAME = 'afadesigns';
const TOKEN = 'synthetic-token-for-tests';
const firstPage = 'https://api.github.com/user/repos?affiliation=owner&visibility=all&per_page=100&page=1';
const nextPage = 'https://api.github.com/user/repos?affiliation=owner&visibility=all&per_page=100&page=2';
const snapshot = { schemaVersion: 1, username: USERNAME, followers: 6, stars: 77, repositories: 21, updatedAt: NOW };
const user = { login: USERNAME, followers: 6, public_repos: 2, owned_private_repos: 1 };
const repo = (id, stars, isPrivate = false, fork = false) => ({ id, owner: { login: USERNAME }, private: isPrivate, fork, stargazers_count: stars, name: `private-canary-${id}` });
const json = (body, headers = {}, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function mockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const response = responses.shift();
    if (!response) throw new Error('unexpected upstream call');
    return typeof response === 'function' ? response() : response;
  };
  return { fetchImpl, calls };
}
function memoryKV(initial = null) {
  let value = initial;
  const puts = [];
  return { puts, get: async () => value, put: async (key, next) => { puts.push({ key, value: next }); value = next; } };
}
function environment(kv = memoryKV(JSON.stringify(snapshot))) {
  return { PROFILE_STATS: kv, GITHUB_TOKEN: TOKEN, GITHUB_USERNAME: USERNAME, ENABLE_REFRESH: 'true' };
}

test('the source SVG exactly matches the verified original bytes', () => {
  assert.equal(createHash('sha256').update(terminalTemplate).digest('hex'), '4a80bcdc232cd93b94a12ac45e659c6974bd170f27f03870a50a99027530a899');
});

test('the Worker entry module exposes only its supported default handler', async () => {
  assert.deepEqual(Object.keys(await import('../src/index.mjs')), ['default']);
});

test('collection includes private repositories and owned forks across all pages', async () => {
  const upstream = mockFetch([
    json(user),
    json([repo(1, 8), repo(2, 3, true)], { link: `<${nextPage}>; rel="next", <${nextPage}>; rel="last"` }),
    json([repo(3, 5, false, true)]),
  ]);
  const result = await collectStats({ token: TOKEN, username: USERNAME, fetchImpl: upstream.fetchImpl, now: () => new Date(NOW) });
  assert.deepEqual(result, { ...snapshot, stars: 16, repositories: 3 });
  assert.deepEqual(upstream.calls.map(call => call.url), ['https://api.github.com/user', firstPage, nextPage]);
  assert.ok(upstream.calls.every(call => call.options.redirect === 'manual'));
  assert.ok(upstream.calls.every(call => new Headers(call.options.headers).get('authorization') === `Bearer ${TOKEN}`));
  assert.equal(JSON.stringify(result).includes('private-canary'), false);
});

test('unverified private coverage preserves the last good snapshot without exposing upstream data', async t => {
  for (const [name, privateCount] of [
    ['missing count', undefined],
    ['null count', null],
    ['negative count', -1],
    ['fractional count', 0.5],
    ['unsafe integer count', Number.MAX_SAFE_INTEGER + 1],
    ['upstream private data', `private-canary-${TOKEN}`],
  ]) await t.test(name, async () => {
    const original = JSON.stringify(snapshot);
    const kv = memoryKV(original);
    const upstream = mockFetch([
      json({ login: USERNAME, followers: 6, public_repos: 1, owned_private_repos: privateCount }),
      json([repo(1, 1)]),
    ]);
    let failure;
    try { await refreshStats(environment(kv), { fetchImpl: upstream.fetchImpl, now: () => new Date(NOW) }); } catch (error) { failure = error; }
    assert.ok(failure, 'unverified coverage must reject a potentially restricted inventory');
    assert.equal(failure.code, 'private_coverage_unverified');
    assert.equal(String(failure).includes(TOKEN), false);
    assert.equal(String(failure).includes('private-canary'), false);
    assert.equal(upstream.calls.length, 1);
    assert.equal(kv.puts.length, 0);
    assert.equal(await kv.get(), original);
  });
});

test('a verified zero private count allows a complete public-only account inventory', async () => {
  const upstream = mockFetch([json({ ...user, owned_private_repos: 0 }), json([repo(1, 1), repo(2, 2)])]);
  const result = await collectStats({ token: TOKEN, username: USERNAME, fetchImpl: upstream.fetchImpl, now: () => new Date(NOW) });
  assert.equal(result.repositories, 2);
  assert.equal(result.stars, 3);
});

test('the wrong authenticated identity is rejected before listing repositories', async () => {
  const upstream = mockFetch([json({ ...user, login: 'somebody-else' })]);
  await assert.rejects(collectStats({ token: TOKEN, username: USERNAME, fetchImpl: upstream.fetchImpl }), /identity_mismatch/);
  assert.equal(upstream.calls.length, 1);
});

test('pagination never forwards credentials to an unapproved URL', async t => {
  for (const next of [
    'https://attacker.example/user/repos?page=2',
    'https://api.github.com/user/repos?affiliation=owner&visibility=public&per_page=100&page=2',
    'https://api.github.com/user/repos?affiliation=owner&visibility=all&per_page=100&page=1',
    'https://api.github.com/user/repos?affiliation=owner&visibility=all&per_page=100&page=2&page=3',
    'https://api.github.com/user/repos?affiliation=owner&visibility=all&per_page=100&page=2&unexpected=1',
    'https://api.github.com/user/repos?affiliation=owner&visibility=all&per_page=100&page=2#secret',
    'https://api.github.com@attacker.example/user/repos?page=2',
    'https://api.github.com/user/repos?affiliation=owner&visibility=all&per_page=100&page=3',
    'https://api.github.com/user?affiliation=owner&visibility=all&per_page=100&page=2',
  ]) await t.test(next, async () => {
    const upstream = mockFetch([json(user), json([repo(1, 1)], { link: `<${next}>; rel="next"` })]);
    await assert.rejects(collectStats({ token: TOKEN, username: USERNAME, fetchImpl: upstream.fetchImpl }), /invalid_pagination/);
    assert.equal(upstream.calls.length, 2);
  });
});

test('invalid, duplicate or foreign-owned records reject the entire refresh', async t => {
  for (const [name, records] of [
    ['duplicate ID', [repo(1, 1), repo(1, 1)]],
    ['negative stars', [repo(1, -1)]],
    ['fractional stars', [repo(1, 0.5)]],
    ['string stars', [{ ...repo(1, 1), stargazers_count: '1' }]],
    ['missing privacy', [{ id: 1, owner: { login: USERNAME }, stargazers_count: 2 }]],
    ['foreign owner', [{ ...repo(1, 1), owner: { login: 'someone-else' } }]],
    ['overflow', [repo(1, Number.MAX_SAFE_INTEGER), repo(2, 1)]],
  ]) await t.test(name, async () => {
    const kv = memoryKV(JSON.stringify(snapshot));
    const upstream = mockFetch([json(user), json(records)]);
    await assert.rejects(refreshStats(environment(kv), { fetchImpl: upstream.fetchImpl, now: () => new Date(NOW) }));
    assert.equal(kv.puts.length, 0);
    assert.deepEqual(JSON.parse(await kv.get()), snapshot);
  });
});

test('known public/private totals prevent a partial inventory from replacing good data', async () => {
  const kv = memoryKV(JSON.stringify(snapshot));
  const upstream = mockFetch([json(user), json([repo(1, 1), repo(2, 2, true)])]);
  await assert.rejects(refreshStats(environment(kv), { fetchImpl: upstream.fetchImpl }), /incomplete_inventory/);
  assert.equal(kv.puts.length, 0);
});

test('unauthorized, rate-limited and malformed upstream responses preserve the last good snapshot', async t => {
  for (const [name, response] of [
    ['unauthorized', json({ message: TOKEN }, {}, 401)],
    ['rate-limited', json({ private: 'private-canary' }, {}, 429)],
    ['truncated JSON', new Response('{"login":', { headers: { 'content-type': 'application/json' } })],
    ['non-JSON', new Response('<html>broken</html>', { headers: { 'content-type': 'text/html' } })],
    ['oversize length', json(user, { 'content-length': '999999999' })],
    ['oversize streamed body', new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })],
  ]) await t.test(name, async () => {
    const kv = memoryKV(JSON.stringify(snapshot));
    const upstream = mockFetch([response]);
    let failure;
    try { await refreshStats(environment(kv), { fetchImpl: upstream.fetchImpl }); } catch (error) { failure = error; }
    assert.ok(failure);
    assert.equal(String(failure).includes(TOKEN), false);
    assert.equal(String(failure).includes('private-canary'), false);
    assert.equal(kv.puts.length, 0);
    assert.deepEqual(JSON.parse(await kv.get()), snapshot);
  });
});

test('successful refresh writes only allowlisted aggregate data after all upstream pages succeed', async () => {
  const kv = memoryKV();
  const upstream = mockFetch([json(user), json([repo(1, 8), repo(2, 3, true), repo(3, 5, false, true)])]);
  const result = await refreshStats(environment(kv), { fetchImpl: upstream.fetchImpl, now: () => new Date(NOW) });
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0].key, SNAPSHOT_KEY);
  assert.deepEqual(JSON.parse(kv.puts[0].value), result);
  assert.deepEqual(Object.keys(result).sort(), ['schemaVersion', 'username', 'followers', 'stars', 'repositories', 'updatedAt'].sort());
});

test('stage refresh stays disabled without reading credentials or touching storage', async () => {
  const env = { ENABLE_REFRESH: 'false', get GITHUB_TOKEN() { throw new Error('must not read'); } };
  assert.deepEqual(await worker.scheduled({}, env, {}), { skipped: true });
});

test('snapshot validation rejects malicious, mismatched and future values', () => {
  for (const invalid of [null, {}, { ...snapshot, username: 'someone-else' }, { ...snapshot, stars: '<script/>' }, { ...snapshot, stars: -1 }, { ...snapshot, repositories: 1.2 }, { ...snapshot, updatedAt: 'tomorrow' }, { ...snapshot, updatedAt: '2999-01-01T00:00:00.000Z' }, { ...snapshot, token: TOKEN }]) {
    assert.throws(() => validateSnapshot(invalid, USERNAME, new Date(NOW)), /invalid_snapshot/);
  }
});

test('rendered stats replace only the snapshot comment and original stats row', () => {
  const svg = renderSvg(snapshot);
  const expected = terminalTemplate
    .replace('GitHub stats snapshot: 2026-10-04;', `GitHub stats updated: ${NOW};`)
    .replace('followers: 7   ·   stars: 47   ·   Repositories: 24', 'followers: 6   ·   stars: 77   ·   Repositories: 21');
  assert.equal(svg, expected);
  assert.match(svg, /Python · ZSH · JavaScript · Shell · Go · HTML · Postgres · CSS · Rust/);
  assert.match(svg, /width="950" height="480"/);
  assert.match(svg, /prefers-reduced-motion/);
});

test('public image requests do not call GitHub and implement HEAD and ETag correctly', async () => {
  const env = environment();
  Object.defineProperty(env, 'GITHUB_TOKEN', { get() { throw new Error('public route must not read credential'); } });
  const response = await worker.fetch(new Request('https://profile.example/terminal.svg'), env, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(await response.text(), renderSvg(snapshot));
  const tag = response.headers.get('etag');
  assert.match(tag, /^"[a-f0-9]{64}"$/);
  const unchanged = await worker.fetch(new Request('https://profile.example/terminal.svg', { headers: { 'if-none-match': `"other", W/${tag}` } }), env, {});
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  const head = await worker.fetch(new Request('https://profile.example/terminal.svg', { method: 'HEAD' }), env, {});
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('etag'), tag);
  assert.equal(await head.text(), '');
});

test('If-Modified-Since cannot hide a changed snapshot', async () => {
  const response = await worker.fetch(new Request('https://profile.example/terminal.svg', { headers: { 'if-modified-since': 'Thu, 31 Dec 2999 23:59:59 GMT', 'if-none-match': '"unrelated"' } }), environment(), {});
  assert.equal(response.status, 200);
});

test('missing, corrupt and unreadable snapshots render placeholders, never fake zero counts or 304', async t => {
  for (const [name, kv] of [
    ['missing', memoryKV()],
    ['corrupt JSON', memoryKV('{bad')],
    ['wrong owner', memoryKV(JSON.stringify({ ...snapshot, username: 'other' }))],
    ['extra data', memoryKV(JSON.stringify({ ...snapshot, repositoryNames: ['private-canary'] }))],
    ['read error', { get: async () => { throw new Error(TOKEN); } }],
  ]) await t.test(name, async () => {
    const response = await worker.fetch(new Request('https://profile.example/terminal.svg', { headers: { 'if-none-match': '*' } }), environment(kv), {});
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-profile-stats'), 'unavailable');
    const body = await response.text();
    assert.match(body, /followers: —   ·   stars: —   ·   Repositories: —/);
    assert.equal(body.includes(TOKEN), false);
    assert.equal(body.includes('private-canary'), false);
    assert.doesNotMatch(body, /followers: 0/);
  });
});

test('unsupported routes and methods do not access storage', async () => {
  const env = { get PROFILE_STATS() { throw new Error('must not read'); } };
  assert.equal((await worker.fetch(new Request('https://profile.example/'), env, {})).status, 404);
  const response = await worker.fetch(new Request('https://profile.example/terminal.svg', { method: 'POST' }), env, {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});
