// The folder archive button: the dialog, the all-or-nothing stop, the
// archive-project IPC, and the alias-aware worktree nesting it relies on.
// See .ai/contexts/session-cache.md ("Archived projects").

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject, answerChoiceDialog } = require('./dom-setup');

const SCHEDULE_A = '/p/.claude/commands/schedule-a.md';

function installApi(ctx, overrides = {}) {
  const calls = [];
  const impls = {
    getProjectArchivePlan: () => Promise.resolve({ schedules: [] }),
    archiveProject: () => Promise.resolve({ ok: true, disabled: [], failed: [] }),
    stopSession: () => Promise.resolve({ ok: true }),
    remoteStopSession: () => Promise.resolve({ ok: true }),
    archiveSession: () => Promise.resolve({ archived: 1 }),
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

function session(id, extra = {}) {
  return { sessionId: id, name: id, summary: id, modified: '2026-05-22T10:00:00Z', archived: 0, ...extra };
}

function remote(id, alias, extra = {}) {
  return session(id, { remoteAlias: alias, remoteDescriptorSeen: true, ...extra });
}

function render(ctx, projects, rendered = projects) {
  ctx.window.cachedAllProjects = projects;
  ctx.sidebar.renderProjects(rendered, true);
}

function archiveButton(ctx, projectPath) {
  const header = ctx.document.getElementById('ph-' + ctx.sidebar.folderId(projectPath));
  assert.ok(header, 'the project header must render');
  const btn = header.querySelector('.project-archive-btn');
  assert.ok(btn, 'the archive button must render');
  return btn;
}

async function clickArchive(ctx, projectPath, answer) {
  const done = archiveButton(ctx, projectPath).onclick(new ctx.window.MouseEvent('click'));
  const overlay = answer ? await answerChoiceDialog(ctx, answer) : null;
  await done;
  return overlay;
}

// Arguments are built in the jsdom realm: compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const named = (calls, method) => calls.filter(c => c.method === method);
const archivedIds = (calls) => named(calls, 'archiveSession').map(c => c.args[0]);

function boxIds(ctx) {
  return [...ctx.document.querySelectorAll('.modal-overlay input[type="checkbox"]')].map(b => b.dataset.choiceId);
}

test('archive folder: both boxes archive the sessions, then archive the folder with its schedules', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject({ projectPath: '/p', folder: '-p' });
    const calls = installApi(ctx, {
      getProjectArchivePlan: () => Promise.resolve({ schedules: [{ name: 'a', filePath: SCHEDULE_A, disableable: true }] }),
    });
    render(ctx, [project]);
    await clickArchive(ctx, '/p', { confirm: true });

    assert.deepEqual(archivedIds(calls), ['s-top-1']);
    const archive = named(calls, 'archiveProject');
    assert.equal(archive.length, 1);
    assert.deepEqual(plain(archive[0].args), [[{ projectPath: '/p', folderKey: '-p' }], { disableSchedules: [SCHEDULE_A] }]);
    const methods = calls.map(c => c.method);
    assert.ok(methods.lastIndexOf('archiveSession') < methods.indexOf('archiveProject'), 'sessions are archived before the folder');
  } finally { ctx.destroy(); }
});

test('archive folder: one refused stop archives nothing at all', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/p', folder: '-p', sessions: [remote('r1', 'vps'), session('s2')] };
    ctx.window.activePtyIds.add('s2');
    const calls = installApi(ctx, { remoteStopSession: () => Promise.resolve({ ok: false, error: 'refused' }) });
    render(ctx, [project]);
    await clickArchive(ctx, '/p', { confirm: true });

    assert.deepEqual(archivedIds(calls), []);
    assert.deepEqual(named(calls, 'archiveProject'), []);
  } finally { ctx.destroy(); }
});

