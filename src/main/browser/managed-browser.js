'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { createStorage } = require('./storage');
const { createProc } = require('./linux-process');
const { createLock } = require('./owner-lock');
const { discoverBrowser } = require('./discovery');
const transport = require('./transport');
const { cleanEnv } = require('../shared/clean-env');

function browserEnv(env) {
  const cleaned = cleanEnv(env, { locale: false });
  return Object.fromEntries(Object.entries(cleaned).filter(([key]) =>
    !/^(ELECTRON_.*|APPIMAGE.*|APPDIR|ARGV0|INVOCATION_ID|JOURNAL_STREAM|SYSTEMD_.*|NOTIFY_SOCKET|WATCHDOG_PID|WATCHDOG_USEC|CHROME_CRASHPAD_PIPE_NAME|CHROME_RESTART|SWITCHBOARD_.*|NODE_PATH|LD_LIBRARY_PATH|LD_PRELOAD)$/i.test(key)));
}

function validState(state, profile) {
  if (state === null) return null;
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const identity = value => value && positive(value.pid) && typeof value.startTime === 'string' && /^\d+$/.test(value.startTime) && typeof value.boot === 'string' && value.boot.length > 0;
  if (state.version !== 1 || !positive(state.port) || state.port > 65535 || state.profile !== profile ||
      (state.pid !== null && (!identity(state) || !identity(state.spawnedBy) || !path.isAbsolute(state.binary) ||
       !['child', 'scope', 'detached'].includes(state.mode) || typeof state.startedAt !== 'number' ||
       (state.mode === 'scope' && !/^switchboard-browser-[a-f0-9]+-\d+-[a-f0-9]+$/.test(state.unit))))) throw new Error('Invalid managed-browser state; retaining data for inspection');
  return state;
}

