import { createHash, createPublicKey } from 'node:crypto';

export const SYNTHETIC_VALUE = 'AFADESIGN_RELAY_SYNTHETIC_V1';
const MAX_LIFETIME_SECONDS = 15 * 60;
const TARGET_WORKER = 'github-profile-prod';
const TARGET_SECRET = 'GITHUB_TOKEN';
const CENSUS_SECRET = 'GITHUB_CENSUS_TOKEN';

function browserProgram(config) {
  let capability = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const form = document.getElementById('relay-form');
  const input = document.getElementById('credential');
  const submit = document.getElementById('submit');
  const status = document.getElementById('status');
  const receipt = document.getElementById('receipt');
  const copy = document.getElementById('copy-test');
  let encrypted = null;
  let expectedDigest = null;
  let busy = false;

  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) {
    status.textContent = 'This transfer link is missing its access code.';
    form.dataset.state = 'unavailable';
    input.disabled = true;
    submit.disabled = true;
    return;
  }
  form.dataset.state = 'ready';
  if (copy) copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(config.syntheticValue);
      status.textContent = 'Test value copied. Paste it into the field.';
    } catch {
      status.textContent = 'Clipboard copy was unavailable.';
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || form.dataset.state === 'complete') return;
    busy = true;
    submit.disabled = true;
    receipt.textContent = '';
    form.dataset.state = 'submitting';
    let transferTimeout;
    try {
      if (!encrypted) {
        let raw = input.value;
        input.value = '';
        const valid = config.mode === 'synthetic'
          ? raw === config.syntheticValue
          : config.mode === 'census'
            ? /^ghp_[A-Za-z0-9]{36}$/.test(raw)
            : ['live', 'metadata-renewal'].includes(config.mode) && /^github_pat_[A-Za-z0-9_]{20,240}$/.test(raw);
        if (!valid) {
          raw = '';
          throw new Error('invalid_input');
        }
        const plaintext = new TextEncoder().encode(raw);
        raw = '';
        input.disabled = true;
        try {
          if (plaintext.byteLength > 318) throw new Error('invalid_input');
          const spki = Uint8Array.from(atob(config.publicKeySpki), char => char.charCodeAt(0));
          const key = await crypto.subtle.importKey(
            'spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'],
          );
          const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'RSA-OAEP', label: new TextEncoder().encode(config.oaepLabel) },
            key,
            plaintext,
          ));
          if (ciphertext.byteLength !== 384) throw new Error('invalid_ciphertext');
          expectedDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', ciphertext))]
            .map(byte => byte.toString(16).padStart(2, '0')).join('');
          encrypted = btoa(String.fromCharCode(...ciphertext));
        } finally {
          plaintext.fill(0);
        }
      }
      const controller = new AbortController();
      transferTimeout = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch('/submit', {
        method: 'POST',
        signal: controller.signal,
        mode: 'same-origin',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Capability': capability },
        body: JSON.stringify({ ciphertext: encrypted }),
      });
      if (response.status !== 201) throw new Error('transfer_failed');
      const result = await response.json();
      if (!result || Object.keys(result).join(',') !== 'digest' ||
          !/^[a-f0-9]{64}$/.test(result.digest) || result.digest !== expectedDigest) {
        throw new Error('invalid_receipt');
      }
      receipt.textContent = result.digest;
      status.textContent = 'Encrypted transfer received.';
      form.dataset.state = 'complete';
      capability = '';
      encrypted = null;
      expectedDigest = null;
      input.disabled = true;
      if (copy) copy.disabled = true;
    } catch {
      status.textContent = encrypted
        ? 'The transfer was not confirmed. Retry the same encrypted submission.'
        : 'The value was not accepted. Paste the correct value and try again.';
      form.dataset.state = 'error';
      if (!encrypted) input.disabled = false;
    } finally {
      clearTimeout(transferTimeout);
      busy = false;
      submit.disabled = form.dataset.state === 'complete';
    }
  });
}

function workerProgram(config, html, securityHeaders) {
  const encoder = new TextEncoder();
  const digestHex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const equalDigest = (left, right) => {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) {
      difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
  };
  // KV requires expiration to be at least 60 seconds ahead. Never extend the deadline.
  const acceptsSubmission = () => config.expiresAt - Math.floor(Date.now() / 1000) >= 60;
  const reply = (status, body = 'Request rejected\n', additional = {}) => new Response(body, {
    status,
    headers: { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8', ...additional },
  });
  async function readBoundedBody(request) {
    const length = request.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2048)) {
      await request.body?.cancel().catch(() => {});
      return null;
    }
    if (!request.body) return new Uint8Array();
    const reader = request.body.getReader();
    const chunks = [];
    let lengthRead = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lengthRead += value.byteLength;
        if (lengthRead > 2048) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(lengthRead);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        if (url.search) return reply(404);
        if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method)) {
          if (!acceptsSubmission()) return reply(410, 'Transfer expired\n');
          return reply(200, request.method === 'HEAD' ? null : html, {
            'Content-Type': 'text/html; charset=utf-8',
          });
        }
        if (url.pathname !== '/submit') return reply(404);
        if (request.method !== 'POST') return reply(405, 'Method not allowed\n', { Allow: 'POST' });
        if (!acceptsSubmission()) return reply(410, 'Transfer expired\n');
        if (request.headers.get('origin') !== url.origin) return reply(403);
        const fetchSite = request.headers.get('sec-fetch-site');
        if (fetchSite !== null && fetchSite !== 'same-origin') return reply(403);
        if (request.headers.get('content-type') !== 'application/json') return reply(415);
        const capability = request.headers.get('x-relay-capability') ?? '';
        if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) return reply(403);
        if (!equalDigest(await digestHex(encoder.encode(capability)), config.capabilitySha256)) return reply(403);
        const bytes = await readBoundedBody(request);
        if (bytes === null) return reply(413);
        let body;
        try {
          body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          return reply(400);
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).join(',') !== 'ciphertext' ||
            typeof body.ciphertext !== 'string' || !/^[A-Za-z0-9+/]{512}$/.test(body.ciphertext)) {
          return reply(400);
        }
        const ciphertext = Uint8Array.from(atob(body.ciphertext), char => char.charCodeAt(0));
        if (ciphertext.byteLength !== 384 || btoa(String.fromCharCode(...ciphertext)) !== body.ciphertext) {
          return reply(400);
        }
        const digest = await digestHex(ciphertext);
        if (!acceptsSubmission()) return reply(410, 'Transfer expired\n');
        await env.RELAY_KV.put(config.keyPrefix + digest, JSON.stringify({
          schemaVersion: 1,
          transferId: config.transferId,
          mode: config.mode,
          expiresAt: config.expiresAt,
          ciphertext: body.ciphertext,
        }), { expiration: config.expiresAt });
        return reply(201, JSON.stringify({ digest }), { 'Content-Type': 'application/json' });
      } catch {
        return reply(500, 'Transfer failed\n');
      }
    },
  };
}

