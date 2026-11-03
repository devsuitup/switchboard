// remote-send.js — see .ai/contexts/session-cache.md ("Remote hosts — sending a prompt")
'use strict';

const crypto = require('crypto');
const {
  isValidPid,
  buildProcCmdlineCheck,
  shellSingleQuote,
  defaultRunRemoteCommand,
} = require('./remote-attach');

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_SOCKET_PATH_BYTES = 107;
const DEDUPE_WINDOW_MS = 30000;
const RATE_CAPACITY = 30;
const RATE_REFILL_PER_MS = 0.5 / 1000;
const DEFAULT_SEND_TIMEOUT_MS = 15000;
const NOT_CLAUDE_EXIT_CODE = 7;
const NO_SOCKET_EXIT_CODE = 8;
const NC_MISSING_EXIT_CODE = 127;
const SOCKET_PATH_RE = /^\/[A-Za-z0-9._/-]+\.sock$/;
const OPENBSD_NC_USAGE_RE = String.raw`usage: nc \[-[0-9A-Za-z]*N[0-9A-Za-z]*U`;
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';

function validateSocketPath(value) {
  if (typeof value !== 'string' || !value) return { ok: false, error: 'the messaging socket path is empty' };
  if (value.startsWith(WINDOWS_PIPE_PREFIX)) {
    return { ok: false, error: 'the channel needs the session\'s key file, which Switchboard does not read' };
  }
  if (Buffer.byteLength(value) > MAX_SOCKET_PATH_BYTES) return { ok: false, error: 'the messaging socket path is too long' };
  if (!SOCKET_PATH_RE.test(value) || value.includes('..')) {
    return { ok: false, error: 'the messaging socket path is not an absolute .sock path of plain characters' };
  }
  return { ok: true };
}

function buildPromptLine(content, sessionId) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content }, msgV: 1, session_id: sessionId }) + '\n';
}

function buildDeliverSegment(socketPath) {
  const p = shellSingleQuote(socketPath);
  return `if command -v ncat >/dev/null 2>&1 && ncat --help 2>&1 | grep -q -- --send-only; then exec ncat --send-only -U ${p}; ` +
    `elif command -v nc >/dev/null 2>&1 && nc -h 2>&1 | grep -Eq '${OPENBSD_NC_USAGE_RE}'; then exec nc -N -U ${p}; ` +
    `else exit ${NC_MISSING_EXIT_CODE}; fi`;
}

function buildSendScript(pid, socketPath) {
  if (!isValidPid(pid)) throw new Error('invalid pid');
  const checked = validateSocketPath(socketPath);
  if (!checked.ok) throw new Error(checked.error);
  return `alive=$(${buildProcCmdlineCheck(pid)}); if [ "$alive" != "1" ]; then exit ${NOT_CLAUDE_EXIT_CODE}; fi; ` +
    `[ -S ${shellSingleQuote(socketPath)} ] || exit ${NO_SOCKET_EXIT_CODE}; ` +
    buildDeliverSegment(socketPath);
}

function buildSendCommand(pid, socketPath) {
  return `sh -c ${shellSingleQuote(buildSendScript(pid, socketPath))}`;
}

