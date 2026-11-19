import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, publicEncrypt, constants } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn as spawnProcess } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { PassThrough, Readable, Writable } from 'node:stream';
import { SYNTHETIC_VALUE } from '../scripts/provisioning-relay.mjs';

const subject = await import('../scripts/provisioning-recipient.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const NOW = 1795041000000;
const CANARY = 'github_pat_' + 'SyntheticCanaryOnly'.repeat(4);
const CENSUS_CANARY = 'ghp_' + 'SyntheticCensusCanary'.padEnd(36, 'X');
const CENSUS = { id: 12345, username: 'afadesigns', followers: 6, publicRepos: 2, ownedPrivateRepos: 19 };
const SNAPSHOT = { schemaVersion: 1, username: 'afadesigns', followers: 6, stars: 77, repositories: 21, updatedAt: new Date(NOW).toISOString() };

function makeRecipient(overrides = {}) {
  const installs = [];
  const recipient = subject.createProvisioningRecipient({
    now: () => NOW,
    collect: async () => ({ ...SNAPSHOT }),
    readCensus: async () => ({ ...CENSUS }),
    readInventory: async () => ({ username: 'afadesigns', followers: 6, stars: 77, repositories: 21 }),
    installSecret: async request => { installs.push(request); return { confirmed: true }; },
    ...overrides,
  });
  return { recipient, installs };
}

async function receiveCensus(recipient) {
  const prepared = await prepare(recipient, 'census');
  const result = await recipient.handle(encrypted(prepared, CENSUS_CANARY));
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'census_ready');
  assert.equal(result.installed, false);
  return { prepared, result };
}

async function prepare(recipient, mode = 'synthetic') {
  const result = await recipient.handle({ action: 'prepare', mode });
  assert.equal(result.ok, true);
  return result;
}

function encrypted(prepared, plaintext = SYNTHETIC_VALUE, label = prepared.oaepLabel) {
  const ciphertext = publicEncrypt({
    key: createPublicKey({ key: Buffer.from(prepared.settings.publicKeySpki, 'base64'), type: 'spki', format: 'der' }),
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
    oaepLabel: Buffer.from(label),
  }, Buffer.from(plaintext));
  return {
    action: 'consume',
    digest: createHash('sha256').update(ciphertext).digest('hex'),
    envelope: {
      schemaVersion: 1,
      transferId: prepared.settings.transferId,
      mode: prepared.settings.mode,
      expiresAt: prepared.settings.expiresAt,
      ciphertext: ciphertext.toString('base64'),
    },
  };
}

test('recipient prepares a usable encrypted transfer without exposing private key material', async () => {
  assert.equal(typeof subject.createProvisioningRecipient, 'function', 'The bounded recipient factory must exist.');
  const { recipient } = makeRecipient();
  try {
    const result = await prepare(recipient);
    assert.equal(result.settings.expiresAt, Math.floor(NOW / 1000) + 900);
    assert.match(result.capability, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(createHash('sha256').update(result.capability).digest('hex'), result.settings.capabilitySha256);
    assert.equal(result.worker, 'github-profile-relay-stage');
    assert.equal(result.secret, 'GITHUB_TOKEN');
    assert.equal(result.sourceSha256, createHash('sha256').update(result.source).digest('hex'));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY|"privateKey"/);
    const duplicate = await recipient.handle({ action: 'prepare', mode: 'live' });
    assert.equal(duplicate.code, 'transfer_already_prepared');
  } finally { await recipient.handle({ action: 'stop' }); }
});