function createManager({ dataDir, platform = process.platform, isPackaged = false,
  fs = require('node:fs'), env = process.env, home = require('node:os').homedir(),
  proc = createProc({ fs }), lock = createLock({ fs, env }), storage = createStorage({ dataDir, fs }),
  discover = discoverBrowser, spawn = require('node:child_process').spawn,
  request = transport.request, allocatePort = transport.allocatePort, portFree = transport.portFree,
  closeBrowser = transport.closeBrowser, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let queue = Promise.resolve(), owner, state, profile, base, memo, disposed = false, quitting = false;
  let result = { supported: platform === 'linux', status: 'stopped', role: null, port: null, survivesRestart: false };
  const snapshot = (status, extra = {}) => (result = { ...result, status, role: owner?.role ?? null,
    port: state?.port ?? null, pid: state?.pid ?? null, mode: state?.mode ?? null,
    binary: state?.binary ?? null, survivesRestart: status === 'running' && state?.mode === 'scope', error: null, notice: null, ...extra });
  const enqueue = work => {
    const next = queue.then(async () => {
      if (platform !== 'linux') return { ...result, supported: false, error: 'Managed browser is supported on Linux only' };
      if (disposed || quitting) return snapshot('error', { error: 'Managed browser is disposing or quitting' });
      try { return await work(); } catch (error) { return snapshot('error', { error: error.message }); }
    });
    queue = next.catch(() => {}); return next;
  };
  const write = () => storage.write('state.json', state);
  function discoveryInputs(binaryPath) {
    let candidates = [binaryPath];
    if (!binaryPath) {
      const root = env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(home, '.cache', 'ms-playwright');
      if (!path.isAbsolute(root)) return [root];
      try {
        candidates = fs.readdirSync(root).filter(name => /^chromium-\d+$/.test(name)).sort().flatMap(name =>
          ['chrome-linux64', 'chrome-linux'].map(layout => path.join(root, name, layout, 'chrome')));
      } catch { return [root, null]; }
    }
    return candidates.map(file => {
      try {
        const stat = fs.statSync(file);
        return [file, stat.ino, stat.mtimeMs, stat.size, stat.mode];
      } catch { return [file, null]; }
    });
  }
  async function initialize() {
    base = storage.init(); profile = path.join(base, 'profile');
    if (owner?.role !== 'owner') owner = await lock.acquire(path.dirname(base), base);
    state = validState(storage.read('state.json'), profile);
    if (owner.role === 'owner') storage.prune();
  }
  async function ready(candidate) {
    if (!proc.verify(candidate) || proc.listener(candidate) !== 'owned') return null;
    let version;
    try { version = await request(candidate.port, '/json/version'); } catch { return null; }
    if (!version || typeof version.Browser !== 'string' || version.Browser.length > 512 || typeof version.webSocketDebuggerUrl !== 'string') return null;
    if (!proc.verify(candidate) || proc.listener(candidate) !== 'owned') return null;
    return version;
  }
  function signal(candidate, kind) {
    if (!proc.verify(candidate)) return false;
    try { proc.signal(candidate.pid, kind); return true; } catch { return false; }
  }
  async function waitGone(candidate, ms) {
    const deadline = now() + ms;
    while (proc.alive(candidate) && now() < deadline) await sleep(Math.min(50, deadline - now()));
    return !proc.identity(candidate.pid);
  }
  function reservePort() {
    state = { version: 1, port: state.port, pid: null, profile }; write();
  }
  function recoverPending() {
    if (!state?.launchPending) return;
    if (owner.role !== 'owner') throw new Error('Browser launch recovery requires its owner');
    const boot = proc.self()?.boot, pendingBoot = state.boot || state.spawnedBy?.boot;
    if (!boot || !pendingBoot) throw new Error('Browser launch boot identity uncertain; data retained');
    if (boot === pendingBoot) {
      const pid = proc.findBrowser(state);
      if (pid) {
        const candidate = { ...state, ...proc.identity(pid) };
        if (!proc.verify(candidate)) throw new Error('Pending browser identity changed during recovery; data retained');
        delete candidate.launchPending;
        state = candidate; write(); return;
      }
    }
    reservePort();
  }
  async function stopOwned() {
    recoverPending();
    if (!state?.pid) return snapshot('stopped');
    if (!proc.alive(state)) { reservePort(); return snapshot('stopped'); }
    if (!proc.verify(state) || proc.listener(state) === 'foreign') return snapshot('foreign', { error: 'Browser identity or listener ownership changed; data retained' });
    const descendants = proc.descendants(state);
    if (proc.listener(state) === 'owned') {
      const version = await ready(state);
      if (!proc.alive(state)) { reservePort(); return snapshot('stopped'); }
      if (!proc.verify(state) || proc.listener(state) === 'foreign') return snapshot('foreign', { error: 'Browser ownership changed' });
      if (proc.listener(state) === 'owned') {
        if (!version) return snapshot('foreign', { error: 'Browser endpoint could not be verified; data retained' });
        try { await closeBrowser(state, version); } catch {}
      }
    }
    let gone = await waitGone(state, 5000);
    for (const [kind, delay] of [['SIGTERM', 3000], ['SIGKILL', 1000]]) {
      if (gone) break;
      if (!signal(state, kind)) return snapshot('foreign', { error: 'Browser identity changed before signal; data retained' });
      gone = await waitGone(state, delay);
    }
    if (!gone) return snapshot('error', { error: 'Browser exit uncertain; data retained' });
    for (const child of descendants) {
      if (!proc.verifyDescendant(child, state)) continue;
      try { if (proc.verifyDescendant(child, state)) proc.signal(child.pid, 'SIGTERM'); } catch {}
      if (!await waitGone(child, 3000)) {
        if (!proc.verifyDescendant(child, state)) continue;
        try { if (proc.verifyDescendant(child, state)) proc.signal(child.pid, 'SIGKILL'); } catch {}
        if (!await waitGone(child, 1000)) return snapshot('error', { error: 'Browser descendant exit uncertain; data retained' });
      }
    }
    state = { version: 1, port: state.port, pid: null, profile }; write(); return snapshot('stopped');
  }
  async function start(options = {}, explicit = false) {
    await initialize();
    recoverPending();
    if (state?.pid && proc.alive(state)) {
      const version = await ready(state);
      if (!version) return snapshot('foreign', { error: 'Existing browser identity or listener conflict; no duplicate start' });
      if (owner.role === 'owner' && state.mode === 'child' && !sameIdentity(state.spawnedBy, proc.self())) {
        if (proc.alive(state.spawnedBy)) return snapshot('foreign', { error: 'Source browser spawner is still alive' });
        state.spawnedBy = { ...proc.self() }; write();
      }
      return snapshot('running', { version: version.Browser });
    }
    if (owner.role !== 'owner') return snapshot('stopped', { notice: 'Browser owner is not running a verified browser' });
    let notice = null;
    if (!state) state = { version: 1, port: await allocatePort(), pid: null, profile };
    else {
      state = { version: 1, port: state.port, pid: null, profile };
      if (!await portFree(state.port)) { state.port = await allocatePort(); notice = 'Browser port changed; restart existing sessions'; }
    }
    write();
    const key = JSON.stringify([options.binaryPath || '', env.PLAYWRIGHT_BROWSERS_PATH, home, discoveryInputs(options.binaryPath)]);
    if (!explicit && memo?.key === key && now() - memo.at < 60000) return snapshot('error', { error: memo.error, notice });
    snapshot('starting');
    let launch;
    const deadline = now() + 20000;
    try {
      const found = discover({ binaryPath: options.binaryPath || '', env, home, fs });
      if (!found?.binary || !path.isAbsolute(found.binary)) throw new Error('Discovery did not return an absolute executable');
      const source = found.source;
      for (let attempt = 0; attempt < 3; attempt++) {
        const binary = found.binary;
        const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${state.port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', 'about:blank'];
        const hash = createHash('sha256').update(base).digest('hex').slice(0, 16);
        const unit = `switchboard-browser-${hash}-${now()}-${require('node:crypto').randomBytes(4).toString('hex')}`;
        let mode = isPackaged ? 'scope' : 'child', fallback = false;
        while (true) {
          if (quitting) throw new Error('Browser start cancelled by quit');
          const fd = storage.log(); let child, exited, spawnError;
          try {
            state = { ...state, launchPending: true, binary, mode, unit: mode === 'scope' ? unit : null,
              spawnedBy: { ...proc.self() }, startedAt: now() }; write();
            const argv = mode === 'scope' ? ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--', ...[binary, ...args].map(arg => arg.replace(/\$/g, () => '$$'))] : args;
            try {
              child = spawn(mode === 'scope' ? 'systemd-run' : binary, argv, { shell: false, detached: mode !== 'child', env: browserEnv(env), stdio: ['ignore', fd, fd], windowsHide: true });
            } catch (error) {
              state = { version: 1, port: state.port, pid: null, profile }; write(); throw error;
            }
            child.once('exit', (code, sig) => { exited = { code, sig }; });
            child.once('error', error => { spawnError = error; });
            if (mode !== 'child') child.unref();
          } finally { storage.close(fd); }
          const candidate = { version: 1, port: state.port, profile, binary, mode, unit: mode === 'scope' ? unit : null,
            spawnedBy: { ...proc.self() }, startedAt: now(), pid: null };
          launch = null;
          while (now() < deadline) {
            const n = mode === 'scope' ? proc.listenerPid(candidate) : child.pid;
            const identity = proc.identity(n);
            if (identity) {
              const possible = { ...candidate, ...identity };
              if (proc.verify(possible)) { launch = possible; state = possible; write(); }
            }
            if (launch) {
              const version = await ready(launch);
              if (version) { memo = null; return snapshot('running', { version: version.Browser, source, notice }); }
            }
            if (quitting) { if (launch) signal(launch, 'SIGTERM'); throw new Error('Browser start cancelled by quit'); }
            if (spawnError || exited) break;
            if (launch && proc.listener(launch) === 'foreign') break;
            await sleep(50);
          }
          const tail = storage.tail();
          const missingBus = mode === 'scope' && !fallback && !launch && (spawnError?.code === 'ENOENT' ||
            (exited?.code !== undefined && exited.code !== 0 && /Failed to connect to (?:bus|user bus)|Failed to start transient scope.*(?:bus|connection)/i.test(tail) && !/FATAL|sandbox/i.test(tail)));
          if (missingBus) { fallback = true; mode = 'detached'; continue; }
          if (launch) {
            const collision = proc.listener(launch) === 'foreign';
            if (!signal(launch, 'SIGTERM') || !await waitGone(launch, 3000)) throw new Error('Failed launch exit uncertain; data retained');
            if (collision && attempt < 2 && now() < deadline) {
              state = { version: 1, port: await allocatePort(), pid: null, profile }; write();
              notice = 'Browser port changed; restart existing sessions'; break;
            }
          }
          if (!launch && (spawnError || exited)) {
            if (spawnError && !child.pid) reservePort();
            else recoverPending();
          }
          throw new Error(`Browser did not become ready: ${spawnError?.message || (exited ? `exit ${exited.code}` : '20-second start deadline')}${tail ? `; ${tail}` : ''}`);
        }
      }
      throw new Error('Browser port collision retry budget exhausted');
    } catch (error) {
      if (launch && proc.verify(launch)) {
        if (signal(launch, 'SIGTERM') && await waitGone(launch, 3000)) {
          state = { version: 1, port: state.port, pid: null, profile };
          try { write(); } catch {}
        }
      }
      memo = { key, at: now(), error: error.message };
      return snapshot('error', { error: error.message, notice });
    }
  }
  function stopForQuit() {
    quitting = true;
    if (platform !== 'linux' || owner?.role !== 'owner' || state?.mode !== 'child' || !sameIdentity(state.spawnedBy, proc.self()) || proc.listener(state) !== 'owned') return false;
    return signal(state, 'SIGTERM');
  }
  async function dispose() {
    disposed = true;
    await queue;
    if (owner?.role === 'owner') await owner.release();
    owner = null;
  }
  return {
    ensureStarted: options => enqueue(() => start(options)),
    open: options => enqueue(async () => {
      const current = await start(options, true);
      if (current.status !== 'running' || current.role !== 'owner') return current;
      try {
        if (!await ready(state)) return snapshot('foreign', { error: 'Browser ownership changed before Open' });
        const pages = await request(state.port, '/json/list');
        const page = Array.isArray(pages) && pages.find(page => typeof page.id === 'string');
        if (page) await request(state.port, `/json/activate/${encodeURIComponent(page.id)}`);
        else await request(state.port, '/json/new?about:blank', 'PUT');
      } catch (error) { return snapshot('running', { notice: `Browser opened; activation failed: ${error.message}` }); }
      return current;
    }),
    stop: () => enqueue(async () => { await initialize(); return owner.role === 'owner' ? stopOwned() : snapshot(result.status, { notice: 'Only the browser owner can stop it' }); }),
    getState: () => ({ ...result }), stopForQuit, dispose,
  };
}

function sameIdentity(a, b) { return !!a && !!b && a.pid === b.pid && a.startTime === b.startTime && a.boot === b.boot; }

async function cleanupDataDir(dataDir, options = {}) {
  const fs = options.fs || require('node:fs');
  if (!fs.existsSync(path.join(dataDir, 'managed-browser'))) return true;
  const manager = createManager({ ...options, dataDir });
  try {
    const stopped = await manager.stop();
    return stopped.supported && stopped.role === 'owner' && stopped.status === 'stopped';
  } finally { await manager.dispose(); }
}

module.exports = { createManager, cleanupDataDir };
