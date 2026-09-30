'use strict';

// Every ssh and scp the app starts goes through remote-ssh-binary.js (issue
// #359). Two halves:
//   1. A static enumeration: every child-process call in remote-*.js is
//      listed, and each one's program argument must be a resolver call. A new
//      call site, or one that names its program some other way, turns this red.
//   2. The default wiring, per operation: with SWITCHBOARD_SSH_PATH and
//      SWITCHBOARD_SCP_PATH set, the mirror, the watch channel, the remote
//      command runner (probe, stop, Changes) and the attach PTY all start the
//      binaries those variables name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const espree = require('espree');

const ROOT = path.join(__dirname, '..');

const SPAWNERS = new Set([
  'spawn', 'spawnFn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork', 'spawnPtyFn',
]);
// Local functions that take the program as their first argument and hand it to a spawner.
const WRAPPERS = { 'remote-transport.js': new Set(['run']) };
const RESOLVERS = new Set(['resolveSshPath', 'resolveScpPath']);

// file -> the program argument of each child-process call, in source order.
const EXPECTED_SITES = {
  'remote-attach.js': ['resolveSshPath()', 'resolveSshPath()'],
  'remote-transport.js': ['<run:command>', 'resolveSshPath()', 'resolveScpPath()', 'resolveSshPath()'],
  'remote-watch.js': ['resolveSshPath()'],
};

function parse(file) {
  return espree.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'), { ecmaVersion: 'latest', sourceType: 'script', loc: true });
}

// Walks the AST, handing each node its chain of enclosing function nodes.
function walk(node, visit, fns = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, fns);
  const isFn = /Function/.test(node.type);
  const nextFns = isFn ? [...fns, node] : fns;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit, nextFns));
    else if (v && typeof v.type === 'string') walk(v, visit, nextFns);
  }
}

const isChildProcessRequire = (n) => n.type === 'CallExpression' && n.callee.type === 'Identifier'
  && n.callee.name === 'require' && n.arguments[0] && n.arguments[0].value === 'child_process';

// `re.exec(s)` is a RegExp call; exec/execSync count only on child_process itself.
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return null;
  const name = callee.property.name;
  if (name === 'exec' || name === 'execSync') {
    const obj = callee.object;
    const onChildProcess = isChildProcessRequire(obj)
      || (obj.type === 'Identifier' && /^(cp|childProcess|child_process)$/.test(obj.name));
    return onChildProcess ? name : null;
  }
  return name;
}

function fnName(fn) {
  return fn.id ? fn.id.name : null;
}

function describeProgramArg(file, arg, fns) {
  if (!arg) return '<none>';
  if (arg.type === 'CallExpression' && arg.callee.type === 'Identifier' && RESOLVERS.has(arg.callee.name) && arg.arguments.length === 0) {
    return `${arg.callee.name}()`;
  }
  if (arg.type === 'Identifier') {
    const wrappers = WRAPPERS[file] || new Set();
    const owner = [...fns].reverse().find((f) => wrappers.has(fnName(f)));
    if (owner && owner.params[0] && owner.params[0].type === 'Identifier' && owner.params[0].name === arg.name) {
      return `<${fnName(owner)}:${arg.name}>`;
    }
    return `identifier ${arg.name}`;
  }
  if (arg.type === 'Literal') return `literal ${JSON.stringify(arg.value)}`;
  return arg.type;
}

function childProcessSites(file) {
  const wrappers = WRAPPERS[file] || new Set();
  const sites = [];
  walk(parse(file), (node, fns) => {
    if (node.type !== 'CallExpression') return;
    const name = calleeName(node.callee);
    if (!name || !(SPAWNERS.has(name) || wrappers.has(name))) return;
    // `require('child_process').spawn` is a reference, not a call; only calls reach here.
    sites.push({ line: node.loc.start.line, callee: name, program: describeProgramArg(file, node.arguments[0], fns) });
  });
  return sites;
}

function remoteModules() {
  return fs.readdirSync(ROOT).filter((f) => /^remote-.*\.js$/.test(f)).sort();
}

test('every child-process call in the remote modules names its program through the resolver', () => {
  const found = {};
  for (const file of remoteModules()) {
    const sites = childProcessSites(file);
    if (sites.length) found[file] = sites;
  }
  const programs = Object.fromEntries(Object.entries(found).map(([f, s]) => [f, s.map((x) => x.program)]));
  const where = Object.entries(found)
    .flatMap(([f, s]) => s.map((x) => `  ${f}:${x.line} ${x.callee}(${x.program}, …)`))
    .join('\n');
  assert.deepEqual(programs, EXPECTED_SITES, `child-process calls found:\n${where}`);
});

test('a remote module that starts a process imports the shared resolver', () => {
  for (const file of Object.keys(EXPECTED_SITES)) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(src, /require\('\.\/remote-ssh-binary'\)/, `${file} must take its resolver from remote-ssh-binary.js`);
  }
});

