// Coverage for issue #271 — the sidebar's four archive/delete call sites
// (.project-archive-btn, .slug-group-archive-btn, .session-delete-btn,
// .session-archive-btn) must stop a running session on its actual host
// before archiving/deleting it, not just detach a local PTY. They share one
// decision, public/stop-session-ui.js's stopBeforeArchive() (built on the
// same resolveSessionStop()/isRemoteSessionAlive() the individual stop
// control uses) — see .ai/contexts/session-state.md ("The two lifecycle
// verbs: detach and stop").
//
// Delete is the one exception: main.js refuses to delete a remote session
// outright (REMOTE_READ_ONLY), so the delete site must skip the stop for a
// remote row entirely rather than kill the process and then fail to delete
// it — see the per-session-delete tests below.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, answerChoiceDialog } = require('./dom-setup');

function installRecordingApi(ctx, overrides = {}) {
  ctx.window.appConfirm = async () => true;
  const calls = [];
  const impls = {
    stopSession: () => Promise.resolve({ ok: true }),
    remoteStopSession: () => Promise.resolve({ ok: true }),
    archiveSession: () => Promise.resolve({ ok: true }),
    getProjectArchivePlan: () => Promise.resolve({ schedules: [] }),
    archiveProject: () => Promise.resolve({ ok: true, disabled: [], failed: [] }),
    deleteSession: () => Promise.resolve({ ok: true, removed: ['x'], subagents: 0 }),
    deleteSessionPreview: id => Promise.resolve({ ok: true, partIds: [id], transcripts: 1, subagents: 0, running: false }),
    ...overrides,
  };
  ctx.window.api = new Proxy({}, {
    get(_target, prop) {
      return (...args) => {
        calls.push({ method: String(prop), args });
        const impl = impls[prop];
        return impl ? impl(...args) : Promise.resolve({ ok: true });
      };
    },
  });
  return calls;
}

function localSession(id, extra = {}) {
  return {
    sessionId: id, projectPath: '/home/dev/proj', name: id, summary: id,
    modified: '2026-05-22T10:00:00Z', archived: 0, ...extra,
  };
}

function remoteSession(id, alias, alive, extra = {}) {
  return {
    sessionId: id, projectPath: '/home/dev/proj', remoteAlias: alias, remoteDescriptorSeen: alive,
    name: id, summary: id, modified: '2026-05-22T10:00:00Z', archived: 0, ...extra,
  };
}

function headerFor(ctx, project) {
  return ctx.document.getElementById('ph-' + ctx.sidebar.folderId(project.projectPath));
}

// ---------------------------------------------------------------------------
// stopBeforeArchive() — the decision table directly.
// ---------------------------------------------------------------------------

test('stopBeforeArchive: local session with an active PTY stops it and clears activePtyIds', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = installRecordingApi(ctx);
    ctx.window.activePtyIds.add('s1');
    const result = await ctx.window.stopBeforeArchive({ sessionId: 's1' });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(c => c.method), ['bgAgentLiveJob', 'stopSession']);
    assert.equal(calls[1].args[0], 's1');
    assert.equal(ctx.window.activePtyIds.has('s1'), false);
  } finally { ctx.destroy(); }
});

test('stopBeforeArchive: local session with no PTY calls nothing', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = installRecordingApi(ctx);
    const result = await ctx.window.stopBeforeArchive({ sessionId: 's1' });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(c => c.method), ['bgAgentLiveJob'], 'only the background-job check');
  } finally { ctx.destroy(); }
});

test('stopBeforeArchive: an alive remote session calls remoteStopSession with the alias, never bare stopSession', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = installRecordingApi(ctx);
    const result = await ctx.window.stopBeforeArchive({ sessionId: 's1', remoteAlias: 'vps', remoteDescriptorSeen: true });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(c => c.method), ['remoteStopSession']);
    assert.deepEqual(calls[0].args, ['vps', 's1']);
  } finally { ctx.destroy(); }
});

test('stopBeforeArchive: a remote session that is not alive calls nothing', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = installRecordingApi(ctx);
    const result = await ctx.window.stopBeforeArchive({ sessionId: 's1', remoteAlias: 'vps', remoteDescriptorSeen: false });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, []);
  } finally { ctx.destroy(); }
});