test('synthetic ciphertext decrypts and installs only the fixed canary exactly once', async () => {
  const { recipient, installs } = makeRecipient();
  const prepared = await prepare(recipient);
  const command = encrypted(prepared);
  const result = await recipient.handle(command);
  assert.equal(result.ok, true);
  assert.equal(result.installed, true);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].value, SYNTHETIC_VALUE);
  assert.equal(installs[0].worker, 'github-profile-relay-stage');
  assert.equal((await recipient.handle(command)).code, 'already_consumed');
  assert.equal(installs.length, 1);
  const status = await recipient.handle({ action: 'status' });
  assert.equal(status.phase, 'complete');
  assert.equal(status.hasPrivateKey, false);
  assert.equal(status.installAttempted, true);
  assert.equal(JSON.stringify({ result, status }).includes(SYNTHETIC_VALUE), false);
  await recipient.handle({ action: 'stop' });
});

test('altered digest, envelope, OAEP destination and plaintext fail before installation', async () => {
  const { recipient, installs } = makeRecipient();
  try {
    const prepared = await prepare(recipient);
    const command = encrypted(prepared);
    const cases = [
      [{ ...command, digest: '0'.repeat(64) }, 'digest_mismatch'],
      [{ ...command, envelope: { ...command.envelope, extra: true } }, 'invalid_envelope'],
      [{ ...command, envelope: { ...command.envelope, transferId: '0'.repeat(32) } }, 'transfer_mismatch'],
      [{ ...command, envelope: { ...command.envelope, mode: 'live' } }, 'transfer_mismatch'],
      [{ ...command, envelope: { ...command.envelope, expiresAt: command.envelope.expiresAt + 1 } }, 'transfer_mismatch'],
      [encrypted(prepared, SYNTHETIC_VALUE, prepared.oaepLabel + 'changed'), 'decryption_failed'],
      [encrypted(prepared, CANARY), 'invalid_credential'],
    ];
    for (const [request, code] of cases) {
      const result = await recipient.handle(request);
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
    }
    assert.equal(installs.length, 0);
    assert.equal((await recipient.handle(command)).ok, true, 'A pre-install validation failure does not consume the correct ciphertext.');
  } finally { await recipient.handle({ action: 'stop' }); }
});

test('live coverage failure is sanitized and cannot install the credential', async () => {
  const { recipient, installs } = makeRecipient({
    collect: async () => { throw Object.assign(new Error(CANARY), { code: 'private_coverage_unverified' }); },
    readInventory: async () => { assert.fail('No reference inventory after failed live coverage.'); },
  });
  try {
    await receiveCensus(recipient);
    const prepared = await prepare(recipient, 'live');
    const result = await recipient.handle(encrypted(prepared, CANARY));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'private_coverage_unverified');
    assert.equal(installs.length, 0);
    assert.equal(JSON.stringify(result).includes(CANARY), false);
    assert.equal((await recipient.handle({ action: 'status' })).installAttempted, false);
  } finally { await recipient.handle({ action: 'stop' }); }
});

test('live data must match an independent owner inventory before production installation', async () => {
  let reference = { username: 'afadesigns', followers: 6, stars: 77, repositories: 20 };
  const { recipient, installs } = makeRecipient({ readInventory: async () => reference });
  try {
    await receiveCensus(recipient);
    const prepared = await prepare(recipient, 'live');
    const command = encrypted(prepared, CANARY);
    assert.equal((await recipient.handle(command)).code, 'independent_inventory_mismatch');
    assert.equal(installs.length, 0);
    reference = { ...reference, repositories: 21 };
    const result = await recipient.handle(command);
    assert.equal(result.ok, true);
    assert.deepEqual(result.snapshot, SNAPSHOT);
    assert.equal(installs.length, 1);
    assert.equal(installs[0].worker, 'github-profile-prod');
    assert.equal(installs[0].value, CANARY);
    assert.equal(installs[0].censusToken, CENSUS_CANARY);
    assert.equal((await recipient.handle({ action: 'status' })).hasCensusCredential, false);
    assert.equal(JSON.stringify(result).includes(CENSUS_CANARY), false);
    assert.equal(JSON.stringify(result).includes(CANARY), false);
  } finally { await recipient.handle({ action: 'stop' }); }
});

