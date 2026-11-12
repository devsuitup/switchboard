'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTriggerActions, validateTrigger } = require('../src/main/triggers/trigger-actions');
const { createTriggerContext } = require('../src/main/triggers/trigger-context');
const { fixture, ID, NEW, STEM, project } = require('./fixtures/trigger-open.cjs');

function named({ observe = () => 'Task', now } = {}) {
  const f = fixture({ now }); f.observed = 0;
  const pin = f.ctx.pinDelivery;
  f.ctx.pinDelivery = (...args) => {
    const pinned = pin(...args);
    pinned.binding.observeName = (...args) => { f.observed++; f.events.push(['observe']); return observe(...args); };
    return pinned;
  };
  const order = kind => f.events.findIndex(e => e[0] === kind);
  return Object.assign(f, { order,
    run: (name, extra) => (now ? createTriggerActions({ now }) : createTriggerActions())
      .execute({ version: 1, action: 'open', new: { project, name }, prompt: 'hello', ...extra }, STEM, f.execution) });
}
const kinds = f => f.events.map(e => e[0]);

test('the saved name precedes delivery and the single name observation follows it', async () => {
  const f = named(); const r = await f.new();
  assert.equal(r.outcome, 'opened');
  assert.equal(r.requestedName, 'Task'); assert.equal(r.actualName, 'Task');
  assert.ok(f.order('name') < f.order('deliver')); assert.ok(f.order('deliver') < f.order('observe'));
  assert.equal(f.observed, 1); assert.equal(kinds(f).filter(k => k === 'deliver').length, 1);
  assert.equal(kinds(f).filter(k => k === 'name').length, 1);
});
test('a different observed name is reported and the open is unchanged', async () => {
  const f = named({ observe: () => 'Task-2' }); const r = await f.new();
  assert.equal(r.outcome, 'opened'); assert.equal(r.ok, true); assert.equal(r.requestedName, 'Task'); assert.equal(r.actualName, 'Task-2');
  assert.deepEqual(f.events.find(e => e[0] === 'name'), ['name', NEW, 'Task']);
  assert.equal(kinds(f).filter(k => k === 'deliver').length, 1);
});
for (const [label, observe] of [['null', () => null], ['empty', () => ''], ['a number', () => 5], ['an object', () => ({ name: 'x' })],
  ['a throw', () => { throw new Error('unreadable'); }]]) {
  test(`an unavailable name (${label}) reports null without changing the open or retrying`, async () => {
    const f = named({ observe }); const r = await f.new();
    assert.equal(r.outcome, 'opened'); assert.equal(r.actualName, null); assert.equal(r.requestedName, 'Task');
    assert.equal(f.observed, 1); assert.equal(kinds(f).filter(k => k === 'deliver').length, 1);
  });
}
test('a name that is exactly as observed is preserved without trimming or substitution', async () => {
  const f = named({ observe: () => '  spaced \u{1F600} ' }); const r = await f.new();
  assert.equal(r.actualName, '  spaced \u{1F600} ');
});
test('an observation port that is absent leaves null', async () => {
  const f = fixture(); const r = await f.new();
  assert.equal(r.outcome, 'opened'); assert.equal(r.actualName, null); assert.equal(r.requestedName, 'Task');
});
test('a saved-name failure withholds the prompt and keeps the requested name', async () => {
  const f = named(); f.ctx.lifecycle.saveName = async () => ({ name: 'other' });
  const r = await f.new();
  assert.equal(r.reason, 'session name could not be saved'); assert.equal(r.requestedName, 'Task');
  assert.equal(kinds(f).includes('deliver'), false); assert.equal(f.observed, 1);
});
test('the deadline reached during delivery skips the observation and reports null', async () => {
  let expired = false; const start = Date.now();
  const f = named({ now: () => expired ? start + 10 * 60 * 1000 : start });
  f.execution.deliver = async () => { expired = true; return { ok: true, timedOut: true, wrote: true, text_written: true, enter_written: true, submitted: 'assumed' }; };
  const r = await f.run('Task');
  assert.equal(r.reason, 'session action timed out'); assert.equal(r.actualName, null); assert.equal(r.requestedName, 'Task');
  assert.equal(r.enter_written, true); assert.equal(f.observed, 0);
});
test('cancellation after delivery skips the observation and keeps the closing refusal', async () => {
  const f = named(); let allowed = true;
  f.ctx.lifecycle.launchAllowed = () => allowed;
  f.execution.deliver = async () => { allowed = false; return { ok: true, wrote: true, text_written: true, enter_written: true, submitted: 'assumed' }; };
  const r = await f.new();
  assert.equal(r.reason, 'Switchboard is closing.'); assert.equal(r.actualName, null); assert.equal(f.observed, 0);
  assert.equal(r.enter_written, true);
});
test('a target replaced after delivery discards the name evidence', async () => {
  const f = named();
  f.execution.deliver = async () => { f.session.generation = 8; return { ok: true, wrote: true, text_written: true, enter_written: true, submitted: 'assumed' }; };
  const r = await f.new();
  assert.equal(r.reason, 'session target changed'); assert.equal(r.actualName, null); assert.equal(f.observed, 0);
});
test('finalization that closes the launch drops the observed name', async () => {
  const f = named(); let finalize; let allowed = true;
  f.ctx.lifecycle.launchAllowed = () => allowed;
  f.execution.publish = (result, fin) => { finalize = fin; f.events.push(['result', result]); };
  const first = await f.new();
  assert.equal(first.actualName, 'Task');
  allowed = false;
  const closed = finalize(first);
  assert.equal(closed.reason, 'Switchboard is closing.'); assert.equal(closed.actualName, null); assert.equal(closed.requestedName, 'Task');
});
test('publication retries reuse the saved snapshot without another observation or effect', async () => {
  const f = named(); let finalize;
  f.execution.publish = (_result, fin) => { finalize = fin; };
  const first = await f.new();
  const again = finalize(first), third = finalize(again);
  assert.equal(third.actualName, 'Task'); assert.equal(f.observed, 1);
  assert.equal(kinds(f).filter(k => k === 'deliver').length, 1); assert.equal(kinds(f).filter(k => k === 'name').length, 1);
});
test('a refusal before launch reports the requested name and no observation', async () => {
  const f = named(); f.ctx.lifecycle.getProjectSnapshot = async () => ({ allProjects: [], hiddenProjects: [], hiddenProjectKinds: {} });
  const r = await f.new();
  assert.equal(r.reason, 'unknown project'); assert.equal(r.requestedName, 'Task'); assert.equal(r.actualName, null); assert.equal(f.observed, 0);
});
test('existing-session opens carry neither name field', async () => {
  const f = named(); const r = await f.open({ prompt: 'hello' });
  assert.equal(r.outcome, 'opened'); assert.equal('requestedName' in r, false); assert.equal('actualName' in r, false);
});
test('schema-invalid requests carry neither name field', async () => {
  const f = named(); const r = await f.new({ prompt: '' });
  assert.equal(r.ok, false); assert.equal('requestedName' in r, false); assert.equal('actualName' in r, false);
});

