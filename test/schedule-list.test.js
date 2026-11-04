'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const runner = require('../src/main/schedules/schedule-runner');
const { encodeProjectPath } = require('../encode-project-path');

function fixture(t) {
  assert.equal(typeof runner.listScheduleFiles, 'function');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-792-list-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const commands = path.join(project, '.claude', 'commands');
  fs.mkdirSync(commands, { recursive: true });
  const stateDir = path.join(root, 'state');
  const deps = { getSetting: () => ({}), defaultSandbox: false, home: root, platform: 'linux' };
  const write = (name, front = 'cron: * * * * *', body = 'Prompt') => {
    const file = path.join(commands, `schedule-${name}.md`);
    fs.writeFileSync(file, `---\n${front}\n---\n${body}`);
    return file;
  };
  const list = () => runner.listScheduleFiles([project], deps);
  const build = async (extra = {}) => {
    const { buildScheduleList } = require('../src/main/schedules/schedule-list');
    return buildScheduleList({ ...deps, stateDir, projectsDir: path.join(root, 'transcripts'),
      scheduleProjects: () => ({ list: async () => [project] }), getCachedByFolder: () => [],
      isScheduleRunLive: () => false, isArchived: () => false, isKnownProject: () => true,
      catchUpActive: true, now: () => Date.parse('2026-11-03T12:00Z'), ...extra });
  };
  return { root, project, commands, stateDir, deps, write, list, build };
}

test('listing retains disabled, no-cron, CRLF and empty-prompt files', t => {
  const f = fixture(t);
  f.write('off', 'cron: * * * * *\nenabled: false');
  f.write('no-cron', 'name: Missing');
  const crlf = f.write('crlf');
  fs.writeFileSync(crlf, fs.readFileSync(crlf, 'utf8').replace(/\n/g, '\r\n'));
  f.write('empty', 'cron: * * * * *', '');
  const rows = f.list();
  assert.equal(rows.length, 4);
  assert.equal(rows.find(r => r.file === 'schedule-off.md').enabled, false);
  assert.ok(rows.find(r => r.file === 'schedule-no-cron.md').problems.includes('no cron'));
  assert.ok(rows.find(r => r.file === 'schedule-crlf.md').problems.some(p => p.includes('front matter not read') && p.includes('save with LF line endings')));
  assert.ok(rows.find(r => r.file === 'schedule-empty.md').problems.includes('no prompt'));
});

test('quoted false remains enabled as in the runner', t => {
  const f = fixture(t);
  f.write('quoted', 'cron: * * * * *\nenabled: "false"');
  assert.equal(f.list()[0].enabled, true);
  assert.equal(runner.scanSchedules(null, [f.project]).length, 1);
});

test('impossible cron analysis does not confuse leap day with a short horizon', t => {
  const f = fixture(t);
  ['0 0 30 2 *', '* * * * 7', '* 1-10/2 * * *', '0 0 29 2 *'].forEach((cron, i) => f.write(String(i), `cron: ${cron}`));
  const rows = f.list();
  assert.deepEqual(rows.map(r => r.problems.includes('cron can never match')), [true, true, true, false]);
});

