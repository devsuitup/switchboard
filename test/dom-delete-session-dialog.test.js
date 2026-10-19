// Behavioural coverage for the Delete Session confirmation flow.
//
// The maintainer asked for a styled dialog rather than window.confirm, on the
// grounds that a native prompt blocks the whole renderer and cannot show what
// is about to be lost. These tests drive the real dialog in jsdom: that it
// reports what will be removed, that cancelling deletes nothing, and that
// confirming deletes and cleans up the renderer's own state.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const SESSION = {
  sessionId: 's-top-1',
  name: 'A session worth naming',
  projectPath: '/home/u/proj',
  summary: 'summary',
};

function stubApi(window, overrides = {}) {
  const calls = { deleteSession: [], preview: [] };
  window.api = {
    deleteSessionPreview: (id) => { calls.preview.push(id); return Promise.resolve({ partIds: [id], ...overrides.preview ?? { ok: true, transcripts: 2, subagents: 3, running: false } }); },
    deleteSession: (id) => { calls.deleteSession.push(id); return Promise.resolve(overrides.deleteResult ?? { ok: true, removed: ['x'], subagents: 3 }); },
    stopSession: () => Promise.resolve({ ok: true }),
    archiveSession: () => Promise.resolve({ ok: true }),
    worktreeStatus: () => Promise.resolve({ ok: true, total: 0, dirty: [] }),
  };
  return calls;
}

const tick = () => new Promise(r => setTimeout(r, 0));

test('the merged conversation preview names all three parts before its file count', async () => {
  const ctx = setupSidebarDom();
  try {
    stubApi(ctx.window, { preview: { ok: true, parts: 3, transcripts: 6, subagents: 0 } });
    const p = ctx.sidebar.showDeleteSessionDialog(SESSION);
    await tick();
    assert.equal(ctx.document.querySelector('h3').textContent, `Delete session "${SESSION.name}"?`);
    assert.match(ctx.document.getElementById('dss-status').textContent, /3 parts of this conversation, 6 files on disk/);
    ctx.document.getElementById('dss-cancel').click();
    await p;
  } finally { ctx.destroy(); }
});

test('confirming a merged row forgets every part and destroys every open part tab', async () => {
  const ctx = setupSidebarDom();
  try {
    const session = { ...SESSION, mergedMemberIds: ['stale-renderer-part'] };
    ctx.window._continuationChoices = new Map([SESSION.sessionId, 'b', 'c', 'stale-renderer-part'].map(id => ['continuationChoice:' + id, {}]));
    const calls = stubApi(ctx.window, { preview: { ok: true, partIds: [SESSION.sessionId, 'b', 'c'], parts: 3, transcripts: 3, subagents: 0 } });
    const destroyed = [], dismissed = [];
    ctx.window.destroySession = id => { destroyed.push(id); ctx.window.openSessions.delete(id); };
    ctx.window.dismissDormantSession = id => dismissed.push(id);
    for (const id of [SESSION.sessionId, 'b', 'c', 'stale-renderer-part']) {
      ctx.window.sessionMap.set(id, session);
      ctx.window.pendingSessions.set(id, { session });
      ctx.window.openSessions.set(id, { closed: true });
    }
    const project = makeSampleProject();
    project.sessions = [session];
    ctx.sidebar.renderProjects([project], true);
    ctx.document.getElementById('si-s-top-1').querySelector('.session-delete-btn').click();
    await tick();
    ctx.document.getElementById('dss-confirm').click();
    await tick(); await tick();
    assert.deepEqual(calls.deleteSession, [SESSION.sessionId]);
    for (const id of [SESSION.sessionId, 'b', 'c']) {
      assert.equal(ctx.window.sessionMap.has(id), false, `sessionMap ${id}`);
      assert.equal(ctx.window.pendingSessions.has(id), false, `pendingSessions ${id}`);
      assert.equal(ctx.window.openSessions.has(id), false, `tab ${id}`);
      assert.equal(ctx.window._continuationChoices.has('continuationChoice:' + id), false, `choice ${id}`);
    }
    assert.deepEqual(destroyed.sort(), ['b', 'c', SESSION.sessionId].sort());
    assert.deepEqual(dismissed.sort(), ['b', 'c', SESSION.sessionId].sort());
    assert.equal(ctx.window.sessionMap.has('stale-renderer-part'), true);
    assert.equal(ctx.window.pendingSessions.has('stale-renderer-part'), true);
    assert.equal(ctx.window.openSessions.has('stale-renderer-part'), true);
    assert.equal(ctx.window._continuationChoices.has('continuationChoice:stale-renderer-part'), true);
  } finally { ctx.destroy(); }
});

