// bg-agents-ipc.js — see .ai/contexts/bg-agents.md and .ai/contexts/ipc-bridge.md
'use strict';

const { deleteSessionRefusal } = require('../../../delete-session-guard');
const { JOB_ID_RE } = require('./bg-agents-roster');
const { liveWorkerDescriptor } = require('./bg-worker-liveness');
const DESCRIPTOR_WAIT_MS = 15000;

function init({ ipcMain, bgAgents, getMainWindow, log, activeSessions, cliSessionState, sessionHasPty, ptyPids, getSetting }) {
  const push = (snapshot) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('bg-agents-changed', snapshot); } catch (err) { log.warn(`[bg-agents] push failed: ${err.message}`); }
  };
  let unsubscribe = null;
  const unsubscribeView = () => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  };
  const subscribe = () => {
    unsubscribeView();
    unsubscribe = bgAgents.onChange(push);
  };
  ipcMain.handle('get-bg-agents', async () => {
    subscribe();
    bgAgents.start();
    return bgAgents.reconcile();
  });
  const checkVerb = async (verb, id, restoring = false, extraSessionIds = []) => {
    if (verb === 'rm' || verb === 'respawn' || verb === 'stop') {
      const action = { rm: 'delete', respawn: 'respawn', stop: 'stop' }[verb];
      const declined = { rm: 'not deleted', respawn: 'not respawned', stop: 'not stopped' }[verb];
      let check;
      try {
        check = await bgAgents.conversationCheck(id, { workerLiveness: restoring ? 'all' : verb !== 'stop' });
        if (verb === 'stop' && (!check.known || check.hosted)) return { ok: true };
        if (!check.known) return { ok: false, error: `cannot tell whether this conversation is running (${check.reason}) — ${declined}` };
        if (verb !== 'stop' && check.state === 'running' && check.workerLiveness === 'unknown') {
          return { ok: false, error: `cannot tell whether this conversation's worker is running — ${declined}. Check the Agents view, then retry.` };
        }
        if (check.hosted) {
          return { ok: false, error: `cannot ${action} a ${check.state} session; stop it first` };
        }
        const sessionIds = new Set(extraSessionIds.length
          ? [...check.sessionIds, ...extraSessionIds].map(s => s.toLowerCase()) : check.sessionIds);
        if (verb === 'respawn') for (const sid of check.continuationSessionIds || []) sessionIds.add(sid);
        for (const sessionId of sessionIds) {
          const refusal = await deleteSessionRefusal(sessionId, {
            activeSessions: verb === 'stop' ? new Map([...activeSessions || []].filter(([, session]) =>
              !(session?.isAttach && String(session.attachJobId).toLowerCase() === id.toLowerCase()))) : activeSessions,
            liveJobCheck: sid => bgAgents.liveJobCheck(sid, restoring || verb === 'respawn'
              ? { workerLiveness: new Map([[id, check.workerLiveness]]) } : undefined), describeLiveProcess: true,
            liveElsewhereChecked: sid => cliSessionState.liveElsewhereChecked(sid, sessionHasPty, ptyPids, { includeOwnProcesses: true }),
          });
          if (refusal) return { ok: false, error: verb === 'stop'
            ? refusal.replace(/ — [^—]*(?:retry Delete|not deleted)$/, ' — not stopped')
            : refusal.replace('not deleted', declined).replace(/then retry Delete$/, verb === 'respawn' ? 'then retry Respawn' : 'then retry Delete') };
        }
        if (verb === 'respawn') {
          for (const sessionId of new Set([...(check.continuationSessionIds || check.sessionIds), ...extraSessionIds].map(s => s.toLowerCase()))) {
            const continuation = await bgAgents.continuationJobCheck(sessionId, {
              excludeJobId: id, workerLiveness: new Map([[id, check.workerLiveness]]),
            });
            if (!continuation.known) return { ok: false, error: `cannot check conversation continuations (${continuation.reason}) — not respawned. Check the Agents view, then retry.` };
            if (continuation.job) return { ok: false, error: `continuation job ${continuation.job.id} still runs this conversation — not respawned. Attach to it or stop it from the Agents view, then retry.` };
          }
        }
      } catch (err) {
        if (verb === 'stop' && !check) return { ok: true };
        return { ok: false, error: `cannot tell whether this conversation is running (${err.message}) — ${declined}` };
      }
    }
    return { ok: true };
  };
  ipcMain.handle('check-bg-agent-verb', (_event, verb, id) => {
    if (!['rm', 'respawn', 'stop'].includes(verb)) return { ok: false, error: `unknown verb: ${String(verb)}` };
    if (typeof id !== 'string' || !JOB_ID_RE.test(id)) return { ok: false, error: 'invalid background session id' };
    return checkVerb(verb, id);
  });
  const respawning = new Map();
  const justRespawned = new Map();
  const holdRespawn = (key, value, job) => {
    let unsubscribe;
    const clear = () => {
      clearTimeout(timer);
      unsubscribe?.();
      if (justRespawned.get(key)?.value === value) justRespawned.delete(key);
    };
    const timer = setTimeout(clear, DESCRIPTOR_WAIT_MS);
    timer.unref?.();
    const check = () => {
      try { if (liveWorkerDescriptor(job, cliSessionState.readAllDescriptors())) clear(); } catch {}
    };
    justRespawned.set(key, { value, clear, job, check });
    try { unsubscribe = cliSessionState.onDescriptorsChanged(check); } catch {}
    check();
  };
  const runRespawn = (id, restoring = false, extraSessionIds = [], job = { id }) => {
    const key = String(id).toLowerCase();
    const recent = justRespawned.get(key);
    if (recent) {
      Object.assign(recent.job, job);
      recent.check();
      return Promise.resolve(recent.value);
    }
    const extraIds = new Set(extraSessionIds.map(sid => sid.toLowerCase()));
    const flight = respawning.get(key);
    if (flight) {
      Object.assign(flight.job, job);
      if (flight.restoring === restoring && [...extraIds].every(sid => flight.extraIds.has(sid))) return flight.pending;
      const retry = () => runRespawn(id, restoring, extraSessionIds, job);
      return flight.pending.then(value => !value.refused ? value : retry(), retry);
    }
    const pending = (async () => {
      const check = await checkVerb('respawn', id, restoring, extraSessionIds);
      if (!check.ok) return { result: check, refused: true };
      const result = await bgAgents.runVerb('respawn', id);
      if (result?.refused) return { result, refused: true };
      const value = { result: result?.ok ? result : { ok: false,
        error: `Respawn result is unknown (${result?.error || 'no result'}). Check the Agents view before retrying.` }, refused: false };
      holdRespawn(key, value, job);
      return value;
    })().finally(() => respawning.delete(key));
    respawning.set(key, { pending, restoring, extraIds, job });
    return pending;
  };
  ipcMain.handle('bg-agent-verb', async (_event, verb, id) => {
    if (verb === 'respawn') return (await runRespawn(id)).result;
    const check = await checkVerb(verb, id);
    if (!check.ok) return check;
    const result = await bgAgents.runVerb(verb, id);
    if (verb === 'stop' && result?.ok) justRespawned.get(String(id).toLowerCase())?.clear();
    return result;
  });
  ipcMain.handle('dispatch-bg-agent', (_event, fields) => bgAgents.dispatch(fields));
  ipcMain.handle('bg-agent-live-job', (_event, sessionId) => bgAgents.liveJobCheck(String(sessionId || '')));
  const restoring = new Map();
  const waitForDescriptor = job => new Promise(resolve => {
    let unsubscribe;
    let timer;
    let settled = false;
    const finish = found => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(found);
    };
    const check = () => {
      try { if (liveWorkerDescriptor(job, cliSessionState.readAllDescriptors())) finish(true); } catch { finish(false); }
    };
    try {
      unsubscribe = cliSessionState.onDescriptorsChanged(check);
      timer = setTimeout(() => finish(false), DESCRIPTOR_WAIT_MS);
      check();
    } catch { finish(false); }
  });
  const respawnForHandoff = async (job, extraSessionIds = []) => {
    try {
      const { result, refused } = await runRespawn(job.id, true, extraSessionIds, { ...job });
      if (!result?.ok) return { ok: false, ...(refused ? { refused: true } : {}), error: result?.error || 'respawn returned no result' };
      return { ok: true, attached: await waitForDescriptor(job) };
    } catch (err) { return { ok: false, error: err.message || String(err) }; }
  };
  const restoreBackgroundJob = async (sessionId, { attachOnly = false } = {}) => {
    let job;
    const refuse = (reason, recovery) => ({ action: 'refuse', ...(job ? { jobId: job.id } : {}),
      reason: job ? `Job ${job.id} (${job.state}): ${reason}` : reason, ...(recovery ? { recovery } : {}) });
    try {
      if (typeof sessionId !== 'string' || !sessionId) return refuse('invalid saved session id');
      const global = await getSetting('global');
      const item = global?.openWorkingSet?.find(item => item.sessionId === sessionId && item.bg === true);
      if (!item) return refuse('session is not a saved background entry in the working set');
      const lookup = bgAgents.findRestoreJob(sessionId, item.attachJobId);
      if (!lookup.known || !lookup.job) return { ...refuse(lookup.reason || 'background job record unavailable'), ...(lookup.missing ? { missing: true } : {}) };
      job = lookup.job;
      const check = await bgAgents.conversationCheck(job.id, { workerLiveness: 'all' });
      if (!check.known) return refuse(check.reason || 'conversation liveness unknown');
      job.state = check.state;
      if (check.workerLiveness !== 'live' && check.workerLiveness !== 'dead') return refuse('worker liveness unknown — not respawned');
      if (check.workerLiveness === 'dead') {
        if (attachOnly) return refuse('worker is not live — not attached');
        if (!['working', 'done', 'running', 'failed'].includes(check.state)) return refuse(check.state + ' job was not respawned automatically', 'respawn');
        const result = await respawnForHandoff(job);
        if (!result.ok) return refuse(result.error);
        return result.attached ? { action: 'attach', sessionId, jobId: job.id }
          : { action: 'respawned-not-attached', jobId: job.id };
      }
      if (await waitForDescriptor(job)) return { action: 'attach', sessionId, jobId: job.id };
      return refuse('live worker has no attachable background descriptor — not attached');
    } catch (err) { return refuse(err.message || String(err)); }
  };
  ipcMain.handle('restore-background-job', (_event, sessionId, options) => {
    if (restoring.has(sessionId)) return restoring.get(sessionId);
    const pending = restoreBackgroundJob(sessionId, { attachOnly: options?.attachOnly === true })
      .finally(() => restoring.delete(sessionId));
    restoring.set(sessionId, pending);
    return pending;
  });
  unsubscribeView.respawnForHandoff = respawnForHandoff;
  return unsubscribeView;
}

module.exports = { init };
