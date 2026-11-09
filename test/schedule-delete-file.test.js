'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const runner = require('../src/main/schedules/schedule-runner');
const results = require('../src/main/schedules/schedule-run-results');

function backend() {
  const filename = path.join(__dirname, '../src/main/schedules/schedule-delete-file.js');
  assert.ok(fs.existsSync(filename), 'schedule deletion backend exists');
  return require(filename);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delete-schedule-792-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const commands = path.join(projectRoot, '.claude', 'commands');
  fs.mkdirSync(commands, { recursive: true });
  const filePath = path.join(commands, 'schedule-job.md');
  const content = '---\ncron: * * * * *\ncatch-up: true\n---\nPrompt';
  fs.writeFileSync(filePath, content);
  const stateDir = path.join(root, 'schedule-state');
  const runsDir = results.scheduleRunsDir(root);
  const deps = { projectRoot, stateDir, runsDir, scheduleProjects: () => ({ list: async () => [projectRoot] }) };
  const key = runner.scheduleStateKey({ filePath });
  const otherKey = runner.scheduleStateKey({ filePath: filePath + '-other' });
  const id = '11111111-1111-4111-8111-111111111111';
  return { root, projectRoot, commands, filePath, content, stateDir, runsDir, deps, key, otherKey, id };
}

test('deleting an unlinked listed file prunes its catch-up records without touching other keys or transcripts', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.stateDir);
  for (const name of [`${f.key}-60000.json`, `${f.key}-120000.json`, `${f.otherKey}-60000.json`, `${f.key}-notes.json`]) {
    fs.writeFileSync(path.join(f.stateDir, name), '{}');
  }
  const transcript = path.join(f.root, 'past-run.jsonl');
  fs.writeFileSync(transcript, '{"scheduleSlug":"job","type":"assistant"}\n');
  const before = fs.readFileSync(transcript);
  assert.equal((await backend().deleteListedScheduleFile(f.filePath, f.deps)).ok, true);
  assert.equal(fs.existsSync(f.filePath), false);
  assert.deepEqual(fs.readdirSync(f.stateDir).sort(), [`${f.otherKey}-60000.json`, `${f.key}-notes.json`].sort());
  assert.deepEqual(fs.readFileSync(transcript), before);
  fs.writeFileSync(f.filePath, f.content);
  assert.equal(runner.readScheduleStateOnly(f.stateDir).has(f.key), false, 'recreated schedule inherits no catch-up baseline');
});

test('deletion reuses the run-result prune with zero retention and a recreated path inherits no results', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.runsDir);
  for (const name of [`${f.key}-60000-${f.id}.json`, `${f.key}-120000-${f.id}.json`, `${f.otherKey}-60000-${f.id}.json`]) {
    fs.writeFileSync(path.join(f.runsDir, name), '{}');
  }
  const prune = results.pruneScheduleRunResults;
  const calls = [];
  t.mock.method(results, 'pruneScheduleRunResults', (...args) => { calls.push(args); return prune(...args); });
  assert.equal((await backend().deleteListedScheduleFile(f.filePath, f.deps)).ok, true);
  assert.deepEqual(calls, [[f.runsDir, f.key, 0]], 'reuse the existing per-key prune');
  assert.deepEqual(fs.readdirSync(f.runsDir), [`${f.otherKey}-60000-${f.id}.json`]);
  fs.writeFileSync(f.filePath, f.content);
  assert.equal(fs.readdirSync(f.runsDir).some(name => name.startsWith(f.key + '-')), false);
});

test('the reusable helper rechecks the link guard before unlinking and preserves all files on refusal', t => {
  const f = fixture(t);
  const realpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', candidate => candidate === f.filePath ? path.join(f.root, 'source.md') : realpath(candidate));
  const reply = backend().deleteScheduleFile(f.filePath, f.deps);
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'linked file: edit it at its source');
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), f.content);
});

test('a file symlink is refused and its source stays intact', async t => {
  const f = fixture(t);
  const source = path.join(f.root, 'source.md');
  fs.renameSync(f.filePath, source);
  try { fs.symlinkSync(source, f.filePath, 'file'); }
  catch (error) { t.skip(`file symlink unavailable: ${error.code}`); return; }
  const reply = await backend().deleteListedScheduleFile(f.filePath, f.deps);
  assert.equal(reply.error, 'linked file: edit it at its source');
  assert.equal(fs.lstatSync(f.filePath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(source, 'utf8'), f.content);
});

test('only exact listed paths from the current registry may be deleted', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'schedule-outside.md');
  const ordinary = path.join(f.commands, 'ordinary.md');
  fs.writeFileSync(outside, f.content);
  fs.writeFileSync(ordinary, f.content);
  let projects = [f.projectRoot];
  const deps = { ...f.deps, scheduleProjects: () => ({ list: async () => projects }) };
  for (const candidate of [outside, ordinary, f.filePath.replace('schedule-job.md', '../commands/schedule-job.md'), null, 42]) {
    assert.equal((await backend().deleteListedScheduleFile(candidate, deps)).ok, false, `refuse ${candidate}`);
  }
  projects = [];
  assert.equal((await backend().deleteListedScheduleFile(f.filePath, deps)).ok, false, 'refresh registry at call time');
  for (const candidate of [outside, ordinary, f.filePath]) assert.equal(fs.existsSync(candidate), true);
});

test('deletion needs no registry or window in its reusable helper and creates no missing state directories', t => {
  const f = fixture(t);
  assert.equal(backend().deleteScheduleFile(f.filePath, { projectRoot: f.projectRoot, stateDir: f.stateDir, runsDir: f.runsDir }).ok, true);
  assert.equal(fs.existsSync(f.filePath), false);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.equal(fs.existsSync(f.runsDir), false);
});

test('unlink errors return a failure and retain catch-up state', t => {
  const f = fixture(t);
  fs.mkdirSync(f.stateDir);
  const record = path.join(f.stateDir, `${f.key}-60000.json`);
  fs.writeFileSync(record, '{}');
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', candidate => {
    if (candidate === f.filePath) throw new Error('unlink denied');
    return unlink(candidate);
  });
  assert.deepEqual(backend().deleteScheduleFile(f.filePath, f.deps), { ok: false, error: 'unlink denied' });
  assert.equal(fs.existsSync(record), true);
});

test('main deletion channel uses the guarded helper and instance directories; preload forwards the exact argument', async t => {
  const f = fixture(t);
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf("ipcMain.handle('delete-schedule-file'");
  assert.ok(start >= 0, 'main registers schedule deletion');
  const end = source.indexOf("ipcMain.handle('list-schedules'", start);
  assert.ok(end > start);
  const handlers = new Map();
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, require: createRequire(filename), path,
    DB_PATH: path.join(f.root, 'switchboard.db'), scheduleProjects: f.deps.scheduleProjects,
  }, { filename, lineOffset: source.slice(0, start).split('\n').length - 1 });
  assert.equal((await handlers.get('delete-schedule-file')(null, f.filePath)).ok, true);
  assert.equal(fs.existsSync(f.filePath), false);
  let api;
  const calls = [];
  const preload = path.join(__dirname, '../preload.js');
  vm.runInNewContext(fs.readFileSync(preload, 'utf8'), { process: { argv: [], platform: process.platform }, require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); }, on() {} }, webUtils: {} };
  } }, { filename: preload });
  assert.equal(typeof api.deleteScheduleFile, 'function');
  await api.deleteScheduleFile(f.filePath);
  assert.deepEqual(calls, [['delete-schedule-file', f.filePath]]);
});
