'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sendToBackground } = require('../bg-handoff');
const { createTriggerContext } = require('../src/main/triggers/trigger-context');
const { start } = require('../src/main/triggers/trigger-watcher');
const { createComposerState } = require('../src/main/terminals/composer-state');

async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fixture condition was not reached');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('L1: a real automation trigger cannot interleave its text or Enter with a handoff', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-trigger-'));
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const writes = [];
  const session = { kind: 'local-pty', generation: 1, cwd: '/project', composerState: createComposerState(), pty: { pid: process.pid, write: data => writes.push(data) } };
  const sessions = new Map([['old', session]]);
  const ctx = createTriggerContext({ activeSessions: sessions, log: { info() {}, warn() {}, error() {} }, isPtyAlive: () => !session.exited,
    cliSessionState: { deliveryPtyStart: () => null }, observeTabWriter: () => ({ writer: { sessionId: 'old' } }),
  });
  let pinned = false;
  const pin = ctx.pinDelivery;
  ctx.pinDelivery = (...args) => { pinned = true; return pin(...args); };
  const watcher = start(ctx);
  let resume, time = 0;
  const gate = new Promise(resolve => { resume = resolve; });
  const moving = sendToBackground('old', {
    getSession: () => session, getStatus: () => 'idle', now: () => time,
    readContinuationIds: () => session.exited ? ['new'] : [],
    readDescriptors: () => [{ sessionId: 'new', kind: 'bg', jobId: '1234abcd' }],
    tapOutput: () => () => {},
    write: (_, data) => { writes.push(data); if (data === '\r') session.exited = true; return true; },
    delay: async () => { await gate; time = 300; }, waitForChange: async ms => { time += ms; },
  });
  try {
    await until(() => writes.length === 1);
    fs.writeFileSync(path.join(root, 'trigger.json'), JSON.stringify({ sessionId: 'old', command: 'reply', wait: 'none', timeout_ms: 3000 }));
    await until(() => pinned);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(writes, ['/bg']);
    resume();
    assert.equal((await moving).ok, true);
    await until(() => fs.existsSync(path.join(root, 'processed', 'trigger.result.json')));
    assert.deepEqual(writes, ['/bg', '\r']);
  } finally { resume(); await moving; watcher.close(); }
});

test('L2: a trigger queued behind a handoff whose Enter was withheld refuses on the /bg left in the composer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-trigger-'));
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const writes = [];
  const session = { kind: 'local-pty', generation: 1, cwd: '/project', composerState: createComposerState(), pty: { pid: process.pid, write: data => writes.push(data) } };
  const sessions = new Map([['old', session]]);
  const ctx = createTriggerContext({ activeSessions: sessions, log: { info() {}, warn() {}, error() {} }, isPtyAlive: () => !session.exited,
    cliSessionState: { deliveryPtyStart: () => null }, observeTabWriter: () => ({ writer: { sessionId: 'old' } }),
  });
  let pinned = false;
  const pin = ctx.pinDelivery;
  ctx.pinDelivery = (...args) => { pinned = true; return pin(...args); };
  const watcher = start(ctx);
  let resume, status = 'idle';
  const gate = new Promise(resolve => { resume = resolve; });
  const moving = sendToBackground('old', {
    getSession: () => session, getStatus: () => status, now: Date.now,
    readContinuationIds: () => [], readDescriptors: () => [],
    tapOutput: () => () => {},
    write: (_, data) => { writes.push(data); return true; },
    delay: async () => { await gate; status = 'waiting'; }, waitForChange: async () => {},
  });
  try {
    await until(() => writes.length === 1);
    fs.writeFileSync(path.join(root, 'trigger.json'), JSON.stringify({ sessionId: 'old', command: 'reply', wait: 'none', timeout_ms: 1500 }));
    await until(() => pinned);
    resume();
    assert.equal((await moving).code, 'write-failed');
    status = 'idle';
    await until(() => writes.length > 1 || fs.existsSync(path.join(root, 'processed', 'trigger.result.json')));
    assert.deepEqual(writes, ['/bg']);
    await until(() => fs.existsSync(path.join(root, 'processed', 'trigger.result.json')));
    const result = JSON.parse(fs.readFileSync(path.join(root, 'processed', 'trigger.result.json'), 'utf8'));
    assert.match(JSON.stringify(result), /unsubmitted in the composer/);
    assert.deepEqual(writes, ['/bg']);
  } finally { resume(); await moving; watcher.close(); }
});