test('expiry releases the private key and prevents both old and late-validated submissions', async () => {
  let clock = NOW;
  const first = makeRecipient({ now: () => clock });
  const prepared = await prepare(first.recipient);
  const command = encrypted(prepared);
  clock += 900000;
  assert.equal((await first.recipient.handle({ action: 'status' })).hasPrivateKey, false);
  assert.equal((await first.recipient.handle(command)).code, 'transfer_expired');
  assert.equal(first.installs.length, 0);
  await first.recipient.handle({ action: 'stop' });

  clock = NOW;
  const late = makeRecipient({
    now: () => clock,
    collect: async () => { clock += 900000; return { ...SNAPSHOT }; },
  });
  await receiveCensus(late.recipient);
  const livePrepared = await prepare(late.recipient, 'live');
  const result = await late.recipient.handle(encrypted(livePrepared, CANARY));
  assert.equal(result.code, 'transfer_expired');
  assert.equal(late.installs.length, 0);
  await late.recipient.handle({ action: 'stop' });
});

test('an uncertain install is never replayed or replaced by a newly prepared transfer', async () => {
  let attempted = 0;
  const { recipient } = makeRecipient({
    installSecret: async () => { attempted++; throw new Error('Possible write followed by ' + CANARY); },
  });
  const prepared = await prepare(recipient);
  const command = encrypted(prepared);
  const result = await recipient.handle(command);
  assert.equal(result.code, 'install_outcome_unknown');
  assert.equal(JSON.stringify(result).includes(CANARY), false);
  assert.equal((await recipient.handle(command)).code, 'install_outcome_unknown');
  assert.equal((await recipient.handle({ action: 'prepare', mode: 'live' })).code, 'install_outcome_unknown');
  const status = await recipient.handle({ action: 'status' });
  assert.equal(status.hasPrivateKey, false);
  assert.equal(status.requiresReconciliation, true);
  assert.equal(attempted, 1);
  await recipient.handle({ action: 'stop' });
});

test('overlapping consume commands cannot dispatch two installations', async () => {
  let finish;
  let attempts = 0;
  const { recipient } = makeRecipient({
    installSecret: async () => {
      attempts++;
      await new Promise(resolve => { finish = resolve; });
      return { confirmed: true };
    },
  });
  const prepared = await prepare(recipient);
  const command = encrypted(prepared);
  const first = recipient.handle(command);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await recipient.handle(command)).code, 'recipient_busy');
  finish();
  assert.equal((await first).ok, true);
  assert.equal(attempts, 1);
  await recipient.handle({ action: 'stop' });
});