test('stopBeforeArchive: a dead adapter snapshot wins over a stale remoteDescriptorSeen=true', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = installRecordingApi(ctx);
    ctx.remoteSessionStates.set('s1', { snapshot: () => ({ liveness: 'dead' }) });
    const result = await ctx.window.stopBeforeArchive({ sessionId: 's1', remoteAlias: 'vps', remoteDescriptorSeen: true });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [], 'this app already stopped it — the descriptor just has not caught up yet');
  } finally { ctx.destroy(); }
});

test('stopBeforeArchive: a failed remote stop surfaces { ok: false, error }', async () => {
  const ctx = setupSidebarDom();
  try {
    installRecordingApi(ctx, { remoteStopSession: () => Promise.resolve({ ok: false, error: 'pid now belongs to a non-claude process' }) });
    const result = await ctx.window.stopBeforeArchive({ sessionId: 's1', remoteAlias: 'vps', remoteDescriptorSeen: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'pid now belongs to a non-claude process');
  } finally { ctx.destroy(); }
});

// ---------------------------------------------------------------------------
// .project-archive-btn
// ---------------------------------------------------------------------------

function sessionsBoxLabel(ctx) {
  const box = ctx.document.querySelector('.modal-overlay input[data-choice-id="archiveSessions"]');
  assert.ok(box, 'the dialog must offer to archive the sessions');
  return box.parentElement.textContent;
}

test('project archive-all: an alive remote session is stopped on its host, alias named in the confirmation', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/home/dev/proj', sessions: [remoteSession('r1', 'vps', true)] };
    const calls = installRecordingApi(ctx);
    ctx.window.cachedAllProjects = [project];

    ctx.sidebar.renderProjects([project], true);
    const done = headerFor(ctx, project).querySelector('.project-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    await new Promise(r => setTimeout(r, 0));
    const prompt = sessionsBoxLabel(ctx);
    await answerChoiceDialog(ctx, { confirm: true });
    await done;

    assert.match(prompt, /vps/, 'the confirmation must name the host alias that will be stopped');
    assert.deepEqual(calls.filter(c => c.method === 'remoteStopSession').map(c => c.args), [['vps', 'r1']]);
    assert.deepEqual(calls.filter(c => c.method === 'stopSession'), [], 'a remote session must never reach bare stopSession');
    assert.deepEqual(calls.filter(c => c.method === 'archiveSession').map(c => c.args[0]), ['r1']);
  } finally { ctx.destroy(); }
});

test('project archive-all: no alias is named when no session in the group is a live remote', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/home/dev/proj', sessions: [remoteSession('r1', 'vps', false), localSession('s2')] };
    installRecordingApi(ctx);
    ctx.window.cachedAllProjects = [project];

    ctx.sidebar.renderProjects([project], true);
    const done = headerFor(ctx, project).querySelector('.project-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    await new Promise(r => setTimeout(r, 0));
    const prompt = sessionsBoxLabel(ctx);
    await answerChoiceDialog(ctx, { confirm: false });
    await done;

    assert.doesNotMatch(prompt, /vps/, 'a dead remote session is nothing to stop, so it must not be named');
  } finally { ctx.destroy(); }
});

test('project archive-all: a stop refusal is surfaced, every other session is still stopped, and nothing is archived', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/home/dev/proj', sessions: [remoteSession('r1', 'vps', true), localSession('s2')] };
    ctx.window.activePtyIds.add('s2');
    const calls = installRecordingApi(ctx, {
      remoteStopSession: () => Promise.resolve({ ok: false, error: 'pid now belongs to a non-claude process' }),
    });
    ctx.window.cachedAllProjects = [project];

    ctx.sidebar.renderProjects([project], true);
    const done = headerFor(ctx, project).querySelector('.project-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    await answerChoiceDialog(ctx, { confirm: true });
    await done;

    assert.deepEqual(calls.filter(c => c.method === 'stopSession').map(c => c.args[0]), ['s2'],
      'the local session must still be stopped after the remote one was refused');
    assert.deepEqual(calls.filter(c => c.method === 'archiveSession'), [],
      'one refused stop must leave every session unarchived');
    assert.deepEqual(calls.filter(c => c.method === 'archiveProject'), [], 'nor archive the folder');
    assert.match(ctx.document.querySelector('[data-notice-id="Archive:vps:r1"]').textContent, /non-claude/);
  } finally { ctx.destroy(); }
});

