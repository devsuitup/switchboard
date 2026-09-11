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

  function dismiss() {
    finish();
  }

  function tick({ sessionMap, openSessions, indexingDone, sessionOpenedOutsideRestore } = {}) {
    if (settled) return { action: 'nothing', candidates: [], remaining: 0 };

    if (sessionOpenedOutsideRestore) {
      finish();
      return { action: 'nothing', candidates: [], remaining: 0 };
    }

    for (const id of remaining) {
      if (openSessions && openSessions.has(id)) remaining.delete(id);
    }
    if (remaining.size === 0) {
      finish();
      return { action: 'nothing', candidates: [], remaining: 0 };
    }

    const indexedIds = [...remaining].filter(id => sessionMap && sessionMap.has(id));
    const allIndexed = indexedIds.length === remaining.size;

    if (askOnce) {
      if (allIndexed || indexingDone) {
        const candidates = indexedIds.map(id => items.get(id));
        finish();
        return candidates.length > 0
          ? { action: 'restore', candidates, remaining: 0 }
          : { action: 'nothing', candidates: [], remaining: 0 };
      }
      ticks++;
      if (ticks >= maxTicks) {
        finish();
        return { action: 'nothing', candidates: [], remaining: 0 };
      }
      return { action: 'wait', candidates: [], remaining: remaining.size };
    }

    if (indexedIds.length > 0) {
      const candidates = indexedIds.map(id => items.get(id));
      for (const id of indexedIds) remaining.delete(id);
      if (remaining.size === 0) settled = true;
      return { action: 'restore', candidates, remaining: remaining.size };
    }

    if (indexingDone) {
      finish();
      return { action: 'nothing', candidates: [], remaining: 0 };
    }

    ticks++;
    if (ticks >= maxTicks) {
      finish();
      return { action: 'nothing', candidates: [], remaining: 0 };
    }

    return { action: 'wait', candidates: [], remaining: remaining.size };
  }

  return { tick, dismiss };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createRestorePlanner };
}
