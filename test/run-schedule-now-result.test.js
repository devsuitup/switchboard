'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { extractFunction } = require('./app-source');

function setup(t, { sandbox = false, platform = 'linux', refused = [], spawnError, syncError, archived = false, noReply = false, deferSpawn = false, windowState = 'open' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-run-result-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.claude', 'commands', 'schedule-test.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nname: test\n---\nDo the task');
  const handlers = new Map(), children = [], events = [], messages = [];
  const log = { info() {}, warn() {}, error() {} };
  const ctx = vm.createContext({
    getSetting: () => ({}), isProjectSettingsArchived: () => archived, Date,
    mainWindow: windowState === 'absent' ? null : {
      isDestroyed: () => windowState === 'destroyed',
      webContents: { isDestroyed: () => windowState === 'contents-destroyed', send: (...args) => messages.push(args) },
    },
    SETTING_DEFAULTS: { shellProfile: 'test', sandbox: false },
    resolveShell: () => ({ path: 'test-shell' }),
    quoteArgvForShell: (_shell, args) => args.join(' '), shellArgs: (_shell, cmd) => [cmd],
    cleanPtyEnv: {}, resolveScheduleSandbox: () => sandbox, process: { platform },
    sandboxScriptPath: () => '/sandbox.sh', scheduleProjects: () => ({ list: async () => [root] }),
    scheduleBindRefusals: () => refused, os, sandboxBindEnv: () => '', encodeProjectPath: () => 'project',
    cpSpawn: () => {
      if (syncError) throw new Error(syncError);
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      children.push(child);
      if (!deferSpawn) queueMicrotask(() => {
        events.push(spawnError ? 'error' : 'spawn');
        child.emit(spawnError ? 'error' : 'spawn', ...(spawnError ? [new Error(spawnError)] : []));
      });
      return child;
    },
    cliSessionState: { trackScheduleRun() {} }, activityReporter: { sessionStarted() {}, sessionEnded() {} }, log,
  });
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const source = main.replace(/^    (async )?function runScheduleCommand/m, '$1function runScheduleCommand');
  const slice = extractFunction(source, 'runScheduleCommand');
  const lineOffset = source.slice(0, source.indexOf(slice)).split('\n').length - 1;
  vm.runInContext(slice, ctx, { filename: path.join(__dirname, '../main.js'), lineOffset, columnOffset: 0 });
  const localRequire = createRequire(path.join(__dirname, '../schedule-ipc.js'));
  const ipc = vm.createContext({
    require: name => name === 'electron' ? { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } }
      : name === './schedule-runner' ? {
        parseFrontmatter: localRequire(name).parseFrontmatter,
        createScheduleSession: () => ({ sessionId: 'manual-session' }),
        buildScheduleCommand: () => ({ claudeArgs: ['--resume', 'manual-session', '--add-dir', '/refused'] }),
      } : localRequire(name),
    module: { exports: {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../schedule-ipc.js'), 'utf8'), ipc, { filename: path.join(__dirname, '../schedule-ipc.js') });
  ctx.scheduleIpc = ipc.module.exports;
  ipc.module.exports.init(log, noReply ? async () => undefined : ctx.runScheduleCommand, () => true, () => false);
  return { run: () => handlers.get('run-schedule-now')(null, file),
    cron: () => ctx.runScheduleCommand(['--resume', 'cron-session'], root, 'Nightly cron', () => {}),
    children, events, messages, root };
}

test('Run now returns a Linux sandbox refusal with recovery and never spawns', async t => {
  const h = setup(t, { sandbox: true, platform: 'win32' });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /sandbox.*Linux/i);
  assert.match(result.error, /disable.*sandbox|turn.*sandbox.*off/i);
  assert.equal(h.children.length, 0);
});

test('Run now returns refused add-dirs with the offending path and recovery', async t => {
  const h = setup(t, { sandbox: true, refused: [{ dir: '/refused', reason: 'protected path' }] });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /add-dirs.*\/refused.*protected path/i);
  assert.match(result.error, /remove|change/i);
  assert.equal(h.children.length, 0);
});

test('Run now returns a late archive refusal from the launcher', async t => {
  const h = setup(t, { archived: true });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /archived.*unarchive/i);
  assert.equal(h.children.length, 0);
});

test('Run now returns a synchronous spawn failure with recovery', async t => {
  const h = setup(t, { syncError: 'spawn EACCES' });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /spawn EACCES/);
  assert.match(result.error, /shell.*project.*Run now/i);
});

