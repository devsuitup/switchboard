// bg-agents-ipc.js — see .ai/contexts/bg-agents.md and .ai/contexts/ipc-bridge.md
'use strict';

function init({ ipcMain, bgAgents, getMainWindow, log }) {
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
  ipcMain.handle('bg-agent-verb', (_event, verb, id) => bgAgents.runVerb(verb, id));
  ipcMain.handle('dispatch-bg-agent', (_event, fields) => bgAgents.dispatch(fields));
  subscribe();
}

module.exports = { init };
