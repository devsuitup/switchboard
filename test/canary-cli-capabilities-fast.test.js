'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require("node:child_process");
const harness = require("../scripts/canary-cli-capabilities");
const script = path.resolve(__dirname, "../scripts/canary-cli-capabilities.js");

function freshHarness(t) {
  const cached = require.cache[require.resolve(script)];
  delete require.cache[require.resolve(script)];
  const isolated = require(script);
  require.cache[require.resolve(script)] = cached;
  return isolated;
}

function receiptFixture(from = 'uds:/tmp/child.sock', origin = undefined) {
  const nonce = 'nonce-fixture';
  const element = `<cross-session-message from="${from}" from-name="child" from-mode="prompting">\n${nonce}\n</cross-session-message>`;
  const row = { type: 'user', _offset: 100, message: { content: `Another Claude session sent a message:\n${element}\n` },
    ...(origin === undefined ? {} : { origin: { name: 'child', body: nonce, ...origin } }) };
  return { nonce, element, row, endpoint: { scheme: 'uds:', pathSha256: crypto.createHash('sha256').update('/tmp/child.sock').digest('hex') } };
}

for (const peer of [undefined, 23, 42]) {
  test(`GIVEN unknown sender endpoint and peer pid ${peer} WHEN parsing THEN only the owned child's verified pid authenticates`, () => {
    const f = receiptFixture('windows-inbox:child-id', peer === undefined ? undefined : { verifiedPeerPid: peer });
    const receipt = harness.nativeReceipt(f.row, 'child', f.nonce, null, 42);
    assert.equal(!!receipt, peer === 42);
  });
}

test('GIVEN real enqueue element WHEN matching receipt THEN wrapper text is irrelevant and controls remain strict', () => {
  const f = receiptFixture();
  const receipt = harness.nativeReceipt(f.row, 'child', f.nonce, f.endpoint, 42);
  assert.ok(receipt);
  const enqueue = { type: 'queue-operation', operation: 'enqueue', _offset: 1, content: f.element };
  assert.equal(harness.unexpectedNonceInOrigin([enqueue, f.row], [receipt], f.nonce), false);
  assert.equal(harness.unexpectedNonceInOrigin([enqueue, f.row], [], f.nonce), true);
  assert.equal(harness.unexpectedNonceInOrigin([{ ...enqueue, content: f.element.replace('prompting', 'changed') }, f.row], [receipt], f.nonce), true);
  assert.equal(harness.unexpectedNonceInOrigin([{ ...enqueue, content: f.element.replace(f.nonce, f.nonce + 'extra') }, f.row], [receipt], f.nonce), true);
  assert.equal(harness.unexpectedNonceInOrigin([{ ...enqueue, _offset: 101 }, f.row], [receipt], f.nonce), true);
  const other = f.element.replace('child"', 'other"');
  const combined = { ...f.row, message: { content: f.row.message.content + other } };
  assert.equal(harness.unexpectedNonceInOrigin([{ ...enqueue, content: other }, combined], [harness.nativeReceipt(combined, 'child', f.nonce, f.endpoint, 42)], f.nonce), true);
});

test('GIVEN missing launch endpoint WHEN descriptor later publishes it THEN reread it before receipt authentication', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-endpoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = receiptFixture();
  fs.writeFileSync(path.join(dir, '42.json'), JSON.stringify({ pid: 42, sessionId: 'child', procStart: 'start', startedAt: 100, messagingSocketPath: '/tmp/child.sock' }));
  const child = { pid: 42, id: 'child', name: 'child', sessions: dir, preexisting: new Map(), spawnedAt: 1, procStart: 'start' };
  const endpoints = { child: null };
  assert.ok(harness.findNativeReceipt({ opts: { dryRun: true } }, child, [f.row], f.nonce, endpoints));
  assert.deepEqual(endpoints.child, f.endpoint);
});