test('cf secret installation carries plaintext only in stdin and discards command output', async () => {
  let invocation;
  let captured = '';
  const spawnImpl = (executable, args, options) => {
    invocation = { executable, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.kill = () => true;
    child.stdin.on('data', chunk => { captured += chunk.toString(); });
    child.stdin.on('finish', () => { queueMicrotask(() => child.emit('close', 0, null)); });
    return child;
  };
  const result = await subject.installWorkerSecret({ worker: 'github-profile-prod', value: CANARY, censusToken: CENSUS_CANARY, spawnImpl });
  assert.equal(result.confirmed, true);
  assert.equal(invocation.executable, 'python3');
  assert.equal(invocation.args[0], '-c');
  assert.deepEqual(invocation.args.slice(2), ['cf', 'workers', 'secrets', 'bulk', '--worker', 'github-profile-prod', '--mode', 'production', '--file', '/dev/stdin']);
  assert.equal(invocation.options.detached, true);
  assert.deepEqual(invocation.options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(invocation.options.shell, false);
  assert.equal(JSON.stringify(invocation.args).includes(CANARY), false);
  assert.equal(invocation.options.env.CLOUDFLARE_ACCOUNT_ID, '3cd944aab212b5cb1b7066e32f17b426');
  assert.equal(invocation.options.env.CF_SEND_TELEMETRY, 'false');
  assert.equal(invocation.options.env.DEBUG, '');
  assert.equal(invocation.options.env.WRANGLER_LOG_SANITIZE, 'true');
  assert.deepEqual(JSON.parse(captured), { secrets: {
    GITHUB_TOKEN: { name: 'GITHUB_TOKEN', type: 'secret_text', text: CANARY },
    GITHUB_CENSUS_TOKEN: { name: 'GITHUB_CENSUS_TOKEN', type: 'secret_text', text: CENSUS_CANARY },
  } });
  assert.equal(JSON.stringify(invocation.args).includes(CENSUS_CANARY), false);
  assert.equal(JSON.stringify(invocation.options.env).includes(CENSUS_CANARY), false);
  assert.equal(JSON.stringify(result).includes(CANARY), false);
  await assert.rejects(subject.installWorkerSecret({ worker: 'unrelated-worker', value: CANARY, spawnImpl }), /invalid_install_target/);
});

test('JSON-lines protocol rejects unknown or oversized input without echoing it and clears on EOF', async () => {
  const { recipient, installs } = makeRecipient();
  let output = '';
  await subject.runRecipientProtocol({
    recipient,
    input: Readable.from([JSON.stringify({ action: 'unknown', credential: CANARY }) + '\n' + 'x'.repeat(9000) + '\n{"action":"status"}\n']),
    output: new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } }),
  });
  const responses = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.equal(responses[0].code, 'invalid_command');
  assert.equal(responses[1].code, 'invalid_command');
  assert.ok(['idle', 'stopped'].includes(responses[2].phase));
  assert.equal(output.includes(CANARY), false);
  assert.equal(installs.length, 0);
  assert.equal((await recipient.handle({ action: 'status' })).phase, 'stopped');
});

test('independent gh inventory returns only aggregates and rejects hidden owner or duplicate errors', async () => {
  const repo = (id, isPrivate, stars, owner = 'afadesigns') => ({
    id, private: isPrivate, stargazers_count: stars, owner: { login: owner },
    name: 'private-name-must-not-leave-helper', unrelated: CANARY,
  });
  function gh(pages) {
    let call = 0;
    return (executable, args, options) => {
      assert.equal(executable, 'gh');
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
      const payload = call++ === 0 ? { login: 'afadesigns', followers: 6, public_repos: 1 } : pages;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify(payload));
        child.emit('close', 0, null);
      });
      return child;
    };
  }
  const result = await subject.readIndependentInventory({ spawnImpl: gh([[repo(1, false, 2), repo(2, true, 3)], [repo(3, true, 5)]]) });
  assert.deepEqual(result, { username: 'afadesigns', followers: 6, stars: 10, repositories: 3 });
  for (const pages of [
    [[repo(1, false, 2), repo(2, true, 3, 'other-owner')]],
    [[repo(1, false, 2), repo(1, true, 3)]],
    [[repo(1, true, 2)]],
  ]) await assert.rejects(subject.readIndependentInventory({ spawnImpl: gh(pages) }), /independent_inventory_unavailable/);
  assert.equal(JSON.stringify(result).includes(CANARY), false);
});

test('real bridge supports the pinned CLI readFileSync dev-stdin contract without a plaintext file', async () => {
  const probe = "const fs=require('node:fs');const b=fs.readFileSync('/dev/stdin');const x=JSON.parse(b);if(x.secrets.GITHUB_TOKEN.type!=='secret_text'||!x.secrets.GITHUB_TOKEN.text.startsWith('github_pat_')||x.secrets.GITHUB_CENSUS_TOKEN.type!=='secret_text'||!x.secrets.GITHUB_CENSUS_TOKEN.text.startsWith('ghp_')||Object.keys(x.secrets).length!==2)process.exit(3);b.fill(0);";
  const spawnImpl = (executable, args, options) => {
    // Replace only the external Cloudflare command; execute the actual transport.
    return executable === 'python3'
      ? spawnProcess(executable, [...args.slice(0, 2), process.execPath, '-e', probe], options)
      : spawnProcess(process.execPath, ['-e', probe], options);
  };
  const result = await subject.installWorkerSecret({ worker: 'github-profile-prod', value: CANARY, censusToken: CENSUS_CANARY, spawnImpl });
  assert.equal(result.confirmed, true);
});

