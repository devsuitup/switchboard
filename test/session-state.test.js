// Tests for public/session-state.js — the pure domain module introduced by
// the migration in .ai/contexts/session-state.md (steps 1-2 of issue #246).

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionState, renderSessionIcon } = require('../public/session-state.js');

// ---------------------------------------------------------------------------
// apply-sequence -> snapshot
// ---------------------------------------------------------------------------

test('a fresh state snapshots to the idle defaults', () => {
  const s = createSessionState('local-pty');
  const snap = s.snapshot();
  assert.equal(snap.kind, 'local-pty');
  assert.equal(snap.liveness, 'unknown');
  assert.equal(snap.attached, false);
  assert.equal(snap.busy, false);
  assert.equal(snap.waitingForInput, false);
  assert.equal(snap.attention, false);
  assert.equal(snap.agentsBusy, false);
});

test('busy(true) -> busy(false) sequence arms waitingForInput and responseReady', () => {
  const s = createSessionState('local-pty');
  s.apply({ type: 'busy', active: true });
  assert.equal(s.snapshot().busy, true);

  s.apply({ type: 'busy', active: false, armReady: true });
  const snap = s.snapshot();
  assert.equal(snap.busy, false);
  assert.equal(snap.waitingForInput, true);
  assert.equal(snap.responseReady, true);
});

test('busy(false) with armReady:false arms waitingForInput but not responseReady', () => {
  const s = createSessionState('local-pty');
  s.apply({ type: 'busy', active: true });
  s.apply({ type: 'busy', active: false, armReady: false });
  const snap = s.snapshot();
  assert.equal(snap.waitingForInput, true);
  assert.equal(snap.responseReady, false);
});

test('clearUnread drops responseReady without touching busy', () => {
  const s = createSessionState('local-pty');
  s.apply({ type: 'busy', active: true });
  s.apply({ type: 'busy', active: false, armReady: true });
  assert.equal(s.snapshot().responseReady, true);

  s.apply({ type: 'clearUnread' });
  assert.equal(s.snapshot().responseReady, false);
  assert.equal(s.snapshot().busy, false);
});

test('liveness/attached are tracked as two separate facts (2026-09-11 lifecycle decision)', () => {
  const s = createSessionState('remote-ssh');
  s.apply({ type: 'liveness', value: 'alive' });
  assert.equal(s.snapshot().liveness, 'alive');
  assert.equal(s.snapshot().attached, false, 'liveness alone must not imply attached');

  s.apply({ type: 'attached', value: true });
  assert.equal(s.snapshot().attached, true);
  assert.equal(s.snapshot().liveness, 'alive', 'attaching must not change liveness');

  s.apply({ type: 'attached', value: false }); // detach — closing the tab, not a stop
  assert.equal(s.snapshot().attached, false);
  assert.equal(s.snapshot().liveness, 'alive', 'a detach is not a stop: the process is still alive');
});

test('subagentSpawned/Completed drive agentsBusy independently of busy/attention', () => {
  const s = createSessionState('local-pty');
  s.apply({ type: 'subagentSpawned' });
  assert.equal(s.snapshot().agentsBusy, true);
  s.apply({ type: 'busy', active: true });
  assert.equal(s.snapshot().agentsBusy, true, 'agentsBusy survives an unrelated busy transition');
  s.apply({ type: 'subagentCompleted', stillActive: false });
  assert.equal(s.snapshot().agentsBusy, false);
});

test('a malformed or unknown event is a no-op', () => {
  const s = createSessionState('local-pty');
  const before = s.snapshot();
  s.apply(null);
  s.apply(undefined);
  s.apply({});
  s.apply({ type: 'not-a-real-event' });
  assert.deepEqual(s.snapshot(), before);
});

// ---------------------------------------------------------------------------
// Exclusivity — busy / waitingForInput / attention
// ---------------------------------------------------------------------------

test('exclusivity: attention while busy clears busy and any pending unread', () => {
  const s = createSessionState('local-pty');
  s.apply({ type: 'busy', active: true });
  s.apply({ type: 'attention', active: true });
  const snap = s.snapshot();
  assert.equal(snap.attention, true);
  assert.equal(snap.busy, false, 'attention wins over busy');
  assert.equal(snap.waitingForInput, false);
  assert.equal(snap.responseReady, false);
});

