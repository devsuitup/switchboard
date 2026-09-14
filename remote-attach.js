// remote-attach.js — see .ai/contexts/session-cache.md ("Remote hosts — tmux attach")
'use strict';

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach")

const TMUX_FIELD_RE = /^([A-Za-z0-9._-]{1,64}):(@?\d{1,10}(?:\.%?\d{1,10})?)$/;
const PROBE_SEP = '\u0001';
const DEFAULT_PROBE_TIMEOUT_MS = 15000;
const DEFAULT_STATUS_LINES = 1;
const NO_TMUX_ENV_EXIT_CODE = 3;
const NO_TMUX_ENV_MARKER = 'NO_TMUX_ENV';

/** Parse the CLI-written `tmux` descriptor field, e.g. "main:@0.%0". */
function parseTmuxField(value) {
  if (typeof value !== 'string') return null;
  const m = TMUX_FIELD_RE.exec(value);
  if (!m) return null;
  return { socket: m[1], target: value };
}

function isValidPid(pid) {
  return Number.isInteger(pid) && pid > 0 && pid < 2 ** 31;
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", socket discovery)
function isSafeSocketPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/['"\\\s]/.test(value);
}

function escapeRegExpLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", sizing rule)
// "status* on" = inherited, "status on" = session override — see .ai/contexts/session-cache.md ("solo attach parity, issue #253")
function parseOptionToken(part, name) {
  const re = new RegExp(`${escapeRegExpLiteral(name)}(\\*?)\\s+(\\S+)`);
  const m = re.exec(part || '');
  if (!m) return { value: null, inherited: false };
  return { value: m[2], inherited: m[1] === '*' };
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles, issue #290)
function unescapeTmuxOptionString(raw) {
  let body = raw;
  if (body.length >= 2 && (body[0] === '"' || body[0] === "'") && body[body.length - 1] === body[0]) {
    body = body.slice(1, -1);
  }
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) {
      const next = body[i + 1];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles, issue #290)
function parseTitleStringToken(part, name) {
  const re = new RegExp(`${escapeRegExpLiteral(name)}(\\*?)\\s+([\\s\\S]*)`);
  const m = re.exec(part || '');
  if (!m) return { value: null, inherited: false };
  const raw = m[2].replace(/\r?\n+$/, '');
  return { value: unescapeTmuxOptionString(raw), inherited: m[1] === '*' };
}

function parseProbeOutput(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const parts = text.split(PROBE_SEP);
  const sizePart = parts[0] || '';
  const statusPart = parts[1] || '';
  const mousePart = parts[2] || '';
  const windowSizePart = parts[3] || '';
  const setTitlesPart = parts[4] || '';
  const setTitlesStringPart = parts[5] || '';

  const sizeMatch = /(\d+)x(\d+)/.exec(sizePart);
  if (!sizeMatch) return null;
  const width = Number.parseInt(sizeMatch[1], 10);
  const height = Number.parseInt(sizeMatch[2], 10);

  let statusLines = DEFAULT_STATUS_LINES;
  let status = null;
  const statusParsed = parseOptionToken(statusPart, 'status');
  if (statusParsed.value != null) {
    if (statusParsed.value === 'off') { statusLines = 0; status = 'off'; }
    else if (statusParsed.value === 'on') { statusLines = 1; status = 'on'; }
    else {
      const n = Number.parseInt(statusParsed.value, 10);
      if (Number.isFinite(n) && n >= 0) { statusLines = n; status = n; }
    }
  }

  let mouse = null;
  const mouseParsed = parseOptionToken(mousePart, 'mouse');
  if (mouseParsed.value === 'on' || mouseParsed.value === 'off') mouse = mouseParsed.value;

  let windowSize = null;
  const windowSizeParsed = parseOptionToken(windowSizePart, 'window-size');
  if (['latest', 'largest', 'smallest', 'manual'].includes(windowSizeParsed.value)) windowSize = windowSizeParsed.value;

  let setTitles = null;
  const setTitlesParsed = parseOptionToken(setTitlesPart, 'set-titles');
  if (setTitlesParsed.value === 'on' || setTitlesParsed.value === 'off') setTitles = setTitlesParsed.value;

  const setTitlesStringParsed = parseTitleStringToken(setTitlesStringPart, 'set-titles-string');

  // pre.<opt> non-null only for a session-scoped override; null means restore by `set -u`
  return {
    cols: width,
    rows: height + statusLines,
    pre: {
      status: statusParsed.inherited ? null : status,
      mouse: mouseParsed.inherited ? null : mouse,
      windowSize: windowSizeParsed.inherited ? null : windowSize,
      setTitles: setTitlesParsed.inherited ? null : setTitles,
      setTitlesString: setTitlesStringParsed.inherited ? null : setTitlesStringParsed.value,
    },
  };
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", pid-reuse guard)
function buildProcCmdlineCheck(pid) {
  return `tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null | grep -qi claude && echo 1 || echo 0`;
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", socket discovery)
function buildProbeCommand(pid, target) {
  return `sock=$(tr '\\0' '\\n' < /proc/${pid}/environ 2>/dev/null | grep -m1 '^TMUX=' | cut -d= -f2- | cut -d, -f1); ` +
    `if [ -z "$sock" ]; then echo ${NO_TMUX_ENV_MARKER} >&2; exit ${NO_TMUX_ENV_EXIT_CODE}; fi; ` +
    `printf '%s${PROBE_SEP}' "$sock"; ` +
    `tmux -S "$sock" display-message -p -t ${target} '#{window_width}x#{window_height}'` +
    `; printf '${PROBE_SEP}'; tmux -S "$sock" show-options -A -t ${target} status 2>/dev/null` +
    `; printf '${PROBE_SEP}'; tmux -S "$sock" show-options -A -t ${target} mouse 2>/dev/null` +
    `; printf '${PROBE_SEP}'; tmux -S "$sock" show-options -A -t ${target} window-size 2>/dev/null` +
    `; printf '${PROBE_SEP}'; tmux -S "$sock" show-options -A -t ${target} set-titles 2>/dev/null` +
    `; printf '${PROBE_SEP}'; tmux -S "$sock" show-options -A -t ${target} set-titles-string 2>/dev/null` +
    `; printf '${PROBE_SEP}'; tmux -S "$sock" list-clients -t ${target} 2>/dev/null | wc -l` +
    `; printf '${PROBE_SEP}'; ${buildProcCmdlineCheck(pid)}`;
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles, issue #290)
function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles, issue #290)
function buildAttachCommand(socket, target, opts = {}) {
  const titleSegments = [
    `set -t ${target} set-titles on`,
    `set -t ${target} set-titles-string '#T'`,
  ];
  if (!opts.solo) {
    return `tmux -S '${socket}' ${[...titleSegments, `attach -t ${target}`].join(' \\; ')}`;
  }
  const segments = [
    `set -t ${target} status off`,
    `set -t ${target} mouse on`,
    `set -t ${target} window-size latest`,
    ...titleSegments,
    `attach -t ${target}`,
  ];
  return `tmux -S '${socket}' ${segments.join(' \\; ')}`;
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", solo attach parity, issue #253)
function buildRestoreOptionSegment(target, name, value, opts = {}) {
  if (value == null) return `set -u -t ${target} ${name}`;
  return `set -t ${target} ${name} ${opts.quote ? shellSingleQuote(value) : value}`;
}

// includeBase/includeTitles — see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles, issue #290)
function buildRestoreCommand(socket, target, pre, opts = {}) {
  const p = pre || {};
  const includeBase = opts.includeBase !== false;
  const includeTitles = opts.includeTitles !== false;
  const segments = [];
  if (includeBase) {
    segments.push(
      buildRestoreOptionSegment(target, 'status', p.status),
      buildRestoreOptionSegment(target, 'mouse', p.mouse),
      buildRestoreOptionSegment(target, 'window-size', p.windowSize),
    );
  }
  if (includeTitles) {
    segments.push(
      buildRestoreOptionSegment(target, 'set-titles', p.setTitles),
      buildRestoreOptionSegment(target, 'set-titles-string', p.setTitlesString, { quote: true }),
    );
  }
  return segments.length ? `tmux -S '${socket}' ${segments.join(' \\; ')}` : null;
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", solo vs shared)
function parseClientCount(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles, issue #290)
function buildClientCountProbeCommand(socket, target) {
  return `tmux -S '${socket}' list-clients -t ${target} 2>/dev/null | wc -l`;
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", socket discovery)
// parts: [socket, size, status, mouse, window-size, set-titles, set-titles-string,
// clientCount, cmdlineHasClaude]; trailing ones optional
function parseDiscoveryProbeOutput(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const parts = text.split(PROBE_SEP);
  const socket = parts[0] || '';
  if (parts.length < 3 || !isSafeSocketPath(socket)) return null;
  const probed = parseProbeOutput(parts.slice(1, 7).join(PROBE_SEP));
  if (!probed) return null;
  const clientCount = parseClientCount(parts[7]);
  const cmdlineHasClaude = parts[8] === '1' ? true : parts[8] === '0' ? false : null;
  return { socket, cols: probed.cols, rows: probed.rows, pre: probed.pre, clientCount, cmdlineHasClaude };
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

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", ConnectTimeout on the probe/restore ssh)
function buildRemoteCommandArgs(alias, command) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-n', alias, command];
}

// Default stdout cap for a single ssh exec — see .ai/contexts/changes-view.md ("Remote transport stdout cap").
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach") and .ai/contexts/changes-view.md ("Remote transport stdout cap")
function defaultRunRemoteCommand(alias, command, { timeoutMs, maxStdoutBytes, spawnFn } = {}) {
  const spawn = spawnFn || require('child_process').spawn;
  const stdoutCap = typeof maxStdoutBytes === 'number' ? maxStdoutBytes : DEFAULT_MAX_STDOUT_BYTES;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ssh', buildRemoteCommandArgs(alias, command), {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message });
      return;
    }
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    let overflowed = false;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs || DEFAULT_PROBE_TIMEOUT_MS);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (overflowed) {
        resolve({ code: -1, stdout: '', stderr: `stdout exceeded ${stdoutCap} bytes` });
        return;
      }
      resolve({ code, stdout, stderr: stderr.slice(0, 4096) });
    };
    if (child.stdout) child.stdout.on('data', (c) => {
      if (overflowed) return;
      stdoutBytes += Buffer.byteLength(c);
      if (stdoutBytes > stdoutCap) {
        overflowed = true;
        try { child.kill('SIGKILL'); } catch {}
        return;
      }
      stdout += c;
    });
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
  const log = opts.log || { info() {}, warn() {}, error() {}, debug() {} };
  // see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles, issue #290)
  function logDebug(msg) {
    if (typeof log.debug === 'function') log.debug(msg);
    else if (typeof log.info === 'function') log.info(msg);
  }

  /** Whether this descriptor names a multiplexer this adapter can attach to. */
  function supports(descriptor) {
    return !!(descriptor && parseTmuxField(descriptor.tmux) && isValidPid(descriptor.pid));
  }

  // localSize: {cols, rows} the caller measured locally — used only when the
  // probe finds no other attached client (see .ai/contexts/session-cache.md,
  // "Remote hosts — tmux attach", solo vs shared).
  async function attach(alias, descriptor, localSize) {
    const parsed = descriptor && parseTmuxField(descriptor.tmux);
    if (!parsed) {
      return { ok: false, error: 'session carries no tmux target — attach is not supported for this host' };
    }
    if (!isValidPid(descriptor.pid)) {
      return { ok: false, error: 'session carries no readable pid — cannot discover its tmux socket' };
    }

    let probe;
    try {
      probe = await runRemoteCommand(alias, buildProbeCommand(descriptor.pid, parsed.target), { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
    } catch (err) {
      return { ok: false, error: `size probe failed: ${err.message}` };
    }
    if (!probe) {
      return { ok: false, error: 'size probe failed: no response' };
    }
    if (probe.code === NO_TMUX_ENV_EXIT_CODE) {
      return { ok: false, error: `process ${descriptor.pid} carries no readable TMUX environment variable — cannot discover its tmux socket` };
    }
    if (probe.code !== 0) {
      const reason = (probe.stderr || '').trim() || 'no stderr';
      return { ok: false, error: `size probe failed (exit ${probe.code}): ${reason}` };
    }
    const discovery = parseDiscoveryProbeOutput(probe.stdout);
    if (!discovery) {
      return { ok: false, error: 'could not parse the remote window size' };
    }

    // pid-reuse guard — see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", pid-reuse guard)
    if (discovery.cmdlineHasClaude === false) {
      return { ok: false, error: `pid ${descriptor.pid} now belongs to a process that is not a claude CLI — the session is gone` };
    }

    // see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", solo vs shared)
    const hasLocalSize = !!localSize
      && Number.isInteger(localSize.cols) && localSize.cols > 0
      && Number.isInteger(localSize.rows) && localSize.rows > 0;
    const solo = discovery.clientCount === 0 && hasLocalSize;
    const openCols = solo ? localSize.cols : discovery.cols;
    const openRows = solo ? localSize.rows : discovery.rows;

    const sshPath = resolveSshPath();
    const argv = ['-tt', '-o', 'BatchMode=yes', alias, buildAttachCommand(discovery.socket, parsed.target, { solo, pre: discovery.pre })];

    let raw;
    try {
      raw = spawnPtyFn(sshPath, argv, { name: 'xterm-256color', cols: openCols, rows: openRows });
    } catch (err) {
      return { ok: false, error: `attach spawn failed: ${err.message}` };
    }

    let alive = true;
    raw.onExit(() => { alive = false; });

    let detaching = false;
    // Ending the local ssh client is what detaches: the remote tmux client
    // loses its pty and tmux drops it, leaving the session running. Sending a
    // prefix keystroke instead would assume this host's prefix, and land as
    // literal text in the remote session on any host that remapped it.
    // see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles, issue #290)
    async function restoreOnDetach() {
      let includeTitles = true;
      try {
        const clientProbe = await runRemoteCommand(alias, buildClientCountProbeCommand(discovery.socket, parsed.target), { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
        if (clientProbe && clientProbe.code === 0) {
          const count = parseClientCount(clientProbe.stdout);
          if (count != null) includeTitles = count <= 1;
        }
      } catch {
        // see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles, issue #290)
      }
      if (!includeTitles) {
        logDebug(`[remote-attach:${alias}] skipping title restore on detach — another client is still attached to ${parsed.target}`);
      }
      const restoreCmd = buildRestoreCommand(discovery.socket, parsed.target, discovery.pre, { includeBase: solo, includeTitles });
      if (!restoreCmd) return;
      const result = await runRemoteCommand(alias, restoreCmd, { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
      if (!result || result.code !== 0) {
        const reason = result ? `exit ${result.code}: ${(result.stderr || '').trim() || 'no stderr'}` : 'no response';
        log.warn(`[remote-attach:${alias}] restore-on-detach failed (${reason})`);
      }
    }

    function detach() {
      if (detaching || !alive) return;
      detaching = true;
      try { raw.kill(); } catch {}
      // best-effort restore, every detach — see .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles, issue #290)
      restoreOnDetach().catch((err) => log.warn(`[remote-attach:${alias}] restore-on-detach failed: ${err && err.message}`));
    }

    const ptyProcess = {
      write(data) { if (alive) raw.write(data); },
      resize(cols, rows) {
        if (!solo || !alive) return;
        try { raw.resize(cols, rows); } catch {}
      },
      kill: detach,
      onData(cb) { return raw.onData(cb); },
      onExit(cb) { return raw.onExit(cb); },
      isAlive() { return alive; },
      get pid() { return raw.pid; },
    };

    if (solo) {
      log.info(`[remote-attach:${alias}] attached ${parsed.target} at ${openCols}x${openRows} (solo — following local resizes)`);
    } else {
      const reason = discovery.clientCount == null
        ? 'attached client count unknown, failing closed'
        : discovery.clientCount > 0
          ? `${discovery.clientCount} other client(s) already attached`
          : 'no local size supplied';
      log.info(`[remote-attach:${alias}] attached ${parsed.target} at ${openCols}x${openRows} (fixed at attach time — ${reason})`);
    }
    return { ok: true, ptyProcess, cols: openCols, rows: openRows };
  }

  return { supports, attach };
}

module.exports = {
  createTmuxAttachAdapter,
  parseTmuxField,
  parseProbeOutput,
  parseDiscoveryProbeOutput,
  buildProbeCommand,
  buildAttachCommand,
  buildRestoreCommand,
  buildRemoteCommandArgs,
  buildClientCountProbeCommand,
  shellSingleQuote,
  isValidPid,
  buildProcCmdlineCheck,
  defaultRunRemoteCommand,
  DEFAULT_MAX_STDOUT_BYTES,
};
