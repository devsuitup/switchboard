'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', 'public', 'cli-liveness.js');

function harness({ online = true, restartResult = true } = {}) {
  const { createCliLiveness, CLI_LIVENESS_NO_CLI_MS, CLI_LIVENESS_RESTART_TIMEOUT_MS } = require(MODULE);
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const changes = [];
  const restarts = [];
  const net = { online };
  const tracker = createCliLiveness({
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: id => { timers.delete(id); },
    isOnline: () => net.online,
    onChange: id => changes.push(id),
    restart: async id => { restarts.push(id); return restartResult; },
  });
  const advance = async ms => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await new Promise(resolve => setImmediate(resolve));
    }
    now = until;
    await new Promise(resolve => setImmediate(resolve));
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { tracker, advance, flush, changes, restarts, net, timers, NO_CLI: CLI_LIVENESS_NO_CLI_MS, RESTART: CLI_LIVENESS_RESTART_TIMEOUT_MS };
}

test('GIVEN a restored session whose bridge listens WHEN no CLI connects within the delay THEN it is reported as having no CLI', async () => {
  const h = harness();
  h.tracker.expect('s1');
  h.tracker.mcpState('s1', 'listening');
  await h.advance(h.NO_CLI - 1);
  assert.equal(h.tracker.isNoCli('s1'), false);
  await h.advance(1);
  assert.equal(h.tracker.isNoCli('s1'), true);
  assert.deepEqual(h.changes, ['s1']);
});

test('GIVEN a restored session WHEN its CLI connects before the delay THEN it is never reported and never restarted', async () => {
  const h = harness();
  h.tracker.expect('s1');
  h.tracker.mcpState('s1', 'listening');
  await h.advance(5000);
  h.tracker.mcpState('s1', 'connected');
  await h.advance(h.NO_CLI + h.RESTART);
  assert.equal(h.tracker.isNoCli('s1'), false);
  assert.deepEqual(h.restarts, []);
});

test('GIVEN a session without CLI WHEN its CLI connects late THEN the state clears and the pending restart is cancelled', async () => {
  const h = harness();
  h.tracker.expect('s1');
  h.tracker.mcpState('s1', 'listening');
  await h.advance(h.NO_CLI);
  assert.equal(h.tracker.isNoCli('s1'), true);
  h.tracker.mcpState('s1', 'connected');
  assert.equal(h.tracker.isNoCli('s1'), false);
  await h.advance(h.RESTART);
  assert.deepEqual(h.restarts, []);
  assert.deepEqual(h.changes, ['s1', 's1']);
});

test('GIVEN a session that is not restored WHEN its bridge listens and nothing connects THEN it is never tracked', async () => {
  const h = harness();
  h.tracker.mcpState('s1', 'listening');
  await h.advance(h.NO_CLI + h.RESTART);
  assert.equal(h.tracker.isNoCli('s1'), false);
  assert.deepEqual(h.restarts, []);
});

test('GIVEN a restored session with no IDE bridge (Codex) WHEN its open reports the bridge off THEN it is never tracked', async () => {
  const h = harness();
  h.tracker.expect('codex');
  h.tracker.mcpState('codex', 'off');
  h.tracker.settle('codex');
  h.tracker.mcpState('codex', 'listening');
  await h.advance(h.NO_CLI + h.RESTART);
  assert.equal(h.tracker.isNoCli('codex'), false);
  assert.deepEqual(h.restarts, []);
});

test('GIVEN a restored session WHEN its PTY exits before the delay THEN it is not reported and not restarted', async () => {
  const h = harness();
  h.tracker.expect('s1');
  h.tracker.mcpState('s1', 'listening');
  await h.advance(1000);
  h.tracker.exited('s1');
  await h.advance(h.NO_CLI + h.RESTART);
  assert.equal(h.tracker.isNoCli('s1'), false);
  assert.deepEqual(h.restarts, []);
});

test('GIVEN a session without CLI WHEN its PTY exits THEN the state clears', async () => {
  const h = harness();
  h.tracker.expect('s1');
  h.tracker.mcpState('s1', 'listening');
  await h.advance(h.NO_CLI);
  h.tracker.exited('s1');
  assert.equal(h.tracker.isNoCli('s1'), false);
  await h.advance(h.RESTART);
  assert.deepEqual(h.restarts, []);
});

