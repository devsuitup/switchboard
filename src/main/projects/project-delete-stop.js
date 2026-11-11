'use strict';

const { stopPtyWithEvidence } = require('../terminals/pty-ops');

function createProjectDeleteStop(ports) {
  const { now = Date.now, schedule = setTimeout, cancel = clearTimeout } = ports;
  const batches = new WeakMap();
  const fail = (code, error = code) => Object.assign(new Error(error), { code });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const identity = value => value && ({ pid: value.pid, procStart: value.procStart,
    generation: value.generation, alias: value.alias, sessionId: value.sessionId, bootId: value.bootId });
  const ids = values => [...values].sort();
  const validIdentity = value => Number.isInteger(value?.pid) && value.pid > 0
    && typeof value.procStart === 'string' && !!value.procStart;
  const bounded = async (read, deadline) => {
    if (now() >= deadline) throw fail('STOP_TIMEOUT');
    let timer;
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        if (now() >= deadline) throw fail('STOP_TIMEOUT');
        return read();
      }), new Promise((_, reject) => {
        timer = schedule(() => reject(fail('STOP_TIMEOUT')), deadline - now());
      })]);
      if (now() >= deadline) throw fail('STOP_TIMEOUT');
      return result;
    } finally { cancel(timer); }
  };
  const pinAttachment = attachment => ({ sessionKey: attachment.sessionKey, session: attachment.session,
    pty: attachment.session?.pty, pid: attachment.session?.pty?.pid,
    generation: attachment.session?.generation, procStart: attachment.session?.statusPtyStart });
  const attachmentCurrent = pin => pin.session?.pty === pin.pty && pin.pty?.pid === pin.pid
    && pin.session?.generation === pin.generation && pin.session?.statusPtyStart === pin.procStart
    && (!ports.activeSessions?.has(pin.sessionKey) || ports.activeSessions.get(pin.sessionKey) === pin.session);
  const pin = binding => ({ ...structuredClone({ id: binding.id, kind: binding.kind,
    conversationId: binding.conversationId, sessionIds: binding.sessionIds, identity: identity(binding.identity),
    jobId: binding.jobId, sessionKey: binding.sessionKey, scheduleId: binding.scheduleId, claimId: binding.claimId,
    descriptor: binding.descriptor }), session: binding.session, local: pinAttachment(binding),
  attachments: (binding.attachments || []).map(pinAttachment) });
  const matches = (target, binding) => binding?.supported === true
    && target.id === binding.id && target.kind === binding.kind
    && target.conversationId === binding.conversationId && same(ids(target.sessionIds), ids(binding.sessionIds || []))
    && same(identity(target.identity), identity(binding.identity)) && target.jobId === binding.jobId
    && target.scheduleId === binding.scheduleId && target.claimId === binding.claimId;
  const current = async (target, deadline, proven = false) => {
    const binding = await bounded(() => ports.readTarget(target), deadline);
    if (!binding && proven && !ports.activeSessions?.has(target.sessionKey)
      && (target.kind !== 'pty' || attachmentCurrent(target.local)) && target.attachments.every(attachmentCurrent)) return;
    if (!matches(target, binding) || binding.session !== target.session
      || target.kind === 'pty' && !attachmentCurrent(target.local)
      || !same((binding.attachments || []).map(a => a.sessionKey), target.attachments.map(a => a.sessionKey))
      || target.attachments.some((a, i) => binding.attachments[i].session !== a.session || !attachmentCurrent(a))) {
      throw fail('STOP_IDENTITY', 'stop binding changed; fresh consent required');
    }
    if (target.kind === 'remote' && !same(identity(binding.descriptor), identity(target.descriptor))) throw fail('STOP_IDENTITY');
  };
  const jobOptions = (target, deadline) => ({ strict: true, jobId: target.jobId,
    sessionIds: [...target.sessionIds], deadline });
  const snapshot = async (conversation, deadline) => {
    const result = await bounded(() => ports.readConversation(conversation), deadline);
    if (!result?.known || result.complete !== true || !Array.isArray(result.owners)
      || new Set(result.owners.map(o => o.id)).size !== result.owners.length
      || result.owners.some(o => !validIdentity(o.identity) || !['live', 'dead'].includes(o.treeState))) {
      throw fail('CONVERSATION_UNKNOWN');
    }
    return structuredClone(result.owners);
  };
  const conversationCheck = async (state, deadline, deadIds = new Set()) => {
    for (const conversation of state.request.conversations) {
      const before = state.owners.get(conversation.id), after = await snapshot(conversation, deadline);
      if (after.length !== before.length || before.some(owner => {
        const observed = after.find(o => o.id === owner.id);
        return !observed || !same(identity(owner.identity), identity(observed.identity))
          || (owner.treeState === 'dead' || deadIds.has(owner.id)) && observed.treeState !== 'dead';
      })) throw fail('CONVERSATION_CHANGED', 'conversation ownership or tree death is not proven');
    }
  };
  const schedules = async (state, deadline) => {
    const runs = await bounded(() => ports.getScheduleRunSnapshot(), deadline);
    if (!Array.isArray(runs)) throw fail('SCHEDULE_UNKNOWN');
    for (const run of runs) {
      const members = state.request.conversations.flatMap(c => c.sessionIds);
      const normalize = value => String(value || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
      const root = normalize(state.request.project.projectPath), cwd = normalize(run.cwd);
      if (cwd && cwd !== root && !cwd.startsWith(root + '/') && !members.includes(run.sessionId)) continue;
      const target = state.targets.find(t => t.kind === 'job' && t.jobId === run.jobId
        && t.sessionIds.includes(run.sessionId) && t.scheduleId === run.scheduleName && t.claimId === run.claimId);
      if (!target || !run.jobId || !run.claimId || state.request.stopBackgroundJobs !== true) {
        throw Object.assign(fail('HEADLESS_SCHEDULE', `uncontrolled schedule ${run.scheduleName || run.sessionId}`), { targetId: run.sessionId });
      }
    }
  };
  const entry = (target, error) => ({ id: error?.targetId || target?.id || 'batch', kind: target?.kind,
    ...(error ? { code: error.code || 'STOP_UNKNOWN', error: error.message,
      unknown: error.code === 'STOP_TIMEOUT' || error.code === 'STOP_UNKNOWN' } : {}) });
  async function preflight(request) {
    const state = { request: structuredClone(request), targets: [], owners: new Map(), deadline: now() + 60000, used: false };
    let target;
    try {
      if (!Array.isArray(request.targets) || !Array.isArray(request.conversations)
        || new Set(request.targets.map(t => t.id)).size !== request.targets.length
        || new Set(request.conversations.map(c => c.id)).size !== request.conversations.length) throw fail('STOP_INPUT');
      for (target of state.request.targets) {
        if (!['pty', 'job', 'remote'].includes(target.kind) || !validIdentity(target.identity)
          || !Array.isArray(target.sessionIds) || !target.sessionIds.length
          || !state.request.conversations.some(c => c.id === target.conversationId
            && target.sessionIds.every(sid => c.sessionIds.includes(sid)))) throw fail('STOP_IDENTITY');
        if (target.kind === 'job' && request.stopBackgroundJobs !== true) throw fail('BACKGROUND_CONSENT');
        const binding = await bounded(() => ports.readTarget(target), state.deadline);
        if (!matches(target, binding)) throw fail('STOP_IDENTITY');
        const captured = pin(binding);
        if (target.kind === 'job' && (typeof ports.bg?.runStop !== 'function' || typeof ports.bg?.checkStop !== 'function')) throw fail('STOP_UNSUPPORTED');
        if (captured.attachments.length && typeof ports.detach !== 'function') throw fail('STOP_UNSUPPORTED');
        if (target.kind === 'pty' && ((ports.platform || process.platform) !== 'win32'
          || !captured.local.pty || captured.local.pid !== target.identity.pid
          || captured.local.generation !== target.identity.generation || target.identity.generation == null
          || captured.local.procStart !== target.identity.procStart
          || binding.session.kind !== 'local-pty' || binding.session.isAttach || binding.session.host
          || binding.session.detaching || binding.session.backgrounding || binding.session.backgrounded
          || typeof binding.session.exitDrain?.then !== 'function')) throw fail('STOP_UNSUPPORTED');
        if (captured.attachments.some(a => !a.pty || a.generation == null || !attachmentCurrent(a))) throw fail('STOP_IDENTITY');
        if (target.kind === 'job') {
          const check = await bounded(() => ports.bg.checkStop(target.jobId, jobOptions(target, state.deadline)), state.deadline);
          if (!check?.ok || !['live', 'dead'].includes(check.workerLiveness)) throw fail('JOB_REFUSED', check?.error);
        }
        const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
        if (target.kind === 'remote' && (!ports.remote?.stop || !target.identity.alias
          || !target.identity.sessionId || !target.identity.bootId
          || !uuid.test(target.identity.sessionId) || !uuid.test(target.identity.bootId)
          || !/^\d{1,20}$/.test(target.identity.procStart)
          || !same(identity(target.identity), identity(binding.descriptor)))) throw fail('STOP_UNSUPPORTED');
        state.targets.push(captured);
      }
      for (const conversation of state.request.conversations) {
        const owners = await snapshot(conversation, state.deadline);
        if (owners.some(o => o.treeState === 'live' && !state.targets.some(t => t.id === o.id && t.conversationId === conversation.id))
          || state.targets.filter(t => t.conversationId === conversation.id).some(t => !owners.some(o => o.id === t.id
            && same(identity(o.identity), t.identity)))) throw fail('CONVERSATION_UNCONTROLLED');
        state.owners.set(conversation.id, owners);
      }
      await schedules(state, state.deadline);
      const prepared = { ok: true, deadline: state.deadline, targets: state.targets.map(t => entry(t)) };
      batches.set(prepared, state);
      return prepared;
    } catch (error) {
      const failed = entry(target, error);
      return { ok: false, stopped: [], failed: [failed], skipped: (request.targets || []).filter(t => t.id !== failed.id).map(t => entry(t)) };
    }
  }
  async function verify(prepared) {
    const state = batches.get(prepared);
    if (!state || !state.finished) return { ok: false, code: 'STOP_UNPROVEN' };
    try {
      for (const target of state.targets) await current(target, state.deadline, true);
      await schedules(state, state.deadline);
      await conversationCheck(state, state.deadline, new Set(state.targets.map(t => t.id)));
      return { ok: true };
    } catch (error) { return { ok: false, ...entry(null, error) }; }
  }
  async function stop(prepared) {
    const state = batches.get(prepared);
    if (!state || state.used) return { ok: false, stopped: [], failed: [{ id: 'batch', code: 'STOP_CONSUMED' }], skipped: [] };
    state.used = true;
    const stopped = [], dead = new Set();
    for (let i = 0; i < state.targets.length; i++) {
      const target = state.targets[i], deadline = Math.min(state.deadline, now() + 15000);
      try {
        for (const binding of state.targets) await current(binding, deadline, dead.has(binding.id));
        await schedules(state, deadline);
        await conversationCheck(state, deadline, dead);
        await current(target, deadline);
        let proof;
        if (target.kind === 'pty') {
          proof = await bounded(() => (ports.stopPtyWithEvidence || stopPtyWithEvidence)(target.session, target.sessionKey,
            { generation: target.identity.generation, deadline, platform: ports.platform }), deadline);
          if (proof?.ended !== true && target.session.pty === target.local.pty && target.local.pty.statusTreeExit) {
            const natural = await bounded(() => target.local.pty.statusTreeExit, deadline);
            if (natural?.ended === true && attachmentCurrent(target.local)) {
              proof = { ...natural, generation: target.identity.generation, pid: target.identity.pid };
            }
          }
          if (proof?.generation !== target.identity.generation || proof?.pid !== target.identity.pid) throw fail('STOP_IDENTITY');
        } else if (target.kind === 'job') {
          proof = await bounded(() => ports.bg.runStop(target.jobId, jobOptions(target, deadline)), deadline);
          if (proof?.ended === true && (proof.jobId !== target.jobId || !same(ids(proof.sessionIds || []), ids(target.sessionIds)))) throw fail('STOP_IDENTITY');
        } else {
          proof = await bounded(() => ports.remote.stop(target.identity.alias, target.descriptor,
            { strict: true, identity: target.identity, deadline }), deadline);
          if (proof?.ended === true && !same(identity(proof.identity), target.identity)) throw fail('STOP_IDENTITY');
        }
        if (proof?.ended !== true) throw fail('STOP_UNKNOWN', proof?.error || proof?.code || 'tree death is not proven');
        await current(target, deadline, true);
        dead.add(target.id);
        await conversationCheck(state, deadline, dead);
        for (const attachment of target.attachments) {
          if (!attachmentCurrent(attachment)) throw fail('STOP_IDENTITY');
          if (await bounded(() => ports.detach(attachment), deadline) !== true) throw fail('DETACH_FAILED');
          if (attachment.session.exitDrain) await bounded(() => attachment.session.exitDrain, deadline);
        }
        if (target.kind === 'pty') {
          if (!target.session.exitDrain) throw fail('EXIT_DRAIN_UNKNOWN');
          await bounded(() => target.session.exitDrain, deadline);
        }
        await current(target, deadline, true);
        await conversationCheck(state, deadline, dead);
        stopped.push(entry(target));
      } catch (error) {
        return { ok: false, stopped, failed: [entry(target, error)], skipped: state.targets.slice(i + 1).map(t => entry(t)) };
      }
    }
    state.finished = true;
    const checked = await verify(prepared);
    return { ok: checked.ok, stopped, failed: checked.ok ? [] : [checked], skipped: [] };
  }
  return { preflight, stop, verify };
}

module.exports = { createProjectDeleteStop };