const lone = ['x\ud800y', 'x\udc00y', '\udc00\ud800', 'x\ud83d'];
for (const name of lone) {
  test(`isolated surrogate ${JSON.stringify(name)} is schema-valid but refused before any effect`, async () => {
    assert.equal(validateTrigger({ version: 1, action: 'open', new: { project, name }, prompt: 'hello' }, STEM), null);
    const f = named(); const r = await f.run(name);
    assert.equal(r.ok, false); assert.equal(r.outcome, 'refused'); assert.equal(r.reason, 'session name cannot be transported');
    assert.equal(r.sessionId, null); assert.equal(r.created, false); assert.equal(r.requestedName, name); assert.equal(r.actualName, null);
    assert.equal(r.submitted, 'no'); assert.equal(r.wrote, false); assert.equal(r.steps_total, 1);
    assert.deepEqual(kinds(f).filter(kind => kind !== 'result'), []);
    assert.ok(JSON.stringify(r).includes(JSON.stringify(name).slice(1, -1)), 'serialization keeps the code units as escapes');
  });
}
test('a valid surrogate pair reaches the launch request unchanged', async () => {
  const f = named(); const r = await f.run('x😀y');
  assert.equal(r.outcome, 'opened'); assert.equal(f.events.find(e => e[0] === 'renderer')[1].name, 'x😀y');
  assert.equal(r.requestedName, 'x😀y');
});
test('a schema error keeps precedence over the transport refusal', async () => {
  const f = named(); const r = await f.run('x\ud800y', { prompt: '' });
  assert.equal(r.reason, 'prompt must be a non-empty string'); assert.equal('requestedName' in r, false);
});
test('transport refusal follows cancellation and deadline checks', async () => {
  const f = named(); f.ctx.lifecycle.launchAllowed = () => false;
  const r = await f.run('x\ud800y');
  assert.equal(r.reason, 'Switchboard is closing.');
});