test('timeout kills bridge descendants even when the leader exits before a SIGTERM-ignoring child', async () => {
  let groupId;
  const probe = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);";
  const spawnImpl = (executable, args, options) => {
    const child = spawnProcess(executable, [...args.slice(0, 2), process.execPath, '-e', probe], options);
    groupId = child.pid;
    return child;
  };
  function liveMembers() {
    return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
      try {
        const stat = readFileSync('/proc/' + name + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        return Number(fields[2]) === groupId && fields[0] !== 'Z' ? [Number(name)] : [];
      } catch { return []; }
    });
  }
  try {
    await assert.rejects(subject.installWorkerSecret({
      worker: 'github-profile-prod', value: CANARY, censusToken: CENSUS_CANARY, spawnImpl, timeoutMs: 300,
    }), /install_outcome_unknown/);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.deepEqual(liveMembers(), []);
  } finally {
    if (groupId) { try { process.kill(-groupId, 'SIGKILL'); } catch {} }
  }
});


test('live transfer cannot be prepared before a census and census receipt never installs', async () => {
  let censusCalls = 0;
  const { recipient, installs } = makeRecipient({
    readCensus: async options => {
      censusCalls++;
      assert.equal(options.token, CENSUS_CANARY);
      assert.equal(options.username, 'afadesigns');
      return { ...CENSUS };
    },
  });
  try {
    assert.equal((await recipient.handle({ action: 'prepare', mode: 'live' })).code, 'census_required');
    const { prepared, result } = await receiveCensus(recipient);
    assert.equal(prepared.secret, 'GITHUB_CENSUS_TOKEN');
    assert.equal(JSON.parse(prepared.oaepLabel).secret, 'GITHUB_CENSUS_TOKEN');
    assert.equal(censusCalls, 1);
    assert.equal(installs.length, 0);
    const status = await recipient.handle({ action: 'status' });
    assert.equal(status.phase, 'census_ready');
    assert.equal(status.hasPrivateKey, false);
    assert.equal(status.hasCensusCredential, true);
    assert.equal(status.installAttempted, false);
    assert.equal((await recipient.handle(encrypted(prepared, CENSUS_CANARY))).code, 'already_consumed');
    assert.equal((await recipient.handle({ action: 'prepare', mode: 'census' })).code, 'transfer_already_prepared');
    assert.equal(JSON.stringify({ result, status }).includes(CENSUS_CANARY), false);
  } finally { await recipient.handle({ action: 'stop' }); }
  assert.equal((await recipient.handle({ action: 'status' })).hasCensusCredential, false);
});

test('census wrong role or scope is sanitized and remains retryable only before installation', async () => {
  let allow = false;
  let censusCalls = 0;
  const { recipient, installs } = makeRecipient({
    readCensus: async () => {
      censusCalls++;
      if (!allow) throw Object.assign(new Error(CENSUS_CANARY), { code: 'census_scope_mismatch' });
      return { ...CENSUS };
    },
  });
  try {
    const prepared = await prepare(recipient, 'census');
    assert.equal((await recipient.handle(encrypted(prepared, CANARY))).code, 'invalid_credential');
    assert.equal(censusCalls, 0);
    const command = encrypted(prepared, CENSUS_CANARY);
    const result = await recipient.handle(command);
    assert.equal(result.code, 'census_scope_mismatch');
    assert.equal(JSON.stringify(result).includes(CENSUS_CANARY), false);
    assert.equal((await recipient.handle({ action: 'status' })).hasCensusCredential, false);
    assert.equal(installs.length, 0);
    allow = true;
    assert.equal((await recipient.handle(command)).phase, 'census_ready');
    const live = await prepare(recipient, 'live');
    assert.equal((await recipient.handle(encrypted(live, CENSUS_CANARY))).code, 'invalid_credential');
    assert.equal(installs.length, 0);
  } finally { await recipient.handle({ action: 'stop' }); }
});

