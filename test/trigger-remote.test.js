'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '10';
process.env.SWITCHBOARD_BUSY_RISE_WAIT_MS = '10';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../trigger-watcher');
const { createTriggerContext } = require('../trigger-context');
const { createRemoteIndexer } = require('../remote-index');
const log = { info() {}, warn() {}, error() {}, debug() {} };
const NO_FRESH = 'fewer than two pulls of the session descriptors of this host completed after the wait began, before the deadline; nothing was written';
const UNKNOWN = 'the descriptor of this host carries no readable status; whether the session is idle is unknown; nothing was written';
const SHELL = 'the session reports a shell command running (shell); nothing was written';
const SLASH = 'a slash command other than /compact and /clear cannot be sent to a remote session; nothing was written';
const BASH = 'a bash-mode command cannot be sent to a remote session; nothing was written';
const MEMORY = 'a memory command cannot be sent to a remote session; nothing was written';
const FORMAT = 'format-char';

function fixture(lookup, outcome = { ok: true }) {
  const calls = [];
  let reads = 0;
  const descriptor = { sessionId: 'remote', pid: 42, messagingSocketPath: '/tmp/42.sock', cwd: '/srv/app', status: 'idle', statusUpdatedAt: 77 };
  const snapshot = () => ({ alias: 'vps', descriptor, at: Date.now(), error: null, maxAgeMs: 120000 });
  const ctx = {
    log, getPtyForSession: () => null, isSessionBusy: () => false,
    remote: {
      lookup: () => lookup ? lookup(++reads, snapshot()) : (reads++, snapshot()),
      send: async (...args) => { calls.push({ args, at: Date.now(), reads }); return typeof outcome === 'function' ? outcome(...args) : outcome; },
    },
  };
  return { ctx, calls, descriptor, reads: () => reads };
}

