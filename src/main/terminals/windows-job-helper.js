'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const ERROR_MEMBER_SKIPPED = 299;
const MAX_START_ATTEMPTS = 3;

function createWindowsJobHelper({ spawn: spawnChild = spawn, warn = () => {}, startupMs = 15000,
  requestMs = 3000, protectedPids = () => [] } = {}) {
  let child, started = false, ready = false, failed = false, buffer = '', startupTimer, earlyCloseWarned = false;
  let attempts = 0, retryAt = 0, unavailableWarned = false;
  let retryTimer;
  const lateAssignments = new Map();
  const pending = new Map();
  const queued = new Map();
  const waiting = new Map();
  let resolveReady;
  let readiness;

  function scheduleRetry() {
    clearTimeout(retryTimer);
    for (const [id, entry] of lateAssignments) if (!entry.current()) lateAssignments.delete(id);
    if (ready || attempts >= MAX_START_ATTEMPTS) { lateAssignments.clear(); return; }
    if (!failed || !lateAssignments.size) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      for (const [id, entry] of lateAssignments) if (!entry.current()) lateAssignments.delete(id);
      if (lateAssignments.size) { start(); if (failed) scheduleRetry(); }
    }, Math.max(0, retryAt - performance.now()));
    retryTimer.unref?.();
  }

  function fail(reason) {
    if (failed) return;
    failed = true;
    retryAt = performance.now() + 1000 * 2 ** (attempts - 1);
    clearTimeout(startupTimer);
    resolveReady(false);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve(false); }
    for (const entries of waiting.values()) for (const entry of entries) entry.resolve(false);
    pending.clear(); queued.clear(); waiting.clear();
    const detail = `attempt ${attempts}/${MAX_START_ATTEMPTS}: ${reason}${attempts >= MAX_START_ATTEMPTS ? '; startup retries exhausted' : ''}`;
    try {
      if (!unavailableWarned) warn(`[pty] Windows job helper unavailable; using plain ConPTY close: ${detail}`);
      else warn(`[pty] Windows job helper ${detail}`);
    } catch {}
    unavailableWarned = true;
    try { child?.kill(); } catch {}
    scheduleRetry();
  }

  function settle(entry, value) {
    pending.delete(entry.id); clearTimeout(entry.timer);
    entry.resolve(value);
    const entries = waiting.get(entry.id), next = entries?.shift();
    if (!entries?.length) waiting.delete(entry.id);
    if (next) {
      pending.set(next.id, next);
      if (ready) send(next);
      else queued.set(next.id, next);
    }
  }

  function send(entry) {
    if (failed) return;
    if (entry.current && !entry.current()) {
      settle(entry, false); return;
    }
    entry.timer = setTimeout(() => fail('request timed out'), requestMs);
    entry.timer.unref?.();
    try { child.stdin.write(entry.line + '\n'); } catch (error) { fail(error.message); }
  }

  function receive(data) {
    buffer += data;
    if (buffer.length > 65536) return fail('protocol overflow');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      if (line === 'ready' && !ready) {
        ready = true; clearTimeout(startupTimer); resolveReady(true);
        for (const entry of queued.values()) send(entry);
        queued.clear();
        clearTimeout(retryTimer);
        for (const [id, entry] of lateAssignments) {
          lateAssignments.delete(id);
          if (entry.current()) entry.onLateAssignment(request('assign', id, entry.args, entry.current));
        }
        continue;
      }
      const match = /^(assigned|terminated|released|observed|error) ([\w-]+)(?: (\d+))?$/.exec(line);
      if (!match) return fail('invalid protocol response');
      const entry = pending.get(match[2]);
      if (!entry || (match[1] !== 'error' && match[1] !== entry.response)) return fail('unexpected protocol response');
      if (match[1] === 'error') {
        const detail = Number(match[3]) === ERROR_MEMBER_SKIPPED ? ' (member skipped)' : '';
        try { warn(`[pty] Windows job ${entry.id} ${entry.op} failed: ${match[3]}${detail}`); } catch {}
      }
      settle(entry, match[1] === 'observed' ? { ended: match[3] === '0', observedAt: Date.now() } : match[1] !== 'error');
    }
  }

  function start() {
    if (failed) {
      if (ready || attempts >= MAX_START_ATTEMPTS || performance.now() < retryAt) return Promise.resolve(false);
    } else if (started) return readiness;
    started = true;
    clearTimeout(retryTimer);
    failed = false;
    buffer = '';
    const attempt = ++attempts;
    readiness = new Promise(resolve => { resolveReady = resolve; });
    const current = () => attempt === attempts && !failed;
    const failedAttempt = reason => { if (current()) fail(reason); };
    if (attempt > 1) {
      try { warn(`[pty] Windows job helper startup retry attempt ${attempt}/${MAX_START_ATTEMPTS}`); } catch {}
    }
    try {
      const script = fs.readFileSync(path.join(__dirname, 'windows-job-helper.ps1'), 'utf8').replace(/\r\n/g, '\n').replace(/^[ \t]+/gm, '');
      child = spawnChild(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', error => failedAttempt(error.message));
      child.on('exit', () => failedAttempt('helper exited'));
      child.stdin.on('error', error => failedAttempt(error.message));
      child.stdout.on('error', error => failedAttempt(error.message));
      child.stderr.on('error', error => failedAttempt(error.message));
      child.stdout.setEncoding?.('utf8');
      child.stdout.on('data', data => { if (current()) receive(data); });
      let stderrLine = '';
      const stderrWarned = new Set();
      const forwardWarning = () => {
        if (!current()) return;
        const line = stderrLine.trim();
        stderrLine = '';
        if (!line) return;
        const kind = line.startsWith('[pty] Windows job command-line read failed;') ? 'command'
          : line.startsWith('[pty] Windows job member cleanup failed;') ? 'member' : 'other';
        if (stderrWarned.has(kind)) return;
        stderrWarned.add(kind);
        try { warn(line); } catch {}
      };
      child.stderr.setEncoding?.('utf8');
      child.stderr.on('data', data => {
        if (!current()) return;
        const text = String(data);
        let start = 0;
        while (start < text.length) {
          const newline = text.indexOf('\n', start);
          const end = newline === -1 ? text.length : newline;
          stderrLine += text.slice(start, Math.min(end, start + 1024 - stderrLine.length));
          if (newline === -1) break;
          forwardWarning();
          start = newline + 1;
        }
      });
      child.stderr.on('end', forwardWarning);
      child.unref?.();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref?.();
      startupTimer = setTimeout(() => failedAttempt('startup timed out'), startupMs);
      startupTimer.unref?.();
    } catch (error) { fail(error.message); }
    return readiness;
  }

  function request(op, id, args = '', current) {
    if (!/^[\w-]+$/.test(id)) return Promise.resolve(false);
    if (failed && op !== 'assign') return Promise.resolve(false);
    start();
    if (failed) return Promise.resolve(false);
    let resolveRequest;
    const done = new Promise(resolve => { resolveRequest = resolve; });
    const entry = { op, id, line: `${op} ${id}${args}`, current, resolve: resolveRequest, done,
      response: { assign: 'assigned', terminate: 'terminated', 'terminate-retained': 'terminated', release: 'released', observe: 'observed' }[op] };
    if (pending.has(id)) {
      if (!waiting.has(id)) waiting.set(id, []);
      waiting.get(id).push(entry);
    } else {
      pending.set(id, entry);
      if (ready) send(entry);
      else queued.set(id, entry);
    }
    return done;
  }

  function finish(op, id, args = '') {
    lateAssignments.delete(id);
    if (!lateAssignments.size) clearTimeout(retryTimer);
    if (op === 'terminate' && !ready && !failed && !earlyCloseWarned) {
      earlyCloseWarned = true;
      try { warn('[pty] Tab closed before Windows job helper ready; using plain ConPTY close; hidden processes may remain'); } catch {}
    }
    const entry = pending.get(id);
    if (entry?.op === 'assign') {
      if (queued.delete(id)) {
        settle(entry, false);
        return Promise.resolve(true);
      }
      return entry.done.then(() => request(op, id, args));
    }
    return request(op, id, args);
  }

  function terminate(id, pids) {
    const sendPids = values => {
      const valid = [...new Set((Array.isArray(values) ? values : []).filter(value => Number.isSafeInteger(value?.pid)
        && value.pid > 0 && value.pid <= 0xffffffff && typeof value.procStart === 'string' && /^\d{17,19}$/.test(value.procStart))
        .map(value => `${value.pid}:${value.procStart}`))];
      return finish('terminate', id, valid.length ? ` ${valid.join(',')}` : '');
    };
    try {
      const values = pids ?? protectedPids();
      if (!values?.then) return sendPids(values);
      let timer;
      const deadline = new Promise(resolve => { timer = setTimeout(() => resolve([]), 50); timer.unref?.(); });
      return Promise.race([Promise.resolve(values).catch(() => []), deadline])
        .then(sendPids).finally(() => clearTimeout(timer));
    } catch { return sendPids([]); }
  }

  async function terminateWithEvidence(id, { deadline = Date.now() + 5000 } = {}) {
    let timer, expired = false;
    const unknown = { ended: false, code: 'UNKNOWN' };
    if (!Number.isFinite(deadline)) return unknown;
    deadline = Math.min(deadline, Date.now() + 15000);
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { expired = true; resolve(null); }, Math.max(0, deadline - Date.now()));
    });
    const bounded = work => Promise.race([Promise.resolve().then(() => {
      if (!expired && Date.now() < deadline) return work();
      expired = true; return null;
    }), timeout]);
    let proof = unknown;
    try {
      const values = await bounded(() => protectedPids());
      if (!Array.isArray(values) || values.some(value => !Number.isSafeInteger(value?.pid) || value.pid <= 0
        || value.pid > 0xffffffff || typeof value.procStart !== 'string' || !/^\d{17,19}$/.test(value.procStart))) return unknown;
      const roster = [...new Set(values.map(value => `${value.pid}:${value.procStart}`))];
      const terminated = await bounded(() => request('terminate-retained', id, roster.length ? ` ${roster.join(',')}` : '',
        () => !expired && Date.now() < deadline));
      if (!terminated) return unknown;
      while (!expired && Date.now() < deadline) {
        const observed = await bounded(() => request('observe', id, '', () => !expired && Date.now() < deadline));
        if (!observed || typeof observed !== 'object') break;
        if (observed.ended === true) { proof = observed; break; }
        await bounded(() => new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now())))));
      }
    } catch { proof = unknown; }
    finally {
      try {
        const releasing = finish('release', id).catch(() => false);
        if (!await bounded(() => releasing)) proof = unknown;
      }
      finally { clearTimeout(timer); }
    }
    return expired ? unknown : proof;
  }

  return {
    start,
    observe(id) {
      if (!ready || failed || pending.has(id)) return Promise.resolve(null);
      return request('observe', id).then(value => value && typeof value === 'object' ? value : null);
    },
    assign(id, pid, spawnTime, current = () => true, { onLateAssignment, current: lateCurrent = current } = {}) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !Number.isSafeInteger(spawnTime)) return Promise.resolve(false);
      const args = ` ${pid} ${spawnTime}`;
      return request('assign', id, args, current).then(assigned => {
        if (!assigned && failed && !ready && attempts < MAX_START_ATTEMPTS && onLateAssignment && lateCurrent()) {
          lateAssignments.set(id, { args, current: lateCurrent, onLateAssignment });
          scheduleRetry();
        }
        return assigned;
      });
    },
    terminate,
    terminateWithEvidence,
    release: id => finish('release', id),
  };
}

let singleton, configuration;
function configureWindowsJobHelper(warn, protectedPids) {
  if (configuration && (configuration.warn !== warn || configuration.protectedPids !== protectedPids)) {
    throw new Error('Windows job helper already configured');
  }
  if (!configuration && singleton) throw new Error('Windows job helper already configured by first use');
  configuration ??= { warn, protectedPids };
  return windowsJobHelper();
}
function windowsJobHelper() {
  singleton ??= createWindowsJobHelper(configuration);
  return singleton;
}

module.exports = { createWindowsJobHelper, configureWindowsJobHelper, windowsJobHelper };
