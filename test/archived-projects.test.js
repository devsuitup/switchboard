// The archived-folder rule: which groups an archive hides, what brings one
// back, and what the dialog may offer to disable.
// See .ai/contexts/session-cache.md ("Archived projects").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  archivedEntry, knownIdsForGroup, applyArchivedProjects, applyAndPersistArchived,
  clearArchivedEntry, archivePlanForGroups, reenableScheduleFiles,
} = require('../archived-projects');
const { scheduleFileUnlinked } = require('../schedule-runner');

function group(projectPath, sessions, remoteAlias = null) {
  return { projectPath, remoteAlias, sessions };
}

function top(sessionId, extra = {}) {
  return { sessionId, archived: 0, ...extra };
}

function archivedStore(entries) {
  const store = {};
  for (const [alias, projectPath, knownSessionIds] of entries) {
    store[archivedEntry(alias, projectPath)] = { archivedAt: '2026-10-05T10:00:00.000Z', knownSessionIds };
  }
  return store;
}

const paths = (projects) => projects.map(p => (p.remoteAlias || '') + '|' + p.projectPath);

test('archived projects: a group with only known sessions is hidden when archived sessions are not shown', () => {
  const store = archivedStore([[null, '/r', ['a', 'b']]]);
  const { projects, cleared } = applyArchivedProjects([group('/r', [top('a'), top('b', { archived: 1 })])], store, false);
  assert.deepEqual(projects, []);
  assert.deepEqual(cleared, []);
});

test('archived projects: Show archived keeps the archived group', () => {
  const store = archivedStore([[null, '/r', ['a']]]);
  const { projects, cleared } = applyArchivedProjects([group('/r', [top('a', { archived: 1 })])], store, true);
  assert.deepEqual(paths(projects), ['|/r']);
  assert.deepEqual(cleared, []);
});

test('archived projects: a new top-level unarchived session brings the group back and clears its entry', () => {
  const store = archivedStore([[null, '/r', ['a']]]);
  const { projects, cleared } = applyArchivedProjects([group('/r', [top('a', { archived: 1 }), top('new')])], store, false);
  assert.deepEqual(paths(projects), ['|/r']);
  assert.deepEqual(cleared, [archivedEntry(null, '/r')]);
});

test('archived projects: a known session left unarchived does not bring the group back', () => {
  const store = archivedStore([[null, '/r', ['a']]]);
  const { projects } = applyArchivedProjects([group('/r', [top('a')])], store, false);
  assert.deepEqual(projects, []);
});

test('archived projects: a new subagent does not bring the group back', () => {
  const store = archivedStore([[null, '/r', ['a']]]);
  const { projects } = applyArchivedProjects([group('/r', [top('a', { archived: 1 }), top('sub', { parentSessionId: 'a' })])], store, false);
  assert.deepEqual(projects, []);
});

test('archived projects: a new archived session does not bring the group back', () => {
  const store = archivedStore([[null, '/r', ['a']]]);
  const { projects } = applyArchivedProjects([group('/r', [top('a', { archived: 1 }), top('n', { archived: 1 })])], store, false);
  assert.deepEqual(projects, []);
});

test('archived projects: an alias-qualified entry hides only that host\'s group', () => {
  const store = archivedStore([['planificator', '/srv/x', ['p1']]]);
  const input = [
    group('/srv/x', [top('l1')]),
    group('/srv/x', [top('p1')], 'planificator'),
    group('/srv/x', [top('o1')], 'otherhost'),
  ];
  const { projects } = applyArchivedProjects(input, store, false);
  assert.deepEqual(paths(projects), ['|/srv/x', 'otherhost|/srv/x']);
});

test('archived projects: a bare entry does not hide a remote group at the same path', () => {
  const store = archivedStore([[null, '/srv/x', ['r1']]]);
  const { projects } = applyArchivedProjects([group('/srv/x', [top('r1')], 'planificator')], store, false);
  assert.deepEqual(paths(projects), ['planificator|/srv/x']);
});

