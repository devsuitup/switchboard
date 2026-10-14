'use strict';

// see .ai/contexts/bg-agents.md ("Send to background")
const tabLocks = new Map();

function tryAcquireTabInput(tab) {
  if (tabLocks.has(tab)) return null;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  tabLocks.set(tab, held);
  return () => {
    if (tabLocks.get(tab) === held) tabLocks.delete(tab);
    release();
  };
}

async function acquireTabInput(tab, deadline) {
  const previous = tabLocks.get(tab) || Promise.resolve();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => held);
  tabLocks.set(tab, tail);
  tail.then(() => { if (tabLocks.get(tab) === tail) tabLocks.delete(tab); });
  let timer;
  const acquired = await Promise.race([previous.then(() => true), new Promise(resolve => {
    timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
  })]);
  clearTimeout(timer);
  const unlock = () => { release(); };
  if (!acquired || Date.now() >= deadline) { unlock(); return null; }
  return unlock;
}

module.exports = { tryAcquireTabInput, acquireTabInput };
