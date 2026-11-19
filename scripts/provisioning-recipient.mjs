import { createHash, generateKeyPair, privateDecrypt, randomBytes, constants } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { collectStats, readCensus, validateSnapshot } from '../src/profile.mjs';
import { createProvisioningRelay, SYNTHETIC_VALUE } from './provisioning-relay.mjs';

const ACCOUNT_ID = '3cd944aab212b5cb1b7066e32f17b426';
const USERNAME = 'afadesigns';
const SECRET = 'GITHUB_TOKEN';
const CENSUS_SECRET = 'GITHUB_CENSUS_TOKEN';
const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const LIFETIME_MS = 15 * 60 * 1000;
const VALID_TOKEN = /^github_pat_[A-Za-z0-9_]{20,240}$/;
const VALID_CENSUS_TOKEN = /^ghp_[A-Za-z0-9]{36}$/;
const SAFE_COLLECTION_ERRORS = new Set([
  'invalid_configuration', 'missing_github_credential', 'identity_mismatch', 'census_scope_mismatch',
  'invalid_github_response', 'private_coverage_unverified', 'github_request_failed',
  'github_response_too_large', 'pagination_limit', 'incomplete_inventory',
  'invalid_pagination', 'invalid_repository_record', 'invalid_snapshot',
]);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const objectWith = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...fields].sort().join(',');

class RecipientError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireValue = (condition, code) => { if (!condition) throw new RecipientError(code); };
const makeKeyPair = () => new Promise((resolve, reject) => {
  generateKeyPair('rsa', { modulusLength: 3072, publicExponent: 65537 }, (error, publicKey, privateKey) => {
    if (error) reject(new RecipientError('key_generation_failed'));
    else resolve({ publicKey, privateKey });
  });
});

// Python reads the Node socket directly, then supplies a real anonymous pipe to cf.
// No credential appears in argv, environment, filesystem paths or child output.
const PIPE_BRIDGE = [
  'import subprocess, sys',
  'data = bytearray(sys.stdin.buffer.read(8193))',
  'if not data or len(data) > 8192:',
  "    data[:] = b'\\0' * len(data)",
  '    raise SystemExit(125)',
  'code = 125',
  'try:',
  '    code = subprocess.run(sys.argv[1:], input=data, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=False, check=False).returncode',
  'except Exception:',
  '    pass',
  'finally:',
  "    data[:] = b'\\0' * len(data)",
  'raise SystemExit(code if code >= 0 else 128 - code)',
].join('\n');

function terminate(child, processGroup = false) {
  const group = processGroup && Number.isSafeInteger(child.pid) && child.pid > 0;
  const signal = name => {
    try {
      if (group) process.kill(-child.pid, name);
      else child.kill(name);
      return true;
    } catch { return false; }
  };
  if (!signal('SIGTERM')) return;
  const timer = setTimeout(() => signal('SIGKILL'), 1000);
  // A dead Python leader does not prove that delegated cf descendants exited.
  // Keep group escalation alive through leader close and parent stdin EOF.
  if (!group) {
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
}

/** Spawn with no shell; raw output is deliberately discarded. An error may follow a write. */
export async function installWorkerSecret({ worker, value, censusToken, secret = SECRET, spawnImpl = spawn, timeoutMs = 30000 }) {
  requireValue(secret === SECRET && (
    (worker === 'github-profile-relay-stage' && value === SYNTHETIC_VALUE && censusToken === undefined) ||
    (worker === 'github-profile-prod' && typeof value === 'string' && VALID_TOKEN.test(value) &&
      typeof censusToken === 'string' && VALID_CENSUS_TOKEN.test(censusToken))
  ), 'invalid_install_target');
  const secrets = { [SECRET]: { name: SECRET, type: 'secret_text', text: value } };
  if (worker === 'github-profile-prod') {
    secrets[CENSUS_SECRET] = { name: CENSUS_SECRET, type: 'secret_text', text: censusToken };
  }
  const payload = Buffer.from(JSON.stringify({ secrets }));
  for (const entry of Object.values(secrets)) entry.text = '';
  value = '';
  censusToken = '';
  try {
    await new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let timer;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        payload.fill(0);
        if (child) terminate(child, true);
        reject(new RecipientError('install_outcome_unknown'));
      };
      try {
        child = spawnImpl('python3', [
          '-c', PIPE_BRIDGE, 'cf', 'workers', 'secrets', 'bulk', '--worker', worker,
          '--mode', 'production', '--file', '/dev/stdin',
        ], {
          cwd: PROJECT, shell: false, detached: true, stdio: ['pipe', 'ignore', 'ignore'],
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CF_SEND_TELEMETRY: 'false', DEBUG: '', WRANGLER_LOG_SANITIZE: 'true' },
        });
      } catch { fail(); return; }
      timer = setTimeout(fail, timeoutMs);
      timer.unref();
      child.once('error', fail);
      child.stdin.once('error', fail);
      child.once('close', (code, signal) => {
        if (settled) return;
        if (code !== 0 || signal) { fail(); return; }
        settled = true;
        clearTimeout(timer);
        payload.fill(0);
        resolve();
      });
      child.stdin.end(payload, () => payload.fill(0));
    });
    return { confirmed: true };
  } finally { payload.fill(0); }
}

