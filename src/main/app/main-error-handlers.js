'use strict';

const { inspect } = require('node:util');
const { createHash } = require('node:crypto');

function installMainErrorHandlers({ log, notify, target = process }) {
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

  function handle(origin, error) {
    let message = 'Unreadable error';
    let detail = message;
    try {
      message = typeof error?.message === 'string' ? error.message : inspect(error, { customInspect: false, getters: false, depth: 3, maxArrayLength: 20, maxStringLength: 2000, breakLength: Infinity });
      detail = typeof error?.stack === 'string' ? error.stack : message;
    } catch {}
    try { log.error(`[main:${origin}]`, detail); } catch {}
    const normalized = message.replace(/\s+/g, ' ').trim();
    const id = `main-error:${createHash('sha256').update(normalized).digest('hex')}`;
    const count = (counts.get(id) || 0) + 1;
    counts.delete(id);
    counts.set(id, count);
    if (counts.size > 100) counts.delete(counts.keys().next().value);
    const label = origin === 'uncaughtException' ? 'Uncaught exception' : 'Unhandled rejection';
    const summary = normalized.length > 500 ? normalized.slice(0, 499) + '…' : normalized;
    const notice = { id, kind: 'error', count, message: `${label}: ${summary}` };
    if (!deliver(notice)) {
      pending.set(id, notice);
      if (pending.size > 100) pending.delete(pending.keys().next().value);
    } else {
      pending.delete(id);
    }
  }

  const onException = error => handle('uncaughtException', error);
  const onRejection = reason => handle('unhandledRejection', reason);
  target.on('uncaughtException', onException);
  target.on('unhandledRejection', onRejection);

  return {
    flushNotices() {
      for (const [id, notice] of pending) {
        if (deliver(notice)) pending.delete(id);
      }
    },
    dispose() {
      target.removeListener('uncaughtException', onException);
      target.removeListener('unhandledRejection', onRejection);
      pending.clear();
      counts.clear();
    },
  };
}

module.exports = { installMainErrorHandlers };
