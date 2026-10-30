'use strict';

const { inspect } = require('node:util');

function installMainErrorHandlers({ log, notify, target = process, now = Date.now }) {
  const shown = new Map();
  const pending = new Map();
  let sequence = 0;

  function deliver(message, notice) {
    const time = now();
    for (const [key, timestamp] of shown) {
      if (time - timestamp >= 60_000) shown.delete(key);
    }
    if (shown.has(message)) return true;
    try {
      if (notify(notice) === false) return false;
    } catch {
      return false;
    }
    shown.set(message, time);
    return true;
  }

  function handle(origin, error) {
    let message = 'Unreadable error';
    let detail = message;
    try {
      message = typeof error?.message === 'string' ? error.message : inspect(error, { customInspect: false, getters: false });
      detail = typeof error?.stack === 'string' ? error.stack : message;
    } catch {}
    try { log.error(`[main:${origin}]`, detail); } catch {}
    const label = origin === 'uncaughtException' ? 'Uncaught exception' : 'Unhandled rejection';
    const notice = { id: `main-error:${++sequence}`, kind: 'error', message: `${label}: ${message}. Details are in the log (Settings → Diagnostics).` };
    if (!deliver(message, notice)) {
      pending.set(message, notice);
      if (pending.size > 100) pending.delete(pending.keys().next().value);
    } else {
      pending.delete(message);
    }
  }

  const onException = error => handle('uncaughtException', error);
  const onRejection = reason => handle('unhandledRejection', reason);
  target.on('uncaughtException', onException);
  target.on('unhandledRejection', onRejection);

  return {
    flushNotices() {
      for (const [message, notice] of pending) {
        if (deliver(message, notice)) pending.delete(message);
      }
    },
    dispose() {
      target.removeListener('uncaughtException', onException);
      target.removeListener('unhandledRejection', onRejection);
      pending.clear();
      shown.clear();
    },
  };
}

module.exports = { installMainErrorHandlers };
