import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Miniflare, Response as RuntimeResponse, CorePaths, convertV4MiniflareOptions } from 'miniflare';

// Invoke explicitly against the frozen compiled entry, not src/index.mjs:
// PROFILE_WORKER_ARTIFACT=/absolute/build/entry.js node --test tests/runtime.test.mjs
const artifactInput = process.env.PROFILE_WORKER_ARTIFACT;
const workerName = 'profile-runtime-fixture';
const snapshotKey = 'github-profile:v1';
const token = 'synthetic-runtime-fixture-token';
const censusToken = 'synthetic-runtime-census-token';
const user = { id: 151975154, login: 'afadesigns', followers: 4, public_repos: 1, owned_private_repos: 1 };
const repositories = [
  { id: 201, owner: { id: user.id, login: user.login }, private: false, fork: false, stargazers_count: 3, name: 'public-fixture' },
  { id: 202, owner: { id: user.id, login: user.login }, private: true, fork: true, stargazers_count: 5, name: 'private-canary-fixture' },
];

test('compiled Worker runs with isolated workerd storage and synthetic outbound traffic', {
  skip: artifactInput ? false : 'Set PROFILE_WORKER_ARTIFACT to the frozen compiled Worker entry.',
  timeout: 45_000,
}, async t => {
  const artifact = await realpath(path.resolve(artifactInput));
  const sourceEntry = await realpath(new URL('../src/index.mjs', import.meta.url));
  assert.notEqual(artifact, sourceEntry, 'This gate requires the compiled artifact, not the source entry.');
  const configPath = process.env.PROFILE_WORKER_CONFIG ?? path.resolve(path.dirname(artifact), '../worker.config.json');
  const configBytes = await readFile(configPath);
  const configuration = JSON.parse(configBytes);
  const compatibilityDate = configuration.compatibilityDate;
  assert.equal(compatibilityDate, '2026-10-13', 'Use the reviewed compatibility date supported by the pinned workerd runtime.');
  const configSha256 = createHash('sha256').update(configBytes).digest('hex');
  const bytes = await readFile(artifact);
  const artifactSha256 = createHash('sha256').update(bytes).digest('hex');
  const directory = await mkdtemp(path.join(tmpdir(), 'afadesigns-profile-runtime-'));
  const outboundCalls = [];
  const workerLogs = [];
  let responseMode = 'failure';
  let mf;

  const outboundService = async request => {
    const url = new URL(request.url);
    const censusRequest = request.headers.get('authorization') === 'Bearer ' + censusToken;
    outboundCalls.push({ origin: url.origin, pathname: url.pathname, role: censusRequest ? 'census' : 'metadata' });
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(request.method, 'GET');
    if (censusRequest) {
      assert.ok(responseMode.startsWith('paired-'));
      assert.equal(url.pathname, '/user', 'The census token must never reach repository enumeration.');
      const payload = responseMode === 'paired-id-mismatch' ? { ...user, id: user.id + 1 } : user;
      const scopes = responseMode === 'paired-scope-invalid' ? 'read:user, repo' : 'read:user';
      return RuntimeResponse.json(payload, { headers: { 'x-oauth-scopes': scopes } });
    }
    assert.equal(request.headers.get('authorization'), 'Bearer ' + token);
    if (responseMode === 'failure') return new RuntimeResponse('synthetic upstream unavailable', { status: 503 });
    if (responseMode === 'redirect') return new RuntimeResponse(null, { status: 302, headers: { location: 'https://redirect.invalid/secret-canary' } });
    if (url.pathname === '/user') {
      const payload = responseMode === 'unverifiable' || responseMode.startsWith('paired-')
        ? { id: user.id, login: user.login, followers: user.followers, public_repos: user.public_repos }
        : user;
      return RuntimeResponse.json(payload);
    }
    if (url.pathname === '/user/repos' && url.searchParams.get('page') === '1') {
      return RuntimeResponse.json(repositories);
    }
    throw new Error('Unexpected synthetic outbound request');
  };

  const options = (enabled, paired = false) => ({
    ...convertV4MiniflareOptions({
      name: workerName,
      modules: true,
      scriptPath: artifact,
      modulesRoot: path.dirname(artifact),
      compatibilityDate,
      host: '127.0.0.1',
      port: 0,
      cf: false,
      telemetry: { enabled: false },
      unsafeRegisterWorker: false,
      unsafeTriggerHandlers: true,
      unsafeLocalExplorer: false,
      unsafeObservability: false,
      unsafeDevRegistryPath: path.join(directory, 'registry'),
      resourcePersistencePath: path.join(directory, 'storage'),
      isolatedResourcePersistencePath: path.join(directory, 'isolated'),
      resourceTmpPath: path.join(directory, 'runtime-tmp'),
      kvNamespaces: { PROFILE_STATS: 'profile-runtime-fixture' },
      bindings: { GITHUB_USERNAME: user.login, GITHUB_TOKEN: token, ...(paired ? { GITHUB_CENSUS_TOKEN: censusToken } : {}), ENABLE_REFRESH: enabled ? 'true' : 'false' },
      outboundService,
      handleStructuredLogs: entry => workerLogs.push(entry),
    }),
    unsafeEnableSharedStorage: false,
  });

  const image = init => mf.dispatchFetch('https://fixture.invalid/terminal.svg', init);
  const scheduled = () => mf.dispatchFetch(
    `https://fixture.invalid${CorePaths.SCHEDULED}?cron=${encodeURIComponent('0 * * * *')}&format=json`,
  );
  try {
    mf = new Miniflare(options(false));
    await mf.ready;
    let kv = await mf.getKVNamespace('PROFILE_STATS', workerName);

    await t.test('empty storage returns explicit unavailable GET and HEAD responses', async () => {
      const get = await image();
      const body = await get.text();
      assert.equal(get.status, 503);
      assert.equal(get.headers.get('x-profile-stats'), 'unavailable');
      assert.equal(get.headers.get('cache-control'), 'no-store');
      assert.match(body, /GitHub stats unavailable;/);
      assert.match(body, /followers: —/);
      const head = await image({ method: 'HEAD' });
      assert.equal(head.status, 503);
      assert.equal(await head.text(), '');
      assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(body)));
    });

    const original = JSON.stringify({
      schemaVersion: 1, username: user.login, followers: 12, stars: 345, repositories: 4,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await kv.put(snapshotKey, original);
    await t.test('last-good SVG has correct content, validators, and no outbound request', async () => {
      const get = await image();
      const body = await get.text();
      assert.equal(get.status, 200);
      assert.equal(get.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
      assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(get.headers.get('x-profile-stats'), 'fresh');
      assert.equal(get.headers.get('cache-control'), 'no-cache');
      assert.equal(get.headers.get('x-profile-stats-updated'), JSON.parse(original).updatedAt);
      assert.match(body, /followers: 12.*stars: 345.*Repositories: 4/);
      const head = await image({ method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      assert.equal(head.headers.get('etag'), get.headers.get('etag'));
      assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(body)));
      const conditional = await image({ headers: { 'If-None-Match': get.headers.get('etag') } });
      assert.equal(conditional.status, 304);
      assert.equal(await conditional.text(), '');
      assert.equal((await mf.dispatchFetch('https://fixture.invalid/other')).status, 404);
      assert.equal((await image({ method: 'POST' })).status, 405);
      assert.equal(outboundCalls.length, 0);
    });

    await t.test('disabled stage scheduler performs no collection', async () => {
      const result = await scheduled();
      assert.equal(result.status, 200);
      assert.equal((await result.json()).outcome, 'ok');
      assert.equal(outboundCalls.length, 0);
      assert.equal(await kv.get(snapshotKey), original);
    });

    await mf.setOptions(options(true));
    kv = await mf.getKVNamespace('PROFILE_STATS', workerName);
    await t.test('scheduled upstream failure keeps the exact last-good snapshot', async () => {
      const result = await scheduled();
      assert.equal(result.status, 500);
      assert.notEqual((await result.json()).outcome, 'ok');
      assert.equal(outboundCalls.length, 1);
      assert.equal(await kv.get(snapshotKey), original);
    });

    await t.test('scheduled redirect is rejected without following or replacing last-good counters', async () => {
      responseMode = 'redirect';
      outboundCalls.length = 0;
      const result = await scheduled();
      assert.equal(result.status, 500);
      assert.notEqual((await result.json()).outcome, 'ok');
      assert.equal(outboundCalls.length, 1);
      assert.equal(await kv.get(snapshotKey), original);
    });

    await t.test('scheduled unverified private coverage cannot replace last-good counters', async () => {
      responseMode = 'unverifiable';
      outboundCalls.length = 0;
      const result = await scheduled();
      assert.equal(result.status, 500);
      assert.notEqual((await result.json()).outcome, 'ok');
      assert.equal(outboundCalls.length, 1);
      assert.equal(await kv.get(snapshotKey), original);
    });

    await t.test('scheduled successful collection writes aggregate-only counters', async () => {
      responseMode = 'success';
      outboundCalls.length = 0;
      const result = await scheduled();
      assert.equal(result.status, 200);
      assert.equal((await result.json()).outcome, 'ok');
      const stored = await kv.get(snapshotKey);
      const snapshot = JSON.parse(stored);
      assert.deepEqual(Object.keys(snapshot).sort(), ['followers', 'repositories', 'schemaVersion', 'stars', 'updatedAt', 'username']);
      assert.equal(snapshot.followers, 4);
      assert.equal(snapshot.stars, 8);
      assert.equal(snapshot.repositories, 2);
      assert.equal(snapshot.username, user.login);
      assert.ok(Date.now() - Date.parse(snapshot.updatedAt) < 60_000);
      assert.equal(stored.includes('private-canary'), false);
      assert.equal(stored.includes(token), false);
      const body = await (await image()).text();
      assert.match(body, /followers: 4.*stars: 8.*Repositories: 2/);
      assert.equal(body.includes('private-canary'), false);
      assert.equal(body.includes(token), false);
    });


    const lastGoodBeforePair = await kv.get(snapshotKey);
    await mf.setOptions(options(true, true));
    kv = await mf.getKVNamespace('PROFILE_STATS', workerName);

    await t.test('paired census scope and identity failures preserve the last-good runtime snapshot', async () => {
      for (const mode of ['paired-scope-invalid', 'paired-id-mismatch']) {
        responseMode = mode;
        outboundCalls.length = 0;
        const result = await scheduled();
        assert.equal(result.status, 500);
        assert.notEqual((await result.json()).outcome, 'ok');
        assert.deepEqual(outboundCalls.map(call => [call.pathname, call.role]), [['/user', 'metadata'], ['/user', 'census']]);
        assert.equal(await kv.get(snapshotKey), lastGoodBeforePair);
      }
    });

    await t.test('paired scheduled collection validates independent census and keeps its token off repo requests', async () => {
      responseMode = 'paired-success';
      outboundCalls.length = 0;
      const result = await scheduled();
      assert.equal(result.status, 200);
      assert.equal((await result.json()).outcome, 'ok');
      assert.deepEqual(outboundCalls.map(call => [call.pathname, call.role]), [['/user', 'metadata'], ['/user', 'census'], ['/user/repos', 'metadata']]);
      const stored = await kv.get(snapshotKey);
      const value = JSON.parse(stored);
      assert.equal(value.repositories, 2);
      assert.equal(value.stars, 8);
      assert.equal(value.followers, 4);
      assert.equal(stored.includes(censusToken), false);
      assert.equal(stored.includes('private-canary'), false);
    });

    const logs = JSON.stringify(workerLogs);
    assert.equal(logs.includes(token), false);
    assert.equal(logs.includes(censusToken), false);
    assert.equal(logs.includes('private-canary'), false);
    assert.equal(createHash('sha256').update(await readFile(artifact)).digest('hex'), artifactSha256, 'The compiled entry changed during runtime verification.');
    assert.equal(createHash('sha256').update(await readFile(configPath)).digest('hex'), configSha256, 'The compiled Worker metadata changed during runtime verification.');
    t.diagnostic(JSON.stringify({ artifact, artifactSha256, configSha256, compatibilityDate, syntheticOnly: true, remoteBindings: false }));
  } finally {
    try {
      if (mf) await mf.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