test('the requested name is the trimmed name and the 256 limit is measured before trimming', () => {
  const ok = name => validateTrigger({ version: 1, action: 'open', new: { project, name }, prompt: 'p' }, STEM);
  assert.equal(ok('x'.repeat(256)), null);
  assert.equal(ok('x'.repeat(200)), null); assert.equal(ok('x'.repeat(201)), null);
  assert.match(ok(' ' + 'x'.repeat(256)), /too long/);
  assert.match(ok('x'.repeat(257)), /too long/);
  assert.match(ok('a\nb'), /control characters/); assert.match(ok('a\x7fb'), /control characters/);
  assert.equal(ok('café ‍ \u{1F600}'), null);
});
test('a 201-character name is neither truncated nor refused', async () => {
  const name = 'n'.repeat(201); const f = named({ observe: () => name.slice(0, 200) }); const r = await f.run(name);
  assert.equal(r.outcome, 'opened'); assert.equal(r.requestedName, name); assert.equal(r.actualName, name.slice(0, 200));
  assert.deepEqual(f.events.find(e => e[0] === 'name'), ['name', NEW, name]);
});

function world({ pid = 12345, sandbox = false, flags = {} } = {}) {
  const state = { writer: { sessionId: ID, pid: 300, procStart: '30', name: 'Task', kind: 'interactive' }, uncertain: false,
    identity: 'id-1', supported: true, start: '10', confirm: true, calls: { legacy: 0, v1: 0, confirm: 0 } };
  const session = { pty: { pid, write() {} }, generation: 7, host: null, cwd: '/first', sandbox, ...flags,
    composerState: { pending: 0, lastInputAt: 0 } };
  const map = new Map([[ID, session]]);
  const source = {
    deliveryPtyStart: p => p > 0 ? state.start : null,
    confirmDeliveryWriter: () => { state.calls.confirm++; return state.confirm; },
    observeTabWriter: () => {
      state.calls.legacy++;
      const seen = state.supported ? { supported: true, writer: state.writer, uncertain: state.uncertain, identity: state.identity } : { supported: false };
      state.onRead?.(state.calls.legacy);
      return seen;
    },
    observeTabWriterV1: () => { state.calls.v1++; return { supported: true, writer: state.writer, uncertain: state.uncertain, identity: state.identity }; },
    findDeliveryTab: () => ({}), refreshProcessTable: async () => {}, deliveryProcessTableFresh: () => true,
  };
  const ctx = createTriggerContext({ activeSessions: map, cliSessionState: source, isPtyAlive: () => true, getCliStatus: () => undefined,
    lifecycle: { launchAllowed: () => true } });
  const pinned = ctx.pinDelivery(ID, ctx.getPtyForSession(ID), false, { v1: true, deadline: Date.now() + 1000 });
  return { state, session, pinned, map };
}
test('the ordinary tab writer supplies the descriptor name for the launched session', () => {
  const w = world(); assert.equal(w.pinned.binding.observeName(), 'Task'); assert.equal(w.state.calls.legacy, 1);
});
test('the Linux sandbox reader supplies the name through its namespace proof', () => {
  const w = world({ sandbox: true }); assert.equal(w.pinned.binding.observeName(), 'Task');
  assert.equal(w.state.calls.v1, 1); assert.equal(w.state.calls.legacy, 0);
});
for (const [label, mutate] of [
  ['an unrelated session writer', w => { w.state.writer = { ...w.state.writer, sessionId: '99999999-9999-9999-9999-999999999999' }; }],
  ['an uncertain observation', w => { w.state.uncertain = true; }],
  ['no writer', w => { w.state.writer = undefined; }],
  ['an observation without identity', w => { w.state.identity = undefined; }],
  ['a missing name', w => { delete w.state.writer.name; }],
  ['an empty name', w => { w.state.writer.name = ''; }],
  ['a non-string name', w => { w.state.writer.name = { toString: () => 'x' }; }],
  ['an unsupported platform (macOS)', w => { w.state.supported = false; }],
  ['a replaced writer identity', w => { w.pinned.binding.writerIdentity = 'id-0'; }],
  ['a replaced PTY', w => { w.session.pty = { pid: 12345 }; }],
  ['a replaced generation', w => { w.session.generation = 8; }],
  ['an exited session', w => { w.session.exited = true; }],
  ['a revoked binding', w => { w.pinned.binding.revoked = true; }],
]) {
  test(`${label} yields no name`, () => {
    const w = world(); mutate(w); assert.equal(w.pinned.binding.observeName(), null);
  });
}
test('an established writer identity that still matches keeps the name', () => {
  const w = world(); w.pinned.binding.writerIdentity = 'id-1'; assert.equal(w.pinned.binding.observeName(), 'Task');
});
test('a reader that throws yields no name', () => {
  const w = world(); w.state.writer = new Proxy({}, { get() { throw new Error('read'); } });
  assert.equal(w.pinned.binding.observeName(), null);
});
test('a Windows PTY with PID zero produces no evidence and consults no reader', () => {
  const w = world({ pid: 0 }); assert.equal(w.pinned.binding.observeName(), null); assert.equal(w.state.calls.legacy, 0);
  w.session.pty.pid = 4321; assert.equal(w.pinned.binding.observeName(), 'Task');
});

