// bg-agents-ipc.js — see .ai/contexts/bg-agents.md and .ai/contexts/ipc-bridge.md
'use strict';

const { deleteSessionRefusal } = require('./delete-session-guard');
const { isLiveJobState } = require('./bg-agents-roster');

function init({ ipcMain, bgAgents, getMainWindow, log, activeSessions, cliSessionState, sessionHasPty, ptyPids }) {
  const push = (snapshot) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('bg-agents-changed', snapshot); } catch (err) { log.warn(`[bg-agents] push failed: ${err.message}`); }
  };
  let unsubscribe = null;
  const subscribe = () => {
    if (unsubscribe) unsubscribe();
    unsubscribe = bgAgents.onChange(push);
  };
  ipcMain.handle('get-bg-agents', async () => {
    subscribe();
    bgAgents.start();
    return bgAgents.reconcile();
  });
  ipcMain.handle('bg-agent-verb', async (_event, verb, id) => {
    if (verb === 'rm' || verb === 'respawn' || verb === 'stop') {
      try {
        const check = bgAgents.conversationCheck(id);
        if (!check.known) return { ok: false, error: `cannot tell whether this conversation is running (${check.reason}) — not ${verb}` };
        if (isLiveJobState(check.state)) {
          if (verb === 'stop') return bgAgents.runVerb(verb, id);
          return { ok: false, error: `cannot ${verb} a ${check.state} session; stop it first` };
        }
        for (const sessionId of check.sessionIds) {
          const refusal = await deleteSessionRefusal(sessionId, {
            activeSessions, liveJobCheck: sid => bgAgents.liveJobCheck(sid), describeLiveProcess: true,
            liveElsewhereChecked: sid => cliSessionState.liveElsewhereChecked(sid, sessionHasPty, ptyPids, { includeOwnProcesses: true }),
          });
          if (refusal) return { ok: false, error: refusal.replace('not deleted', `not ${verb}`) };
        }
      } catch (err) {
        return { ok: false, error: `cannot tell whether this conversation is running (${err.message}) — not ${verb}` };
      }
    }
    return bgAgents.runVerb(verb, id);
  });
  ipcMain.handle('dispatch-bg-agent', (_event, fields) => bgAgents.dispatch(fields));
  ipcMain.handle('bg-agent-live-job', (_event, sessionId) => bgAgents.liveJobCheck(String(sessionId || '')));
  subscribe();
}

module.exports = { init };