test('archived projects: known ids hold every top-level id of the group, archived, terminal or placeholder, and no subagent', () => {
  const projects = [
    group('/r', [
      top('a1', { archived: 1 }),
      top('t1', { type: 'terminal' }),
      top('p1', { placeholder: true }),
      top('sub1', { parentSessionId: 'a1' }),
    ]),
    group('/other', [top('o1')]),
  ];
  const ids = knownIdsForGroup({ projects, activeSessions: new Map(), diskIds: [], alias: null, projectPath: '/r' });
  assert.deepEqual([...ids].sort(), ['a1', 'p1', 't1']);
});

test('archived projects: known ids hold the running sessions of the group, with their real id', () => {
  const activeSessions = new Map([
    ['live-1', { projectPath: '/r', host: null }],
    ['fork-key', { projectPath: '/r/', host: null, realSessionId: 'real-2' }],
    ['remote-x', { projectPath: '/r', host: 'planificator' }],
    ['elsewhere', { projectPath: '/q', host: null }],
  ]);
  const ids = knownIdsForGroup({ projects: [], activeSessions, diskIds: [], alias: null, projectPath: '/r' });
  assert.deepEqual([...ids].sort(), ['fork-key', 'live-1', 'real-2']);
});

test('archived projects: known ids hold the transcripts found on disk', () => {
  const ids = knownIdsForGroup({ projects: [], activeSessions: new Map(), diskIds: ['d1'], alias: null, projectPath: '/r' });
  assert.deepEqual([...ids], ['d1']);
});

const WT = '/r/.claude/worktrees/w';

test('archived projects: a new session in an archived worktree brings back the worktree and its parent', () => {
  const store = archivedStore([[null, '/r', ['a']], [null, WT, ['b']]]);
  const input = [group('/r', [top('a', { archived: 1 })]), group(WT, [top('b', { archived: 1 }), top('c')])];
  const { projects, cleared } = applyArchivedProjects(input, store, false);
  assert.deepEqual(paths(projects), ['|/r', '|' + WT]);
  assert.deepEqual([...cleared].sort(), [archivedEntry(null, '/r'), archivedEntry(null, WT)].sort());
});

test('archived projects: a worktree that appears after the archive brings back its parent', () => {
  const store = archivedStore([[null, '/r', ['a']]]);
  const input = [group('/r', [top('a', { archived: 1 })]), group(WT, [top('c')])];
  const { projects, cleared } = applyArchivedProjects(input, store, false);
  assert.deepEqual(paths(projects), ['|/r', '|' + WT]);
  assert.deepEqual(cleared, [archivedEntry(null, '/r')]);
});

test('archived projects: a worktree of another host does not bring back a local parent', () => {
  const store = archivedStore([[null, '/r', ['a']]]);
  const input = [group('/r', [top('a', { archived: 1 })]), group(WT, [top('c')], 'planificator')];
  const { projects } = applyArchivedProjects(input, store, false);
  assert.deepEqual(paths(projects), ['planificator|' + WT]);
});

test('archived projects: a parent that comes back leaves its archived worktree hidden', () => {
  const store = archivedStore([[null, '/r', ['a']], [null, WT, ['b']]]);
  const input = [group('/r', [top('a', { archived: 1 }), top('n')]), group(WT, [top('b', { archived: 1 })])];
  const { projects } = applyArchivedProjects(input, store, false);
  assert.deepEqual(paths(projects), ['|/r']);
});

test('archived projects: a folder archived with its worktree, with no new session, stays hidden with it', () => {
  const store = archivedStore([[null, '/r', ['a']], [null, WT, ['b']]]);
  const input = [group('/r', [top('a', { archived: 1 })]), group(WT, [top('b', { archived: 1 })])];
  const { projects, cleared } = applyArchivedProjects(input, store, false);
  assert.deepEqual(projects, []);
  assert.deepEqual(cleared, []);
});