test('every marker written for a new session carries the canonical naming provenance', async () => {
  const f = named(); await f.new();
  const markers = f.events.filter(e => e[0] === 'marker').map(e => e[1]);
  assert.ok(markers.length >= 3);
  for (const marker of markers) {
    assert.equal(marker.mode, 'new'); assert.equal(marker.nameVersion, 1); assert.equal(marker.requestedName, 'Task');
    assert.equal('actualName' in marker, false);
  }
});
test('markers for an existing session carry no naming provenance', async () => {
  const f = named(); await f.open({ prompt: 'hello' });
  for (const [, marker] of f.events.filter(e => e[0] === 'marker')) {
    assert.equal('nameVersion' in marker, false); assert.equal('requestedName' in marker, false);
  }
});
test('a background-attach or plain-terminal tab yields no name', () => {
  for (const flag of ['isAttach', 'isPlainTerminal']) {
    const w = world({ flags: { [flag]: true } }); assert.equal(w.pinned.binding.observeName(), null); assert.equal(w.state.calls.legacy, 0);
  }
});

const stale = [
  ['a writer that fails its final confirmation', w => { w.state.confirm = false; }],
  ['a PTY whose process start changes during the read', w => { w.state.start = '20'; }],
];
for (const [label, change] of stale) {
  test(`${label} yields no name from the ordinary reader`, () => {
    const w = world(); w.state.onRead = () => change(w);
    assert.equal(w.pinned.binding.observeName(), null);
  });
}
test('the ordinary reader reads once and confirms the writer once', () => {
  const w = world(); assert.equal(w.pinned.binding.observeName(), 'Task');
  assert.equal(w.state.calls.legacy, 1); assert.equal(w.state.calls.confirm, 1);
});
test('an action that is no longer admitted starts neither the read nor the confirmation', () => {
  const w = world(); assert.equal(w.pinned.binding.observeName(() => false), null);
  assert.equal(w.state.calls.legacy, 0);
  let calls = 0; assert.equal(w.pinned.binding.observeName(() => calls++ === 0), null);
  assert.equal(w.state.calls.confirm, 0);
});
test('a sandbox writer of another session yields no name and needs no confirmation', () => {
  const w = world({ sandbox: true }); w.state.writer = { ...w.state.writer, sessionId: '99999999-9999-9999-9999-999999999999' };
  assert.equal(w.pinned.binding.observeName(), null); assert.equal(w.state.calls.confirm, 0);
});
test('a sandbox writer is confirmed by its own reader, not a second confirmation', () => {
  const w = world({ sandbox: true }); assert.equal(w.pinned.binding.observeName(), 'Task'); assert.equal(w.state.calls.confirm, 0);
});
test('a name read leaves the delivery binding untouched', () => {
  const w = world(); const before = JSON.stringify({ ...w.pinned.binding, observeName: undefined });
  assert.equal(w.pinned.binding.observeName(), 'Task');
  assert.equal(w.pinned.binding.writerIdentity, null);
  assert.equal(JSON.stringify({ ...w.pinned.binding, observeName: undefined }), before);
});
test('a name read schedules no timer', () => {
  const w = world(); const original = global.setTimeout; const timers = [];
  global.setTimeout = (...args) => { timers.push(args[1]); return original(...args); };
  try { w.pinned.binding.observeName(); } finally { global.setTimeout = original; }
  assert.deepEqual(timers, []);
});

