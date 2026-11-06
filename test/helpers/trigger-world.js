'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createTriggerContext } = require('../../src/main/triggers/trigger-context');
const { createComposerState } = require('../../src/main/terminals/composer-state');
const { createTriggerActions } = require('../../src/main/triggers/trigger-actions');

const log = { info() {}, warn() {}, error() {}, debug() {} };
const ID_A = '01234567-89ab-cdef-0123-456789abcdef';
const ID_B = 'fedcba98-7654-3210-fedc-ba9876543210';

function makeWorld(options = {}) {
  const activeSessions = new Map();
  const statuses = new Map();
  const writes = [];
  const writers = new Map();
  let nextPid = 5000;
  const world = { activeSessions, statuses, writes, writers, log };

  world.addSession = (key, overrides = {}) => {
    const pid = nextPid++;
    const session = {
      generation: 1, host: null, isPlainTerminal: false, isAttach: false, cwd: '/work/project', projectFolder: 'proj',
      exited: false, _cliBusy: false, composerState: createComposerState(), ...overrides,
    };
    session.pty = { pid, dead: false, write(data) { writes.push({ key, data }); world.onWrite?.(key, data); } };
    activeSessions.set(key, session);
    writers.set(pid, overrides.writerId || key);
    statuses.set(key, { status: 'idle', statusUpdatedAt: Date.now() - 60000 });
    return session;
  };

  world.ctx = createTriggerContext({
    activeSessions, log, isPtyAlive: pty => !pty.dead,
    getCliStatus: id => statuses.get(id),
    resolveSessionId: options.resolveSessionId, projectsDir: options.projectsDir,
    observeTabWriter: pid => ({ writer: { sessionId: writers.get(pid) }, identity: `${pid}:${pid}` }),
    cliSessionState: {
      findDeliveryTab: () => ({}), refreshProcessTable: async () => {}, deliveryPtyStart: pid => String(pid),
      observeTabWriter: () => ({ supported: false }),
    },
  });
  return world;
}

function makeClock(start = 1_000_000) {
  const clock = { t: start, now: () => clock.t, sleep: async ms => { clock.t += ms; } };
  return clock;
}

function makeEnv(deadline, overrides = {}) {
  const marks = [];
  return {
    deadline, marks, mark: (phase, evidence) => { marks.push({ phase, evidence }); return true; },
    acquireSessionLock: async () => () => {}, acquireTabLock: async () => () => {}, staleCheck: () => null, ...overrides,
  };
}

function makeActions(world, overrides = {}) {
  const calls = { stop: [], ensureOpen: [], deliver: [], live: [] };
  const deps = {
    ctx: world.ctx,
    helpers: { normalizeCwd: value => value, getQuietMs: () => 3000, deliverPrompt: async op => { calls.deliver.push(op); return { ok: true, evidence: {} }; } },
    bridge: {
      waitReady: async () => ({ ok: true }),
      ensureOpen: async op => { calls.ensureOpen.push(op); return { ok: true, generation: 1, spawned: false }; },
    },
    getSnapshot: async () => ({ allProjects: [{ projectPath: '/work/project' }], global: { hiddenProjects: [], hiddenProjectKinds: {} } }),
    directoryExists: () => true,
    liveV1: async id => { calls.live.push(id); return { known: true, live: null }; },
    resolveClosed: async () => ({ status: 'unknown' }),
    isRemoteTarget: async () => false,
    reserveId: () => ID_B,
    saveName: async () => {},
    stopSession: async (key, session) => { calls.stop.push(key); session.exited = true; return { ok: true }; },
    ...overrides,
  };
  return { actions: createTriggerActions(deps), calls, deps };
}

function tempRoot(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-1022-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function v1Dependencies(world, overrides = {}) {
  const { deps, calls } = makeActions(world, overrides);
  const { ctx, helpers, ...rest } = deps;
  void ctx; void helpers;
  return { deps: rest, calls };
}

function startWatcher(t, world, overrides = {}, root = tempRoot(t)) {
  const { start } = require('../../src/main/triggers/trigger-watcher');
  const triggers = path.join(root, 'triggers');
  fs.mkdirSync(triggers, { recursive: true });
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = triggers;
  const built = v1Dependencies(world, overrides);
  world.ctx.v1 = built.deps;
  const watcher = start(world.ctx);
  t.after(() => { watcher.close(); if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR; else process.env.SWITCHBOARD_TRIGGERS_DIR = previous; });
  const resultOf = uuid => path.join(triggers, 'processed', uuid + '.result.json');
  async function waitResult(uuid, limitMs = 8000) {
    const end = Date.now() + limitMs;
    while (!fs.existsSync(resultOf(uuid))) {
      if (Date.now() > end) throw new Error('no result for ' + uuid);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return JSON.parse(fs.readFileSync(resultOf(uuid), 'utf8'));
  }
  function submit(request, uuid = randomUUID()) {
    const tmp = path.join(triggers, uuid + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(request));
    fs.renameSync(tmp, path.join(triggers, uuid + '.json'));
    return waitResult(uuid);
  }
  return { triggers, root, submit, waitResult, resultOf, watcher, calls: built.calls };
}

module.exports = { tempRoot, startWatcher, v1Dependencies, makeWorld, makeClock, makeEnv, makeActions, log, ID_A, ID_B };
