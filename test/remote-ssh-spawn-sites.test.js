'use strict';

// see .ai/contexts/session-cache.md ("Remote hosts — ssh and scp binaries", the spawn-site test)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const espree = require('espree');
const eslintScope = require('eslint-scope');

const ROOT = path.join(__dirname, '..');

test('U20 GUARD: both trigger modules are included in the spawn-site inventory', () => {
  for (const file of ['trigger-watcher.js', 'trigger-context.js']) assert.ok(mainProcessFiles().includes(file));
});
const RESOLVER_MODULE = './remote-ssh-binary';
const RESOLVER_EXPORTS = new Set(['resolveSshPath', 'resolveScpPath']);
const CP_FUNCS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const PTY_FUNCS = new Set(['spawn']);
const SSH_NAME_RE = /(^|[\\/])(ssh|scp)(\.exe)?$/i;

// Spawners injected through options, invisible to the value analysis.
const INJECTED_SPAWNERS = { 'remote-attach.js': new Set(['spawnPtyFn']) };
// Wrappers that take the program as their first argument, called from other modules too.
const SPAWN_WRAPPERS = new Set(['runToExit', 'spawnPty']);

const HOW_TO_FIX = 'Route the program through resolveSshPath()/resolveScpPath() from remote-ssh-binary.js, '
  + 'or, when it is not ssh or scp, add its enclosing function to UNRESOLVED_ALLOWED with the reason.';

// Sites whose program is not ssh or scp and cannot be proven so statically — file -> enclosing function.
const UNRESOLVED_ALLOWED = {
  'main.js': {
    spawnPty: 'node-pty wrapper: the shell of a local session, or the attach adapter\'s resolved ssh',
    runScheduleCommand: 'the shell of the schedule\'s shell profile',
  },
  'run-to-exit.js': {
    runToExit: 'exported wrapper; its callers are covered by the program-name test below',
  },
};

// file -> the program of each resolver-backed site, in source order; a wrapper's site lists what its callers pass.
const EXPECTED_RESOLVER_SITES = {
  'remote-attach.js': ['resolveSshPath()', 'resolveSshPath()'],
  'remote-transport.js': ['resolveSshPath()|resolveScpPath()'],
  'remote-watch.js': ['resolveSshPath()'],
};

function mainProcessFiles() {
  return [
    ...fs.readdirSync(ROOT).filter((f) => f.endsWith('.js') && f !== 'remote-ssh-binary.js'),
    ...fs.readdirSync(path.join(ROOT, 'workers')).filter((f) => f.endsWith('.js')).map((f) => `workers/${f}`),
  ].sort();
}

function analyse(file, source) {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true, range: true });
  const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script' });
  (function link(node, parent) {
    node.parent = parent;
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && link(c, node));
      else if (v && typeof v.type === 'string') link(v, node);
    }
  })(ast, null);
  // Identifier node -> the variable it declares or refers to.
  const variables = new Map();
  for (const scope of scopeManager.scopes) {
    for (const v of scope.variables) for (const id of v.identifiers) variables.set(id, v);
    for (const r of scope.references) if (r.resolved) variables.set(r.identifier, r.resolved);
  }
  return { ast, variables, file };
}

function variableOf(ctx, id) {
  return ctx.variables.get(id) || null;
}

const V = {
  module: (name) => ({ k: 'module', name }),
  cpfn: { k: 'cpfn' },
  resolver: (name) => ({ k: 'resolver', name }),
  sshLiteral: (value) => ({ k: 'ssh-literal', value }),
  literal: (value) => ({ k: 'literal', value }),
  unknown: (why) => ({ k: 'unknown', why }),
};

function stringValue(s) {
  return SSH_NAME_RE.test(s) ? V.sshLiteral(s) : V.literal(s);
}

// The part of `init` that a destructuring pattern binds to `id`, as a list of property keys.
function patternPath(pattern, id, trail = []) {
  if (pattern === id) return trail;
  if (pattern.type === 'AssignmentPattern') return patternPath(pattern.left, id, trail);
  if (pattern.type === 'ObjectPattern') {
    for (const p of pattern.properties) {
      if (p.type === 'RestElement') { if (patternPath(p.argument, id, trail)) return [...trail, '*']; continue; }
      const key = p.computed ? '*' : (p.key.type === 'Identifier' ? p.key.name : String(p.key.value));
      const found = patternPath(p.value, id, [...trail, key]);
      if (found) return found;
    }
  }
  if (pattern.type === 'ArrayPattern') {
    for (const el of pattern.elements) {
      const found = el && patternPath(el, id, [...trail, '*']);
      if (found) return found;
    }
  }
  return null;
}

