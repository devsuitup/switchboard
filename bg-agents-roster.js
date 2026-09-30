// bg-agents-roster.js — see .ai/contexts/bg-agents.md
'use strict';

const JOB_STATES = new Set(['working', 'blocked', 'done', 'stopped']);
const SESSION_STATUSES = new Set(['busy', 'idle', 'waiting', 'shell']);
const JOB_ID_RE = /^[0-9a-f]{8}$/;
const JOB_ID_IN_TEXT_RE = /(?:^|[^0-9a-f])([0-9a-f]{8})(?![0-9a-f])/i;
const TRANSCRIPT_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const str = (v) => (typeof v === 'string' && v ? v : null);
const num = (v) => (Number.isFinite(v) ? v : null);

function sessionIdFromLinkScanPath(p) {
  if (typeof p !== 'string') return null;
  const m = TRANSCRIPT_ID_RE.exec(p);
  return m ? m[1].toLowerCase() : null;
}

function flagValue(flags, name) {
  if (!Array.isArray(flags)) return null;
  const i = flags.indexOf(name);
  return i >= 0 && i + 1 < flags.length ? str(flags[i + 1]) : null;
}

function parseJobState(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fan = Array.isArray(raw.fan)
    ? raw.fan.filter(f => f && typeof f === 'object').map(f => ({
      id: str(f.id), kind: str(f.kind), label: str(f.label), startedAt: num(f.startedAt), doneAt: num(f.doneAt),
    }))
    : [];
  const children = Array.isArray(raw.children)
    ? raw.children.filter(c => c && typeof c === 'object').map(c => ({
      id: c.id == null ? null : String(c.id), href: str(c.href), kind: str(c.kind),
    }))
    : [];
  return {
    state: JOB_STATES.has(raw.state) ? raw.state : null,
    detail: str(raw.detail),
    tempo: str(raw.tempo),
    tokens: num(raw.tokens),
    fan,
    children,
    result: raw.output && typeof raw.output === 'object' ? str(raw.output.result) : null,
    template: str(raw.template),
    agent: flagValue(raw.respawnFlags, '--agent'),
    model: flagValue(raw.respawnFlags, '--model'),
    name: flagValue(raw.respawnFlags, '--name'),
    sessionId: sessionIdFromLinkScanPath(raw.linkScanPath),
  };
}

const MAX_NOISY_CANDIDATES = 32;

function arrayStarts(text) {
  const out = [];
  for (let i = text.indexOf('['); i !== -1 && out.length < MAX_NOISY_CANDIDATES; i = text.indexOf('[', i + 1)) {
    if (!text.slice(text.lastIndexOf('\n', i - 1) + 1, i).trim()) out.push(i);
  }
  return out;
}

function arrayEnds(text) {
  const out = [];
  for (let i = text.lastIndexOf(']'); i !== -1 && out.length < MAX_NOISY_CANDIDATES; i = i > 0 ? text.lastIndexOf(']', i - 1) : -1) {
    const eol = text.indexOf('\n', i);
    if (!text.slice(i + 1, eol === -1 ? text.length : eol).trim()) out.push(i);
  }
  return out;
}

function parseJsonArray(text) {
  const s = String(text == null ? '' : text);
  try { return JSON.parse(s); } catch { /* fall through to the noisy parse */ }
  const starts = arrayStarts(s);
  const ends = arrayEnds(s);
  for (const a of starts) {
    for (const b of ends) {
      if (b <= a) continue;
      try {
        const v = JSON.parse(s.slice(a, b + 1));
        if (Array.isArray(v)) return v;
      } catch { /* next candidate */ }
    }
  }
  return null;
}

const SHELL_NOISE_RE = /^(?:[\w./-]*sh): (?:no job control in this shell|cannot set terminal process group\b.*|initialize_job_control: .*)$/;

function stripShellNoise(stderr) {
  const lines = String(stderr == null ? '' : stderr).split('\n');
  let i = 0;
  while (i < lines.length && SHELL_NOISE_RE.test(lines[i].trim())) i++;
  return lines.slice(i).join('\n').trim();
}

function parseCliList(text) {
  const raw = parseJsonArray(text);
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const kind = s.kind === 'background' || s.kind === 'interactive' ? s.kind : null;
    if (!kind || typeof s.sessionId !== 'string' || !s.sessionId) continue;
    out.push({
      id: str(s.id),
      sessionId: s.sessionId,
      name: str(s.name),
      cwd: str(s.cwd),
      kind,
      state: JOB_STATES.has(s.state) ? s.state : null,
      status: SESSION_STATUSES.has(s.status) ? s.status : null,
      pid: Number.isInteger(s.pid) && s.pid > 0 ? s.pid : null,
      startedAt: num(s.startedAt),
    });
  }
  return out;
}

