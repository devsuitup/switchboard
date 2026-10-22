// bg-agents-ipc.js — see .ai/contexts/bg-agents.md and .ai/contexts/ipc-bridge.md
'use strict';

const { deleteSessionRefusal } = require('./delete-session-guard');
const { JOB_ID_RE } = require('./bg-agents-roster');

function init({ ipcMain, bgAgents, getMainWindow, log, activeSessions, cliSessionState, sessionHasPty, ptyPids }) {
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
  const checkVerb = async (verb, id) => {
    if (verb === 'rm' || verb === 'respawn' || verb === 'stop') {
      const action = { rm: 'delete', respawn: 'respawn', stop: 'stop' }[verb];
      const declined = { rm: 'not deleted', respawn: 'not respawned', stop: 'not stopped' }[verb];
      let check;
      try {
        check = bgAgents.conversationCheck(id);
        if (verb === 'stop' && (!check.known || check.hosted)) return { ok: true };
        if (!check.known) return { ok: false, error: `cannot tell whether this conversation is running (${check.reason}) — ${declined}` };
        if (check.hosted) {
          return { ok: false, error: `cannot ${action} a ${check.state} session; stop it first` };
        }
        for (const sessionId of check.sessionIds) {
          const refusal = await deleteSessionRefusal(sessionId, {
            activeSessions: verb === 'stop' ? new Map([...activeSessions || []].filter(([, session]) =>
              !(session?.isAttach && String(session.attachJobId).toLowerCase() === id.toLowerCase()))) : activeSessions,
            liveJobCheck: sid => bgAgents.liveJobCheck(sid), describeLiveProcess: true,
            liveElsewhereChecked: sid => cliSessionState.liveElsewhereChecked(sid, sessionHasPty, ptyPids, { includeOwnProcesses: true }),
          });
          if (refusal) return { ok: false, error: verb === 'stop'
            ? refusal.replace(/ — [^—]*(?:retry Delete|not deleted)$/, ' — not stopped')
            : refusal.replace('not deleted', declined) };
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
  return unsubscribeView;
}

module.exports = { init };
