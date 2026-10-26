'use strict';

const WINDOWS_FILETIME_RE = /^\d{17,19}$/;
const timestamp = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' ? Date.parse(value) : NaN;

function liveWorkerDescriptor(job, descriptors = []) {
  return descriptors.some(d => d?.kind === 'bg'
    && (d.jobId ? d.jobId.toLowerCase() === String(job.id).toLowerCase()
      : job.sessionId && d.sessionId?.toLowerCase() === job.sessionId.toLowerCase()));
}

function workerObservation(job, sample) {
  if (liveWorkerDescriptor(job, sample?.descriptors)) return 'live';
  const roster = sample?.roster;
  if (!roster || roster.proto !== 1 || !sample.processTableFresh || typeof sample.tableEntry !== 'function'
    || !Number.isFinite(sample.bootTime)) return 'unknown';
  const updatedAt = timestamp(roster.updatedAt);
  if (!Number.isFinite(updatedAt)) return 'unknown';
  if (updatedAt < sample.bootTime) return 'dead';
  const worker = roster.workers?.[job.daemonShort ?? job.id];
  if (worker) {
    if (typeof worker.procStart !== 'string' || !WINDOWS_FILETIME_RE.test(worker.procStart)) return 'unknown';
    const startedAt = Number(BigInt(worker.procStart) / 10000n - 11644473600000n);
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) return 'unknown';
    if (startedAt < sample.bootTime) return 'dead';
    if (Number.isInteger(worker.pid) && worker.pid > 0
      && sample.tableEntry(worker.pid)?.created?.toString() === worker.procStart) return 'live';
  }
  return missingSupervisor(job, sample) ? 'pending' : 'unknown';
}

function missingSupervisor(job, sample) {
  const roster = sample?.roster;
  return roster?.proto === 1 && sample.processTableFresh && typeof sample.tableEntry === 'function'
    && Number.isInteger(roster.supervisorPid) && roster.supervisorPid > 0
    && !sample.tableEntry(roster.supervisorPid)
    && Number.isFinite(timestamp(job.updatedAt)) && timestamp(roster.updatedAt) >= timestamp(job.updatedAt);
}

function classifyWorkerLiveness(job, sample, confirmation) {
  if (!job) return 'unknown';
  const initial = workerObservation(job, sample);
  if (initial === 'live' || initial === 'dead') return initial;
  if (initial !== 'pending' || !confirmation || workerObservation(job, confirmation) !== 'pending') return 'unknown';
  if (!Number.isFinite(sample.observedAt) || !Number.isFinite(confirmation.observedAt)
    || confirmation.observedAt - sample.observedAt < 1000) return 'unknown';
  const sameRoster = sample.roster?.supervisorPid === confirmation.roster?.supervisorPid
    && sample.roster?.updatedAt === confirmation.roster?.updatedAt
    && JSON.stringify(sample.roster?.workers?.[job.daemonShort ?? job.id]) === JSON.stringify(confirmation.roster?.workers?.[job.daemonShort ?? job.id]);
  return sameRoster && missingSupervisor(job, sample) && missingSupervisor(job, confirmation) ? 'dead' : 'unknown';
}

module.exports = { classifyWorkerLiveness, liveWorkerDescriptor, workerTimestamp: timestamp };