// ---------------------------------------------------------------------------
// .slug-group-archive-btn
// ---------------------------------------------------------------------------

test('slug-group archive: a stop refusal on one remote session skips it, the other (local) session still archives', async () => {
  const ctx = setupSidebarDom();
  try {
    const r1 = remoteSession('r1', 'vps', true, { scheduleSlug: 'grp' });
    const s2 = localSession('s2', { scheduleSlug: 'grp' });
    const project = { projectPath: '/home/dev/proj', sessions: [r1, s2] };
    ctx.window.sessionMap.set('r1', r1);
    ctx.window.sessionMap.set('s2', s2);
    ctx.window.activePtyIds.add('s2');
    const calls = installRecordingApi(ctx, {
      remoteStopSession: () => Promise.resolve({ ok: false, error: 'ssh: connection refused' }),
    });

    ctx.sidebar.renderProjects([project], true);
    const group = ctx.document.querySelector('.slug-group');
    assert.ok(group, 'the two same-slug sessions must render as a slug group');
    await group.querySelector('.slug-group-archive-btn').onclick(new ctx.window.MouseEvent('click'));

    assert.deepEqual(calls.filter(c => c.method === 'remoteStopSession').map(c => c.args), [['vps', 'r1']]);
    assert.deepEqual(calls.filter(c => c.method === 'stopSession').map(c => c.args[0]), ['s2']);
    assert.deepEqual(calls.filter(c => c.method === 'archiveSession').map(c => c.args[0]), ['s2'],
      'the refused remote session must not be archived; the local one still proceeds');
    assert.match(ctx.document.querySelector('[data-notice-id="Archive:vps:r1"]').textContent, /ssh: connection refused/);
  } finally { ctx.destroy(); }
});

// ---------------------------------------------------------------------------
// .session-delete-btn
// ---------------------------------------------------------------------------

test('per-session delete: a local session with an active PTY is stopped before the delete IPC', async () => {
  const ctx = setupSidebarDom();
  try {
    const s1 = localSession('s1');
    ctx.window.sessionMap.set('s1', s1);
    ctx.window.activePtyIds.add('s1');
    const calls = installRecordingApi(ctx);

    ctx.sidebar.renderProjects([{ projectPath: '/home/dev/proj', sessions: [s1] }], true);
    const item = ctx.document.getElementById('si-s1');
    item.querySelector('.session-delete-btn').click();
    // showDeleteSessionDialog awaits deleteSessionPreview — flush both that
    // microtask and the dialog's own promise chain before confirming.
    await new Promise(r => setTimeout(r, 0));
    ctx.document.getElementById('dss-confirm').click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const methods = calls.map(c => c.method);
    assert.ok(methods.indexOf('stopSession') !== -1, 'the running local session must be stopped');
    assert.ok(methods.indexOf('stopSession') < methods.indexOf('deleteSession'),
      'the stop must happen before the delete IPC call');
  } finally { ctx.destroy(); }
});

test('per-session delete: a stale local row that becomes remote never stops it before the backend refusal', async () => {
  const ctx = setupSidebarDom();
  try {
    const r1 = localSession('r1');
    ctx.window.sessionMap.set('r1', r1);
    const calls = installRecordingApi(ctx, {
      deleteSession: () => Promise.resolve({ ok: false, error: 'remote sessions are read-only — this build observes them, it does not attach to them' }),
    });

    ctx.sidebar.renderProjects([{ projectPath: '/home/dev/proj', sessions: [r1] }], true);
    const item = ctx.document.getElementById('si-r1');
    Object.assign(r1, remoteSession('r1', 'vps', true));
    item.querySelector('.session-delete-btn').click();
    await new Promise(r => setTimeout(r, 0));
    ctx.document.getElementById('dss-confirm').click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    assert.deepEqual(calls.filter(c => c.method === 'stopSession'), [], 'a remote delete must never stop the process');
    assert.deepEqual(calls.filter(c => c.method === 'remoteStopSession'), [], 'nor call the remote stop IPC');
    assert.ok(calls.some(c => c.method === 'deleteSession'), 'the delete IPC is still attempted (and refused server-side)');
  } finally { ctx.destroy(); }
});

