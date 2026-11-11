'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = require('../cli-session-state');
const { encodeProjectPath } = require('../encode-project-path');
const { createTriggerContext } = require('../src/main/triggers/trigger-context');
const { start } = require('./fixtures/trigger-watcher.cjs');
const { resolveLocalTarget, resolveProject } = require('../src/main/triggers/trigger-actions');
const { createComposerState } = require('../src/main/terminals/composer-state');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'claude-sandbox.sh');
const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-sandbox-cli.sh');
const REQUIRED = process.env.SWITCHBOARD_REQUIRE_REAL_BWRAP === '1';
const ID = '01234567-89ab-cdef-0123-456789abcdef';
const NEW = '11234567-89ab-cdef-0123-456789abcdef';
const REQUEST = '21234567-89ab-cdef-0123-456789abcdef';

let nodePty = null;
try { nodePty = require('node-pty'); } catch {}
const bwrapWorks = process.platform === 'linux' && spawnSync('bwrap', [
  '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-all', '--share-net', '--dir', '/var',
  '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
  '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
  '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
  '/bin/true',
], { encoding: 'utf8' }).status === 0;
const capable = bwrapWorks && nodePty !== null;
const skip = capable || REQUIRED ? false : 'requires Linux, node-pty and unprivileged user namespaces';

function hostProcess(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const nspid = /^NSpid:\s*(.*)$/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1].trim().split(/\s+/).map(Number);
    return { pid, parent: Number(fields[1]), start: fields[19], nspid, namespace: fs.readlinkSync(`/proc/${pid}/ns/pid`) };
  } catch { return null; }
}
function findHostWriter(anchorPid, innerPid) {
  const anchor = hostProcess(anchorPid);
  const all = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => hostProcess(Number(name))).filter(Boolean);
  const byPid = new Map(all.map(proc => [proc.pid, proc]));
  const descends = proc => { for (let p = proc, i = 0; p && i < 64; p = byPid.get(p.parent), i++) if (p.pid === anchorPid) return true; return false; };
  const writers = all.filter(proc => proc.nspid.at(-1) === innerPid && proc.namespace !== anchor.namespace && descends(proc));
  return { anchor, writer: writers.length === 1 ? writers[0] : null };
}
async function until(predicate, label, ms = 15000) {
  const end = performance.now() + ms;
  while (!predicate() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), label);
}

async function launchThroughWrapper(t, { mode, mismatch }) {
  assert.ok(capable, 'SWITCHBOARD_REQUIRE_REAL_BWRAP=1 needs bubblewrap with unprivileged user namespaces and node-pty');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-readiness-')));
  const dirs = Object.fromEntries(['bin', 'home', 'proj', 'triggers'].map(name => [name, path.join(root, name)]));
  Object.values(dirs).forEach(dir => fs.mkdirSync(dir));
  const sessions = path.join(dirs.home, '.claude', 'sessions');
  const projectsDir = path.join(dirs.home, '.claude', 'projects');
  const folder = encodeProjectPath(dirs.proj);
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
  fs.mkdirSync(path.join(dirs.triggers, 'processed'));
  fs.copyFileSync(FAKE_CLI, path.join(dirs.bin, 'claude'));
  fs.chmodSync(path.join(dirs.bin, 'claude'), 0o755);
  const log = path.join(dirs.proj, 'received.log');
  const sessionId = mode === 'new' ? NEW : ID;
  if (mode === 'resume') {
    fs.writeFileSync(path.join(projectsDir, folder, ID + '.jsonl'), JSON.stringify({ type: 'user', sessionId: ID, cwd: dirs.proj, message: { content: 'start' } }) + '\n');
  }
  const previous = {};
  for (const [key, value] of Object.entries({ SWITCHBOARD_TRIGGERS_DIR: dirs.triggers, SWITCHBOARD_TRIGGER_QUIET_MS: '1',
    SWITCHBOARD_BUSY_FALL_SETTLE_MS: '10', SWITCHBOARD_SUBMIT_ENTER_DELAY_MS: '1', SWITCHBOARD_SUBMIT_VERIFY_MS: '600' })) {
    previous[key] = process.env[key]; process.env[key] = value;
  }
  const activeSessions = new Map();
  const log_ = { info() {}, warn() {}, error() {}, debug() {} };
  const writes = [];
  const evidence = { spawns: 0 };
  let terminal;
  t.after(async () => {
    watcher?.close();
    cli.stop();
    if (terminal) {
      const exited = new Promise(resolve => terminal.onExit(resolve));
      try { terminal.kill(); } catch {}
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  });
  cli.init({ dir: sessions, activeSessions, platform: 'linux', log: log_, onIdle() {}, isProcessAlive: () => true });
  const broker = {
    async request(operation, beforeSpawn) {
      await beforeSpawn({});
      const launchStartedAt = Date.now();
      evidence.spawns++;
      terminal = nodePty.spawn('bash', [SCRIPT], { name: 'xterm-256color', cols: 80, rows: 24, cwd: dirs.proj,
        env: { PATH: `${dirs.bin}:${process.env.PATH}`, HOME: dirs.home, TERM: 'xterm-256color',
          SWITCHBOARD_SANDBOX_TRIGGERS_DIR: dirs.triggers, SWITCHBOARD_SANDBOX_PROJECT_FOLDER: folder,
          FAKE_ID: sessionId, FAKE_LOG: log, ...(mismatch ? { FAKE_MISMATCH: '1' } : {}) } });
      terminal.onData(() => {});
      const write = terminal.write.bind(terminal);
      const target = { pty: terminal, write: data => {
        const descriptors = fs.readdirSync(sessions).filter(name => /^\d+\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(sessions, name), 'utf8')));
        writes.push({ data, status: descriptors[0]?.status, at: Date.now(), updatedAt: descriptors[0]?.statusUpdatedAt });
        return write(data);
      } };
      terminal.write = target.write;
      const session = { pty: terminal, generation: 1, sandbox: true, host: null, cwd: dirs.proj, projectPath: dirs.proj,
        projectFolder: folder, hostPtyStart: cli.deliveryPtyStart(terminal.pid), launchMode: operation.mode === 'new' ? 'new' : 'resume',
        launchSourceId: sessionId, launchStartedAt, composerState: createComposerState() };
      activeSessions.set(operation.tabKey, session);
      evidence.hostPty = terminal.pid;
      evidence.generation = session.generation;
      operation.onOpened?.(session);
      return { ok: true, generation: 1 };
    },
  };
  const lifecycle = { activeSessions, broker, launchAllowed: () => true, projectsDir,
    getCachedSession: () => null, getCachedFolder: () => null,
    getProjectSnapshot: async () => ({ allProjects: [{ projectPath: dirs.proj }], hiddenProjects: [], hiddenProjectKinds: {} }),
    resolveTarget: resolveLocalTarget, resolveProject, remoteTarget: async () => false, randomUUID: () => NEW,
    liveElsewhere: (id, deadline) => cli.liveElsewhereV1Checked(id, () => false, cli.makePtyPids(activeSessions), { deadline }),
    saveName: async (_id, name) => ({ name }) };
  const ctx = createTriggerContext({ activeSessions, log: log_, projectsDir, getCliStatus: id => cli.getStatus(id), cliSessionState: cli, lifecycle });
  let watcher = start(ctx);
  async function publish(payload) {
    fs.writeFileSync(path.join(dirs.triggers, REQUEST + '.tmp'), JSON.stringify(payload));
    fs.renameSync(path.join(dirs.triggers, REQUEST + '.tmp'), path.join(dirs.triggers, REQUEST + '.json'));
    const result = path.join(dirs.triggers, 'processed', REQUEST + '.result.json');
    await until(() => fs.existsSync(result), 'the request reaches a terminal result', 25000);
    return JSON.parse(fs.readFileSync(result, 'utf8'));
  }
  return { dirs, sessions, log, writes, evidence, publish, sessionId, activeSessions, root,
    terminal: () => terminal };
}