test('archive folder: with the sessions box unticked nothing is stopped or archived, the folder still is', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/p', folder: '-p', sessions: [session('s1')] };
    ctx.window.activePtyIds.add('s1');
    const calls = installApi(ctx, {
      getProjectArchivePlan: () => Promise.resolve({ schedules: [{ name: 'a', filePath: SCHEDULE_A, disableable: true }] }),
    });
    render(ctx, [project]);
    await clickArchive(ctx, '/p', { confirm: true, uncheck: ['archiveSessions'] });

    assert.deepEqual(named(calls, 'stopSession'), []);
    assert.deepEqual(archivedIds(calls), []);
    assert.equal(named(calls, 'archiveProject').length, 1);
  } finally { ctx.destroy(); }
});

test('archive folder: no schedule box without a disableable schedule; a linked one is named as staying enabled', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/p', folder: '-p', sessions: [session('s1')] };
    installApi(ctx, {
      getProjectArchivePlan: () => Promise.resolve({ schedules: [{ name: 'b', filePath: '/p/x', disableable: false, reason: 'linked file or directory' }] }),
    });
    render(ctx, [project]);
    const done = archiveButton(ctx, '/p').onclick(new ctx.window.MouseEvent('click'));
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(boxIds(ctx), ['archiveSessions']);
    assert.match(ctx.document.querySelector('.modal-overlay').textContent, /b stays enabled: linked file or directory/);
    await answerChoiceDialog(ctx, { confirm: false });
    await done;
  } finally { ctx.destroy(); }
});

test('archive folder: a folder without sessions still opens the dialog and is archived', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/p', folder: '-p', sessions: [] };
    const calls = installApi(ctx);
    render(ctx, [project]);
    const overlay = await clickArchive(ctx, '/p', { confirm: true });

    assert.ok(overlay, 'the dialog must open');
    assert.equal(named(calls, 'archiveProject').length, 1);
  } finally { ctx.destroy(); }
});

test('archive folder: Cancel calls nothing but the plan', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/p', folder: '-p', sessions: [session('s1')] };
    ctx.window.activePtyIds.add('s1');
    const calls = installApi(ctx);
    render(ctx, [project]);
    await clickArchive(ctx, '/p', { confirm: false });

    assert.deepEqual(calls.map(c => c.method), ['getProjectArchivePlan']);
  } finally { ctx.destroy(); }
});

test('archive folder: with the schedules box unticked no schedule is disabled', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/p', folder: '-p', sessions: [session('s1')] };
    const calls = installApi(ctx, {
      getProjectArchivePlan: () => Promise.resolve({ schedules: [{ name: 'a', filePath: SCHEDULE_A, disableable: true }] }),
    });
    render(ctx, [project]);
    await clickArchive(ctx, '/p', { confirm: true, uncheck: ['disableSchedules'] });

    assert.deepEqual(plain(named(calls, 'archiveProject')[0].args[1]), { disableSchedules: [] });
  } finally { ctx.destroy(); }
});

test('archive folder: the schedules box starts from the remembered answer', async () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.localStorage.setItem('archiveFolder.disableSchedules', '0');
    const project = { projectPath: '/p', folder: '-p', sessions: [session('s1')] };
    installApi(ctx, {
      getProjectArchivePlan: () => Promise.resolve({ schedules: [{ name: 'a', filePath: SCHEDULE_A, disableable: true }] }),
    });
    render(ctx, [project]);
    const done = archiveButton(ctx, '/p').onclick(new ctx.window.MouseEvent('click'));
    await new Promise(r => setTimeout(r, 0));
    const box = ctx.document.querySelector('.modal-overlay input[data-choice-id="disableSchedules"]');
    assert.ok(box, 'the schedules box must render');
    assert.equal(box.checked, false);
    await answerChoiceDialog(ctx, { confirm: false });
    await done;
  } finally { ctx.destroy(); }
});

const WT = '/r/.claude/worktrees/w';