// remote-ssh-binary.js is the one place the names appear, as its last fallbacks.
test('no main-process module passes a bare ssh or scp program name to a call', () => {
  const files = [
    ...fs.readdirSync(ROOT).filter((f) => f.endsWith('.js') && f !== 'remote-ssh-binary.js'),
    ...fs.readdirSync(path.join(ROOT, 'workers')).filter((f) => f.endsWith('.js')).map((f) => `workers/${f}`),
  ];
  const offenders = [];
  for (const file of files) {
    walk(parse(file), (node) => {
      if (node.type !== 'CallExpression' || !node.arguments[0]) return;
      const a = node.arguments[0];
      const value = a.type === 'Literal' ? a.value
        : (a.type === 'TemplateLiteral' && a.expressions.length === 0 ? a.quasis[0].value.cooked : null);
      if (typeof value === 'string' && /^(ssh|scp)(\.exe)?$/i.test(value)) offenders.push(`${file}:${node.loc.start.line}`);
    });
  }
  assert.deepEqual(offenders, []);
});

// ── default wiring, per operation ──────────────────────────────────────────

const SSH = path.join(os.tmpdir(), 'switchboard-359', 'custom-ssh');
const SCP = path.join(os.tmpdir(), 'switchboard-359', 'custom-scp');

function withBinaryEnv(t) {
  const saved = { ssh: process.env.SWITCHBOARD_SSH_PATH, scp: process.env.SWITCHBOARD_SCP_PATH };
  process.env.SWITCHBOARD_SSH_PATH = SSH;
  process.env.SWITCHBOARD_SCP_PATH = SCP;
  t.after(() => {
    if (saved.ssh === undefined) delete process.env.SWITCHBOARD_SSH_PATH; else process.env.SWITCHBOARD_SSH_PATH = saved.ssh;
    if (saved.scp === undefined) delete process.env.SWITCHBOARD_SCP_PATH; else process.env.SWITCHBOARD_SCP_PATH = saved.scp;
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = () => {};
  return child;
}

/** Records the program of every spawn and closes the child with `code`. */
function closingSpawn(code = 0) {
  const cmds = [];
  const spawn = (cmd) => {
    cmds.push(cmd);
    const child = fakeChild();
    setImmediate(() => { child.stdout.push(null); child.emit('close', code); });
    return child;
  };
  spawn.cmds = cmds;
  return spawn;
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

test('the mirror inventory runs SWITCHBOARD_SSH_PATH', async (t) => {
  withBinaryEnv(t);
  const { createSshTransport } = require('../remote-transport');
  const spawn = closingSpawn(0);
  await createSshTransport({ spawn, log: silentLog }).listFiles('vps');
  assert.deepEqual(spawn.cmds, [SSH]);
});

test('the mirror file copy runs SWITCHBOARD_SCP_PATH', async (t) => {
  withBinaryEnv(t);
  const { createSshTransport } = require('../remote-transport');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-359-scp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spawn = closingSpawn(1);
  await createSshTransport({ spawn, log: silentLog }).fetchFiles('vps', ['-srv-a/a.jsonl'], dir);
  assert.deepEqual(spawn.cmds, [SCP]);
});

test('the mirror range fetch runs SWITCHBOARD_SSH_PATH', async (t) => {
  withBinaryEnv(t);
  const { createSshTransport } = require('../remote-transport');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-359-range-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '-srv-a'));
  fs.writeFileSync(path.join(dir, '-srv-a', 'a.jsonl'), 'x');
  const spawn = closingSpawn(1);
  await createSshTransport({ spawn, log: silentLog }).fetchIncremental('vps', [{ rel: '-srv-a/a.jsonl', offset: 1 }], dir);
  assert.deepEqual(spawn.cmds, [SSH]);
});

test('the watch channel runs SWITCHBOARD_SSH_PATH', (t) => {
  withBinaryEnv(t);
  const { createRemoteWatcher } = require('../remote-watch');
  const cmds = [];
  const spawn = (cmd) => { cmds.push(cmd); return fakeChild(); };
  const timers = { setTimeout: () => ({}), clearTimeout: () => {} };
  const watcher = createRemoteWatcher({ spawn, log: silentLog, timers });
  watcher.start('vps', () => {});
  watcher.stopAll();
  assert.deepEqual(cmds, [SSH]);
});

test('the remote command runner (probe, stop, Changes) runs SWITCHBOARD_SSH_PATH', async (t) => {
  withBinaryEnv(t);
  const { defaultRunRemoteCommand } = require('../remote-attach');
  const spawnFn = closingSpawn(0);
  await defaultRunRemoteCommand('vps', 'true', { spawnFn });
  assert.deepEqual(spawnFn.cmds, [SSH]);
});

test('the attach PTY runs SWITCHBOARD_SSH_PATH', async (t) => {
  withBinaryEnv(t);
  const { createTmuxAttachAdapter } = require('../remote-attach');
  const files = [];
  const pty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pid: 1 };
  const adapter = createTmuxAttachAdapter({
    spawnPty: (file) => { files.push(file); return pty; },
    runRemoteCommand: async () => ({ code: 0, stdout: '/tmp/tmux-0/default\u000180x24\u0001status off', stderr: '' }),
    log: silentLog,
  });
  const res = await adapter.attach('vps', { pid: 4242, tmux: 'main:@0.%0' }, { cols: 80, rows: 24 });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(files, [SSH]);
});
