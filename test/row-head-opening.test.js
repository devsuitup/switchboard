'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions, extractFunction } = require('./app-source');
const { computeHostProfile, attachBlockReason, sendBlockReason } = require('../remote-host-profile');

const mainPath = path.join(__dirname, '../main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const row = {
  sessionId: 'A', headSessionId: 'B', mergedMemberIds: ['B', 'C'],
  projectPath: '/project', summary: 'Conversation', modified: new Date().toISOString(),
};

function setup(t, { session = row, live = {}, candidates = [], confirm = false } = {}) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.evalPublic('resume-guard.js');
  const checked = [], spawned = [], prompts = [], shown = [], viewed = [];
  Object.assign(ctx.window, {
    restoringWorkingSet: false, sessionOpenedOutsideRestore: false,
    showSession: id => shown.push(id),
    showJsonlViewer: target => viewed.push(target.sessionId),
    appConfirm: async ({ message }) => { prompts.push(message); return confirm; },
    appAlert: async ({ message }) => { prompts.push(message); },
    createTerminalEntry: target => {
      const entry = { initialSize: { cols: 80, rows: 24 }, terminal: { write() {} } };
      ctx.window.openSessions.set(target.sessionId, entry);
      return entry;
    },
    resolveDefaultSessionOptions: async () => ({}),
    forgetSessionExit() {}, syncPtySizeAfterOpen() {}, setSessionSandboxed() {},
    schedulePersistWorkingSet() {}, pollActiveSessions() {},
  });
  Object.assign(ctx.window.api, {
    getSessionContinuations: async () => ({ candidates, unresolved: false }),
    getSessionLiveElsewhere: async id => { checked.push([id]); return live[id] || null; },
    getSessionsLiveElsewhere: async ids => {
      checked.push(Array.from(ids));
      return Object.fromEntries(ids.filter(id => live[id]).map(id => [id, live[id]]));
    },
    openTerminal: async id => { spawned.push(id); return { ok: true }; },
  });
  const app = loadAppFunctions(ctx.context, {
    functions: ['openSession', 'openSessionNow', 'beginPtyOpen', 'settlePtyOpen', 'dormantRowIds', 'syncDormantRow', 'clearDormantRow'],
    declarations: ['openingSessions', 'skippedWorkingSetEntries', 'restoreSavedIndex',
      'continuationRetryCancelled', 'ptyGenerations', 'pendingOpens', 'dormantWorkingSet', 'restoreMode', 'restoreInFlight'],
  });
  ctx.window.sessionMap.set(session.sessionId, session);
  ctx.sidebar.renderProjects([makeSampleProject({ projectPath: session.projectPath, remoteAlias: session.remoteAlias, sessions: [session] })], true);
  return {
    ctx, app, checked, spawned, prompts, shown, viewed,
    click: async () => {
      ctx.document.getElementById('si-A').click();
      await Promise.all(ctx.read('[...openingSessions.values()].map(open => open.promise)'));
    },
  };
}

function remoteMain(descriptorIds) {
  const descriptors = descriptorIds.map(sessionId => ({ sessionId, pid: 42, cwd: '/remote/project', tmux: 'main:@0.%0' }));
  const attached = [], handlers = new Map();
  const context = vm.createContext({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    activeSessions: new Map(), mainWindow: { webContents: { send() {} } },
    remoteIndexer: {
      getRemoteSessions: () => ({ sessions: descriptors, at: 100, error: null }),
      getRemoteHostState: () => ({ consecutiveFailures: 0 }),
      getRemoteHostProfile: () => computeHostProfile({ at: 100, descriptors, error: null }),
    },
    remoteAttachAdapter: {
      supports: () => true,
      attach: async (_alias, descriptor) => { attached.push(descriptor.sessionId); return { ok: true, ptyProcess: {} }; },
    },
    remoteActivityTracker: { activeAt: () => null }, cliSessionState: {},
    attachBlockReason, sendBlockReason,
    getCachedFolder: () => 'host::project', isRemoteFolder: () => true,
    parseFolderKey: () => ({ alias: 'host' }),
    normalizePtySize: require('../pty-size').normalizePtySize,
    wireSessionPty() {}, revealIfSdkSession() {},
    REMOTE_READ_ONLY: 'read-only',
  });
  for (const name of ['annotateRemoteAttachable', 'registerRemoteAttachSession']) {
    vm.runInContext(extractFunction(mainSource, name), context, { filename: mainPath });
  }
  const start = mainSource.indexOf("ipcMain.handle('open-terminal'");
  const end = mainSource.indexOf('\n});', start) + 4;
  assert.ok(start >= 0 && end > start);
  vm.runInContext(mainSource.slice(start, end), context, { filename: mainPath });
  return { context, attached, open: handlers.get('open-terminal') };
}

