import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { createProvisioningRelay, SYNTHETIC_VALUE } from '../scripts/provisioning-relay.mjs';

const NOW = Date.now();
const CAPABILITY = 'A'.repeat(43);
const PAIR = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 65537 });
const PUBLIC = PAIR.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const SETTINGS = {
  transferId: 'a'.repeat(32),
  accountId: 'b'.repeat(32),
  publicKeySpki: PUBLIC,
  capabilitySha256: createHash('sha256').update(CAPABILITY).digest('hex'),
  expiresAt: Math.floor(NOW / 1000) + 600,
  mode: 'synthetic',
};
const ORIGIN = 'https://relay.example';
const CANARY = 'github_pat_' + 'SyntheticCanaryOnly'.repeat(4);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureCiphertext = Buffer.alloc(384, 7).toString('base64');
async function fixture(overrides = {}, options = { now: NOW }) {
  const result = createProvisioningRelay({ ...SETTINGS, ...overrides }, options);
  const worker = (await import('data:text/javascript;base64,' + Buffer.from(result.source).toString('base64'))).default;
  const puts = [];
  const env = { RELAY_KV: { put: async (...args) => puts.push(args) } };
  return { ...result, worker, env, puts };
}
function request(body = JSON.stringify({ ciphertext: fixtureCiphertext }), headers = {}) {
  return new Request(ORIGIN + '/submit', {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'X-Relay-Capability': CAPABILITY,
      ...headers,
    },
    body,
  });
}
async function ui(f, customFetch, timers = { setTimeout, clearTimeout }) {
  const response = await f.worker.fetch(new Request(ORIGIN + '/'), f.env);
  const html = await response.text();
  const script = html.match(/<script>([\s\S]+)<\/script>/)[1];
  const nodes = Object.fromEntries(['relay-form', 'credential', 'submit', 'status', 'receipt', 'copy-test'].map(id => [id, {
    value: '', textContent: '', disabled: false, dataset: {}, listeners: {},
    addEventListener(event, fn) { this.listeners[event] = fn; },
  }]));
  const calls = [];
  const history = [];
  const clipboard = [];
  vm.runInNewContext(script, {
    document: { getElementById: id => nodes[id] },
    location: { hash: '#' + CAPABILITY, pathname: '/' },
    history: { replaceState: (...args) => history.push(args) },
    navigator: { clipboard: { writeText: async value => clipboard.push(value) } },
    TextEncoder, Uint8Array, atob, btoa, crypto: webcrypto, AbortController,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.equal(history.length, 1, 'Capability fragment must already be removed.');
      assert.equal(nodes.credential.value, '', 'Raw input must be cleared before networking.');
      if (customFetch) return customFetch(url, options);
      const bytes = Buffer.from(JSON.parse(options.body).ciphertext, 'base64');
      return Response.json({ digest: digest(bytes) }, { status: 201 });
    },
  });
  return {
    nodes, calls, history, clipboard, html,
    submit: async value => {
      if (value !== undefined) nodes.credential.value = value;
      await nodes['relay-form'].listeners.submit({ preventDefault() {} });
    },
  };
}
async function decrypt(value, label) {
  const key = await webcrypto.subtle.importKey(
    'jwk', PAIR.privateKey.export({ format: 'jwk' }),
    { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt'],
  );
  return new TextDecoder().decode(await webcrypto.subtle.decrypt(
    { name: 'RSA-OAEP', label: new TextEncoder().encode(label) },
    key, Buffer.from(value, 'base64'),
  ));
}

test('generator validates settings, RSA size, deadline, and binds destination plus mode', async () => {
  const f = await fixture();
  assert.equal(f.sourceSha256, digest(f.source));
  assert.equal(f.keyPrefix, 'relay:' + SETTINGS.transferId + ':');
  assert.deepEqual(JSON.parse(f.oaepLabel), {
    protocol: 'afadesigns-provisioning-relay-v1',
    transferId: SETTINGS.transferId, accountId: SETTINGS.accountId,
    worker: 'github-profile-prod', secret: 'GITHUB_TOKEN',
    mode: 'synthetic', expiresAt: SETTINGS.expiresAt,
  });
  for (const patch of [
    { transferId: '../other' }, { accountId: 'wrong' }, { capabilitySha256: CAPABILITY },
    { mode: 'other' }, { expiresAt: Math.floor(NOW / 1000) + 901 },
    { expiresAt: Math.floor(NOW / 1000) + 59 }, { expiresAt: 1.5 },
    { publicKeySpki: 'not a public key' }, { unexpected: 'field' },
  ]) assert.throws(() => createProvisioningRelay({ ...SETTINGS, ...patch }, { now: NOW }));
  const smaller = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
    .export({ type: 'spki', format: 'der' }).toString('base64');
  assert.throws(() => createProvisioningRelay({ ...SETTINGS, publicKeySpki: smaller }, { now: NOW }), /3072/);
});

test('form is uncached, script/style are hash-pinned, and no credential can be sent by native form fallback', async () => {
  const f = await fixture();
  const response = await f.worker.fetch(new Request(ORIGIN + '/'), f.env);
  const html = await response.text();
  const script = html.match(/<script>([\s\S]+)<\/script>/)[1];
  const style = html.match(/<style>([\s\S]+)<\/style>/)[1];
  const csp = response.headers.get('content-security-policy');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(csp.includes("script-src 'sha256-" + createHash('sha256').update(script).digest('base64') + "'"));
  assert.ok(csp.includes("style-src 'sha256-" + createHash('sha256').update(style).digest('base64') + "'"));
  assert.ok(csp.includes("connect-src 'self'"));
  assert.ok(csp.includes("form-action 'none'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  const input = html.match(/<input[^>]+>/)[0];
  assert.match(input, /type="password"/);
  assert.doesNotMatch(input, /\bname=/);
  assert.doesNotMatch(f.source, /\bconsole\.(?:log|error|warn|info)/);
  assert.equal(f.source.includes(CAPABILITY), false);
  assert.equal(await (await f.worker.fetch(new Request(ORIGIN + '/', { method: 'HEAD' }), f.env)).text(), '');
  assert.equal((await f.worker.fetch(new Request(ORIGIN + '/anything'), f.env)).status, 404);
  assert.equal((await f.worker.fetch(new Request(ORIGIN + '/?cap=value'), f.env)).status, 404);
});

test('submission stores only authenticated bounded ciphertext under a digest key with fixed expiration', async () => {
  const f = await fixture();
  const expectedDigest = digest(Buffer.from(fixtureCiphertext, 'base64'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await f.worker.fetch(request(), f.env);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { digest: expectedDigest });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(f.puts.length, 2, 'KV is idempotent mailbox storage, not an atomic one-use assertion.');
  assert.deepEqual(f.puts[0], f.puts[1]);
  const [key, value, options] = f.puts[0];
  assert.equal(key, f.keyPrefix + expectedDigest);
  assert.deepEqual(JSON.parse(value), {
    schemaVersion: 1, transferId: SETTINGS.transferId, mode: 'synthetic',
    expiresAt: SETTINGS.expiresAt, ciphertext: fixtureCiphertext,
  });
  assert.deepEqual(options, { expiration: SETTINGS.expiresAt });
  assert.equal(value.includes(CAPABILITY), false);
  assert.equal((await f.worker.fetch(new Request(ORIGIN + '/submit'), f.env)).status, 405);
});

test('unauthorized, cross-origin, malformed, oversized and expired requests never write storage', async () => {
  const f = await fixture();
  for (const [req, expected] of [
    [request(undefined, { Origin: 'https://other.example' }), 403],
    [request(undefined, { Origin: '' }), 403],
    [request(undefined, { 'Sec-Fetch-Site': 'cross-site' }), 403],
    [request(undefined, { 'X-Relay-Capability': 'B'.repeat(43) }), 403],
    [request(undefined, { 'Content-Type': 'text/plain' }), 415],
    [request('{broken'), 400],
    [request(JSON.stringify({ ciphertext: fixtureCiphertext, token: CANARY })), 400],
    [request(JSON.stringify({ ciphertext: Buffer.alloc(383).toString('base64') })), 400],
    [request(JSON.stringify({ ciphertext: '_'.repeat(512) })), 400],
    [request('x'.repeat(2049)), 413],
    [request(undefined, { 'Content-Length': '9999' }), 413],
  ]) {
    const response = await f.worker.fetch(req, f.env);
    assert.equal(response.status, expected);
    assert.equal((await response.text()).includes(CANARY), false);
  }
  assert.equal(f.puts.length, 0);
  const expired = await fixture(
    { expiresAt: Math.floor(NOW / 1000) - 1 },
    { now: NOW - 600_000 },
  );
  assert.equal((await expired.worker.fetch(request(), expired.env)).status, 410);
  assert.equal((await expired.worker.fetch(new Request(ORIGIN + '/'), expired.env)).status, 410);
  assert.equal(expired.puts.length, 0);
  const failing = await f.worker.fetch(request(), { RELAY_KV: { put: async () => { throw new Error(CANARY); } } });
  assert.equal(failing.status, 500);
  assert.equal((await failing.text()).includes(CANARY), false);
});

test('synthetic browser flow copies only dummy, encrypts locally, clears input and presents digest only', async () => {
  const f = await fixture();
  const browser = await ui(f);
  await browser.nodes['copy-test'].listeners.click();
  assert.deepEqual(browser.clipboard, [SYNTHETIC_VALUE]);
  await browser.submit(SYNTHETIC_VALUE);
  assert.equal(browser.calls.length, 1);
  assert.equal(browser.calls[0].url, '/submit');
  const options = browser.calls[0].options;
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.body.includes(SYNTHETIC_VALUE), false);
  const ciphertext = JSON.parse(options.body).ciphertext;
  assert.equal(Buffer.from(ciphertext, 'base64').length, 384);
  assert.equal(await decrypt(ciphertext, f.oaepLabel), SYNTHETIC_VALUE);
  assert.equal(browser.nodes.credential.value, '');
  assert.match(browser.nodes.receipt.textContent, /^[a-f0-9]{64}$/);
  assert.equal(browser.nodes['relay-form'].dataset.state, 'complete');
  assert.equal(browser.nodes.submit.disabled, true);
  await browser.submit(SYNTHETIC_VALUE);
  assert.equal(browser.calls.length, 1, 'Completion must not dispatch another transfer.');
  await assert.rejects(decrypt(ciphertext, f.oaepLabel + '-other'));
});

test('mode checks reject wrong plaintext, live canary is encrypted, and uncertain retry reuses exact ciphertext', async () => {
  const synthetic = await ui(await fixture());
  await synthetic.submit(CANARY);
  assert.equal(synthetic.calls.length, 0);
  assert.equal(synthetic.nodes.credential.value, '');
  const live = await fixture({ mode: 'live' });
  const browser = await ui(live);
  await browser.submit(SYNTHETIC_VALUE);
  assert.equal(browser.calls.length, 0);
  await browser.submit('ghp_' + 'SyntheticClassicCanary'.repeat(3));
  assert.equal(browser.calls.length, 0, 'Classic PATs must be refused.');
  await browser.submit(CANARY);
  assert.equal(browser.calls.length, 1);
  assert.equal(browser.calls[0].options.body.includes(CANARY), false);
  assert.equal(await decrypt(JSON.parse(browser.calls[0].options.body).ciphertext, live.oaepLabel), CANARY);
  let attempts = 0;
  const retry = await ui(await fixture(), async (_url, options) => {
    if (++attempts === 1) return new Response('uncertain', { status: 500 });
    return Response.json({ digest: digest(Buffer.from(JSON.parse(options.body).ciphertext, 'base64')) }, { status: 201 });
  });
  await retry.submit(SYNTHETIC_VALUE);
  await retry.submit();
  assert.equal(retry.calls.length, 2);
  assert.equal(retry.calls[0].options.body, retry.calls[1].options.body);
  assert.equal(retry.nodes['relay-form'].dataset.state, 'complete');
});

test('a mismatched receipt keeps the exact ciphertext available for retry', async () => {
  let attempts = 0;
  const browser = await ui(await fixture(), async (_url, options) => {
    const expected = digest(Buffer.from(JSON.parse(options.body).ciphertext, 'base64'));
    const mismatched = (expected[0] === '0' ? '1' : '0') + expected.slice(1);
    return Response.json({ digest: ++attempts === 1 ? mismatched : expected }, { status: 201 });
  });
  await browser.submit(SYNTHETIC_VALUE);
  assert.equal(browser.nodes['relay-form'].dataset.state, 'error');
  assert.equal(browser.nodes.receipt.textContent, '');
  assert.equal(browser.nodes.submit.disabled, false);
  assert.equal(browser.nodes.credential.disabled, true);
  await browser.submit();
  assert.equal(browser.calls.length, 2);
  assert.equal(browser.calls[0].options.body, browser.calls[1].options.body);
  assert.equal(browser.nodes['relay-form'].dataset.state, 'complete');
  assert.equal(browser.nodes.receipt.textContent,
    digest(Buffer.from(JSON.parse(browser.calls[0].options.body).ciphertext, 'base64')));
});

test('a stalled submission is aborted on deadline and retries the same ciphertext', async () => {
  const scheduled = new Map();
  let timerId = 0;
  const timers = {
    setTimeout(callback, delay) {
      const id = ++timerId;
      scheduled.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { scheduled.delete(id); },
  };
  let started;
  let rejectPending;
  const firstFetch = new Promise(resolve => { started = resolve; });
  let attempts = 0;
  const browser = await ui(await fixture(), async (_url, options) => {
    if (++attempts === 1) {
      started();
      if (!options.signal) return new Response('Missing abort signal', { status: 500 });
      return new Promise((_resolve, reject) => {
        rejectPending = reject;
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    return Response.json({
      digest: digest(Buffer.from(JSON.parse(options.body).ciphertext, 'base64')),
    }, { status: 201 });
  }, timers);
  const pending = browser.submit(SYNTHETIC_VALUE);
  await firstFetch;
  try {
    assert.ok(browser.calls[0].options.signal instanceof AbortSignal);
    assert.equal(browser.nodes.submit.disabled, true);
    assert.equal(scheduled.size, 1);
    const deadline = [...scheduled.values()][0];
    assert.equal(deadline.delay, 15_000);
    deadline.callback();
    await pending;
    assert.equal(browser.calls[0].options.signal.aborted, true);
    assert.equal(scheduled.size, 0, 'Failure must clear the deadline timer.');
    assert.equal(browser.nodes['relay-form'].dataset.state, 'error');
    assert.equal(browser.nodes.receipt.textContent, '');
    assert.equal(browser.nodes.submit.disabled, false);
    assert.equal(browser.nodes.credential.disabled, true);
    await browser.submit();
    assert.equal(browser.calls.length, 2);
    assert.equal(browser.calls[0].options.body, browser.calls[1].options.body);
    assert.equal(browser.calls[1].options.signal.aborted, false);
    assert.equal(browser.nodes['relay-form'].dataset.state, 'complete');
    assert.equal(scheduled.size, 0, 'Success must clear the deadline timer.');
  } finally {
    rejectPending?.(new Error('test_cleanup'));
    await pending;
  }
});



test('metadata renewal has a distinct OAEP role and accepts only the repository token', async () => {
  const f = await fixture({ mode: 'metadata-renewal' });
  const label = JSON.parse(f.oaepLabel);
  assert.equal(label.mode, 'metadata-renewal');
  assert.equal(label.secret, 'GITHUB_TOKEN');
  assert.equal(label.worker, 'github-profile-prod');
  const browser = await ui(f);
  await browser.submit('ghp_' + 'SyntheticCensusCanary'.padEnd(36, 'X'));
  await browser.submit(SYNTHETIC_VALUE);
  assert.equal(browser.calls.length, 0);
  await browser.submit(CANARY);
  const ciphertext = JSON.parse(browser.calls[0].options.body).ciphertext;
  assert.equal(await decrypt(ciphertext, f.oaepLabel), CANARY);
  await assert.rejects(decrypt(ciphertext, JSON.stringify({ ...label, mode: 'live' })));
  assert.equal(browser.calls[0].options.body.includes(CANARY), false);
});

test('census transfer binds a separate fixed secret and accepts only its classic-token role', async () => {
  const classic = 'ghp_' + 'SyntheticCensusCanary'.padEnd(36, 'X');
  const census = await fixture({ mode: 'census' });
  const label = JSON.parse(census.oaepLabel);
  assert.equal(label.secret, 'GITHUB_CENSUS_TOKEN');
  assert.equal(label.worker, 'github-profile-prod');
  assert.equal(label.mode, 'census');
  const browser = await ui(census);
  await browser.submit(CANARY);
  await browser.submit(SYNTHETIC_VALUE);
  assert.equal(browser.calls.length, 0, 'Neither a repository token nor a dummy belongs in census mode.');
  await browser.submit(classic);
  assert.equal(browser.calls.length, 1);
  const ciphertext = JSON.parse(browser.calls[0].options.body).ciphertext;
  assert.equal(await decrypt(ciphertext, census.oaepLabel), classic);
  await assert.rejects(decrypt(ciphertext, JSON.stringify({ ...label, secret: 'GITHUB_TOKEN' })));
  assert.equal(browser.calls[0].options.body.includes(classic), false);
  assert.equal(browser.nodes.credential.value, '');
  assert.equal(browser.nodes['relay-form'].dataset.state, 'complete');
});
