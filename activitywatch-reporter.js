// activitywatch-reporter.js — what the user looked at, and what ran, as two
// ActivityWatch buckets — see .ai/contexts/activitywatch.md

'use strict';

const KEEPALIVE_MS = 30000;
const PULSETIME_SECONDS = 60;

/**
 * @param {object} deps
 * @param {object} deps.client            createActivityWatchClient() result
 * @param {string} deps.hostname
 * @param {() => number} [deps.now]
 * @param {Function} [deps.setIntervalFn]
 * @param {Function} [deps.clearIntervalFn]
 */
function createActivityWatchReporter(deps) {
  const { client } = deps;
  const now = deps.now || (() => Date.now());
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const clearIntervalFn = deps.clearIntervalFn || clearInterval;

  const attention = {
    id: `aw-watcher-switchboard_${deps.hostname}`,
    bucket: { client: 'aw-watcher-switchboard', type: 'app.editor.activity' },
  };
  const running = {
    id: `aw-watcher-switchboard-running_${deps.hostname}`,
    bucket: { client: 'aw-watcher-switchboard', type: 'app.session.running' },
  };

  let enabled = false;
  let focused = null;          // { sessionId, name, project } or null
  let keepalive = null;
  const live = new Map();      // sessionId -> { project, startedAt }
  const names = new Map();     // sessionId -> the last name the renderer showed

  function attentionData(f) {
    return { project: f.project || '', file: f.name || f.sessionId };
  }

  function beat(f) {
    if (!enabled || !f) return Promise.resolve(false);
    return client.heartbeat(attention.id, attention.bucket, attentionData(f), PULSETIME_SECONDS);
  }

  function startKeepalive() {
    if (keepalive || !enabled || !focused) return;
    keepalive = setIntervalFn(() => { beat(focused); }, KEEPALIVE_MS);
  }

  function stopKeepalive() {
    if (keepalive) clearIntervalFn(keepalive);
    keepalive = null;
  }

  // The session on screen, or null — see .ai/contexts/activitywatch.md ("Attention")
  async function focus(next) {
    const f = next && next.sessionId ? { ...next } : null;
    if (f && f.name) names.set(f.sessionId, f.name);

    const same = focused && f && focused.sessionId === f.sessionId
      && focused.name === f.name && focused.project === f.project;
    if (same) return;

    // see .ai/contexts/activitywatch.md ("Attention")
    const outgoing = focused;
    focused = f;
    stopKeepalive();
    if (outgoing) await beat(outgoing);
    if (focused) {
      await beat(focused);
      startKeepalive();
    }
  }

  function sessionStarted({ sessionId, project }, startedAt) {
    if (!sessionId || live.has(sessionId)) return;
    live.set(sessionId, { project: project || '', startedAt: startedAt || now() });
  }

  function runningEvent(sessionId, span, endedAt) {
    const data = { session: sessionId, project: span.project };
    const name = names.get(sessionId);
    if (name) data.name = name;
    return client.insertEvent(running.id, running.bucket, data, span.startedAt, (endedAt - span.startedAt) / 1000);
  }

  // see .ai/contexts/activitywatch.md ("Two buckets, two mechanisms")
  async function sessionEnded(sessionId) {
    const span = live.get(sessionId);
    if (!span) return false;
    live.delete(sessionId);
    const written = enabled ? runningEvent(sessionId, span, now()) : Promise.resolve(false);
    names.delete(sessionId);
    return written;
  }

  // see .ai/contexts/activitywatch.md ("Quitting")
  async function flush() {
    const at = now();
    if (focused) await beat(focused);
    if (!enabled) return;
    await Promise.all(Array.from(live, ([id, span]) => runningEvent(id, span, at)));
  }

  // see .ai/contexts/activitywatch.md ("Running")
  function rekey(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    const span = live.get(fromId);
    if (span && !live.has(toId)) { live.set(toId, span); live.delete(fromId); }
    const name = names.get(fromId);
    if (name !== undefined) { if (!names.has(toId)) names.set(toId, name); names.delete(fromId); }
    if (focused && focused.sessionId === fromId) focused = { ...focused, sessionId: toId };
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) { stopKeepalive(); return; }
    if (focused) { beat(focused); startKeepalive(); }
  }

  function stop() { stopKeepalive(); }

  return {
    focus, sessionStarted, sessionEnded, rekey, flush, setEnabled, stop,
    get enabled() { return enabled; },
    get liveCount() { return live.size; },
    buckets: { attention: attention.id, running: running.id },
  };
}

module.exports = { createActivityWatchReporter, KEEPALIVE_MS, PULSETIME_SECONDS };