test('paired validation retries preserve the original census deadline and both credentials', async () => {
  let clock = NOW;
  let attempts = 0;
  const { recipient, installs } = makeRecipient({
    now: () => clock,
    collect: async options => {
      assert.equal(options.token, CANARY);
      assert.equal(options.censusToken, CENSUS_CANARY);
      if (++attempts === 1) throw Object.assign(new Error(CENSUS_CANARY), { code: 'github_request_failed' });
      return { ...SNAPSHOT, updatedAt: new Date(clock).toISOString() };
    },
  });
  try {
    const census = await receiveCensus(recipient);
    clock += 120000;
    const live = await prepare(recipient, 'live');
    assert.equal(live.settings.expiresAt, census.prepared.settings.expiresAt);
    const command = encrypted(live, CANARY);
    assert.equal((await recipient.handle(command)).code, 'github_request_failed');
    assert.equal(installs.length, 0);
    assert.equal((await recipient.handle({ action: 'status' })).hasCensusCredential, true);
    const result = await recipient.handle(command);
    assert.equal(result.installed, true);
    assert.equal(installs.length, 1);
    assert.equal(installs[0].censusToken, CENSUS_CANARY);
    assert.equal((await recipient.handle({ action: 'status' })).hasCensusCredential, false);
  } finally { await recipient.handle({ action: 'stop' }); }
});

test('shared hard expiry clears a received census even without a private key or live transfer', async () => {
  let clock = NOW;
  const { recipient, installs } = makeRecipient({ now: () => clock });
  try {
    await receiveCensus(recipient);
    clock += 900000;
    const status = await recipient.handle({ action: 'status' });
    assert.equal(status.phase, 'expired');
    assert.equal(status.hasPrivateKey, false);
    assert.equal(status.hasCensusCredential, false);
    assert.equal((await recipient.handle({ action: 'prepare', mode: 'live' })).code, 'census_required');
    assert.equal(installs.length, 0);
  } finally { await recipient.handle({ action: 'stop' }); }
});

test('expiry during independent comparison prevents installation and drops the paired census', async () => {
  let clock = NOW;
  const { recipient, installs } = makeRecipient({
    now: () => clock,
    readInventory: async () => {
      clock += 900000;
      return { username: 'afadesigns', followers: 6, stars: 77, repositories: 21 };
    },
  });
  try {
    await receiveCensus(recipient);
    const prepared = await prepare(recipient, 'live');
    const result = await recipient.handle(encrypted(prepared, CANARY));
    assert.equal(result.code, 'transfer_expired');
    assert.equal(installs.length, 0);
    assert.equal((await recipient.handle({ action: 'status' })).hasCensusCredential, false);
  } finally { await recipient.handle({ action: 'stop' }); }
});

test('an uncertain paired installation clears both retained roles and cannot replay or renew', async () => {
  let attempts = 0;
  const { recipient } = makeRecipient({
    installSecret: async request => {
      attempts++;
      assert.equal(request.value, CANARY);
      assert.equal(request.censusToken, CENSUS_CANARY);
      throw new Error(CANARY + CENSUS_CANARY);
    },
  });
  try {
    await receiveCensus(recipient);
    const prepared = await prepare(recipient, 'live');
    const command = encrypted(prepared, CANARY);
    const result = await recipient.handle(command);
    assert.equal(result.code, 'install_outcome_unknown');
    assert.equal(JSON.stringify(result).includes(CENSUS_CANARY), false);
    assert.equal((await recipient.handle(command)).code, 'install_outcome_unknown');
    assert.equal((await recipient.handle({ action: 'prepare', mode: 'census' })).code, 'install_outcome_unknown');
    const status = await recipient.handle({ action: 'status' });
    assert.equal(status.hasCensusCredential, false);
    assert.equal(status.hasPrivateKey, false);
    assert.equal(status.requiresReconciliation, true);
    assert.equal(attempts, 1);
  } finally { await recipient.handle({ action: 'stop' }); }
});