for (const [name, descriptors, expected] of [
  ['head only', ['B'], 'B'], ['representative only', ['A'], 'A'],
  ['neither', [], null], ['both', ['A', 'B'], 'B'], ['another member only', ['C'], 'C'],
]) {
  test(`remote merged row with descriptor on ${name} uses the same attach target through click and main`, async t => {
    const main = remoteMain(descriptors);
    const session = { ...row, remoteAlias: 'host' };
    main.context.annotateRemoteAttachable([{ remoteAlias: 'host', sessions: [session] }]);
    const h = setup(t, { session });
    h.ctx.window.api.openTerminal = async (...args) => {
      h.spawned.push(args[0]);
      return main.open(null, ...args);
    };
    await h.click();
    assert.deepEqual(h.spawned, expected ? [expected] : []);
    assert.deepEqual(main.attached, expected ? [expected] : []);
    assert.deepEqual(h.viewed, expected ? [] : ['A']);
    assert.equal(session.remoteAttachable, !!expected);
    assert.equal(session.remoteDescriptorSeen, descriptors.includes('A'));
    assert.equal(session.remoteMemberDescriptorSeen.B, descriptors.includes('B'));
  });
}

for (const id of ['B', 'A', 'C']) {
  test(`merged row live elsewhere on ${id} refuses a cancelled click before spawning the head`, async t => {
    const h = setup(t, { live: { [id]: { pid: 4242, cwd: '/elsewhere' } } });
    await h.click();
    assert.deepEqual(h.spawned, []);
    assert.equal(h.prompts.length, 1);
    assert.match(h.prompts[0], /pid 4242/);
    assert.deepEqual(h.checked, [['B', 'C', 'A']]);
  });
}

test('merged row live elsewhere on a member is checked even with a supplied null head result', async t => {
  const h = setup(t, { live: { C: { pid: 4242 } } });
  assert.equal(await h.app.openSession({ ...row, sessionId: 'B', mergedMemberIds: ['C', 'A'] }, undefined, { automatic: true, live: null }), false);
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.checked, [['B', 'C', 'A']]);
});

test('merged row live elsewhere checks another scheduled part after accepting the head warning', async t => {
  const h = setup(t, { confirm: true, live: { B: { pid: 11 }, C: { pid: 12, kind: 'schedule' } } });
  await h.click();
  assert.deepEqual(h.spawned, []);
  assert.equal(h.prompts.length, 2);
  assert.match(h.prompts[1], /scheduled task/);
});

test('same-row continuation from a representative head to a member opens the head without a prompt', async t => {
  const h = setup(t, { session: { ...row, headSessionId: 'A' }, candidates: [{ sessionId: 'B' }] });
  await h.click();
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.spawned, ['A']);
});

test('same-row continuation to the representative is excluded while an external candidate remains', async t => {
  const h = setup(t, { candidates: [{ sessionId: 'A' }, { sessionId: 'D' }], confirm: true });
  await h.click();
  assert.deepEqual(h.spawned, ['D']);
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /Open D\?/);
  assert.doesNotMatch(h.prompts[0], /A \(last activity/);
});

test('end-to-end click checks the head id and opens the head through real openSession functions', async t => {
  const h = setup(t);
  await h.click();
  assert.deepEqual(h.checked, [['B', 'C', 'A']]);
  assert.deepEqual(h.spawned, ['B']);
  assert.deepEqual(h.shown, ['B']);
  assert.equal(h.ctx.window.sessionMap.get('A').sessionId, 'A');
});

test('changelog #564 explains showing the latest part tab when both parts have tabs', () => {
  const entry = fs.readFileSync(path.join(__dirname, '../CHANGELOG.md'), 'utf8').split('\n').find(line => line.includes('(#564)'));
  assert.match(entry, /both parts have open tabs/);
  assert.match(entry, /shows the latest part.s tab/);
});