// ---------------------------------------------------------------------------
// .session-archive-btn (per-session toggle)
// ---------------------------------------------------------------------------

test('per-session archive toggle: local session with an active PTY is stopped, then archived', async () => {
  const ctx = setupSidebarDom();
  try {
    const s1 = localSession('s1');
    ctx.window.sessionMap.set('s1', s1);
    ctx.window.activePtyIds.add('s1');
    const calls = installRecordingApi(ctx);

    ctx.sidebar.renderProjects([{ projectPath: '/home/dev/proj', sessions: [s1] }], true);
    await ctx.document.getElementById('si-s1').querySelector('.session-archive-btn').onclick(new ctx.window.MouseEvent('click'));

    const methods = calls.map(c => c.method);
    assert.deepEqual(methods.filter(method => method !== 'bgAgentLiveJob'), ['stopSession', 'archiveSession'], 'stop must precede archive');
  } finally { ctx.destroy(); }
});

test('per-session archive toggle: a failed remote stop blocks the archive with a persistent notice', async () => {
  const ctx = setupSidebarDom();
  try {
    const r1 = remoteSession('r1', 'vps', true);
    ctx.window.sessionMap.set('r1', r1);
    const calls = installRecordingApi(ctx, {
      remoteStopSession: () => Promise.resolve({ ok: false, error: 'pid now belongs to a non-claude process' }),
    });

    ctx.sidebar.renderProjects([{ projectPath: '/home/dev/proj', sessions: [r1] }], true);
    const archiveBtn = ctx.document.getElementById('si-r1').querySelector('.session-archive-btn');
    await archiveBtn.onclick(new ctx.window.MouseEvent('click'));

    assert.deepEqual(calls.filter(c => c.method === 'archiveSession'), [], 'a refused stop must not archive');
    assert.match(ctx.document.querySelector('[data-notice-id="Archive:vps:r1"]').textContent, /non-claude/);
    assert.equal(r1.archived, 0, 'the session object itself must stay unarchived');
  } finally { ctx.destroy(); }
});

test('stopBeforeArchive: a session a live background job runs is refused before anything is stopped', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = installRecordingApi(ctx, { bgAgentLiveJob: () => Promise.resolve({ known: true, job: { id: 'aaaaaaaa', state: 'working' } }) });
    ctx.window.activePtyIds.add('s1');
    const result = await ctx.window.stopBeforeArchive({ sessionId: 's1' });
    assert.equal(result.ok, false);
    assert.match(result.error, /background job aaaaaaaa is still running this session/);
    assert.deepEqual(calls.map(c => c.method), ['bgAgentLiveJob'], 'the attach tab is not detached');
    assert.equal(ctx.window.activePtyIds.has('s1'), true);
  } finally { ctx.destroy(); }
});

test('stopBeforeArchive: an unknown background-job answer, or a failed check, is refused', async () => {
  for (const impl of [() => Promise.resolve({ known: false, reason: 'cannot read jobs' }), () => Promise.reject(new Error('ipc down'))]) {
    const ctx = setupSidebarDom();
    try {
      installRecordingApi(ctx, { bgAgentLiveJob: impl });
      const result = await ctx.window.stopBeforeArchive({ sessionId: 's1' });
      assert.equal(result.ok, false);
      assert.match(result.error, /cannot tell whether a background job is running this session \((cannot read jobs|ipc down)\)/);
    } finally { ctx.destroy(); }
  }
});

test('project archive-all: a session a live background job runs keeps the whole folder from being archived', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/home/dev/proj', sessions: [localSession('bg1'), localSession('plain1')] };
    const calls = installRecordingApi(ctx, {
      bgAgentLiveJob: (id) => Promise.resolve(id === 'bg1' ? { known: true, job: { id: 'aaaaaaaa', state: 'blocked' } } : { known: true, job: null }),
    });
    ctx.window.cachedAllProjects = [project];
    ctx.window.flashButtonText = () => {};
    ctx.sidebar.renderProjects([project], true);
    const done = headerFor(ctx, project).querySelector('.project-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    await answerChoiceDialog(ctx, { confirm: true });
    await done;
    assert.deepEqual(calls.filter(c => c.method === 'archiveSession'), [], 'no session is archived');
    assert.deepEqual(calls.filter(c => c.method === 'archiveProject'), [], 'nor the folder');
    assert.match(ctx.document.querySelector('[data-notice-id="Archive:local:bg1"]').textContent, /background job aaaaaaaa/);
  } finally { ctx.destroy(); }
});

