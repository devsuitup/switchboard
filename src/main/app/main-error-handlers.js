'use strict';

const { inspect, types } = require('node:util');
const { createHash } = require('node:crypto');

const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const inspectOptions = { customInspect: false, getters: false, depth: 3, maxArrayLength: 20, maxStringLength: 2000, breakLength: Infinity };

function largeIndexedPreview(error) {
  const array = Array.isArray(error);
  const string = types.isStringObject(error);
  const view = types.isDataView(error);
  if (!array && !string && !ArrayBuffer.isView(error)) return null;
  const intrinsic = (prototype, key) => Reflect.apply(Object.getOwnPropertyDescriptor(prototype, key).get, error, []);
  const value = string ? String.prototype.valueOf.call(error) : null;
  const length = array ? Object.getOwnPropertyDescriptor(error, 'length').value
    : string ? value.length : intrinsic(view ? DataView.prototype : typedArrayPrototype, view ? 'byteLength' : 'length');
  if (length <= 1000) return null;
  const name = array ? 'Array' : string ? 'String' : types.isUint8Array(error) && Object.getPrototypeOf(error) === Buffer.prototype ? 'Buffer'
    : view ? 'DataView' : intrinsic(typedArrayPrototype, Symbol.toStringTag);
  let sample;
  if (string) sample = String.prototype.slice.call(value, 0, 2000);
  else if (view) sample = new Uint8Array(intrinsic(DataView.prototype, 'buffer'), intrinsic(DataView.prototype, 'byteOffset'), Math.min(length, 20));
  else {
    sample = new Array(Math.min(length, 20));
    for (let i = 0; i < sample.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(error, i);
      if (!descriptor) continue;
      if ('value' in descriptor) sample[i] = descriptor.value;
      else sample[i] = descriptor.get ? descriptor.set ? '[Getter/Setter]' : '[Getter]' : '[Setter]';
    }
  }
  return `[${name} ${view ? 'byteLength' : 'length'}=${length}; named properties not inspected] ${inspect(sample, inspectOptions)}`.slice(0, 16000);
}

function installMainErrorHandlers({ log, notify, target = process, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const counts = new Map();
  const pending = new Map();
  const delivered = new Map();

  function deliver(notice) {
    try {
      if (notify(notice) === false) return false;
    } catch {
      return false;
    }
    delivered.delete(notice.id);
    delivered.set(notice.id, notice);
    if (delivered.size > 5) delivered.delete(delivered.keys().next().value);
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
    let messageLength = null;
    try {
      const proxy = types.isProxy(error);
      if (proxy) message = '[Proxy; inspection omitted]';
      else {
        const errorMessage = error?.message;
        const previewMessage = typeof errorMessage === 'string' ? null : largeIndexedPreview(error);
        if (typeof errorMessage === 'string') {
          if (errorMessage.length > 16000) messageLength = errorMessage.length;
          message = errorMessage.slice(0, 16000);
        } else if (previewMessage !== null) message = previewMessage;
        else {
          const preview = Array.isArray(error) || ArrayBuffer.isView(error) || types.isStringObject(error);
          let keyCount = 0;
          if (error && (typeof error === 'object' || typeof error === 'function')) {
            const keys = Object.keys(error);
            if (preview) {
              const indexedLength = Array.isArray(error) ? 0xFFFFFFFF : types.isTypedArray(error) ? Number.MAX_SAFE_INTEGER
                : types.isStringObject(error) ? String.prototype.valueOf.call(error).length : 0;
              for (const key of keys) {
                const index = Number(key);
                if (Number.isInteger(index) && index >= 0 && index < indexedLength && String(index) === key) continue;
                if (++keyCount > 1000) break;
              }
            } else keyCount = keys.length;
          }
          message = keyCount > 1000 ? preview ? '[Object with more than 1000 named keys; inspection omitted]' : `[Object with ${keyCount} keys; inspection omitted]`
            : inspect(error, inspectOptions).slice(0, 16000);
        }
      }
      if (!message.trim()) {
        message = typeof error;
        try {
          if (!proxy && typeof error?.name === 'string' && error.name.trim()) message = error.name;
        } catch {}
      }
      detail = message;
      if (!proxy) {
        const longMessage = message.length > 15000;
        if (longMessage) detail = `${message.slice(0, 11000)}\n[truncated; length=${messageLength ?? message.length}]`;
        let stack;
        if (messageLength === null) stack = error?.stack;
        else {
          const formatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
          try {
            Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, writable: true,
              value: (_, frames) => frames.slice(-20).map(frame => `    at ${frame}`).join('\n').slice(-4000) });
            const descriptor = error && Object.getOwnPropertyDescriptor(error, 'stack');
            if (descriptor && 'value' in descriptor) stack = descriptor.value;
            else if (nativeStackGetter && descriptor?.get === nativeStackGetter && types.isNativeError(error)) {
              stack = Reflect.apply(nativeStackGetter, error, []);
            }
          } finally {
            if (formatter) Object.defineProperty(Error, 'prepareStackTrace', formatter);
            else delete Error.prepareStackTrace;
          }
        }
        if (typeof stack === 'string') detail = longMessage ? `${detail}\n${stack.slice(-4000)}` : stack.slice(0, 16000);
      }
    } catch {}
    try { log.error(`[main:${origin}]`, detail); } catch {}
    const normalized = message.replace(/\s+/g, ' ').trim();
    const id = `main-error:${createHash('sha256').update(normalized).update(messageLength === null ? '' : `\0length=${messageLength}`).digest('hex')}`;
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
    dismissNotices(ids) {
      if (!Array.isArray(ids) || ids.length > 5 || ![...ids].every(id => typeof id === 'string')) return;
      for (const id of ids) delivered.delete(id);
    },
    flushNotices({ replay = false } = {}) {
      if (replay) for (const notice of [...delivered.values()]) deliver(notice);
      for (const id of pending.keys()) sendPending(id);
    },
    dispose() {
      target.removeListener('uncaughtException', onException);
      target.removeListener('unhandledRejection', onRejection);
      for (const { state } of pending.values()) clearTimer(state.timer);
      pending.clear();
      counts.clear();
      delivered.clear();
    },
  };
}

module.exports = { installMainErrorHandlers };
