'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadDeletionHandlers } = require('./delete-session-harness');
const { loadProjectActionHandlers, bridgeHandlers } = require('./project-action-harness');
const { encodeProjectPath } = require('../encode-project-path');

const tick = () => new Promise(resolve => setImmediate(resolve));
const session = { sessionId: 'A', projectPath: '/repo', summary: 'Conversation', modified: new Date().toISOString() };

function setup(t, row = session) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.sessionMap.set(row.sessionId, row);
  ctx.sidebar.renderProjects([makeSampleProject({ projectPath: row.projectPath, sessions: [row] })], true);
  return ctx;
}

function assertRefusal(ctx, opener, reason) {
  assert.equal(ctx.document.querySelector('.new-session-overlay, .modal-overlay'), null, 'no confirmation dialog');
  const notice = ctx.document.querySelector('[role="alert"]');
  assert.ok(notice, 'a refusal notice');
  assert.match(notice.textContent, reason);
  assert.equal(ctx.document.activeElement, opener, 'focus stays on the opener');
  const dismiss = notice.querySelector('.app-notice-dismiss');
  dismiss.focus();
  dismiss.click();
  assert.equal(ctx.document.activeElement, opener, 'dismissal returns focus to the opener');
}

for (const reason of ['session is still running outside this window', 'background job job1 is still running this session', 'session state is unknown']) {
  test(`P8 preview refuses before resolving files: ${reason}`, async t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr7-preview-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    fs.mkdirSync(path.join(tmp, 'project'));
    for (const id of ['A', 'B']) fs.writeFileSync(path.join(tmp, 'project', id + '.jsonl'), '{}\n');
    const calls = [];
    const handlers = loadDeletionHandlers({
      PROJECTS_DIR: tmp, getCachedByParent: () => [],
      getMergedMemberIds: () => ['B', 'A'],
      getCachedFolder: () => 'project',
      deleteSessionGuard: async (id, parts) => { calls.push([id, Array.from(parts)]); return reason; },
    });
    const preview = await handlers.get('delete-session-preview')(null, 'A');
    assert.equal(preview.ok, false);
    assert.equal(preview.error, reason);
    assert.deepEqual(calls, [['A', ['A', 'B']]]);
  });
}

test('refused preview is awaited through preload before any dialog, deletion or stop', async t => {
  const ctx = setup(t);
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const calls = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr7-bridge-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, 'project'));
  fs.writeFileSync(path.join(tmp, 'project', 'A.jsonl'), '{}\n');
  const handlers = loadDeletionHandlers({ PROJECTS_DIR: tmp, getCachedFolder: () => 'project', getCachedByParent: () => [], getMergedMemberIds: () => [], deleteSessionGuard: () => ready });
  bridgeHandlers(ctx.window, handlers, calls);
  const opener = ctx.document.querySelector('.session-delete-btn');
  opener.focus();
  const pending = opener.onclick({ stopPropagation() {} });
  await tick();
  assert.equal(ctx.document.querySelector('#dss-confirm, .modal-overlay'), null, 'no dialog while the guard is pending');
  release('session is still running outside this window');
  await pending;
  assertRefusal(ctx, opener, /running outside this window/);
  assert.deepEqual(calls, [['delete-session-preview', 'A']]);
});

for (const state of ['pty', 'tab', 'snapshot']) {
  for (const merged of [false, true]) {
    test(`P7 ${merged ? 'merged' : 'single'} representative ${state} refuses before preview or stop`, async t => {
      const ctx = setup(t, { ...session, ...(merged ? { mergedMemberIds: ['B'] } : {}) });
      const calls = [];
      for (const method of ['deleteSessionPreview', 'deleteSession', 'stopSession', 'bgAgentLiveJob']) {
        ctx.window.api[method] = async () => { calls.push(method); return { ok: true, partIds: ['A'] }; };
      }
      if (state === 'pty') ctx.window.activePtyIds.add('A');
      if (state === 'tab') ctx.window.openSessions.set('A', { closed: false });
      if (state === 'snapshot') {
        ctx.window.sessionMap.get('A').status = 'idle';
        ctx.read("seedLocalTranscriptDescriptor('A')");
      }
      const opener = ctx.document.querySelector('.session-delete-btn');
      opener.focus();
      const pending = opener.onclick({ stopPropagation() {} });
      await tick();
      try {
        assertRefusal(ctx, opener, /still running.*stop/i);
        assert.deepEqual(calls, []);
      } finally {
        ctx.document.querySelector('#dss-cancel')?.click();
        await pending;
      }
    });
  }
}