test('archived projects: a remote entry ignores a trailing slash', () => {
  assert.equal(archivedEntry('planificator', '/srv/x/'), archivedEntry('planificator', '/srv/x'));
  assert.equal(archivedEntry('planificator', '/srv/x/'), 'planificator::/srv/x');
});

function hiddenStore(hiddenProjects) {
  return { getSetting: (k) => (k === 'global' ? { hiddenProjects } : null), setSetting: () => {} };
}

test('hidden repositories: a worktree of a repository hidden on its host is marked, on another host it is not', () => {
  const projects = [
    group(WT, [top('c')], 'box'),
    group(WT, [top('d')], 'other'),
    group('/q/.claude/worktrees/w', [top('e')], 'box'),
  ];
  const shown = applyAndPersistArchived(projects, false, hiddenStore(['box::/r']));
  assert.deepEqual(shown.map(p => !!p.hiddenRepository), [true, false, false]);
});

test('hidden repositories: a bare hidden entry marks the worktrees of that path on every host', () => {
  const shown = applyAndPersistArchived([group(WT, [top('c')]), group(WT, [top('d')], 'box')], false, hiddenStore(['/r']));
  assert.deepEqual(shown.map(p => !!p.hiddenRepository), [true, true]);
});

test('archived projects: a cleared entry is persisted once, and nothing is written when nothing is cleared', () => {
  const store = archivedStore([[null, '/r', ['a']], [null, '/q', ['q1']]]);
  const writes = [];
  const deps = { getSetting: (k) => (k === 'archivedProjects' ? store : null), setSetting: (k, v) => writes.push([k, v]) };

  const shown = applyAndPersistArchived([group('/r', [top('new')]), group('/q', [top('q1')])], false, deps);
  assert.deepEqual(paths(shown), ['|/r']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'archivedProjects');
  assert.deepEqual(Object.keys(writes[0][1]), [archivedEntry(null, '/q')]);

  writes.length = 0;
  applyAndPersistArchived([group('/q', [top('q1')])], false, deps);
  assert.deepEqual(writes, []);
});

test('archived projects: clearing an entry normalises the path it is given', () => {
  const store = archivedStore([[null, '/srv/x', ['a']]]);
  const writes = [];
  clearArchivedEntry(() => store, (k, v) => writes.push([k, v]), null, '/srv/x/');
  assert.deepEqual(writes, [['archivedProjects', {}]]);
});

// --- archivePlanForGroups ---

const identity = (p) => p;
const scanOne = (projectPath) => [{ name: 'a', filePath: path.join(projectPath, '.claude', 'commands', 'schedule-a.md') }];

test('archive plan: a remote group contributes no schedule', () => {
  const plan = archivePlanForGroups([{ projectPath: '/p', folderKey: 'planificator::-p' }],
    { registered: [path.resolve('/p')], scan: scanOne, realpath: identity });
  assert.deepEqual(plan, []);
});

test('archive plan: a local group outside the schedule registry contributes no schedule', () => {
  const plan = archivePlanForGroups([{ projectPath: '/p', folderKey: '-p' }],
    { registered: [path.resolve('/q')], scan: scanOne, realpath: identity });
  assert.deepEqual(plan, []);
});

test('archive plan: a registered project is matched whatever trailing slash the group carries', () => {
  const plan = archivePlanForGroups([{ projectPath: '/p/', folderKey: '-p' }],
    { registered: [path.resolve('/p')], scan: scanOne, realpath: identity });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].name, 'a');
  assert.equal(plan[0].disableable, true);
});

