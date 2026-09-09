// Dual-mode helper — see .work-files/switchboard/restore-cold-cache-report.md

function planWorkingSetRestore({ savedSet, sessionMap, openSessions, retryDone, sessionOpenedOutsideRestore }) {
  if (!savedSet || savedSet.length === 0) {
    return { action: 'nothing', candidates: [], notYetIndexedCount: 0 };
  }

  const candidates = savedSet.filter(item =>
    sessionMap.has(item.sessionId) && !openSessions.has(item.sessionId)
  );

  if (candidates.length > 0) {
    return { action: 'restore', candidates, notYetIndexedCount: 0 };
  }

  const notYetIndexedCount = savedSet.filter(item => !sessionMap.has(item.sessionId)).length;

  if (notYetIndexedCount > 0 && !retryDone && !sessionOpenedOutsideRestore) {
    return { action: 'defer', candidates: [], notYetIndexedCount };
  }

  return { action: 'nothing', candidates: [], notYetIndexedCount };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { planWorkingSetRestore };
}