test('GIVEN the network is down when the session starts WHEN it comes back after the session is reported THEN the session restarts once', async () => {
  const h = harness({ online: false });
  h.tracker.expect('s1');
  h.tracker.mcpState('s1', 'listening');
  await h.advance(h.NO_CLI);
  assert.deepEqual(h.restarts, []);
  h.net.online = true;
  h.tracker.online();
  await h.flush();
  assert.deepEqual(h.restarts, ['s1']);
  h.tracker.offline();
  h.tracker.online();
  await h.advance(h.RESTART);
  assert.deepEqual(h.restarts, ['s1']);
});

test('GIVEN the network went down and came back before the delay WHEN the session is reported THEN it restarts at once', async () => {
  const h = harness({ online: true });
  h.tracker.expect('s1');
  h.tracker.mcpState('s1', 'listening');
  h.net.online = false;
  h.tracker.offline();
  await h.advance(10000);
  h.net.online = true;
  h.tracker.online();
  await h.flush();
  assert.deepEqual(h.restarts, []);
  await h.advance(h.NO_CLI - 10000);
  assert.deepEqual(h.restarts, ['s1']);
});

test('GIVEN the network never reported down WHEN the restart timeout passes THEN the session restarts once', async () => {
  const h = harness({ online: true });
  h.tracker.expect('s1');
  h.tracker.mcpState('s1', 'listening');
  await h.advance(h.NO_CLI);
  await h.advance(h.RESTART - 1);
  assert.deepEqual(h.restarts, []);
  await h.advance(1);
  assert.deepEqual(h.restarts, ['s1']);
});

test('GIVEN a session already restarted once WHEN its new CLI does not connect either THEN it is reported again and never restarted a second time', async () => {
  const h = harness({ online: true });
  h.tracker.expect('s1');
  h.tracker.mcpState('s1', 'listening');
  await h.advance(h.NO_CLI + h.RESTART);
  assert.deepEqual(h.restarts, ['s1']);
  assert.equal(h.tracker.status('s1').restartPending, false);
  h.tracker.mcpState('s1', 'off');
  h.tracker.expect('s1');
  h.tracker.mcpState('s1', 'listening');
  await h.advance(h.NO_CLI);
  assert.equal(h.tracker.isNoCli('s1'), true);
  h.tracker.online();
  await h.advance(h.RESTART * 3);
  assert.deepEqual(h.restarts, ['s1']);
  assert.equal(h.tracker.status('s1').restartPending, false);
});

test('GIVEN a restart that is refused WHEN the network comes back later THEN no second attempt is made and the state stays', async () => {
  const h = harness({ online: true, restartResult: false });
  h.tracker.expect('s1');
  h.tracker.mcpState('s1', 'listening');
  await h.advance(h.NO_CLI + h.RESTART);
  assert.deepEqual(h.restarts, ['s1']);
  assert.equal(h.tracker.isNoCli('s1'), true);
  h.tracker.offline();
  h.tracker.online();
  await h.advance(h.RESTART);
  assert.deepEqual(h.restarts, ['s1']);
});

test('GIVEN a restart in progress WHEN the stopped PTY reports its bridge off THEN the session keeps its no-CLI state', async () => {
  const h = harness({ online: true });
  let release;
  const { createCliLiveness } = require(MODULE);
  const timers = new Map();
  let id = 0;
  const tracker = createCliLiveness({
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimer: t => timers.delete(t),
    isOnline: () => true,
    restart: () => new Promise(resolve => { release = resolve; }),
  });
  tracker.expect('s1');
  tracker.mcpState('s1', 'listening');
  const fire = () => { const [k, t] = [...timers][0]; timers.delete(k); t.fn(); };
  fire();
  fire();
  await h.flush();
  tracker.mcpState('s1', 'off');
  tracker.exited('s1');
  assert.equal(tracker.isNoCli('s1'), true);
  release(true);
  await h.flush();
});

test('the no-CLI delay outlasts the CLI\'s 30-second IDE search and the restart timeout is minutes, not seconds', () => {
  const { CLI_LIVENESS_NO_CLI_MS, CLI_LIVENESS_RESTART_TIMEOUT_MS } = require(MODULE);
  assert.equal(CLI_LIVENESS_NO_CLI_MS, 60000);
  assert.equal(CLI_LIVENESS_RESTART_TIMEOUT_MS, 300000);
});
