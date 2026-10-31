'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { extractFunction } = require('./app-source');
const { trackWindowsPty, killPty } = require('../src/main/terminals/pty-ops');
const { performance } = require('node:perf_hooks');
const espree = require('espree');

test('main reads only supervisor and worker PIDs from the disposable daemon roster, best effort', async () => {
  const filename = require.resolve('../main'), source = fs.readFileSync(filename, 'utf8');
  assert.ok(/function readWindowsDaemonPids\(/.test(source), 'main must supply roster PIDs to termination');
  const path = require('node:path'), os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-roster-897g-'));
  const roster = path.join(home, '.claude', 'daemon', 'roster.json');
  fs.mkdirSync(path.dirname(roster), { recursive: true });
  const context = vm.createContext({ fs, path, os: { homedir: () => home },
    require: name => { assert.equal(name, './bg-agents'); return { getDaemonRosterPath: () => roster }; } });
  vm.runInContext(extractFunction(source, 'readWindowsDaemonPids'), context, { filename });
  try {
    assert.deepEqual(Array.from(await context.readWindowsDaemonPids()), []);
    fs.writeFileSync(roster, '{');
    assert.deepEqual(Array.from(await context.readWindowsDaemonPids()), []);
    const supervisor = { pid: 901, procStart: '133000000000000000' };
    const worker = { pid: 902, procStart: '133000000000000001' };
    fs.writeFileSync(roster, JSON.stringify({ supervisorPid: supervisor.pid, supervisorProcStart: supervisor.procStart,
      workers: { a: worker, b: { pid: -1 }, c: { pid: 904 } }, unrelatedPid: 903 }));
    assert.deepEqual(JSON.parse(JSON.stringify(await context.readWindowsDaemonPids())), [supervisor, worker]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('background roster getter follows the configured service path', () => {
  const bgAgents = require('../bg-agents');
  const path = require('node:path'), os = require('node:os');
  const custom = path.join(os.tmpdir(), 'sb-roster-h', 'custom.json');
  bgAgents.init({ daemonRosterPath: custom });
  assert.equal(bgAgents.getDaemonRosterPath(), custom);
  bgAgents.init({ jobsDir: path.join(os.tmpdir(), 'sb-roster-h', 'jobs') });
  assert.equal(bgAgents.getDaemonRosterPath(), path.join(os.tmpdir(), 'sb-roster-h', 'daemon', 'roster.json'));
  bgAgents.stop();
});

test('main warms the helper off the close path and registers only foreground local spawns before wiring exit', () => {
  const filename = require.resolve('../main'), source = fs.readFileSync(filename, 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', range: true });
  const nodes = [];
  function walk(node, parents = []) {
    if (!node || typeof node !== 'object') return;
    if (node.type) nodes.push({ node, parents });
    for (const [key, value] of Object.entries(node)) {
      if (key === 'range') continue;
      if (Array.isArray(value)) value.forEach(child => walk(child, [...parents, node]));
      else if (value && typeof value === 'object') walk(value, [...parents, node]);
    }
  }
  walk(ast);
  const registrations = nodes.filter(({ node }) => node.type === 'CallExpression' && node.callee.name === 'trackWindowsPty');
  assert.equal(registrations.length, 1, 'main must register the local PTY it just spawned');
  const { node: registration, parents } = registrations[0];
  assert.ok(parents.some(n => n.type === 'IfStatement' && source.slice(...n.test.range) === '!isAttach'));
  const handler = parents.findLast(n => n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration');
  const calls = nodes.filter(({ node }) => node.type === 'CallExpression' && node.range[0] > handler.range[0] && node.range[1] < handler.range[1]);
  const spawns = calls.filter(({ node }) => node.callee.name === 'spawnPty');
  assert.equal(spawns.length, 2);
  assert.ok(spawns.every(({ node }) => node.range[1] < registration.range[0]));
  const warms = nodes.filter(({ node }) => node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'start'
    && node.callee.object.callee?.name === 'configureWindowsJobHelper');
  assert.equal(warms.length, 1);
  const warm = warms[0];
  assert.equal(warm.node.callee.object.arguments[1]?.name, 'readWindowsDaemonPids', 'main must pass roster evidence to the helper');
  assert.ok(!calls.includes(warm), 'spawn handler must not wait for helper startup');
  assert.ok(!warm.parents.some(n => n.type === 'AwaitExpression'), 'helper startup must be non-blocking');
  assert.ok(warm.parents.some(n => n.type === 'CallExpression' && source.slice(...n.callee.range) === 'app.whenReady().then'),
    'helper must warm at app ready');
  assert.ok(calls.some(({ node }) => node.callee.name === 'wireSessionPty' && node.range[0] > registration.range[1]));
});

test('real shutdown function closes three PTYs synchronously and flushes within the 1500ms budget without a helper reply', async () => {
  const events = [], sessions = new Map();
  for (let i = 0; i < 3; i++) {
    let drain;
    const session = { kind: 'local-pty', exitDrain: new Promise(resolve => { drain = resolve; }) };
    session.pty = { pid: 897 + i, _agent: {}, onExit() {}, kill() { events.push(`pty-${i}`); queueMicrotask(drain); } };
    await trackWindowsPty(session.pty, { platform: 'win32', jobs: {
      assign: async () => true, terminate: () => new Promise(() => {}), release: async () => true,
    } });
    sessions.set(String(i), session);
  }
  const record = name => async () => { events.push(name); };
  const filename = require.resolve('../main');
  const source = fs.readFileSync(filename, 'utf8');
  const context = vm.createContext({ Promise, Map, setTimeout, clearTimeout,
    shutdownPromise: null, appQuitting: false, shutdownComplete: false, TRACE: {}, updateInstalling: false,
    log: { error: (...args) => events.push(args.join(' ')) }, stopNonDatabaseResources() {},
    closedSessions: new Map(), activeSessions: sessions, killPty: (session, id) => killPty(session, id, { platform: 'win32' }),
    writer: { beginShutdown: fn => fn(), releaseLiveSession: record('release-row') },
    flushProjectsBeforeExit: record('projects'), flushWindowBounds: record('bounds'),
    sessionCache: { shutdownProducers: record('producers') }, sessionTransitions: { drainMetadataWrites: record('metadata') },
    activityFlushedForQuit: false, activityReporter: { flush: record('activity'), stop() {} },
    projectsClient: { shutdown: record('projects-worker') }, fileListsClient: { shutdown: record('files-worker') },
    searchClient: { shutdown: record('search-worker') }, closeDb: record('db'), activityTrace: { close() {} },
    stopWorkersForExit: async () => true,
  });
  vm.runInContext(extractFunction(source, 'boundedShutdown'), context, { filename });
  vm.runInContext(extractFunction(source, 'shutdownForExit'), context, { filename });
  const start = performance.now();
  await context.shutdownForExit();
  const elapsedMs = performance.now() - start;
  assert.deepEqual(events.slice(0, 3), ['pty-0', 'pty-1', 'pty-2']);
  assert.ok(events.includes('projects')); assert.equal(events.filter(e => e === 'release-row').length, 3);
  assert.ok(events.includes('db')); assert.equal(context.shutdownComplete, true);
  assert.ok(elapsedMs < 1500, `${elapsedMs}ms`);
  assert.ok(!events.some(e => e.includes('timed out')));
});
