'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { extractFunction } = require('../app-source');
const { createWindowsJobHelper } = require('../../src/main/terminals/windows-job-helper');
const { trackWindowsPty, releaseWindowsPty, guardPtyInputErrors, killPty } = require('../../pty-ops');
const keepAlive = setInterval(() => {}, 1000);

function observer(pid) {
  let dead = false;
  const alive = () => {
    if (dead) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') { dead = true; return false; } if (error.code === 'EPERM') return null; throw error; }
  };
  alive.pid = pid;
  return alive;
}

async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (predicate()) return true; await delay(25); }
  return predicate();
}

async function run(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-job-native-'));
  const terms = [], helpers = [], hidden = [];
  const expiryGate = path.join(dir, 'expire');
  const cliEntry = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(cliEntry), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'pty-background-agent.cjs'), cliEntry);
  let protectedPids = [];
  function helper() {
    let child;
    const stderr = [];
    const helper = createWindowsJobHelper({ protectedPids: () => protectedPids, spawn(...args) {
      child = spawn(...args); helpers.push(child);
      child.stderr.on('data', data => { stderr.push(String(data)); console.error(String(data)); });
      child.on('exit', (code, signal) => console.log(JSON.stringify({ helperExit: child.pid, code, signal })));
      if (mode === 'helper-timeout') {
        const stdout = new PassThrough();
        child.stdout.on('data', data => { if (!String(data).includes(' delayed')) stdout.write(data); });
        return { stdout, stdin: child.stdin, stderr: child.stderr, on: child.on.bind(child),
          kill: child.kill.bind(child), unref: child.unref.bind(child) };
      }
      return child;
    },
      warn: message => console.error(message) });
    return { helper, child: () => child, stderr };
  }
  async function term(h, index, detached = false) {
    const nodePty = require(process.env.NODE_PTY_DIR);
    const gate = path.join(dir, `gate-${index}`), pidFile = path.join(dir, `pid-${index}`);
    const spawnTime = Date.now();
    const nodeRoot = ['helper-death', 'helper-timeout', 'pipe-eof'].includes(mode);
    const pty = guardPtyInputErrors(nodePty.spawn(nodeRoot ? process.execPath : path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      nodeRoot ? [path.join(__dirname, 'pty-job-parent.cjs'), 'root'] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'pty-hidden-root.ps1')],
      { cols: 80, rows: 24, useConptyDll: true, env: { ...process.env, FIXTURE_GATE: gate,
        FIXTURE_NODE: process.execPath, FIXTURE_CHILD: path.join(__dirname, detached ? 'pty-detached-parent.cjs' : 'pty-hidden-grandchild.cjs'),
        FIXTURE_PIDS: pidFile, FIXTURE_MODE: mode, FIXTURE_LIFETIME: '60000', FIXTURE_CLI_ENTRY: cliEntry,
        FIXTURE_FILES: __dirname, FIXTURE_EXPIRY_GATE: expiryGate } }));
    let drain;
    const session = { pty, kind: 'local-pty', exited: false, exitDrain: new Promise(resolve => { drain = resolve; }) };
    terms.push(session);
    pty.onData(() => {}); pty.onExit(() => { session.exited = true; drain(); });
    assert.equal(await trackWindowsPty(pty, { jobs: h.helper, spawnTime }), true, 'native root assignment must succeed');
    fs.writeFileSync(gate, 'go');
    assert.equal(await until(() => fs.existsSync(pidFile), 30000), true, 'root must publish owned PIDs');
    const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    const alive = observer(pids.grandchildPid); hidden.push(alive);
    assert.equal(alive(), true);
    console.log(JSON.stringify({ mode, rootPid: pty.pid, ...pids }));
    const daemon = pids.daemonPid && observer(pids.daemonPid);
    const daemonChild = pids.daemonChildPid && observer(pids.daemonChildPid);
    if (daemon) {
      hidden.push(daemon, daemonChild);
      assert.equal(daemon(), true); assert.equal(daemonChild(), true);
      assert.equal(await until(() => observer(pids.intermediatePid)() === false), true, 'intermediate must exit before close');
      if (mode === 'roster' || mode === 'stale-roster') {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-Process -Id ${pids.daemonPid}).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        const procStart = result.stdout.trim(); assert.match(procStart, /^\d{17,19}$/);
        protectedPids = [{ pid: pids.daemonPid, procStart: mode === 'roster' ? procStart : String(BigInt(procStart) - 10000000n) }];
      }
    }
    return { session, alive, daemon, daemonChild };
  }
  try {
    if (mode === 'parent-exit') {
      const file = path.join(dir, 'parent-pids');
      const parent = spawn(process.execPath, [path.join(__dirname, 'pty-job-parent.cjs')], { windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FIXTURE_GATE: path.join(dir, 'parent-go'),
          FIXTURE_PIDS: file, FIXTURE_MODE: 'daemon', FIXTURE_LIFETIME: '60000', FIXTURE_EXPIRY_GATE: expiryGate,
          FIXTURE_CLI_ENTRY: cliEntry, FIXTURE_FILES: __dirname } });
      let stderr = ''; parent.stderr.on('data', data => { stderr += data; }); parent.stdout.resume();
      assert.equal(await until(() => parent.exitCode !== null, 45000), true, 'parent Node process must exit');
      assert.equal(parent.exitCode, 0, stderr);
      const pids = { ...JSON.parse(fs.readFileSync(file, 'utf8')), ...JSON.parse(fs.readFileSync(`${file}.parent`, 'utf8')) };
      const owned = [pids.rootPid, pids.grandchildPid, pids.daemonPid, pids.daemonChildPid].map(observer);
      hidden.push(...owned);
      console.log(JSON.stringify({ mode, parentPid: parent.pid, ...pids }));
      assert.equal(await until(() => owned.some(alive => alive() !== true), 800), false,
        'parent exit must leave assigned root, hidden child, daemon and daemon child alive');
      fs.writeFileSync(expiryGate, 'expire');
      assert.equal(await until(() => owned.every(alive => alive() === false), 5000), true, 'survivors must expire on their own timers');
      return;
    }
    if (mode === 'pid-guard') {
      const h = helper();
      assert.equal(await h.helper.start(), true);
      const root = spawn(process.execPath, ['-e', 'setTimeout(()=>{},8000)'], { stdio: 'ignore', windowsHide: true });
      try {
        assert.equal(await h.helper.assign('reused', root.pid, Date.now() - 60000), false,
          'a process newer than the recorded spawn plus slack must be rejected');
        assert.equal(observer(root.pid)(), true, 'rejected PID must remain alive');
        console.log(JSON.stringify({ mode, rootPid: root.pid }));
      } finally { try { root.kill(); } catch {} h.child().stdin.end(); }
      return;
    }
    if (mode === 'latencies') {
      const rows = [];
      for (let i = 0; i < 10; i++) {
        const h = helper(), started = performance.now();
        assert.equal(await h.helper.start(), true, 'helper must compile and report ready');
        const startup = performance.now() - started;
        const root = spawn(process.execPath, ['-e', 'setTimeout(()=>{},8000)'], { stdio: 'ignore', windowsHide: true });
        try {
          let at = performance.now();
          assert.equal(await h.helper.assign('measure', root.pid, Date.now()), true);
          const assign = performance.now() - at;
          at = performance.now(); assert.equal(await h.helper.terminate('measure'), true);
          rows.push({ startup, assign, terminate: performance.now() - at });
        } finally { try { root.kill(); } catch {} h.child().stdin.end(); }
        assert.equal(await until(() => h.child().exitCode !== null), true);
      }
      console.log(JSON.stringify({ mode, rows, summary: Object.fromEntries(['startup', 'assign', 'terminate'].map(key => {
        const sorted = rows.map(r => r[key]).sort((a,b) => a-b);
        return [key, { median: (sorted[4] + sorted[5]) / 2, max: sorted[9] }];
      })) }));
      return;
    }
    const h = helper();
    const startup = h.helper.start();
    const count = ['simultaneous', 'shutdown'].includes(mode) ? 3 : mode === 'helper-death' ? 2 : 1;
    const cases = [];
    for (let i = 0; i < count; i++) cases.push(await term(h, i,
      ['detached', 'daemon', 'worker', 'roster', 'stale-roster', 'daemon-eof', 'helper-death', 'helper-timeout', 'pipe-eof', 'lookalike'].includes(mode)));
    assert.equal(await startup, true, 'helper must compile and report ready');
    for (const c of cases) assert.equal(c.alive(), true, 'every owned child must still be alive immediately before close');
    const started = Date.now();
    if (mode === 'shutdown') {
      const events = [], filename = require.resolve('../../main'), source = fs.readFileSync(filename, 'utf8');
      const record = name => async () => { events.push(name); };
      const context = vm.createContext({ Promise, Map, setTimeout, clearTimeout, shutdownPromise: null,
        shutdownComplete: false, appQuitting: false, TRACE: {}, updateInstalling: false,
        log: { error: (...args) => events.push(args.join(' ')) }, stopNonDatabaseResources() {},
        closedSessions: new Map(), activeSessions: new Map(cases.map((c, i) => [String(i), c.session])), killPty,
        writer: { beginShutdown: fn => fn(), releaseLiveSession: record('row') },
        flushProjectsBeforeExit: record('projects'), flushWindowBounds: record('bounds'),
        sessionCache: { shutdownProducers: record('producers') }, sessionTransitions: { drainMetadataWrites: record('metadata') },
        activityFlushedForQuit: false, activityReporter: { flush: record('activity'), stop() {} },
        projectsClient: { shutdown: record('worker') }, fileListsClient: { shutdown: record('worker') },
        searchClient: { shutdown: record('worker') }, closeDb: record('db'), activityTrace: { close() {} }, stopWorkersForExit: async () => true,
      });
      vm.runInContext(extractFunction(source, 'boundedShutdown'), context, { filename });
      vm.runInContext(extractFunction(source, 'shutdownForExit'), context, { filename });
      await context.shutdownForExit();
      const shutdownMs = Date.now() - started;
      console.log(JSON.stringify({ mode, shutdownMs, events }));
      assert.ok(events.includes('projects') && events.includes('db'), 'quit must reach persistence flushes and closeDb');
      assert.equal(events.filter(e => e === 'row').length, 3);
      assert.ok(shutdownMs < 1500, `native quit drain took ${shutdownMs}ms`);
    }
    else if (mode === 'helper-death') h.child().kill();
    else if (mode === 'helper-timeout') {
      assert.equal(await h.helper.assign('delayed', cases[0].session.pty.pid, Date.now()), false,
        'a suppressed native reply must hit the real request timeout');
      assert.equal(await h.helper.assign('later', cases[0].session.pty.pid, Date.now()), false,
        'later tabs must use fallback after helper failure');
    }
    else if (mode === 'pipe-eof' || mode === 'daemon-eof') h.child().stdin.end();
    else {
      if (mode === 'release') assert.equal(await releaseWindowsPty(cases[0].session.pty), true);
      for (const c of cases) killPty(c.session, mode);
    }
    if (['helper-death', 'helper-timeout', 'pipe-eof', 'daemon-eof'].includes(mode)) {
      assert.equal(await until(() => h.child().exitCode !== null || h.child().signalCode !== null), true, 'helper must have exited before survival checks');
      assert.equal(await until(() => cases.some(c => !observer(c.session.pty.pid)() || !c.alive() || !c.daemon() || !c.daemonChild()), 800), false,
        'helper exit must leave every root, hidden child, daemon and daemon child alive');
    } else if (mode === 'release') {
      const survived = await until(() => cases[0].alive() === false, 2500);
      assert.equal(survived, false, `${mode} grandchild must survive tab close`);
    } else {
      assert.equal(await until(() => cases.every(c => c.alive() === false), 5000), true, 'every hidden grandchild must exit within five seconds');
    }
    if (cases[0].daemon && !['helper-death', 'helper-timeout', 'pipe-eof', 'daemon-eof'].includes(mode)) {
      if (mode === 'lookalike' || mode === 'stale-roster') {
        assert.equal(await until(() => cases[0].daemon() === false && cases[0].daemonChild() === false), true,
          'daemon runner is not the daemon run marker; its tree must end');
      } else {
        assert.equal(await until(() => cases[0].daemon() === false || cases[0].daemonChild() === false, 800), false,
          'background daemon and its unmarked child must survive tab close or helper EOF');
      }
    }
    if (process.env.FIXTURE_EXPECT_COMMAND_WARNING === '1') {
      assert.equal((h.stderr.join('').match(/command-line read failed/g) || []).length, 1,
        'unreadable command lines must produce one native warning per helper lifetime');
    }
    console.log(JSON.stringify({ mode, elapsedMs: Date.now() - started }));
  } finally {
    if (['helper-death', 'helper-timeout', 'pipe-eof', 'daemon-eof'].includes(mode)) {
      fs.writeFileSync(expiryGate, 'expire');
      assert.equal(await until(() => terms.every(s => s.exited) && hidden.every(alive => alive() === false), 55000), true,
        'survivors must exit on their own fixture timers');
    }
    for (const session of terms) if (!session.exited) { await releaseWindowsPty(session.pty); killPty(session, 'fixture-cleanup'); }
    for (const child of helpers) { if (child.exitCode === null) child.stdin.end(); }
    for (const alive of hidden) {
      if (alive() === true) { try { process.kill(alive.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }
    await until(() => hidden.every(alive => alive() === false), 18000);
    await until(() => helpers.every(child => child.exitCode !== null || child.signalCode !== null), 4000);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run(process.argv[2]).then(() => { clearInterval(keepAlive); process.exit(0); }, error => { console.error(error); process.exit(1); });
