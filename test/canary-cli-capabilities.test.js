'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const harness = require('../scripts/canary-cli-capabilities');

const script = path.resolve(__dirname, '../scripts/canary-cli-capabilities.js');
const accountFixture = path.resolve(__dirname, 'fixtures/session-capabilities/isolated-account.js');
const keys = {
  C1: ['singleTurnDelivery', 'literalTranscript', 'eligibleConfirmation'],
  C2: ['forkWorktree'],
  C3: ['extraPermissionSettings'],
  C4: ['independentSendMessage', 'sandboxChildSendMessage'],
};

async function run(t, args = [], options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-380-'));
  const evidenceRoot = path.resolve(__dirname, '../.work-files/380p0c/dry-runs');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const out = fs.mkdtempSync(path.join(evidenceRoot, '.dry-run-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.equal(path.dirname(out), evidenceRoot);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const realHome = path.join(root, 'fake-real-home');
  fs.mkdirSync(realHome);
  const runtime = path.join(root, 'runtime');
  options.prepare?.({ root, home, realHome, runtime });
  const result = await new Promise(resolve => execFile(process.execPath, ['--require', accountFixture, script, '--dry-run', '--canary', 'all',
    '--home', home, '--out', out, '--platform-label', 'fixture-only', ...(options.noRuntime ? [] : ['--runtime-root', runtime]), ...args,
    ...(options.homeAlias ? ['--home', options.homeAlias({ root, home, realHome })] : []),
    ...(options.extraArgs?.({ root, home, realHome, runtime }) || [])], {
    encoding: 'utf8', timeout: 110000, windowsHide: true,
    env: { ...process.env, HOME: realHome, USERPROFILE: realHome, HOMEDRIVE: '', HOMEPATH: '',
      CANARY_TEST_ACCOUNT_HOME: realHome, CANARY_TEST_SECRET: 'DO_NOT_RETAIN_THIS_VALUE', ...options.env },
  }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr,
    error: error && typeof error.code !== 'number' ? error : undefined })));
  assert.ifError(result.error);
  let ledger;
  if (fs.existsSync(path.join(out, 'ledger.dry-run.json'))) {
    ledger = JSON.parse(fs.readFileSync(path.join(out, 'ledger.dry-run.json'), 'utf8'));
  }
  return { ...result, ledger, root, home, out };
}

test('GIVEN fake CLI WHEN all canaries run THEN independently hashed N1 evidence is produced', async t => {
  let eventLoopProgressed = false;
  const pending = setImmediate(() => { eventLoopProgressed = true; });
  t.after(() => clearImmediate(pending));
  const r = await run(t);
  assert.equal(eventLoopProgressed, true, 'fake CLI wait must allow per-test timeout and progress reporting');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.ledger.schemaVersion, 1);
  assert.match(r.ledger.baselineHead, /^[0-9a-f]{40}$/);
  assert.equal(r.ledger.measurements.length, 4);
  for (const [i, record] of r.ledger.measurements.entries()) {
    assert.equal(record.sequence, i + 1);
    assert.equal(record.canary, `C${i + 1}`);
    assert.equal(record.status, 'PASS');
    assert.deepEqual(Object.keys(record.capabilities), keys[record.canary]);
    assert.ok(Object.values(record.capabilities).every(x => x === true));
    assert.equal(record.acceptedSpecBranch, null);
    assert.deepEqual(record.execution, { platform: process.platform, label: 'fixture-only', backend: 'emulated-pipes' });
    assert.ok(Number.isFinite(Date.parse(record.measuredAt)));
    assert.match(record.cli.sha256, /^[0-9a-f]{64}$/);
    assert.match(record.harnessRevision, /^[0-9a-f]{64}$/);
    assert.match(record.evidencePath, /^\.work-files\/380p0c\/dry-runs\//);
    const evidence = fs.readFileSync(path.join(__dirname, '..', record.evidencePath));
    assert.equal(crypto.createHash('sha256').update(evidence).digest('hex'), record.evidenceSha256);
    const data = JSON.parse(evidence);
    assert.equal(data.dryRun, true);
    assert.equal(data.qualifiesProduction, false);
    assert.ok(data.checks.length > 0);
    assert.ok(data.controls.length > 0);
    assert.ok(data.controls.every(x => ['PASS', 'FAIL', 'UNVERIFIED'].includes(x.status)));
    assert.ok(data.environmentKeys.includes('HOME'));
    assert.ok(!data.environmentKeys.includes('CANARY_TEST_SECRET'));
    assert.ok(!evidence.includes(Buffer.from('DO_NOT_RETAIN_THIS_VALUE')));
    assert.ok(data.processes.every(x => x.cleaned === true));
    if (record.canary === 'C4' && process.platform === 'win32') {
      assert.ok(data.reports.every(x => x.parentEnvironment.status === 'UNVERIFIED'));
      assert.ok(data.reports.every(x => x.parentEnvironment.fixtureOutcome === 'PASS'));
    }
  }
});

const mutations = {
  C1: ['split-paste', 'placeholder-no-confirmation', 'drop-byte'],
  C2: ['reuse-worktree', 'drop-sentinel', 'omit-fork'],
  C3: ['remove-deny', 'writable-settings', 'fake-denial'],
  C4: ['shared-descriptors', 'parent-env', 'wrong-control-leak', 'wrong-control-hidden-leak'],
};

test('GIVEN delayed fake fixture preparation WHEN C3 work starts THEN its requested work budget remains available', async t => {
  const r = await run(t, ['--canary', 'C3', '--platform-label', 'windows-conpty-bundled', '--timeout-ms', '20000'], { env: { CANARY_TEST_SETUP_DELAY_MS: '21000' } });
  assert.equal(r.status, 0, r.stderr + (r.ledger ? JSON.stringify(data(r)) : 'no ledger'));
  assert.equal(data(r).workBudgetMs, 20000);
  assert.ok(data(r).fixturePreparation.elapsedMs >= 21000);
  assert.equal(data(r).fixturePreparation.budgetMs, 60000);
});

test('GIVEN delayed fake native send WHEN C4 observes THEN preserve live timing separately and accept exact receipt', async t => {
  const r = await run(t, ['--canary', 'C4', '--platform-label', 'windows-conpty-bundled', '--mutation', 'send-observation-delayed']);
  assert.equal(r.status, 0, r.stderr + (r.ledger ? JSON.stringify(data(r)) : 'no ledger'));
  assert.equal(r.ledger.measurements[0].capabilityStatus.independentSendMessage, 'PASS');
  assert.equal(data(r).reports[0].observationBudgetMs, 5000);
});

test('GIVEN amended C1 WHEN fake CLI expands TAB THEN delivered boundaries and raw control are measured separately', async t => {
  const r = await run(t, ['--canary', 'C1', '--mutation', 'tab-to-spaces']);
  assert.equal(r.status, 0, r.stderr);
  const e = data(r);
  assert.deepEqual(e.payloads.map(p => p.bytes), [180, 5000, 32768, 49152, 256]);
  assert.ok(e.payloads.every(p => p.literal && p.wrapperPresent && p.openingTagLineEnding === 'LF'));
  assert.ok(e.payloads.every(p => p.inputTabs > 0 && p.deliveredTabs === 0 && p.containsEmoji));
  assert.equal(e.payloads.at(-1).whitespaceBoundary, true);
  assert.deepEqual(e.rawTabControl.transformations, ['tab-to-4-spaces']);
  assert.equal(e.rawTabControl.informational, true);
  assert.deepEqual(r.ledger.measurements[0].capabilityStatus, {
    singleTurnDelivery: 'PASS', literalTranscript: 'PASS', eligibleConfirmation: 'PASS',
  });
});