test('GIVEN live without token file WHEN parsing THEN refuse before reading or launching the CLI', () => {
  assert.throws(() => harness.parse(['--live', '--home', 'unused', '--out', 'unused']), /--oauth-token-file/);
});

function earlyAbortFixture(t) {
  const f = oauthFixture(t);
  const fakeHome = path.join(f.root, 'account');
  fs.mkdirSync(fakeHome);
  const envKeys = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
  const old = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  for (const k of envKeys) process.env[k] = k === 'HOME' || k === 'USERPROFILE' ? fakeHome : '';
  t.after(() => { for (const k of envKeys) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; });
  t.mock.method(os, 'userInfo', () => ({ homedir: fakeHome }));
  t.mock.method(os, 'homedir', () => fakeHome);
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', file => /CLAUDE(?:\.local)?\.md$|\.claude[\\/]settings(?:\.local)?\.json$/.test(String(file)) ? false : exists(file));
  t.mock.method(require('node:child_process'), 'spawnSync', (exe, args) => ({ status: exe === 'git' && args[0] === 'init' ? 1 : 0,
    stdout: exe === 'git' ? 'a'.repeat(40) : 'fixture build 1', stderr: '' }));
  return { ...f, harness: freshHarness(t), args: ['--dry-run', '--canary', 'C1', '--home', f.opts.home, '--out', f.opts.out, '--runtime-root', f.opts.runtimeRoot] };
}

test('GIVEN fixture setup failure WHEN evidence is written THEN identity survives and no capability passes', async t => {
  const f = earlyAbortFixture(t);
  assert.equal(await f.harness.main(f.args), 1);
  const ledger = JSON.parse(fs.readFileSync(path.join(f.opts.out, 'ledger.dry-run.json')));
  const record = ledger.measurements[0];
  const evidence = JSON.parse(fs.readFileSync(path.join(f.opts.out, path.basename(path.dirname(record.evidencePath)), 'evidence.json')));
  assert.deepEqual([evidence.schemaVersion, evidence.canary, evidence.platform, evidence.platformLabel, evidence.ptyBackend],
    [1, 'C1', process.platform, 'fixture-only', 'emulated-pipes']);
  assert.equal(record.status, 'UNVERIFIED');
  assert.ok(Object.values(record.capabilities).every(v => !v));
});

test('GIVEN main throws after run creation WHEN recovering THEN leave identified evidence and an UNVERIFIED ledger record', async t => {
  const f = earlyAbortFixture(t);
  const write = fs.writeFileSync;
  let thrown = false;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (!thrown && String(file).endsWith('evidence.json')) { thrown = true; throw Object.assign(new Error('fixture write fault'), { code: 'EIO' }); }
    return write(file, ...args);
  });
  assert.equal(await f.harness.main(f.args), 2);
  assert.equal(thrown, true);
  const ledger = JSON.parse(fs.readFileSync(path.join(f.opts.out, 'ledger.dry-run.json')));
  const record = ledger.measurements[0];
  const evidence = JSON.parse(fs.readFileSync(path.join(f.opts.out, path.basename(path.dirname(record.evidencePath)), 'evidence.json')));
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.canary, 'C1');
  assert.equal(evidence.platformLabel, 'fixture-only');
  assert.equal(evidence.ptyBackend, 'emulated-pipes');
  assert.equal(evidence.platform, process.platform);
  assert.equal(record.status, 'UNVERIFIED');
});