test('archive folder: the worktrees of the folder are archived with it', async () => {
  const ctx = setupSidebarDom();
  try {
    const parent = { projectPath: '/r', folder: '-r', sessions: [session('a')] };
    const child = { projectPath: WT, folder: '-r--claude-worktrees-w', sessions: [session('c')] };
    const calls = installApi(ctx);
    render(ctx, [parent, child]);
    await clickArchive(ctx, '/r', { confirm: true });

    assert.deepEqual(archivedIds(calls).sort(), ['a', 'c']);
    assert.deepEqual(plain(named(calls, 'archiveProject')[0].args[0]), [
      { projectPath: '/r', folderKey: '-r' },
      { projectPath: WT, folderKey: '-r--claude-worktrees-w' },
    ]);
  } finally { ctx.destroy(); }
});

test('archive folder: a refused stop in a worktree archives nothing, and the folder\'s running session was stopped', async () => {
  const ctx = setupSidebarDom();
  try {
    const parent = { projectPath: '/r', folder: '-r', sessions: [session('a')] };
    const child = { projectPath: WT, folder: '-r--claude-worktrees-w', sessions: [session('c')] };
    ctx.window.activePtyIds.add('a');
    ctx.window.activePtyIds.add('c');
    const calls = installApi(ctx, {
      stopSession: (id) => Promise.resolve(id === 'c' ? { ok: false, error: 'refused' } : { ok: true }),
    });
    render(ctx, [parent, child]);
    await clickArchive(ctx, '/r', { confirm: true });

    assert.deepEqual(archivedIds(calls), []);
    assert.deepEqual(named(calls, 'archiveProject'), []);
    assert.ok(named(calls, 'stopSession').some(c => c.args[0] === 'a'), 'the folder\'s own session must have been stopped');
  } finally { ctx.destroy(); }
});

test('archive folder: while indexing, an alert and nothing else', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/p', folder: '-p', sessions: [session('s1')] };
    const calls = installApi(ctx, { getProjectArchivePlan: () => Promise.resolve({ indexing: true }) });
    let alerted = null;
    ctx.window.alert = (m) => { alerted = m; };
    render(ctx, [project]);
    await clickArchive(ctx, '/p');

    assert.match(alerted || '', /still indexing/);
    assert.equal(ctx.document.querySelector('.modal-overlay'), null);
    assert.deepEqual(calls.map(c => c.method), ['getProjectArchivePlan']);
  } finally { ctx.destroy(); }
});

test('worktree nesting: a worktree of another host is drawn at top level, not inside the local folder', () => {
  const ctx = setupSidebarDom();
  try {
    const parent = { projectPath: '/r', folder: '-r', remoteAlias: null, sessions: [session('a')] };
    const child = { projectPath: WT, folder: 'planificator::-r--claude-worktrees-w', remoteAlias: 'planificator', sessions: [remote('c', 'planificator')] };
    render(ctx, [parent, child]);

    const parentGroup = ctx.document.getElementById(ctx.sidebar.folderId('/r'));
    assert.ok(parentGroup);
    assert.equal(parentGroup.querySelector('.worktree-group'), null, 'nothing may nest under the local folder');
    const header = ctx.document.getElementById('ph-' + ctx.sidebar.folderId(WT));
    assert.ok(header && header.classList.contains('project-header'), 'the worktree must be drawn as a top-level group');
  } finally { ctx.destroy(); }
});

test('worktree nesting: a worktree whose repository is not listed is drawn at top level', () => {
  const ctx = setupSidebarDom();
  try {
    render(ctx, [{ projectPath: WT, folder: '-r--claude-worktrees-w', sessions: [session('c')] }]);
    const header = ctx.document.getElementById('ph-' + ctx.sidebar.folderId(WT));
    assert.ok(header && header.classList.contains('project-header'));
  } finally { ctx.destroy(); }
});