function createRemoteSendAdapter(opts = {}) {
  const runRemoteCommand = opts.runRemoteCommand || defaultRunRemoteCommand;
  const now = opts.now || Date.now;
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const recent = new Map();
  const buckets = new Map();

  function reserveToken(alias, sessionId, at) {
    const key = `${alias}\u0000${sessionId}`;
    const bucket = buckets.get(key) || { tokens: RATE_CAPACITY, at, pending: 0 };
    bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + Math.max(0, at - bucket.at) * RATE_REFILL_PER_MS);
    bucket.at = at;
    buckets.set(key, bucket);
    if (bucket.tokens < 1) return null;
    bucket.tokens--;
    bucket.pending++;
    return {
      refund() { bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + 1); },
      release() { bucket.pending--; },
    };
  }

  function dedupeKey(alias, sessionId, content) {
    return `${alias}\u0000${sessionId}\u0000${crypto.createHash('sha256').update(content).digest('hex')}`;
  }

  function pruneRecent(at) {
    for (const [key, sentAt] of recent) {
      if (at - sentAt >= DEDUPE_WINDOW_MS) recent.delete(key);
    }
    for (const [key, bucket] of buckets) {
      if (bucket.pending === 0 && bucket.tokens + Math.max(0, at - bucket.at) * RATE_REFILL_PER_MS >= RATE_CAPACITY) buckets.delete(key);
    }
  }

  async function send(alias, descriptor, content) {
    if (typeof content !== 'string' || !content.trim()) return { ok: false, code: 'invalid', error: 'nothing to send' };
    const socketPath = descriptor && descriptor.messagingSocketPath;
    if (socketPath == null || socketPath === '') {
      return { ok: false, code: 'invalid', error: 'session carries no messaging socket — a prompt cannot be sent to it' };
    }
    const checked = validateSocketPath(socketPath);
    if (!checked.ok) return { ok: false, code: typeof socketPath === 'string' && socketPath.startsWith(WINDOWS_PIPE_PREFIX) ? 'windows' : 'invalid', error: checked.error };
    if (!isValidPid(descriptor.pid)) return { ok: false, code: 'invalid', error: 'session carries no readable pid — cannot send to it' };
    if (typeof descriptor.sessionId !== 'string' || !descriptor.sessionId) {
      return { ok: false, code: 'invalid', error: 'session carries no session id — cannot send to it' };
    }

    const line = buildPromptLine(content, descriptor.sessionId);
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return { ok: false, code: 'invalid', error: 'the prompt is over 1 MiB once encoded' };

    const at = now();
    pruneRecent(at);
    const key = dedupeKey(alias, descriptor.sessionId, content);
    if (recent.has(key)) {
      return { ok: false, code: 'dedupe', error: 'the same text was sent to this session less than 30 s ago — the session drops it' };
    }
    const reservation = reserveToken(alias, descriptor.sessionId, at);
    if (!reservation) return { ok: false, code: 'rate', error: 'too many prompts sent to this session; it drops them above 30, refilling one every 2 s' };
    const { refund, release } = reservation;
    recent.set(key, at);

    let result;
    try {
      result = await runRemoteCommand(alias, buildSendCommand(descriptor.pid, socketPath), {
        timeoutMs: DEFAULT_SEND_TIMEOUT_MS,
        input: line,
      });
    } catch (err) {
      recent.delete(key);
      refund();
      return { ok: false, code: 'runner', error: `send failed: ${err.message}` };
    } finally {
      release();
    }
    if (!result) {
      recent.delete(key);
      refund();
      return { ok: false, code: 'runner', error: 'send failed: no response' };
    }

    if (result.timedOut) return { ok: false, code: 'timeout', maybeWritten: true, error: 'send failed: no confirmation that the line was written — it may have been sent (timed out)' };
    if (result.code !== 0) recent.delete(key);
    if ([NOT_CLAUDE_EXIT_CODE, NO_SOCKET_EXIT_CODE, NC_MISSING_EXIT_CODE].includes(result.code)) {
      refund();
    }
    if (result.code === NOT_CLAUDE_EXIT_CODE) {
      return { ok: false, code: 'not-claude', error: `pid ${descriptor.pid} now belongs to a process that is not a claude CLI — the session is gone` };
    }
    if (result.code === NO_SOCKET_EXIT_CODE) {
      return { ok: false, code: 'no-socket', error: 'the session\'s messaging socket is gone — it has exited or restarted' };
    }
    if (result.code === NC_MISSING_EXIT_CODE) {
      return { ok: false, code: 'nc-missing', error: 'nc with -U (unix socket) support was not found on the host — install netcat-openbsd or ncat' };
    }
    if (result.code !== 0) {
      const reason = (result.stderr || '').trim() || 'no stderr';
      return { ok: false, code: 'exit', maybeWritten: true, error: `send failed (exit ${result.code}): ${reason}` };
    }

    log.info(`[remote-send:${alias}] wrote ${Buffer.byteLength(line)} bytes to pid ${descriptor.pid}`);
    return { ok: true };
  }

  return { send };
}

async function handleSendRequest(payload, deps) {
  const alias = payload && payload.alias;
  const sessionId = payload && payload.sessionId;
  const text = payload && payload.text;
  if (typeof alias !== 'string' || !alias || typeof sessionId !== 'string' || !sessionId || typeof text !== 'string') {
    return { ok: false, error: 'invalid request' };
  }
  const descriptor = deps.getDescriptor(alias, sessionId);
  if (!descriptor) return { ok: false, error: 'session not found on that host' };
  if (text.length > MAX_LINE_BYTES) return { ok: false, error: 'the prompt is longer than 1 MiB' };
  if (deps.isAttached(sessionId)) {
    return { ok: false, error: 'the session is attached in a terminal — type the prompt there' };
  }
  return deps.adapter.send(alias, descriptor, text);
}

module.exports = {
  createRemoteSendAdapter,
  handleSendRequest,
  buildPromptLine,
  buildSendCommand,
  buildSendScript,
  buildDeliverSegment,
  OPENBSD_NC_USAGE_RE,
  validateSocketPath,
  MAX_LINE_BYTES,
  DEDUPE_WINDOW_MS,
  RATE_CAPACITY,
  RATE_REFILL_PER_MS,
  NOT_CLAUDE_EXIT_CODE,
  NO_SOCKET_EXIT_CODE,
  NC_MISSING_EXIT_CODE,
};
