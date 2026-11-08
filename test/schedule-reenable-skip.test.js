'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runner = require('../src/main/schedules/schedule-runner');
const { reenableScheduleFiles } = require('../archived-projects');

function fixture(t, catchUp = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reenable-792-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const commands = path.join(project, '.claude', 'commands');
  fs.mkdirSync(commands, { recursive: true });
  const file = path.join(commands, 'schedule-a.md');
  fs.writeFileSync(file, `---\ncron: 15 9 * * *\nenabled: false\ncatch-up: ${catchUp}\n---\nPrompt`);
  const stateDir = path.join(root, 'state');
  if (catchUp) {
    fs.mkdirSync(stateDir);
    runner.claimScheduleMinute(stateDir, runner.scheduleStateKey({ filePath: file }), Math.floor(Date.now() / 60000) * 60000 - 180000, { file });
  }
  const deps = { scheduleProjects: () => ({ list: async () => [project] }), stateDir };
  return { project, file, stateDir, deps };
}

test('set-schedule-enabled skips missed catch-up minutes and non-catch-up creates no state', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 8, 9, 16, 30).getTime() });
  assert.equal(typeof runner.setListedScheduleEnabled, 'function', 'the listed-path enable operation exists');
  const h = fixture(t);
  const baseline = Math.floor(Date.now() / 60000) * 60000 - 60000;
  assert.equal((await runner.setListedScheduleEnabled(h.file, true, h.deps)).ok, true);
  const state = runner.readScheduleStateOnly(h.stateDir).get(runner.scheduleStateKey({ filePath: h.file }));
  assert.ok(state.handled >= baseline, 'missed minutes have been handled');
  assert.equal(runner.latestCronMatch('* * * * *', state.handled, baseline), null, 'a following catch-up check finds no missed minute');
  const isolation = process.env.SWITCHBOARD_DATA_DIR;
  delete process.env.SWITCHBOARD_DATA_DIR;
  const runs = [];
  try {
    const stop = runner.startScheduler({ info() {}, warn() {}, error() {} }, (...args) => runs.push(args), { stateDir: h.stateDir, projects: () => [h.project] });
    stop();
    assert.equal(runs.length, 0, 'the following scheduler catch-up check launches nothing');
  } finally { process.env.SWITCHBOARD_DATA_DIR = isolation; }
  const plain = fixture(t, false);
  assert.equal((await runner.setListedScheduleEnabled(plain.file, true, plain.deps)).ok, true);
  assert.equal(fs.existsSync(plain.stateDir), false);
  assert.equal((await runner.setListedScheduleEnabled(path.join(plain.project, 'outside.md'), true, plain.deps)).ok, false);
  assert.equal((await runner.setListedScheduleEnabled(plain.file, 'true', plain.deps)).ok, false);
});

test('the catch-up baseline exists before the enable write, including isolated instances', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 8, 9, 16, 30).getTime() });
  assert.equal(typeof runner.setListedScheduleEnabled, 'function', 'the listed-path enable operation exists');
  const h = fixture(t);
  const result = await runner.setListedScheduleEnabled(h.file, true, { ...h.deps,
    setEnabled(file, enabled, opts) {
      const state = runner.readScheduleStateOnly(h.stateDir).get(runner.scheduleStateKey({ filePath: file }));
      assert.ok(state, 'baseline precedes enabling');
      const baseline = Math.floor(Date.now() / 60000) * 60000 - 60000;
      assert.equal(runner.latestCronMatch('* * * * *', state.handled, baseline), null);
      const result = runner.setScheduleEnabled(file, enabled, opts);
      const isolation = process.env.SWITCHBOARD_DATA_DIR;
      delete process.env.SWITCHBOARD_DATA_DIR;
      const runs = [];
      try {
        const stop = runner.startScheduler({ info() {}, warn() {}, error() {} }, (...args) => runs.push(args), { stateDir: h.stateDir, projects: () => [h.project] });
        stop();
        assert.equal(runs.length, 0, 'a catch-up check after the write cannot run a missed minute');
      } finally { process.env.SWITCHBOARD_DATA_DIR = isolation; }
      return result;
    },
  });
  assert.equal(result.ok, true);
});

test('offered and Undo catch-up schedules skip missed minutes before re-enabling', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 8, 9, 16, 30).getTime() });
  const h = fixture(t);
  assert.deepEqual(reenableScheduleFiles([h.file], h.project, { stateDir: h.stateDir }), { enabled: ['schedule-a.md'], failed: [] });
  const handled = runner.readScheduleStateOnly(h.stateDir).get(runner.scheduleStateKey({ filePath: h.file })).handled;
  assert.ok(handled >= Math.floor(Date.now() / 60000) * 60000 - 60000, 'offered schedules receive a baseline');
});

test('the enable IPC wires listing guards and instance state through main and preload', async t => {
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const h = fixture(t);
  const filename = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf("ipcMain.handle('set-schedule-enabled'");
  const end = source.indexOf("ipcMain.handle('list-schedules'", start);
  assert.ok(start >= 0 && end > start, 'main registers the guarded enable operation');
  const handlers = new Map();
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    require: createRequire(filename), scheduleProjects: h.deps.scheduleProjects,
    path, DB_PATH: path.join(path.dirname(h.stateDir), 'db'),
  }, { filename, lineOffset: source.slice(0, start).split('\n').length - 1 });
  const result = await handlers.get('set-schedule-enabled')({}, h.file, true);
  assert.equal(result.ok, true);
  assert.ok(runner.readScheduleStateOnly(path.join(path.dirname(h.stateDir), 'schedule-state'))
    .has(runner.scheduleStateKey({ filePath: h.file })), 'main passes this instance state directory');
  assert.equal((await handlers.get('set-schedule-enabled')({}, path.join(h.project, 'outside.md'), true)).ok, false);
  let api;
  const calls = [];
  const preload = path.join(__dirname, '..', 'preload.js');
  vm.runInNewContext(fs.readFileSync(preload, 'utf8'), {
    process: { platform: process.platform, argv: [] },
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
        ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true }; }, on() {}, send() {}, removeListener() {} } };
    },
  }, { filename: preload });
  assert.equal(typeof api.setScheduleEnabled, 'function');
  assert.equal((await api.setScheduleEnabled(h.file, false)).ok, true);
  assert.deepEqual(calls, [['set-schedule-enabled', h.file, false]]);
});
