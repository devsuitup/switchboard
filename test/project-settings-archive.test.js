'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { extractFunction, loadAppFunctions } = require('./app-source');
const { setupSidebarDom, answerChoiceDialog } = require('./dom-setup');
const { encodeProjectPath } = require('../encode-project-path');
const { parseFolderKey, joinFolderKey } = require('../remote-hosts');
const { applyAndPersistArchived, clearArchivedEntry } = require('../archived-projects');
const { loadScheduleRunner } = require('./schedule-runner-harness');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(t, { hidden = [], cron = '* * * * *', registered = true,
  platform = process.platform, realpath = fs.realpathSync.native } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-project-archive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projectPath = path.join(dir, 'project');
  const commands = path.join(projectPath, '.claude', 'commands');
  fs.mkdirSync(commands, { recursive: true });
  const scheduleFile = path.join(commands, 'schedule-audit.md');
  const scheduleBytes = `---\nname: Audit\ncron: ${cron}\nenabled: true\ncatch-up: true\n---\nAudit this project.\n`;
  fs.writeFileSync(scheduleFile, scheduleBytes);
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ global: { hiddenProjects: hidden },
    ['project:' + projectPath]: { permissionMode: 'plan', addDirs: '/extra' }, scheduleProjects: registered ? [projectPath] : [] }));
  const getSetting = key => JSON.parse(fs.readFileSync(settingsFile, 'utf8'))[key];
  const setSetting = (key, value) => {
    const state = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    state[key] = value;
    fs.writeFileSync(settingsFile, JSON.stringify(state));
  };
  const deleteSetting = key => {
    const state = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    delete state[key];
    fs.writeFileSync(settingsFile, JSON.stringify(state));
  };
  const folder = encodeProjectPath(projectPath);
  const cache = new Set([folder]);
  const search = new Set([folder]);
  const refreshed = [];
  const handlers = new Map();
  let notices = 0;
  const modules = loadScheduleRunner({ home: dir, platform, realpath });
  const context = vm.createContext({
    fs: modules.filesystem, path, process: { platform }, skipMissedScheduleRuns: () => {}, encodeProjectPath, parseFolderKey, joinFolderKey, getSetting, setSetting, deleteSetting,
    clearArchivedEntry, require: createRequire(path.join(ROOT, 'main.js')),
    scheduleProjects: () => modules.runner.scheduleRegistry(getSetting, setSetting),
    deleteCachedFolder: key => cache.delete(key), deleteSearchFolder: key => search.delete(key),
    refreshFolder: key => { refreshed.push(key); cache.add(key); },
    notifyRendererProjectsChanged: () => { notices++; },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  });
  context.writer = require('./fixtures/writer-memory.cjs').memoryWriter({
    getSetting, setSetting, deleteSetting,
    deleteCachedFolder: context.deleteCachedFolder, deleteSearchFolder: context.deleteSearchFolder,
  }, { refreshFolder: context.refreshFolder });
  const source = read('main.js');
  vm.runInContext(extractFunction(source, 'isDirectory'), context, { filename: path.join(ROOT, 'main.js') });
  context.normalizeArchivedProjectPath = modules.load('normalize-project-path.js').normalizeProjectPath;
  vm.runInContext(extractFunction(source, 'unarchivedScheduleProjects'), context, { filename: path.join(ROOT, 'main.js') });
  if (source.includes('function isProjectSettingsArchived(')) {
    vm.runInContext(extractFunction(source, 'isProjectSettingsArchived'), context, { filename: path.join(ROOT, 'main.js') });
  }
  for (const channel of ['remove-project', 'archive-project-settings', 'unarchive-project']) {
    const start = source.indexOf(`ipcMain.handle('${channel}'`);
    if (start !== -1) vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), context, { filename: path.join(ROOT, 'main.js') });
  }
  const invoke = (channel, ...args) => {
    assert.ok(handlers.has(channel), `${channel} must be available`);
    return handlers.get(channel)(null, ...args);
  };
  const archive = (p = projectPath, f = folder) => invoke(handlers.has('archive-project-settings') ? 'archive-project-settings' : 'remove-project', p, f);
  return { dir, projectPath, folder, getSetting, setSetting, deleteSetting, cache, search, refreshed, context,
    invoke, archive, scheduleFile, scheduleBytes, notices: () => notices };
}