// ---------------------------------------------------------------------------
// A host that does not answer never blocks Archive (#556)
// ---------------------------------------------------------------------------
const unreachable = () => Promise.resolve({ ok: false, hostUnreachable: true, error: 'no answer within 20s' });

test('stopBeforeArchive: an unreachable host is reported as not stopped, once per host, without refusing', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = installRecordingApi(ctx, { remoteStopSession: unreachable });
    const result = await ctx.window.stopBeforeArchive({ sessionId: 's1', mergedMemberIds: ['s2'], remoteAlias: 'vps', remoteDescriptorSeen: true, remoteMemberDescriptorSeen: { s2: true } });
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result.notStopped), JSON.stringify([{ alias: 'vps', error: 'no answer within 20s' }]));
    assert.equal(calls.filter(c => c.method === 'remoteStopSession').length, 1, 'the host is not asked again for the next member');
  } finally { ctx.destroy(); }
});

test('slug-group archive: sessions on an unreachable host are archived with one notice per host listing sessions', async () => {
  const ctx = setupSidebarDom();
  try {
    const r1 = remoteSession('r1', 'vps', true, { scheduleSlug: 'grp' });
    const r2 = remoteSession('r2', 'vps', true, { scheduleSlug: 'grp' });
    const project = { projectPath: '/home/dev/proj', sessions: [r1, r2] };
    ctx.window.sessionMap.set('r1', r1);
    ctx.window.sessionMap.set('r2', r2);
    const calls = installRecordingApi(ctx, { remoteStopSession: unreachable });
    ctx.sidebar.renderProjects([project], true);
    const button = ctx.document.querySelector('.slug-group').querySelector('.slug-group-archive-btn');
    const done = button.onclick(new ctx.window.MouseEvent('click'));
    assert.equal(button.disabled, true);
    await done;
    assert.deepEqual(calls.filter(c => c.method === 'archiveSession').map(c => c.args[0]).sort(), ['r1', 'r2']);
    const notices = ctx.document.querySelectorAll('#app-notices [role="alert"]');
    assert.equal(notices.length, 1);
    assert.match(notices[0].textContent, /r1.*r2/);
    assert.doesNotMatch(notices[0].textContent, /Archive failed/);
    assert.match(notices[0].textContent, /vps did not answer/);
    assert.equal(button.disabled, false);
  } finally { ctx.destroy(); }
});

test('project archive-all: sessions on an unreachable host are archived with the folder and a notice names the host', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/home/dev/proj', sessions: [remoteSession('r1', 'vps', true)] };
    const calls = installRecordingApi(ctx, { remoteStopSession: unreachable });
    ctx.window.cachedAllProjects = [project];
    ctx.sidebar.renderProjects([project], true);
    const button = headerFor(ctx, project).querySelector('.project-archive-btn');
    const done = button.onclick(new ctx.window.MouseEvent('click'));
    await new Promise(r => setTimeout(r, 0));
    await answerChoiceDialog(ctx, { confirm: true });
    await done;
    assert.deepEqual(calls.filter(c => c.method === 'archiveSession').map(c => c.args[0]), ['r1']);
    assert.equal(calls.filter(c => c.method === 'archiveProject').length, 1);
    const notices = ctx.document.querySelectorAll('#app-notices [role="alert"]');
    assert.equal(notices.length, 1);
    assert.match(notices[0].textContent, /vps did not answer/);
    assert.equal(button.disabled, false);
  } finally { ctx.destroy(); }
});