test('GIVEN default runner WHEN collecting tests THEN fake CLI journeys are opt-in', t => {
  const subprocess = require('node:child_process');
  const calls = [];
  t.mock.method(subprocess, 'spawnSync', (_exe, args) => { calls.push(args); return { status: 0 }; });
  const runner = path.resolve(__dirname, '../scripts/run-tests.js');
  const Module = require('node:module');
  const loaded = new Module(runner, module);
  loaded.filename = runner;
  loaded.paths = module.paths;
  loaded._compile(fs.readFileSync(runner, 'utf8').replace('require.main === module', 'true').replace('process.exit(mainStatus !== 0 ? mainStatus : isolatedStatus);', 'if (mainStatus || isolatedStatus) throw new Error("runner failed");'), runner);
  const files = calls.flat().filter(arg => arg.startsWith('test')).map(file => file.replaceAll('\\', '/'));
  assert.ok(files.includes('test/canary-cli-capabilities-fast.test.js'));
  for (const file of files) assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), /await run\(t,/);
  assert.equal(require('../package.json').scripts['test:canary'], 'node --test-timeout=120000 test/canary/cli-capabilities.test.js');
});
const keys = {
  C1: ['singleTurnDelivery', 'literalTranscript', 'eligibleConfirmation'],
  C2: ['forkWorktree'],
  C3: ['extraPermissionSettings'],
  C4: ['independentSendMessage', 'sandboxChildSendMessage'],
};

function oauthFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-oauth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), runtimeRoot = path.join(root, 'runtime'), out = path.join(root, 'evidence');
  for (const dir of [path.join(home, '.claude'), runtimeRoot, out]) fs.mkdirSync(dir, { recursive: true });
  const token = 'fake-oauth-' + crypto.randomUUID();
  const oauthTokenFile = path.join(root, 'token.txt');
  fs.writeFileSync(oauthTokenFile, `  ${token}  \r\n`);
  return { root, token, opts: { home, runtimeRoot, out, oauthTokenFile } };
}