test('archive keeps persisted project settings, cache, search and schedule registration', async t => {
  const h = setup(t);
  const before = h.getSetting('project:' + h.projectPath);
  assert.equal((await h.archive()).ok, true);
  assert.deepEqual(h.getSetting('project:' + h.projectPath), before);
  assert.ok(h.cache.has(h.folder));
  assert.ok(h.search.has(h.folder));
  assert.deepEqual(h.getSetting('scheduleProjects'), [h.projectPath]);
  assert.equal(fs.readFileSync(h.scheduleFile, 'utf8'), h.scheduleBytes);
  assert.deepEqual(h.getSetting('global').hiddenProjects, [h.projectPath]);
  assert.equal(h.notices(), 1);
});

test('archive and unarchive filter the public project payload and restore its sidebar row', async t => {
  const h = setup(t);
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const project = { folder: h.folder, projectPath: h.projectPath, sessions: [] };
  ctx.window.api.getProjects = async () => ({
    defaultProjects: applyAndPersistArchived([structuredClone(project)], false, h),
    allProjects: applyAndPersistArchived([structuredClone(project)], true, h),
  });
  ctx.window.api.getActiveTerminals = async () => [];
  ctx.window.api.getSetting = async key => h.getSetting(key);
  ctx.window.loadingStatus = ctx.document.createElement('div');
  ctx.window.reportActivityFocus = () => {};
  ctx.window.reportActivityTitles = () => {};
  ctx.window.refreshSidebar = () => ctx.sidebar.renderProjects(ctx.window.cachedProjects, true);
  ctx.window.renderDefaultStatus = () => {};
  const app = loadAppFunctions(ctx.context, { functions: ['dedup', 'loadProjects'] });
  await app.loadProjects();
  const id = 'ph-' + ctx.sidebar.folderId(h.projectPath);
  assert.ok(ctx.document.getElementById(id));
  (await h.archive());
  await app.loadProjects();
  assert.equal(ctx.document.getElementById(id), null);
  assert.equal((await h.invoke('unarchive-project', h.projectPath)).ok, true);
  await app.loadProjects();
  assert.ok(ctx.document.getElementById(id));
  assert.equal(h.getSetting('project:' + h.projectPath).permissionMode, 'plan');
});

test('legacy hidden entries unarchive with default settings and rebuild the folder', async t => {
  const h = setup(t);
  h.setSetting('global', { hiddenProjects: [h.projectPath] });
  h.deleteSetting('project:' + h.projectPath);
  h.setSetting('scheduleProjects', []);
  h.cache.clear();
  assert.equal((await h.invoke('unarchive-project', h.projectPath)).ok, true);
  assert.deepEqual(h.getSetting('global').hiddenProjects, []);
  assert.equal(h.getSetting('project:' + h.projectPath), undefined);
  assert.ok(h.cache.has(h.folder));
  assert.deepEqual(h.getSetting('scheduleProjects'), [h.projectPath]);
});

test('Windows legacy Hide unarchive with different case keeps one registration and one scheduled run',
  { skip: process.platform !== 'win32' }, async t => {
    const h = setup(t, { cron: '0 * * * *' });
    const hidden = h.projectPath.toUpperCase();
    h.setSetting('global', { hiddenProjects: [hidden] });
    assert.equal((await h.invoke('unarchive-project', hidden)).ok, true);
    assert.deepEqual(h.getSetting('scheduleProjects'), [h.projectPath]);
    const s = (await schedulerHarness(t, h));
    s.at(11, 0);
    (await s.tick());
    assert.deepEqual(s.runs, [h.projectPath]);
  });

test('remote archive and unarchive preserve host scope without registering a local schedule', async t => {
  const h = setup(t);
  const remoteFolder = joinFolderKey('server', h.folder);
  (await h.archive(h.projectPath, remoteFolder));
  assert.deepEqual(h.getSetting('global').hiddenProjects, ['server::' + h.projectPath]);
  h.setSetting('scheduleProjects', []);
  assert.equal((await h.invoke('unarchive-project', 'server::' + h.projectPath)).ok, true);
  assert.deepEqual(h.getSetting('scheduleProjects'), []);
  assert.ok(h.refreshed.includes(remoteFolder));
});

test('archiving a host named null does not archive the same local project', t => {
  const h = setup(t);
  h.setSetting('global', { hiddenProjects: ['null::' + h.projectPath] });
  const projects = [{ projectPath: h.projectPath, remoteAlias: null, sessions: [] },
    { projectPath: h.projectPath, remoteAlias: 'null', sessions: [] }];
  const kept = applyAndPersistArchived(projects, false, h);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].remoteAlias, null);
});