test('worktree nesting: a worktree whose repository is hidden on its host stays hidden', () => {
  const ctx = setupSidebarDom();
  try {
    render(ctx, [{ projectPath: WT, folder: 'box::-r--claude-worktrees-w', remoteAlias: 'box', hiddenRepository: true, sessions: [remote('c', 'box')] }]);
    assert.equal(ctx.document.getElementById('ph-' + ctx.sidebar.folderId(WT)), null);
    assert.equal(ctx.document.getElementById(ctx.sidebar.folderId(WT)), null);
  } finally { ctx.destroy(); }
});

test('archive folder: a worktree of another host at the same path is not archived with the folder', async () => {
  const ctx = setupSidebarDom();
  try {
    const parent = { projectPath: '/r', folder: '-r', sessions: [session('a')] };
    const child = { projectPath: WT, folder: 'planificator::-r--claude-worktrees-w', remoteAlias: 'planificator', sessions: [remote('c', 'planificator')] };
    const calls = installApi(ctx);
    render(ctx, [parent, child]);
    await clickArchive(ctx, '/r', { confirm: true });

    assert.deepEqual(plain(named(calls, 'archiveProject')[0].args[0]), [{ projectPath: '/r', folderKey: '-r' }]);
    assert.deepEqual(archivedIds(calls), ['a']);
    assert.deepEqual(named(calls, 'remoteStopSession'), []);
  } finally { ctx.destroy(); }
});

test('archive folder: the sessions box starts from the remembered answer', async () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.localStorage.setItem('archiveFolder.archiveSessions', '0');
    installApi(ctx);
    render(ctx, [{ projectPath: '/p', folder: '-p', sessions: [session('s1')] }]);
    const done = archiveButton(ctx, '/p').onclick(new ctx.window.MouseEvent('click'));
    await new Promise(r => setTimeout(r, 0));
    const box = ctx.document.querySelector('.modal-overlay input[data-choice-id="archiveSessions"]');
    assert.ok(box, 'the sessions box must render');
    assert.equal(box.checked, false);
    await answerChoiceDialog(ctx, { confirm: false });
    await done;
  } finally { ctx.destroy(); }
});

test('archive folder: an archive that failed after disabling schedules names them', async () => {
  const ctx = setupSidebarDom();
  try {
    installApi(ctx, { archiveProject: () => Promise.resolve({ error: 'SQLITE_BUSY', disabled: ['nightly'] }) });
    let alerted = null;
    ctx.window.alert = (m) => { alerted = m; };
    render(ctx, [{ projectPath: '/p', folder: '-p', sessions: [session('s1')] }]);
    await clickArchive(ctx, '/p', { confirm: true });

    assert.match(alerted || '', /could not be archived: SQLITE_BUSY/);
    assert.match(alerted || '', /turned off: nightly/);
  } finally { ctx.destroy(); }
});

test('worktree nesting: a same-host worktree still nests under its folder', () => {
  const ctx = setupSidebarDom();
  try {
    const parent = { projectPath: '/r', folder: '-r', sessions: [session('a')] };
    const child = { projectPath: WT, folder: '-r--claude-worktrees-w', sessions: [session('c')] };
    render(ctx, [parent, child]);
    const parentGroup = ctx.document.getElementById(ctx.sidebar.folderId('/r'));
    assert.ok(parentGroup.querySelector('#' + ctx.sidebar.folderId(WT) + '.worktree-group'));
    assert.equal(parentGroup.querySelector('.worktree-name').textContent, 'w');
  } finally { ctx.destroy(); }
});

