'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadAppFunctions } = require('./app-source');
const { fixture, ID, OTHER, request } = require('./fixtures/trigger-renderer-open.cjs');
test('exact resume preserves current focus, defaults and ordinary persistence', async t => {
  const h = fixture(t); await h.f.handleTriggerSessionAction(request());
  const ack = h.calls.find(c => c[0] === 'ack')?.[1];
  assert.equal(ack?.ok, true); assert.equal(ack?.generation, 7);
  const open = h.calls.find(c => c[0] === 'open')[1];
  assert.equal(open[0], ID); assert.equal(open[2], false); assert.equal(open[3].chrome, true); assert.equal(open[5], OTHER);
  assert.equal(h.calls.some(c => c[0] === 'focus'), false); assert.equal(h.calls.some(c => c[0] === 'persist'), true);
  const guard = h.calls.find(c => c[0] === 'guard')[1]; assert.equal(guard.automatic, true); assert.equal(guard.allowBgAttach, false);
});
test('new uses main-reserved ID and pending name without focusing', async t => {
  const h = fixture(t); await h.f.handleTriggerSessionAction(request({ mode: 'new', requestedSessionId: null, name: 'Named task' }));
  assert.equal(h.calls.find(c => c[0] === 'ack')?.[1].ok, true);
  assert.equal(h.calls.find(c => c[0] === 'open')?.[1][0], ID);
  assert.equal(h.w.pendingSessions.get(ID)?.session.name, 'Named task');
  assert.equal(h.calls.some(c => c[0] === 'focus'), false);
});
test('reattach historical A addresses existing B with its generation', async t => {
  const h = fixture(t);
  h.w.openSessions.set(OTHER, { session: { sessionId: OTHER } });
  h.f.settlePtyOpen(OTHER, { generation: 7 });
  await h.f.handleTriggerSessionAction(request({ mode: 'reattach', tabKey: OTHER, generation: 7 }));
  assert.equal(h.calls.find(c => c[0] === 'ack')?.[1].ok, true);
  assert.equal(h.calls.some(c => c[0] === 'open'), false); assert.equal(h.calls.some(c => c[0] === 'focus'), false);
});
test('missing renderer reattaches only under the supplied key', async t => {
  const h = fixture(t);
  await h.f.handleTriggerSessionAction(request({ mode: 'reattach', tabKey: OTHER, generation: 7 }));
  const open = h.calls.find(c => c[0] === 'open')?.[1];
  assert.equal(open?.[0], OTHER); assert.equal(open?.[3].reattachOnly, true);
});
test('background dormant provenance refuses without invoking restore override', async t => {
  const h = fixture(t); h.w.dormantWorkingSet.set(ID, { item: { bg: true } });
  await h.f.handleTriggerSessionAction(request());
  assert.equal(h.calls.find(c => c[0] === 'ack')?.[1].reason, 'background session is not supported');
  assert.equal(h.calls.some(c => c[0] === 'open'), false);
});
test('deadline after defaults prevents a late placeholder and spawn', async t => {
  const h = fixture(t); const op = request({ mode: 'new', requestedSessionId: null, name: 'Name' });
  h.w.resolveDefaultSessionOptions = async () => { op.deadline = 0; return {}; };
  await h.f.handleTriggerSessionAction(op);
  assert.equal(h.calls.find(c => c[0] === 'ack')?.[1].ok, false);
  assert.equal(h.calls.some(c => c[0] === 'open'), false); assert.equal(h.w.pendingSessions.size, 0);
});
test('grid open adds an ordinary card without selecting it', async t => {
  const h = fixture(t); h.w.gridViewActive = true;
  await h.f.handleTriggerSessionAction(request());
  assert.equal(h.calls.some(c => c[0] === 'card' && c[1] === ID), true);
  assert.equal(h.calls.some(c => c[0] === 'focus'), false);
});
test('a joined ordinary promise still requires a registered entry and generation', async t => {
  const h = fixture(t); h.w.openSession = async () => undefined;
  await h.f.handleTriggerSessionAction(request());
  assert.equal(h.calls.find(c => c[0] === 'ack')?.[1].ok, false);
});

test('startup announces ready only after successful project loading and awaited restore', async t => {
  const h = fixture(t); const order = [];
  let release;
  h.w.loadProjects = async () => { order.push('load'); };
  h.w.restoreStartupSessions = () => new Promise(resolve => { release = () => { order.push('restore'); resolve(); }; });
  h.w.api.triggerActionsReady = async () => { order.push('ready'); };
  const { loadStartupProjects } = loadAppFunctions(h.context, { functions: ['loadStartupProjects'] });
  const pending = loadStartupProjects(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['load']); release(); await pending;
  assert.deepEqual(order, ['load', 'restore', 'ready']);
});