for (const mode of ['new', 'resume']) {
  test(`real wrapper, node-pty and /proc: a ${mode} launch is delivered its prompt only after fresh settled idle`, { skip }, async t => {
    const w = await launchThroughWrapper(t, { mode, mismatch: false });
    const payload = mode === 'new'
      ? { version: 1, action: 'open', new: { project: w.dirs.proj, name: 'Task' }, prompt: 'hello', timeout_ms: 20000 }
      : { version: 1, action: 'open', sessionId: ID, prompt: 'hello', timeout_ms: 20000 };
    const result = await w.publish(payload);
    assert.equal(result.outcome, 'opened', JSON.stringify(result));
    assert.equal(result.sessionId, w.sessionId);
    assert.equal(result[mode === 'new' ? 'created' : 'resumed'], true);
    assert.deepEqual(w.writes.map(entry => entry.data), ['hello', '\r'], 'exactly one prompt and one Enter');
    assert.ok(w.writes.every(entry => entry.status === 'idle'), 'every byte arrives while the CLI descriptor reads idle');
    assert.equal(w.evidence.spawns, 1);

    const descriptor = JSON.parse(fs.readFileSync(path.join(w.sessions, fs.readdirSync(w.sessions).find(name => /^\d+\.json$/.test(name))), 'utf8'));
    const { anchor, writer } = findHostWriter(w.evidence.hostPty, descriptor.pid);
    assert.ok(writer, 'the descriptor writer is a descendant of the host PTY in its own PID namespace');
    assert.notEqual(writer.pid, descriptor.pid, 'host and inner writer PIDs differ');
    assert.notEqual(writer.namespace, anchor.namespace, 'the writer PID namespace differs from the host anchor');
    assert.equal(String(descriptor.procStart), writer.start, 'the descriptor carries the writer process start identity');
    assert.equal(w.evidence.generation, 1);
    assert.equal(fs.readFileSync(w.log, 'utf8'), 'helloENTER\n');
  });
  test(`real wrapper, node-pty and /proc: a ${mode} launch whose descriptor start identity mismatches gets no prompt`, { skip }, async t => {
    const w = await launchThroughWrapper(t, { mode, mismatch: true });
    const payload = mode === 'new'
      ? { version: 1, action: 'open', new: { project: w.dirs.proj, name: 'Task' }, prompt: 'hello', timeout_ms: 4000 }
      : { version: 1, action: 'open', sessionId: ID, prompt: 'hello', timeout_ms: 4000 };
    const result = await w.publish(payload);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'session readiness unavailable');
    assert.equal(result[mode === 'new' ? 'created' : 'resumed'], true, 'launch evidence is retained');
    assert.deepEqual(w.writes, [], 'no prompt byte reaches the session');
  });
}