test('a deadline reached while the name is being read discards the name', async () => {
  let clock = Date.now(); const f = named({ now: () => clock, observe: () => { clock += 10 * 60 * 1000; return 'Task'; } });
  const r = await f.run('Task');
  assert.equal(r.outcome, 'opened'); assert.equal(r.actualName, null); assert.equal(f.observed, 1);
  assert.equal(r.enter_written, true);
});
test('cancellation during the name read discards the name', async () => {
  let allowed = true; const f = named({ observe: () => { allowed = false; return 'Task'; } });
  f.ctx.lifecycle.launchAllowed = () => allowed;
  const r = await f.new();
  assert.equal(r.actualName, null); assert.equal(r.requestedName, 'Task');
});
test('a target invalidated before commitment drops the name of a refused open and keeps its reason', async () => {
  const f = named(); let finalize;
  f.ctx.lifecycle.saveName = async () => ({ name: 'other' });
  f.execution.publish = (result, fin) => { finalize = fin; f.events.push(['result', result]); };
  const first = await f.new();
  assert.equal(first.reason, 'session name could not be saved'); assert.equal(first.actualName, 'Task');
  f.session.generation = 8;
  const settled = finalize(first);
  assert.equal(settled.reason, 'session name could not be saved'); assert.equal(settled.actualName, null);
  assert.equal(settled.requestedName, 'Task'); assert.equal(settled.created, true);
});

test('a surrogate refusal happens before project lookup, rate reservation, UUID allocation and dispatch', async () => {
  const f = named(); const calls = [];
  f.ctx.lifecycle.getProjectSnapshot = () => { calls.push('project'); return new Promise(() => {}); };
  f.ctx.lifecycle.randomUUID = () => { calls.push('uuid'); return NEW; };
  f.ctx.lifecycle.broker.request = async () => { calls.push('renderer'); return { ok: false }; };
  const r = await f.run('x\ud800y');
  assert.equal(r.reason, 'session name cannot be transported'); assert.deepEqual(calls, []);
});
test('a refused surrogate name does not spend a launch token', async () => {
  const f = named(); f.ctx.lifecycle.getProjectSnapshot = async () => ({ allProjects: [{ projectPath: project }], hiddenProjects: [], hiddenProjectKinds: {} });
  const actions = createTriggerActions({ now: () => Date.now() });
  const trigger = name => ({ version: 1, action: 'open', new: { project, name }, prompt: 'hello' });
  for (let i = 0; i < 5; i++) assert.equal((await actions.execute(trigger('x\ud800y'), STEM, f.execution)).reason, 'session name cannot be transported');
  for (let i = 0; i < 3; i++) assert.equal((await actions.execute(trigger('ok'), STEM, f.execution)).outcome, 'opened');
});
test('a valid new open with no lifecycle services carries the requested name and no actual name', async () => {
  const r = await createTriggerActions().execute({ version: 1, action: 'open', new: { project, name: '  Task  ' }, prompt: 'hello' }, STEM, { ctx: {} });
  assert.equal(r.reason, 'session action not implemented in this build');
  assert.equal(r.requestedName, 'Task'); assert.equal(r.actualName, null);
  const bad = await createTriggerActions().execute({ version: 1, action: 'open', new: { project, name: 'Task' }, prompt: '' }, STEM, { ctx: {} });
  assert.equal('requestedName' in bad, false);
  const existing = await createTriggerActions().execute({ version: 1, action: 'open', sessionId: ID, prompt: 'hello' }, STEM, { ctx: {} });
  assert.equal('requestedName' in existing, false);
  const stop = await createTriggerActions().execute({ version: 1, action: 'stop', sessionId: ID }, STEM, { ctx: {} });
  assert.equal('requestedName' in stop, false);
});
test('post-delivery name observation schedules no timer', async () => {
  const f = named(); const original = global.setTimeout; let after = false; const late = [];
  f.execution.deliver = async () => { after = true; return { ok: true, wrote: true, text_written: true, enter_written: true, submitted: 'assumed' }; };
  global.setTimeout = (...args) => { if (after) late.push(args[1]); return original(...args); };
  try { await f.new(); } finally { global.setTimeout = original; }
  assert.deepEqual(late, []);
});
test('a name observation leaves the delivery binding without writer authority', async () => {
  const f = named(); let binding;
  const pin = f.ctx.pinDelivery;
  f.ctx.pinDelivery = (...args) => { const pinned = pin(...args); binding = pinned.binding; return pinned; };
  const before = () => JSON.stringify({ ...binding, observeName: undefined });
  let snapshot;
  f.execution.deliver = async () => { snapshot = before(); return { ok: true, wrote: true, text_written: true, enter_written: true, submitted: 'assumed' }; };
  await f.new();
  assert.equal(before(), snapshot);
});