test('archive folder: groups and sessions come from every cached session, not the search projection', async () => {
  const ctx = setupSidebarDom();
  try {
    const parent = { projectPath: '/r', folder: '-r', sessions: [session('a'), session('b')] };
    const child = { projectPath: WT, folder: '-r--claude-worktrees-w', sessions: [session('c')] };
    const calls = installApi(ctx);
    render(ctx, [parent, child], [{ ...parent, sessions: [parent.sessions[0]] }]);
    const done = archiveButton(ctx, '/r').onclick(new ctx.window.MouseEvent('click'));
    await new Promise(r => setTimeout(r, 0));
    const label = ctx.document.querySelector('.modal-overlay input[data-choice-id="archiveSessions"]').parentElement.textContent;
    assert.match(label, /Archive the 3 sessions/);
    await answerChoiceDialog(ctx, { confirm: true });
    await done;

    assert.deepEqual(archivedIds(calls).sort(), ['a', 'b', 'c']);
    assert.equal(named(calls, 'archiveProject')[0].args[0].length, 2);
  } finally { ctx.destroy(); }
});

test('archive folder: a header with no cached group reloads and does nothing else', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/r', folder: '-r', sessions: [session('a')] };
    ctx.window.activePtyIds.add('a');
    const calls = installApi(ctx);
    let reloads = 0;
    ctx.window.loadProjects = () => { reloads++; };
    render(ctx, [], [project]);
    await clickArchive(ctx, '/r');

    assert.equal(ctx.document.querySelector('.modal-overlay'), null);
    assert.equal(reloads, 1);
    assert.deepEqual(calls, []);
  } finally { ctx.destroy(); }
});

test('archive folder: a schedule that could not be disabled is reported', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/p', folder: '-p', sessions: [session('s1')] };
    installApi(ctx, {
      getProjectArchivePlan: () => Promise.resolve({ schedules: [{ name: 'a', filePath: SCHEDULE_A, disableable: true }] }),
      archiveProject: () => Promise.resolve({ ok: true, disabled: [], failed: [{ name: 'a', error: 'EACCES' }] }),
    });
    let alerted = null;
    ctx.window.alert = (m) => { alerted = m; };
    render(ctx, [project]);
    await clickArchive(ctx, '/p', { confirm: true });

    assert.match(alerted || '', /a: EACCES/);
  } finally { ctx.destroy(); }
});

test('archive folder: an archive refused for indexing is reported', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/p', folder: '-p', sessions: [session('s1')] };
    installApi(ctx, { archiveProject: () => Promise.resolve({ error: 'indexing' }) });
    let alerted = null;
    ctx.window.alert = (m) => { alerted = m; };
    render(ctx, [project]);
    await clickArchive(ctx, '/p', { confirm: true });

    assert.match(alerted || '', /still indexing/);
  } finally { ctx.destroy(); }
});

test('archive folder: an archive that failed in the main process is reported', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/p', folder: '-p', sessions: [session('s1')] };
    installApi(ctx, { archiveProject: () => Promise.resolve({ error: 'SQLITE_BUSY' }) });
    let alerted = null;
    ctx.window.alert = (m) => { alerted = m; };
    render(ctx, [project]);
    await clickArchive(ctx, '/p', { confirm: true });

    assert.match(alerted || '', /could not be archived: SQLITE_BUSY/);
  } finally { ctx.destroy(); }
});

// --- re-enable offer notice ---

function notice(ctx, projectPath) {
  const group = ctx.document.getElementById(ctx.sidebar.folderId(projectPath));
  assert.ok(group, 'the project group must render');
  return group.querySelector('.schedule-reenable-notice');
}

test('re-enable notice: a project carrying an offer shows it, and Turn back on asks main for that folder', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/p', folder: '-p', sessions: [session('s1')], reenableOffer: { names: ['nightly', 'weekly'] } };
    const calls = installApi(ctx, { reenableProjectSchedules: () => Promise.resolve({ ok: true, enabled: ['nightly', 'weekly'], failed: [] }) });
    let reloads = 0;
    ctx.window.loadProjects = () => { reloads++; };
    render(ctx, [project]);

    const el = notice(ctx, '/p');
    assert.ok(el, 'the notice must render under the header');
    assert.match(el.textContent, /2 schedules were turned off when this folder was archived: nightly, weekly/);
    await el.querySelector('.schedule-reenable-on').onclick(new ctx.window.MouseEvent('click'));

    assert.deepEqual(named(calls, 'reenableProjectSchedules').map(c => plain(c.args)), [['/p', '-p']]);
    assert.equal(reloads, 1);
  } finally { ctx.destroy(); }
});