function planRig(t, linkCommands) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-archive-plan-')));
  const project = path.join(root, 'p');
  const claudeDir = path.join(project, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  if (linkCommands) {
    const target = path.join(root, 'dotfiles');
    fs.mkdirSync(target);
    try { fs.symlinkSync(target, path.join(claudeDir, 'commands'), 'dir'); }
    catch { fs.rmSync(root, { recursive: true, force: true }); t.skip('cannot create a symlink on this machine'); return null; }
  } else {
    fs.mkdirSync(path.join(claudeDir, 'commands'));
  }
  const filePath = path.join(claudeDir, 'commands', 'schedule-a.md');
  fs.writeFileSync(filePath, '---\ncron: * * * * *\n---\nhi\n');
  return { root, project, filePath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('archive plan: a schedule reached through a linked commands directory is listed but not disableable', (t) => {
  const r = planRig(t, true);
  if (!r) return;
  try {
    const plan = archivePlanForGroups([{ projectPath: r.project, folderKey: '-p' }],
      { registered: [r.project], scan: () => [{ name: 'a', filePath: r.filePath }], realpath: fs.realpathSync });
    assert.deepEqual(plan, [{ name: 'a', filePath: r.filePath, disableable: false, reason: 'linked file or directory' }]);
  } finally { r.cleanup(); }
});

test('archive plan: a plain schedule file is disableable', (t) => {
  const r = planRig(t, false);
  try {
    const plan = archivePlanForGroups([{ projectPath: r.project, folderKey: '-p' }],
      { registered: [r.project], scan: () => [{ name: 'a', filePath: r.filePath }], realpath: fs.realpathSync });
    assert.deepEqual(plan, [{ name: 'a', filePath: r.filePath, disableable: true }]);
  } finally { r.cleanup(); }
});

test('archive plan: a schedule file that vanished is dropped, and the link check never throws', () => {
  const enoent = (p) => {
    if (p.endsWith('schedule-gone.md')) { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; }
    return p;
  };
  assert.equal(scheduleFileUnlinked('/p', '/p/.claude/commands/schedule-gone.md', enoent), false);

  const scan = (projectPath) => [
    { name: 'gone', filePath: path.join(projectPath, '.claude', 'commands', 'schedule-gone.md') },
    { name: 'kept', filePath: path.join(projectPath, '.claude', 'commands', 'schedule-kept.md') },
  ];
  const plan = archivePlanForGroups([{ projectPath: '/p', folderKey: '-p' }],
    { registered: [path.resolve('/p')], scan, realpath: enoent });
  assert.deepEqual(plan.map(s => s.name), ['kept']);
});

// --- re-enable offers ---

function settingsStore(initial) {
  const values = { ...initial };
  const writes = [];
  return {
    values, writes,
    getSetting: (k) => (k in values ? values[k] : null),
    setSetting: (k, v) => { values[k] = v; writes.push(k); },
  };
}

const names = { '/p/.claude/commands/schedule-a.md': 'nightly', '/p/.claude/commands/schedule-b.md': 'weekly' };
const scheduleName = (filePath) => names[filePath] || null;

test('re-enable offer: a folder that reappears turns its disabled schedules into an offer the project carries', () => {
  const store = settingsStore({ archivedProjects: {
    [archivedEntry(null, '/p')]: { archivedAt: 'T0', knownSessionIds: ['a'], disabledSchedules: ['/p/.claude/commands/schedule-a.md'] },
  } });
  const shown = applyAndPersistArchived([group('/p', [top('new')])], false, { ...store, scheduleName });
  assert.deepEqual(store.values.scheduleReenableOffers, {
    [archivedEntry(null, '/p')]: { disabledSchedules: ['/p/.claude/commands/schedule-a.md'], archivedAt: 'T0' },
  });
  assert.deepEqual(store.values.archivedProjects, {});
  assert.deepEqual(shown[0].reenableOffer, { names: ['nightly'] });
});

test('re-enable offer: a folder that reappears with no disabled schedule makes no offer', () => {
  const store = settingsStore({ archivedProjects: {
    [archivedEntry(null, '/p')]: { archivedAt: 'T0', knownSessionIds: ['a'], disabledSchedules: [] },
  } });
  const shown = applyAndPersistArchived([group('/p', [top('new')])], false, { ...store, scheduleName });
  assert.deepEqual(store.writes, ['archivedProjects']);
  assert.equal(shown[0].reenableOffer, undefined);
});

test('re-enable offer: a stored offer names only the files still present, on every later listing', () => {
  const store = settingsStore({ scheduleReenableOffers: {
    [archivedEntry(null, '/p')]: { archivedAt: 'T0', disabledSchedules: ['/p/.claude/commands/schedule-a.md', '/p/.claude/commands/gone.md'] },
  } });
  const shown = applyAndPersistArchived([group('/p', [top('a')])], true, { ...store, scheduleName });
  assert.deepEqual(shown[0].reenableOffer, { names: ['nightly'] });
  assert.deepEqual(store.writes, []);
});

test('re-enable offer: the failures of a previous attempt reach the project', () => {
  const store = settingsStore({ scheduleReenableOffers: {
    [archivedEntry(null, '/p')]: {
      archivedAt: 'T0', disabledSchedules: ['/p/.claude/commands/schedule-a.md'],
      failed: [{ name: 'nightly', error: 'linked file or directory' }],
    },
  } });
  const shown = applyAndPersistArchived([group('/p', [top('a')])], false, { ...store, scheduleName });
  assert.deepEqual(shown[0].reenableOffer, { names: ['nightly'], failed: [{ name: 'nightly', error: 'linked file or directory' }] });
});

test('re-enable offer: Add Project on an archived folder keeps its disabled schedules as an offer', () => {
  const store = settingsStore({ archivedProjects: {
    [archivedEntry(null, '/p')]: { archivedAt: 'T0', knownSessionIds: [], disabledSchedules: ['/p/.claude/commands/schedule-b.md'] },
  } });
  clearArchivedEntry(store.getSetting, store.setSetting, null, '/p/');
  assert.deepEqual(store.values.archivedProjects, {});
  assert.deepEqual(store.values.scheduleReenableOffers, {
    [archivedEntry(null, '/p')]: { disabledSchedules: ['/p/.claude/commands/schedule-b.md'], archivedAt: 'T0' },
  });
});

test('re-enable: turns back on the files still disabled, leaves edited and vanished ones, reports a refusal', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-reenable-')));
  try {
    const project = path.join(root, 'p');
    const commands = path.join(project, '.claude', 'commands');
    fs.mkdirSync(commands, { recursive: true });
    const write = (name, enabled) => {
      const filePath = path.join(commands, name);
      fs.writeFileSync(filePath, `---\nname: ${name}\ncron: * * * * *\nenabled: ${enabled}\n---\nhi\n`);
      return filePath;
    };
    const off = write('schedule-off.md', 'false');
    const edited = write('schedule-edited.md', 'off');
    const editedBefore = fs.readFileSync(edited, 'utf8');
    const gone = path.join(commands, 'schedule-gone.md');
    const shared = path.join(root, 'shared.md');
    fs.writeFileSync(shared, '---\nname: linked\ncron: * * * * *\nenabled: false\n---\nhi\n');
    const linked = path.join(commands, 'schedule-linked.md');
    let haveLink = true;
    try { fs.symlinkSync(shared, linked, 'file'); } catch { haveLink = false; }

    const files = haveLink ? [off, edited, gone, linked] : [off, edited, gone];
    const res = reenableScheduleFiles(files, project);

    assert.deepEqual(res.enabled, ['schedule-off.md']);
    assert.match(fs.readFileSync(off, 'utf8'), /\nenabled: true\n/);
    assert.equal(fs.readFileSync(edited, 'utf8'), editedBefore, 'a file the user edited is left as it is');
    if (haveLink) {
      assert.deepEqual(res.failed.map(f => [f.name, f.filePath]), [['linked', linked]]);
      assert.match(fs.readFileSync(shared, 'utf8'), /\nenabled: false\n/);
    } else {
      t.diagnostic('cannot create a symlink on this machine: the refusal is not exercised');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