for (const tabKey of [OTHER.toUpperCase(), 'older-local-tab-key']) {
  test(`reattach preserves the exact main-map key ${tabKey}`, async t => {
    const h = fixture(t);
    h.w.openSessions.set(tabKey, { session: { sessionId: tabKey } });
    h.f.settlePtyOpen(tabKey, { generation: 7 });
    await h.f.handleTriggerSessionAction(request({ mode: 'reattach', tabKey, generation: 7 }));
    const ack = h.calls.find(c => c[0] === 'ack')?.[1];
    assert.equal(ack?.ok, true, 'a main-proven reattach key is independent of the canonical requested UUID');
    assert.equal(ack?.tabKey, tabKey);
  });
}

test('an explicit pre-spawn failure does not ACK an unrelated earlier generation', async t => {
  const h = fixture(t); h.f.settlePtyOpen(ID, { generation: 7 });
  h.w.openSession = async (_session, _options, flags) => {
    flags.onOpenError('blocked', 'session live elsewhere', null); return false;
  };
  await h.f.handleTriggerSessionAction(request());
  const ack = h.calls.find(c => c[0] === 'ack')?.[1];
  assert.equal(ack.ok, false); assert.equal(ack.reason, 'session live elsewhere'); assert.equal(ack.generation, null);
});

test('a dormant-background refusal cannot reuse a closed tab generation', async t => {
  const h = fixture(t); h.f.settlePtyOpen(ID, { generation: 7 });
  h.w.dormantWorkingSet.set(ID, { item: { bg: true } });
  await h.f.handleTriggerSessionAction(request());
  const ack = h.calls.find(c => c[0] === 'ack')?.[1];
  assert.equal(ack.reason, 'background session is not supported'); assert.equal(ack.generation, null);
});

test('a renderer failure after a successful backend ACK retains that request generation', async t => {
  const h = fixture(t); h.w.syncPtySizeAfterOpen = () => { throw new Error('fit failed'); };
  await h.f.handleTriggerSessionAction(request());
  const ack = h.calls.find(c => c[0] === 'ack')?.[1];
  assert.equal(ack.ok, false); assert.equal(ack.generation, 7);
});

test('an absent new-session backend result removes its failed placeholder', async t => {
  const h = fixture(t); h.w.api.openTerminal = async () => undefined;
  await h.f.handleTriggerSessionAction(request({ mode: 'new', requestedSessionId: null, name: 'Name' }));
  assert.equal(h.calls.find(c => c[0] === 'ack')?.[1].ok, false);
  assert.equal(h.w.openSessions.has(ID), false);
  assert.equal(h.w.pendingSessions.has(ID), false);
  assert.equal(h.w.sessionMap.has(ID), false);
  for (const projects of [h.w.cachedProjects, h.w.cachedAllProjects]) {
    assert.equal(projects.some(p => p.sessions.some(s => s.sessionId === ID)), false);
  }
});

