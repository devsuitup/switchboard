'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const plain = value => JSON.parse(JSON.stringify(value));
async function settle() {
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}
function setup(t, sessions = [], schedules = [], children = []) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const rows = sessions.map(s => ({ name: s.sessionId, projectPath: '/p', modified: new Date().toISOString(), ...s }));
  const project = { projectPath: '/p', folder: '-p', sessions: rows };
  ctx.window.cachedAllProjects = [project, ...children];
  for (const row of rows) ctx.window.sessionMap.set(row.sessionId, row);
  ctx.sidebar.renderProjects(ctx.window.cachedAllProjects, true);
  const calls = [];
  ctx.window.api.bgAgentLiveJob = async () => ({ known: true, job: null });
  ctx.window.api.getProjectArchivePlan = async () => ({ schedules });
  ctx.window.api.archiveProject = async (...args) => { calls.push(['folder', ...plain(args)]); return { ok: true, archivedAt: 123, disabled: schedules.filter(s => s.disableable).map(s => s.name) }; };
  ctx.window.api.undoArchiveProject = async (...args) => { calls.push(['undoFolder', ...plain(args)]); return { ok: true }; };
  ctx.window.api.archiveSession = async (...args) => { calls.push(['archive', ...args]); return { ok: true }; };
  ctx.window.api.stopSession = async id => { calls.push(['stop', id]); return { ok: true }; };
  ctx.window.api.remoteStopSession = async (...args) => { calls.push(['remoteStop', ...args]); return { ok: true }; };
  ctx.window.loadProjects = async () => {};
  return { ...ctx, calls, rows };
}
function archive(ctx) {
  return ctx.document.querySelector('.project-archive-btn').onclick({ stopPropagation() {} });
}
function answer(ctx, yes = true) {
  const overlay = ctx.document.querySelector('.modal-overlay');
  assert.ok(overlay, 'options dialog opens');
  overlay.querySelector(yes ? '.choice-dialog-confirm' : '.choice-dialog-cancel').click();
}
function undo(ctx) {
  return [...ctx.document.querySelectorAll('#app-notices .app-notice-action')].find(b => b.textContent === 'Undo');
}

test('PR5b running local and remote parts are named with places in a danger dialog', async t => {
  const ctx = setup(t, [{ sessionId: 'S' }, { sessionId: 'R', remoteAlias: 'vps', remoteDescriptorSeen: true }]);
  ctx.window.setRemoteHostLabels([{ alias: 'vps', label: 'VPS label' }]);
  ctx.window.activePtyIds.add('S');
  const pending = archive(ctx);
  await settle();
  const label = ctx.document.querySelector('[data-choice-id="archiveSessions"]').parentElement.textContent;
  assert.match(label, /S.*in this window/);
  assert.match(label, /R.*on VPS label/);
  assert.ok(ctx.document.querySelector('.choice-dialog-confirm.delete-worktree-confirm-btn'));
  answer(ctx, false);
  await pending;
  assert.deepEqual(ctx.calls, []);
});

test('PR5b running names are capped with +N more and unseeded remote parts are named', async t => {
  const ctx = setup(t, Array.from({ length: 9 }, (_, i) => ({ sessionId: `R${i}`, remoteAlias: 'vps', remoteHostAt: null })));
  const pending = archive(ctx);
  await settle();
  const label = ctx.document.querySelector('[data-choice-id="archiveSessions"]').parentElement.textContent;
  assert.match(label, /R0.*possibly running.*on vps/);
  assert.match(label, /\+\d+ more/);
  assert.doesNotMatch(label, /R8/);
  answer(ctx, false);
  await pending;
});

for (const state of ['job', 'unknown', 'throws']) {
  test(`PR5b ${state} background refusal precedes every folder dialog`, async t => {
    const ctx = setup(t, [{ sessionId: 'S', mergedMemberIds: ['B'] }]);
    ctx.window.api.bgAgentLiveJob = async id => {
      if (id !== 'B') return { known: true, job: null };
      if (state === 'throws') throw new Error('offline');
      return state === 'job' ? { known: true, job: { id: 'job-B' } } : { known: false, reason: 'offline' };
    };
    const pending = archive(ctx);
    await settle();
    assert.equal(ctx.document.querySelector('.modal-overlay'), null, 'no dialog before refusal');
    await pending;
    assert.deepEqual(ctx.calls, []);
    assert.match(ctx.document.querySelector('[role="alert"]').textContent, state === 'job' ? /job-B/ : /cannot tell.*offline/);
  });
}

test('PR5b R2 empty folder archives immediately with timestamped folder Undo', async t => {
  const ctx = setup(t);
  const pending = archive(ctx);
  await settle();
  assert.equal(ctx.document.querySelector('.modal-overlay'), null, 'no empty options dialog');
  await pending;
  assert.equal(ctx.calls[0][0], 'folder');
  assert.ok(undo(ctx));
  assert.doesNotMatch(undo(ctx).parentElement.textContent, /stay stopped/);
  undo(ctx).click();
  await settle();
  assert.deepEqual(ctx.calls[1], ['undoFolder', [{ projectPath: '/p', folderKey: '-p' }], 123]);
});

