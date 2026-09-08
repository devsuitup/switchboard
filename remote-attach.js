// remote-attach.js — see .ai/contexts/session-cache.md ("Remote hosts — tmux attach")
'use strict';

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach")

const TMUX_FIELD_RE = /^([A-Za-z0-9._-]{1,64}):(@?\d{1,10}(?:\.%?\d{1,10})?)$/;
const PROBE_SEP = '\u0001';
const DETACH_KEYS = '\x02d'; // Ctrl-B d — tmux default prefix, then detach
const DETACH_GRACE_MS = 150;
const DEFAULT_PROBE_TIMEOUT_MS = 15000;
const DEFAULT_STATUS_LINES = 1;

/** Parse the CLI-written `tmux` descriptor field, e.g. "main:@0.%0". */
function parseTmuxField(value) {
  if (typeof value !== 'string') return null;
  const m = TMUX_FIELD_RE.exec(value);
  if (!m) return null;
  return { socket: m[1], target: value };
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", sizing rule)
function parseProbeOutput(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const idx = text.indexOf(PROBE_SEP);
  const sizePart = idx === -1 ? text : text.slice(0, idx);
  const statusPart = idx === -1 ? '' : text.slice(idx + PROBE_SEP.length);

  const sizeMatch = /(\d+)x(\d+)/.exec(sizePart);
  if (!sizeMatch) return null;
  const width = Number.parseInt(sizeMatch[1], 10);
  const height = Number.parseInt(sizeMatch[2], 10);

  let statusLines = DEFAULT_STATUS_LINES;
  const statusMatch = /status\s+(\S+)/.exec(statusPart);
  if (statusMatch) {
    if (statusMatch[1] === 'off') statusLines = 0;
    else if (statusMatch[1] === 'on') statusLines = 1;
    else {
      const n = Number.parseInt(statusMatch[1], 10);
      if (Number.isFinite(n) && n >= 0) statusLines = n;
    }
  }

  return { cols: width, rows: height + statusLines };
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", injection guard)
function buildProbeCommand(parsed) {
  return `tmux -L ${parsed.socket} display-message -p -t ${parsed.target} '#{window_width}x#{window_height}'` +
    `; printf '${PROBE_SEP}'; tmux -L ${parsed.socket} show-options -A -t ${parsed.socket} status 2>/dev/null`;
}

function buildAttachCommand(parsed) {
  return `tmux -L ${parsed.socket} attach -t ${parsed.target}`;
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach")
function defaultResolveSshPath() {
  if (process.env.SWITCHBOARD_SSH_PATH) return process.env.SWITCHBOARD_SSH_PATH;
  const fs = require('fs');
  const path = require('path');
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'ssh.exe'),
      ]
    : ['/usr/bin/ssh'];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return 'ssh';
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach")
function defaultRunRemoteCommand(alias, command, { timeoutMs } = {}) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ssh', ['-o', 'BatchMode=yes', '-n', alias, command], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs || DEFAULT_PROBE_TIMEOUT_MS);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr.slice(0, 4096) });
    };
    if (child.stdout) child.stdout.on('data', (c) => { stdout += c; });
    if (child.stderr) child.stderr.on('data', (c) => { if (stderr.length < 4096) stderr += c; });
    child.on('error', (err) => { stderr += err.message; finish(-1); });
    child.on('close', (code) => finish(code == null ? -1 : code));
  });
}

/**
 * Adapter for attaching a local PTY to a remote session through its tmux
 * multiplexer. Indexed on the descriptor's `tmux` field, never on host
 * detection — a descriptor without it is refused before any ssh call.
 *
 * @param {object} opts
 * @param {function} opts.spawnPty  (file, args, ptyOpts) => IPty-like
 *   { onData, onExit, write, resize, kill, pid } — the caller's own
 *   node-pty wrapper (conpty selection, env, cwd are the caller's concern).
 * @param {function} [opts.runRemoteCommand]  (alias, command, {timeoutMs})
 *   => Promise<{code, stdout, stderr}> — non-interactive ssh exec, injected
 *   for tests; defaults to a real ssh child process.
 * @param {function} [opts.resolveSshPath]  () => string
 * @param {object}   [opts.log]
 */
function createTmuxAttachAdapter(opts = {}) {
  const spawnPtyFn = opts.spawnPty;
  if (typeof spawnPtyFn !== 'function') {
    throw new Error('createTmuxAttachAdapter requires opts.spawnPty');
  }
  const runRemoteCommand = opts.runRemoteCommand || defaultRunRemoteCommand;
  const resolveSshPath = opts.resolveSshPath || defaultResolveSshPath;
  const log = opts.log || { info() {}, warn() {}, error() {} };

  /** Whether this descriptor names a multiplexer this adapter can attach to. */
  function supports(descriptor) {
    return !!(descriptor && parseTmuxField(descriptor.tmux));
  }

  async function attach(alias, descriptor) {
    const parsed = descriptor && parseTmuxField(descriptor.tmux);
    if (!parsed) {
      return { ok: false, error: 'session carries no tmux target — attach is not supported for this host' };
    }

    let probe;
    try {
      probe = await runRemoteCommand(alias, buildProbeCommand(parsed), { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
    } catch (err) {
      return { ok: false, error: `size probe failed: ${err.message}` };
    }
    if (!probe || probe.code !== 0) {
      const reason = (probe && probe.stderr || '').trim() || 'no stderr';
      return { ok: false, error: `size probe failed (exit ${probe ? probe.code : 'n/a'}): ${reason}` };
    }
    const size = parseProbeOutput(probe.stdout);
    if (!size) {
      return { ok: false, error: 'could not parse the remote window size' };
    }

    const sshPath = resolveSshPath();
    const argv = ['-tt', '-o', 'BatchMode=yes', alias, buildAttachCommand(parsed)];

    let raw;
    try {
      raw = spawnPtyFn(sshPath, argv, { name: 'xterm-256color', cols: size.cols, rows: size.rows });
    } catch (err) {
      return { ok: false, error: `attach spawn failed: ${err.message}` };
    }

    let alive = true;
    raw.onExit(() => { alive = false; });

    let detaching = false;
    function detach() {
      if (detaching || !alive) return;
      detaching = true;
      try { raw.write(DETACH_KEYS); } catch {}
      // see .ai/contexts/session-cache.md ("Remote hosts — tmux attach")
      setTimeout(() => { try { raw.kill(); } catch {} }, DETACH_GRACE_MS);
    }

    const ptyProcess = {
      write(data) { if (alive) raw.write(data); },
      resize() {}, // fixed at attach time — see .ai/contexts/session-cache.md ("Remote hosts — tmux attach")
      kill: detach,
      onData(cb) { return raw.onData(cb); },
      onExit(cb) { return raw.onExit(cb); },
      isAlive() { return alive; },
      get pid() { return raw.pid; },
    };

    log.info(`[remote-attach:${alias}] attached ${parsed.target} at ${size.cols}x${size.rows}`);
    return { ok: true, ptyProcess, cols: size.cols, rows: size.rows };
  }

  return { supports, attach };
}

module.exports = {
  createTmuxAttachAdapter,
  parseTmuxField,
  parseProbeOutput,
  buildProbeCommand,
  buildAttachCommand,
  DETACH_KEYS,
};