test('GIVEN exact C1 envelope with missing cache object WHEN measuring THEN cache cannot veto literalTranscript', async t => {
  const r = await run(t, ['--canary', 'C1', '--mutation', 'missing-paste-object']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.ledger.measurements[0].capabilityStatus, { singleTurnDelivery: 'PASS', literalTranscript: 'PASS', eligibleConfirmation: 'PASS' });
  assert.ok(data(r).payloads.every(p => p.literal));
});

test('GIVEN C1 placeholder with assistant reaction WHEN measuring THEN only observed storage property fails', async t => {
  const r = await run(t, ['--canary', 'C1', '--mutation', 'storage-only']);
  assert.equal(r.ledger.measurements[0].status, 'FAIL');
  assert.deepEqual(r.ledger.measurements[0].capabilityStatus, { singleTurnDelivery: 'PASS', literalTranscript: 'FAIL', eligibleConfirmation: 'PASS' });
});

test('GIVEN corrupt C1 body WHEN other properties pass THEN preserve their independent booleans', async t => {
  const r = await run(t, ['--canary', 'C1', '--mutation', 'drop-byte']);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.ledger.measurements[0].capabilityStatus, {
    singleTurnDelivery: 'PASS', literalTranscript: 'FAIL', eligibleConfirmation: 'PASS',
  });
  assert.deepEqual(r.ledger.measurements[0].capabilities, {
    singleTurnDelivery: true, literalTranscript: false, eligibleConfirmation: true,
  });
});

test('GIVEN informational raw-TAB control cannot confirm WHEN all expanded payloads passed THEN retain C1 PASS', async t => {
  const r = await run(t, ['--canary', 'C1', '--mutation', 'raw-control-no-confirmation']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.ledger.measurements[0].status, 'PASS');
  assert.equal(data(r).rawTabControl.status, 'UNVERIFIED');
  assert.equal(data(r).rawTabControl.informational, true);
});

test('GIVEN fork launched from W1 WHEN checking prepared trust THEN use repository-root worktree location', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-trust-w1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project'), home = path.join(root, 'home');
  fs.mkdirSync(home);
  const key = path.join(repo, '.claude/worktrees/named').replaceAll('\\', '/');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } }));
  const ctx = { repo, runtime: root, env: {}, opts: { home, dryRun: false },
    ptyFactory: () => { throw new Error('trust passed; fake spawn boundary reached'); } };
  await assert.rejects(harness.launch(ctx, { cwd: path.join(root, 'W1'), args: ['--resume', crypto.randomUUID(), '--fork-session', '--worktree', 'named'] }),
    /trust passed; fake spawn boundary reached/);
});

for (const label of ['windows-conpty-bundled', 'windows-conpty-inbox']) {
  test(`GIVEN ${label} WHEN C3 fake CLI runs without sandbox THEN unsandboxed cases qualify`, async t => {
    const r = await run(t, ['--canary', 'C3', '--platform-label', label]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(data(r).permissions.map(p => p.sandbox), [false, false]);
    assert.deepEqual(r.ledger.measurements[0].capabilityStatus, { extraPermissionSettings: 'PASS' });
  });
  test(`GIVEN ${label} WHEN C4 uses descriptor pipe THEN independent pair qualifies and sandbox is inapplicable`, async t => {
    const r = await run(t, ['--canary', 'C4', '--platform-label', label]);
    assert.equal(r.status, 0, r.stderr + (r.ledger ? JSON.stringify(data(r)) : 'no ledger'));
    assert.deepEqual(r.ledger.measurements[0].capabilityStatus, {
      independentSendMessage: 'PASS', sandboxChildSendMessage: 'NOT_APPLICABLE',
    });
    assert.deepEqual(r.ledger.measurements[0].capabilities, { independentSendMessage: true, sandboxChildSendMessage: false });
    assert.ok(data(r).reports.every(p => !p.sandbox));
    const p = data(r).reports[0];
    assert.equal(p.messagingEndpoints.child.scheme, 'pipe:');
    assert.equal(p.receipt.from.scheme, 'pipe:');
    assert.equal(p.receipt.from.socketPathSha256, p.messagingEndpoints.child.pathSha256);
    assert.ok(!JSON.stringify(data(r)).includes('canary-message-'));
    const late = data(r).renameAfterPromptReports[0];
    assert.equal(late.renamedAfterPrompt, true);
    assert.equal(late.sendResults[0].unreachableRecipient, true);
    assert.equal(late.unexpectedNonceInOrigin, false);
  });
}

test('GIVEN Linux sandbox unreachable result WHEN independent pair passes THEN only sandbox capability fails', async t => {
  const r = await run(t, ['--canary', 'C4', '--platform-label', 'linux-unix-pty', '--mutation', 'sandbox-unreachable']);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.ledger.measurements[0].capabilityStatus, { independentSendMessage: 'PASS', sandboxChildSendMessage: 'FAIL' });
  assert.deepEqual(r.ledger.measurements[0].capabilities, { independentSendMessage: true, sandboxChildSendMessage: false });
});