test('a partial delete forgets only removed parts, refreshes the row and keeps the failure notice', async () => {
  const ctx = setupSidebarDom();
  try {
    const session = { ...SESSION, mergedMemberIds: ['b', 'c'] };
    const error = 'Deleted 1 of 3 parts; EBUSY transcript. Removed: b; remaining: s-top-1, c. Try Delete again.';
    stubApi(ctx.window, {
      preview: { ok: true, partIds: [SESSION.sessionId, 'b', 'c'], parts: 3, transcripts: 3, subagents: 0 },
      deleteResult: { ok: false, error, removedPartIds: ['b'] },
    });
    const destroyed = [], dismissed = [];
    let refreshed = 0;
    ctx.window.destroySession = id => { destroyed.push(id); ctx.window.openSessions.delete(id); };
    ctx.window.dismissDormantSession = id => dismissed.push(id);
    ctx.window.loadProjects = () => {
      refreshed++;
      assert.equal(ctx.window.sessionMap.has('b'), false);
      assert.equal(ctx.window.pendingSessions.has('b'), false);
      assert.equal(ctx.window.openSessions.has('b'), false);
      const project = makeSampleProject();
      project.sessions = [{ ...session, mergedMemberIds: ['c'] }];
      ctx.sidebar.renderProjects([project], true);
    };
    for (const id of [SESSION.sessionId, 'b', 'c']) {
      ctx.window.sessionMap.set(id, session);
      ctx.window.pendingSessions.set(id, { session });
      ctx.window.openSessions.set(id, { closed: true });
    }
    const project = makeSampleProject();
    project.sessions = [session];
    ctx.sidebar.renderProjects([project], true);
    ctx.document.getElementById('si-s-top-1').querySelector('.session-delete-btn').click();
    await tick();
    ctx.document.getElementById('dss-confirm').click();
    await tick(); await tick();
    assert.equal(ctx.window.sessionMap.has('b'), false);
    assert.equal(ctx.window.pendingSessions.has('b'), false);
    assert.equal(ctx.window.openSessions.has('b'), false);
    assert.deepEqual(destroyed, ['b']);
    assert.deepEqual(dismissed, ['b']);
    for (const id of [SESSION.sessionId, 'c']) {
      assert.equal(ctx.window.sessionMap.has(id), true, id);
      assert.equal(ctx.window.pendingSessions.has(id), true, id);
      assert.equal(ctx.window.openSessions.has(id), true, id);
    }
    assert.equal(refreshed, 1);
    assert.ok(ctx.document.getElementById('si-s-top-1'));
    assert.ok(ctx.document.querySelector('[role="alert"]').textContent.includes(error));
  } finally { ctx.destroy(); }
});

test('a partial delete refreshes even when only subagents were removed', async () => {
  const ctx = setupSidebarDom();
  try {
    const error = 'Deleted 0 of 1 parts; EBUSY transcript. Try Delete again.';
    stubApi(ctx.window, { deleteResult: { ok: false, error, removedPartIds: [] } });
    let refreshed = 0;
    ctx.window.loadProjects = () => { refreshed++; };
    ctx.window.sessionMap.set(SESSION.sessionId, SESSION);
    ctx.window.pendingSessions.set(SESSION.sessionId, { session: SESSION });
    ctx.sidebar.renderProjects([makeSampleProject()], true);
    ctx.document.getElementById('si-s-top-1').querySelector('.session-delete-btn').click();
    await tick();
    ctx.document.getElementById('dss-confirm').click();
    await tick(); await tick();
    assert.equal(refreshed, 1);
    assert.equal(ctx.window.sessionMap.has(SESSION.sessionId), true);
    assert.equal(ctx.window.pendingSessions.has(SESSION.sessionId), true);
    assert.ok(ctx.document.querySelector('[role="alert"]').textContent.includes(error));
  } finally { ctx.destroy(); }
});

