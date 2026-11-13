'use strict';

const { fail } = require('./project-delete-identity');
const { AsyncLocalStorage } = require('node:async_hooks');
const scopes = new AsyncLocalStorage();

function discoveryTimeout(budget, now, fallback) {
  const pending = [...(budget.pendingPorts?.values() || [])].filter(detail => {
    if (!fallback.key) return true;
    let current = detail;
    while (current) {
      if (current.key === fallback.key) return true;
      current = budget.pendingPorts.get(current.parent);
    }
    return false;
  });
  const port = pending.at(-1) || fallback;
  const elapsedMs = Math.max(0, now() - port.startedAt);
  return Object.assign(fail('DISCOVERY_TIMEOUT', `${port.port} deadline expired (${elapsedMs} ms elapsed; ${port.boundMs} ms bound).`),
    { port: port.port, elapsedMs, boundMs: port.boundMs });
}

function discoveryDetails(error) {
  return error.code === 'DISCOVERY_TIMEOUT' ? { port: error.port, elapsedMs: error.elapsedMs, boundMs: error.boundMs } : {};
}

function createDiscoveryBounds({ now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  return async function bounded(port, fn, budget, dispose, capMs = Infinity) {
    const startedAt = now(), boundMs = Math.max(0, Math.min(budget.deadline - startedAt, capMs));
    const pending = budget.pendingPorts ||= new Map(), key = Symbol(port);
    const detail = { port, startedAt, boundMs, key, parent: scopes.getStore() };
    pending.set(key, detail);
    let timer, accepted = false, work;
    try {
      if (budget.signal?.aborted || boundMs <= 0) throw discoveryTimeout(budget, now, detail);
      work = Promise.resolve().then(() => scopes.run(key, fn));
      const value = await Promise.race([work, new Promise((_, reject) => {
        timer = schedule(() => reject(discoveryTimeout(budget, now, detail)), boundMs);
      })]);
      if (budget.signal?.aborted || now() >= startedAt + boundMs) throw discoveryTimeout(budget, now, detail);
      accepted = true;
      return value;
    } finally {
      cancel(timer);
      pending.delete(key);
      if (dispose && work && !accepted) void work.then(dispose, () => {}).catch(() => {});
    }
  };
}

async function closeDiscoveryHandle(port, handle, budget, clock = {}) {
  if (!handle) return;
  const work = Promise.resolve().then(() => handle.close());
  if (budget.signal?.aborted || (clock.now || Date.now)() >= budget.deadline) {
    void work.catch(() => {});
    return;
  }
  await createDiscoveryBounds(clock)(port, () => work, budget);
}

module.exports = { createDiscoveryBounds, discoveryTimeout, discoveryDetails, closeDiscoveryHandle };