test('Run now returns an asynchronous spawn error before answering IPC', async t => {
  const h = setup(t, { spawnError: 'spawn ENOENT' });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /spawn ENOENT/);
  assert.match(result.error, /shell.*project.*Run now/i);
  assert.deepEqual(h.events, ['error']);
});

test('Run now acknowledges success only after the child spawn event', async t => {
  const h = setup(t, { deferSpawn: true });
  let answered = false;
  const pending = h.run().then(result => { answered = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(answered, false, 'IPC must wait for the spawn acknowledgement');
  h.children[0].emit('spawn');
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'manual-session');
  h.children[0].emit('exit', 1);
  assert.equal(result.ok, true);
});

test('Run now refuses a missing launcher acknowledgement', async t => {
  const h = setup(t, { noReply: true });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /no.*result|no.*reply|acknowledg/i);
});

test('Run now exit 127 sends its schedule, exit code and PATH diagnosis after launch', async t => {
  const h = setup(t);
  assert.equal((await h.run()).ok, true);
  h.children[0].emit('exit', 127);
  assert.equal(h.messages.length, 1, 'the exit failure must reach the renderer');
  const [channel, payload] = h.messages[0];
  assert.equal(channel, 'schedule-run-exit');
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    name: 'test', manual: true, projectPath: h.root, sessionId: 'manual-session',
    code: 127, signal: null, failure: 'claude-path',
  });
});

test('Run now exit 1 still notifies after ten seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const h = setup(t);
  await h.run();
  t.mock.timers.tick(10_000);
  h.children[0].emit('exit', 1);
  assert.equal(h.messages.length, 1, 'long runs must not lose their failure notice');
  assert.equal(h.messages[0][1].code, 1);
  assert.equal(h.messages[0][1].failure, 'exit');
});

test('successful Run now and cron exits stay silent', async t => {
  const h = setup(t);
  await h.run();
  h.children[0].emit('exit', 0);
  await h.cron();
  h.children[1].emit('exit', 0);
  assert.deepEqual(h.messages, []);
});

test('cron sandbox failure sends the same exit IPC with a sandbox diagnosis', async t => {
  const h = setup(t, { sandbox: true });
  await h.cron();
  h.children[0].stderr.emit('data', Buffer.from('bwrap: creating new namespace failed'));
  h.children[0].emit('exit', 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0][1].name, 'Nightly cron');
  assert.equal(h.messages[0][1].sessionId, 'cron-session');
  assert.equal(h.messages[0][1].manual, false);
  assert.equal(h.messages[0][1].failure, 'sandbox');
});

for (const stderr of [
  'spawn claude ENOENT',
  "'claude' is not recognized as an internal or external command",
  "claude: The term 'claude' is not recognized as a name of a cmdlet",
  'claude: command not found',
]) {
  test(`shell lookup failure includes a PATH diagnosis: ${stderr}`, async t => {
    const h = setup(t, { platform: 'win32' });
    await h.run();
    h.children[0].stderr.emit('data', Buffer.from(stderr));
    h.children[0].emit('exit', 1);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0][1].failure, 'claude-path');
  });
}

for (const [stderr, sandbox, code, failure] of [
  ['claude-sandbox: bwrap not found — install bubblewrap', true, 125, 'sandbox'],
  ['/home/u/.claude/hooks/pre.sh: line 2: jq: command not found', false, 1, 'exit'],
  ['Error: settings file /home/u/.claude/settings.json not found', false, 1, 'exit'],
  ['claude-sandbox: claude not found in PATH (/usr/bin)', true, 125, 'claude-path'],
  ['claude-sandbox: setup failed\nclaude: command not found', true, 127, 'sandbox'],
  ["'claude' n'est pas reconnu en tant que commande interne ou externe", false, 1, 'exit'],
]) {
  test(`exit diagnosis targets the command, not a path or sandbox dependency: ${stderr}`, async t => {
    const h = setup(t, { sandbox });
    await h.cron();
    h.children[0].stderr.emit('data', Buffer.from(stderr));
    h.children[0].emit('exit', code);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0][1].failure, failure);
  });
}

test('a signal termination reports its signal', async t => {
  const h = setup(t);
  await h.run();
  h.children[0].emit('exit', null, 'SIGTERM');
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0][1].signal, 'SIGTERM');
});

for (const windowState of ['absent', 'destroyed', 'contents-destroyed']) {
  test(`exit failure without a usable window stays log-only: ${windowState}`, async t => {
    const h = setup(t, { windowState });
    await h.cron();
    assert.doesNotThrow(() => h.children[0].emit('exit', 1));
    assert.deepEqual(h.messages, []);
  });
}