test('re-enable notice: no offer, no notice', () => {
  const ctx = setupSidebarDom();
  try {
    render(ctx, [{ projectPath: '/p', folder: '-p', sessions: [session('s1')] }]);
    assert.equal(notice(ctx, '/p'), null);
  } finally { ctx.destroy(); }
});

test('re-enable notice: Dismiss deletes the offer and turns nothing on', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = { projectPath: '/p', folder: '-p', sessions: [session('s1')], reenableOffer: { names: ['nightly'] } };
    const calls = installApi(ctx);
    render(ctx, [project]);
    const el = notice(ctx, '/p');
    assert.ok(el, 'the notice must render under the header');
    assert.match(el.textContent, /1 schedule was turned off when this folder was archived: nightly/);
    await el.querySelector('.schedule-reenable-dismiss').onclick(new ctx.window.MouseEvent('click'));

    assert.deepEqual(named(calls, 'dismissScheduleReenableOffer').map(c => plain(c.args)), [['/p', '-p']]);
    assert.deepEqual(named(calls, 'reenableProjectSchedules'), []);
  } finally { ctx.destroy(); }
});

test('re-enable notice: failures are reported, and every name is text', () => {
  const ctx = setupSidebarDom();
  try {
    const img = '<img src="x" onerror="window.__pwned = 1">';
    const project = {
      projectPath: '/p', folder: '-p', sessions: [session('s1')],
      reenableOffer: { names: [img], failed: [{ name: img, error: 'linked file or directory' }] },
    };
    render(ctx, [project]);
    const el = notice(ctx, '/p');
    assert.ok(el, 'the notice must render under the header');
    assert.equal(el.querySelectorAll('img').length, 0);
    assert.match(el.textContent, /Could not turn back on: <img[^]*: linked file or directory/);
  } finally { ctx.destroy(); }
});

test('re-enable notice: a nested worktree carrying an offer shows it too', () => {
  const ctx = setupSidebarDom();
  try {
    const parent = { projectPath: '/r', folder: '-r', sessions: [session('a')] };
    const child = { projectPath: WT, folder: '-r--claude-worktrees-w', sessions: [session('c')], reenableOffer: { names: ['wt-job'] } };
    render(ctx, [parent, child]);
    const wtGroup = ctx.document.getElementById(ctx.sidebar.folderId(WT));
    assert.ok(wtGroup && wtGroup.querySelector('.schedule-reenable-notice'));
  } finally { ctx.destroy(); }
});

test('re-enable notice: a stale folder carrying an offer is not auto-collapsed, without an offer it is', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.sessionMaxAgeDays = 1;
    const withOffer = { projectPath: '/p', folder: '-p', sessions: [session('s1')], reenableOffer: { names: ['nightly'] } };
    const without = { projectPath: '/q', folder: '-q', sessions: [session('s2')] };
    const parent = { projectPath: '/r', folder: '-r', sessions: [session('a')] };
    const child = { projectPath: WT, folder: '-r--claude-worktrees-w', sessions: [session('c')], reenableOffer: { names: ['wt-job'] } };
    render(ctx, [withOffer, without, parent, child]);
    const header = (p) => ctx.document.getElementById('ph-' + ctx.sidebar.folderId(p));
    assert.equal(header('/p').classList.contains('collapsed'), false);
    assert.equal(header('/q').classList.contains('collapsed'), true, 'precondition: a stale folder auto-collapses');
    assert.equal(header(WT).classList.contains('collapsed'), false);
  } finally { ctx.destroy(); }
});
