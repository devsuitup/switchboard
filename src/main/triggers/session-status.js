'use strict';

const { projectHeadActivity, projectSessionStatus } = require('../../../public/session-status-projection');
const iso = at => Number.isFinite(at) ? new Date(at).toISOString() : null;
const key = id => String(id).toLowerCase();

function createSessionStatus({ activeSessions, getKnown = () => null, readHead = async () => null,
  probe = async () => null, observeOwned = () => null, getPtyStart = () => null, hosted = () => null, exits = new Map(),
  now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  function direct(id) {
    return [...new Set([...activeSessions].filter(([name, session]) => key(session?.realSessionId || name) === key(id)
      && session && !session.exited && !session.host && !session.isPlainTerminal).map(([, s]) => s))];
  }
  function author(id) {
    const matches = direct(id);
    if (matches.length !== 1 || !matches[0].pty || matches[0].isAttach || !Number.isInteger(matches[0].generation)) return false;
    const session = matches[0], pty = session.pty, generation = session.generation;
    return () => direct(id).length === 1 && direct(id)[0] === session && session.pty === pty && session.generation === generation;
  }
  async function gather(id) {
    const deadline = now() + 2000;
    async function bounded(fn) {
      if (now() >= deadline) return null;
      let timer;
      try { return await Promise.race([Promise.resolve().then(fn).catch(() => null), new Promise(resolve => {
        timer = schedule(() => resolve(null), Math.max(0, deadline - now()));
      })]); } finally { cancel(timer); }
    }
    const matches = direct(id), session = matches.length === 1 ? matches[0] : null;
    const known = getKnown(id), job = hosted(id), exit = exits.get(key(id));
    const jobIdentity = value => JSON.stringify([value?.id, value?.pid, value?.procStart, value?.namespace]);
    const pinnedJob = jobIdentity(job);
    const currentJob = () => {
      if (!job?.verified || !job.live) return true;
      const value = hosted(id);
      return value?.verified && value.live && jobIdentity(value) === pinnedJob;
    };
    const result = { sessionId: known || matches.length || job || exit ? key(id) : null,
      state: 'unknown', detail: 'not-found', liveness: 'unknown', headTurn: 'unknown', descriptorStatus: null,
      evidence: 'none', evidence_at: null, pid: null, jobId: null };
    const pin = session && { generation: session.generation, pty: session.pty, pid: session.pty?.pid === 0 ? null : session.pty?.pid,
      start: session.statusPtyStart };
    const current = () => {
      if (!session || session.isAttach) return true;
      if (direct(id).length !== 1 || direct(id)[0] !== session || session.exited
        || session.generation !== pin.generation || session.pty !== pin.pty) return false;
      if (pin.pid === null && Number.isInteger(session.pty?.pid) && session.pty.pid > 0) pin.pid = session.pty.pid;
      if (pin.pid !== null && session.pty?.pid !== pin.pid) return false;
      const start = Number.isInteger(pin.pid) && pin.pid > 0 ? getPtyStart(pin.pid) : null;
      if (pin.start != null && start != null && pin.start !== start) return false;
      if (pin.start != null && session.statusPtyStart !== pin.start) return false;
      pin.start ??= session.statusPtyStart ?? start;
      session.statusPtyStart ??= pin.start;
      return true;
    };
    let snapshot = { liveness: 'unknown' }, proof = { ambiguous: matches.length > 1 }, decisive = null;
    let descriptor, ownedIdentity, probeObservation;
    const identity = observation => observation?.writer && JSON.stringify([observation.identity,
      observation.writer.pid, observation.writer.procStart, observation.writer.namespace, observation.writer.rawPid, observation.writer.sessionId]);
    if (session && !session.isAttach && pin.pty && Number.isInteger(pin.generation)) {
      if (!current()) proof.ambiguous = true;
      snapshot.liveness = 'alive'; proof.ptyHere = true;
      result.evidence = 'owned-pty'; result.pid = pin.pid > 0 ? pin.pid : null; decisive = session.startedAt ?? session.launchStartedAt;
      const observation = observeOwned(session, deadline);
      if (observation && !observation.uncertain) { descriptor = observation.writer; ownedIdentity = identity(observation); }
      if (!current()) proof.ambiguous = true;
    } else if (job?.verified && job.live) {
      snapshot.liveness = 'alive'; proof.background = true;
      descriptor = job.descriptor; result.evidence = 'background-job'; result.jobId = job.id;
      result.pid = job.pid > 0 ? job.pid : null; decisive = job.observedAt;
    }
    const head = await bounded(() => readHead(id, known, session, deadline));
    if (!current() || !currentJob()) proof.ambiguous = true;
    if (ownedIdentity) {
      if (now() >= deadline) descriptor = null;
      else {
        const observation = observeOwned(session, deadline);
        if (!observation?.writer || observation.uncertain) descriptor = null;
        else if (identity(observation) !== ownedIdentity) proof.ambiguous = true;
      }
    }
    if (snapshot.liveness !== 'alive' && !proof.ambiguous && (!known?.cli || known.cli === 'claude')) {
      const observation = await bounded(() => probe(id, deadline));
      probeObservation = observation;
      if (observation?.ambiguous) { proof.ambiguous = true; result.sessionId = key(id); }
      if (!current() || !currentJob()) proof.ambiguous = true;
      if (observation?.known && observation.live && now() < deadline && observation.fresh !== false) {
        descriptor = observation.live; snapshot.liveness = 'alive';
        result.sessionId = key(id);
        result.evidence = descriptor.rawPid !== descriptor.pid && descriptor.namespace ? 'sandbox-mapped-descriptor' : 'descriptor';
        result.pid = descriptor.pid > 0 ? descriptor.pid : null; decisive = descriptor.statusUpdatedAt ?? descriptor.startedAt;
        if (descriptor.kind === 'bg' && job?.id && descriptor.jobId === job.id) {
          if (hosted(id)?.id !== job.id) proof.ambiguous = true;
          else { proof.background = true; result.evidence = 'background-job'; result.jobId = job.id; }
        }
      }
    }
    if (exit?.confirmed && Number.isInteger(exit.generation) && exit.generation === activeSessions.statusGenerations?.get(key(id))
      && !matches.length && !job && !proof.ambiguous
      && snapshot.liveness !== 'alive' && probeObservation?.known && !probeObservation.live) {
      snapshot = { liveness: 'dead' }; proof = { confirmedExit: true, ptyHere: false };
      result.evidence = 'confirmed-exit'; decisive = exit.at;
    }
    if (!current()) proof.ambiguous = true;
    if (proof.ptyHere) result.pid = pin.pid > 0 ? pin.pid : null;
    if (proof.ambiguous) {
      snapshot = { liveness: 'unknown' }; descriptor = null; proof.ptyHere = false;
      result.evidence = 'none'; result.pid = null; result.jobId = null; decisive = null;
    }
    if (descriptor && snapshot.liveness === 'alive') {
      result.descriptorStatus = ['busy', 'waiting', 'idle', 'shell'].includes(descriptor.status) ? descriptor.status : null;
      proof.blocking = descriptor.status === 'waiting' && !!descriptor.waitingFor && descriptor.waitingFor !== 'input';
      proof.shell = descriptor.status === 'shell';
    }
    const osc = session?._statusOsc;
    if (!proof.background && !session?.isAttach && current() && osc?.generation === pin?.generation && osc?.idleAt > (osc?.busyAt ?? -Infinity)) {
      snapshot.promptHint = true; snapshot.promptHintAt = osc.idleAt;
    }
    const projectedHead = projectHeadActivity(snapshot, head, proof);
    Object.assign(result, projectSessionStatus(snapshot, head, proof), { headTurn: projectedHead.headTurn, liveness: projectedHead.liveness });
    if (snapshot.liveness === 'alive') {
      if (result.detail === 'blocking-dialog' || result.detail === 'shell') decisive = descriptor.statusUpdatedAt;
      else if (projectedHead.headTurn !== 'unknown') decisive = projectedHead.headTurn === 'closed' && snapshot.promptHint
        && (head?.state !== 'closed' || snapshot.promptHintAt > head?.observedAt) ? snapshot.promptHintAt : head?.observedAt;
    }
    result.evidence_at = result.evidence === 'none' ? null : iso(decisive);
    if (!result.sessionId) Object.assign(result, { detail: 'not-found', headTurn: 'unknown' });
    return result;
  }
  return { author, gather };
}
module.exports = { createSessionStatus };