test('exclusivity: going busy again clears attention and waitingForInput/responseReady', () => {
  const s = createSessionState('local-pty');
  s.apply({ type: 'attention', active: true });
  s.apply({ type: 'busy', active: true });
  const snap = s.snapshot();
  assert.equal(snap.busy, true);
  assert.equal(snap.attention, false);
  assert.equal(snap.waitingForInput, false);
});

test('exclusivity: at most one of busy/waitingForInput/attention is ever true', () => {
  const s = createSessionState('local-pty');
  const events = [
    { type: 'busy', active: true },
    { type: 'attention', active: true },
    { type: 'attention', active: false },
    { type: 'busy', active: false, armReady: true },
    { type: 'busy', active: true },
    { type: 'busy', active: false, armReady: false },
    { type: 'attention', active: true },
  ];
  for (const e of events) {
    s.apply(e);
    const snap = s.snapshot();
    const trueCount = [snap.busy, snap.waitingForInput, snap.attention].filter(Boolean).length;
    assert.ok(trueCount <= 1, `busy/waitingForInput/attention must stay exclusive, got ${trueCount} true after ${JSON.stringify(e)}`);
  }
});

// ---------------------------------------------------------------------------
// Priority order (attention > responseReady > busy > agentsBusy >
// waitingForInput > idle+age > stale > archived)
// ---------------------------------------------------------------------------

test('priority: attention beats every other rung', () => {
  const snap = { attention: true, responseReady: true, busy: true, agentsBusy: true, waitingForInput: true, stale: true, archived: true };
  assert.deepEqual(renderSessionIcon(snap).classes, ['needs-attention']);
});

test('priority: responseReady beats busy/agentsBusy/waitingForInput', () => {
  const snap = { attention: false, responseReady: true, busy: false, agentsBusy: true, waitingForInput: true };
  assert.deepEqual(renderSessionIcon(snap).classes, ['response-ready']);
});

test('priority: busy beats agentsBusy and waitingForInput', () => {
  const snap = { busy: true, agentsBusy: true, waitingForInput: true };
  assert.deepEqual(renderSessionIcon(snap).classes, ['cli-busy']);
});

test('priority: agentsBusy beats waitingForInput/stale/archived', () => {
  const snap = { agentsBusy: true, waitingForInput: true, stale: true, archived: true };
  assert.deepEqual(renderSessionIcon(snap).classes, ['has-busy-agents']);
});

test('priority: waitingForInput beats stale/archived', () => {
  const snap = { waitingForInput: true, stale: true, archived: true };
  assert.deepEqual(renderSessionIcon(snap).classes, []);
  assert.equal(renderSessionIcon(snap).title, 'Waiting for input');
});

test('priority: stale beats archived', () => {
  const snap = { stale: true, archived: true };
  assert.equal(renderSessionIcon(snap).title, 'Stale');
});

test('priority: archived is the lowest rung', () => {
  const snap = { archived: true };
  assert.equal(renderSessionIcon(snap).title, 'Archived');
});

test('priority: an empty snapshot resolves to idle', () => {
  assert.deepEqual(renderSessionIcon({}), { classes: [], glyph: '', title: 'Idle' });
  assert.deepEqual(renderSessionIcon(undefined), { classes: [], glyph: '', title: 'Idle' });
});

// ---------------------------------------------------------------------------
// renderSessionIcon for each state — one icon slot: { classes, glyph, title }
// ---------------------------------------------------------------------------

test('renderSessionIcon: every rung returns a distinct, well-shaped icon', () => {
  const cases = [
    [{ attention: true }, 'needs-attention', '!'],
    [{ responseReady: true }, 'response-ready', '●'],
    [{ busy: true }, 'cli-busy', '⠋'],
    [{ agentsBusy: true }, 'has-busy-agents', '◆'],
  ];
  for (const [snap, cls, glyph] of cases) {
    const icon = renderSessionIcon(snap);
    assert.ok(icon.classes.includes(cls), `expected class ${cls} for ${JSON.stringify(snap)}`);
    assert.equal(icon.glyph, glyph);
    assert.ok(typeof icon.title === 'string' && icon.title.length > 0);
  }
  // The three non-CSS rungs carry no legacy class (no sidebar HTML shape change yet).
  for (const snap of [{ waitingForInput: true }, { stale: true }, { archived: true }, {}]) {
    assert.deepEqual(renderSessionIcon(snap).classes, []);
  }
});