const nodeFs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { createJournal } = require('./fixtures/session-request-journal.cjs');
const { createSessionRequestNamespace } = require('../src/main/triggers/session-request-namespace');
const { createSessionRequestPublication } = require('../src/main/triggers/session-request-publication');

test('a named result keeps its snapshot through journal publication, a failed rename and replay', async t => {
  const f = named({ observe: () => 'Task-2' });
  const root = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'sb-name-journal-')));
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }));
  const processed = nodePath.join(root, 'processed'); nodeFs.mkdirSync(processed);
  const input = nodePath.join(root, STEM + '.json');
  const trigger = { version: 1, action: 'open', new: { project, name: 'Task' }, prompt: 'hello' };
  nodeFs.writeFileSync(input, JSON.stringify(trigger));
  const journal = createJournal(); let failRename = true;
  const publisher = createSessionRequestPublication({ fs: nodeFs, renameWithRetry: (from, to) => {
    if (failRename && to.endsWith('.result.json')) throw new Error('rename');
    nodeFs.renameSync(from, to);
  } });
  const actions = createTriggerActions();
  const namespace = createSessionRequestNamespace({ fs: nodeFs, journal, publisher, actions, processedDir: processed });
  const guarded = await namespace.begin(STEM, input);
  f.execution.publish = (result, finalize) => actions.publish({ result, namespace: guarded, finalize });
  const result = await actions.execute(trigger, STEM, f.execution);
  assert.equal(result.actualName, 'Task-2');
  const resultPath = nodePath.join(processed, STEM + '.result.json');
  assert.equal(nodeFs.existsSync(resultPath), false);
  failRename = false;
  const committed = Buffer.from((await journal.querySessionRequestOutcome({ stemKey: STEM.toLowerCase() })).owner.resultBytes);
  const replay = await createSessionRequestNamespace({ fs: nodeFs, journal, publisher, actions, processedDir: processed }).begin(STEM, input);
  assert.deepEqual(replay, { done: true });
  assert.deepEqual(nodeFs.readFileSync(resultPath), committed);
  const bytes = nodeFs.readFileSync(resultPath, 'utf8');
  assert.deepEqual(JSON.parse(bytes), JSON.parse(JSON.stringify(result)));
  assert.equal(JSON.parse(bytes).actualName, 'Task-2'); assert.equal(JSON.parse(bytes).requestedName, 'Task');
  assert.equal(f.observed, 1); assert.equal(kinds(f).filter(k => k === 'name').length, 1); assert.equal(kinds(f).filter(k => k === 'deliver').length, 1);
  const state = actions.readState(resultPath, nodePath.join(processed, 'none.action.json'));
  assert.equal(state.committed, true); assert.equal(state.result.actualName, 'Task-2'); assert.equal(state.result.requestedName, 'Task');
  assert.equal(nodeFs.readFileSync(resultPath, 'utf8'), bytes);
});

test('the action hands the binding a callback that follows its deadline, cancellation and target', async () => {
  let clock = Date.now(); const seen = [];
  const f = named({ now: () => clock, observe: admit => {
    seen.push(admit()); clock += 10 * 60 * 1000; seen.push(admit()); return 'Task';
  } });
  const r = await f.run('Task');
  assert.deepEqual(seen, [true, false]); assert.equal(r.actualName, null);
  let allowed = true; const cancelled = [];
  const g = named({ observe: admit => { cancelled.push(admit()); allowed = false; cancelled.push(admit()); return 'Task'; } });
  g.ctx.lifecycle.launchAllowed = () => allowed;
  assert.equal((await g.new()).actualName, null);
  assert.deepEqual(cancelled, [true, false]);
  const h = named({ observe: admit => { const before = admit(); h.session.generation = 8; seenTarget.push(before, admit()); return 'Task'; } });
  const seenTarget = [];
  await h.new();
  assert.deepEqual(seenTarget, [true, false]);
});
