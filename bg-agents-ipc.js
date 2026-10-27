// bg-agents-ipc.js — see .ai/contexts/bg-agents.md and .ai/contexts/ipc-bridge.md
'use strict';

const { deleteSessionRefusal } = require('./delete-session-guard');
const { JOB_ID_RE } = require('./bg-agents-roster');
const { liveWorkerDescriptor } = require('./bg-worker-liveness');

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
  const checkVerb = async (verb, id, restoring = false) => {
    if (verb === 'rm' || verb === 'respawn' || verb === 'stop') {
      const action = { rm: 'delete', respawn: 'respawn', stop: 'stop' }[verb];
      const declined = { rm: 'not deleted', respawn: 'not respawned', stop: 'not stopped' }[verb];
      let check;
      try {
        check = await bgAgents.conversationCheck(id, { workerLiveness: restoring ? 'all' : verb !== 'stop' });
        if (verb === 'stop' && (!check.known || check.hosted)) return { ok: true };
        if (!check.known) return { ok: false, error: `cannot tell whether this conversation is running (${check.reason}) — ${declined}` };
        if (verb !== 'stop' && check.state === 'running' && check.workerLiveness === 'unknown') {
          return { ok: false, error: `cannot tell whether this conversation's worker is running — ${declined}` };
        }
        if (check.hosted) {
          return { ok: false, error: `cannot ${action} a ${check.state} session; stop it first` };
        }
        for (const sessionId of check.sessionIds) {
          const refusal = await deleteSessionRefusal(sessionId, {
            activeSessions: verb === 'stop' ? new Map([...activeSessions || []].filter(([, session]) =>
              !(session?.isAttach && String(session.attachJobId).toLowerCase() === id.toLowerCase()))) : activeSessions,
            liveJobCheck: sid => bgAgents.liveJobCheck(sid, restoring
              ? { workerLiveness: new Map([[id, check.workerLiveness]]) } : undefined), describeLiveProcess: true,
            liveElsewhereChecked: sid => cliSessionState.liveElsewhereChecked(sid, sessionHasPty, ptyPids, { includeOwnProcesses: true }),
          });
          if (refusal) return { ok: false, error: verb === 'stop'
            ? refusal.replace(/ — [^—]*(?:retry Delete|not deleted)$/, ' — not stopped')
            : refusal.replace('not deleted', declined).replace(/then retry Delete$/, verb === 'respawn' ? 'then retry Respawn' : 'then retry Delete') };
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
  ipcMain.handle('bg-agent-verb', async (_event, verb, id) => {
    const check = await checkVerb(verb, id);
    return check.ok ? bgAgents.runVerb(verb, id) : check;
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
      timer = setTimeout(() => finish(false), 15000);
      check();
    } catch { finish(false); }
  });
  const respawnForHandoff = async job => {
    try {
      const permission = await checkVerb('respawn', job.id, true);
      if (!permission.ok) return { ok: false, refused: true, error: permission.error };
      const result = await bgAgents.runVerb('respawn', job.id);
      if (!result?.ok) return { ok: false, error: result?.error || 'respawn returned no result' };
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
        if (check.state === 'stopped') return refuse('stopped job was not respawned automatically', 'respawn');
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