test('PR5b Q4 idle options are configuration without danger or Undo', async t => {
  const ctx = setup(t, [], [{ name: 'X', filePath: '/x', disableable: true }]);
  const pending = archive(ctx);
  await settle();
  assert.ok(ctx.document.querySelector('.modal-overlay'));
  assert.equal(ctx.document.querySelector('.choice-dialog-confirm.delete-worktree-confirm-btn'), null);
  answer(ctx);
  await pending;
  assert.equal(undo(ctx), undefined);
  assert.deepEqual(ctx.calls, [['folder', [{ projectPath: '/p', folderKey: '-p' }], { disableSchedules: ['/x'] }]]);
});

test('PR5b Q5 Undo restores this click only and names disabled schedules and worktrees', async t => {
  const child = { projectPath: '/p/.claude/worktrees/w', folder: '-p-w', sessions: [] };
  const ctx = setup(t, [{ sessionId: 'S' }, { sessionId: 'old', archived: 1 }], [{ name: 'X', filePath: '/x', disableable: true }], [child]);
  ctx.window.activePtyIds.add('S');
  const pending = archive(ctx);
  await settle();
  answer(ctx);
  await pending;
  assert.ok(undo(ctx), 'confirmed Archive offers Undo');
  assert.match(undo(ctx).parentElement.textContent, /stay stopped/);
  assert.match(undo(ctx).parentElement.textContent, /X/);
  assert.match(undo(ctx).parentElement.textContent, /\/p\/\.claude\/worktrees\/w/);
  undo(ctx).click();
  await settle();
  assert.deepEqual(ctx.calls, [
    ['stop', 'S'], ['archive', 'S', 1],
    ['folder', [{ projectPath: '/p', folderKey: '-p' }, { projectPath: child.projectPath, folderKey: '-p-w' }], { disableSchedules: ['/x'] }],
    ['undoFolder', [{ projectPath: '/p', folderKey: '-p' }, { projectPath: child.projectPath, folderKey: '-p-w' }], 123],
    ['archive', 'S', 0],
  ]);
});

test('PR5b stop refusal leaves every archive untouched and offers no Undo', async t => {
  const ctx = setup(t, [{ sessionId: 'S' }]);
  ctx.window.activePtyIds.add('S');
  ctx.window.api.stopSession = async () => ({ ok: false, error: 'refused' });
  const pending = archive(ctx);
  await settle();
  answer(ctx);
  await pending;
  assert.deepEqual(ctx.calls, []);
  assert.equal(undo(ctx), undefined);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /refused/);
});

test('PR5b folder reconfirms newly running targets before effects', async t => {
  const ctx = setup(t, [{ sessionId: 'S' }, { sessionId: 'B' }]);
  ctx.window.activePtyIds.add('S');
  const pending = archive(ctx);
  await settle();
  ctx.window.activePtyIds.add('B');
  answer(ctx);
  await settle();
  assert.ok(ctx.document.querySelector('.modal-overlay'), 'new target requires confirmation');
  assert.match(ctx.document.querySelector('.modal-overlay').textContent, /B.*in this window/);
  assert.deepEqual(ctx.calls, []);
  answer(ctx, false);
  await pending;
});

test('PR5b stale folder Undo refusal cannot unarchive sessions', async t => {
  const ctx = setup(t, [{ sessionId: 'S' }]);
  ctx.window.activePtyIds.add('S');
  ctx.window.api.undoArchiveProject = async () => ({ ok: false, error: 'stale' });
  const pending = archive(ctx);
  await settle(); answer(ctx); await pending;
  assert.ok(undo(ctx)); undo(ctx).click(); await settle();
  assert.equal(ctx.calls.some(c => c[0] === 'archive' && c[2] === 0), false);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /stale/);
});

test('PR5b a pre-Archive project reload keeps the fresh folder Undo', async t => {
  const ctx = setup(t);
  ctx.window.api.getProjects = async () => ({ defaultProjects: [], allProjects: [] });
  ctx.window.api.getSetting = async () => ({});
  let release;
  let reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  ctx.window.api.getActiveTerminals = () => {
    ctx.window.api.getActiveTerminals = async () => [];
    return new Promise(resolve => { release = resolve; reached(); });
  };
  ctx.window.loadingStatus = ctx.document.createElement('div');
  ctx.window.reportActivityFocus = () => {};
  ctx.window.reportActivityTitles = () => {};
  ctx.window.refreshSidebar = () => {};
  ctx.window.renderDefaultStatus = () => {};
  const app = loadAppFunctions(ctx.context, { functions: ['dedup', 'loadProjects'] });
  const loading = app.loadProjects();
  await waiting;
  await archive(ctx);
  const action = undo(ctx);
  assert.ok(action);
  release([]);
  await loading;
  assert.equal(action.isConnected, true, 'older settings cannot clear folder Undo');
  await app.loadProjects();
  assert.equal(action.isConnected, true, 'a later project reload also keeps folder Undo');
});