function patternDefault(pattern, id) {
  if (pattern.type === 'AssignmentPattern' && pattern.left === id) return pattern.right;
  for (const key of ['properties', 'elements']) {
    for (const p of pattern[key] || []) {
      if (!p) continue;
      const sub = p.type === 'Property' ? p.value : p;
      const d = patternDefault(sub, id);
      if (d) return d;
    }
  }
  if (pattern.type === 'AssignmentPattern') return patternDefault(pattern.left, id);
  return null;
}

function member(values, prop) {
  return values.map((v) => {
    if (v.k === 'module' && v.name === 'child_process' && CP_FUNCS.has(prop)) return V.cpfn;
    if (v.k === 'module' && v.name === 'node-pty' && PTY_FUNCS.has(prop)) return V.cpfn;
    if (v.k === 'module' && v.name === RESOLVER_MODULE && RESOLVER_EXPORTS.has(prop)) return V.resolver(prop);
    return V.unknown(`member ${prop}`);
  });
}

function evaluate(ctx, node, seen = new Set()) {
  if (!node) return [V.unknown('none')];
  if (seen.has(node)) return [V.unknown('cycle')];
  seen = new Set(seen).add(node);
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? [stringValue(node.value)] : [V.literal(node.value)];
    case 'TemplateLiteral':
      return node.expressions.length === 0 ? [stringValue(node.quasis[0].value.cooked)] : [V.unknown('template')];
    case 'LogicalExpression':
      return [...evaluate(ctx, node.left, seen), ...evaluate(ctx, node.right, seen)];
    case 'ConditionalExpression':
      return [...evaluate(ctx, node.consequent, seen), ...evaluate(ctx, node.alternate, seen)];
    case 'SequenceExpression':
      return evaluate(ctx, node.expressions[node.expressions.length - 1], seen);
    case 'AssignmentExpression':
      return evaluate(ctx, node.right, seen);
    case 'AwaitExpression':
      return evaluate(ctx, node.argument, seen);
    case 'MemberExpression': {
      if (node.computed && !(node.property.type === 'Literal' && typeof node.property.value === 'string')) return [V.unknown('computed')];
      const prop = node.computed ? node.property.value : node.property.name;
      if (prop === 'execPath' && node.object.type === 'Identifier' && node.object.name === 'process' && !variableOf(ctx, node.object)) {
        return [V.literal('process.execPath')];
      }
      return member(evaluate(ctx, node.object, seen), prop);
    }
    case 'CallExpression': {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0] && node.arguments[0].type === 'Literal') {
        return [V.module(String(node.arguments[0].value).replace(/^node:/, ''))];
      }
      if (isPathJoin(ctx, node) && node.arguments.length) return evaluate(ctx, node.arguments[node.arguments.length - 1], seen);
      const callee = evaluate(ctx, node.callee, seen);
      const resolver = callee.find((v) => v.k === 'resolver');
      return resolver ? [V.resolver(resolver.name)] : [V.unknown('call')];
    }
    case 'Identifier':
      return evaluateIdentifier(ctx, node, seen);
    default:
      return [V.unknown(node.type)];
  }
}

// path.join(..., 'name') names the program by its last segment.
function isPathJoin(ctx, call) {
  const c = call.callee;
  if (c.type !== 'MemberExpression' || c.computed || !['join', 'resolve'].includes(c.property.name)) return false;
  return evaluate(ctx, c.object).some((v) => v.k === 'module' && v.name === 'path');
}

function evaluateIdentifier(ctx, id, seen) {
  const variable = variableOf(ctx, id);
  if (!variable || variable.defs.length === 0) return [V.unknown(`global ${id.name}`)];
  const out = [];
  for (const def of variable.defs) {
    if (def.type === 'Variable') {
      const decl = def.node;
      const trail = patternPath(decl.id, def.name);
      let values = decl.init ? evaluate(ctx, decl.init, seen) : [V.unknown('uninitialised')];
      for (const key of trail || []) values = key === '*' ? values.map(() => V.unknown('rest')) : member(values, key);
      out.push(...values);
      const d = patternDefault(decl.id, def.name);
      if (d) out.push(...evaluate(ctx, d, seen));
    } else if (def.type === 'Parameter') {
      out.push(...evaluateParameter(ctx, def, seen));
    } else if (def.type === 'FunctionName' || def.type === 'ClassName') {
      out.push(V.unknown('function'));
    } else {
      out.push(V.unknown(def.type));
    }
  }
  for (const ref of variable.references) {
    if (ref.isWrite() && ref.writeExpr && !variable.defs.some((d) => d.name === ref.identifier)) {
      out.push(...evaluate(ctx, ref.writeExpr, seen));
    }
  }
  return out;
}