test('the dialog names the session, the project, and what will be removed', async () => {
  const ctx = setupSidebarDom();
  try {
    stubApi(ctx.window);
    const p = ctx.sidebar.showDeleteSessionDialog(SESSION);
    await tick();

    const dialog = ctx.document.querySelector('.new-session-dialog');
    assert.ok(dialog, 'a styled dialog must be shown');
    assert.match(dialog.querySelector('h3').textContent, /A session worth naming/);
    assert.match(dialog.textContent, /Archive/, 'must point at the non-destructive alternative');
    assert.match(dialog.textContent, /cannot be undone/);

    const status = ctx.document.getElementById('dss-status');
    assert.match(status.textContent, /\/home\/u\/proj/, 'the project must be stated');
    assert.match(status.textContent, /2 files on disk/);
    assert.match(status.textContent, /3 subagent transcripts/);

    ctx.document.getElementById('dss-cancel').click();
    assert.equal(await p, false);
  } finally { ctx.destroy(); }
});

test('a session that never started is described as having no transcript', async () => {
  const ctx = setupSidebarDom();
  try {
    stubApi(ctx.window, { preview: { ok: true, transcripts: 0, subagents: 0, running: false } });
    const p = ctx.sidebar.showDeleteSessionDialog(SESSION);
    await tick();
    assert.match(ctx.document.getElementById('dss-status').textContent,
      /never started/, 'the placeholder case must be explained, not shown as "0 files"');
    ctx.document.getElementById('dss-cancel').click();
    await p;
  } finally { ctx.destroy(); }
});

test('a running session is flagged in the dialog', async () => {
  const ctx = setupSidebarDom();
  try {
    stubApi(ctx.window, { preview: { ok: true, transcripts: 1, subagents: 0, running: true } });
    const p = ctx.sidebar.showDeleteSessionDialog(SESSION);
    await tick();
    assert.match(ctx.document.getElementById('dss-status').textContent, /still running/);
    ctx.document.getElementById('dss-cancel').click();
    await p;
  } finally { ctx.destroy(); }
});

test('Escape and overlay-click both cancel, like the worktree dialog', async () => {
  for (const how of ['escape', 'overlay']) {
    const ctx = setupSidebarDom();
    try {
      stubApi(ctx.window);
      const p = ctx.sidebar.showDeleteSessionDialog(SESSION);
      await tick();
      if (how === 'escape') {
        ctx.document.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        ctx.document.querySelector('.new-session-overlay').click();
      }
      assert.equal(await p, false, `${how} must cancel`);
      assert.equal(ctx.document.querySelector('.new-session-overlay'), null, 'and close the dialog');
    } finally { ctx.destroy(); }
  }
});

test('confirming resolves the preview parts and closes the dialog', async () => {
  const ctx = setupSidebarDom();
  try {
    stubApi(ctx.window);
    const p = ctx.sidebar.showDeleteSessionDialog(SESSION);
    await tick();
    ctx.document.getElementById('dss-confirm').click();
    assert.deepEqual(Array.from((await p).partIds), [SESSION.sessionId]);
    assert.equal(ctx.document.querySelector('.new-session-overlay'), null);
  } finally { ctx.destroy(); }
});

test('a failed preview rejects with its reason before showing a dialog', async () => {
  const ctx = setupSidebarDom();
  try {
    stubApi(ctx.window, { preview: { ok: false, error: 'boom' } });
    await assert.rejects(ctx.sidebar.showDeleteSessionDialog(SESSION), /boom/);
    assert.equal(ctx.document.querySelector('.new-session-overlay'), null);
  } finally { ctx.destroy(); }
});

// --- the button on a rendered card ---

test('the card button opens the dialog; cancelling deletes nothing', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = stubApi(ctx.window);
    // rebindSidebarEvents only wires an item it can resolve via sessionMap
    // (sidebar.js:823), so a card is inert without it — as the real app populates.
    ctx.window.sessionMap.set('s-top-1', SESSION);
    ctx.sidebar.renderProjects([makeSampleProject()], true);
    const item = ctx.document.getElementById('si-s-top-1');
    assert.ok(item, 'the session card must render');
    const btn = item.querySelector('.session-delete-btn');
    assert.ok(btn, 'the card must carry a delete button');

    btn.click();
    await tick();
    assert.ok(ctx.document.querySelector('#dss-confirm'), 'the dialog must open');
    ctx.document.getElementById('dss-cancel').click();
    await tick();
    assert.deepEqual(calls.deleteSession, [], 'cancelling must not delete');
  } finally { ctx.destroy(); }
});