test('delete drops project settings, cache, search and schedules without changing disk files', async t => {
  const h = setup(t);
  assert.equal((await h.invoke('remove-project', h.projectPath, h.folder)).ok, true);
  assert.equal(h.getSetting('project:' + h.projectPath), undefined);
  assert.equal(h.cache.has(h.folder), false);
  assert.equal(h.search.has(h.folder), false);
  assert.deepEqual(h.getSetting('scheduleProjects'), []);
  assert.equal(fs.readFileSync(h.scheduleFile, 'utf8'), h.scheduleBytes);
  assert.ok(fs.statSync(h.projectPath).isDirectory());
});

async function schedulerHarness(t, h) {
  const localRequire = createRequire(path.join(ROOT, 'schedule-runner.js'));
  const timers = [];
  const clock = { now: new Date(2026, 0, 5, 10, 50).getTime() };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const runnerContext = vm.createContext({
    require: name => name === 'os' ? { homedir: () => h.dir } : localRequire(name), module: { exports: {} },
    process: { env: {} }, Date: Clock, setTimeout: fn => { const timer = { fn }; timers.push(timer); return timer; },
    setInterval: () => ({}), clearTimeout() {}, clearInterval() {},
  });
  vm.runInContext(read('schedule-runner.js'), runnerContext, { filename: path.join(ROOT, 'schedule-runner.js') });
  const stateDir = path.join(h.dir, 'schedule-state');
  const log = { info() {}, warn() {}, error() {} };
  h.context.skipMissedScheduleRuns = projects => runnerContext.module.exports.skipMissedRuns(log, projects, stateDir);
  const source = read('main.js');
  const projectsLine = source.split('\n').find(line => line.includes('projects: async () => (await scheduleProjects().list())'));
  const projects = vm.runInContext('({' + projectsLine.trim() + '}).projects', h.context, { filename: path.join(ROOT, 'main.js') });
  const runs = [];
  const resume = new EventEmitter();
  const stop = runnerContext.module.exports.startScheduler(log,
    (_args, cwd, _name, done) => { runs.push(cwd); done(); },
    { projects, resumeSource: resume, stateDir });
  t.after(stop);
  await settle();
  return { runs, resume: { emit: async (...args) => { resume.emit(...args); await settle(); } }, stateDir,
    tick: async () => { await timers[0].fn(); await settle(); },
    at: (...args) => { clock.now = new Date(2026, 0, 5, ...args).getTime(); } };
}

test('archived schedules cannot run on ticks or catch-up and a run missed while archived is not caught up on unarchive', async t => {
  const h = setup(t, { cron: '0 * * * *' });
  const s = (await schedulerHarness(t, h));
  assert.equal(s.runs.length, 0);
  (await h.archive());
  s.at(11, 30);
  (await s.tick());
  (await s.resume.emit('resume'));
  assert.equal(s.runs.length, 0, 'archive must suspend ticks and resume catch-up checks');
  (await h.invoke('unarchive-project', h.projectPath));
  s.at(11, 31);
  (await s.tick());
  assert.equal(s.runs.length, 0, 'the 11:00 run missed while archived is not caught up');
  s.at(12, 0);
  (await s.tick());
  assert.equal(s.runs.length, 1, 'the same registration runs again at its next due minute');
});

test('a nested worktree schedule is not caught up either when its project is unarchived', async t => {
  const h = setup(t, { cron: '0 * * * *' });
  const worktree = path.join(h.projectPath, '.claude', 'worktrees', 'worker');
  const commands = path.join(worktree, '.claude', 'commands');
  fs.mkdirSync(commands, { recursive: true });
  fs.writeFileSync(path.join(commands, 'schedule-audit.md'), h.scheduleBytes);
  h.setSetting('scheduleProjects', [h.projectPath, worktree]);
  const s = (await schedulerHarness(t, h));
  (await h.archive());
  s.at(11, 30);
  (await s.tick());
  assert.equal(s.runs.length, 0);
  (await h.invoke('unarchive-project', h.projectPath));
  s.at(11, 31);
  (await s.tick());
  assert.equal(s.runs.length, 0, 'neither the project nor its worktree replays the 11:00 run');
  s.at(12, 0);
  (await s.tick());
  assert.deepEqual([...s.runs].sort(), [h.projectPath, worktree].sort());
});

