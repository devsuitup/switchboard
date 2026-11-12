'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./fixtures/browser-mode.cjs');
const { loadAppFunctions } = require('./app-source');

for (const platform of ['linux', 'win32', 'darwin']) {
  for (const kind of ['new', 'resume', 'global', 'project']) {
    test(`${platform} ${kind}: Browser offers only Off and Claude in Chrome without writes on open`, async () => {
      const row = { browserMode: 'managed', chrome: true };
      const ctx = setup({ platform, effective: row, rows: { global: row } });
      try {
        if (kind === 'new') await ctx.window.showNewSessionDialog({ projectPath: '/fixture' });
        else if (kind === 'resume') await ctx.window.showResumeSessionDialog({ sessionId: 's', projectPath: '/fixture' });
        else await assert.doesNotReject(() => ctx.window.openSettingsViewer(kind, '/fixture'));
        const prefix = kind === 'new' ? 'nsd' : kind === 'resume' ? 'rsd' : 'sv';
        const select = ctx.document.querySelector(`#${prefix}-browser-mode`);
        assert.ok(select, 'Browser select must render');
        assert.deepEqual(Array.from(select.options, o => [o.value, o.textContent]), [['off', 'Off'], ['claude-in-chrome', 'Claude in Chrome']]);
        assert.equal(select.value, 'off');
        assert.equal(ctx.calls.filter(c => c[0] === 'save' || /browser/i.test(c[0])).length, 0);
        assert.equal(ctx.rows.global.browserMode, 'managed');
        if (kind === 'new' || kind === 'resume') {
          select.value = 'claude-in-chrome';
          ctx.document.querySelector('.new-session-start-btn').click();
          assert.equal(ctx.launched[0][1].browserMode, 'claude-in-chrome');
          assert.equal(Object.hasOwn(ctx.launched[0][1], 'chrome'), false);
        }
      } finally { ctx.destroy(); }
    });
  }
}

for (const kind of ['new', 'resume']) {
  test(`${kind}: legacy Chrome starts selected and explicit Off is sent`, async () => {
    const ctx = setup({ effective: { chrome: true } });
    try {
      if (kind === 'new') await ctx.window.showNewSessionDialog({ projectPath: '/fixture' });
      else await ctx.window.showResumeSessionDialog({ sessionId: 's', projectPath: '/fixture' });
      const select = ctx.document.querySelector(`#${kind === 'new' ? 'nsd' : 'rsd'}-browser-mode`);
      assert.ok(select, 'Browser select must render');
      assert.equal(select.value, 'claude-in-chrome');
      select.value = 'off';
      ctx.document.querySelector('.new-session-start-btn').click();
      assert.equal(ctx.launched[0][1].browserMode, 'off');
    } finally { ctx.destroy(); }
  });
}

test('defaults, fork and interactive schedule creator carry the browser mode', async () => {
  const ctx = setup({ effective: { chrome: true } });
  try {
    const project = { projectPath: '/fixture' };
    assert.equal((await ctx.window.resolveDefaultSessionOptions(project)).browserMode, 'claude-in-chrome');
    await ctx.window.forkSession({ sessionId: 'source' }, project);
    assert.equal(ctx.launched[0][1].browserMode, 'claude-in-chrome');
    assert.equal(ctx.launched[0][1].forkFrom, 'source');
    await ctx.window.launchScheduleCreator(project);
    const open = ctx.calls.find(c => c[0] === 'open');
    assert.equal(open[4].browserMode, 'claude-in-chrome');
  } finally { ctx.destroy(); }
});

test('resumed restore/open resolves the current browser default into the terminal IPC', async () => {
  const ctx = setup({ effective: { chrome: true } });
  try {
    const session = { sessionId: 's', projectPath: '/fixture' };
    Object.assign(ctx.window, {
      resolveResumeSession: async s => s, resolveSessionProjectPath: s => s.projectPath,
      isRemoteSession: () => false, guardResume: async () => true, cleanDisplayName: s => s,
      forgetSessionExit() {}, beginPtyOpen() {}, settlePtyOpen() {}, schedulePersistWorkingSet() {},
      setSessionMcpState() {}, setSessionSandboxed() {}, loadProjects() {},
      rowOpenId: () => null, clearAppNotice() {}, sessionActionNoticeId: () => 'fixture', clearDormantRow: () => false,
    });
    const functions = loadAppFunctions(ctx.context, { functions: ['openSessionNow'],
      declarations: ['restoreRunDepth', 'sessionOpenedOutsideRestore', 'openingSessions', 'dormantWorkingSet',
        'skippedWorkingSetEntries', 'restoreSavedIndex'] });
    await functions.openSessionNow(session, null, { automatic: true, fromRestore: true, continuationResolved: true });
    const open = ctx.calls.find(c => c[0] === 'open');
    assert.ok(open, 'restore/open must spawn the terminal');
    assert.equal(open[4].browserMode, 'claude-in-chrome');
  } finally { ctx.destroy(); }
});

test('startsFresh restore resolves the current browser default into the new launch', async () => {
  const ctx = setup({ effective: { chrome: true, worktree: true, worktreeName: 'saved' } });
  try {
    Object.assign(ctx.window, { liveElsewhereMany: async () => new Map() });
    const functions = loadAppFunctions(ctx.context, { functions: ['runRestore'],
      declarations: ['restoreRunDepth', 'restoreIndexingDone', 'restoreInFlight', 'restoreSavedIndex', 'RESTORE_STAGGER_MS'] });
    await functions.runRestore([{ sessionId: 'fresh', projectPath: '/fixture', fresh: true }], { retryAfterIndexing: false });
    assert.equal(ctx.launched.length, 1, 'startsFresh restore must launch a new session');
    const [project, options, sessionId] = ctx.launched[0];
    assert.equal(project.projectPath, '/fixture');
    assert.equal(sessionId, 'fresh');
    assert.equal(options.browserMode, 'claude-in-chrome', 'startsFresh restore must carry the current browser default');
    assert.equal(Object.hasOwn(options, 'chrome'), false);
    assert.equal(Object.hasOwn(options, 'worktree'), false);
    assert.equal(Object.hasOwn(options, 'worktreeName'), false);
  } finally { ctx.destroy(); }
});
