'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '100';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../trigger-watcher');
const { createTriggerContext } = require('../trigger-context');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const id = 'escape-session';

async function run(payload, options = {}) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-escape-')));
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;
  const written = [];
  const ptyProcess = { pid: process.pid, write: data => written.push(data) };
  const session = { pty: ptyProcess, cwd: tmp, generation: 1, realSessionId: id, host: options.attachedRemote ? 'vps' : null };
  const desc = { status: options.status ?? 'waiting', statusUpdatedAt: Date.now() };
  const getCliStatus = () => {
    if (options.descriptorThrows) throw new Error('descriptor unreadable');
    return options.noDescriptor ? undefined : { ...desc };
  };
  const ctx = options.realContext ? createTriggerContext({
    activeSessions: new Map([[id, session]]), log: silent,
    getCliStatus, isPtyAlive: () => !options.dead,
    observeTabWriter: () => ({ writer: { sessionId: id }, outcome: 'mine' }),
    cliSessionState: { deliveryPtyStart: () => null, observeTabWriter: () => ({ writer: { sessionId: id }, outcome: 'mine' }) },
  }) : {
    log: silent,
    getPtyForSession: () => options.missing || options.remote ? null : { ptyProcess, cwd: tmp, session },
    getCliStatus,
    isSessionBusy: () => false,
    isPtyAlive: () => !options.dead,
    getComposerState: () => ({ pending: 0, lastInputAt: 0 }),
  };
  ctx.remote = {
    lookup: () => options.remote ? { alias: 'vps', descriptor: { status: 'waiting' } } : null,
    send: () => { written.push('remote send'); throw new Error('unexpected remote send'); },
  };
  const watcher = start(ctx);
  try {
    fs.writeFileSync(path.join(tmp, 'escape.json'), JSON.stringify({ sessionId: id, key: 'escape', ...payload }));
    const resultPath = path.join(tmp, 'processed', 'escape.result.json');
    const deadline = performance.now() + 5000;
    while (!fs.existsSync(resultPath)) {
      assert.ok(performance.now() < deadline, 'result file must be produced');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { result: JSON.parse(fs.readFileSync(resultPath, 'utf8')), written };
  } finally {
    watcher.close();
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('waiting local session receives exactly one Escape without Enter', async () => {
  const { result, written } = await run({});
  assert.deepEqual(written, ['\x1b']);
  assert.equal(result.ok, true);
  assert.equal(result.key, 'escape');
  assert.equal(result.sessionId, id);
});

for (const status of ['idle', 'busy', 'shell']) {
  test(`${status} session refuses Escape with its current status`, async () => {
    const { result, written } = await run({}, { status });
    assert.deepEqual(written, []);
    assert.equal(result.ok, false);
    assert.equal(result.reason, `session not waiting on a question or permission (status: ${status})`);
  });
}

for (const [name, options, reason] of [
  ['unknown', { missing: true }, 'session not found'],
  ['remote without tab', { remote: true }, 'escape is not supported on remote sessions'],
  ['remote with tab', { attachedRemote: true }, 'escape is not supported on remote sessions'],
  ['dead', { dead: true }, 'target process not running'],
  ['missing descriptor', { noDescriptor: true }, 'session not waiting on a question or permission (status: unknown)'],
  ['unreadable descriptor', { descriptorThrows: true }, 'session not waiting on a question or permission (status: unknown)'],
]) {
  test(`${name} session refuses Escape without writing`, async () => {
    const { result, written } = await run({}, options);
    assert.deepEqual(written, []);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
  });
}

for (const [name, payload, reason] of [
  ['command', { command: 'hello' }, 'key and command are mutually exclusive'],
  ['enter', { key: 'enter' }, 'unsupported key: only "escape" is supported'],
  ['null', { key: null }, 'unsupported key: only "escape" is supported'],
  ['chain', { chain: [{ command: 'hello' }] }, 'key does not support chain'],
  ['wait none', { wait: 'none' }, 'key does not support wait'],
  ['wait idle', { wait: 'idle' }, 'key does not support wait'],
]) {
  test(`key with ${name} is refused without writing`, async () => {
    const { result, written } = await run(payload);
    assert.deepEqual(written, []);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
  });
}

test('command containing Escape still refuses forbidden control characters', async () => {
  const { result, written } = await run({ key: undefined, command: 'hello\x1b' }, { status: 'idle' });
  assert.deepEqual(written, []);
  assert.equal(result.ok, false);
  assert.match(result.error, /command contains forbidden control characters/);
});

test('real trigger context sends Escape through the pinned local PTY', async () => {
  const { result, written } = await run({}, { realContext: true });
  assert.deepEqual(written, ['\x1b']);
  assert.equal(result.ok, true);
});