for (const target of ['root', 'worktree']) {
  test(`Windows unarchive with different path case resets the ${target} scheduler key`, async t => {
    let h;
    const onDisk = value => value.toLowerCase().startsWith(h.projectPath.toLowerCase())
      ? h.projectPath + value.slice(h.projectPath.length) : value;
    h = setup(t, { cron: '0 * * * *', platform: 'win32', realpath: onDisk });
    const worktree = path.join(h.projectPath, '.claude', 'worktrees', 'worker');
    const commands = path.join(worktree, '.claude', 'commands');
    fs.mkdirSync(commands, { recursive: true });
    const worktreeFile = path.join(commands, 'schedule-audit.md');
    fs.writeFileSync(worktreeFile, h.scheduleBytes);
    h.setSetting('scheduleProjects', [h.projectPath, worktree]);
    const s = (await schedulerHarness(t, h));
    const archivedPath = h.projectPath.toUpperCase();
    assert.notEqual(archivedPath, h.projectPath);
    assert.equal((await h.archive(archivedPath, encodeProjectPath(archivedPath))).ok, true);
    s.at(11, 30);
    (await s.tick());
    (await s.resume.emit('resume'));
    assert.equal(s.runs.length, 0);
    assert.equal((await h.invoke('unarchive-project', archivedPath)).ok, true);
    const file = target === 'root' ? h.scheduleFile : worktreeFile;
    const key = createHash('sha256').update(file).digest('hex').slice(0, 16);
    const baseline = new Date(2026, 0, 5, 11, 29).getTime();
    assert.ok(fs.existsSync(path.join(s.stateDir, `${key}-${baseline}.json`)),
      'unarchive must reset the catch-up record under the registry schedule file key');
    s.at(11, 31);
    (await s.tick());
    (await s.resume.emit('resume'));
    assert.equal(s.runs.length, 0, 'the missed 11:00 run must not replay');
    s.at(12, 0);
    (await s.tick());
    assert.deepEqual([...s.runs].sort(), [h.projectPath, worktree].sort());
  });
}

for (const platform of ['linux', 'darwin']) {
  test(`${platform} unarchive keeps differently cased registry projects distinct`, async t => {
    const h = setup(t, { platform, realpath: value => value });
    const otherRoot = h.projectPath.toUpperCase();
    const otherWorktree = path.join(otherRoot, '.claude', 'worktrees', 'worker');
    h.setSetting('scheduleProjects', [h.projectPath, otherRoot, otherWorktree]);
    assert.deepEqual(Array.from((await h.context.unarchivedScheduleProjects(h.projectPath))), [h.projectPath]);
  });
}

function runNowHarness(h) {
  const handlers = new Map();
  const runs = [];
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const localRequire = createRequire(path.join(ROOT, file));
    const context = vm.createContext({ module: { exports: {} },
      require: name => {
        if (name === 'electron') return { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } };
        if (name === 'os') return { homedir: () => h.dir };
        if (name === './schedule-runner') return load('schedule-runner.js');
        return localRequire(name);
      },
    });
    vm.runInContext(read(file), context, { filename: path.join(ROOT, file) });
    modules.set(file, context.module.exports);
    return context.module.exports;
  }
  const log = { info() {}, warn() {}, error() {} };
  load('schedule-ipc.js').init(log, (...args) => runs.push(args), () => true, h.context.isProjectSettingsArchived);
  return { run: file => handlers.get('run-schedule-now')(null, file), runs };
}

test('Run now refuses an archived project before writing a transcript and resumes on unarchive', async t => {
  const h = setup(t);
  const runner = runNowHarness(h);
  (await h.archive());
  assert.equal((await runner.run(h.scheduleFile)).ok, false);
  assert.equal(runner.runs.length, 0);
  assert.equal(fs.existsSync(path.join(h.dir, '.claude', 'projects')), false);
  (await h.invoke('unarchive-project', h.projectPath));
  assert.equal((await runner.run(h.scheduleFile)).ok, true);
  assert.equal(runner.runs.length, 1);
});

