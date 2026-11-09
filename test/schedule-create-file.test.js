'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const runner = require('../src/main/schedules/schedule-runner');

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-create-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fields = { name: 'Nightly: review', slug: 'nightly', cron: '0 0 29 2 *', prompt: 'Review\r\nthe project', cli: { model: 'sonnet', 'max-budget-usd': '1.5', 'append-system-prompt': 'Be thorough', 'allowed-tools': 'Read,Glob' } };
  const deps = { scheduleProjects: () => ({ list: async () => [root] }), stateDir: path.join(root, 'state'), runsDir: path.join(root, 'runs'), getSetting: () => null };
  const create = (values = fields, overrides = {}) => {
    assert.equal(typeof runner.createScheduleFile, 'function', 'runner exports the creation boundary');
    return runner.createScheduleFile(root, values, { ...deps, ...overrides });
  };
  return { root, fields, deps, create };
}

test('creation round trips every field through the runner with LF and defaults', async t => {
  const h = setup(t);
  const result = await h.create({ ...h.fields, 'catch-up': true });
  assert.equal(result.ok, true, result.error);
  const bytes = fs.readFileSync(result.filePath, 'utf8');
  assert.equal(bytes.includes('\r'), false);
  const parsed = runner.parseFrontmatter(bytes);
  assert.equal(parsed.meta.name, h.fields.name);
  assert.equal(parsed.meta.enabled, 'true');
  assert.equal(parsed.meta['catch-up'], 'true');
  assert.deepEqual(parsed.meta.cli, h.fields.cli);
  assert.equal(parsed.body, 'Review\nthe project');
  assert.ok(runner.buildScheduleCommand('id', { cli: parsed.meta.cli }).claudeArgs.includes('auto'));
  assert.deepEqual(fs.readdirSync(path.dirname(result.filePath)), ['schedule-nightly.md']);
});

for (const [field, value] of [['name', ''], ['name', 'one\ntwo'], ['name', 'x\0'], ['slug', '../oops'], ['slug', 'a'.repeat(65)], ['cron', '* * * * 7'], ['cron', '0 0 30 2 *'], ['prompt', '  '], ['cli.model', 'x\ny'], ['cli.max-budget-usd', '-1'], ['cli.add-dirs', ['/one,two']], ['cli.append-system-prompt', 'x\ny']]) {
  test(`rejects ${field}=${JSON.stringify(value)} before writing`, async t => {
    const h = setup(t);
    const fields = { ...h.fields, cli: { ...h.fields.cli } };
    if (field.startsWith('cli.')) fields.cli[field.slice(4)] = value;
    else fields[field] = value;
    const result = await h.create(fields);
    assert.equal(result.ok, false);
    assert.equal(result.field, field);
    assert.equal(fs.existsSync(path.join(h.root, '.claude')), false);
  });
}

test('refuses unregistered and archived projects before writing', async t => {
  const h = setup(t);
  assert.equal((await h.create(h.fields, { scheduleProjects: () => ({ list: async () => [] }) })).field, 'projectPath');
  assert.match((await h.create(h.fields, { isArchived: () => true })).error, /unarchive it first/i);
  assert.equal(fs.existsSync(path.join(h.root, '.claude')), false);
});

test('existing effective slug and link-time collision preserve the winner and remove temp files', async t => {
  const h = setup(t);
  const dir = path.join(h.root, '.claude', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'schedule-other.md'), '---\nslug: nightly\ncron: * * * * *\n---\nPrompt');
  assert.equal((await h.create()).field, 'slug');
  fs.unlinkSync(path.join(dir, 'schedule-other.md'));
  const result = await h.create(h.fields, { link: (_tmp, target) => { fs.writeFileSync(target, 'winner'); const error = new Error('collision'); error.code = 'EEXIST'; throw error; } });
  assert.equal(result.ok, false);
  assert.equal(result.field, 'slug');
  assert.equal(fs.readFileSync(path.join(dir, 'schedule-nightly.md'), 'utf8'), 'winner');
  assert.deepEqual(fs.readdirSync(dir), ['schedule-nightly.md']);
});

for (const code of ['EPERM', 'ENOTSUP', 'ENOSYS']) test(`hard-link ${code} is refused without a leftover temp`, async t => {
  const h = setup(t);
  const result = await h.create(h.fields, { link: () => { const error = new Error(code); error.code = code; throw error; } });
  assert.equal(result.ok, false);
  assert.equal(result.field, 'projectPath', 'unsupported hard links must focus the project');
  assert.match(result.error, /this project.s filesystem does not support hard links/i);
  assert.match(result.error, new RegExp(code));
  assert.deepEqual(fs.readdirSync(path.join(h.root, '.claude', 'commands')), []);
});

test('creation shares sandbox refusals and permits home add-dirs without a sandbox', async t => {
  const h = setup(t);
  const fields = { ...h.fields, cli: { 'add-dirs': [path.join(h.root, '.git')] } };
  for (const platform of ['win32', 'linux']) {
    const expected = runner.scheduleLaunchRefusal({ sandbox: true, platform, addDirs: fields.cli['add-dirs'], projectPaths: [h.root], home: h.root, cwd: h.root });
    const result = await h.create(fields, { getSetting: () => ({ sandbox: true }), platform, home: h.root });
    assert.equal(result.ok, false);
    assert.equal(result.error, expected.error);
    assert.equal(result.field, platform === 'linux' ? 'cli.add-dirs' : 'projectPath', 'sandbox platform refusal must focus the project');
  }
  assert.equal((await h.create(fields, { platform: 'linux', home: h.root })).ok, true);
});

