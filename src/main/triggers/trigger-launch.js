'use strict';

const pendingByMap = new WeakMap();

async function acquireOpen(sessions, id) {
  let pending = pendingByMap.get(sessions);
  if (!pending) { pending = new Map(); pendingByMap.set(sessions, pending); }
  const key = String(id).toLowerCase();
  const previous = pending.get(key) || Promise.resolve();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => held);
  pending.set(key, tail);
  await previous;
  return () => { release(); if (pending.get(key) === tail) pending.delete(key); };
}

async function validateTriggerOpen(permit, deps) {
  const fail = reason => ({ ok: false, reason, error: reason });
  const valid = () => deps.launchAllowed() && Date.now() < permit.deadline && deps.broker.checkPermit(permit.requestId);
  if (!valid()) return fail(deps.launchAllowed() ? 'session action timed out' : 'Switchboard is closing.');
  if (permit.mode === 'reattach') return { ok: true };
  try {
    if (await deps.remoteTarget(permit.tabKey)) return fail('remote sessions are not supported');
    const checked = await deps.liveElsewhere(permit.tabKey, permit.deadline);
    if (!checked?.known) return fail('session liveness unavailable');
    if (checked.live) return fail(checked.live.kind === 'schedule' ? 'scheduled session is not supported'
      : checked.live.kind === 'bg' ? 'background session is not supported' : 'session live elsewhere');
    if (!valid()) return fail('session action timed out');
    if (permit.mode === 'resume') {
      const target = await deps.resolveTarget(permit.tabKey, { ...deps, deadline: permit.deadline });
      if (!target.ok) return target;
      if (target.cwd !== permit.target?.cwd || target.transcript !== permit.target?.transcript
        || target.transcriptIdentity !== permit.target?.transcriptIdentity || target.project !== permit.project) return fail('session target changed');
      if (!valid()) return fail('session action timed out');
      return { ok: true, cwd: target.cwd };
    }
    const project = await deps.resolveProject(permit.project, { ...deps, deadline: permit.deadline });
    return !valid() ? fail('session action timed out') : project;
  } catch (error) { return { ...fail('session liveness unavailable'), error: error.message }; }
}

module.exports = { acquireOpen, validateTriggerOpen };
