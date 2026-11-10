'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
const ID = '01234567-89ab-cdef-0123-456789abcdef';
const NEW = '11234567-89ab-cdef-0123-456789abcdef';
const STEM = '21234567-89ab-cdef-0123-456789abcdef';
const project = process.cwd();
function fixture() {
  const events = [];
  const session = { pty: { pid: 1 }, generation: 7, cwd: project, projectPath: project };
  const entry = { session, ptyProcess: session.pty, cwd: project };
  const map = new Map([[ID, session]]);
  const ctx = {
    getPtyForSession: () => entry,
    pinDelivery: (_id, e) => ({ binding: { tab: e.session, deadline: Infinity, admit: async () => {}, readId: () => ID }, ctx: {}, handle: {} }),
    lifecycle: {
      activeSessions: map, launchAllowed: () => true,
      getProjectSnapshot: async () => ({ allProjects: [{ projectPath: project }], hiddenProjects: [], hiddenProjectKinds: {} }),
      liveElsewhere: async () => ({ known: true, live: null }), remoteTarget: async () => false,
      resolveTarget: async () => ({ ok: true, sessionId: ID, project, cwd: project, folder: 'folder', transcript: 'file' }),
      randomUUID: () => NEW,
      broker: { request: async (op, save) => {
        events.push(['renderer', op]); await save();
        if (op.mode !== 'reattach') { map.set(op.tabKey, session); ctx.getPtyForSession = () => entry; }
        return { ok: true, generation: 7, ...(op.mode === 'new' ? { created: true } : op.mode === 'resume' ? { resumed: true } : {}) };
      } },
      saveName: async (id, name) => { events.push(['name', id, name]); return { name }; },
    },
  };
  const execution = { ctx, deadline: Date.now() + 5000,
    acquireSessionLock: async id => { events.push(['fifo', id]); return () => events.push(['release-fifo']); },
    acquireTabLock: async tab => { events.push(['mutex', tab]); return () => events.push(['release-mutex']); },
    saveMarker: marker => events.push(['marker', marker]),
    publish: result => events.push(['result', result]),
    deliver: async () => { events.push(['deliver']); return { ok: true, submitted: 'assumed', wrote: true, text_written: true, enter_written: true }; },
  };
  const actions = createTriggerActions();
  return { events, ctx, execution, session, map,
    open: extra => actions.execute({ version: 1, action: 'open', sessionId: ID, ...extra }, STEM, execution),
    new: extra => actions.execute({ version: 1, action: 'open', new: { project, name: '  Task  ' }, prompt: 'hello', ...extra }, STEM, execution) };
}
test('open here gets an explicit reattach ACK and publishes under both locks', async () => {
  const f = fixture(); const r = await f.open();
  assert.equal(r.outcome, 'opened'); assert.equal(r.resumed, false);
  assert.equal(r.wrote, false); assert.equal(r.steps_total, 0);
  assert.deepEqual(f.events.map(e => e[0]), ['fifo', 'mutex', 'renderer', 'marker', 'marker', 'result', 'release-mutex', 'release-fifo']);
});
test('historical requested ID remains separate from the renderer tab key', async () => {
  const f = fixture(); f.map.delete(ID); f.map.set(NEW, f.session);
  const r = await f.open({ prompt: 'hello' });
  assert.equal(r.sessionId, ID); assert.equal(r.outcome, 'opened');
  const op = f.events.find(e => e[0] === 'renderer')?.[1];
  assert.equal(op?.tabKey, NEW); assert.equal(op?.requestedSessionId, ID);
});
test('closed resume checks liveness twice before renderer and retains spawn evidence', async () => {
  const f = fixture(); f.ctx.getPtyForSession = () => null;
  f.ctx.lifecycle.liveElsewhere = async () => { f.events.push(['live']); return { known: true, live: null }; };
  const r = await f.open({ prompt: 'hello' });
  assert.equal(r.outcome, 'opened'); assert.equal(r.resumed, true);
  assert.equal(f.events.filter(e => e[0] === 'live').length, 3);
  assert.equal(r.submitted, 'assumed');
});
test('new reserves its own ID, stores trimmed name before prompt, and retains creation', async () => {
  const f = fixture(); const r = await f.new();
  assert.equal(r.outcome, 'opened', JSON.stringify(r)); assert.equal(r.created, true); assert.equal(r.sessionId, NEW);
  assert.deepEqual(f.events.find(e => e[0] === 'name'), ['name', NEW, 'Task']);
  assert.ok(f.events.findIndex(e => e[0] === 'name') < f.events.findIndex(e => e[0] === 'deliver'));
});
for (const [live, reason] of [[{ kind: 'schedule' }, 'scheduled session is not supported'], [{ kind: 'bg' }, 'background session is not supported'], [{ kind: 'interactive' }, 'session live elsewhere'], [undefined, 'session liveness unavailable']]) {
  test(`pre-dispatch ${reason} creates no renderer work`, async () => {
    const f = fixture(); f.ctx.getPtyForSession = () => null;
    f.ctx.lifecycle.liveElsewhere = async () => live ? { known: true, live } : { known: false };
    const r = await f.open(); assert.equal(r.reason, reason);
    assert.equal(f.events.some(e => e[0] === 'renderer'), false);
  });
}
for (const [field, value, reason] of [['isAttach', true, 'background session is not supported'], ['backgrounding', true, 'background session is not supported'], ['backgrounded', true, 'background session is not supported'], ['host', 'server', 'remote sessions are not supported'], ['isPlainTerminal', true, 'plain terminal sessions are not supported']]) {
  test(`open target with ${field} refuses`, async () => {
    const f = fixture(); f.session[field] = value;
    assert.equal((await f.open()).reason, reason);
    assert.equal(f.events.some(e => e[0] === 'renderer'), false);
  });
}
test('name failure leaves the created session and withholds prompt', async () => {
  const f = fixture(); f.ctx.lifecycle.saveName = async () => { throw new Error('disk'); };
  const r = await f.new(); assert.equal(r.reason, 'session name could not be saved'); assert.equal(r.created, true);
  assert.equal(f.map.has(NEW), true); assert.equal(f.events.some(e => e[0] === 'deliver'), false);
});
test('unknown renderer result never authorizes delivery', async () => {
  const f = fixture(); f.ctx.lifecycle.broker.request = async () => undefined;
  assert.equal((await f.open({ prompt: 'hello' })).reason, 'session open failed');
  assert.equal(f.events.some(e => e[0] === 'deliver'), false);
});
test('delivery timeout overrides success and preserves partial evidence', async () => {
  const f = fixture(); f.execution.deliver = async () => ({ ok: true, timedOut: true, wrote: true, submitted: 'assumed', enter_written: true, text_written: true });
  const r = await f.open({ prompt: 'hello' });
  assert.equal(r.ok, false); assert.equal(r.reason, 'session action timed out');
  assert.equal(r.uncertain, true); assert.equal(r.enter_written, true); assert.equal(r.submitted, 'assumed');
});
test('deadline waiting for FIFO releases its eventual lock without renderer work', async () => {
  const f = fixture(); let release; let released = false;
  f.execution.deadline = Date.now() + 15;
  f.execution.acquireSessionLock = () => new Promise(resolve => { release = () => resolve(() => { released = true; }); });
  const r = await f.open(); assert.equal(r.reason, 'session action timed out');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, true); assert.equal(f.events.some(e => e[0] === 'renderer'), false);
});
test('marker publication failure dispatches no action', async () => {
  const f = fixture(); f.execution.saveMarker = () => { throw new Error('disk'); };
  f.ctx.lifecycle.broker.request = async (_op, save) => { try { await save(); } catch { return { ok: false, reason: 'action state could not be saved' }; } throw new Error('must not send'); };
  assert.equal((await f.open()).reason, 'action state could not be saved');
});
test('stop remains the slice B refusal', async () => {
  const f = fixture(); const r = await createTriggerActions().execute({ version: 1, action: 'stop', sessionId: ID }, STEM, f.execution);
  assert.equal(r.reason, 'session action not implemented in this build');
});