function persistence(t, h) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-trigger-persist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ openWorkingSet: [] }));
  Object.assign(h.w, { exitingApp: false, activeSessionId: OTHER, pendingRestoreEntries: () => [] });
  h.w.api.getSetting = async () => JSON.parse(fs.readFileSync(file, 'utf8'));
  h.w.api.setSetting = async (_key, value) => fs.writeFileSync(file, JSON.stringify(value));
  const { persistWorkingSet } = loadAppFunctions(h.context, { declarations: ['_persistChain'], functions: ['persistWorkingSet'] });
  return { persistWorkingSet, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('a refused trigger resume has no restore or persisted working-set effect', async t => {
  const h = fixture(t); const disk = persistence(t, h);
  h.w.api.openTerminal = async () => ({ ok: false, error: 'blocked', reason: 'session live elsewhere' });
  await h.f.handleTriggerSessionAction(request());
  assert.equal(h.w.skippedWorkingSetEntries.size, 0, 'a refused trigger must not become a skipped restore');
  assert.equal(h.calls.some(c => c[0] === 'notice'), false, 'trigger refusal must not show a Restore notice');
  assert.equal(h.calls.some(c => c[0] === 'persist'), false, 'trigger refusal must not schedule a working-set write');
  assert.equal(h.w.openSessions.has(ID), false);
  assert.equal(h.calls.find(c => c[0] === 'ack')?.[1].reason, 'session live elsewhere');
  assert.deepEqual(disk.read().openWorkingSet, []);
  await disk.persistWorkingSet();
  assert.deepEqual(disk.read().openWorkingSet, [], 'a later save must not restore the refused conversation');
});

test('a new trigger deadline after entry creation removes all placeholder state', async t => {
  const h = fixture(t); const disk = persistence(t, h);
  const op = request({ mode: 'new', requestedSessionId: null, name: 'Name' });
  const create = h.w.createTerminalEntry;
  h.w.createTerminalEntry = session => { const entry = create(session); op.deadline = 0; return entry; };
  await h.f.handleTriggerSessionAction(op);
  assert.equal(h.w.openSessions.has(ID), false, 'the expired trigger must destroy its open placeholder');
  assert.equal(h.w.pendingSessions.has(ID), false);
  assert.equal(h.w.sessionMap.has(ID), false);
  for (const projects of [h.w.cachedProjects, h.w.cachedAllProjects]) {
    assert.equal(projects.some(p => p.sessions.some(s => s.sessionId === ID)), false);
  }
  assert.equal(h.calls.some(c => c[0] === 'open' || c[0] === 'persist'), false);
  await disk.persistWorkingSet();
  assert.deepEqual(disk.read().openWorkingSet, [], 'an expired placeholder must not be persisted as fresh');
});

for (const closed of [false, true]) {
  for (const refusal of ['guard refusal', 'deadline after guard', 'deadline after defaults', 'notLive', 'backend refusal']) {
    test(`a held startup entry${closed ? ' with a closed tab' : ''} survives trigger ${refusal} and a later working-set save`, async t => {
      const h = fixture(t); const disk = persistence(t, h); const op = request();
      const held = { item: { sessionId: ID, projectPath: '/project', active: false }, index: 0 };
      h.w.skippedWorkingSetEntries.set(ID, held);
      if (closed) h.w.openSessions.set(ID, { session: op.session, closed: true });
      await disk.persistWorkingSet();
      assert.deepEqual(disk.read().openWorkingSet, [held.item]);
      if (refusal === 'guard refusal') {
        h.w.guardResume = async () => false;
      } else if (refusal === 'deadline after guard') {
        h.w.guardResume = async () => { op.deadline = 0; return true; };
      } else if (refusal === 'deadline after defaults') {
        h.w.resolveDefaultSessionOptions = async () => { op.deadline = 0; return {}; };
      } else {
        h.w.api.openTerminal = async () => refusal === 'notLive'
          ? { ok: false, notLive: true }
          : { ok: false, error: 'blocked', reason: 'session live elsewhere' };
      }
      await h.f.handleTriggerSessionAction(op);
      assert.equal(h.calls.find(c => c[0] === 'ack')?.[1].ok, false);
      assert.equal(h.w.openSessions.has(ID), false);
      assert.equal(h.w.skippedWorkingSetEntries.get(ID), held, 'trigger cleanup must retain the original held startup entry');
      assert.equal(h.calls.some(c => c[0] === 'notice' || c[0] === 'persist'), false);
      await disk.persistWorkingSet();
      assert.deepEqual(disk.read().openWorkingSet, [held.item], 'a later save must retain the held conversation');
    });
  }
}

test('a successful trigger resume consumes a held startup entry with a closed tab', async t => {
  const h = fixture(t); const disk = persistence(t, h);
  h.w.skippedWorkingSetEntries.set(ID, { item: { sessionId: ID, projectPath: '/project' }, index: 0 });
  h.w.openSessions.set(ID, { session: request().session, closed: true });
  await h.f.handleTriggerSessionAction(request());
  assert.equal(h.calls.find(c => c[0] === 'ack')?.[1].ok, true);
  assert.equal(h.w.skippedWorkingSetEntries.has(ID), false, 'successful resume must consume the held entry');
  assert.equal(h.w.openSessions.get(ID)?.closed, undefined);
  await disk.persistWorkingSet();
  assert.equal(disk.read().openWorkingSet.filter(item => item.sessionId === ID).length, 1);
});

for (const refusal of ['deadline', 'absent result', 'backend refusal', 'backend throw']) {
  test(`a new trigger ${refusal} removes only the empty project rows it created`, async t => {
    const h = fixture(t); const op = request({ mode: 'new', requestedSessionId: null, name: 'Name' });
    const existing = { projectPath: '/project', sessions: [] };
    h.w.cachedAllProjects.push(existing);
    if (refusal === 'deadline') {
      const create = h.w.createTerminalEntry;
      h.w.createTerminalEntry = session => { const entry = create(session); op.deadline = 0; return entry; };
    } else {
      h.w.api.openTerminal = async () => {
        if (refusal === 'backend throw') throw new Error('backend unavailable');
        return refusal === 'absent result' ? undefined : { ok: false, error: 'blocked' };
      };
    }
    await h.f.handleTriggerSessionAction(op);
    assert.equal(h.calls.find(c => c[0] === 'ack')?.[1].ok, false);
    assert.equal(h.w.cachedProjects.length, 0, 'trigger cleanup must remove the empty project row it created');
    assert.equal(h.w.cachedAllProjects.length, 1, 'an existing empty project row must survive');
    assert.equal(h.w.cachedAllProjects[0], existing);
    assert.equal(existing.sessions.length, 0);
    assert.equal(h.w.openSessions.has(ID), false);
    assert.equal(h.w.pendingSessions.has(ID), false);
    assert.equal(h.w.sessionMap.has(ID), false);
  });
}

test('a failed new trigger retains a created project row that gained another session', async t => {
  const h = fixture(t); const other = { sessionId: OTHER, projectPath: '/project' };
  h.w.api.openTerminal = async () => {
    for (const projects of [h.w.cachedProjects, h.w.cachedAllProjects]) projects[0].sessions.push(other);
    return { ok: false, error: 'blocked' };
  };
  await h.f.handleTriggerSessionAction(request({ mode: 'new', requestedSessionId: null, name: 'Name' }));
  for (const projects of [h.w.cachedProjects, h.w.cachedAllProjects]) {
    assert.equal(projects.length, 1);
    assert.deepEqual(Array.from(projects[0].sessions), [other]);
  }
});

function sidebarHarness(t, { grid }) {
  const h = fixture(t); const doc = h.w.document;
  const button = doc.createElement('button'); const second = doc.createElement('button'); const input = doc.createElement('textarea');
  button.id = 'user-control'; second.id = 'second-control'; input.id = 'terminal-input'; doc.body.append(button, second, input);
  Object.assign(h.w, { activeSessionId: OTHER, gridViewActive: grid, showArchived: false, searchMatchIds: null,
    pruneRemoteActivityTimers() {}, pruneLocalTranscriptTimers() {} });
  h.w.openSessions.set(OTHER, { session: { sessionId: OTHER, projectPath: '/project' }, terminal: { focus: () => input.focus() } });
  const real = loadAppFunctions(h.context, { functions: ['refreshSidebar'] });
  h.w.refreshSidebar = real.refreshSidebar;
  let release;
  h.w.api.openTerminal = () => new Promise(resolve => { release = resolve; });
  const waitForBackend = async () => { for (let i = 0; i < 60 && !release; i++) await Promise.resolve(); assert.ok(release, 'reaches the ordinary open boundary'); };
  return { h, doc, button, second, input, waitForBackend, settle: result => release(result) };
}
for (const grid of [false, true]) {
  for (const outcome of ['success', 'failure']) {
    test(`nonactivating new keeps the focused control before, during and after ${outcome} (grid=${grid})`, async t => {
      const s = sidebarHarness(t, { grid });
      s.button.focus();
      assert.equal(s.doc.activeElement.id, 'user-control');
      const pending = s.h.f.handleTriggerSessionAction(request({ mode: 'new', requestedSessionId: null, name: 'New' }));
      await s.waitForBackend();
      assert.equal(s.doc.activeElement.id, 'user-control', 'during the backend wait');
      s.settle(outcome === 'success' ? { ok: true, generation: 7 } : { ok: false, reason: 'refused' });
      await pending;
      assert.equal(s.doc.activeElement.id, 'user-control', 'after settlement');
      assert.equal(s.h.calls.some(c => c[0] === 'focus'), false);
      assert.equal(s.h.w.activeSessionId, OTHER);
    });
  }
  test(`a focus move made while the launch is pending is not undone by its completion (grid=${grid})`, async t => {
    const s = sidebarHarness(t, { grid });
    s.button.focus();
    const pending = s.h.f.handleTriggerSessionAction(request({ mode: 'new', requestedSessionId: null, name: 'New' }));
    await s.waitForBackend();
    s.second.focus();
    s.settle({ ok: true, generation: 7 });
    await pending;
    assert.equal(s.doc.activeElement.id, 'second-control');
  });
}
test('an ordinary user-initiated sidebar refresh still returns focus to the active terminal', t => {
  const s = sidebarHarness(t, { grid: false });
  s.button.focus();
  s.h.w.refreshSidebar();
  assert.equal(s.doc.activeElement.id, 'terminal-input');
});
