'use strict';

const { randomUUID } = require('node:crypto');

function createTriggerRendererBridge({ ipcMain, getWindow, getSession, launchAllowed,
  now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  const pending = new Map();
  let document = null;
  let disposed = false;
  const failure = (reason, error) => ({ ok: false, reason, ...(error ? { error } : {}) });
  const available = state => !disposed && state && document === state && getWindow() === state.win
    && !state.win.isDestroyed() && !state.wc.isDestroyed();
  const senderMatches = (state, event) => available(state) && event?.sender === state.wc
    && !!event.senderFrame && event.senderFrame === state.wc.mainFrame;

  function finish(record, result, interrupted = false) {
    if (!pending.delete(record.requestId)) return;
    clearTimeoutFn(record.timer);
    record.controller.abort();
    const evidence = record.opened ? { [record.mode === 'new' ? 'created' : 'resumed']: true } : {};
    record.resolve({ ...result, ...evidence,
      ...(interrupted && !result.ok && record.mode !== 'reattach' && record.phase === 'opening' ? { uncertain: true } : {}) });
  }

  function revoke(win, reason = 'renderer unavailable') {
    const state = document;
    if (!state || state.win !== win) return;
    state.ready = false;
    state.frame = null;
    state.epoch = randomUUID();
    for (const record of [...pending.values()]) if (record.document === state) finish(record, failure(reason), true);
  }

  function detach() {
    if (!document) return;
    const state = document;
    revoke(state.win);
    for (const [emitter, name, listener] of state.listeners) emitter.removeListener(name, listener);
    document = null;
  }

  function attach(win) {
    if (disposed || document?.win === win) return;
    detach();
    const wc = win.webContents;
    const state = { win, wc, epoch: randomUUID(), ready: false, frame: null, listeners: [] };
    document = state;
    const listen = (emitter, name, listener) => {
      emitter.on(name, listener);
      state.listeners.push([emitter, name, listener]);
    };
    listen(wc, 'did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) revoke(win);
    });
    listen(wc, 'render-process-gone', () => revoke(win));
    listen(wc, 'destroyed', detach);
    listen(win, 'closed', detach);
  }

  function targetMatches(record) {
    const entry = getSession(record.tabKey);
    const pinned = record.mode === 'reattach' ? record.pinned : record.opened;
    return !!pinned && entry === pinned.entry && !entry.exited
      && entry.pty === pinned.pty && entry.generation === pinned.generation;
  }

  function valid(record) {
    if (!record || !pending.has(record.requestId)) return false;
    if (!launchAllowed()) {
      revoke(record.document.win, 'Switchboard is closing.');
      return false;
    }
    if (now() >= record.deadline) {
      finish(record, failure(record.sent ? 'renderer action timed out'
        : record.preparing ? 'session action timed out' : 'renderer not ready'), true);
      return false;
    }
    if (!available(record.document) || record.document.epoch !== record.epoch
      || record.document.frame !== record.document.wc.mainFrame) {
      finish(record, failure('renderer unavailable'), true);
      return false;
    }
    if ((record.mode === 'reattach' || record.opened) && !targetMatches(record)) {
      finish(record, failure('session target changed'), true);
      return false;
    }
    return true;
  }

  function permitView(record) {
    return Object.freeze({ requestId: record.requestId, documentEpoch: record.epoch,
      mode: record.mode, requestedSessionId: record.requestedSessionId, tabKey: record.tabKey,
      generation: record.generation, project: record.project, deadline: record.deadline,
      signal: record.controller.signal });
  }

  async function dispatch(record) {
    if (record.preparing || !record.document.ready) return;
    record.preparing = true;
    record.epoch = record.document.epoch;
    if (!valid(record)) return;
    try {
      if (record.beforeDispatch) await record.beforeDispatch(permitView(record));
    } catch (error) {
      finish(record, failure('action state could not be saved', error.message));
      return;
    }
    if (!valid(record)) return;
    const payload = { requestId: record.requestId, documentEpoch: record.epoch,
      mode: record.mode, requestedSessionId: record.requestedSessionId, tabKey: record.tabKey,
      generation: record.generation, session: record.session, project: record.project,
      name: record.name, deadline: record.deadline };
    try {
      record.sent = true;
      record.document.wc.send('trigger-session-action', payload);
    } catch (error) {
      finish(record, failure('renderer unavailable', error.message), true);
    }
  }

  function ready(event) {
    const state = document;
    if (!senderMatches(state, event) || !launchAllowed()) return null;
    state.ready = true;
    state.frame = event.senderFrame;
    for (const record of pending.values()) if (record.document === state) void dispatch(record);
    return { documentEpoch: state.epoch };
  }

  function reply(event, ack) {
    if (!ack || typeof ack !== 'object') return;
    const record = pending.get(ack.requestId);
    if (!record || !record.sent || !senderMatches(record.document, event)) return;
    if (ack.documentEpoch !== record.epoch || ack.mode !== record.mode
      || ack.requestedSessionId !== record.requestedSessionId || ack.tabKey !== record.tabKey
      || typeof ack.ok !== 'boolean') return;
    if (!valid(record)) return;
    const generation = record.mode === 'reattach' ? record.generation : record.opened?.generation ?? null;
    if (ack.generation !== generation) return;
    if (!ack.ok) {
      finish(record, failure(typeof ack.reason === 'string' ? ack.reason : 'session open failed',
        typeof ack.error === 'string' ? ack.error : undefined));
      return;
    }
    if (!targetMatches(record)) return;
    finish(record, { ok: true, requestId: record.requestId, documentEpoch: record.epoch,
      mode: record.mode, requestedSessionId: record.requestedSessionId, tabKey: record.tabKey, generation });
  }

  function request(operation, beforeDispatch) {
    const state = document;
    if (!launchAllowed()) return Promise.resolve(failure('Switchboard is closing.'));
    if (!available(state)) return Promise.resolve(failure('window not available'));
    if (now() >= operation.deadline) return Promise.resolve(failure('session action timed out'));
    if (!['resume', 'new', 'reattach'].includes(operation.mode)
      || !Number.isFinite(operation.deadline)
      || typeof operation.tabKey !== 'string'
      || (operation.mode === 'new' ? operation.requestedSessionId !== null : typeof operation.requestedSessionId !== 'string')
      || (operation.mode === 'reattach' && (!operation.entry?.pty || operation.generation == null))) {
      return Promise.resolve(failure('session open failed'));
    }
    const record = { ...operation, beforeDispatch, document: state, epoch: state.epoch,
      requestId: randomUUID(), controller: new AbortController(), phase: 'issued', sent: false, preparing: false };
    if (record.mode === 'reattach') record.pinned = { entry: operation.entry, pty: operation.entry.pty, generation: operation.generation };
    return new Promise(resolve => {
      record.resolve = resolve;
      record.timer = setTimeoutFn(() => finish(record, failure(record.sent ? 'renderer action timed out'
        : record.preparing ? 'session action timed out' : 'renderer not ready'), true), Math.max(0, record.deadline - now()));
      pending.set(record.requestId, record);
      if (state.ready) void dispatch(record);
    });
  }

  function consumePermit(requestId, event, { sessionId, projectPath, isNew, sessionOptions } = {}) {
    const record = pending.get(requestId);
    if (!record || !record.sent || !senderMatches(record.document, event) || !valid(record)
      || record.phase !== 'issued' || sessionId !== record.tabKey || projectPath !== record.project
      || isNew !== (record.mode === 'new') || sessionOptions?.type === 'attach'
      || sessionOptions?.type === 'terminal' || sessionOptions?.forkFrom
      || (record.mode === 'reattach' && sessionOptions?.reattachOnly !== true)) return null;
    record.phase = 'opening';
    return permitView(record);
  }

  function checkPermit(requestId) {
    const record = pending.get(requestId);
    return record?.phase === 'opening' && valid(record) ? permitView(record) : null;
  }

  function markOpened(requestId, entry) {
    const record = pending.get(requestId);
    if (!record || record.mode === 'reattach' || record.phase !== 'opening' || record.opened || !valid(record)
      || getSession(record.tabKey) !== entry || !entry?.pty || entry.exited || entry.generation == null) return false;
    record.opened = { entry, pty: entry.pty, generation: entry.generation };
    return true;
  }

  function dispose() {
    detach();
    disposed = true;
    ipcMain.removeHandler('trigger-actions-ready');
    ipcMain.removeListener('trigger-session-action-result', reply);
  }

  ipcMain.handle('trigger-actions-ready', ready);
  ipcMain.on('trigger-session-action-result', reply);
  return { attach, request, consumePermit, checkPermit, markOpened, revoke, dispose };
}

module.exports = { createTriggerRendererBridge };