test('catch-up listing never creates the missing state directory', async t => {
  const f = fixture(t);
  f.write('catch', 'cron: * * * * *\ncatch-up: true');
  const reply = await f.build();
  assert.equal(reply.catchUpActive, true);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test('catch-up uses the injected flag with the environment unset', async t => {
  const f = fixture(t);
  f.write('catch', 'cron: * * * * *\ncatch-up: true');
  const saved = process.env.SWITCHBOARD_DATA_DIR;
  delete process.env.SWITCHBOARD_DATA_DIR;
  try {
    const off = await f.build({ catchUpActive: false });
    const on = await f.build({ catchUpActive: true });
    assert.equal(off.projects[0].schedules[0].catchUpDueMs, null);
    assert.equal(on.projects[0].schedules[0].catchUpDueMs, on.now);
  } finally {
    if (saved === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = saved;
  }
});

test('duplicate effective slugs mark both files', t => {
  const f = fixture(t);
  f.write('same');
  f.write('other', 'cron: * * * * *\nslug: same');
  const rows = f.list();
  assert.ok(rows.every(r => r.problems.some(p => p.startsWith('slug shared with schedule-'))));
});

test('sandbox problems share the launch refusal text and rules', t => {
  const f = fixture(t);
  f.write('sandbox', `cron: * * * * *\ncli:\n  add-dirs: ${path.join(f.root, 'private')}`);
  f.deps.defaultSandbox = true;
  f.deps.platform = 'win32';
  let row = f.list()[0];
  assert.ok(row.problems.includes('sandbox needs Linux'));
  const win = runner.scheduleLaunchRefusal({ sandbox: true, platform: 'win32' });
  assert.match(win.error, /requires Linux \(bubblewrap\)/);
  f.deps.platform = 'linux';
  row = f.list()[0];
  const addDirs = [path.join(f.root, 'private')];
  const refused = runner.scheduleLaunchRefusal({ sandbox: true, platform: 'linux', addDirs, projectPaths: [f.project], home: f.root, cwd: f.project });
  assert.ok(row.problems.some(p => p.startsWith('add-dirs refused:') && refused.error.includes(p.slice('add-dirs refused: '.length))));
  assert.equal(runner.scheduleLaunchRefusal({ sandbox: false, addDirs }), null);
});

test('runs from registry and realpath folders are combined once, newest first, capped at twenty', async t => {
  const f = fixture(t);
  f.write('job');
  const alias = path.join(f.root, 'alias');
  try { fs.symlinkSync(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (err) { t.skip(`directory link unavailable: ${err.code}`); return; }
  const a = encodeProjectPath(alias), b = encodeProjectPath(f.project);
  const rows = Array.from({ length: 22 }, (_, i) => ({ sessionId: `s${i}`, scheduleSlug: 'job', created: new Date(1700000000000 + i * 60000).toISOString(), messageCount: 1 }));
  const folders = new Map([[a, rows.slice(0, 11)], [b, [...rows.slice(11), rows[10], { sessionId: 'ordinary', created: rows[0].created }]]]);
  const reply = await f.build({ scheduleProjects: () => ({ list: async () => [alias] }), getCachedByFolder: folder => folders.get(folder) || [] });
  const runs = reply.projects[0].schedules[0].runs;
  assert.equal(runs.length, 20);
  assert.deepEqual(runs.map(r => r.sessionId), rows.slice(2).reverse().map(r => r.sessionId));
  assert.ok(runs.every(r => r.result === null));
});

test('replied requires an assistant record, including message-role format', async t => {
  const f = fixture(t);
  f.write('job');
  const folder = encodeProjectPath(f.project);
  const transcripts = path.join(f.root, 'transcripts', folder);
  fs.mkdirSync(transcripts, { recursive: true });
  const records = [{ type: 'user' }, { type: 'user' }];
  for (const [id, extra] of [['users', []], ['assistant', [{ type: 'assistant' }]], ['role', [{ type: 'message', role: 'assistant' }]]]) {
    fs.writeFileSync(path.join(transcripts, `${id}.jsonl`), [...records, ...extra].map(r => JSON.stringify(r)).join('\n'));
  }
  const rows = ['users', 'assistant', 'role'].map(sessionId => ({ sessionId, scheduleSlug: 'job', messageCount: 2, created: '2026-11-03T00:00Z' }));
  const reply = await f.build({ getCachedByFolder: () => rows });
  const runs = reply.projects[0].schedules[0].runs;
  assert.equal(runs.find(r => r.sessionId === 'users').replied, false);
  assert.equal(runs.find(r => r.sessionId === 'assistant').replied, true);
  assert.equal(runs.find(r => r.sessionId === 'role').replied, true);
});

test('running uses injected liveness and the read-only export follows child release', async t => {
  const f = fixture(t);
  f.write('job');
  const row = { sessionId: 'live', scheduleSlug: 'job', created: '2026-11-03T00:00Z', messageCount: 1 };
  const reply = await f.build({ getCachedByFolder: () => [row], isScheduleRunLive: id => id === 'live' });
  assert.equal(reply.projects[0].schedules[0].runs[0].running, true);
  const state = require('../cli-session-state');
  assert.equal(typeof state.isScheduleRunLive, 'function');
  const child = new EventEmitter();
  state.trackScheduleRun('LiVe', child, f.project, 'job');
  try { assert.equal(state.isScheduleRunLive('LIVE'), true); }
  finally { child.emit('exit'); }
  assert.equal(state.isScheduleRunLive('live'), false);
});

test('project flags, linked files, catch-up record and ahead-clock baseline remain read-only', async t => {
  const f = fixture(t);
  const file = f.write('job', 'cron: * * * * *\ncatch-up: true');
  const key = crypto.createHash('sha256').update(file).digest('hex').slice(0, 16);
  const now = Date.parse('2026-11-03T12:00Z');
  fs.mkdirSync(f.stateDir);
  fs.writeFileSync(path.join(f.stateDir, `${key}-${now}.json`), '{}');
  const bytes = fs.readFileSync(file);
  const reply = await f.build({ isArchived: () => true, isKnownProject: () => false });
  assert.equal(reply.now, now);
  assert.equal(reply.projects[0].archived, true);
  assert.equal(reply.projects[0].known, false);
  assert.equal(reply.projects[0].schedules[0].catchUpDueMs, null);
  assert.equal(reply.projects[0].schedules[0].nextRunMs, now + 60000);
  fs.renameSync(path.join(f.stateDir, `${key}-${now}.json`), path.join(f.stateDir, `${key}-${now + 60000}.json`));
  assert.equal((await f.build()).projects[0].schedules[0].catchUpDueMs, now);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.readdirSync(f.stateDir).length, 1);
  const source = path.join(f.root, 'source.md');
  fs.writeFileSync(source, bytes);
  fs.unlinkSync(file);
  try { fs.symlinkSync(source, file); }
  catch (err) { t.diagnostic(`file symlink unavailable: ${err.code}`); return; }
  assert.equal(f.list()[0].linked, true);
});

test('preload listSchedules invokes the registered backend channel', async () => {
  let api;
  const calls = [];
  const filename = path.join(__dirname, '..', 'preload.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { process: { argv: [], platform: process.platform }, require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve('listed'); }, on() {} }, webUtils: {} };
  } }, { filename });
  assert.equal(typeof api.listSchedules, 'function');
  assert.equal(await api.listSchedules(), 'listed');
  assert.deepEqual(calls, [['list-schedules']]);
});

test('main registers list-schedules with the real backend and instance dependencies', async t => {
  const f = fixture(t);
  f.write('job');
  const filename = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf("ipcMain.handle('list-schedules'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n}));', start) + '\n}));'.length;
  const handlers = new Map();
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    buildScheduleList: require('../src/main/schedules/schedule-list').buildScheduleList,
    scheduleProjects: () => ({ list: async () => [f.project] }), getCachedByFolder: () => [],
    cliSessionState: { isScheduleRunLive: () => false }, process: { env: { SWITCHBOARD_DATA_DIR: 'isolated' } },
    path, DB_PATH: path.join(f.root, 'db'), PROJECTS_DIR: path.join(f.root, 'transcripts'),
    getSetting: f.deps.getSetting, SETTING_DEFAULTS: { sandbox: false },
    isProjectSettingsArchived: () => true, isKnownProjectRoot: () => false,
  }, { filename, lineOffset: source.slice(0, start).split('\n').length - 1 });
  const reply = await handlers.get('list-schedules')();
  assert.equal(reply.catchUpActive, false);
  assert.equal(reply.projects[0].archived, true);
  assert.equal(reply.projects[0].known, false);
  assert.equal(reply.projects[0].schedules[0].file, 'schedule-job.md');
});