function functionBinding(ctx, fn) {
  if (fn.id) return variableOf(ctx, fn.id);
  const p = fn.parent;
  if (p && p.type === 'VariableDeclarator' && p.id.type === 'Identifier') return variableOf(ctx, p.id);
  return null;
}

function evaluateParameter(ctx, def, seen) {
  const fn = def.node;
  const index = fn.params.findIndex((p) => p === def.name || patternPath(p, def.name));
  const param = fn.params[index];
  const out = [];
  const d = param && patternDefault(param, def.name);
  if (d) out.push(...evaluate(ctx, d, seen));
  const binding = functionBinding(ctx, fn);
  const calls = binding
    ? binding.references.map((r) => r.identifier.parent).filter((n, i) => n.type === 'CallExpression' && n.callee === binding.references[i].identifier)
    : [];
  if (!calls.length || !param) { out.push(V.unknown(`parameter ${def.name.name}`)); return out; }
  const trail = patternPath(param, def.name);
  for (const call of calls) {
    let values = evaluate(ctx, call.arguments[index], seen);
    for (const key of trail) values = key === '*' ? values.map(() => V.unknown('rest')) : member(values, key);
    out.push(...values);
  }
  return out;
}

function enclosingFunctionName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (!/Function/.test(n.type)) continue;
    if (n.id) return n.id.name;
    const p = n.parent;
    if (p && p.type === 'VariableDeclarator' && p.id.type === 'Identifier') return p.id.name;
    if (p && p.type === 'Property' && !p.computed && p.key.type === 'Identifier') return p.key.name;
  }
  return '<top>';
}

function describeProgram(ctx, arg) {
  const values = evaluate(ctx, arg);
  const ssh = values.find((v) => v.k === 'ssh-literal');
  if (ssh) return { verdict: 'bypass', label: `literal ${JSON.stringify(ssh.value)}` };
  if (arg && arg.type === 'CallExpression') {
    const r = values.find((v) => v.k === 'resolver');
    if (r) return { verdict: 'resolver', label: `${r.name}()` };
  }
  if (values.every((v) => v.k === 'resolver')) return { verdict: 'resolver', label: [...new Set(values.map((v) => `${v.name}()`))].join('|') };
  if (values.every((v) => v.k === 'literal' || v.k === 'resolver')) return { verdict: 'other', label: values.map((v) => v.value || `${v.name}()`).join('|') };
  return { verdict: 'unresolved', label: values.filter((v) => v.k === 'unknown').map((v) => v.why).join(', ') };
}

// A call that starts a process, by value (a child_process/node-pty function) or by name (a spawner or a known wrapper).
function isSpawnCall(ctx, node) {
  const injected = INJECTED_SPAWNERS[ctx.file] || new Set();
  const c = node.callee;
  const name = c.type === 'Identifier' ? c.name
    : (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' ? c.property.name : null);
  // exec/execSync by name alone would match RegExp#exec; those need the value analysis.
  const byName = injected.has(name) || SPAWN_WRAPPERS.has(name) || (CP_FUNCS.has(name) && name !== 'exec' && name !== 'execSync');
  return byName || evaluate(ctx, c).some((v) => v.k === 'cpfn');
}

function programNameOffenders(file, source = fs.readFileSync(path.join(ROOT, file), 'utf8')) {
  const ctx = analyse(file, source);
  const offenders = [];
  (function visit(node) {
    if (node.type === 'CallExpression' && node.arguments[0] && isSpawnCall(ctx, node)) {
      const ssh = evaluate(ctx, node.arguments[0]).find((v) => v.k === 'ssh-literal');
      if (ssh) offenders.push(`  ${file}:${node.loc.start.line} ${JSON.stringify(ssh.value)}`);
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && visit(c));
      else if (v && typeof v.type === 'string') visit(v);
    }
  })(ctx.ast);
  return offenders;
}

