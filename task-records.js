'use strict';

const TASK_KINDS = new Map([['agent', 'agent'], ['bash', 'bash'], ['monitor', 'monitor'], ['cron', 'cron']]);
const IN_FLIGHT_KINDS = new Set(['local_agent', 'local_bash', 'monitor', 'session_cron']);

function normalizeTaskEvidence(raw) {
  const at = typeof raw?.updatedAt === 'string' ? Date.parse(raw.updatedAt) : NaN;
  const terminal = ['done', 'stopped', 'failed'].includes(raw?.state);
  const validFan = raw?.fan === undefined || Array.isArray(raw?.fan) && raw.fan.every(f => f && typeof f.id === 'string' && f.id.length > 0 &&
    TASK_KINDS.has(f.kind) && Number.isFinite(f.startedAt) && (f.doneAt === undefined || Number.isFinite(f.doneAt)));
  const flight = raw?.inFlight;
  const validFlight = terminal && flight === undefined || flight && Number.isSafeInteger(flight.tasks) && flight.tasks >= 0 && Array.isArray(flight.kinds) &&
    flight.kinds.every(k => IN_FLIGHT_KINDS.has(k));
  if (!Number.isFinite(at) || !validFan || !validFlight || !['working', 'blocked', 'done', 'stopped', 'failed'].includes(raw.state)) {
    return { valid: false, at: null, tasks: [], inFlight: null, terminal: false };
  }
  return { valid: true, at, tasks: (raw.fan || []).map(f => ({ id: f.id, kind: TASK_KINDS.get(f.kind), startedAt: f.startedAt, doneAt: f.doneAt ?? null })),
    fanKnown: Array.isArray(raw.fan), inFlight: flight?.tasks || 0, terminal };
}

module.exports = { normalizeTaskEvidence, TASK_KINDS, IN_FLIGHT_KINDS };