test('GIVEN Q1 fork name WHEN launching with and without worktree THEN origin remains unchanged and unique', async t => {
  const r = await run(t, ['--canary', 'C2']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(data(r).namedForks.map(f => f.worktree), [false, true]);
  for (const f of data(r).namedForks) {
    assert.equal(f.agentName, f.requestedName);
    assert.equal(f.descriptorName, f.requestedName);
    assert.equal(f.originNameBefore, f.originNameAfter);
    assert.equal(f.originUniqueAmongLive, true);
  }
});

for (const mutation of ['ignore-fork-name', 'rename-fork-source', 'colliding-fork-name']) {
  test(`GIVEN Q1 ${mutation} WHEN named fork measured THEN name subcase fails`, async t => {
    const r = await run(t, ['--canary', 'C2', '--mutation', mutation]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.ledger.measurements[0].capabilityStatus.forkWorktree, 'FAIL');
    assert.ok(data(r).namedForks.length > 0);
  });
}

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
      fs.writeFileSync(file, JSON.stringify({ dryRun: false, canary, platform: execution.platform, platformLabel: execution.label, ptyBackend: execution.backend }));
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

test('GIVEN committed Phase 0 history WHEN consolidating through CLI THEN records stay immutable and gate stays closed', async t => {
  const root = path.resolve(__dirname, '..');
  const base = path.join(root, 'docs/evidence/session-capabilities');
  const dirs = fs.readdirSync(base).map(p => path.join(base, p)).filter(p => fs.existsSync(path.join(p, 'ledger.json')) &&
    JSON.parse(fs.readFileSync(path.join(p, 'ledger.json'))).measurements.every(r => !r.capabilityStatus));
  assert.ok(dirs.length > 0);
  const before = dirs.map(p => fs.readFileSync(path.join(p, 'ledger.json'), 'utf8'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-n1-history-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const out = path.join(temp, 'session-capabilities.json');
  const result = spawnSync(process.execPath, [script, '--consolidate', ...dirs, '--out', out], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(dirs.map(p => fs.readFileSync(path.join(p, 'ledger.json'), 'utf8')), before);
  const ledger = JSON.parse(fs.readFileSync(out));
  assert.equal(ledger.measurements.length, before.reduce((n, text) => n + JSON.parse(text).measurements.length, 0));
  assert.ok(Object.values(harness.readCapabilities(out).capabilities).every(v => v === false));
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

for (const mutation of ['', 'stale-descriptor-name', 'descriptor-only-name', 'rename-during-child-launch']) {
  test(`GIVEN C4 rename ${mutation} WHEN child is prompted THEN use current native name and retain linked send results`, async t => {
    const r = await run(t, ['--canary', 'C4', ...(mutation ? ['--mutation', mutation] : [])]);
    assert.equal(r.status, 0, r.stderr + (r.ledger ? JSON.stringify(data(r)) : 'no ledger'));
    for (const report of data(r).reports) {
      assert.equal(report.nativeRecipientDiffersFromDisplayTitle, false);
      assert.equal(report.nativeRecipient, report.displayTitle);
      assert.match(report.displayTitle, /^UI-/);
      if (mutation === 'rename-during-child-launch' && !report.sandbox) assert.match(report.nativeRecipient, /-latest$/);
      assert.equal(report.recipientSource, mutation === 'descriptor-only-name' ? 'descriptor.name' : 'agent-name');
      assert.equal(report.renameObservation.nativeNameChanged, true);
      assert.equal(report.renameObservation.nativeNameEqualsDisplayTitle, true);
      assert.equal(report.intendedToolCall, true);
      assert.equal(report.sendResults.length, 1);
      const result = report.sendResults[0];
      const expected = report.wrongRecipientControl
        ? JSON.stringify({ success: false, message: `No agent named '${report.addressedRecipient}' is reachable.\nUse ListAgents to see everyone you can message.` })
        : JSON.stringify({ success: true, message: `“Report canary nonce to orchestrator” → ${report.addressedRecipient} (another Claude session on this machine; in that session's inbox)` });
      assert.equal(result.success, !report.wrongRecipientControl);
      assert.equal(result.sha256, crypto.createHash('sha256').update(expected).digest('hex'));
      assert.equal(result.excerpt, expected.slice(0, 200));
      assert.equal(result.bytes, Buffer.byteLength(expected));
      assert.ok(result.offset >= 0);
      assert.ok(result.toolUseId);
    }
  });
}

for (const mutation of ['', 'receipt-delayed']) {
  test(`GIVEN live C4 receipt ${mutation} while child stays busy WHEN measuring THEN accept exact sender and body and exit gracefully`, async t => {
    const r = await run(t, ['--canary', 'C4', ...(mutation ? ['--mutation', mutation] : [])]);
    assert.equal(r.status, 0, r.stderr + (r.ledger ? JSON.stringify(data(r)) : 'no ledger'));
    const evidence = data(r);
    for (const report of evidence.reports.filter(x => !x.wrongRecipientControl)) {
      assert.equal(report.sendResults[0].success, true);
      assert.equal(report.nativeReceipt, true);
      assert.equal(report.receipt.shape, 'cross-session-message');
      assert.equal(report.receipt.from.scheme, 'uds:');
      const child = evidence.processes.find(x => x.sessionId === report.childId);
      assert.equal(report.receipt.from.socketPathSha256, crypto.createHash('sha256').update(`/tmp/cc-socks/${child.pid}.sock`).digest('hex'));
      assert.equal(report.receipt.fromName, `native-${report.childId}`);
      assert.equal(report.receipt.fromMode, 'prompting');
      assert.ok(report.receiptOffset >= report.before);
      assert.equal(report.queueOperations.length, 2);
      assert.ok(report.queueOperations.every(x => x.type === 'queue-operation' && x.offset >= report.before && x.offset < report.receiptOffset));
      assert.equal(child.lastDescriptor.status, 'busy');
      assert.equal(child.shutdown.gracefulExit, true);
      assert.equal(child.shutdown.forcedKill, false);
      assert.equal(child.submissions[0].confirmation, 'observation');
      const origin = evidence.processes.find(x => x.sessionId === report.orchestratorId);
      assert.equal(origin.shutdown.gracefulExit, true);
    }
    assert.ok(!JSON.stringify(evidence.reports).includes('/tmp/cc-socks/'));
    const control = evidence.reports.find(x => x.wrongRecipientControl);
    assert.equal(control.sendResults[0].success, false);
    assert.match(control.sendResults[0].excerpt, /No agent named/);
    assert.equal(control.unexpectedNonceInOrigin, false);
  });
}

for (const mutation of ['receipt-wrong-sender', 'receipt-extra-body', 'receipt-wrong-scheme', 'receipt-wrong-type', 'receipt-teammate']) {
  test(`GIVEN C4 ${mutation} WHEN measuring THEN do not qualify receipt but retain queue offsets and send result`, async t => {
    const r = await run(t, ['--canary', 'C4', '--mutation', mutation]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.ledger.measurements[0].status, 'UNVERIFIED');
    const report = data(r).reports[0];
    assert.equal(report.sendResults[0].success, true);
    assert.equal(report.nativeReceipt, false);
    assert.equal(report.queueOperations.length, 2);
    assert.ok(Object.values(r.ledger.measurements[0].capabilities).every(x => x === false));
    assert.ok(data(r).processes.every(x => x.cleaned && x.shutdown.gracefulExit && !x.shutdown.forcedKill));
  });
}

test('GIVEN private tmp hides C4 messaging socket WHEN sandbox SendMessage fails THEN retain O1 STOP evidence without socket sharing', async t => {
  const r = await run(t, ['--canary', 'C4', '--mutation', 'sandbox-socket-unavailable']);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.ledger.measurements[0].status, 'UNVERIFIED');
  const evidence = data(r);
  const report = evidence.reports.find(x => x.sandbox);
  assert.ok(report, JSON.stringify(evidence));
  assert.equal(report.socketDirectory.visible, false);
  assert.equal(report.socketDirectory.path, '/tmp/cc-socks');
  assert.equal(report.socketDirectory.source, 'emulated child descriptor');
  assert.equal(report.sendResults[0].success, false);
  assert.match(report.sendResults[0].excerpt, /connect ENOENT/);
  assert.equal(report.nativeReceipt, false);
  assert.equal(report.o1.status, 'STOP');
  assert.match(report.failure, /SendMessage reported failure/);
  const child = evidence.processes.find(x => x.sessionId === report.childId);
  assert.equal(child.shutdown.gracefulExit, true);
  const tmp = child.mountPlan.indexOf('--tmpfs');
  assert.equal(child.mountPlan[tmp + 1], '/tmp');
  assert.ok(!child.mountPlan.some(x => x.includes('cc-socks')));
  assert.deepEqual(r.ledger.measurements[0].capabilityStatus, { independentSendMessage: 'PASS', sandboxChildSendMessage: 'UNVERIFIED' });
});

test('GIVEN C4 failed SendMessage WHEN receipt is absent THEN preserve bounded failure text separately from receipt recognition', async t => {
  const r = await run(t, ['--canary', 'C4', '--mutation', 'send-failed']);
  assert.equal(r.ledger.measurements[0].status, 'FAIL');
  assert.ok(Object.values(r.ledger.measurements[0].capabilities).every(x => x === false));
  assert.match(data(r).failure, /SendMessage reported failure/);
  const report = data(r).reports[0];
  assert.equal(report.nativeReceipt, false);
  const expected = JSON.stringify({ success: false, message: `No agent named '${report.addressedRecipient}' is reachable.\nUse ListAgents to see everyone you can message.${' fixture detail'.repeat(40)}` });
  const result = report.sendResults[0];
  assert.equal(result.success, false);
  assert.match(result.excerpt, /No agent named/);
  assert.equal(result.excerpt.length, 200);
  assert.equal(result.sha256, crypto.createHash('sha256').update(expected).digest('hex'));
  assert.equal(result.bytes, Buffer.byteLength(expected));
});

test('GIVEN C4 pre-rename native recipient WHEN fake CLI sends THEN old address is unreachable and no receipt is written', async t => {
  const r = await run(t, ['--canary', 'C4', '--mutation', 'stale-recipient']);
  assert.equal(r.ledger.measurements[0].status, 'UNVERIFIED');
  assert.match(data(r).failure, /wrong recipient/);
  const report = data(r).reports[0];
  assert.equal(report.intendedToolCall, false);
  assert.equal(report.nativeReceipt, false);
  assert.equal(report.unexpectedNonceInOrigin, false);
  const expected = JSON.stringify({ success: false, message: `No agent named 'native-${report.orchestratorId}' is reachable.\nUse ListAgents to see everyone you can message.` });
  assert.equal(report.sendResults[0].success, false);
  assert.equal(report.sendResults[0].sha256, crypto.createHash('sha256').update(expected).digest('hex'));
  assert.equal(report.sendResults[0].excerpt, expected.slice(0, 200));
});
test('GIVEN CLI paste envelope WHEN C1 runs THEN unwrapped body is literal and cache metadata is redacted', async t => {
  const r = await run(t, ['--canary', 'C1']);
  const evidence = data(r);
  assert.ok(evidence.payloads.every(x => x.literal), 'wrapper must not invalidate literal payload');
  assert.equal(r.status, 0, r.stderr);
  for (const p of evidence.payloads) {
    assert.equal(p.wrapperPresent, true);
    assert.equal(p.wrapperId, 'e7f5');
    assert.equal(p.envelopePrefix, '\\n\\n');
    assert.equal(p.envelopeSuffix, '\\n');
    assert.equal(p.literalAfterKnownTransformations, true);
    assert.deepEqual(p.transformations, []);
    assert.equal(p.linkedPaste, false);
    assert.ok(p.pasteCache.every(x => Object.keys(x).sort().join(',') === 'bytes,sha256'));
    if (p.bytes > 4096) {
      assert.ok(p.pasteCache.some(x => x.bytes === p.bytes && x.sha256 === p.sha256));
    }
  }
});

test('GIVEN TAB expanded by CLI WHEN C1 runs THEN only raw control records the transformation', async t => {
  const r = await run(t, ['--canary', 'C1', '--mutation', 'tab-to-spaces']);
  assert.equal(r.status, 0, r.stderr);
  const evidence = data(r);
  assert.ok(evidence.payloads.every(x => x.literal));
  assert.deepEqual(evidence.rawTabControl.transformations, ['tab-to-4-spaces']);
  assert.ok(evidence.payloads.every(x => x.literalAfterKnownTransformations));
  for (const p of evidence.payloads) {
    assert.equal(p.wrapperPresent, true);
    assert.equal(p.wrapperId, 'e7f5');
    assert.equal(p.envelopePrefix, '\\n\\n');
    assert.equal(p.envelopeSuffix, '\\n');
    assert.equal(p.linkedPaste, false);
    assert.equal(p.storedBodyBytes, p.bytes);
    assert.equal(p.storedBodySha256, p.sha256);
    const project = path.join(r.home, '.claude/projects');
    const file = fs.readdirSync(project, { recursive: true }).find(x => path.basename(x) === `${p.transcriptId}.jsonl`);
    const rows = fs.readFileSync(path.join(project, file), 'utf8').trim().split('\n').map(x => JSON.parse(x));
    const body = rows.find(x => x.type === 'user').message.content;
    assert.ok(body.startsWith('\n\n<pasted_content id="e7f5">\n'));
    assert.ok(!body.includes('\t'));
    if (p.bytes > 4096) assert.ok(p.pasteCache.some(x => x.bytes === p.bytes && x.sha256 === p.storedBodySha256));
  }
  for (const name of fs.readdirSync(path.join(r.home, '.claude/paste-cache'))) assert.match(name, /^[0-9a-f]{16}\.txt$/);
  assert.ok(evidence.payloads.every(x => x.eligibleConfirmation));
  assert.equal(r.ledger.measurements[0].status, 'PASS');
});

test('GIVEN assistant persisted only on graceful exit WHEN C1 runs THEN confirmation includes final transcript', async t => {
  const r = await run(t, ['--canary', 'C1', '--mutation', 'exit-flush-assistant']);
  const evidence = data(r);
  assert.ok(evidence.payloads.every(x => x.eligibleConfirmation), 'exit-flushed assistant must be observed');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(evidence.processes.every(x => x.shutdown.gracefulExit && !x.shutdown.forcedKill));
  assert.ok(evidence.payloads.every(x => x.transcriptFinalBytes > x.transcriptConfirmedBytes));
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
for (const [canary, cases] of Object.entries(mutations)) {
  for (const mutation of cases) {
    test(`GIVEN ${canary} mutation ${mutation} WHEN dry-run THEN that canary fails`, async t => {
      const r = await run(t, ['--canary', canary, '--mutation', mutation]);
      assert.equal(r.status, 1, r.stderr);
      assert.equal(r.ledger.measurements.length, 1);
      assert.equal(r.ledger.measurements[0].status, 'FAIL');
      assert.ok(Object.values(r.ledger.measurements[0].capabilities).some(x => x === false));
    });
  }
}

test('GIVEN a failing canary WHEN all are selected THEN remaining canaries still run', async t => {
  const r = await run(t, ['--mutation', 'drop-byte']);
  assert.equal(r.status, 1);
  const failures = r.ledger.measurements.map(x => JSON.parse(fs.readFileSync(path.join(__dirname, '..', x.evidencePath))).failure || 'none');
  assert.deepEqual(r.ledger.measurements.map(x => x.status), ['FAIL', 'PASS', 'PASS', 'PASS'], failures.join('; '));
});

test('GIVEN fake real home WHEN starting THEN refuse before any CLI or evidence setup', async t => {
  const r = await run(t, [], { homeAlias: ({ realHome }) => realHome });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /real user home/);
  assert.equal(r.ledger, undefined);
});

test('GIVEN no prepared .claude WHEN starting THEN refuse', async t => {
  const r = await run(t, ['--home', os.tmpdir()]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /prepared.*\.claude/);
});

test('GIVEN invalid backend WHEN live starting THEN refuse without launching CLI', async t => {
  const r = await run(t, ['--live', '--cli', 'never-execute-this']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /platform-label/);
});

test('GIVEN fake hangs WHEN deadline expires THEN bounded cleanup and UNVERIFIED evidence', async t => {
  const r = await run(t, ['--canary', 'C1', '--mutation', 'hang', '--timeout-ms', '2000']);
  assert.equal(r.status, 1);
  assert.equal(r.ledger.measurements[0].status, 'UNVERIFIED');
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', r.ledger.measurements[0].evidencePath)));
  assert.ok(data.processes.length > 0);
  assert.ok(data.processes.every(x => x.cleaned));
});

test('GIVEN append to ledger WHEN another measurement runs THEN sequence keeps increasing', async t => {
  const r = await run(t, ['--canary', 'C1']);
  const nextHome = path.join(r.root, 'next-home');
  fs.mkdirSync(path.join(nextHome, '.claude'), { recursive: true });
  const next = spawnSync(process.execPath, ['--require', accountFixture, script, '--dry-run', '--canary', 'C2',
    '--home', nextHome, '--out', r.out, '--platform-label', 'fixture-only', '--runtime-root', path.join(r.root, 'runtime')], {
    encoding: 'utf8', timeout: 600000, windowsHide: true,
    env: { ...process.env, HOME: path.join(r.root, 'fake-real-home'), USERPROFILE: path.join(r.root, 'fake-real-home'),
      HOMEDRIVE: '', HOMEPATH: '', CANARY_TEST_ACCOUNT_HOME: path.join(r.root, 'fake-real-home') },
  });
  assert.equal(next.status, 0, next.stderr);
  const records = JSON.parse(fs.readFileSync(path.join(r.out, 'ledger.dry-run.json'))).measurements;
  assert.deepEqual(records.map(x => x.sequence), [1, 2]);
});

function data(r) {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', r.ledger.measurements[0].evidencePath)));
}

for (const alias of ['junction', 'case-trailing', 'short']) {
  test(`GIVEN fake real home ${alias} alias WHEN starting THEN refuse`, { skip: process.platform !== 'win32' && alias !== 'junction' ? 'Windows path alias only' : false }, async t => {
    const r = await run(t, [], { homeAlias: ({ root, realHome }) => {
      if (alias === 'case-trailing') return realHome.toUpperCase() + path.sep;
      if (alias === 'short') {
        const output = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${realHome}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
        assert.equal(output.status, 0, output.stderr);
        assert.ok(fs.existsSync(output.stdout.trim()), output.stdout);
        return output.stdout.trim();
      }
      const link = path.join(root, 'alias');
      fs.symlinkSync(realHome, link, process.platform === 'win32' ? 'junction' : 'dir');
      return link;
    } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /real user home/);
    assert.equal(r.ledger, undefined);
  });
}

test('GIVEN nonempty prepared projects WHEN starting THEN refuse without reading transcripts', async t => {
  const r = await run(t, [], { prepare: ({ home }) => {
    fs.mkdirSync(path.join(home, '.claude/projects'));
    fs.writeFileSync(path.join(home, '.claude/projects/unrelated.jsonl'), 'unread');
  } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /projects.*empty/);
});

for (const mutation of ['own-title', 'natural-source-activity', 'meta-users', 'escaped-settings', 'no-paste-ref', 'missing-paste-object']) {
  const canary = ['own-title', 'natural-source-activity'].includes(mutation) ? 'C2' : mutation === 'escaped-settings' ? 'C3' : 'C1';
  test(`GIVEN ${mutation} WHEN dry-run THEN capability remains PASS`, async t => {
    const r = await run(t, ['--canary', canary, '--mutation', mutation]);
    assert.equal(r.status, 0, r.stderr + JSON.stringify(r.ledger) + JSON.stringify(data(r)));
    const evidence = data(r);
    if (mutation === 'own-title') assert.ok(evidence.forks.every(x => x.titleOutcome.status === 'FAIL'));
    if (canary === 'C2') assert.ok(evidence.forks.every(x => x.timeline.some(y => y.at === 'ready-before-own-turn' && y.lines === 1)));
  });
}

for (const [canary, mutation, reason] of [
  ['C4', 'no-report', /SendMessage/], ['C4', 'synthetic-receipt', /receipt/], ['C4', 'missing-name', /name/],
  ['C4', 'unknown-receipt', /receipt/], ['C1', 'blocking-dialog', /dialog/], ['C1', 'exit-on-submit', /exited/],
  ['C4', 'wrong-recipient', /wrong recipient/],
  ['C3', 'os-denial', /denial.*unrecognized/],
]) {
  test(`GIVEN ${mutation} WHEN dry-run THEN retain UNVERIFIED and any independently measured keys`, async t => {
    const r = await run(t, ['--canary', canary, '--mutation', mutation]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.ledger.measurements[0].status, 'UNVERIFIED');
    if (mutation === 'storage-only') {
      assert.deepEqual(r.ledger.measurements[0].capabilities, { singleTurnDelivery: true, literalTranscript: false, eligibleConfirmation: true });
    } else assert.ok(Object.values(r.ledger.measurements[0].capabilities).every(x => x === false));
    assert.match(data(r).failure, reason);
    if (mutation === 'blocking-dialog') assert.equal(data(r).processes[0].waitingFor, 'trust');
    if (['synthetic-receipt', 'unknown-receipt'].includes(mutation)) {
      assert.ok(data(r).reports[0].rawReceiptRows.length > 0);
      assert.equal(data(r).reports[0].sendResults[0].success, true);
      assert.equal(data(r).reports[0].nativeReceipt, false);
    }
    if (mutation === 'storage-only') assert.ok(data(r).payloads.every(x => x.singleTurnDelivery && x.eligibleConfirmation));
  });
}

test('GIVEN sandbox plan WHEN dry-run THEN only launch settings mount and private config copy match contract', async t => {
  const r = await run(t, ['--canary', 'C3'], { prepare: ({ home }) => fs.writeFileSync(path.join(home, '.claude.json'), '{"fixtureConfig":true}') });
  assert.equal(r.status, 0, r.stderr);
  const evidence = data(r);
  const proc = evidence.processes.find(x => x.sandbox);
  const plan = proc.mountPlan;
  const at = plan.indexOf('/run/switchboard/launch-settings.json');
  assert.ok(at > 1);
  assert.equal(plan[at - 2], '--ro-bind');
  const runDir = plan.indexOf('/run/switchboard');
  assert.deepEqual(plan.slice(runDir - 3, runDir + 1), ['--perms', '0555', '--dir', '/run/switchboard']);
  assert.ok(!plan.some((x, i) => x === '--ro-bind' && plan[i + 1].endsWith(`${path.sep}private`)));
  assert.equal(proc.privateConfigSha256, crypto.createHash('sha256').update('{"fixtureConfig":true}').digest('hex'));
  assert.equal(evidence.peerAliasThreat.status, 'UNVERIFIED');
  assert.ok(!fs.existsSync(path.join(r.out, '0001-C3', 'project')));
  assert.ok(evidence.processes.every(x => !x.cwd.startsWith(r.out)));
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

test('GIVEN sandbox C3 WHEN Read and authority probes run THEN settings explicitly allow their tools', async t => {
  const r = await run(t, ['--canary', 'C3']);
  assert.equal(r.status, 0, r.stderr + (r.ledger ? JSON.stringify(data(r)) : 'no ledger'));
  assert.ok(data(r).permissions.every(x => x.exactSettingsRead));
  assert.ok(data(r).permissions.find(x => x.sandbox).protectionAttemptObserved);
});

test('GIVEN dirty checkout WHEN live setup THEN refuse before CLI version probe', async t => {
  const backend = process.platform === 'win32' ? 'windows-conpty-bundled' : 'linux-unix-pty';
  const r = await run(t, ['--live', '--canary', 'C1', '--cli', process.execPath, '--platform-label', backend,
    '--out', path.resolve(__dirname, '../docs/evidence/session-capabilities/refused-dirty')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /dirty/);
});

test('GIVEN per-canary budgets WHEN parsing THEN live caps can be configured', async t => {
  const r = await run(t, ['--canary', 'C1', '--c2-timeout-ms', '900000']);
  assert.equal(r.status, 0, r.stderr);
});

test('GIVEN occupied runtime root WHEN starting THEN refuse and preserve operator files', async t => {
  const r = await run(t, ['--canary', 'C1'], { prepare: ({ runtime }) => {
    fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, 'operator-file'), 'preserve');
  } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /runtime.*empty/i);
  assert.equal(fs.readFileSync(path.join(r.root, 'runtime/operator-file'), 'utf8'), 'preserve');
});

test('GIVEN CLAUDE.md ancestor WHEN choosing runtime THEN refuse before fixture creation', async t => {
  const r = await run(t, [], { prepare: ({ root }) => fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'fixture instructions') });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CLAUDE.md ancestor/);
});

for (const marker of ['.claude/CLAUDE.md', 'CLAUDE.local.md', '.claude/settings.json', '.claude/settings.local.json']) {
  test(`GIVEN ${marker} ancestor WHEN choosing runtime THEN refuse before fixture creation`, async t => {
    const r = await run(t, [], { prepare: ({ root }) => {
      const file = path.join(root, marker);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'fixture instructions');
    } });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /ancestor/);
    assert.equal(r.ledger, undefined);
  });
}

for (const location of ['runtime', 'home', 'project']) {
  for (const alias of ['direct', 'junction', ...(process.platform === 'win32' ? ['case-trailing', 'short'] : [])]) {
    test(`GIVEN ${location} inside ${alias} real-home identity WHEN starting THEN refuse before writes`, async t => {
      let target;
      const r = await run(t, [], { extraArgs: ({ root, realHome, runtime }) => {
        let identity = realHome;
        if (alias === 'junction') {
          identity = path.join(root, 'home-alias');
          fs.symlinkSync(realHome, identity, process.platform === 'win32' ? 'junction' : 'dir');
        } else if (alias === 'short') {
          const p = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${realHome}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
          assert.equal(p.status, 0, p.stderr);
          identity = p.stdout.trim();
          assert.ok(fs.existsSync(identity));
        } else if (alias === 'case-trailing') identity = realHome.toUpperCase() + path.sep;
        target = path.join(realHome, 'must-not-create');
        if (location === 'project') {
          fs.mkdirSync(runtime);
          fs.symlinkSync(identity, path.join(runtime, 'project'), process.platform === 'win32' ? 'junction' : 'dir');
          return [];
        }
        if (location === 'home') {
          fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
          return ['--home', path.join(identity, 'must-not-create')];
        }
        return ['--runtime-root', path.join(identity, 'must-not-create')];
      } });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /real user home/);
      assert.equal(r.ledger, undefined);
      if (location !== 'home') assert.ok(!fs.existsSync(target));
    });
  }
}

test('GIVEN no explicit runtime root WHEN live setup THEN refuse before CLI or evidence writes', async t => {
  const r = await run(t, ['--live'], { noRuntime: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /explicit --runtime-root/);
  assert.equal(r.ledger, undefined);
});

for (const [platform, file, expected] of [
  ['linux', '/srv/private/permissions-nonce.json', '//srv/private/permissions-nonce.json'],
  ['darwin', '/srv/private/permissions-nonce.json', '//srv/private/permissions-nonce.json'],
  ['linux', '/run/switchboard/launch-settings.json', '//run/switchboard/launch-settings.json'],
  ['win32', 'C:\\private\\permissions-nonce.json', 'C:\\private\\permissions-nonce.json'],
  ['win32', 'C:/private/permissions-nonce.json', 'C:/private/permissions-nonce.json'],
  ['linux', '//srv/private/permissions-nonce.json', '//srv/private/permissions-nonce.json'],
  ['linux', 'private/permissions-nonce.json', 'private/permissions-nonce.json'],
]) {
  test(`GIVEN ${platform} path ${file} WHEN building a path permission THEN preserve its intended scope`, () => {
    for (const tool of ['Read', 'Write', 'Edit']) {
      assert.equal(harness.pathPermissionRule(tool, file, platform), `${tool}(${expected})`);
    }
  });
}

test('GIVEN sandbox C3 WHEN generating settings THEN allow Read of the mounted absolute path seen by the CLI', async t => {
  const r = await run(t, ['--canary', 'C3']);
  assert.equal(r.status, 0, r.stderr);
  const evidence = data(r);
  const proc = evidence.processes.find(p => p.sandbox);
  const project = path.join(r.home, '.claude/projects');
  const name = fs.readdirSync(project, { recursive: true }).find(file => path.basename(file) === `${proc.sessionId}.jsonl`);
  const rows = fs.readFileSync(path.join(project, name), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const all = rows.flatMap(row => Array.isArray(row.message?.content) ? row.message.content : []);
  const read = all.find(block => block.type === 'tool_use' && block.name === 'Read');
  const result = all.find(block => block.type === 'tool_result' && block.tool_use_id === read.id);
  const settings = JSON.parse(result.content[0].text);
  assert.ok(settings.permissions.allow.includes('Read(//run/switchboard/launch-settings.json)'),
    JSON.stringify(settings.permissions.allow));
  assert.ok(!settings.permissions.allow.some(rule => /^Read\((?!\/\/run\/)/.test(rule)));
  assert.equal(read.input.file_path, '/run/switchboard/launch-settings.json');
});

test('GIVEN a single-slash POSIX Read rule WHEN fake C3 runs THEN reproduce a permission prompt', async t => {
  const r = await run(t, ['--canary', 'C3', '--mutation', 'single-slash-read-rule']);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.ledger.measurements[0].status, 'UNVERIFIED');
  const evidence = data(r);
  const proc = evidence.processes.at(-1);
  assert.equal(proc.waitingFor, 'permission');
  assert.equal(proc.cleaned, true);
  assert.equal(evidence.permissions.at(-1).exactSettingsRead, false);
  assert.equal(evidence.permissions.at(-1).nonOverlappingActionRan, false);
  assert.equal(evidence.permissions.at(-1).finalReplyObserved, false);
});

test('GIVEN exact live command denial WHEN C3 runs THEN linked result and explicit final reply qualify each turn', async t => {
  const r = await run(t, ['--canary', 'C3']);
  const evidence = data(r);
  assert.ok(evidence.permissions.length > 0, JSON.stringify(evidence));
  assert.equal(evidence.permissions[0].toolPermissionDenial, true);
  assert.equal(r.status, 0, r.stderr + JSON.stringify(evidence));
  assert.equal(evidence.workBudgetMs, 300000);
  assert.ok(evidence.permissions.every(p => p.finalReplyObserved));
  assert.ok(evidence.permissions[0].denialObservation.excerpt.includes('with command printf denied >'));
  assert.ok(evidence.processes.every(p => p.submissions[0].waitBudgetMs === 90000));
});

test('GIVEN exact live denial without is_error WHEN C3 runs THEN linked command text still proves refusal', async t => {
  const r = await run(t, ['--canary', 'C3', '--mutation', 'denial-no-error-flag', '--timeout-ms', '60000']);
  assert.equal(r.status, 0, r.stderr + (r.ledger ? JSON.stringify(data(r)) : 'no ledger'));
  assert.equal(data(r).permissions[0].toolPermissionDenial, true);
});

for (const [mutation, descriptorStatus] of [['tool-stop', 'busy'], ['tool-stop-idle', 'idle'], ['tool-stop-waiting', 'waiting'], ['missing-allowed-tool', 'busy']]) {
  test(`GIVEN ${mutation} after permission tools WHEN C3 stops THEN retain all supported checks and last descriptor`, async t => {
    const r = await run(t, ['--canary', 'C3', '--mutation', mutation, '--timeout-ms', '15000']);
    assert.equal(r.status, 1, r.stderr);
    const evidence = data(r);
    assert.equal(r.ledger.measurements[0].status, 'UNVERIFIED');
    assert.equal(evidence.permissions.length, 1, 'partial permission evidence must survive incomplete turn');
    const permission = evidence.permissions[0];
    assert.equal(permission.exactSettingsRead, true);
    assert.equal(permission.toolPermissionDenial, true);
    assert.equal(permission.deniedSideEffectAbsent, true);
    assert.equal(permission.nonOverlappingActionRan, mutation !== 'missing-allowed-tool');
    assert.equal(permission.finalReplyObserved, false);
    for (const name of ['CLI reads exact settings JSON', 'deny overrides overlapping settings and project allow']) {
      assert.equal(evidence.checks.find(x => x.name === name).status, 'PASS', name);
    }
    assert.equal(evidence.checks.find(x => x.name === 'non-overlapping allowed Bash action runs').status,
      mutation === 'missing-allowed-tool' ? 'UNVERIFIED' : 'PASS');
    assert.equal(evidence.checks.find(x => x.name === 'explicit C3 final reply observed').status, 'UNVERIFIED');
    const proc = evidence.processes[0];
    assert.equal(proc.cleaned, true);
    assert.equal(proc.lastDescriptor.status, descriptorStatus);
    assert.equal(proc.lastDescriptor.waitingFor, mutation === 'tool-stop-waiting' ? 'trust' : null);
    const submission = proc.submissions[0];
    assert.equal(submission.outcome, 'UNVERIFIED');
    assert.ok(submission.lastRows.length >= 5);
    assert.equal(submission.lastRows.at(-1).type, 'user');
    assert.ok(submission.lastRows.at(-1).blocks.some(x => x.type === 'tool_result'));
    assert.ok(submission.lastRows.every(x => Number.isInteger(x.offset)));
    assert.ok(Object.values(r.ledger.measurements[0].capabilities).every(x => x === false));
    if (mutation !== 'tool-stop-waiting') assert.match(evidence.failure, /timeout/);
  });
}

test('GIVEN premature final reply WHEN allowed tool is missing THEN C3 stays UNVERIFIED with partial checks', async t => {
  const r = await run(t, ['--canary', 'C3', '--mutation', 'premature-final']);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.ledger.measurements[0].status, 'UNVERIFIED');
  const evidence = data(r);
  assert.equal(evidence.permissions[0].finalReplyObserved, true);
  assert.equal(evidence.permissions[0].nonOverlappingActionRan, false);
  assert.equal(evidence.checks.find(x => x.name === 'non-overlapping allowed Bash action runs').status, 'UNVERIFIED');
});

test('GIVEN forbidden side effect before timeout WHEN C3 records evidence THEN retain failed property without qualifying incomplete turn', async t => {
  const r = await run(t, ['--canary', 'C3', '--mutation', 'tool-stop-side-effect', '--timeout-ms', '15000']);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.ledger.measurements[0].status, 'UNVERIFIED');
  const evidence = data(r);
  assert.equal(evidence.permissions[0].deniedSideEffectAbsent, false);
  assert.equal(evidence.permissions[0].toolPermissionDenial, true);
  assert.equal(evidence.checks.find(x => x.name === 'denied side effect absent').status, 'FAIL');
  assert.equal(evidence.checks.find(x => x.name === 'non-overlapping allowed Bash action runs').status, 'PASS');
});

for (const mutation of ['wrong-command-denial', 'unlinked-denial']) {
  test(`GIVEN ${mutation} WHEN C3 runs THEN absence alone does not prove permission denial`, async t => {
    const r = await run(t, ['--canary', 'C3', '--mutation', mutation, '--timeout-ms', '15000']);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.ledger.measurements[0].status, 'UNVERIFIED');
    const permission = data(r).permissions[0];
    assert.ok(permission, 'mismatched or unlinked denial must still be recorded');
    assert.equal(permission.deniedSideEffectAbsent, true);
    assert.equal(permission.toolPermissionDenial, false);
    assert.equal(permission.denialObservation.status, 'UNVERIFIED');
  });
}

for (const mutation of ['unknown-denial', 'sandbox-unknown-denial', 'os-denial']) {
  test(`GIVEN ${mutation} without side effect WHEN C3 runs THEN retain bounded denial evidence as UNVERIFIED`, async t => {
    const r = await run(t, ['--canary', 'C3', '--mutation', mutation]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.ledger.measurements[0].status, 'UNVERIFIED');
    const p = data(r).permissions.find(x => x.denialObservation?.status === 'UNVERIFIED' && x.denialObservation.sha256);
    assert.ok(p, JSON.stringify(data(r)));
    const text = mutation === 'os-denial' ? 'bash: Permission denied' : 'Unrecognized fixture refusal. '.repeat(20);
    assert.equal(p.denialObservation.sha256, crypto.createHash('sha256').update(text).digest('hex'));
    assert.equal(p.denialObservation.excerpt, text.slice(0, 200));
    assert.equal(p.deniedSideEffectAbsent, true);
    assert.ok(Object.values(r.ledger.measurements[0].capabilities).every(x => x === false));
  });
}

test('GIVEN C1 post-submit idle descriptor WHEN measuring confirmation THEN record it independently of assistant rows', async t => {
  const r = await run(t, ['--canary', 'C1']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(data(r).payloads.every(x => x.descriptorConfirmation?.status === 'idle' &&
    x.descriptorConfirmation.statusUpdatedAt >= x.descriptorConfirmation.submittedAt));
  assert.ok(data(r).payloads.every(x => x.oscObservations?.some(y => y.code === '9;4' && y.level === '0')));
});

test('GIVEN sandbox mount probe WHEN invoking bwrap THEN both namespaces test trigger private and settings-parent write refusal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-probes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), repo = path.join(root, 'project'), privateDir = path.join(root, 'private');
  for (const dir of [path.join(home, '.claude/sessions'), path.join(repo, '.claude'), privateDir]) fs.mkdirSync(dir, { recursive: true });
  const sessions = path.join(root, 'generation');
  fs.mkdirSync(sessions);
  const settings = path.join(privateDir, 'settings.json');
  fs.writeFileSync(settings, '{}');
  const calls = [];
  const subprocess = require('node:child_process');
  t.mock.method(subprocess, 'spawnSync', (exe, argv) => {
    assert.equal(exe, 'bwrap');
    if (argv[0] === '--version') return { status: 0, stdout: 'fixture bwrap' };
    const at = argv.indexOf('-c');
    const code = argv[at + 1], paths = argv.slice(at + 3);
    calls.push({ code, paths });
    const mount = argv.slice(0, at).lastIndexOf(path.join(home, '.claude/sessions'));
    fs.writeFileSync(path.join(argv[mount - 1], 'publication-probe'), 'own');
    fs.writeFileSync(paths[3], 'ordinary');
    return { status: 0, stdout: '' };
  });
  const cached = require.cache[require.resolve(script)];
  delete require.cache[require.resolve(script)];
  const isolated = require(script);
  require.cache[require.resolve(script)] = cached;
  const ctx = { opts: { home }, repo, private: privateDir, env: harness.environment(home), deadline: Date.now() + 4000,
    observation: 0, evidence: { checks: [] } };
  isolated.probeMounts(ctx, isolated.sandboxPlan(ctx, repo, settings, sessions), sessions, settings);
  assert.equal(calls.length, 2);
  for (const { code, paths } of calls) {
    assert.ok(paths.includes(ctx.env.SWITCHBOARD_TRIGGERS_DIR), 'trigger path absent from namespace probe');
    assert.ok(paths.includes(privateDir), 'private path absent from namespace probe');
    for (const target of [ctx.env.SWITCHBOARD_TRIGGERS_DIR, privateDir]) {
      const position = paths.indexOf(target) + 1;
      assert.ok(code.includes(`test ! -w "$${position}"`), 'missing write-refusal assertion');
    }
    assert.ok(code.includes('test ! -w /run/switchboard'));
  }
});

test('GIVEN per-canary budget override WHEN C1 runs THEN evidence records configured budget', async t => {
  const r = await run(t, ['--canary', 'C1', '--c1-timeout-ms', '180000']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(data(r).workBudgetMs, 180000);
});

test('GIVEN never-ready zero pid PTY WHEN deadline expires THEN owned handle is killed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-zero-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.pid = 0;
  child.onData = () => {};
  child.onExit = fn => child.on('exit', fn);
  child.kill = () => { child.killed = true; child.emit('exit'); };
  const ctx = { opts: { home: root, dryRun: true, backend: 'fake-pty' }, env: {}, repo: root, run: root, runtime: root,
    deadline: Date.now() + 100, processes: [], evidence: { processes: [] }, ptyFactory: () => child };
  await assert.rejects(harness.launch(ctx), /non-zero pid/);
  await harness.stop(ctx, ctx.processes[0]);
  assert.equal(child.killed, true);
  assert.equal(ctx.processes[0].record.cleaned, true);
});

test('GIVEN unreadable bounded transcript WHEN stopping confirmed PTY THEN owned handle still exits', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-stop-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude/projects/fixture');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fixture.jsonl'), Buffer.alloc(16 * 1024 * 1024 + 1));
  const proc = { id: 'fixture', isPty: true, exited: false, record: { cleaned: false, descriptorConfirmation: {} },
    child: { kill: () => { proc.exited = true; } } };
  await harness.stop({ opts: { dryRun: true, home } }, proc);
  assert.equal(proc.record.cleaned, true);
  assert.equal(proc.record.shutdown.forcedKill, true);
});

test('GIVEN delayed PTY pid WHEN launch and stop THEN match fresh identity and kill owned handle', async t => {
  assert.equal(typeof harness.launch, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-pty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = path.join(root, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const ctx = { opts: { home: root, dryRun: true, backend: 'fake-pty' }, env: {}, repo: root, run: root, runtime: root,
    deadline: Date.now() + 2000, processes: [], evidence: { processes: [] },
    ptyFactory: (_exe, args, config) => {
      const child = new EventEmitter();
      child.pid = 0;
      child.onData = () => {};
      child.onExit = fn => child.on('exit', fn);
      child.kill = () => { child.killed = true; child.emit('exit'); };
      setTimeout(() => {
        child.pid = 123456;
        const sid = args[args.indexOf('--session-id') + 1];
        fs.writeFileSync(path.join(sessions, '123456.json'), JSON.stringify({ pid: child.pid, sessionId: sid,
          startedAt: Date.now(), procStart: config.env.CANARY_FIXTURE_PROC_START, status: 'idle', cwd: root }));
        child.emit('ready');
      }, 30);
      return child;
    } };
  const proc = await harness.launch(ctx);
  assert.equal(proc.pid, 123456);
  await harness.stop(ctx, proc);
  assert.equal(proc.child.killed, true);
  assert.equal(proc.record.cleaned, true);
});

for (const defect of ['session-id', 'started-at', 'proc-start', 'preexisting']) {
  test(`GIVEN ${defect} stale descriptor WHEN launching THEN wait for fresh owned descriptor`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-stale-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sessions = path.join(root, '.claude/sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const stale = path.join(sessions, '123456.json');
    if (defect === 'preexisting') {
      const identity = '11111111-1111-4111-8111-111111111111';
      t.mock.method(crypto, 'randomUUID', () => identity);
      fs.writeFileSync(stale, JSON.stringify({ pid: 123456, sessionId: identity, startedAt: Date.now() + 10000,
        procStart: identity, status: 'idle', cwd: root }));
    }
    let published = false;
    const ctx = { opts: { home: root, dryRun: true, backend: 'fake-pty' }, env: {}, repo: root, run: root, runtime: root,
      deadline: Date.now() + 2000, processes: [], evidence: { processes: [] },
      ptyFactory: (_exe, args, config) => {
        const child = new EventEmitter();
        child.pid = 123456;
        child.onData = () => {};
        child.onExit = fn => child.on('exit', fn);
        child.kill = () => child.emit('exit');
        const good = { pid: child.pid, sessionId: args[args.indexOf('--session-id') + 1], startedAt: Date.now(),
          procStart: config.env.CANARY_FIXTURE_PROC_START, status: 'idle', cwd: root };
        if (defect !== 'preexisting') fs.writeFileSync(stale, JSON.stringify({ ...good, ...(defect === 'session-id' ? { sessionId: 'stale-id' } : {}),
          ...(defect === 'started-at' ? { startedAt: 1 } : {}), ...(defect === 'proc-start' ? { procStart: 'reused' } : {}) }));
        const timer = setTimeout(() => {
          published = true;
          fs.writeFileSync(path.join(sessions, '654321.json'), JSON.stringify(good));
        }, 150);
        t.after(() => clearTimeout(timer));
        return child;
      } };
    const proc = await harness.launch(ctx);
    try { assert.equal(published, true, 'stale descriptor accepted before fresh publication'); }
    finally { await harness.stop(ctx, proc); }
  });
}

test('GIVEN reused pid filename WHEN new owned process publishes THEN accept only its fresh descriptor', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-reused-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = { opts: { home: root, dryRun: true, backend: 'fake-pty' }, env: {}, repo: root, run: root, runtime: root,
    deadline: Date.now() + 1000, processes: [], evidence: { processes: [] },
    ptyFactory: (_exe, args, config) => {
      const child = new EventEmitter();
      child.pid = 123456;
      child.onData = () => {};
      child.onExit = fn => child.on('exit', fn);
      child.kill = () => child.emit('exit');
      fs.writeFileSync(path.join(root, '.claude/sessions/123456.json'), JSON.stringify({ pid: child.pid,
        sessionId: args[args.indexOf('--session-id') + 1], startedAt: Date.now(),
        procStart: config.env.CANARY_FIXTURE_PROC_START, status: 'idle', cwd: root }));
      return child;
    } };
  const first = await harness.launch(ctx);
  await harness.stop(ctx, first);
  const second = await harness.launch(ctx);
  await harness.stop(ctx, second);
  assert.notEqual(second.id, first.id);
  assert.equal(second.pid, first.pid);
});
