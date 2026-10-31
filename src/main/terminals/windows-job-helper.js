'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function createWindowsJobHelper({ spawn: spawnChild = spawn, warn = () => {}, startupMs = 15000,
  requestMs = 3000, protectedPids = () => [] } = {}) {
  let child, started = false, ready = false, failed = false, buffer = '', startupTimer, earlyCloseWarned = false;
  const pending = new Map();
  const queued = new Map();
  let resolveReady;
  const readiness = new Promise(resolve => { resolveReady = resolve; });

  function fail(reason) {
    if (failed) return;
    failed = true;
    clearTimeout(startupTimer);
    resolveReady(false);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve(false); }
    pending.clear(); queued.clear();
    try { warn(`[pty] Windows job helper unavailable; using plain ConPTY close: ${reason}`); } catch {}
    try { child?.kill(); } catch {}
  }

  function send(entry) {
    if (failed) return;
    if (entry.current && !entry.current()) {
      pending.delete(entry.id); entry.resolve(false); return;
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
      const match = /^(assigned|terminated|released|error) ([\w-]+)(?: (\d+))?$/.exec(line);
      if (!match) return fail('invalid protocol response');
      const entry = pending.get(match[2]);
      if (!entry || (match[1] !== 'error' && match[1] !== entry.response)) return fail('unexpected protocol response');
      pending.delete(entry.id); clearTimeout(entry.timer);
      if (match[1] === 'error') {
        try { warn(`[pty] Windows job ${entry.id} ${entry.op} failed: ${match[3]}`); } catch {}
      }
      entry.resolve(match[1] !== 'error');
    }
  }

  function start() {
    if (started) return readiness;
    started = true;
    try {
      const script = fs.readFileSync(path.join(__dirname, 'windows-job-helper.ps1'), 'utf8');
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
    return new Promise(resolve => {
      const entry = { op, id, line: `${op} ${id}${args}`, current, resolve,
        response: { assign: 'assigned', terminate: 'terminated', release: 'released' }[op] };
      pending.set(id, entry);
      if (ready) send(entry);
      else queued.set(id, entry);
    });
  }

  function finish(op, id, args = '') {
    if (op === 'terminate' && !ready && !failed && !earlyCloseWarned) {
      earlyCloseWarned = true;
      try { warn('[pty] Tab closed before Windows job helper ready; using plain ConPTY close; hidden processes may remain'); } catch {}
    }
    const entry = pending.get(id);
    if (entry?.op === 'assign') {
      if (queued.delete(id)) {
        pending.delete(id); entry.resolve(false);
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

  return {
    start,
    assign(id, pid, spawnTime, current = () => true) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !Number.isSafeInteger(spawnTime)) return Promise.resolve(false);
      const done = request('assign', id, ` ${pid} ${spawnTime}`, current);
      const entry = pending.get(id);
      if (entry) entry.done = done;
      return done;
    },
    terminate,
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