test('native bulk installer rejects unpaired, swapped or synthetic census targets before spawn', async () => {
  let attempts = 0;
  const spawnImpl = () => { attempts++; assert.fail('Invalid target must not spawn.'); };
  for (const request of [
    { worker: 'github-profile-prod', value: CANARY },
    { worker: 'github-profile-prod', value: CANARY, censusToken: CANARY },
    { worker: 'github-profile-prod', value: CENSUS_CANARY, censusToken: CANARY },
    { worker: 'github-profile-prod', value: CANARY, censusToken: CENSUS_CANARY, secret: 'GITHUB_CENSUS_TOKEN' },
    { worker: 'github-profile-relay-stage', value: SYNTHETIC_VALUE, censusToken: CENSUS_CANARY },
  ]) await assert.rejects(subject.installWorkerSecret({ ...request, spawnImpl }), /invalid_install_target/);
  assert.equal(attempts, 0);
});

test('EOF during deferred live validation stops installation and releases census references', async () => {
  let started;
  let finish;
  const pending = new Promise(resolve => { started = resolve; });
  const validation = new Promise(resolve => { finish = resolve; });
  const { recipient, installs } = makeRecipient({
    collect: async () => { started(); await validation; return { ...SNAPSHOT }; },
  });
  const input = new PassThrough();
  let output = '';
  let run;
  try {
    await receiveCensus(recipient);
    const prepared = await prepare(recipient, 'live');
    run = subject.runRecipientProtocol({
      recipient, input,
      output: new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } }),
    });
    input.write(JSON.stringify(encrypted(prepared, CANARY)) + '\n');
    await pending;
    input.end();
    await new Promise(resolve => setImmediate(resolve));
    finish();
    await run;
    assert.equal(installs.length, 0);
    assert.equal((await recipient.handle({ action: 'status' })).hasCensusCredential, false);
    const result = JSON.parse(output.trim());
    assert.equal(result.code, 'recipient_stopped');
    assert.equal(output.includes(CENSUS_CANARY), false);
    assert.equal(output.includes(CANARY), false);
  } finally {
    input.destroy();
    finish();
    if (run) await run;
    await recipient.handle({ action: 'stop' });
  }
});


test('a stop line interrupts deferred validation while preserving response order', async () => {
  let started;
  let finish;
  const pending = new Promise(resolve => { started = resolve; });
  const validation = new Promise(resolve => { finish = resolve; });
  const { recipient, installs } = makeRecipient({
    collect: async () => { started(); await validation; return { ...SNAPSHOT }; },
  });
  const input = new PassThrough();
  let output = '';
  let run;
  try {
    await receiveCensus(recipient);
    const prepared = await prepare(recipient, 'live');
    run = subject.runRecipientProtocol({
      recipient, input,
      output: new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } }),
    });
    input.write(JSON.stringify(encrypted(prepared, CANARY)) + '\n');
    await pending;
    input.write('{"action":"stop"}\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await recipient.handle({ action: 'status' })).hasCensusCredential, false);
    finish();
    await run;
    assert.equal(installs.length, 0);
    const results = output.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(results[0].code, 'recipient_stopped');
    assert.equal(results[1].stopped, true);
  } finally {
    input.destroy();
    finish();
    if (run) await run;
    await recipient.handle({ action: 'stop' });
  }
});

