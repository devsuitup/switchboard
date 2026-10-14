'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionState } = require('../public/session-state');
const { createTaskRecordsClient } = require('../task-records-client');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

for (const type of ['promptHint', 'descriptorStatus']) {
  for (const next of ['busy', 'transcriptTouched']) {
    test(`${type}: ${next} clears a prior prompt hint`, () => {
      const state = createSessionState('local-pty');
      state.apply({ type, status: 'idle', at: 1000 });
      assert.equal(state.snapshot().promptHint, true);
      state.apply({ type: next, active: true, at: 2000 });
      assert.equal(state.snapshot().promptHint, false);
    });
  }
}

test('a busy descriptor clears an unknown-head prompt hint', () => {
  const state = createSessionState('local-pty');
  state.apply({ type: 'descriptorStatus', status: 'idle', at: 1000 });
  state.apply({ type: 'descriptorStatus', status: 'busy', at: 2000 });
  assert.equal(state.snapshot().promptHint, false);
});

test('a fresh untimestamped idle descriptor after a status transition supplies a new prompt hint', () => {
  const state = createSessionState('local-pty');
  state.apply({ type: 'descriptorStatus', status: 'idle' });
  state.apply({ type: 'busy', active: true });
  state.apply({ type: 'descriptorStatus', status: 'busy' });
  state.apply({ type: 'descriptorStatus', status: 'idle' });
  assert.equal(state.snapshot().promptHint, true);
});

test('repainting an unchanged busy descriptor preserves a newer OSC idle hint', () => {
  const state = createSessionState('local-pty');
  state.apply({ type: 'descriptorStatus', status: 'busy', at: 1000 });
  state.apply({ type: 'promptHint', at: 2000 });
  state.apply({ type: 'descriptorStatus', status: 'busy', at: 1000 });
  assert.equal(state.snapshot().promptHint, true);
  state.apply({ type: 'descriptorStatus', status: 'busy', at: 3000 });
  assert.equal(state.snapshot().promptHint, false);
});

for (const next of ['busy', 'transcriptTouched']) {
  test(`${next}: repainting an unchanged idle descriptor does not restore its consumed prompt hint`, () => {
    const state = createSessionState('local-pty');
    state.apply({ type: 'descriptorStatus', status: 'idle', at: 1000 });
    state.apply({ type: next, active: true, at: 2000 });
    state.apply({ type: 'descriptorStatus', status: 'idle', at: 1000 });
    assert.equal(state.snapshot().promptHint, false);
    state.apply({ type: 'descriptorStatus', status: 'idle', at: 3000 });
    assert.equal(state.snapshot().promptHint, true);
  });
}

async function attached(t, skew = 0) {
  const ctx = setupSidebarDom();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'head-hints-638c-'));
  const file = path.join(dir, 'root.jsonl');
  let now = 1_800_000_000_000;
  ctx.window.Date.now = () => now;
  ctx.window.activeSessionId = 'root';
  ctx.window.activePtyIds.add('root');
  const row = { sessionId: 'root', remoteAlias: 'host', remoteDescriptorSeen: true, status: 'busy' };
  ctx.sidebar.renderProjects([makeSampleProject({ remoteAlias: 'host', sessions: [row] })], true);
  const client = createTaskRecordsClient({ onSnapshot: s => ctx.emitTaskSnapshot(s) });
  t.after(async () => {
    await client.dispose();
    ctx.destroy();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const append = async content => {
    fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date(now + skew).toISOString(), message: { role: 'user', content } }) + '\n');
    await client.read(file, 'root', { turnOnly: true });
  };
  return { ctx, append, read: () => client.read(file, 'root', { turnOnly: true }),
    advance: () => { now += 1000; },
    icon: () => ctx.document.querySelector('#si-root .session-icon') };
}

test('an unknown oversized head loses Waiting for input after a busy signal', async t => {
  const { ctx, append, advance, icon } = await attached(t);
  await append([{ type: 'tool_result', content: 'x'.repeat(300_000) }]);
  advance();
  ctx.setActivity('root', false, 'onCliBusyState');
  assert.equal(icon().title, 'Waiting for input');
  ctx.setActivity('root', true, 'onCliBusyState');
  assert.equal(icon().title, 'Turn state unavailable');
});

test('new oversized transcript evidence clears Waiting for input on an unknown attached head', async t => {
  const { ctx, append, advance, icon } = await attached(t);
  await append('Work');
  advance();
  ctx.setActivity('root', false, 'onTerminalNotification');
  assert.equal(icon().title, 'Waiting for input');
  advance();
  await append([{ type: 'tool_result', content: 'x'.repeat(300_000) }]);
  assert.equal(icon().title, 'Turn state unavailable');
});

test('a changed oversized tail clears the hint even when both head snapshots are unknown', async t => {
  const { ctx, append, advance, icon } = await attached(t);
  await append([{ type: 'tool_result', content: 'x'.repeat(300_000) }]);
  advance();
  ctx.setActivity('root', false, 'onCliBusyState');
  assert.equal(icon().title, 'Waiting for input');
  advance();
  await append([{ type: 'tool_result', content: 'y'.repeat(300_001) }]);
  assert.equal(icon().title, 'Turn state unavailable');
});

for (const skew of [60_000, -60_000]) {
  test(`attached remote OSC idle uses local transcript arrival with clock skew ${skew} ms`, async t => {
    const { ctx, append, read, advance, icon } = await attached(t, skew);
    await append('Work');
    assert.equal(icon().title, 'Working');
    advance();
    ctx.setActivity('root', false, 'onCliBusyState');
    assert.equal(icon().title, 'Waiting for input');
    advance();
    await read();
    assert.equal(icon().title, 'Waiting for input', 'rereading unchanged evidence must not undo OSC idle');
    advance();
    await append([{ type: 'tool_result', content: 'new result' }]);
    assert.equal(icon().title, 'Working', 'new transcript evidence wins in either remote clock direction');
  });
}