function emptyEntry() {
  return {
    id: null, sessionId: null, name: null, cwd: null, kind: 'background',
    state: null, status: null, pid: null, startedAt: null,
    agent: null, model: null, detail: null, tempo: null, tokens: null,
    fan: [], children: [], result: null, attachedHere: false,
  };
}

function backgroundEntry(id, cliEntry, job, descriptor) {
  const e = emptyEntry();
  e.id = id;
  if (job) {
    Object.assign(e, {
      sessionId: job.sessionId, name: job.name, state: job.state, agent: job.agent, model: job.model,
      detail: job.detail, tempo: job.tempo, tokens: job.tokens, fan: job.fan, children: job.children, result: job.result,
    });
  }
  if (cliEntry) {
    e.sessionId = cliEntry.sessionId || e.sessionId;
    e.name = cliEntry.name || e.name;
    e.cwd = cliEntry.cwd || e.cwd;
    e.state = cliEntry.state || e.state;
    e.status = cliEntry.status || e.status;
    e.pid = cliEntry.pid || e.pid;
    e.startedAt = cliEntry.startedAt ?? e.startedAt;
  }
  if (descriptor) {
    e.sessionId = e.sessionId || descriptor.sessionId;
    e.name = e.name || descriptor.name;
    e.cwd = e.cwd || descriptor.cwd;
    e.agent = e.agent || descriptor.agent;
    e.status = descriptor.status || e.status;
    e.pid = descriptor.pid || e.pid;
    e.startedAt = e.startedAt ?? descriptor.startedAt;
  }
  return e;
}

function mergeRoster({ cli, jobs, descriptors, isOwnPid, isAttachedHere }) {
  const own = typeof isOwnPid === 'function' ? isOwnPid : () => false;
  const attached = typeof isAttachedHere === 'function' ? isAttachedHere : () => false;
  const byJobId = new Map();
  for (const d of descriptors || []) {
    if (d && d.kind === 'bg' && typeof d.jobId === 'string') byJobId.set(d.jobId, d);
  }
  const roster = [];
  if (Array.isArray(cli)) {
    for (const s of cli) {
      if (s.kind !== 'background' || !s.id) continue;
      roster.push(backgroundEntry(s.id, s, jobs ? jobs.get(s.id) : null, byJobId.get(s.id)));
    }
  } else if (jobs) {
    for (const [id, job] of jobs) roster.push(backgroundEntry(id, null, job, byJobId.get(id)));
  }
  for (const d of descriptors || []) {
    if (!d || d.kind !== 'interactive' || !d.sessionId || own(d.pid)) continue;
    roster.push({
      ...emptyEntry(), kind: 'interactive', sessionId: d.sessionId, name: d.name, cwd: d.cwd,
      status: d.status, pid: d.pid, startedAt: d.startedAt,
    });
  }
  for (const e of roster) e.attachedHere = e.kind === 'background' && !!attached(e.id);
  return roster;
}

function splitAddDirs(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function dispatchArgs(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const prompt = typeof f.prompt === 'string' ? f.prompt.trim() : '';
  if (!prompt) return { ok: false, error: 'a prompt is required' };
  if (prompt.startsWith('-')) return { ok: false, error: 'the prompt cannot start with "-": the CLI would read it as a flag' };
  if (typeof f.cwd !== 'string' || !f.cwd) return { ok: false, error: 'a project directory is required' };
  const args = ['--bg'];
  const name = typeof f.name === 'string' ? f.name.trim() : '';
  if (name) args.push('--name', name);
  const agent = typeof f.agent === 'string' ? f.agent.trim() : '';
  if (agent) args.push('--agent', agent);
  if (f.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  else if (typeof f.permissionMode === 'string' && f.permissionMode) args.push('--permission-mode', f.permissionMode);
  for (const dir of splitAddDirs(f.addDirs)) args.push('--add-dir', dir);
  args.push(prompt);
  return { ok: true, args, cwd: f.cwd };
}

function parseDispatchOutput(stdout) {
  const m = JOB_ID_IN_TEXT_RE.exec(String(stdout || ''));
  return m ? m[1].toLowerCase() : null;
}

module.exports = {
  parseJobState, parseCliList, mergeRoster, dispatchArgs, parseDispatchOutput,
  sessionIdFromLinkScanPath, stripShellNoise, JOB_ID_RE, JOB_STATES,
};
