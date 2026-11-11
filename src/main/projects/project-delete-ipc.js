'use strict';

function registerProjectDeleteIpc({ ipcMain, service, getMainWindow, announce = () => {} }) {
  let document = null, disposed = false;
  const listeners = [];
  const channels = ['preview-project-delete', 'delete-project', 'project-delete-state'];
  function revoke() { document = null; }
  function detach() {
    revoke();
    for (const [emitter, name, listener] of listeners.splice(0)) emitter.removeListener(name, listener);
  }
  function attach(win) {
    detach();
    if (disposed || !win || win !== getMainWindow() || win.isDestroyed() || win.webContents.isDestroyed()) return;
    const wc = win.webContents;
    const bind = () => {
      if (disposed || win !== getMainWindow() || win.isDestroyed() || wc.isDestroyed()) return;
      const state = { win, wc, frame: wc.mainFrame };
      state.valid = () => document === state && !disposed && win === getMainWindow()
        && !win.isDestroyed() && !wc.isDestroyed() && wc.mainFrame === state.frame;
      document = state;
      announce(service.rebind(state));
    };
    const listen = (emitter, name, fn) => { emitter.on(name, fn); listeners.push([emitter, name, fn]); };
    listen(wc, 'did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) revoke(); });
    listen(wc, 'did-finish-load', bind);
    listen(wc, 'render-process-gone', revoke);
    listen(wc, 'destroyed', detach);
    listen(win, 'closed', detach);
    bind();
  }
  const authority = event => document?.valid() && event?.sender === document.wc
    && event.senderFrame && event.senderFrame === document.frame ? document : null;
  for (const [index, method] of ['preview', 'execute', 'readState'].entries()) ipcMain.handle(channels[index], async (event, input) => {
    const sender = authority(event);
    if (!sender) return { ok: false, code: 'UNAUTHORIZED', ...(method === 'preview' ? { token: null } : {}) };
    const result = await service[method](sender, input);
    return sender.valid() ? result : { ok: false, code: 'UNAUTHORIZED', ...(method === 'preview' ? { token: null } : {}) };
  });
  return { attach, rebind: () => document && service.rebind(document), dispose() {
    disposed = true; detach(); for (const channel of channels) ipcMain.removeHandler(channel);
  } };
}

module.exports = { registerProjectDeleteIpc };
