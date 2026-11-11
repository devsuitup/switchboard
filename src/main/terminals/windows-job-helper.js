'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function createWindowsJobHelper({ spawn: spawnChild = spawn, warn = () => {}, startupMs = 15000,
  requestMs = 3000, protectedPids = () => [] } = {}) {
  let child, started = false, ready = false, failed = false, buffer = '', startupTimer, earlyCloseWarned = false;
  const pending = new Map();
  const queued = new Map();
  const waiting = new Map();
  let resolveReady;
  const readiness = new Promise(resolve => { resolveReady = resolve; });

  function fail(reason) {
    if (failed) return;
    failed = true;
    clearTimeout(startupTimer);
    resolveReady(false);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve(false); }
    for (const entries of waiting.values()) for (const entry of entries) entry.resolve(false);
    pending.clear(); queued.clear(); waiting.clear();
    try { warn(`[pty] Windows job helper unavailable; using plain ConPTY close: ${reason}`); } catch {}
    try { child?.kill(); } catch {}
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
        continue;
      }
      const match = /^(assigned|terminated|released|observed|error) ([\w-]+)(?: (\d+))?$/.exec(line);
      if (!match) return fail('invalid protocol response');
      const entry = pending.get(match[2]);
      if (!entry || (match[1] !== 'error' && match[1] !== entry.response)) return fail('unexpected protocol response');
      if (match[1] === 'error') {
        try { warn(`[pty] Windows job ${entry.id} ${entry.op} failed: ${match[3]}`); } catch {}
      }
      settle(entry, match[1] === 'observed' ? { ended: match[3] === '0', observedAt: Date.now() } : match[1] !== 'error');
    }
  }

  function start() {
    if (started) return readiness;
    started = true;
    try {
      const script = fs.readFileSync(path.join(__dirname, 'windows-job-helper.ps1'), 'utf8').replace(/\r\n/g, '\n').replace(/^[ \t]+/gm, '');
      child = spawnChild(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', error => fail(error.message));
      child.on('exit', () => fail('helper exited'));
      child.stdin.on('error', error => fail(error.message));
      child.stdout.on('error', error => fail(error.message));
      child.stderr.on('error', error => fail(error.message));
      child.stdout.setEncoding?.('utf8');
      child.stdout.on('data', receive);
      let stderrWarned = false;
      child.stderr.on('data', data => {
        if (stderrWarned) return;
        stderrWarned = true;
        try { warn(String(data).slice(0, 1024).trim()); } catch {}
      });
      child.unref?.();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref?.();
      startupTimer = setTimeout(() => fail('startup timed out'), startupMs);
      startupTimer.unref?.();
    } catch (error) { fail(error.message); }
    return readiness;
  }

  function request(op, id, args = '', current) {
    if (!/^[\w-]+$/.test(id)) return Promise.resolve(false);
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
      timer = setTimeout(() => { expired = true; fail('stop evidence timed out'); resolve(null); }, Math.max(0, deadline - Date.now()));
    });
    const bounded = work => Promise.race([Promise.resolve().then(() => {
      if (!expired && Date.now() < deadline) return work();
      expired = true; fail('stop evidence timed out'); return null;
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
        const observed = await bounded(() => request('observe', id));
        if (!observed || typeof observed !== 'object') break;
        if (observed.ended === true) { proof = observed; break; }
        await bounded(() => new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now())))));
      }
    } catch { proof = unknown; }
    finally {
      try { if (!await bounded(() => finish('release', id))) proof = unknown; }
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
    assign(id, pid, spawnTime, current = () => true) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !Number.isSafeInteger(spawnTime)) return Promise.resolve(false);
      return request('assign', id, ` ${pid} ${spawnTime}`, current);
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
