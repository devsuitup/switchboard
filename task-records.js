'use strict';

const TASK_KINDS = new Map([['agent', 'agent'], ['bash', 'bash'], ['shell', 'bash'], ['monitor', 'monitor'], ['cron', 'cron']]);
const IN_FLIGHT_LABELS = new Map([
  ['local_agent', 'Agent'], ['local_bash', 'Shell'], ['monitor', 'Monitor'],
  ['session_cron', 'Scheduled task'], ['artifact_watch', 'Artifact watch'],
]);
const IN_FLIGHT_KINDS = new Set(IN_FLIGHT_LABELS.keys());
const validCount = value => Number.isSafeInteger(value) && value >= 0;

function normalizeTaskEvidence(raw) {
  const at = typeof raw?.updatedAt === 'string' ? Date.parse(raw.updatedAt) : NaN;
  const terminal = ['done', 'stopped', 'failed'].includes(raw?.state);
  const validFan = raw?.fan === undefined || Array.isArray(raw?.fan) && raw.fan.every(f => f && typeof f.id === 'string' && f.id.length > 0 &&
    TASK_KINDS.has(f.kind) && Number.isFinite(f.startedAt) && (f.doneAt === undefined || Number.isFinite(f.doneAt)));
  const flight = raw?.inFlight;
  const validFlight = terminal && flight === undefined || flight && typeof flight === 'object' && !Array.isArray(flight) &&
    validCount(flight.tasks) && (flight.queued === undefined || validCount(flight.queued)) &&
    (flight.drainableMonitors === undefined || validCount(flight.drainableMonitors)) && Array.isArray(flight.kinds) &&
    flight.kinds.every(k => typeof k === 'string' && k.trim().length > 0);
  if (!Number.isFinite(at) || !validFan || !validFlight || !['working', 'blocked', 'done', 'stopped', 'failed'].includes(raw.state)) {
    return { valid: false, at: null, tasks: [], inFlight: null, terminal: false };
  }
  return { valid: true, at, tasks: (raw.fan || []).map(f => ({ id: f.id, kind: TASK_KINDS.get(f.kind), startedAt: f.startedAt, doneAt: f.doneAt ?? null })),
    fanKnown: Array.isArray(raw.fan), inFlight: flight?.tasks ?? 0, queued: flight?.queued ?? 0,
    drainableMonitors: flight?.drainableMonitors ?? 0,
    inFlightKinds: (flight?.kinds || []).map(kind => ({ kind, label: IN_FLIGHT_LABELS.get(kind) || `Unknown activity (${kind})`, known: IN_FLIGHT_KINDS.has(kind) })), terminal };
}

module.exports = { normalizeTaskEvidence, TASK_KINDS, IN_FLIGHT_KINDS };
