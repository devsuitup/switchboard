'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
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

test('an absent new-session backend result closes its failed ordinary placeholder', async t => {
  const h = fixture(t); h.w.api.openTerminal = async () => undefined;
  await h.f.handleTriggerSessionAction(request({ mode: 'new', requestedSessionId: null, name: 'Name' }));
  assert.equal(h.calls.find(c => c[0] === 'ack')?.[1].ok, false);
  assert.equal(h.w.openSessions.get(ID)?.closed, true);
});