test('creation prunes only the new key stale catch-up and result records', async t => {
  const h = setup(t);
  const key = runner.scheduleStateKey({ filePath: path.join(h.root, '.claude', 'commands', 'schedule-nightly.md') });
  const otherKey = runner.scheduleStateKey({ filePath: path.join(h.root, '.claude', 'commands', 'schedule-weekly.md') });
  const otherState = `${otherKey}-60000.json`;
  const otherResult = `${otherKey}-60000-12345678-1234-1234-1234-123456789abc.json`;
  fs.mkdirSync(h.deps.stateDir);
  fs.mkdirSync(h.deps.runsDir);
  fs.writeFileSync(path.join(h.deps.stateDir, `${key}-60000.json`), JSON.stringify({ key, minuteMs: 60000 }));
  fs.writeFileSync(path.join(h.deps.runsDir, `${key}-60000-12345678-1234-1234-1234-123456789abc.json`), '{}');
  fs.writeFileSync(path.join(h.deps.runsDir, 'other'), 'keep');
  fs.writeFileSync(path.join(h.deps.stateDir, otherState), JSON.stringify({ key: otherKey, minuteMs: 60000 }));
  fs.writeFileSync(path.join(h.deps.runsDir, otherResult), '{}');
  assert.equal((await h.create()).ok, true);
  assert.deepEqual(fs.readdirSync(h.deps.stateDir), [otherState], 'another schedule catch-up record survives');
  assert.deepEqual(fs.readdirSync(h.deps.runsDir).sort(), [otherResult, 'other'].sort(), 'another schedule result survives');
});

for (const directory of ['stateDir', 'runsDir']) test(`creation stays successful when ${directory} cleanup throws EACCES after publication`, async t => {
  const h = setup(t);
  const filename = path.join(__dirname, '../src/main/schedules/schedule-runner.js');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const warnings = [];
  const denied = () => { const error = new Error('injected cleanup denied'); error.code = 'EACCES'; throw error; };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process, console: { ...console, warn: (...args) => warnings.push(args.join(' ')) },
    require: name => name === 'fs' ? { ...fs, readdirSync: candidate => candidate === h.deps.stateDir && directory === 'stateDir' ? denied() : fs.readdirSync(candidate) }
      : name === './schedule-run-results' && directory === 'runsDir' ? { pruneScheduleRunResults: denied } : nativeRequire(name),
  }, { filename });
  const result = await module.exports.createScheduleFile(h.root, h.fields, h.deps);
  assert.equal(result.ok, true, 'publication must stay successful after cleanup EACCES');
  assert.equal(result.filePath, path.join(h.root, '.claude', 'commands', 'schedule-nightly.md'));
  assert.equal(runner.parseFrontmatter(fs.readFileSync(result.filePath, 'utf8')).meta.slug, 'nightly');
  assert.deepEqual(fs.readdirSync(path.dirname(result.filePath)), ['schedule-nightly.md']);
  assert.equal(warnings.length, 1, 'cleanup failure is logged once');
  assert.match(warnings[0], /EACCES/);
});

test('a redirected commands directory is refused without publication', async t => {
  const h = setup(t);
  const filename = path.join(__dirname, '../src/main/schedules/schedule-runner.js');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process,
    require: name => name === 'fs' ? { ...fs, realpathSync: candidate => candidate === path.join(h.root, '.claude', 'commands') ? path.join(h.root, 'outside') : fs.realpathSync(candidate) } : nativeRequire(name),
  }, { filename });
  assert.equal(typeof module.exports.createScheduleFile, 'function');
  const result = await module.exports.createScheduleFile(h.root, h.fields, h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.field, 'projectPath');
  assert.match(result.error, /linked/);
  assert.deepEqual(fs.readdirSync(path.join(h.root, '.claude', 'commands')), []);
});

test('main creation channel uses registry and instance state, and preload forwards both arguments', async t => {
  const h = setup(t);
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf("ipcMain.handle('create-schedule-file'");
  assert.ok(start >= 0, 'main registers creation');
  const end = source.indexOf("ipcMain.handle('set-schedule-enabled'", start);
  assert.ok(end > start);
  const handlers = new Map();
  vm.runInNewContext(source.slice(start, end), { ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    require: createRequire(filename), path, DB_PATH: path.join(h.root, 'switchboard.db'),
    scheduleProjects: h.deps.scheduleProjects, getSetting: () => null,
    SETTING_DEFAULTS: { sandbox: false }, isProjectSettingsArchived: () => false,
  }, { filename, lineOffset: source.slice(0, start).split('\n').length - 1 });
  assert.equal((await handlers.get('create-schedule-file')(null, h.root, h.fields)).ok, true);
  let api;
  const calls = [];
  const preload = path.join(__dirname, '../preload.js');
  vm.runInNewContext(fs.readFileSync(preload, 'utf8'), { process: { argv: [], platform: process.platform }, require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); }, on() {} }, webUtils: {} };
  } }, { filename: preload });
  assert.equal(typeof api.createScheduleFile, 'function');
  await api.createScheduleFile(h.root, h.fields);
  assert.deepEqual(calls, [['create-schedule-file', h.root, h.fields]]);
});