test('Run now cannot bypass project Archive through a directory junction or symlink', async t => {
  const h = setup(t);
  const link = path.join(h.dir, 'linked-project');
  fs.symlinkSync(h.projectPath, link, process.platform === 'win32' ? 'junction' : 'dir');
  (await h.archive(link, encodeProjectPath(link)));
  const runner = runNowHarness(h);
  assert.equal((await runner.run(path.join(link, '.claude', 'commands', 'schedule-audit.md'))).ok, false);
  assert.equal(runner.runs.length, 0);
  assert.equal(fs.existsSync(path.join(h.dir, '.claude', 'projects')), false);
});

test('project Archive suspends nested worktree schedules with native path separators', async t => {
  const h = setup(t);
  const worktree = path.join(h.projectPath, '.claude', 'worktrees', 'worker');
  fs.mkdirSync(worktree, { recursive: true });
  (await h.archive());
  assert.equal(h.context.isProjectSettingsArchived(worktree), true);
  (await h.invoke('unarchive-project', h.projectPath));
  assert.equal(h.context.isProjectSettingsArchived(worktree), false);
});

test('the shared schedule launch refuses an archived project and releases its running guard', async t => {
  const h = setup(t);
  (await h.archive());
  let done = 0;
  h.context.log = { info() {} };
  const source = read('main.js').replace(/^    (async )?function runScheduleCommand/m, '$1function runScheduleCommand');
  vm.runInContext(extractFunction(source, 'runScheduleCommand'), h.context, { filename: path.join(ROOT, 'main.js') });
  (await h.context.runScheduleCommand([], h.projectPath, 'Audit', () => { done++; }));
  assert.equal(done, 1);
});

test('preload forwards Archive, Unarchive and Delete to their distinct IPC handlers', t => {
  const h = setup(t);
  let api;
  const calls = [];
  const context = vm.createContext({ process: { platform: 'win32', argv: [], env: {} }, require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { invoke: (...args) => calls.push(args) },
  }) });
  vm.runInContext(read('preload.js'), context, { filename: path.join(ROOT, 'preload.js') });
  api.archiveProjectSettings(h.projectPath, h.folder);
  api.unarchiveProject('server::' + h.projectPath);
  api.deleteProject(h.projectPath, h.folder);
  assert.deepEqual(calls, [['archive-project-settings', h.projectPath, h.folder],
    ['unarchive-project', 'server::' + h.projectPath], ['remove-project', h.projectPath, h.folder]]);
});