function spawnSites(file, source = fs.readFileSync(path.join(ROOT, file), 'utf8')) {
  const ctx = analyse(file, source);
  const injected = INJECTED_SPAWNERS[file] || new Set();
  const sites = [];
  (function visit(node) {
    if (node.type === 'CallExpression') {
      const isInjected = node.callee.type === 'Identifier' && injected.has(node.callee.name);
      if (isInjected || evaluate(ctx, node.callee).some((v) => v.k === 'cpfn')) {
        const d = describeProgram(ctx, node.arguments[0]);
        sites.push({ file, line: node.loc.start.line, fn: enclosingFunctionName(node), ...d });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && visit(c));
      else if (v && typeof v.type === 'string') visit(v);
    }
  })(ctx.ast);
  return sites;
}

function violations(sites) {
  return sites.filter((s) => s.verdict === 'bypass'
    || (s.verdict === 'unresolved' && !(UNRESOLVED_ALLOWED[s.file] && UNRESOLVED_ALLOWED[s.file][s.fn])));
}

const fmt = (s) => `  ${s.file}:${s.line} in ${s.fn}: ${s.verdict} (${s.label})`;

test('no main-process spawn runs ssh or scp except through the resolver', () => {
  const all = mainProcessFiles().flatMap((f) => spawnSites(f));
  const bad = violations(all);
  assert.deepEqual(bad.map(fmt), [], `${HOW_TO_FIX}\nEvery spawn site:\n${all.map(fmt).join('\n')}`);
});

test('no spawning call in a main-process module passes an ssh or scp program name', () => {
  const offenders = mainProcessFiles().flatMap((f) => programNameOffenders(f));
  assert.deepEqual(offenders, [], `${HOW_TO_FIX}\nCalls that start ssh or scp by name:\n${offenders.join('\n')}`);
});

test('the resolver-backed spawn sites are exactly the listed ones', () => {
  const found = {};
  for (const file of mainProcessFiles()) {
    const sites = spawnSites(file).filter((s) => s.verdict === 'resolver');
    if (sites.length) found[file] = sites.map((s) => s.label);
  }
  assert.deepEqual(found, EXPECTED_RESOLVER_SITES,
    'A resolver-backed site was added, removed or changed: update EXPECTED_RESOLVER_SITES to match, after checking the change is intended.');
});

test('each allowed unresolved site still exists, so the list cannot go stale', () => {
  for (const [file, fns] of Object.entries(UNRESOLVED_ALLOWED)) {
    const sites = spawnSites(file).filter((s) => s.verdict === 'unresolved');
    for (const fn of Object.keys(fns)) {
      assert.ok(sites.some((s) => s.fn === fn),
        `${file} ${fn} no longer has an unresolved spawn: remove it from UNRESOLVED_ALLOWED, or rename the entry if the function was renamed.`);
    }
  }
});

// The scanner itself: each of these bypasses must be reported.
const BYPASSES = {
  'a destructuring rename of spawn': ["const { spawn: sp } = require('child_process');", "function go() { return sp('ssh', []); }"],
  'a member call on the require result': ["function go(bin) { return require('child_process').spawn(bin, []); }", "go('scp');"],
  'a template literal program': ["const cp = require('child_process');", 'function go() { return cp.execFile(`ssh`, []); }'],
  'a constant holding the name': ["const { execFile } = require('child_process');", "const BIN = 'ssh';", 'execFile(BIN, []);'],
  'an absolute path literal': ["const cp = require('child_process');", "cp.spawn('/usr/bin/ssh', []);"],
  'a program read from elsewhere': ["const cp = require('child_process');", 'cp.spawn(process.env.X, []);'],
  'an alias of the module': ["const cp = require('child_process');", 'const c2 = cp;', 'c2.spawnSync(\'scp\');'],
  'the node: prefix': ["const { spawn } = require('node:child_process');", "spawn(process.env.SWITCHBOARD_SSH_PATH || '/usr/local/bin/ssh2', []);"],
  'the node: prefix with an ssh literal': ["const cp = require('node:child_process');", "cp.execFileSync('ssh', []);"],
};

for (const [name, lines] of Object.entries(BYPASSES)) {
  test(`the scanner reports ${name}`, () => {
    const sites = spawnSites('fixture.js', lines.join('\n'));
    assert.equal(sites.length, 1, JSON.stringify(sites));
    assert.equal(violations(sites).length, 1, fmt(sites[0]));
  });
}