async function run(s, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-trigger-remote-'));
  const old = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = dir;
  const hold = setInterval(() => {}, 20);
  const watcher = start(s.ctx);
  try {
    fs.writeFileSync(path.join(dir, 'one.json'), JSON.stringify({ sessionId: 'remote', command: 'hello', timeout_ms: 500, ...extra }));
    const resultPath = path.join(dir, 'processed', 'one.result.json');
    const deadline = Date.now() + 6000;
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline) throw new Error('result deadline');
      await new Promise(r => setTimeout(r, 10));
    }
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } finally {
    watcher.close(); clearInterval(hold);
    if (old === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const host of [null, 'vps']) test(`U1: a live ${host ? 'attached' : 'local'} entry wins without remote lookup`, async () => {
  const s = fixture(); const writes = [];
  const pty = { pid: process.pid, write: data => writes.push(data) };
  const local = createTriggerContext({ activeSessions: new Map([['remote', { pty, host, handle: { write: pty.write, isAlive: () => true }, composerState: { pending: 0, lastInputAt: 0 } }]]), log, isPtyAlive: () => true });
  Object.assign(s.ctx, local);
  const r = await run(s);
  assert.equal(r.ok, true); assert.equal(s.reads(), 0); assert.deepEqual(writes.slice(0, 2), ['hello', '\r']); assert.ok(writes.every((v, i) => i === 0 || v === '\r')); assert.equal(r.channel, undefined);
});

test('U2: an unattached remote uses the socket and reports assumed only', async () => {
  const s = fixture(); const r = await run(s);
  assert.equal(r.ok, true); assert.equal(r.submitted, 'assumed'); assert.equal(r.channel, 'socket'); assert.equal(r.host, 'vps');
  assert.equal(r.submit_retries, 0); assert.equal(r.steps_total, 1); assert.equal(r.submit_confirmed, undefined);
  assert.equal(typeof r.sent_at, 'string'); assert.ok(Number.isFinite(Date.parse(r.sent_at)));
  assert.equal(s.calls.length, 1); assert.deepEqual(s.calls[0].args, ['vps', s.descriptor, 'hello']);
});
test('U3: multiple hosts refuse the id without sending', async () => {
  const s = fixture(() => ({ aliases: ['vps', 'other'] })); const r = await run(s);
  assert.equal(r.error, 'not sent'); assert.match(r.reason, /more than one host.*vps.*other.*nothing was written/); assert.equal(s.calls.length, 0);
});
test('U4 GUARD: trigger host fields cannot select the destination', async () => {
  const s = fixture(); await run(s, { host: 'evil', alias: 'evil', remoteAlias: 'evil' });
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].args[0], 'vps');
});
test('U5: a remote chain is refused with its step count', async () => {
  const s = fixture(); const r = await run(s, { command: undefined, chain: [{ command: 'a' }, { command: 'b' }] });
  assert.equal(r.error, 'not sent'); assert.match(r.reason, /chain cannot be sent.*nothing was written/); assert.equal(r.steps_total, 2); assert.equal(s.calls.length, 0);
});
test('U6: old idle pulls do not count toward the two completed pulls', async () => {
  const s = fixture((n, snap) => ({ ...snap, at: n <= 2 ? 1 : snap.at }));
  const r = await run(s, { wait: 'idle', timeout_ms: 1500 });
  assert.equal(r.ok, true); assert.ok(s.calls[0].reads >= 5);
});
test('U6: completed pulls from different hosts cannot establish idle freshness', async () => {
  const s = fixture((n, snap) => ({ ...snap, alias: n >= 3 ? 'other' : 'vps', descriptor: { ...snap.descriptor, status: n >= 3 ? 'idle' : 'busy' } }));
  const r = await run(s, { wait: 'idle', timeout_ms: 1500 });
  assert.equal(r.error, 'not sent'); assert.match(r.reason, /another host/); assert.equal(s.calls.length, 0);
});
test('U7: fresh busy then idle permits one send', async () => {
  const s = fixture((n, snap) => ({ ...snap, descriptor: { ...snap.descriptor, status: n < 4 ? 'busy' : 'idle' } }));
  assert.equal((await run(s, { wait: 'idle', timeout_ms: 1500 })).ok, true); assert.ok(s.calls[0].reads >= 4);
});
for (const [status, reason] of [['waiting', 'the CLI reports a dialog open (waiting); nothing was written into it'], ['busy', 'the CLI still reported a turn running (busy) at the deadline; nothing was written'], ['shell', SHELL]]) {
  test(`U7/U8: fresh ${status} waits until its own deadline reason`, async () => {
    const s = fixture((n, snap) => ({ ...snap, descriptor: { ...snap.descriptor, status } }));
    const r = await run(s, { wait: 'idle', timeout_ms: 350 });
    assert.equal(r.error, 'not sent'); assert.equal(r.reason, reason); assert.ok(r.waited_ms >= 350); assert.equal(s.calls.length, 0);
  });
}
test('U7: an unchanged pull expires with the no-fresh-pull reason', async () => {
  const s = fixture((n, snap) => ({ ...snap, at: 1 })); const r = await run(s, { wait: 'idle', timeout_ms: 150 });
  assert.equal(r.reason, NO_FRESH); assert.equal(s.calls.length, 0);
});
for (const status of [undefined, 'unknown']) test(`U8: fresh ${status} status fails closed`, async () => {
  const s = fixture((n, snap) => ({ ...snap, descriptor: { ...snap.descriptor, status } }));
  const r = await run(s, { wait: 'idle', timeout_ms: 1500 });
  assert.equal(r.error, 'not sent'); assert.equal(r.reason, UNKNOWN); assert.ok(r.waited_ms < 1000); assert.equal(s.calls.length, 0);
});
test('U9: a descriptor vanishing during idle wait reports exit', async () => {
  const s = fixture((n, snap) => n >= 3 ? null : { ...snap, descriptor: { ...snap.descriptor, status: 'busy' } });
  const r = await run(s, { wait: 'idle' }); assert.equal(r.error, 'session exited during wait'); assert.equal(r.submitted, 'no'); assert.equal(s.calls.length, 0);
});
test('U10: a mid-wait attachment aborts before another descriptor poll', async () => {
  const s = fixture((n, snap) => ({ ...snap, descriptor: { ...snap.descriptor, status: n >= 8 ? 'idle' : 'busy' } }));
  s.ctx.getPtyForSession = () => s.reads() >= 3 ? {} : null;
  const r = await run(s, { wait: 'idle', timeout_ms: 1500 });
  assert.equal(r.error, 'not sent'); assert.match(r.reason, /attached.*nothing was written/); assert.equal(s.reads(), 3); assert.equal(s.calls.length, 0);
});
test('U10: attachment immediately before a none write is refused', async () => {
  const s = fixture(); s.ctx.getPtyForSession = () => s.reads() ? {} : null;
  assert.match((await run(s)).reason, /attached/); assert.equal(s.calls.length, 0);
});
for (const [cwd, expectedCwd, key] of [['/srv/App', '/srv/app', 'targetMismatch'], [undefined, '/srv/app', 'targetCwdUnknown']]) test(`U11: cwd guard ${key}`, async () => {
  const s = fixture(); s.descriptor.cwd = cwd; const r = await run(s, { expectedCwd });
  assert.equal(r.error, 'not sent'); assert.equal(r[key], true); assert.equal(s.calls.length, 0);
});
test('U11: POSIX normalization accepts a trailing slash and parent segment', async () => {
  const s = fixture(); assert.equal((await run(s, { expectedCwd: '/srv/x/../app/' })).ok, true);
});
for (const code of ['invalid', 'windows', 'dedupe', 'rate', 'nc-missing', 'no-socket', 'runner', 'not-claude', 'timeout', 'exit']) test(`U12: adapter ${code} maps without overstating certainty`, async () => {
  const ambiguous = ['timeout', 'exit'].includes(code);
  const s = fixture(null, { ok: false, code, error: 'adapter reason', ...(ambiguous ? { maybeWritten: true } : {}) });
  const r = await run(s);
  assert.equal(r.error, ambiguous ? 'send unconfirmed' : code === 'not-claude' ? 'target process not running' : 'not sent');
  assert.equal(r.submitted, 'no'); assert.equal(r.reason, 'adapter reason'); assert.equal(r.written, ambiguous ? 'unknown' : undefined);
});
test('U13: result snapshots descriptor fields before the send mutates them', async () => {
  const s = fixture(null, (alias, desc) => { desc.status = 'busy'; desc.statusUpdatedAt = 99; return { ok: true }; });
  const r = await run(s); assert.equal(r.descriptor.status, 'idle'); assert.equal(r.descriptor.status_updated_at, 77); assert.ok(r.descriptor.pulled_at <= s.calls[0].at);
});
test('U13: absent descriptor fields are explicitly null', async () => {
  const s = fixture(); delete s.descriptor.status; delete s.descriptor.statusUpdatedAt;
  const r = await run(s); assert.equal(r.descriptor.status, null); assert.equal(r.descriptor.status_updated_at, null);
});
for (const [command, error] of [['x'.repeat(4097), 'command too long (max 4 KB)'], ['x\ny', 'command contains forbidden control characters (\\r \\n \\0 \\x1b)']]) test(`U14: ${error} precedes lookup`, async () => {
  const s = fixture(); const r = await run(s, { command }); assert.equal(r.error, error); assert.equal(s.reads(), 0);
});
for (const off of [true, false]) test(`U15/U22: setting ${off ? 'off' : 'on without descriptor'} preserves not-found result`, async () => {
  const s = fixture(() => null); if (off) delete s.ctx.remote;
  const r = await run(s); assert.deepEqual(r, { ok: false, error: 'session not found', sessionId: 'remote', submitted: 'no', steps_total: 1 });
});
test('U20 GUARD: trigger modules cannot require a process spawner', () => {
  for (const file of ['trigger-watcher.js', 'trigger-context.js']) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), /require\(['"](?:node:)?child_process['"]\)/);
});
for (const command of ['/compact', '/clear', '  /compact  ', 'compact']) test(`U21: allowed command ${command} sends its canonical text`, async () => {
  const s = fixture(); assert.equal((await run(s, { command })).ok, true); assert.equal(s.calls[0].args[2], command.trim());
});
for (const command of ['/compact now', '/Compact', '/model', '//x']) test(`U21: unsupported slash ${command} is refused before waiting`, async () => {
  const s = fixture(); const r = await run(s, { command, wait: 'idle', timeout_ms: 1500 });
  assert.equal(r.error, 'not sent'); assert.equal(r.reason, SLASH); assert.equal(s.reads(), 1); assert.equal(s.calls.length, 0);
});
for (const prefix of ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', ' \u200b\t\u2060 ']) {
  test(`U21: invisible prefix ${JSON.stringify(prefix)} cannot hide a slash command`, async () => {
    const s = fixture(); const r = await run(s, { command: prefix + '/model', wait: 'idle', timeout_ms: 1500 });
    assert.equal(r.error, 'not sent'); assert.equal(r.reason, FORMAT); assert.equal(s.reads(), 1); assert.equal(s.calls.length, 0);
  });
}
for (const [command, reason] of [['!ls', BASH], [' !ls', BASH], ['\u200b!ls', FORMAT], ['#note', MEMORY], [' \u2060#note', FORMAT]]) {
  test(`U21: mode prefix ${JSON.stringify(command)} is refused before waiting`, async () => {
    const s = fixture(); const r = await run(s, { command, wait: 'idle', timeout_ms: 1500 });
    assert.equal(r.error, 'not sent'); assert.equal(r.reason, reason); assert.equal(s.reads(), 1); assert.equal(s.calls.length, 0);
  });
}
for (const command of ['say hello! and describe #note', '  keep ! and # in the middle  ', 'hello 😀']) {
  test(`U21: plain prompt ${JSON.stringify(command)} is sent unchanged`, async () => {
    const s = fixture(); assert.equal((await run(s, { command })).ok, true); assert.equal(s.calls[0].args[2], command);
  });
}
test('U21: format characters before an allowed slash are refused', async () => {
  const s = fixture(); const r = await run(s, { command: ' \u200b\u2060 /clear  ' });
  assert.equal(r.reason, FORMAT); assert.equal(s.calls.length, 0);
});

test('U21: slash, bash, memory and format refusals have distinct reasons', () => {
  assert.equal(new Set([SLASH, BASH, MEMORY, FORMAT]).size, 4);
});

const formatCodePoints = [0x00ad, 0x034f, 0x061c, 0x180e, 0x2060, 0xfeff, 0x0600, 0x0890, 0x110bd, 0x13430, 0x1bca0];
for (const [first, last] of [[0x200b, 0x200f], [0x202a, 0x202e], [0x2061, 0x2064], [0x2066, 0x2069], [0xfe00, 0xfe0f], [0xe0000, 0xe007f], [0xe0100, 0xe01ef]]) {
  for (let codePoint = first; codePoint <= last; codePoint++) formatCodePoints.push(codePoint);
}
for (const codePoint of formatCodePoints) {
  const character = String.fromCodePoint(codePoint);
  test(`U28: U+${codePoint.toString(16).toUpperCase()} is refused at the start, middle and end of a remote prompt`, async () => {
    for (const command of [character + 'hello', 'he' + character + 'llo', 'hello' + character]) {
      const s = fixture(); const r = await run(s, { command, wait: 'idle', timeout_ms: 1500 });
      assert.equal(r.ok, false); assert.equal(r.error, 'not sent'); assert.equal(r.submitted, 'no');
      assert.equal(r.reason, FORMAT); assert.equal(s.reads(), 1); assert.equal(s.calls.length, 0);
    }
  });
}
for (const command of ['\u202e/model', '/compact\u034f', '/cl\ufe0fear', '\u200d/compact', '👩\u200d💻']) {
  test(`U28: ${JSON.stringify(command)} is refused with the format reason before prefix handling`, async () => {
    const s = fixture(); const r = await run(s, { command, wait: 'idle', timeout_ms: 1500 });
    assert.equal(r.error, 'not sent'); assert.equal(r.submitted, 'no'); assert.equal(r.reason, FORMAT);
    assert.equal(s.reads(), 1); assert.equal(s.calls.length, 0);
  });
}
for (const host of [null, 'vps']) test(`U28: ${host ? 'attached' : 'local'} delivery preserves format characters and ZWJ emoji`, async () => {
  const s = fixture(); const writes = [];
  const pty = { pid: process.pid, write: data => writes.push(data) };
  const local = createTriggerContext({ activeSessions: new Map([['remote', { pty, host, handle: { write: pty.write, isAlive: () => true }, composerState: { pending: 0, lastInputAt: 0 } }]]), log, isPtyAlive: () => true });
  Object.assign(s.ctx, local);
  const command = formatCodePoints.map(codePoint => String.fromCodePoint(codePoint)).join('') + '👩\u200d💻';
  const r = await run(s, { command });
  assert.equal(r.ok, true); assert.equal(r.channel, undefined); assert.equal(s.reads(), 0); assert.equal(s.calls.length, 0);
  assert.equal(writes[0], command); assert.ok(writes.slice(1).every(value => value === '\r'));
});

test('U22: main uses a dynamic opt-in getter and the central default', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /get remote\(\)/); assert.match(source, /remoteTriggers\s*\?\?\s*SETTING_DEFAULTS\.remoteTriggers/);
  assert.match(source, /remoteTriggers[^\n]+=== true/);
  assert.equal(require('../public/setting-defaults').SETTING_DEFAULTS.remoteTriggers, false);
  const start = source.indexOf('get remote()');
  const end = source.indexOf('\n      }));', start);
  let settings = {};
  const indexer = {}; const adapter = {};
  const { SETTING_DEFAULTS } = require('../public/setting-defaults');
  const { enabledHosts, normalizeRefreshMs } = require('../remote-hosts');
  const deps = new Function('getSetting', 'SETTING_DEFAULTS', 'remoteIndexer', 'remoteSendAdapter', 'enabledHosts', 'normalizeRefreshMs', 'return ({' + source.slice(start, end) + '});')(() => settings, SETTING_DEFAULTS, indexer, adapter, enabledHosts, normalizeRefreshMs);
  assert.equal(deps.remote, undefined);
  settings = { remoteTriggers: true, remoteHosts: [{ alias: 'vps' }], remoteRefreshMs: 1 };
  assert.equal(deps.remote.indexer, indexer); assert.equal(deps.remote.adapter, adapter);
  assert.equal(deps.remote.maxAgeMs, 120000); assert.equal(deps.remote.isEnabled('vps'), true);
  settings.remoteHosts[0].enabled = false; assert.equal(deps.remote.isEnabled('vps'), false);
  settings.remoteTriggers = false; assert.equal(deps.remote, undefined);
});
test('U22: each remote lookup reads global settings once for all aliases and rereads on the next poll', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('get remote()'); const end = source.indexOf('\n      }));', start);
  const descriptor = { sessionId: 'remote' };
  const hosts = [{ alias: 'vps' }, { alias: 'other', enabled: false }, { alias: 'third', enabled: false }];
  let settings = { remoteTriggers: true, remoteHosts: hosts }; let reads = 0;
  const indexer = {
    findSessionAliases: (id, isEnabled) => hosts.filter(host => isEnabled(host.alias)).map(host => host.alias),
    getRemoteSessions: () => ({ sessions: [descriptor], at: 42, error: null }),
  };
  const { SETTING_DEFAULTS } = require('../public/setting-defaults');
  const { enabledHosts, normalizeRefreshMs } = require('../remote-hosts');
  const deps = new Function('getSetting', 'SETTING_DEFAULTS', 'remoteIndexer', 'remoteSendAdapter', 'enabledHosts', 'normalizeRefreshMs', 'return ({' + source.slice(start, end) + '});')(
    key => { assert.equal(key, 'global'); reads++; return settings; }, SETTING_DEFAULTS, indexer, {}, enabledHosts, normalizeRefreshMs);
  const ctx = createTriggerContext({ activeSessions: new Map(), log, get remote() { return deps.remote; } });
  for (const alias of ['vps', 'other']) {
    hosts.forEach(host => { host.enabled = host.alias === alias; });
    reads = 0;
    assert.equal(ctx.remote.lookup('remote').alias, alias); assert.equal(reads, 1);
  }
  settings = { ...settings, remoteTriggers: false }; reads = 0;
  assert.equal(ctx.remote, undefined); assert.equal(reads, 1);
});
for (const at of [null, 1]) test(`U24: stale pull ${at} carries the backoff reason`, async () => {
  const s = fixture((n, snap) => ({ ...snap, at, error: 'ssh backoff' })); const r = await run(s);
  assert.equal(r.error, 'not sent'); assert.equal(r.reason, 'the descriptors of this host are older than twice its refresh interval (last refresh error: ssh backoff); nothing was written'); assert.equal(s.calls.length, 0);
});
test('U24: a pull inside the age bound sends and records pulled_at', async () => {
  const at = Date.now() - 1000; const s = fixture((n, snap) => ({ ...snap, at })); const r = await run(s);
  assert.equal(r.ok, true); assert.equal(r.descriptor.pulled_at, at);
});
test('U25: an exited remote pane falls through to socket delivery', async () => {
  const s = fixture(); const local = createTriggerContext({ activeSessions: new Map([['remote', { exited: true, host: 'vps', pty: {} }]]), log });
  s.ctx.getPtyForSession = local.getPtyForSession;
  assert.equal((await run(s)).channel, 'socket'); assert.equal(s.calls.length, 1);
});
for (const midWait of [false, true]) test(`U23: disabling a real indexed host ${midWait ? 'during idle wait' : 'before trigger'} prevents sending`, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-remote-enabled-'));
  let enabled = midWait; let reads = 0;
  const indexer = createRemoteIndexer({
    dataDir, getHosts: () => [{ alias: 'vps' }], transport: {}, timers: { setInterval() {}, clearInterval() {} },
    scanFolders: async () => ({ ok: true }), listIndexedFolderKeys: () => [],
    sync: async () => ({ fetched: 0, unchanged: 0, removed: 0, failed: 0, total: 0, changedFolders: new Set(), sessions: [{ sessionId: 'remote', status: 'busy', pid: 42 }] }),
  });
  try {
    await indexer.refreshNow();
    const s = fixture();
    const ctx = createTriggerContext({ activeSessions: new Map(), log, remote: { indexer, adapter: s.ctx.remote, maxAgeMs: 120000, isEnabled: () => { if (++reads >= 3) enabled = false; return enabled; } } });
    s.ctx = ctx;
    const r = await run(s, midWait ? { wait: 'idle', timeout_ms: 500 } : {});
    assert.equal(r.error, midWait ? 'session exited during wait' : 'session not found'); assert.equal(s.calls.length, 0);
  } finally { indexer.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
test('U26: the first post-start idle pull is insufficient, including repeated reads', async () => {
  let first;
  const s = fixture((n, snap) => { if (n === 2) first = snap.at; return { ...snap, at: n === 1 || n >= 5 ? snap.at : first }; });
  assert.equal((await run(s, { wait: 'idle', timeout_ms: 1500 })).ok, true); assert.ok(s.calls[0].reads >= 6);
});
test('U27: a second trigger waits for the first remote idle wait and send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-remote-lock-'));
  const old = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = dir;
  const hold = setInterval(() => {}, 20); let release; let entered;
  const started = new Promise(r => { entered = r; }); const pending = new Promise(r => { release = r; });
  const s = fixture(null, async (alias, descriptor, text) => { if (text === 'first') { entered(); await pending; } return { ok: true }; });
  const watcher = start(s.ctx);
  try {
    fs.writeFileSync(path.join(dir, 'first.json'), JSON.stringify({ sessionId: 'remote', command: 'first', wait: 'idle', timeout_ms: 1500 }));
    let timer;
    try { await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('first send did not start')), 3000); })]); }
    finally { clearTimeout(timer); }
    fs.writeFileSync(path.join(dir, 'second.json'), JSON.stringify({ sessionId: 'remote', command: 'second' }));
    await new Promise(r => setTimeout(r, 200)); assert.equal(s.calls.length, 1);
    release();
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(path.join(dir, 'processed', 'second.result.json'))) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); }
    assert.deepEqual(s.calls.map(c => c.args[2]), ['first', 'second']);
  } finally {
    release(); watcher.close(); clearInterval(hold);
    if (old === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(process.env.SWITCHBOARD_TRIGGERS_DIR, old);
});
