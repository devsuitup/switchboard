// remote-launch.js — see .ai/contexts/session-cache.md ("Remote hosts — launching a session")
'use strict';

const {
  isValidPid,
  parseTmuxField,
  shellSingleQuote,
  defaultRunRemoteCommand,
} = require('./remote-attach');
const { isValidAlias } = require('./remote-hosts');

const DEFAULT_LAUNCH_TIMEOUT_MS = 20000;
const NO_DIR_EXIT_CODE = 9;
const NO_TMUX_EXIT_CODE = 10;
const NO_CLAUDE_EXIT_CODE = 11;
const MAX_CWD_BYTES = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CWD_RE = /^\/[A-Za-z0-9._+@:,=/ -]*$/;
const PERMISSION_MODES = ['auto', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];
const LAUNCH_OUTPUT_RE = /^([A-Za-z0-9._-]{1,64}:@\d{1,10}\.%\d{1,10}) (\d{1,10})$/;
const LIST_FORMAT = '#{session_name}:#{window_id}.#{pane_id} #{pane_pid}';

function validateSessionId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) return { ok: false, error: 'the session id is not a uuid' };
  return { ok: true };
}

function validateLaunchCwd(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return { ok: false, error: 'the directory must be an absolute path' };
  if (Buffer.byteLength(value) > MAX_CWD_BYTES) return { ok: false, error: 'the directory path is too long' };
  if (!CWD_RE.test(value)) {
    return { ok: false, error: 'the directory may only contain these characters: letters, digits, space and . _ + @ : , = / -' };
  }
  if (value.split('/').includes('..')) return { ok: false, error: 'the directory must not contain a .. segment' };
  return { ok: true };
}

function tmuxSessionName(sessionId) {
  return `switchboard-${sessionId.slice(0, 8).toLowerCase()}`;
}

function buildClaudeArgs(options) {
  const o = options && typeof options === 'object' ? options : {};
  if (o.dangerouslySkipPermissions === true) return { ok: true, args: ['--dangerously-skip-permissions'] };
  if (o.permissionMode == null) return { ok: true, args: [] };
  if (!PERMISSION_MODES.includes(o.permissionMode)) return { ok: false, error: 'unknown permission mode' };
  return { ok: true, args: ['--permission-mode', o.permissionMode] };
}

function buildLaunchScript({ sessionId, cwd, options }) {
  const id = validateSessionId(sessionId);
  if (!id.ok) throw new Error(id.error);
  const dir = validateLaunchCwd(cwd);
  if (!dir.ok) throw new Error(dir.error);
  const flags = buildClaudeArgs(options);
  if (!flags.ok) throw new Error(flags.error);
  const claude = ['claude', '--session-id', sessionId.toLowerCase(), ...flags.args].join(' ');
  return `cwd=${shellSingleQuote(cwd)}; [ -d "$cwd" ] || exit ${NO_DIR_EXIT_CODE}; ` +
    `command -v tmux >/dev/null 2>&1 || exit ${NO_TMUX_EXIT_CODE}; ` +
    `command -v claude >/dev/null 2>&1 || exit ${NO_CLAUDE_EXIT_CODE}; ` +
    `exec tmux new-session -d -P -F '${LIST_FORMAT}' -s ${tmuxSessionName(sessionId)} -c "$cwd" ${shellSingleQuote(claude)}`;
}

function buildLaunchCommand(request) {
  return `sh -c ${shellSingleQuote(buildLaunchScript(request))}`;
}

function parseLaunchOutput(stdout) {
  if (typeof stdout !== 'string') return null;
  const m = LAUNCH_OUTPUT_RE.exec(stdout.trim());
  if (!m || !parseTmuxField(m[1])) return null;
  const pid = Number.parseInt(m[2], 10);
  return isValidPid(pid) ? { tmux: m[1], pid } : null;
}