test('GIVEN OAuth token file WHEN loading THEN trim one line without mutating parent environment', t => {
  const f = oauthFixture(t);
  const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  assert.equal(harness.loadOAuthToken(f.opts), f.token);
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, before);
  assert.equal(harness.environment(f.opts.home).CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

for (const defect of ['empty', 'multiline', 'leading-line', 'missing', 'relative', 'repo', 'evidence', 'runtime', 'home', 'linked', 'credentials']) {
  test(`GIVEN OAuth ${defect} WHEN loading THEN refuse without revealing the token`, t => {
    const f = oauthFixture(t);
    if (defect === 'empty') fs.writeFileSync(f.opts.oauthTokenFile, '  \r\n');
    if (defect === 'multiline') fs.writeFileSync(f.opts.oauthTokenFile, `${f.token}\nsecond\n`);
    if (defect === 'leading-line') fs.writeFileSync(f.opts.oauthTokenFile, `\n${f.token}`);
    if (defect === 'missing') fs.unlinkSync(f.opts.oauthTokenFile);
    if (defect === 'relative') f.opts.oauthTokenFile = 'token.txt';
    const locations = { repo: path.resolve(__dirname, '..'), evidence: f.opts.out, runtime: f.opts.runtimeRoot, home: f.opts.home };
    if (locations[defect]) {
      f.opts.oauthTokenFile = path.join(locations[defect], `${defect === 'repo' ? '..' : ''}${crypto.randomUUID()}.token`);
      fs.writeFileSync(f.opts.oauthTokenFile, f.token);
      t.after(() => fs.rmSync(f.opts.oauthTokenFile, { force: true }));
    }
    if (defect === 'linked') {
      const alias = path.join(f.root, 'alias');
      fs.symlinkSync(f.opts.home, alias, process.platform === 'win32' ? 'junction' : 'dir');
      fs.writeFileSync(path.join(f.opts.home, 'token'), f.token);
      f.opts.oauthTokenFile = path.join(alias, 'token');
    }
    if (defect === 'credentials') fs.writeFileSync(path.join(f.opts.home, '.claude/.credentials.json'), '{}');
    assert.throws(() => harness.loadOAuthToken(f.opts), err => {
      assert.ok(!err.message.includes(f.token));
      return err.code === 'OAUTH_TOKEN_REFUSED';
    });
  });
}
test('GIVEN token in evidence or ledger WHEN writing THEN abort before creating or replacing the file', t => {
  const f = oauthFixture(t);
  const cached = require.cache[require.resolve(script)];
  delete require.cache[require.resolve(script)];
  const isolated = require(script);
  require.cache[require.resolve(script)] = cached;
  isolated.loadOAuthToken(f.opts);
  for (const name of ['evidence.json', 'ledger.json', 'run.log']) {
    const file = path.join(f.opts.out, name);
    assert.throws(() => isolated.save(file, { leaked: f.token }), /redaction/i);
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, 'previous');
    assert.throws(() => isolated.save(file, { leaked: f.token }), /redaction/i);
    assert.equal(fs.readFileSync(file, 'utf8'), 'previous');
  }
  assert.throws(() => isolated.save(path.join(f.opts.out, 'later.json'), { safe: true }), /redaction/i);
  assert.equal(fs.existsSync(path.join(f.opts.out, 'later.json')), false);
});
test('GIVEN delivery payload with boundary whitespace WHEN validated THEN refuse before normal delivery', () => {
  for (const text of [' leading', 'trailing\n', '\tleading', '\nbody\n', '']) {
    assert.throws(() => harness.validateDeliveryPayload(text), /boundary whitespace|empty/);
  }
  assert.equal(harness.validateDeliveryPayload('body\nwith interior spaces 😀'), 'body\nwith interior spaces 😀');
});

function n1Fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-n1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const triples = [
    { label: 'windows-conpty-bundled', platform: 'win32', backend: 'conpty-bundled' },
    { label: 'windows-conpty-inbox', platform: 'win32', backend: 'conpty-inbox' },
    { label: 'linux-unix-pty', platform: 'linux', backend: 'unix-pty' },
  ];
  const records = [];
  const dirs = [];
  for (const [i, execution] of triples.entries()) {
    const dir = path.join(root, 'docs/evidence/session-capabilities', `run-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const measurements = Object.keys(keys).map((canary, j) => {
      const evidencePath = `docs/evidence/session-capabilities/run-${i}/${canary}/evidence.json`;
      const file = path.join(root, evidencePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, dryRun: false, canary, platform: execution.platform, platformLabel: execution.label, ptyBackend: execution.backend }));
      const capabilityStatus = Object.fromEntries(keys[canary].map(k => [k, k === 'sandboxChildSendMessage' ? i === 2 ? 'FAIL' : 'NOT_APPLICABLE' : 'PASS']));
      return { sequence: j + 1, canary, status: Object.values(capabilityStatus).includes('FAIL') ? 'FAIL' : 'PASS',
        measuredAt: `2026-10-17T20:00:0${j}.000Z`, execution, baselineHead: String(i + 1).repeat(40),
        cli: { version: `2.1.${301 + i}`, build: 'fixture', sha256: 'a'.repeat(64) }, harnessRevision: 'b'.repeat(64),
        evidencePath, evidenceSha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        capabilities: Object.fromEntries(Object.entries(capabilityStatus).map(([k, s]) => [k, s === 'PASS'])), capabilityStatus, acceptedSpecBranch: null };
    });
    records.push(...measurements);
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ schemaVersion: 1, baselineHead: String(i + 1).repeat(40), measurements }));
  }
  const out = path.join(root, 'resources/session-capabilities.json');
  const consolidate = () => harness.consolidate(dirs, out, { root, baselineHead: 'c'.repeat(40) });
  return { root, triples, records, dirs, out, consolidate };
}

function legacyFixture(t, canary = 'C1') {
  const f = n1Fixture(t);
  const ledgerFile = path.join(f.dirs[0], 'ledger.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile));
  const record = ledger.measurements.find(r => r.canary === canary);
  record.status = 'UNVERIFIED';
  for (const k of keys[canary]) { record.capabilities[k] = false; record.capabilityStatus[k] = 'UNVERIFIED'; }
  const file = path.join(f.root, record.evidencePath);
  fs.writeFileSync(file, JSON.stringify({ dryRun: false, qualifiesProduction: false, failure: 'legacy setup failure' }));
  const persist = () => {
    record.evidenceSha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  };
  persist();
  return { ...f, record, file, persist };
}

for (const canary of ['C1', 'C4']) {
  test(`GIVEN legacy ${canary} setup failure WHEN consolidating THEN retain ledger-only UNVERIFIED evidence`, t => {
    const f = legacyFixture(t, canary);
    const before = fs.readFileSync(f.file);
    const ledger = f.consolidate();
    const r = ledger.measurements.find(r => r.evidencePath === f.record.evidencePath);
    assert.equal(r.evidenceIdentity, 'ledger-only');
    assert.equal(r.status, 'UNVERIFIED');
    assert.ok(Object.values(r.capabilities).every(v => !v));
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.ok(harness.readCapabilities(f.out, { root: f.root }).ledgerSha256);
  });
}

for (const defect of ['pass', 'mixed-status', 'execution', 'partial-identity', 'wrong-identity', 'dry-run']) {
  test(`GIVEN legacy ${defect} WHEN consolidating THEN refuse instead of trusting a ledger-only identity`, t => {
    const f = legacyFixture(t);
    if (defect === 'pass') { f.record.status = 'PASS'; for (const k of keys.C1) { f.record.capabilities[k] = true; f.record.capabilityStatus[k] = 'PASS'; } }
    if (defect === 'mixed-status') { f.record.capabilityStatus.literalTranscript = 'FAIL'; f.record.status = 'FAIL'; }
    if (defect === 'execution') f.record.execution.backend = 'emulated-pipes';
    if (defect === 'partial-identity') fs.writeFileSync(f.file, JSON.stringify({ dryRun: false, canary: 'C1' }));
    if (defect === 'wrong-identity') fs.writeFileSync(f.file, JSON.stringify({ schemaVersion: 1, dryRun: false, canary: 'C2', platform: 'win32', platformLabel: 'windows-conpty-bundled', ptyBackend: 'conpty-bundled' }));
    if (defect === 'dry-run') fs.writeFileSync(f.file, JSON.stringify({ dryRun: true }));
    f.persist();
    assert.throws(() => f.consolidate(), /malformed ledger/);
  });
}

test('GIVEN divergent HEAD and origin main WHEN consolidating THEN root baseline is their merge base', t => {
  const f = n1Fixture(t);
  const calls = [];
  t.mock.method(require('node:child_process'), 'spawnSync', (_exe, args) => {
    calls.push(args);
    return { status: 0, stdout: (args[0] === 'merge-base' ? 'd' : 'e').repeat(40) };
  });
  const isolated = freshHarness(t);
  assert.equal(isolated.consolidate(f.dirs, f.out, { root: f.root }).baselineHead, 'd'.repeat(40));
  assert.deepEqual(calls, [['merge-base', 'HEAD', 'origin/main']]);
});

test('GIVEN N1 tied timestamps and historical FAIL WHEN consolidating THEN preserve records and baseline with stable sequence', async t => {
  const f = n1Fixture(t);
  const file = path.join(f.dirs[0], 'ledger.json');
  const old = JSON.parse(fs.readFileSync(file));
  const record = old.measurements[0];
  delete record.capabilityStatus;
  delete record.baselineHead;
  record.status = 'FAIL';
  for (const k of keys.C1) record.capabilities[k] = false;
  fs.writeFileSync(file, JSON.stringify(old));
  const before = fs.readFileSync(file, 'utf8');
  f.consolidate();
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const ledger = JSON.parse(fs.readFileSync(f.out));
  assert.equal(ledger.baselineHead, 'c'.repeat(40));
  const expected = [...f.records.filter(r => r.evidencePath !== record.evidencePath), { ...record, baselineHead: old.baselineHead,
    capabilityStatus: Object.fromEntries(keys.C1.map(k => [k, 'FAIL'])) }].sort((a, b) => a.measuredAt.localeCompare(b.measuredAt) || a.evidencePath.localeCompare(b.evidencePath));
  assert.deepEqual(ledger.measurements, expected.map((r, i) => ({ ...r, sequence: i + 1 })));
  const result = harness.readCapabilities(f.out, { root: f.root });
  assert.equal(result.capabilities.singleTurnDelivery, false);
  assert.equal(result.capabilities.independentSendMessage, true);
  assert.equal(result.capabilities.sandboxChildSendMessage, false);
});

test('GIVEN all 42 committed Phase 0 runs WHEN consolidating through CLI THEN records stay immutable and sandbox gate stays closed', async t => {
  const root = path.resolve(__dirname, '..');
  const base = path.join(root, 'docs/evidence/session-capabilities');
  const dirs = fs.readdirSync(base).map(p => path.join(base, p)).filter(p => fs.existsSync(path.join(p, 'ledger.json')));
  assert.equal(dirs.length, 42);
  const files = dirs.flatMap(p => [path.join(p, 'ledger.json'), ...JSON.parse(fs.readFileSync(path.join(p, 'ledger.json'))).measurements.map(r => path.join(root, r.evidencePath))]);
  const before = files.map(p => fs.readFileSync(p, 'utf8'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-n1-history-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const out = path.join(temp, 'session-capabilities.json');
  const result = spawnSync(process.execPath, [script, '--consolidate', ...dirs, '--out', out], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(files.map(p => fs.readFileSync(p, 'utf8')), before);
  const ledger = JSON.parse(fs.readFileSync(out));
  assert.equal(ledger.measurements.length, 42);
  assert.equal(ledger.measurements.find(r => r.evidencePath.includes('win-bundled-C1-6e6b9263/')).evidenceIdentity, 'ledger-only');
  assert.equal(harness.readCapabilities(out).capabilities.sandboxChildSendMessage, false);
});

test('GIVEN N1 last per execution WHEN a new FAIL supersedes PASS THEN apply worst globally and retain other keys', async t => {
  const f = n1Fixture(t);
  f.consolidate();
  const ledger = JSON.parse(fs.readFileSync(f.out));
  const first = ledger.measurements.find(r => r.canary === 'C1' && r.execution.label === 'windows-conpty-inbox');
  ledger.measurements.push({ ...first, sequence: 13, measuredAt: '2026-10-17T21:00:00.000Z', status: 'FAIL',
    capabilities: { ...first.capabilities, literalTranscript: false }, capabilityStatus: { ...first.capabilityStatus, literalTranscript: 'FAIL' } });
  fs.writeFileSync(f.out, JSON.stringify(ledger));
  for (const running of f.triples) {
    const result = harness.readCapabilities(f.out, { root: f.root, ...running, version: 'unmeasured' });
    assert.equal(result.capabilityStatus.literalTranscript, 'FAIL');
    assert.equal(result.capabilities.singleTurnDelivery, true);
    assert.equal(result.capabilities.independentSendMessage, true);
    assert.equal(result.selectedSequences.C1['windows-conpty-inbox'], 13);
  }
  ledger.measurements = ledger.measurements.filter(r => r.execution.label !== 'windows-conpty-inbox');
  fs.writeFileSync(f.out, JSON.stringify(ledger));
  assert.equal(harness.readCapabilities(f.out, { root: f.root }).capabilityStatus.independentSendMessage, 'UNVERIFIED');
});

for (const defect of ['boolean', 'status', 'unknown-key', 'missing-key', 'duplicate-sequence', 'unknown-execution', 'dry-run', 'hash', 'missing-evidence', 'timestamp', 'calendar-date', 'baseline', 'not-applicable', 'windows-sandbox-pass']) {
  test(`GIVEN N1 ${defect} WHEN reading THEN reject malformed evidence`, async t => {
    const f = n1Fixture(t);
    f.consolidate();
    const ledger = JSON.parse(fs.readFileSync(f.out));
    const r = ledger.measurements[0];
    if (defect === 'boolean') r.capabilities.singleTurnDelivery = false;
    if (defect === 'status') r.status = 'FAIL';
    if (defect === 'unknown-key') r.capabilityStatus.other = 'PASS';
    if (defect === 'missing-key') delete r.capabilityStatus.literalTranscript;
    if (defect === 'duplicate-sequence') ledger.measurements[1].sequence = r.sequence;
    if (defect === 'unknown-execution') r.execution.backend = 'emulated-pipes';
    if (defect === 'dry-run') {
      const file = path.join(f.root, r.evidencePath);
      const e = JSON.parse(fs.readFileSync(file)); e.dryRun = true;
      fs.writeFileSync(file, JSON.stringify(e));
      r.evidenceSha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
    if (defect === 'hash') r.evidenceSha256 = '0'.repeat(64);
    if (defect === 'missing-evidence') fs.unlinkSync(path.join(f.root, r.evidencePath));
    if (defect === 'timestamp') r.measuredAt = 'yesterday';
    if (defect === 'calendar-date') r.measuredAt = '2026-02-31T00:00:00.000Z';
    if (defect === 'baseline') r.baselineHead = 'short';
    if (defect === 'not-applicable') r.capabilityStatus.singleTurnDelivery = 'NOT_APPLICABLE';
    if (defect === 'windows-sandbox-pass') {
      const c4 = ledger.measurements.find(r => r.canary === 'C4' && r.execution.platform === 'win32');
      c4.capabilityStatus.sandboxChildSendMessage = 'PASS';
      c4.capabilities.sandboxChildSendMessage = true;
    }
    fs.writeFileSync(f.out, JSON.stringify(ledger));
    assert.throws(() => harness.readCapabilities(f.out, { root: f.root }), /session capability evidence is unavailable/);
  });
}

test('GIVEN N1 permitted C2 branch under run directory WHEN validating THEN retain explicit measured failure', async t => {
  const f = n1Fixture(t);
  f.consolidate();
  const ledger = JSON.parse(fs.readFileSync(f.out));
  const c2 = ledger.measurements.find(r => r.canary === 'C2');
  c2.status = 'FAIL'; c2.capabilities.forkWorktree = false; c2.capabilityStatus.forkWorktree = 'FAIL';
  c2.acceptedSpecBranch = 'docs/evidence/session-capabilities/run-0/amendment.md';
  fs.writeFileSync(path.join(f.root, c2.acceptedSpecBranch), 'Synthetic permitted C2 fixture branch.');
  fs.writeFileSync(f.out, JSON.stringify(ledger));
  assert.equal(harness.readCapabilities(f.out, { root: f.root }).capabilityStatus.forkWorktree, 'FAIL');
});

for (const [label, transform, expected] of [
  ['CRLF', s => s.replaceAll('\n', '\r\n'), ['lf-to-crlf']],
  ['trailing whitespace', s => s.replace(/ +$/gm, ''), ['trailing-whitespace-removed']],
  ['truncation', s => s.slice(0, -4), ['truncation']],
  ['combined transforms', s => s.replaceAll('\t', '    ').replaceAll('\n', '\r\n').replace(/ +$/gm, ''), ['tab-to-4-spaces', 'lf-to-crlf', 'trailing-whitespace-removed']],
  ['unknown mutation', s => s.replace('text', 'other'), ['unclassified-byte-change']],
]) {
  test(`GIVEN ${label} WHEN comparing envelope body THEN all byte changes are recorded`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-storage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const payload = 'CANARY\nTAB\ttext   \nend   ';
    const stored = harness.received({ opts: { home: root } }, { message: { content: `<pasted_content id="5678">\n${transform(payload)}\n</pasted_content id="5678">\n` } }, payload);
    assert.equal(stored.literal, false);
    assert.deepEqual(stored.transformations, expected);
    assert.equal(stored.literalAfterKnownTransformations, !expected.includes('unclassified-byte-change'));
  });
}

for (const prefix of ['', '\n\n', ' \t\r\n']) {
  for (const suffix of ['\n', ' \t\r\n']) {
    test(`GIVEN escaped prefix ${JSON.stringify(prefix)} and suffix ${JSON.stringify(suffix)} WHEN unwrapping THEN body whitespace stays byte-exact`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-envelope-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const payload = '\n \t"café 東京"\n  \n';
      const stored = harness.received({ opts: { home: root } }, { message: { content: `${prefix}<pasted_content id="e7f5">\n${payload}\n</pasted_content id="e7f5">${suffix}` } }, payload);
      if (/[^\n]/.test(prefix + suffix)) {
        assert.equal(stored.wrapperPresent, false);
        assert.equal(stored.literal, false);
        return;
      }
      assert.equal(stored.wrapperPresent, true);
      assert.equal(stored.wrapperId, 'e7f5');
      assert.equal(stored.envelopePrefix, JSON.stringify(prefix).slice(1, -1));
      assert.equal(stored.envelopeSuffix, JSON.stringify(suffix).slice(1, -1));
      assert.equal(stored.storedBodyBytes, Buffer.byteLength(payload));
      assert.equal(stored.storedBodySha256, crypto.createHash('sha256').update(payload).digest('hex'));
      assert.equal(stored.literal, true);
      assert.equal(stored.literalAfterKnownTransformations, true);
      assert.deepEqual(stored.transformations, []);
    });
  }
}

test('GIVEN body ending in CR before the LF closing delimiter WHEN unwrapping THEN the CR stays in the body', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-body-cr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = '\n \t"café 東京"\n  \r';
  const stored = harness.received({ opts: { home: root } }, { message: { content: `\n\n<pasted_content id="0152">\n${payload}\n</pasted_content id="0152">\n` } }, payload);
  assert.equal(stored.literal, true);
  assert.equal(stored.storedBodyBytes, Buffer.byteLength(payload));
  assert.equal(stored.storedBodySha256, crypto.createHash('sha256').update(payload).digest('hex'));
  assert.equal(stored.envelopeSuffix, '\\n');
  assert.deepEqual(stored.transformations, []);
});

for (const width of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`GIVEN TAB expanded to ${width} spaces WHEN comparing THEN expansion width is precise`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-tab-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stored = harness.received({ opts: { home: root } }, { message: { content: 'a' + ' '.repeat(width) + 'b' } }, 'a\tb');
    assert.equal(stored.literal, false);
    assert.equal(stored.literalAfterKnownTransformations, true);
    assert.deepEqual(stored.transformations, [`tab-to-${width}-spaces`]);
  });
}

test('GIVEN mismatched closing ID WHEN comparing THEN malformed envelope stays unclassified', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-bad-envelope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stored = harness.received({ opts: { home: root } }, { message: { content: '\n\n<pasted_content id="e7f5">\nbody\n</pasted_content id="8705">\n' } }, 'body');
  assert.equal(stored.wrapperPresent, false);
  assert.equal(stored.envelopePrefix, null);
  assert.equal(stored.envelopeSuffix, null);
  assert.equal(stored.literal, false);
  assert.equal(stored.literalAfterKnownTransformations, false);
  assert.deepEqual(stored.transformations, ['unclassified-byte-change']);
});
test('GIVEN Windows launch environment WHEN cleaned THEN required host keys and updater guard survive', () => {
  const names = ['CLAUDE_CODE_GIT_BASH_PATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'USERNAME', 'SystemRoot', 'PATH'];
  const old = Object.fromEntries(names.map(k => [k, process.env[k]]));
  try {
    for (const name of names) process.env[name] = 'fixture';
    const env = harness.environment(os.tmpdir());
    for (const name of names) {
      const key = Object.keys(env).find(k => process.platform === 'win32' ? k.toLowerCase() === name.toLowerCase() : k === name);
      assert.equal(env[key], 'fixture', name);
    }
    assert.equal(env.DISABLE_AUTOUPDATER, '1');
  } finally {
    for (const name of names) if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name];
  }
});