test('the scanner reads node:path like path', () => {
  const src = ["const path = require('node:path');", "const { spawn } = require('node:child_process');", "spawn(path.join('/opt', 'ssh'), []);"].join('\n');
  assert.deepEqual(spawnSites('fixture.js', src).map((s) => s.verdict), ['bypass']);
});

test('the scanner accepts process.execPath as a program', () => {
  const src = ["const { execFile } = require('child_process');", "execFile(process.execPath, ['-e', '']);"].join('\n');
  const sites = spawnSites('fixture.js', src);
  assert.deepEqual(sites.map((s) => s.verdict), ['other']);
  assert.deepEqual(violations(sites), []);
});

test('the program-name check ignores a call that starts no process', () => {
  const src = ["const s = 'x';", "String(s).endsWith('ssh');", "console.log('ssh');", "[].includes('scp');"].join('\n');
  assert.deepEqual(programNameOffenders('fixture.js', src), []);
});

test('the program-name check flags ssh passed to a known wrapper from another module', () => {
  const src = ["const { runToExit } = require('./run-to-exit');", "runToExit('ssh', [], {});"].join('\n');
  assert.equal(programNameOffenders('fixture.js', src).length, 1);
});

test('the scanner accepts the resolver behind an injectable default', () => {
  const src = [
    "const { resolveSshPath: defaultResolve } = require('./remote-ssh-binary');",
    'function make(opts = {}) {',
    '  const spawn = opts.spawn || require(\'child_process\').spawn;',
    '  const resolveSshPath = opts.resolveSshPath || defaultResolve;',
    '  return () => spawn(resolveSshPath(), []);',
    '}',
  ].join('\n');
  const sites = spawnSites('fixture.js', src);
  assert.deepEqual(sites.map((s) => s.verdict), ['resolver']);
});

// ── default wiring, per operation ──────────────────────────────────────────

const { resetResolvedBinaries } = require('../remote-ssh-binary');
const SSH = path.join(os.tmpdir(), 'switchboard-359', 'custom-ssh');
const SCP = path.join(os.tmpdir(), 'switchboard-359', 'custom-scp');

function withBinaryEnv(t) {
  const saved = { ssh: process.env.SWITCHBOARD_SSH_PATH, scp: process.env.SWITCHBOARD_SCP_PATH };
  process.env.SWITCHBOARD_SSH_PATH = SSH;
  process.env.SWITCHBOARD_SCP_PATH = SCP;
  resetResolvedBinaries();
  t.after(() => {
    if (saved.ssh === undefined) delete process.env.SWITCHBOARD_SSH_PATH; else process.env.SWITCHBOARD_SSH_PATH = saved.ssh;
    if (saved.scp === undefined) delete process.env.SWITCHBOARD_SCP_PATH; else process.env.SWITCHBOARD_SCP_PATH = saved.scp;
    resetResolvedBinaries();
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = () => {};
  return child;
}

/** Records every spawn and closes the child with `code`. */
function closingSpawn(code = 0) {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    const child = fakeChild();
    setImmediate(() => { child.stdout.push(null); child.emit('close', code); });
    return child;
  };
  spawn.calls = calls;
  spawn.cmds = () => calls.map((c) => c.cmd);
  return spawn;
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

test('the mirror inventory runs SWITCHBOARD_SSH_PATH', async (t) => {
  withBinaryEnv(t);
  const { createSshTransport } = require('../remote-transport');
  const spawn = closingSpawn(0);
  await createSshTransport({ spawn, log: silentLog }).listFiles('vps');
  assert.deepEqual(spawn.cmds(), [SSH]);
});

test('the mirror file copy runs SWITCHBOARD_SCP_PATH, which runs SWITCHBOARD_SSH_PATH through -S', async (t) => {
  withBinaryEnv(t);
  const { createSshTransport } = require('../remote-transport');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-359-scp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spawn = closingSpawn(1);
  await createSshTransport({ spawn, log: silentLog }).fetchFiles('vps', ['-srv-a/a.jsonl'], dir);
  assert.deepEqual(spawn.cmds(), [SCP]);
  const args = spawn.calls[0].args;
  const s = args.indexOf('-S');
  assert.ok(s !== -1, `scp argv must carry -S: ${JSON.stringify(args)}`);
  assert.equal(args[s + 1], SSH);
  assert.ok(s < args.indexOf('vps:.claude/projects/-srv-a/a.jsonl'), '-S is an option, before the operands');
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
  assert.deepEqual(spawn.cmds(), [SSH]);
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
  assert.deepEqual(spawnFn.cmds(), [SSH]);
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
