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

const { setupSidebarDom } = require('./dom-setup');

function installRecordingApi(ctx, overrides = {}) {
  const calls = [];
  const impls = {
    stopSession: () => Promise.resolve({ ok: true }),
    remoteStopSession: () => Promise.resolve({ ok: true }),
    archiveSession: () => Promise.resolve({ ok: true }),
    deleteSession: () => Promise.resolve({ ok: true, removed: ['x'], subagents: 0 }),
    deleteSessionPreview: () => Promise.resolve({ ok: true, transcripts: 1, subagents: 0, running: false }),
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
    assert.deepEqual(calls.map(c => c.method), ['stopSession']);
    assert.equal(calls[0].args[0], 's1');
    assert.equal(ctx.window.activePtyIds.has('s1'), false);
  } finally { ctx.destroy(); }
});

test('stopBeforeArchive: local session with no PTY calls nothing', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = installRecordingApi(ctx);
    const result = await ctx.window.stopBeforeArchive({ sessionId: 's1' });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, []);
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

test('project archive-all: an alive remote session is stopped on its host, alias named in the confirmation', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/home/dev/proj', sessions: [remoteSession('r1', 'vps', true)] };
    const calls = installRecordingApi(ctx);
    let prompt = null;
    ctx.window.confirm = (m) => { prompt = m; return true; };

    ctx.sidebar.renderProjects([project], true);
    await headerFor(ctx, project).querySelector('.project-archive-btn').onclick(new ctx.window.MouseEvent('click'));

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
    let prompt = null;
    ctx.window.confirm = (m) => { prompt = m; return false; };

    ctx.sidebar.renderProjects([project], true);
    await headerFor(ctx, project).querySelector('.project-archive-btn').onclick(new ctx.window.MouseEvent('click'));

    assert.doesNotMatch(prompt, /vps/, 'a dead remote session is nothing to stop, so it must not be named');
  } finally { ctx.destroy(); }
});

test('project archive-all: a stop refusal skips that session\'s archive and surfaces it; the other proceeds', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/home/dev/proj', sessions: [remoteSession('r1', 'vps', true), localSession('s2')] };
    ctx.window.activePtyIds.add('s2');
    const calls = installRecordingApi(ctx, {
      remoteStopSession: () => Promise.resolve({ ok: false, error: 'pid now belongs to a non-claude process' }),
    });
    ctx.window.confirm = () => true;
    let flashed = null;
    ctx.window.flashButtonText = (btn, text) => { flashed = { btn, text }; };

    ctx.sidebar.renderProjects([project], true);
    await headerFor(ctx, project).querySelector('.project-archive-btn').onclick(new ctx.window.MouseEvent('click'));

    assert.deepEqual(calls.filter(c => c.method === 'archiveSession').map(c => c.args[0]), ['s2'],
      'the refused remote session must not be archived; the local one still proceeds');
    assert.ok(flashed, 'the failure must flash a button');
    assert.equal(flashed.text, 'Failed');
    const failedBtn = ctx.document.getElementById('si-r1').querySelector('.session-archive-btn');
    assert.match(failedBtn.title, /non-claude/, 'the error must be surfaced on the button title');
  } finally { ctx.destroy(); }
});

// ---------------------------------------------------------------------------
// .slug-group-archive-btn
// ---------------------------------------------------------------------------

test('slug-group archive: a stop refusal on one remote session skips it, the other (local) session still archives', async () => {
  const ctx = setupSidebarDom();
  try {
    const r1 = remoteSession('r1', 'vps', true, { slug: 'grp' });
    const s2 = localSession('s2', { slug: 'grp' });
    const project = { projectPath: '/home/dev/proj', sessions: [r1, s2] };
    ctx.window.sessionMap.set('r1', r1);
    ctx.window.sessionMap.set('s2', s2);
    ctx.window.activePtyIds.add('s2');
    const calls = installRecordingApi(ctx, {
      remoteStopSession: () => Promise.resolve({ ok: false, error: 'ssh: connection refused' }),
    });
    let flashed = null;
    ctx.window.flashButtonText = (btn, text) => { flashed = { btn, text }; };

    ctx.sidebar.renderProjects([project], true);
    const group = ctx.document.getElementById('slug-grp');
    assert.ok(group, 'the two same-slug sessions must render as a slug group');
    await group.querySelector('.slug-group-archive-btn').onclick(new ctx.window.MouseEvent('click'));

    assert.deepEqual(calls.filter(c => c.method === 'remoteStopSession').map(c => c.args), [['vps', 'r1']]);
    assert.deepEqual(calls.filter(c => c.method === 'stopSession').map(c => c.args[0]), ['s2']);
    assert.deepEqual(calls.filter(c => c.method === 'archiveSession').map(c => c.args[0]), ['s2'],
      'the refused remote session must not be archived; the local one still proceeds');
    assert.ok(flashed && flashed.text === 'Failed', 'the refusal must flash a button');
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

test('per-session delete: a remote session is never stopped — delete is refused server-side for remote regardless', async () => {
  const ctx = setupSidebarDom();
  try {
    const r1 = remoteSession('r1', 'vps', true);
    ctx.window.sessionMap.set('r1', r1);
    const calls = installRecordingApi(ctx, {
      deleteSession: () => Promise.resolve({ ok: false, error: 'remote sessions are read-only — this build observes them, it does not attach to them' }),
    });

    ctx.sidebar.renderProjects([{ projectPath: '/home/dev/proj', sessions: [r1] }], true);
    const item = ctx.document.getElementById('si-r1');
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
    assert.deepEqual(methods, ['stopSession', 'archiveSession'], 'stop must precede archive');
  } finally { ctx.destroy(); }
});

test('per-session archive toggle: a failed remote stop blocks the archive and flashes the button', async () => {
  const ctx = setupSidebarDom();
  try {
    const r1 = remoteSession('r1', 'vps', true);
    ctx.window.sessionMap.set('r1', r1);
    const calls = installRecordingApi(ctx, {
      remoteStopSession: () => Promise.resolve({ ok: false, error: 'pid now belongs to a non-claude process' }),
    });
    let flashed = null;
    ctx.window.flashButtonText = (btn, text) => { flashed = { btn, text }; };

    ctx.sidebar.renderProjects([{ projectPath: '/home/dev/proj', sessions: [r1] }], true);
    const archiveBtn = ctx.document.getElementById('si-r1').querySelector('.session-archive-btn');
    await archiveBtn.onclick(new ctx.window.MouseEvent('click'));

    assert.deepEqual(calls.filter(c => c.method === 'archiveSession'), [], 'a refused stop must not archive');
    assert.ok(flashed && flashed.text === 'Failed');
    assert.match(archiveBtn.title, /non-claude/, 'the error must be surfaced on the button title');
    assert.equal(r1.archived, 0, 'the session object itself must stay unarchived');
  } finally { ctx.destroy(); }
});
