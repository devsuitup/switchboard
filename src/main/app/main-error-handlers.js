'use strict';

const { inspect } = require('node:util');
const { createHash } = require('node:crypto');

function installMainErrorHandlers({ log, notify, target = process, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const counts = new Map();
  const pending = new Map();

  function deliver(notice) {
    try {
      if (notify(notice) === false) return false;
    } catch {
      return false;
    }
    return true;
  }

  function sendPending(id) {
    const { notice, state } = pending.get(id) || {};
    if (!state || !notice) return;
    const delay = state.lastSent + 1000 - now();
    if (delay > 0) {
      if (state.timer === null) {
        state.timer = setTimer(() => {
          state.timer = null;
          sendPending(id);
        }, delay);
        state.timer?.unref?.();
      }
      return;
    }
    if (deliver(notice)) {
      clearTimer(state.timer);
      state.timer = null;
      state.lastSent = now();
      pending.delete(id);
    }
  }

  function handle(origin, error) {
    let message = 'Unreadable error';
    let detail = message;
    try {
      message = typeof error?.message === 'string' ? error.message : inspect(error, { customInspect: false, getters: false, depth: 3, maxArrayLength: 20, maxStringLength: 2000, breakLength: Infinity }).slice(0, 16000);
      if (!message.trim()) {
        message = typeof error;
        try {
          if (typeof error?.name === 'string' && error.name.trim()) message = error.name;
        } catch {}
      }
      detail = typeof error?.stack === 'string' ? error.stack : message;
    } catch {}
    try { log.error(`[main:${origin}]`, detail); } catch {}
    const normalized = message.replace(/\s+/g, ' ').trim();
    const id = `main-error:${createHash('sha256').update(normalized).digest('hex')}`;
    const state = counts.get(id) || pending.get(id)?.state || { count: 0, lastSent: -Infinity, timer: null };
    const count = ++state.count;
    counts.delete(id);
    counts.set(id, state);
    if (counts.size > 100) {
      const oldest = counts.keys().next().value;
      counts.delete(oldest);
    }
    const label = origin === 'uncaughtException' ? 'Uncaught exception' : 'Unhandled rejection';
    const summary = normalized.length > 500 ? normalized.slice(0, 499) + '…' : normalized;
    const notice = { id, kind: 'error', count, message: `${label}: ${summary}` };
    pending.delete(id);
    pending.set(id, { notice, state });
    if (pending.size > 100) {
      const oldest = pending.keys().next().value;
      const evicted = pending.get(oldest).state;
      clearTimer(evicted.timer);
      evicted.timer = null;
      pending.delete(oldest);
    }
    sendPending(id);
  }

  const onException = error => handle('uncaughtException', error);
  const onRejection = reason => handle('unhandledRejection', reason);
  target.on('uncaughtException', onException);
  target.on('unhandledRejection', onRejection);

  return {
    flushNotices() {
      for (const id of pending.keys()) sendPending(id);
    },
    dispose() {
      target.removeListener('uncaughtException', onException);
      target.removeListener('unhandledRejection', onRejection);
      for (const { state } of pending.values()) clearTimer(state.timer);
      pending.clear();
      counts.clear();
    },
  };
}

module.exports = { installMainErrorHandlers };
