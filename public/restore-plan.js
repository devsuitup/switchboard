// Dual-mode helper — see .ai/contexts/session-cache.md ("Working-set restore: retry until indexing is done")

function createRestorePlanner({ savedSet, maxTicks = 50, askOnce = false } = {}) {
  const items = new Map((savedSet || []).map(item => [item.sessionId, item]));
  const remaining = new Set(items.keys());
  let ticks = 0;
  let settled = remaining.size === 0;

  function finish() {
    remaining.clear();
    settled = true;
  }

  function giveUp() {
    const unavailable = [...remaining].map(id => items.get(id));
    finish();
    return unavailable;
  }

  function dismiss() {
    finish();
  }

  function tick({ sessionMap, openSessions, indexingDone, sessionOpenedOutsideRestore } = {}) {
    if (settled) return { action: 'nothing', candidates: [], remaining: 0, unavailable: [] };

    if (sessionOpenedOutsideRestore) {
      finish();
      return { action: 'nothing', candidates: [], remaining: 0, unavailable: [] };
    }

    for (const id of remaining) {
      if (openSessions && openSessions.has(id)) remaining.delete(id);
    }
    if (remaining.size === 0) {
      finish();
      return { action: 'nothing', candidates: [], remaining: 0, unavailable: [] };
    }

    const indexedIds = [...remaining].filter(id => sessionMap && sessionMap.has(id));
    const allIndexed = indexedIds.length === remaining.size;

    if (askOnce) {
      if (allIndexed || indexingDone) {
        const candidates = indexedIds.map(id => items.get(id));
        for (const id of indexedIds) remaining.delete(id);
        const unavailable = giveUp();
        return candidates.length > 0
          ? { action: 'restore', candidates, remaining: 0, unavailable }
          : { action: 'nothing', candidates: [], remaining: 0, unavailable };
      }
      ticks++;
      if (ticks >= maxTicks) {
        return { action: 'nothing', candidates: [], remaining: 0, unavailable: giveUp() };
      }
      return { action: 'wait', candidates: [], remaining: remaining.size, unavailable: [] };
    }

    if (indexedIds.length > 0) {
      const candidates = indexedIds.map(id => items.get(id));
      for (const id of indexedIds) remaining.delete(id);
      if (remaining.size === 0) settled = true;
      const unavailable = indexingDone ? giveUp() : [];
      return { action: 'restore', candidates, remaining: remaining.size, unavailable };
    }

    if (indexingDone) {
      return { action: 'nothing', candidates: [], remaining: 0, unavailable: giveUp() };
    }

    ticks++;
    if (ticks >= maxTicks) {
      return { action: 'nothing', candidates: [], remaining: 0, unavailable: giveUp() };
    }

    return { action: 'wait', candidates: [], remaining: remaining.size, unavailable: [] };
  }

  return { tick, dismiss, isSettled: () => settled, pending: () => [...remaining].map(id => items.get(id)) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createRestorePlanner };
}