async function captureJson(executable, args, { spawnImpl = spawn, timeoutMs = 30000 } = {}) {
  const chunks = [];
  let size = 0;
  try {
    const bytes = await new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let timer;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child) terminate(child);
        reject(new RecipientError('independent_inventory_unavailable'));
      };
      try { child = spawnImpl(executable, args, { cwd: PROJECT, shell: false, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { fail(); return; }
      timer = setTimeout(fail, timeoutMs);
      timer.unref();
      child.once('error', fail);
      child.stdout.once('error', fail);
      child.stdout.on('data', chunk => {
        if (settled) return;
        size += chunk.byteLength;
        if (size > 16 * 1024 * 1024) { fail(); return; }
        chunks.push(Buffer.from(chunk));
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        if (code !== 0 || signal) { fail(); return; }
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
    });
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw new RecipientError('independent_inventory_unavailable'); }
    finally { bytes.fill(0); }
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

/** Existing gh authentication stays in gh; only owner aggregate data leaves this function. */
export async function readIndependentInventory(options = {}) {
  const user = await captureJson('gh', ['api', '/user', '--jq', '{login,followers,public_repos}'], options);
  requireValue(user && user.login?.toLowerCase() === USERNAME && integer(user.followers) && integer(user.public_repos), 'independent_inventory_unavailable');
  const pages = await captureJson('gh', [
    'api', '--paginate', '--slurp',
    '/user/repos?affiliation=owner&visibility=all&per_page=100&page=1',
  ], options);
  requireValue(Array.isArray(pages) && pages.length > 0 && pages.length <= 100, 'independent_inventory_unavailable');
  const ids = new Set();
  let stars = 0;
  let publicCount = 0;
  for (const page of pages) {
    requireValue(Array.isArray(page) && page.length <= 100, 'independent_inventory_unavailable');
    for (const repo of page) {
      requireValue(repo && Number.isSafeInteger(repo.id) && repo.id > 0 && !ids.has(repo.id) &&
        repo.owner?.login?.toLowerCase() === USERNAME && typeof repo.private === 'boolean' &&
        integer(repo.stargazers_count), 'independent_inventory_unavailable');
      ids.add(repo.id);
      stars += repo.stargazers_count;
      if (!repo.private) publicCount++;
    }
  }
  requireValue(integer(stars) && publicCount === user.public_repos, 'independent_inventory_unavailable');
  return { username: USERNAME, followers: user.followers, stars, repositories: ids.size };
}

/** Role-bound in-memory transfers share the census preparation's original hard deadline. */
export function createProvisioningRecipient({
  now = () => Date.now(), collect = collectStats, readCensus: readCensusImpl = readCensus,
  readInventory = readIndependentInventory, installSecret = installWorkerSecret, keyPairFactory = makeKeyPair,
} = {}) {
  let session = null;
  let censusCredential = null;
  let busy = false;
  let stopped = false;

  function clearCensus() {
    if (censusCredential) censusCredential.token = '';
    censusCredential = null;
  }
  function clearKey(current) {
    if (!current) return;
    current.privateKey = null;
    if (current.timer) clearTimeout(current.timer);
    current.timer = null;
  }
  function expireSession(current) {
    if (session !== current) return;
    clearKey(current);
    clearCensus();
    if (!current.installAttempted && current.phase !== 'complete') {
      current.phase = stopped ? 'stopped' : 'expired';
    }
  }
  function expire() {
    if (censusCredential && now() >= censusCredential.expiresAt * 1000) clearCensus();
    if (session && now() >= session.expiresAt * 1000 &&
        !['complete', 'installing', 'install_unknown', 'stopped'].includes(session.phase)) {
      expireSession(session);
    }
  }
  function status() {
    expire();
    return {
      ok: true,
      phase: session?.phase ?? (stopped ? 'stopped' : 'idle'),
      ...(session ? { mode: session.mode, transferId: session.transferId, expiresAt: session.expiresAt, worker: session.worker } : {}),
      hasPrivateKey: Boolean(session?.privateKey),
      hasCensusCredential: Boolean(censusCredential?.token),
      installAttempted: Boolean(session?.installAttempted),
      requiresReconciliation: session?.phase === 'install_unknown',
      ...(session?.digest ? { digest: session.digest } : {}),
    };
  }
  function requireActive(current) {
    expire();
    requireValue(!stopped && session === current, 'recipient_stopped');
    requireValue(current.phase !== 'expired' && now() < current.expiresAt * 1000, 'transfer_expired');
    requireValue(current.privateKey, 'transfer_unavailable');
  }
  function requireCensus() {
    expire();
    requireValue(censusCredential?.token && now() < censusCredential.expiresAt * 1000, 'census_required');
    return censusCredential;
  }
  async function prepare(mode) {
    requireValue(['synthetic', 'census', 'live'].includes(mode), 'invalid_command');
    requireValue(!stopped, 'recipient_stopped');
    expire();
    requireValue(session?.phase !== 'install_unknown', 'install_outcome_unknown');
    requireValue(!session || ['complete', 'expired'].includes(session.phase) ||
      (mode === 'live' && session.phase === 'census_ready'), 'transfer_already_prepared');
    if (mode === 'live') requireCensus();
    const pair = await keyPairFactory();
    requireValue(!stopped, 'recipient_stopped');
    const start = now();
    requireValue(Number.isSafeInteger(start) && start >= 0, 'invalid_clock');
    const expiresAt = mode === 'live'
      ? requireCensus().expiresAt
      : Math.floor(start / 1000) + LIFETIME_MS / 1000;
    requireValue(expiresAt - Math.floor(start / 1000) >= 60, 'transfer_expired');
    const capability = randomBytes(32).toString('base64url');
    const settings = {
      accountId: ACCOUNT_ID,
      transferId: randomBytes(16).toString('hex'),
      publicKeySpki: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      capabilitySha256: hash(capability),
      expiresAt,
      mode,
    };
    const relay = createProvisioningRelay(settings, { now: start });
    clearKey(session);
    if (mode !== 'live') clearCensus();
    session = {
      ...settings,
      worker: mode === 'synthetic' ? 'github-profile-relay-stage' : 'github-profile-prod',
      secret: mode === 'census' ? CENSUS_SECRET : SECRET,
      privateKey: pair.privateKey, oaepLabel: relay.oaepLabel, phase: 'ready',
      installAttempted: false, timer: null,
    };
    const current = session;
    // Receiving census clears its private key but leaves this deadline running.
    // Preparing live replaces the timer without extending its absolute expiry.
    current.timer = setTimeout(() => expireSession(current), Math.max(0, expiresAt * 1000 - start));
    current.timer.unref();
    return {
      ok: true, settings, capability, worker: current.worker, secret: current.secret,
      source: relay.source, sourceSha256: relay.sourceSha256, oaepLabel: relay.oaepLabel, keyPrefix: relay.keyPrefix,
    };
  }
  async function consume(command) {
    expire();
    const current = session;
    requireValue(current, 'transfer_not_prepared');
    requireValue(!['complete', 'census_ready'].includes(current.phase), 'already_consumed');
    requireValue(current.phase !== 'install_unknown', 'install_outcome_unknown');
    requireActive(current);
    requireValue(objectWith(command, ['action', 'digest', 'envelope']) &&
      typeof command.digest === 'string' && /^[a-f0-9]{64}$/.test(command.digest), 'invalid_command');
    const envelope = command.envelope;
    requireValue(objectWith(envelope, ['schemaVersion', 'transferId', 'mode', 'expiresAt', 'ciphertext']) &&
      envelope.schemaVersion === 1 && typeof envelope.ciphertext === 'string' &&
      /^[A-Za-z0-9+/]{512}$/.test(envelope.ciphertext), 'invalid_envelope');
    requireValue(envelope.transferId === current.transferId && envelope.mode === current.mode &&
      envelope.expiresAt === current.expiresAt, 'transfer_mismatch');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    requireValue(ciphertext.length === 384 && ciphertext.toString('base64') === envelope.ciphertext, 'invalid_envelope');
    requireValue(hash(ciphertext) === command.digest, 'digest_mismatch');
    let plaintext;
    let token = '';
    let censusToken = '';
    let snapshot;
    current.phase = 'validating';
    try {
      try {
        plaintext = privateDecrypt({
          key: current.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256', oaepLabel: Buffer.from(current.oaepLabel),
        }, ciphertext);
      } catch { throw new RecipientError('decryption_failed'); }
      requireValue(plaintext.byteLength > 0 && plaintext.byteLength <= 318, 'invalid_credential');
      try { token = new TextDecoder('utf-8', { fatal: true }).decode(plaintext); }
      catch { throw new RecipientError('invalid_credential'); }
      const valid = current.mode === 'synthetic' ? token === SYNTHETIC_VALUE
        : current.mode === 'census' ? VALID_CENSUS_TOKEN.test(token)
          : current.mode === 'live' && VALID_TOKEN.test(token);
      requireValue(valid, 'invalid_credential');
      if (current.mode === 'census') {
        try { await readCensusImpl({ token, username: USERNAME }); }
        catch (error) {
          throw new RecipientError(SAFE_COLLECTION_ERRORS.has(error?.code) ? error.code : 'census_validation_failed');
        }
        requireActive(current);
        censusCredential = { token, expiresAt: current.expiresAt };
        current.privateKey = null;
        current.phase = 'census_ready';
        current.digest = command.digest;
        return {
          ok: true, installed: false, phase: 'census_ready', mode: current.mode,
          transferId: current.transferId, expiresAt: current.expiresAt,
          worker: current.worker, secret: current.secret, digest: command.digest,
        };
      }
      if (current.mode === 'live') {
        const census = requireCensus();
        try {
          snapshot = validateSnapshot(await collect({
            token, censusToken: census.token, username: USERNAME, now: () => new Date(now()),
          }), USERNAME, new Date(now()));
        } catch (error) {
          throw new RecipientError(SAFE_COLLECTION_ERRORS.has(error?.code) ? error.code : 'live_validation_failed');
        }
        requireActive(current);
        requireCensus();
        let reference;
        try { reference = await readInventory(); }
        catch { throw new RecipientError('independent_inventory_unavailable'); }
        requireValue(reference && reference.username === USERNAME &&
          ['followers', 'stars', 'repositories'].every(field => integer(reference[field]) && reference[field] === snapshot[field]),
        'independent_inventory_mismatch');
      }
      requireActive(current);
      if (current.mode === 'live') censusToken = requireCensus().token;
      // This marker precedes spawn. No retry is possible after an uncertain outcome.
      current.installAttempted = true;
      current.digest = command.digest;
      current.phase = 'installing';
      clearKey(current);
      clearCensus();
      const installed = await installSecret({
        worker: current.worker, secret: SECRET, value: token,
        ...(current.mode === 'live' ? { censusToken } : {}),
      });
      requireValue(installed?.confirmed === true, 'install_outcome_unknown');
      current.phase = 'complete';
      return {
        ok: true, installed: true, mode: current.mode, transferId: current.transferId,
        worker: current.worker, secret: SECRET, digest: command.digest,
        ...(current.mode === 'live' ? { secrets: [SECRET, CENSUS_SECRET] } : {}),
        ...(snapshot ? { snapshot } : {}),
      };
    } catch (error) {
      if (current.installAttempted) {
        clearKey(current);
        clearCensus();
        current.phase = 'install_unknown';
        throw new RecipientError('install_outcome_unknown');
      }
      expire();
      if (current.phase === 'validating') current.phase = stopped ? 'stopped' : 'ready';
      throw error;
    } finally {
      plaintext?.fill(0);
      token = '';
      censusToken = '';
      ciphertext.fill(0);
    }
  }

  return {
    async handle(command) {
      try {
        requireValue(command && typeof command === 'object' && !Array.isArray(command), 'invalid_command');
        if (command.action === 'status' && objectWith(command, ['action'])) return status();
        if (command.action === 'stop' && objectWith(command, ['action'])) {
          stopped = true;
          clearKey(session);
          clearCensus();
          // A confirmed install becomes stopped; repeated shutdown must preserve that outcome.
          if (session && session.phase !== 'stopped') {
            session.phase = session.installAttempted && session.phase !== 'complete' ? 'install_unknown' : 'stopped';
          }
          return { ...status(), stopped: true };
        }
        requireValue(['prepare', 'consume'].includes(command.action), 'invalid_command');
        requireValue(!busy, 'recipient_busy');
        if (command.action === 'prepare') requireValue(objectWith(command, ['action', 'mode']), 'invalid_command');
        busy = true;
        try { return command.action === 'prepare' ? await prepare(command.mode) : await consume(command); }
        finally { busy = false; }
      } catch (error) {
        return { ok: false, code: error instanceof RecipientError ? error.code : 'recipient_failed' };
      }
    },
  };
}

/** Bounded JSONL input stays flowing so EOF and stop can cancel awaited validation. */
export async function runRecipientProtocol({
  recipient = createProvisioningRecipient(), input = process.stdin, output = process.stdout,
} = {}) {
  const decoder = new StringDecoder('utf8');
  const queue = [];
  let pending = '';
  let oversized = false;
  let ended = false;
  let wake;
  const notify = () => { const resolve = wake; wake = null; resolve?.(); };
  const stopRecipient = () => { void recipient.handle({ action: 'stop' }); };
  const write = value => new Promise((resolve, reject) => {
    output.write(JSON.stringify(value) + '\n', error => error ? reject(new RecipientError('output_failed')) : resolve());
  });
  function rejectInput() {
    if (ended) return;
    ended = true;
    pending = '';
    queue.length = 0;
    queue.push(null);
    stopRecipient();
    input.pause();
    notify();
  }
  function line() {
    let command = null;
    if (!oversized) {
      try { command = JSON.parse(pending); } catch {}
    }
    pending = '';
    oversized = false;
    if (objectWith(command, ['action']) && command.action === 'stop') stopRecipient();
    if (queue.length >= 4) { rejectInput(); return; }
    queue.push(command);
    notify();
  }
  function consumeText(text) {
    for (const character of text) {
      if (ended) return;
      if (character === '\n') line();
      else if (!oversized) {
        pending += character;
        if (pending.length > 8192) { pending = ''; oversized = true; }
      }
    }
  }
  const onData = chunk => {
    try { consumeText(decoder.write(Buffer.from(chunk))); }
    catch { rejectInput(); }
  };
  const onEnd = () => {
    if (ended) return;
    consumeText(decoder.end());
    if (!ended && (pending || oversized)) line();
    ended = true;
    stopRecipient();
    notify();
  };
  const onClose = () => {
    if (ended) return;
    pending = '';
    ended = true;
    stopRecipient();
    notify();
  };
  input.once('end', onEnd);
  input.once('close', onClose);
  input.once('error', rejectInput);
  input.on('data', onData);
  if (input.readableEnded || input.destroyed) onClose();
  try {
    for (;;) {
      if (queue.length === 0) {
        if (ended) return;
        await new Promise(resolve => { wake = resolve; });
        continue;
      }
      const command = queue.shift();
      const result = await recipient.handle(command);
      await write(result);
      if (result.stopped === true) return;
    }
  } finally {
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
    input.removeListener('close', onClose);
    input.removeListener('error', rejectInput);
    input.pause();
    pending = '';
    queue.length = 0;
    await recipient.handle({ action: 'stop' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRecipientProtocol().catch(() => {
    process.stdout.write('{"ok":false,"code":"recipient_failed"}\n');
    process.exitCode = 1;
  });
}
