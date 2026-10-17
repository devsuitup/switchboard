// Renderer half of the opt-in activity trace. The renderer never writes: it
// forwards to the main process, the single writer.
// See docs/activity-trace.md and .ai/contexts/ipc-bridge.md "Activity trace".
(function initActivityTrace() {
  const api = window.api;
  const wired = !!(api && typeof api.traceActivity === 'function');
  window.ATRACE = wired && !!api.activityTraceEnabled;
  window.atrace = wired
    ? function atrace(cat, sid, fields) {
      try { api.traceActivity(cat, sid === undefined ? null : sid, fields || null); } catch {}
    }
    : function atraceDisabled() {};
  // see docs/activity-trace.md ("Renderer long frames")
  let frameObserver = null;
  function syncFrameObserver() {
    if (!window.ATRACE) {
      frameObserver?.disconnect();
      frameObserver = null;
      return;
    }
    if (frameObserver) return;
    const Observer = window.PerformanceObserver;
    const supported = Observer?.supportedEntryTypes || [];
    const type = supported.includes('long-animation-frame') ? 'long-animation-frame'
      : supported.includes('longtask') ? 'longtask' : null;
    if (!type) return;
    const observer = new Observer(list => {
      if (!window.ATRACE || frameObserver !== observer) return;
      for (const entry of list.getEntries()) {
        if (entry.duration < 50) continue;
        window.atrace('renderer.longframe', null, { durationMs: entry.duration,
          blockingMs: type === 'long-animation-frame' ? entry.blockingDuration : Math.max(0, entry.duration - 50) });
      }
    });
    frameObserver = observer;
    observer.observe({ type });
  }
  syncFrameObserver();
  if (wired && typeof api.onActivityTraceState === 'function') {
    api.onActivityTraceState((enabled) => { window.ATRACE = !!enabled; syncFrameObserver(); });
  }
})();
