// remote-stop.js — see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")
'use strict';

const {
  isValidPid,
  parseTmuxField,
  buildProcCmdlineCheck,
  buildRemoteCommandArgs,
  defaultRunRemoteCommand,
} = require('./remote-attach');

const DEFAULT_STOP_TIMEOUT_MS = 15000;
const NOT_CLAUDE_EXIT_CODE = 7;
const NOT_CLAUDE_MARKER = 'NOT_CLAUDE';
const TMUX_PANE_KILLED_MARKER = 'TMUX_PANE_KILLED';
const TMUX_WINDOW_KILLED_MARKER = 'TMUX_WINDOW_KILLED';
const PID_TERM_MARKER = 'PID_KILLED_TERM';
const PID_FORCE_MARKER = 'PID_KILLED_FORCE';
// ~3s: kill -TERM, then poll /proc/<pid> six times at 0.5s before kill -KILL.
const TERM_WAIT_TICKS = 6;
const TERM_WAIT_STEP_S = '0.5';

// see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")
function buildRefusalGuard(pid) {
  const check = buildProcCmdlineCheck(pid);
  return `alive=$(${check}); if [ "$alive" != "1" ]; then echo ${NOT_CLAUDE_MARKER}; exit ${NOT_CLAUDE_EXIT_CODE}; fi;`;
}

// shared /proc poll, no signal sent here — see .ai/contexts/session-state.md
function buildDeathPoll(pid) {
  return `i=0; while [ -d /proc/${pid} ] && [ $i -lt ${TERM_WAIT_TICKS} ]; do sleep ${TERM_WAIT_STEP_S}; i=$((i+1)); done;`;
}

function buildKillByPidSegment(pid) {
  return `kill -TERM ${pid} 2>/dev/null; ${buildDeathPoll(pid)} ` +
    `if [ -d /proc/${pid} ]; then kill -KILL ${pid} 2>/dev/null; echo ${PID_FORCE_MARKER}; else echo ${PID_TERM_MARKER}; fi; exit 0`;
}

// pane present only when a "." follows the window component — see .ai/contexts/session-state.md
function targetHasPane(target) {
  const idx = target.indexOf(':');
  const winPane = idx >= 0 ? target.slice(idx + 1) : target;
  return winPane.includes('.');
}

// see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")
function buildStopCommand(pid, tmuxTarget) {
  const guard = buildRefusalGuard(pid);
  const killByPid = buildKillByPidSegment(pid);
  if (!tmuxTarget) return `${guard} ${killByPid}`;

  // never kill-session, siblings share the tmux session — see .ai/contexts/session-state.md
  const hasPane = targetHasPane(tmuxTarget);
  const tmuxSubcommand = hasPane ? 'kill-pane' : 'kill-window';
  const tmuxMarker = hasPane ? TMUX_PANE_KILLED_MARKER : TMUX_WINDOW_KILLED_MARKER;

  const sockDiscovery = `sock=$(tr '\\0' '\\n' < /proc/${pid}/environ 2>/dev/null | grep -m1 '^TMUX=' | cut -d= -f2- | cut -d, -f1);`;
  // confirm death before declaring success — see .ai/contexts/session-state.md
  const deathPoll = buildDeathPoll(pid);
  return `${guard} ${sockDiscovery} ` +
    `if [ -n "$sock" ] && tmux -S "$sock" ${tmuxSubcommand} -t ${tmuxTarget} 2>/dev/null; then ` +
    `${deathPoll} if [ ! -d /proc/${pid} ]; then echo ${tmuxMarker}; exit 0; fi; fi; ` +
    killByPid;
}

// see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")
function createRemoteStopAdapter(opts = {}) {
  const runRemoteCommand = opts.runRemoteCommand || defaultRunRemoteCommand;
  const log = opts.log || { info() {}, warn() {}, error() {} };

  async function stop(alias, descriptor) {
    if (!isValidPid(descriptor && descriptor.pid)) {
      return { ok: false, error: 'session carries no readable pid — cannot stop it' };
    }
    const parsedTmux = descriptor.tmux ? parseTmuxField(descriptor.tmux) : null;
    const command = buildStopCommand(descriptor.pid, parsedTmux ? parsedTmux.target : null);

    let result;
    try {
      result = await runRemoteCommand(alias, command, { timeoutMs: DEFAULT_STOP_TIMEOUT_MS });
    } catch (err) {
      return { ok: false, error: `stop failed: ${err.message}` };
    }
    if (!result) return { ok: false, error: 'stop failed: no response' };

    const stdout = result.stdout || '';
    if (result.code === NOT_CLAUDE_EXIT_CODE || stdout.includes(NOT_CLAUDE_MARKER)) {
      return { ok: false, error: `pid ${descriptor.pid} now belongs to a process that is not a claude CLI — the session is gone` };
    }
    if (result.code !== 0) {
      const reason = (result.stderr || '').trim() || 'no stderr';
      return { ok: false, error: `stop failed (exit ${result.code}): ${reason}` };
    }

    const method = stdout.includes(TMUX_PANE_KILLED_MARKER) ? 'tmux-pane'
      : stdout.includes(TMUX_WINDOW_KILLED_MARKER) ? 'tmux-window'
        : stdout.includes(PID_FORCE_MARKER) ? 'pid-kill'
          : stdout.includes(PID_TERM_MARKER) ? 'pid-term'
            : 'unknown';
    log.info(`[remote-stop:${alias}] stopped pid ${descriptor.pid} via ${method}`);
    return { ok: true, method };
  }

  return { stop };
}

module.exports = {
  createRemoteStopAdapter,
  buildStopCommand,
  buildRemoteCommandArgs,
  NOT_CLAUDE_EXIT_CODE,
  NOT_CLAUDE_MARKER,
  TMUX_PANE_KILLED_MARKER,
  TMUX_WINDOW_KILLED_MARKER,
  PID_TERM_MARKER,
  PID_FORCE_MARKER,
};
