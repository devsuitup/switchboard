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
  for (const next of ['busy', 'transcriptTouched', 'descriptorStatus']) {
    for (const at of [1000, 2000, 3000]) {
      test(`${type}: activity ${next} at ${at} only consumes a strictly older prompt hint`, () => {
        const state = createSessionState('local-pty');
        state.apply({ type, status: 'idle', at: 2000 });
        state.apply({ type: next, status: 'busy', active: true, at });
        assert.equal(state.snapshot().promptHint, at <= 2000);
      });
    }
  }
}

for (const at of [1000, 3000]) {
  test(`a remote busy hint at ${at} is ordered against the idle descriptor at 2000`, () => {
    const ctx = setupSidebarDom();
    try {
      ctx.window.Date.now = () => 4000;
      ctx.sidebar.renderProjects([makeSampleProject({ remoteAlias: 'host', sessions: [{
        sessionId: 'ordered', remoteAlias: 'host', remoteDescriptorSeen: true,
        status: 'idle', statusUpdatedAt: 2000,
      }] })], true);
      ctx.window.markRemoteBusy('ordered', 'remote-watch', at);
      assert.equal(ctx.document.querySelector('#si-ordered .session-icon').title,
        at < 2000 ? 'Waiting for input' : 'Turn state unavailable');
    } finally { ctx.destroy(); }
  });
}

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
  const appendRecord = async entry => {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    fs.utimesSync(file, new Date(now), new Date(now));
    await client.read(file, 'root', { turnOnly: true });
  };
  return { ctx, append, appendRecord, read: () => client.read(file, 'root', { turnOnly: true }),
    advance: () => { now += 1000; },
    icon: () => ctx.document.querySelector('#si-root .session-icon') };
}

test('an mtime-only snapshot after OSC idle preserves waiting and all adapter hint sources', async t => {
  const { ctx, append, advance, icon } = await attached(t);
  await append('Work');
  for (const map of ['localPtyStates', 'localTranscriptStates', 'remoteSessionStates']) {
    ctx.read(`${map}.set('root', createSessionState('local-pty'))`);
    ctx.read(`${map}.get('root').apply({ type: 'transcriptTouched', at: 1000, source: 'original' })`);
  }
  advance();
  ctx.setActivity('root', false, 'onCliBusyState');
  const before = ctx.read('headTurns.get("root")');
  assert.equal(icon().title, 'Waiting for input');
  const sources = ['localPtyStates', 'localTranscriptStates', 'remoteSessionStates']
    .map(map => JSON.stringify(ctx.read(`${map}.get('root').snapshot()`)));
  advance();
  ctx.window.applyHeadTurnSnapshot({ ...before, revision: before.revision + 1, mtimeMs: before.mtimeMs + 1000 });
  assert.equal(icon().title, 'Waiting for input');
  assert.equal(ctx.read('headTurns.get("root").observedAt'), before.observedAt);
  for (const [i, map] of ['localPtyStates', 'localTranscriptStates', 'remoteSessionStates'].entries()) {
    assert.equal(JSON.stringify(ctx.read(`${map}.get('root').snapshot()`)), sources[i]);
  }
  advance();
  ctx.window.applyHeadTurnSnapshot({ ...before, revision: before.revision + 2, lastEntryAt: before.lastEntryAt + 1000 });
  assert.equal(icon().title, 'Working');
  for (const map of ['localPtyStates', 'localTranscriptStates', 'remoteSessionStates']) {
    assert.equal(ctx.read(`${map}.get('root').snapshot().lastActivitySource`), 'head-turn');
  }
});

for (const type of ['last-prompt', 'ai-title', 'mode', 'pr-link']) {
  test(`${type}: an untimestamped bookkeeping append after OSC idle cannot animate an open head`, async t => {
    const { ctx, append, appendRecord, advance, icon } = await attached(t);
    await append('Work');
    assert.equal(icon().title, 'Working');
    advance();
    ctx.setActivity('root', false, 'onCliBusyState');
    const before = ctx.read('headTurns.get("root")');
    assert.equal(icon().title, 'Waiting for input');
    advance();
    await appendRecord({ type, value: 'bookkeeping' });
    const after = ctx.read('headTurns.get("root")');
    assert.notEqual(after.mtimeMs, before.mtimeMs);
    assert.equal(after.state, before.state);
    assert.equal(after.lastEntryAt, before.lastEntryAt);
    assert.equal(icon().title, 'Waiting for input');
    assert.equal(after.observedAt, before.observedAt);
    advance();
    await append('Next prompt');
    assert.equal(icon().title, 'Working');
  });
}

test('an unknown oversized head loses Waiting for input after a busy signal', async t => {
  const { ctx, append, advance, icon } = await attached(t);
  await append([{ type: 'tool_result', content: 'x'.repeat(300_000) }]);
  advance();
  ctx.setActivity('root', false, 'onCliBusyState');
  assert.equal(icon().title, 'Waiting for input');
  advance();
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

test('a changed oversized tail preserves the hint when both snapshots lack timestamped evidence', async t => {
  const { ctx, append, advance, icon } = await attached(t);
  await append([{ type: 'tool_result', content: 'x'.repeat(300_000) }]);
  advance();
  ctx.setActivity('root', false, 'onCliBusyState');
  assert.equal(icon().title, 'Waiting for input');
  advance();
  await append([{ type: 'tool_result', content: 'y'.repeat(300_001) }]);
  assert.equal(icon().title, 'Waiting for input');
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