function createRemoteLaunchAdapter(opts = {}) {
  const runRemoteCommand = opts.runRemoteCommand || defaultRunRemoteCommand;
  const log = opts.log || { info() {}, warn() {}, error() {} };

  async function launch(alias, request) {
    const id = validateSessionId(request && request.sessionId);
    if (!id.ok) return id;
    const dir = validateLaunchCwd(request.cwd);
    if (!dir.ok) return dir;
    const flags = buildClaudeArgs(request.options);
    if (!flags.ok) return flags;

    let result;
    try {
      result = await runRemoteCommand(alias, buildLaunchCommand(request), { timeoutMs: DEFAULT_LAUNCH_TIMEOUT_MS });
    } catch (err) {
      return { ok: false, error: `launch failed: ${err.message}` };
    }
    if (!result) return { ok: false, error: 'launch failed: no response' };
    if (result.timedOut) return { ok: false, error: `launch timed out on ${alias} — the session may have started` };
    if (result.code === NO_DIR_EXIT_CODE) return { ok: false, error: `directory ${request.cwd} does not exist on ${alias}` };
    if (result.code === NO_TMUX_EXIT_CODE) return { ok: false, error: `tmux is not installed on ${alias}` };
    if (result.code === NO_CLAUDE_EXIT_CODE) {
      return { ok: false, error: `claude was not found on the PATH of an ssh command on ${alias}` };
    }
    if (result.code !== 0) {
      const reason = (result.stderr || '').trim() || 'no stderr';
      return { ok: false, error: `launch failed (exit ${result.code}): ${reason}` };
    }
    const parsed = parseLaunchOutput(result.stdout);
    if (!parsed) {
      return { ok: false, error: `launch ran on ${alias} but its tmux target could not be read (session ${tmuxSessionName(request.sessionId)})` };
    }
    log.info(`[remote-launch:${alias}] started ${parsed.tmux} (pid ${parsed.pid}) in ${request.cwd}`);
    return { ok: true, descriptor: { sessionId: request.sessionId.toLowerCase(), pid: parsed.pid, tmux: parsed.tmux, cwd: request.cwd } };
  }

  return { launch };
}

function normalizeSize(size) {
  const ok = size && Number.isInteger(size.cols) && size.cols > 0 && Number.isInteger(size.rows) && size.rows > 0;
  return ok ? { cols: size.cols, rows: size.rows } : null;
}

async function handleLaunchRequest(payload, deps) {
  const alias = payload && payload.alias;
  if (typeof alias !== 'string' || !isValidAlias(alias) || !deps.hasHost(alias)) return { ok: false, error: 'invalid request' };
  const id = validateSessionId(payload.sessionId);
  if (!id.ok) return id;
  const dir = validateLaunchCwd(payload.cwd);
  if (!dir.ok) return dir;
  const flags = buildClaudeArgs(payload.options);
  if (!flags.ok) return flags;

  const blocked = deps.launchBlockReason(alias);
  if (blocked) return { ok: false, error: blocked };

  const launched = await deps.adapter.launch(alias, { sessionId: payload.sessionId, cwd: payload.cwd, options: payload.options });
  if (!launched.ok) return launched;

  const attachResult = await deps.attach(alias, launched.descriptor, normalizeSize(payload.initialSize));
  if (!attachResult || !attachResult.ok) {
    const why = (attachResult && attachResult.error) || 'no response';
    return { ok: false, error: `the session was started on ${alias} as ${launched.descriptor.tmux} but attaching failed: ${why}` };
  }
  return { ok: true, descriptor: launched.descriptor, attachResult };
}

module.exports = {
  validateLaunchCwd,
  validateSessionId,
  buildClaudeArgs,
  buildLaunchScript,
  buildLaunchCommand,
  parseLaunchOutput,
  tmuxSessionName,
  createRemoteLaunchAdapter,
  handleLaunchRequest,
  NO_DIR_EXIT_CODE,
  NO_TMUX_EXIT_CODE,
  NO_CLAUDE_EXIT_CODE,
  PERMISSION_MODES,
};
