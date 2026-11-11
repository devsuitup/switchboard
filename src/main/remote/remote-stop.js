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
const SSH_CONNECT_ALLOWANCE_MS = 5000;
const NOT_CLAUDE_EXIT_CODE = 7;
const NOT_CLAUDE_MARKER = 'NOT_CLAUDE';
const TMUX_PANE_KILLED_MARKER = 'TMUX_PANE_KILLED';
const TMUX_WINDOW_KILLED_MARKER = 'TMUX_WINDOW_KILLED';
const PID_TERM_MARKER = 'PID_KILLED_TERM';
const PID_FORCE_MARKER = 'PID_KILLED_FORCE';
// ~3s: kill -TERM, then poll /proc/<pid> six times at 0.5s before kill -KILL.
const TERM_WAIT_TICKS = 6;
const TERM_WAIT_STEP_S = '0.5';

const STRICT_STOP_SCRIPT = `import base64,json,os,signal,sys,time,select
x=json.loads(base64.b64decode(sys.argv[1]))
p=x['pid']; fd=None
deadline=time.monotonic()+x['remainingMs']/1000
identity=str(p)+' '+x['procStart']+' '+x['sessionId']+' '+x['bootId']
def emit(kind):
 print(kind+' '+identity,flush=True)
def guard():
 if time.monotonic()>=deadline: raise RuntimeError('deadline')
 if open('/proc/sys/kernel/random/boot_id').read().strip()!=x['bootId']: raise RuntimeError('host identity')
def start():
 return open('/proc/'+str(p)+'/stat').read().rsplit(') ',1)[1].split()[19]
try:
 guard()
 if x['phase']=='observe':
  if not os.path.isdir('/proc/'+str(p)): emit('STOP_ENDED')
  elif start()!=x['procStart']: emit('STOP_REUSED')
  else: emit('STOP_LIVE')
 else:
  fd=os.pidfd_open(p,0)
  if start()!=x['procStart']: raise RuntimeError('start identity')
  args=open('/proc/'+str(p)+'/cmdline','rb').read().split(b'\\0')
  sid=x['sessionId'].encode()
  if not any(args[i] in (b'--session-id',b'--resume') and args[i+1]==sid for i in range(len(args)-1)): raise RuntimeError('session identity')
  if select.select([fd],[],[],0)[0]: raise RuntimeError('exited before signal')
  guard()
  signal.pidfd_send_signal(fd,signal.SIGTERM if x['phase']=='TERM' else signal.SIGKILL)
  emit('STOP_SIGNALLED')
except Exception:
 emit('STOP_IDENTITY'); sys.exit(1)
finally:
 if fd is not None: os.close(fd)
`;

function buildStrictStopCommand(identity, phase, remainingMs) {
  const payload = Buffer.from(JSON.stringify({ ...identity, phase, remainingMs })).toString('base64');
  return `python3 -c '${STRICT_STOP_SCRIPT.replaceAll("'", "'\"'\"'")}' '${payload}'`;
}

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
  const { now = Date.now, schedule = setTimeout, cancel = clearTimeout } = opts;

  async function stopStrict(alias, descriptor, options) {
    const unknown = error => ({ ok: false, ended: false, error });
    const identity = options.identity && { ...options.identity }, deadline = Math.min(options.deadline, now() + DEFAULT_STOP_TIMEOUT_MS);
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    if (!identity || identity.alias !== alias || !alias || !isValidPid(identity.pid) || identity.pid !== descriptor?.pid
      || identity.sessionId !== descriptor?.sessionId || !uuid.test(identity.sessionId)
      || typeof identity.procStart !== 'string' || !/^\d{1,20}$/.test(identity.procStart) || identity.procStart !== descriptor?.procStart
      || typeof identity.bootId !== 'string' || !uuid.test(identity.bootId) || identity.bootId !== descriptor?.bootId
      || !Number.isFinite(deadline) || deadline <= now()) return unknown('strict stop identity or deadline is unavailable');
    const suffix = `${identity.pid} ${identity.procStart} ${identity.sessionId} ${identity.bootId}`;
    const read = async (phase, phaseDeadline = deadline) => {
      const remaining = phaseDeadline - now();
      const remoteRemaining = remaining - SSH_CONNECT_ALLOWANCE_MS;
      if (remoteRemaining <= 0) throw new Error('stop deadline expired');
      let timer;
      try {
        const result = await Promise.race([runRemoteCommand(alias, buildStrictStopCommand(identity, phase, remoteRemaining), { timeoutMs: remaining }),
          new Promise((_, reject) => { timer = schedule(() => reject(new Error('stop deadline expired')), remaining); })]);
        if (now() >= phaseDeadline || result?.code !== 0) throw new Error('remote observation unavailable');
        const text = String(result.stdout || '').trim();
        return ['STOP_SIGNALLED', 'STOP_ENDED', 'STOP_LIVE', 'STOP_REUSED'].find(marker => text === `${marker} ${suffix}`) || 'UNKNOWN';
      } finally { cancel(timer); }
    };
    try {
      for (const phase of ['TERM', 'KILL']) {
        const phaseDeadline = phase === 'TERM' && deadline - now() > 12000 ? deadline - 7000 : deadline;
        if (await read(phase, phaseDeadline) !== 'STOP_SIGNALLED') return unknown('remote signal identity was not acknowledged');
        for (let i = 0; i < TERM_WAIT_TICKS; i++) {
          if (phase === 'TERM' && phaseDeadline - now() <= SSH_CONNECT_ALLOWANCE_MS) break;
          const state = await read('observe', phaseDeadline);
          if (state === 'STOP_ENDED') return { ok: true, ended: true, scope: 'process', identity, observedAt: now(), method: `pid-${phase.toLowerCase()}` };
          if (state !== 'STOP_LIVE') return unknown('remote death is unknown or the pid was reused');
          if (phaseDeadline <= now()) return unknown('stop deadline expired');
          let timer;
          try { await new Promise(resolve => { timer = schedule(resolve, Math.min(50, phaseDeadline - now())); }); }
          finally { cancel(timer); }
        }
      }
      return unknown('remote process is still live');
    } catch (error) { return unknown(error.message || String(error)); }
  }

  async function stop(alias, descriptor, options = {}) {
    if (options.strict) return stopStrict(alias, descriptor, options);
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