test('flowing protocol rejects a command flood within its bounded queue and cancels validation', async () => {
  let started;
  let finish;
  const pending = new Promise(resolve => { started = resolve; });
  const validation = new Promise(resolve => { finish = resolve; });
  const { recipient, installs } = makeRecipient({
    collect: async () => { started(); await validation; return { ...SNAPSHOT }; },
  });
  const input = new PassThrough();
  let output = '';
  let run;
  try {
    await receiveCensus(recipient);
    const prepared = await prepare(recipient, 'live');
    run = subject.runRecipientProtocol({
      recipient, input,
      output: new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } }),
    });
    input.write(JSON.stringify(encrypted(prepared, CANARY)) + '\n');
    await pending;
    input.write('{"action":"status"}\n'.repeat(100));
    finish();
    await run;
    assert.equal(installs.length, 0);
    const results = output.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(results.length, 2);
    assert.equal(results[0].code, 'recipient_stopped');
    assert.equal(results[1].code, 'invalid_command');
    assert.equal((await recipient.handle({ action: 'status' })).hasCensusCredential, false);
  } finally {
    input.destroy();
    finish();
    if (run) await run;
    await recipient.handle({ action: 'stop' });
  }
});

test('hard deadline timer releases the received census without a status poll', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { recipient, installs } = makeRecipient();
  try {
    await receiveCensus(recipient);
    t.mock.timers.tick(900000);
    const status = await recipient.handle({ action: 'status' });
    assert.equal(status.phase, 'expired');
    assert.equal(status.hasCensusCredential, false);
    assert.equal(status.hasPrivateKey, false);
    assert.equal(installs.length, 0);
  } finally {
    await recipient.handle({ action: 'stop' });
    t.mock.timers.reset();
  }
});


test('confirmed installation stays reconciled through repeated stop and EOF', async () => {
  for (const termination of ['stop', 'eof']) {
    const { recipient, installs } = makeRecipient();
    try {
      await receiveCensus(recipient);
      const prepared = await prepare(recipient, 'live');
      const installed = await recipient.handle(encrypted(prepared, CANARY));
      assert.equal(installed.installed, true);
      assert.equal((await recipient.handle({ action: 'status' })).phase, 'complete');
      let output = '';
      await subject.runRecipientProtocol({
        recipient,
        input: Readable.from(termination === 'stop' ? ['{"action":"stop"}\n'] : []),
        output: new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } }),
      });
      if (termination === 'stop') {
        const response = JSON.parse(output.trim());
        assert.equal(response.stopped, true);
        assert.equal(response.requiresReconciliation, false);
      }
      for (let repetition = 0; repetition < 3; repetition++) {
        const status = await recipient.handle({ action: repetition ? 'stop' : 'status' });
        assert.equal(status.phase, 'stopped');
        assert.equal(status.installAttempted, true);
        assert.equal(status.requiresReconciliation, false);
        assert.equal(status.hasPrivateKey, false);
        assert.equal(status.hasCensusCredential, false);
      }
      assert.equal(installs.length, 1);
    } finally { await recipient.handle({ action: 'stop' }); }
  }
});

test('uncertain installation stays unreconciled through repeated stop and EOF', async () => {
  for (const termination of ['stop', 'eof']) {
    let attempts = 0;
    const { recipient } = makeRecipient({
      installSecret: async () => { attempts++; throw new Error('Unconfirmed result'); },
    });
    try {
      await receiveCensus(recipient);
      const prepared = await prepare(recipient, 'live');
      const command = encrypted(prepared, CANARY);
      assert.equal((await recipient.handle(command)).code, 'install_outcome_unknown');
      let output = '';
      await subject.runRecipientProtocol({
        recipient,
        input: Readable.from(termination === 'stop' ? ['{"action":"stop"}\n'] : []),
        output: new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } }),
      });
      if (termination === 'stop') assert.equal(JSON.parse(output.trim()).requiresReconciliation, true);
      for (let repetition = 0; repetition < 3; repetition++) {
        const status = await recipient.handle({ action: repetition ? 'stop' : 'status' });
        assert.equal(status.phase, 'install_unknown');
        assert.equal(status.requiresReconciliation, true);
        assert.equal(status.hasPrivateKey, false);
        assert.equal(status.hasCensusCredential, false);
      }
      assert.equal((await recipient.handle(command)).code, 'install_outcome_unknown');
      assert.equal(attempts, 1);
    } finally { await recipient.handle({ action: 'stop' }); }
  }
});