test('startup proof timeout retains its specific readiness refusal', async () => {
  const f = fixture();
  f.execution.ctx.lifecycle.broker.request = async () => ({ ok: true, generation: 7 });
  const originalNow = Date.now;
  let expired = false;
  const actions = require('../src/main/triggers/trigger-actions').createTriggerActions({ now: () => expired ? f.execution.deadline + 1 : originalNow() });
  f.execution.deliver = async () => { expired = true; return { ok: false, reason: 'session readiness unavailable', submitted: 'no', wrote: false }; };
  const result = await actions.execute({ version: 1, action: 'open', sessionId: ID, prompt: 'hello' }, STEM, f.execution);
  assert.equal(result.reason, 'session readiness unavailable');
  assert.equal(result.wrote, false);
});

test('action marker carries the request identity, exact tab key and shared deadline', async () => {
  const f = fixture(); await f.open();
  const marker = f.events.find(e => e[0] === 'marker')[1];
  assert.equal(marker.requestId, STEM); assert.equal(marker.requestedSessionId, ID);
  assert.equal(marker.tabKey, ID); assert.equal(marker.deadline, f.execution.deadline);
});

test('joined resume revalidates actual mode, transcript/cwd and liveness without claiming its spawn', async () => {
  const f = fixture(); f.ctx.getPtyForSession = () => null;
  f.ctx.lifecycle.broker.request = async op => {
    assert.equal(typeof op.verifyJoined, 'function', 'a joined ordinary opener needs a main-only validator');
    f.session.launchMode = 'new'; f.session.launchSourceId = ID;
    assert.equal((await op.verifyJoined(f.session)).reason, 'session target changed');
    f.session.launchMode = 'resume';
    assert.equal((await op.verifyJoined(f.session)).ok, true);
    f.ctx.lifecycle.resolveTarget = async () => ({ ok: true, cwd: project, project, transcript: 'replaced' });
    assert.equal((await op.verifyJoined(f.session)).reason, 'session target changed');
    f.ctx.lifecycle.resolveTarget = async () => ({ ok: true, cwd: project, project, transcript: 'file' });
    f.session.isAttach = true;
    assert.equal((await op.verifyJoined(f.session)).reason, 'background session is not supported');
    delete f.session.isAttach;
    f.ctx.getPtyForSession = () => ({ session: f.session, ptyProcess: f.session.pty, cwd: project });
    return { ok: true, generation: 7, resumed: false };
  };
  const result = await f.open(); assert.equal(result.outcome, 'opened'); assert.equal(result.resumed, false);
});