test('idle Delete never stops or probes background jobs after confirmation', async t => {
  const ctx = setup(t);
  const calls = [];
  ctx.window.api.deleteSessionPreview = async () => ({ ok: true, partIds: ['A'], parts: 1, transcripts: 1, subagents: 0 });
  ctx.window.api.deleteSession = async () => { calls.push('delete'); return { ok: true }; };
  ctx.window.api.bgAgentLiveJob = async () => { calls.push('background probe'); return { known: true, job: null }; };
  ctx.window.api.stopSession = async () => { calls.push('stop'); return { ok: true }; };
  const pending = ctx.document.querySelector('.session-delete-btn').onclick({ stopPropagation() {} });
  await tick();
  ctx.document.querySelector('#dss-confirm').click();
  await pending;
  assert.deepEqual(calls, ['delete']);
});

test('Change path refuses a running folder PTY before picker or confirmation through preload', async t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const calls = [];
  const handlers = loadProjectActionHandlers({ activeSessions: new Map([['live', { exited: false, projectPath: '/missing/repo' }]]) });
  bridgeHandlers(ctx.window, handlers, calls);
  ctx.window.api.browseFolder = async () => { calls.push(['picker']); return '/new/repo'; };
  ctx.window.appConfirm = async () => { calls.push(['confirm']); return false; };
  ctx.sidebar.renderProjects([makeSampleProject({ projectPath: '/missing/repo', missing: true, sessions: [] })], true);
  const opener = ctx.document.querySelector('.project-remap-btn');
  opener.focus();
  await opener.onclick({ stopPropagation() {} });
  assertRefusal(ctx, opener, /Active sessions.*stop them first/);
  assert.deepEqual(calls, [['check-remap-project', '/missing/repo']]);
});

for (const refusal of ['unknown parent', 'invalid layout']) {
  test(`Delete worktree refuses ${refusal} before dialog or status`, async t => {
    const ctx = setupSidebarDom();
    t.after(() => ctx.destroy());
    const calls = [];
    const wt = '/repo/.claude/worktrees/task';
    const handlers = loadProjectActionHandlers({ getKnownProjectPaths: () => [] });
    bridgeHandlers(ctx.window, handlers, calls);
    ctx.sidebar.renderProjects([
      makeSampleProject({ projectPath: '/repo', sessions: [] }),
      makeSampleProject({ projectPath: wt, sessions: [] }),
    ], true);
    const opener = ctx.document.querySelector('.worktree-delete-btn');
    if (refusal === 'invalid layout') {
      ctx.window.api.checkDeleteWorktree = () => handlers.get('check-delete-worktree')(null, '/repo/plain');
    }
    opener.focus();
    const pending = opener.onclick({ stopPropagation() {} });
    await tick();
    try {
      assertRefusal(ctx, opener, refusal === 'unknown parent' ? /Parent repository is not a known project/ : /recognized worktree layout/);
      if (refusal === 'unknown parent') assert.deepEqual(calls, [['check-delete-worktree', wt]]);
    } finally {
      ctx.document.querySelector('#dwt-cancel')?.click();
      await pending;
    }
  });
}

test('worktree check is read-only and the action rechecks a parent removed after preview', async () => {
  let known = ['/repo'];
  const effects = [];
  const handlers = loadProjectActionHandlers({
    getKnownProjectPaths: () => known,
    execFile: () => effects.push('git'), writer: { cleanupWorktree: () => effects.push('cleanup') },
  });
  const check = handlers.get('check-delete-worktree');
  assert.equal((await check(null, '/repo/.worktrees/task/')).ok, true);
  assert.deepEqual(effects, []);
  known = [];
  const refused = await handlers.get('delete-worktree')(null, '/repo/.worktrees/task/');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not a known project/);
  assert.deepEqual(effects, []);
});

test('Change path shares its non-panel, non-exited, same-folder predicate with the action', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr7-remap-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const old = path.join(tmp, 'missing');
  const next = path.join(tmp, 'next');
  fs.mkdirSync(next);
  fs.mkdirSync(path.join(tmp, encodeProjectPath(old)));
  const sessions = new Map([
    ['panel', { panelFor: 'A', exited: false, projectPath: old }],
    ['exited', { exited: true, projectPath: old }],
    ['other', { exited: false, projectPath: path.join(tmp, 'other') }],
  ]);
  let writes = 0;
  const handlers = loadProjectActionHandlers({
    activeSessions: sessions, PROJECTS_DIR: tmp,
    writer: { remapProjectTranscripts: async () => { writes++; }, refreshFolder: async () => {} },
    notifyRendererProjectsChanged() {},
  });
  const check = handlers.get('check-remap-project');
  assert.equal((await check(null, old)).ok, true);
  assert.equal((await handlers.get('remap-project')(null, old, next)).ok, true);
  assert.equal(writes, 1);
  sessions.set('plain', { exited: false, isPlainTerminal: true, projectPath: old });
  assert.match((await check(null, old)).error, /Active sessions/);
  assert.match((await handlers.get('remap-project')(null, old, next)).error, /Active sessions/);
  assert.equal(writes, 1);
});
