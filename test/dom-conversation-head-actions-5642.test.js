'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppFunctions } = require('./app-source');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function setup(t, overrides = {}) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const session = {
    sessionId: 'A', headSessionId: 'B', mergedMemberIds: ['B'],
    projectPath: '/project', summary: 'Conversation', modified: new Date().toISOString(),
    ...overrides,
  };
  const project = makeSampleProject({ projectPath: session.projectPath, sessions: [session] });
  ctx.window.sessionMap.set('A', session);
  ctx.window.cachedProjects = [project];
  ctx.window.cachedAllProjects = [project];
  ctx.window.refreshSidebar = () => {};
  ctx.sidebar.renderProjects([project], true);
  return { ...ctx, session, project };
}

for (const [label, selector, verb] of [
  ['Fork', '.session-fork-btn', 'forkSession'],
  ['Resume with config', '.session-launch-config-btn', 'showResumeSessionDialog'],
  ['View messages', '.session-jsonl-btn', 'showJsonlViewer'],
]) {
  test(`${label} on a merged row receives its head and retains row metadata`, async t => {
    const ctx = setup(t);
    const calls = [];
    ctx.window[verb] = (...args) => calls.push(args);
    await ctx.document.querySelector(`#si-A ${selector}`).onclick({ stopPropagation() {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].sessionId, 'B');
    assert.deepEqual(Array.from(calls[0][0].mergedMemberIds), ['A']);
    assert.equal(calls[0][0].summary, ctx.session.summary);
    assert.equal(calls[0][0].projectPath, ctx.session.projectPath);
    if (verb === 'forkSession') assert.equal(calls[0][1], ctx.project);
    assert.equal(ctx.window.sessionMap.get('A').sessionId, 'A');
  });

  test(`${label} without headSessionId falls back to its session id`, async t => {
    const ctx = setup(t, { headSessionId: undefined });
    const calls = [];
    ctx.window[verb] = target => calls.push(target);
    await ctx.document.querySelector(`#si-A ${selector}`).onclick({ stopPropagation() {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, 'A');
    assert.deepEqual(Array.from(calls[0].mergedMemberIds), ['B']);
  });
}

function resumeSetup(t) {
  const ctx = setup(t);
  ctx.evalPublic('resume-guard.js');
  ctx.evalPublic('setting-defaults.js');
  ctx.evalPublic('dialogs.js');
  const checked = [], spawned = [], shown = [];
  Object.assign(ctx.window, {
    restoringWorkingSet: false, sessionOpenedOutsideRestore: false,
    showSession: id => shown.push(id), schedulePersistWorkingSet() {},
    createTerminalEntry: () => ({ initialSize: { cols: 80, rows: 24 }, terminal: { write() {} } }),
    forgetSessionExit() {}, syncPtySizeAfterOpen() {}, setSessionSandboxed() {},
  });
  Object.assign(ctx.window.api, {
    getEffectiveSettings: async () => ({}),
    getSessionContinuations: async () => ({ candidates: [], unresolved: false }),
    getSessionsLiveElsewhere: async ids => { checked.push(Array.from(ids)); return { A: { pid: 4242, cwd: '/elsewhere' } }; },
    getSessionLiveElsewhere: async () => null,
    openTerminal: async id => { spawned.push(id); return { ok: true }; },
  });
  loadAppFunctions(ctx.context, {
    functions: ['openSession', 'openSessionNow', 'beginPtyOpen', 'settlePtyOpen', 'dormantRowIds', 'syncDormantRow', 'clearDormantRow', 'indexedRowOf'],
    declarations: ['restoreRunDepth', 'openingSessions', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'continuationRetryCancelled',
      'ptyGenerations', 'pendingOpens', 'dormantWorkingSet', 'restoreMode', 'restoreInFlight'],
  });
  return { ctx, checked, spawned, shown, resume: async () => {
    ctx.document.querySelector('#si-A .session-launch-config-btn').onclick({ stopPropagation() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(ctx.document.querySelector('.new-session-start-btn'));
    ctx.document.querySelector('.new-session-start-btn').click();
    await new Promise(resolve => setImmediate(resolve));
  }, settled: () => Promise.all(ctx.read('[...openingSessions.values()].map(open => open.promise)')) };
}

test('Resume with config goes through the dialog and openSession and warns about the live root', async t => {
  const h = resumeSetup(t);
  await h.resume();
  const warning = h.ctx.document.querySelector('.choice-dialog-overlay');
  assert.ok(warning, 'the live root must show a warning before resuming the head');
  assert.match(warning.textContent, /pid 4242/);
  assert.match(warning.textContent, /"Conversation" is already running/);
  assert.equal(warning.querySelector('h2').textContent, 'Session running elsewhere');
  assert.equal(warning.querySelector('.choice-dialog-confirm').textContent, 'Resume anyway');
  assert.ok(warning.querySelector('.choice-dialog-confirm').classList.contains('delete-worktree-confirm-btn'));
  assert.equal(h.ctx.document.activeElement, warning.querySelector('.choice-dialog-cancel'));
  assert.deepEqual(h.checked, [['B', 'A']]);
  h.ctx.document.querySelector('.choice-dialog-cancel').click();
  await h.settled();
  assert.deepEqual(h.spawned, []);
});

test('Resume with config reuses a non-closed root tab instead of opening a second tab', async t => {
  const h = resumeSetup(t);
  h.ctx.window.openSessions.set('A', { closed: false });
  await h.resume();
  await h.settled();
  assert.deepEqual(h.shown, ['A']);
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.checked, []);
});

test('Resume with config restores a dormant root through openSession', async t => {
  const h = resumeSetup(t);
  h.ctx.read("dormantWorkingSet.set('A', { item: { sessionId: 'A' }, index: 0 })");
  const checked = [];
  h.ctx.window.api.getSessionLiveElsewhere = async id => { checked.push(id); return null; };
  h.ctx.window.api.getSessionsLiveElsewhere = async ids => { checked.push(...ids); return {}; };
  await h.resume();
  await h.settled();
  assert.ok(checked.includes('A'));
  assert.deepEqual(h.spawned, ['A']);
  assert.equal(h.ctx.read("dormantWorkingSet.has('A')"), false);
});

test('a remote merged row without an attach target opens messages of its head', t => {
  const ctx = setup(t, { remoteAlias: 'host', remoteAttachable: false });
  const viewed = [];
  ctx.window.showJsonlViewer = session => viewed.push(session.sessionId);
  ctx.document.getElementById('si-A').click();
  assert.deepEqual(viewed, ['B']);
});

test('Pin and Unpin send the desired conversation value through its root', async t => {
  const ctx = setup(t);
  const pinned = [];
  ctx.window.api.setStar = async (id, value) => { pinned.push([id, value]); return { starred: Number(value) }; };
  await ctx.document.querySelector('#si-A .session-pin').onclick({ stopPropagation() {} });
  assert.deepEqual(pinned, [['A', true]]);
  assert.equal(ctx.session.starred, 1);
  await ctx.document.querySelector('#si-A .session-pin').onclick({ stopPropagation() {} });
  assert.deepEqual(pinned, [['A', true], ['A', false]]);
  assert.equal(ctx.session.starred, 0);
});

test('Rename on a merged row still targets its root', async t => {
  const ctx = setup(t);
  const renamed = [];
  let saved;
  const saving = new Promise(resolve => { saved = resolve; });
  ctx.window.api.renameSession = async (id, name) => { renamed.push([id, name]); saved(); };
  ctx.document.querySelector('#si-A .session-summary').ondblclick({ stopPropagation() {} });
  const input = ctx.document.querySelector('#si-A .session-rename-input');
  input.value = 'New name';
  input.blur();
  await saving;
  assert.deepEqual(renamed, [['A', 'New name']]);
});

test('Archive on a merged row keeps the archived flag on its root', async t => {
  const ctx = setup(t);
  const archived = [];
  ctx.window.api.archiveSession = async (id, value) => { archived.push([id, value]); return { ok: true }; };
  await ctx.document.querySelector('#si-A .session-archive-btn').onclick({ stopPropagation() {} });
  assert.deepEqual(archived, [['A', 1]]);
});

for (const background of [false, true]) {
  test(`Agents Transcript keeps the job session when its ${background ? 'daemon result' : 'interactive entry'} resolves to a merged row`, async t => {
    const ctx = setup(t);
    ctx.evalPublic('agents-view.js');
    const viewed = [];
    const daemonCalls = [];
    ctx.window.showJsonlViewer = session => viewed.push(session.sessionId);
    ctx.window.api.bgAgentVerb = async (...args) => { daemonCalls.push(args); return { ok: true, sessionId: 'A' }; };
    await ctx.window.runAgentVerb('transcript', {
      id: background ? 'job-1' : null, sessionId: 'A',
      kind: background ? 'background' : 'interactive', cwd: '/project',
    });
    assert.deepEqual(viewed, ['A']);
    assert.deepEqual(daemonCalls, background ? [['transcript', 'job-1']] : []);
    assert.equal(ctx.session.sessionId, 'A');
  });
}

for (const scheduled of [false, true]) {
  test(`two ${scheduled ? 'scheduled runs share a group' : 'interactive sessions with the same slug remain separate'}`, t => {
    const ctx = setup(t);
    const sessions = ['one', 'two'].map(sessionId => ({
      sessionId, summary: sessionId, modified: new Date().toISOString(),
      slug: 'x', ...(scheduled ? { scheduleSlug: 'nightly' } : {}),
    }));
    ctx.sidebar.renderProjects([makeSampleProject({ sessions })], true);
    const groups = ctx.document.querySelectorAll('.slug-group');
    assert.equal(groups.length, scheduled ? 1 : 0);
    assert.equal(ctx.document.querySelectorAll('.session-item:not([data-subagent])').length, 2);
    if (scheduled) assert.equal(groups[0].querySelectorAll('.session-item').length, 2);
  });
}