/** Build a temporary encrypted relay. Caller deploys with observability/logging disabled.
 * KV is an idempotent ciphertext mailbox, not an atomic one-use primitive.
 * The recipient must enforce expiry, OAEP label, mode, token validation and one successful consumption.
 */
export function createProvisioningRelay(settings, { now = Date.now() } = {}) {
  const expectedFields = ['accountId', 'capabilitySha256', 'expiresAt', 'mode', 'publicKeySpki', 'transferId'];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      Object.keys(settings).sort().join(',') !== expectedFields.join(',')) {
    throw new Error('Invalid relay settings');
  }
  const { transferId, accountId, publicKeySpki, capabilitySha256, expiresAt, mode } = settings;
  if (!/^[a-f0-9]{32}$/.test(transferId) || !/^[a-f0-9]{32}$/.test(accountId) ||
      !/^[a-f0-9]{64}$/.test(capabilitySha256) || !['synthetic', 'census', 'live', 'metadata-renewal'].includes(mode) ||
      !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt)) {
    throw new Error('Invalid relay settings');
  }
  const nowSeconds = Math.floor(now / 1000);
  if (expiresAt - nowSeconds < 60 || expiresAt - nowSeconds > MAX_LIFETIME_SECONDS) {
    throw new Error('Relay lifetime must be between 60 and 900 seconds');
  }
  if (typeof publicKeySpki !== 'string' || publicKeySpki.length > 1500 ||
      Buffer.from(publicKeySpki, 'base64').toString('base64') !== publicKeySpki) {
    throw new Error('Invalid RSA public key');
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: Buffer.from(publicKeySpki, 'base64'), type: 'spki', format: 'der' });
  } catch {
    throw new Error('Invalid RSA public key');
  }
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails?.modulusLength !== 3072 ||
      publicKey.asymmetricKeyDetails.publicExponent !== 65537n) {
    throw new Error('RSA-OAEP requires the reviewed 3072-bit public key');
  }
  const oaepLabel = JSON.stringify({
    protocol: 'afadesigns-provisioning-relay-v1',
    transferId,
    accountId,
    worker: TARGET_WORKER,
    secret: mode === 'census' ? CENSUS_SECRET : TARGET_SECRET,
    mode,
    expiresAt,
  });
  const keyPrefix = 'relay:' + transferId + ':';
  const script = '(' + browserProgram.toString() + ')(' + JSON.stringify({
    publicKeySpki, oaepLabel, mode, syntheticValue: SYNTHETIC_VALUE,
  }) + ');';
  const style = 'body{font:16px system-ui,sans-serif;max-width:640px;margin:64px auto;padding:24px;color:#e8e8e8;background:#141414}input,button{box-sizing:border-box;font:inherit;padding:12px;margin:8px 0}input{display:block;width:100%}button{cursor:pointer}button:disabled{cursor:default}output{display:block;overflow-wrap:anywhere;font:13px monospace;margin-top:20px}';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AFADesign secure transfer</title><style>' +
    style + '</style></head><body><h1>' + (mode === 'synthetic' ? 'Secure transfer test' : mode === 'census' ? 'GitHub profile census transfer' : 'GitHub credential transfer') +
    '</h1><p>The value is encrypted in this browser before submission.</p><form id="relay-form" autocomplete="off">' +
    '<label for="credential">' + (mode === 'synthetic' ? 'Test value' : mode === 'census' ? 'GitHub classic token (read:user only)' : 'GitHub fine-grained personal access token') + '</label>' +
    '<input id="credential" type="password" autocomplete="off" autocapitalize="off" spellcheck="false">' +
    (mode === 'synthetic' ? '<button id="copy-test" type="button">Copy test value</button> ' : '') +
    '<button id="submit" type="submit">Transfer</button></form><p id="status" role="status">Paste the value to transfer.</p>' +
    '<output id="receipt" aria-label="Transfer receipt"></output><script>' + script + '</script></body></html>';
  const hash = value => createHash('sha256').update(value).digest('base64');
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; script-src 'sha256-" + hash(script) +
      "'; style-src 'sha256-" + hash(style) +
      "'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
  };
  const workerConfig = { transferId, capabilitySha256, mode, expiresAt, keyPrefix };
  const source = 'export default (' + workerProgram.toString() + ')(' +
    JSON.stringify(workerConfig) + ',' + JSON.stringify(html) + ',' + JSON.stringify(headers) + ');\n';
  return {
    source,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    oaepLabel,
    keyPrefix,
    expiresAt,
    mode,
  };
}
