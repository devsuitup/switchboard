'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { fixture: mainFixture, ID } = require('./fixtures/trigger-main-open.cjs');
const { fixture: rendererFixture } = require('./fixtures/trigger-renderer-open.cjs');
const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
const { createTriggerRendererBridge } = require('../src/main/triggers/trigger-renderer-bridge');
const { projectOperationGate, PROJECT_OPERATION_ERROR } = require('../src/main/shared/project-operation-gate');

function fixture(t) {
  const main = mainFixture();
  const renderer = rendererFixture(t);
  renderer.w.resolveDefaultSessionOptions = async () => ({ mcpEmulation: false });
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  ipcMain.removeHandler = name => handlers.delete(name);
  const wc = new EventEmitter();
  wc.mainFrame = {};
  wc.isDestroyed = () => false;
  const win = new EventEmitter();
  win.webContents = wc;
  win.isDestroyed = () => false;
  const event = { sender: wc, senderFrame: wc.mainFrame };
  const broker = createTriggerRendererBridge({ ipcMain, getWindow: () => win,
    getSession: id => main.map.get(id), launchAllowed: () => true });
  t.after(() => broker.dispose());
  main.context.triggerRendererBridge = broker;
  const requests = [];
  wc.send = (_channel, request) => {
    requests.push(request);
    void renderer.f.handleTriggerSessionAction(request);
  };
  const results = [];
  renderer.w.api.openTerminal = (...args) => main.invoke(event, ...args);
  renderer.w.api.triggerSessionActionResult = ack => {
    results.push(ack);
    ipcMain.emit('trigger-session-action-result', event, ack);
  };
  broker.attach(win);
  handlers.get('trigger-actions-ready')(event);
  const published = [];
  const names = [];
  const project = process.cwd();
  const actions = createTriggerActions();
  const execution = { deadline: Date.now() + 5000,
    acquireSessionLock: async () => () => {}, acquireTabLock: async () => () => {},
    saveMarker() {}, publish: result => published.push(result),
    ctx: { getPtyForSession: () => null, lifecycle: {
      broker, activeSessions: main.map, launchAllowed: () => true,
      getProjectSnapshot: async () => ({ allProjects: [{ projectPath: project }], hiddenProjects: [], hiddenProjectKinds: {} }),
      liveElsewhere: async () => ({ known: true, live: null }), remoteTarget: async () => false,
      resolveTarget: async () => ({ ok: true, sessionId: ID, project, cwd: project, transcript: 'file' }),
      randomUUID: () => ID, saveName: async (...args) => { names.push(args); return { name: args[1] }; },
    } },
  };
  return { main, renderer, requests, results, published, names, broker,
    execute: mode => actions.execute({ version: 1, action: 'open',
      ...(mode === 'new' ? { new: { project, name: 'Held task' }, prompt: 'hello' } : { sessionId: ID }) }, ID, execution) };
}

for (const mode of ['new', 'resume']) {
  test(`trigger ${mode} refuses a held project with an explicit operation reason and no saved session`, async t => {
    const f = fixture(t);
    const hold = projectOperationGate.hold(process.cwd());
    t.after(() => hold.release());
    const result = await f.execute(mode);
    assert.equal(f.main.spawns.length, 0, 'held trigger must spawn nothing');
    assert.equal(result.outcome, 'refused', 'held trigger must report the spec refusal outcome');
    assert.equal(result.reason, PROJECT_OPERATION_ERROR, 'held trigger must explain the project operation');
    assert.equal(result.ok, false);
    assert.equal(result[mode === 'new' ? 'created' : 'resumed'], false);
    assert.equal(result.uncertain, undefined, 'an explicit backend refusal has known effects');
    assert.equal(f.main.map.size, 0, 'held trigger must register no session');
    assert.equal(f.names.length, 0, 'held trigger must save no name');
    assert.equal(f.renderer.w.openSessions.size, 0);
    assert.equal(f.renderer.w.pendingSessions.size, 0);
    assert.equal(f.renderer.w.sessionMap.size, 0);
    for (const projects of [f.renderer.w.cachedProjects, f.renderer.w.cachedAllProjects]) {
      assert.equal(projects.some(project => project.sessions.some(session => session.sessionId === ID)), false);
    }
    assert.equal(f.renderer.calls.some(call => call[0] === 'persist'), false, 'held trigger must not schedule a working-set write');
    assert.equal(f.requests.length, 1);
    assert.equal(f.results.length, 1, 'the consumed permit must receive a definitive renderer reply');
    assert.equal(f.published.length, 1);
    assert.equal(f.broker.checkPermit(f.requests[0].requestId), null, 'refusal must retire the consumed permit');
    hold.release();
    const admission = projectOperationGate.tryAdmit(process.cwd());
    assert.ok(admission, 'refusal must leave no admission behind');
    admission.release();
    assert.equal((await f.main.open(null, mode === 'new')).ok, true, 'refusal must release the open serialization lock');
  });
}