test('confirming from the card deletes and forgets the session in the renderer', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = stubApi(ctx.window);
    ctx.window.pendingSessions.set('s-top-1', { session: SESSION });
    ctx.window.sessionMap.set('s-top-1', SESSION);

    ctx.sidebar.renderProjects([makeSampleProject()], true);
    ctx.document.getElementById('si-s-top-1').querySelector('.session-delete-btn').click();
    await tick();
    ctx.document.getElementById('dss-confirm').click();
    await tick(); await tick();

    assert.deepEqual(calls.deleteSession, ['s-top-1'], 'the delete must reach the main process');
    // Otherwise the sidebar re-injects the card from pendingSessions on reload.
    assert.equal(ctx.window.pendingSessions.has('s-top-1'), false, 'pending entry must be forgotten');
    assert.equal(ctx.window.sessionMap.has('s-top-1'), false, 'sessionMap entry must be forgotten');
  } finally { ctx.destroy(); }
});

test('the card sends exactly the parts shown in the preview through the preload bridge', async () => {
  const ctx = setupSidebarDom();
  try {
    const vm = require('node:vm');
    const fs = require('node:fs');
    const path = require('node:path');
    const calls = [];
    const preview = { ok: true, partIds: [SESSION.sessionId, 'shown-part'], parts: 2, transcripts: 2, subagents: 0 };
    const context = vm.createContext({ process: { platform: process.platform, argv: [] }, require: id => {
      assert.equal(id, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (_name, api) => { ctx.window.api = api; } },
        ipcRenderer: {
          on() {},
          invoke: async (name, ...args) => {
            if (name === 'delete-session-preview') return preview;
            if (name === 'delete-session') { calls.push(args); return { ok: true }; }
            return {};
          },
        },
        webUtils: {},
      };
    } });
    const filename = path.join(__dirname, '../preload.js');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const session = { ...SESSION, mergedMemberIds: ['stale-renderer-part'] };
    ctx.window.sessionMap.set(SESSION.sessionId, session);
    const project = makeSampleProject();
    project.sessions = [session];
    ctx.sidebar.renderProjects([project], true);
    ctx.document.getElementById('si-s-top-1').querySelector('.session-delete-btn').click();
    await tick();
    session.mergedMemberIds = ['changed-after-preview'];
    ctx.document.getElementById('dss-confirm').click();
    await tick(); await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), [SESSION.sessionId, preview.partIds]);
  } finally { ctx.destroy(); }
});

for (const failure of ['refused', 'rejected', 'unavailable']) {
  test(`a ${failure} preview shows the failure notice before any confirmation or stop`, async () => {
    const ctx = setupSidebarDom();
    try {
      const calls = stubApi(ctx.window);
      let stopped = false;
      ctx.window.api.stopSession = async () => { stopped = true; return { ok: true }; };
      ctx.window.api.deleteSessionPreview = failure === 'unavailable' ? undefined : async () => {
        if (failure === 'rejected') throw new Error('preview disconnected');
        return { ok: false, error: 'remote transcript is read-only' };
      };
      ctx.window.sessionMap.set(SESSION.sessionId, SESSION);
      ctx.sidebar.renderProjects([makeSampleProject()], true);
      ctx.document.getElementById('si-s-top-1').querySelector('.session-delete-btn').click();
      await tick(); await tick();
      assert.equal(ctx.document.querySelector('.new-session-overlay'), null);
      const notice = ctx.document.querySelector('[role="alert"]');
      assert.ok(notice);
      assert.match(notice.textContent, failure === 'unavailable' ? /unavailable/i : failure === 'rejected' ? /preview disconnected/ : /remote transcript is read-only/);
      assert.equal(stopped, false);
      assert.deepEqual(calls.deleteSession, []);
      assert.equal(ctx.window.sessionMap.has(SESSION.sessionId), true);
    } finally { ctx.destroy(); }
  });
}