test('folder archive is refused up front while a row of the folder is still checking its host', async () => {
  const ctx = setupSidebarDom();
  try {
    const r1 = remoteSession('r1', 'vps', true);
    const project = { projectPath: '/home/dev/proj', sessions: [r1] };
    ctx.window.sessionMap.set('r1', r1);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const calls = installRecordingApi(ctx, { remoteStopSession: () => gate.then(() => ({ ok: false, error: 'stop refused' })) });
    ctx.window.cachedAllProjects = [project];
    ctx.sidebar.renderProjects([project], true);
    const rowBtn = ctx.document.querySelector('#si-r1 .session-archive-btn');
    const own = rowBtn.onclick({ stopPropagation() {} });
    await new Promise(r => setTimeout(r, 0));
    const folderBtn = headerFor(ctx, project).querySelector('.project-archive-btn');
    await folderBtn.onclick(new ctx.window.MouseEvent('click'));
    assert.match(ctx.document.querySelector('[role="alert"]').textContent, /archive is still in progress.*Try again when it finishes/);
    assert.equal(calls.filter(c => c.method === 'archiveProject').length, 0);
    assert.equal(calls.filter(c => c.method === 'remoteStopSession').length, 1);
    assert.equal(ctx.document.querySelector('#si-r1 .session-archive-btn').disabled, true);
    release();
    await own;
    assert.equal(calls.filter(c => c.method === 'archiveSession').length, 0);
    assert.equal(ctx.document.querySelector('#si-r1 .session-archive-btn').disabled, false);
  } finally { ctx.destroy(); }
});

test('a re-render keeps the slug-group and folder Archive buttons disabled while they check', async () => {
  const ctx = setupSidebarDom();
  try {
    const r1 = remoteSession('r1', 'vps', true, { scheduleSlug: 'grp' });
    const r2 = remoteSession('r2', 'vps', true, { scheduleSlug: 'grp' });
    const project = { projectPath: '/home/dev/proj', sessions: [r1, r2] };
    ctx.window.sessionMap.set('r1', r1);
    ctx.window.sessionMap.set('r2', r2);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    installRecordingApi(ctx, { remoteStopSession: () => gate.then(() => ({ ok: true })) });
    ctx.sidebar.renderProjects([project], true);
    const done = ctx.document.querySelector('.slug-group').querySelector('.slug-group-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    await new Promise(r => setTimeout(r, 0));
    ctx.sidebar.renderProjects([project], true);
    assert.equal(ctx.document.querySelector('.slug-group').querySelector('.slug-group-archive-btn').disabled, true);
    release();
    await done;
    assert.equal(ctx.document.querySelector('.slug-group').querySelector('.slug-group-archive-btn').disabled, false);
  } finally { ctx.destroy(); }
});

test('folder archive asks an offline host once and shows one notice per host listing all rows', async () => {
  const ctx = setupSidebarDom();
  try {
    const rows = ['r1', 'r2', 'r3'].map(id => remoteSession(id, 'vps', true));
    const project = { projectPath: '/home/dev/proj', sessions: rows };
    const calls = installRecordingApi(ctx, { remoteStopSession: unreachable });
    ctx.window.cachedAllProjects = [project];
    ctx.sidebar.renderProjects([project], true);
    const done = headerFor(ctx, project).querySelector('.project-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    await new Promise(r => setTimeout(r, 0));
    await answerChoiceDialog(ctx, { confirm: true });
    await done;
    assert.equal(calls.filter(c => c.method === 'remoteStopSession').length, 1);
    assert.equal(calls.filter(c => c.method === 'archiveSession').length, 3);
    const notices = ctx.document.querySelectorAll('#app-notices [role="alert"]');
    assert.equal(notices.length, 1);
    assert.match(notices[0].textContent, /r1.*r2.*r3/);
  } finally { ctx.destroy(); }
});

test('folder archive marks every row busy before it starts checking the first one', async () => {
  const ctx = setupSidebarDom();
  try {
    const rows = ['r1', 'r2'].map(id => remoteSession(id, 'vps', true));
    const project = { projectPath: '/home/dev/proj', sessions: rows };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    installRecordingApi(ctx, { remoteStopSession: () => gate.then(() => ({ ok: true })) });
    ctx.window.cachedAllProjects = [project];
    ctx.sidebar.renderProjects([project], true);
    const done = headerFor(ctx, project).querySelector('.project-archive-btn').onclick(new ctx.window.MouseEvent('click'));
    await new Promise(r => setTimeout(r, 0));
    await answerChoiceDialog(ctx, { confirm: true });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(ctx.document.querySelector('#si-r2 .session-archive-btn').disabled, true);
    release();
    await done;
    assert.equal(ctx.document.querySelector('#si-r2 .session-archive-btn').disabled, false);
  } finally { ctx.destroy(); }
});