function settingsDom(t, h) {
  const ids = ['settings-viewer', 'settings-viewer-title', 'settings-viewer-body', 'terminal-area',
    'terminal-header', 'placeholder', 'stats-viewer', 'memory-viewer', 'jsonl-viewer'];
  const dom = new JSDOM(ids.map(id => `<div id="${id}"></div>`).join(''), { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const calls = [];
  dom.window.api = new Proxy({
    platform: 'win32', getSetting: async key => h.getSetting(key), getShellProfiles: async () => [],
    setSetting: async (key, value) => { h.setSetting(key, value); return { ok: true }; },
    archiveProjectSettings: async (...args) => { calls.push(['archive', ...args]); return (await h.archive(...args)); },
    deleteProject: async (...args) => { calls.push(['delete', ...args]); return (await h.invoke('remove-project', ...args)); },
    unarchiveProject: async entry => { calls.push(['unarchive', entry]); return (await h.invoke('unarchive-project', entry)); },
  }, { get: (obj, key) => key in obj ? obj[key] : async () => ({ ok: true }) });
  dom.window.confirm = () => { throw new Error('native confirm must not be used'); };
  dom.window.alert = () => { throw new Error('native alert must not be used'); };
  let reloads = 0;
  dom.window.loadProjects = async () => { reloads++; };
  for (const file of ['setting-defaults.js', 'utils.js', 'shortcuts.js', 'terminal-themes.js', 'modal-stack.js', 'choice-dialog.js', 'settings-panel.js']) {
    vm.runInContext(read('public/' + file), dom.getInternalVMContext(), { filename: path.join(ROOT, 'public', file) });
  }
  return { window: dom.window, document: dom.window.document, calls, reloads: () => reloads };
}

test('Settings lists legacy and remote archived projects safely and Unarchive reloads the sidebar', async t => {
  const h = setup(t);
  h.setSetting('global', { hiddenProjects: [h.projectPath, 'server::/srv/<project>'] });
  const dom = settingsDom(t, h);
  await dom.window.openSettingsViewer('global');
  const list = dom.document.querySelector('#sv-archived-projects');
  assert.ok(list, 'Archived projects must have a Settings list');
  assert.match(list.textContent, /server::\/srv\/<project>/);
  assert.equal(list.querySelector('project'), null);
  const button = list.querySelector('button');
  assert.equal(button.textContent, 'Unarchive');
  button.click();
  await settle();
  assert.deepEqual(dom.calls, [['unarchive', h.projectPath]]);
  assert.equal(dom.reloads(), 1);
  assert.equal(dom.document.querySelectorAll('#sv-archived-projects button').length, 1);
  dom.document.querySelector('#sv-save-btn').click();
  await settle();
  assert.deepEqual(h.getSetting('global').hiddenProjects, ['server::/srv/<project>']);
});

for (const action of ['archive', 'delete']) {
  test(`${action} confirmation describes its effects, cancels safely and uses an in-app dialog`, async t => {
    const h = setup(t);
    const dom = settingsDom(t, h);
    await dom.window.openSettingsViewer('project', h.projectPath, h.folder);
    const button = dom.document.querySelector(action === 'archive' ? '#sv-archive-btn' : '#sv-delete-btn');
    assert.ok(button, `${action} must have a separate project action`);
    button.click();
    const dialog = dom.document.querySelector('.choice-dialog');
    assert.ok(dialog);
    if (action === 'archive') {
      assert.match(dialog.textContent, /Settings → Archived projects/);
      assert.match(dialog.textContent, /settings.*kept/i);
      assert.match(dialog.textContent, /schedules.*suspended/i);
      assert.equal(dialog.querySelector('.choice-dialog-confirm').classList.contains('delete-worktree-confirm-btn'), false);
    } else {
      assert.match(dialog.textContent, /project settings/i);
      assert.match(dialog.textContent, /cache.*search index/i);
      assert.match(dialog.textContent, /schedule registration/i);
      assert.match(dialog.textContent, /folder.*session.*schedule files.*not deleted/i);
      assert.ok(dialog.querySelector('.choice-dialog-confirm').classList.contains('delete-worktree-confirm-btn'));
    }
    dialog.querySelector('.choice-dialog-cancel').click();
    await settle();
    assert.equal(dom.calls.length, 0);
    button.click();
    dom.document.querySelector('.choice-dialog-confirm').click();
    await settle();
    assert.deepEqual(dom.calls, [[action, h.projectPath, h.folder]]);
    assert.equal(dom.reloads(), 1);
  });
}

test('archiving an exact project does not reinsert a pending session into the sidebar', async t => {
  const h = setup(t);
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.api.getProjects = async () => ({ defaultProjects: [], allProjects: [] });
  ctx.window.api.getActiveTerminals = async () => [];
  ctx.window.api.getSetting = async key => h.getSetting(key);
  ctx.window.loadingStatus = ctx.document.createElement('div');
  ctx.window.reportActivityFocus = () => {};
  ctx.window.reportActivityTitles = () => {};
  ctx.window.refreshSidebar = () => {};
  ctx.window.renderDefaultStatus = () => {};
  ctx.window.pendingSessions.set('pending', { projectPath: h.projectPath, folder: h.folder,
    session: { sessionId: 'pending', projectPath: h.projectPath } });
  (await h.archive());
  await loadAppFunctions(ctx.context, { functions: ['dedup', 'loadProjects'] }).loadProjects();
  assert.equal(ctx.window.cachedProjects.length, 0);
  assert.equal(ctx.window.cachedAllProjects.length, 0);
});

test('a pending session arriving during project fetch cannot reinsert an archived project', async t => {
  const h = setup(t);
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const release = [];
  ctx.window.api.getProjects = () => new Promise(resolve => release.push(resolve));
  ctx.window.api.getActiveTerminals = async () => [];
  ctx.window.api.getSetting = async key => h.getSetting(key);
  ctx.window.loadingStatus = ctx.document.createElement('div');
  ctx.window.reportActivityFocus = () => {};
  ctx.window.reportActivityTitles = () => {};
  ctx.window.refreshSidebar = () => {};
  ctx.window.renderDefaultStatus = () => {};
  (await h.archive());
  const loading = loadAppFunctions(ctx.context, { functions: ['dedup', 'loadProjects'] }).loadProjects();
  ctx.window.pendingSessions.set('pending', { projectPath: h.projectPath, folder: h.folder,
    session: { sessionId: 'pending', projectPath: h.projectPath } });
  release.forEach(resolve => resolve({ defaultProjects: [], allProjects: [] }));
  await loading;
  assert.equal(ctx.window.cachedProjects.length, 0);
  assert.equal(ctx.window.cachedAllProjects.length, 0);
});

test('unarchiving a project that was never registered or was deleted registers no schedule', async t => {
  const never = setup(t, { registered: false });
  (await never.archive());
  assert.equal((await never.invoke('unarchive-project', never.projectPath)).ok, true);
  assert.deepEqual(never.getSetting('scheduleProjects'), []);
  const deleted = setup(t);
  (await deleted.invoke('remove-project', deleted.projectPath, deleted.folder));
  assert.equal((await deleted.invoke('unarchive-project', deleted.projectPath)).ok, true);
  assert.deepEqual(deleted.getSetting('scheduleProjects'), []);
});

test('a legacy hidden entry whose folder is gone is not registered on unarchive', async t => {
  const h = setup(t, { registered: false });
  const gone = path.join(h.dir, 'gone');
  h.setSetting('global', { hiddenProjects: [gone] });
  assert.equal((await h.invoke('unarchive-project', gone)).ok, true);
  assert.deepEqual(h.getSetting('scheduleProjects'), []);
});

test('Archive matches a project path whatever its letter case on Windows', { skip: process.platform !== 'win32' }, async t => {
  const h = setup(t);
  (await h.archive());
  assert.equal(h.context.isProjectSettingsArchived(h.projectPath.toUpperCase()), true);
  const worktree = path.join(h.projectPath, '.claude', 'worktrees', 'w');
  fs.mkdirSync(worktree, { recursive: true });
  assert.equal(h.context.isProjectSettingsArchived(worktree.toLowerCase()), true);
});

test('Settings lists archived projects but not deleted ones, and Delete and Archive record which they were', async t => {
  const h = setup(t);
  const other = path.join(h.dir, 'other');
  h.setSetting('global', { hiddenProjects: [h.projectPath, other], hiddenProjectKinds: { [other]: 'delete' } });
  const dom = settingsDom(t, h);
  await dom.window.openSettingsViewer('global');
  const text = dom.document.querySelector('#sv-archived-projects').textContent;
  assert.ok(text.includes(h.projectPath));
  assert.equal(text.includes(other), false);
  h.setSetting('global', {});
  (await h.archive());
  assert.deepEqual(h.getSetting('global').hiddenProjectKinds, { [h.projectPath]: 'archive' });
  (await h.invoke('unarchive-project', h.projectPath));
  assert.deepEqual(h.getSetting('global').hiddenProjectKinds, {});
  (await h.invoke('remove-project', h.projectPath, h.folder));
  assert.deepEqual(h.getSetting('global').hiddenProjectKinds, { [h.projectPath]: 'delete' });
});

test('the worktree Archive button asks in the app dialog and archives that project', async t => {
  const h = setup(t);
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const repo = { folder: 'repo', projectPath: '/home/dev/myrepo', sessions: [] };
  const worktree = { folder: 'wt-folder', projectPath: '/home/dev/myrepo/.claude/worktrees/agent-1', sessions: [] };
  const calls = [];
  let confirmed = 0;
  ctx.window.confirm = () => { confirmed++; return true; };
  ctx.window.api.archiveProjectSettings = async (...args) => { calls.push(args); return { ok: true }; };
  ctx.window.loadProjects = async () => {};
  ctx.sidebar.renderProjects([repo, worktree], true);
  ctx.document.querySelector('.worktree-hide-btn').click();
  await answerChoiceDialog(ctx);
  await settle();
  assert.deepEqual(calls, [[worktree.projectPath, worktree.folder]]);
  assert.equal(confirmed, 0);
});

test('the worktree Archive button reports a failed archive instead of reloading', async t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const worktree = { folder: 'wt-folder', projectPath: '/home/dev/myrepo/.claude/worktrees/agent-1', sessions: [] };
  ctx.window.api.archiveProjectSettings = async () => ({ error: 'disk full' });
  ctx.window.loadProjects = async () => { throw new Error('must not reload'); };
  ctx.sidebar.renderProjects([{ folder: 'repo', projectPath: '/home/dev/myrepo', sessions: [] }, worktree], true);
  ctx.document.querySelector('.worktree-hide-btn').click();
  await answerChoiceDialog(ctx);
  await settle();
  assert.match(ctx.document.querySelector('.modal-overlay').textContent, /disk full/);
});
