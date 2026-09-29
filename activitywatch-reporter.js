// activitywatch-reporter.js — what the user looked at, and what ran, as two
// ActivityWatch buckets — see .ai/contexts/activitywatch.md

'use strict';

const KEEPALIVE_MS = 30000;
const PULSETIME_SECONDS = 60;
const CHECKPOINT_MS = 60000;
// ActivityWatch's own AFK watcher calls a user away after this long.
const IDLE_SECONDS = 180;

/**
 * @param {object} deps
 * @param {object} deps.client            createActivityWatchClient() result
 * @param {string} deps.hostname
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.idleSeconds]   seconds since the last input
 * @param {Function} [deps.setIntervalFn]
 * @param {Function} [deps.clearIntervalFn]
 */
function createActivityWatchReporter(deps) {
  const { client } = deps;
  const now = deps.now || (() => Date.now());
  const idleSeconds = deps.idleSeconds || (() => 0);
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
  let checkpointTimer = null;
  const live = new Map();      // sessionId -> { project, startedAt, writtenAs }
  const names = new Map();     // sessionId -> the last name the renderer showed
  const inflight = new Set();  // running-event writes not yet settled
  const chains = new Map();    // sessionId -> the tail of that session's writes

  function attentionData(f) {
    return { project: f.project || '', file: f.name || f.sessionId };
  }

  function beat(f) {
    if (!enabled || !f) return Promise.resolve(false);
    return client.heartbeat(attention.id, attention.bucket, attentionData(f), PULSETIME_SECONDS);
  }

  // see .ai/contexts/activitywatch.md ("Attention")
  function keepaliveTick() {
    if (idleSeconds() >= IDLE_SECONDS) return;
    beat(focused);
  }

  function startKeepalive() {
    if (keepalive || !enabled || !focused) return;
    keepalive = setIntervalFn(keepaliveTick, KEEPALIVE_MS);
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

    const outgoing = focused;
    focused = f;
    stopKeepalive();
    if (outgoing) await beat(outgoing);
    if (focused) {
      await beat(focused);
      startKeepalive();
    }
  }

  function sessionStarted({ sessionId, project, name }, startedAt) {
    if (!sessionId || live.has(sessionId)) return;
    if (name) names.set(sessionId, name);
    // see .ai/contexts/activitywatch.md ("Running")
    const span = { project: project || '', startedAt: startedAt || now(), writtenAs: sessionId };
    live.set(sessionId, span);
    if (enabled) writeSpan(sessionId, span, span.startedAt);
  }

  // see .ai/contexts/activitywatch.md ("Checkpoints")
  function writeSpan(sessionId, span, endedAt) {
    const data = { session: sessionId, project: span.project };
    const name = names.get(sessionId);
    if (name) data.name = name;
    const duration = (endedAt - span.startedAt) / 1000;

    const write = (chains.get(sessionId) || Promise.resolve())
      .then(() => {
        const values = span.writtenAs === sessionId ? [sessionId] : [span.writtenAs, sessionId];
        return client.upsertSpan(running.id, running.bucket, data, span.startedAt, duration, { key: 'session', values });
      })
      .then((ok) => { if (ok) span.writtenAs = sessionId; return ok; })
      .catch(() => false);
    chains.set(sessionId, write);
    inflight.add(write);
    write.finally(() => {
      inflight.delete(write);
      for (const [id, tail] of chains) if (tail === write) chains.delete(id);
    });
    return write;
  }

  function pruneNames() {
    for (const id of Array.from(names.keys())) {
      if (!live.has(id) && !(focused && focused.sessionId === id)) names.delete(id);
    }
  }

  function checkpointAll() {
    pruneNames();
    if (!enabled) return;
    const at = now();
    for (const [id, span] of live) writeSpan(id, span, at);
  }

  function startCheckpoints() {
    if (checkpointTimer || !enabled) return;
    checkpointTimer = setIntervalFn(checkpointAll, CHECKPOINT_MS);
  }

  function stopCheckpoints() {
    if (checkpointTimer) clearIntervalFn(checkpointTimer);
    checkpointTimer = null;
  }

  // see .ai/contexts/activitywatch.md ("Two buckets, two mechanisms")
  async function sessionEnded(sessionId) {
    const span = live.get(sessionId);
    if (!span) return false;
    live.delete(sessionId);
    const written = enabled ? writeSpan(sessionId, span, now()) : Promise.resolve(false);
    names.delete(sessionId);
    return written;
  }

  // see .ai/contexts/activitywatch.md ("Quitting")
  async function flush() {
    const at = now();
    const closing = focused ? beat(focused) : Promise.resolve(false);
    if (enabled) {
      for (const [id, span] of Array.from(live)) {
        live.delete(id);
        writeSpan(id, span, at);
        names.delete(id);
      }
    }
    await Promise.all([closing, ...Array.from(inflight)]);
  }

  // see .ai/contexts/activitywatch.md ("Running")
  function rekey(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    const span = live.get(fromId);
    if (span && !live.has(toId)) { live.set(toId, span); live.delete(fromId); }
    const chain = chains.get(fromId);
    if (chain && !chains.has(toId)) { chains.set(toId, chain); chains.delete(fromId); }
    const name = names.get(fromId);
    if (name !== undefined) { if (!names.has(toId)) names.set(toId, name); names.delete(fromId); }
    if (focused && focused.sessionId === fromId) focused = { ...focused, sessionId: toId };
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) { stopKeepalive(); stopCheckpoints(); return; }
    if (focused) { beat(focused); startKeepalive(); }
    checkpointAll(); // see .ai/contexts/activitywatch.md ("Running")
    startCheckpoints();
  }

  function stop() { stopKeepalive(); stopCheckpoints(); }

  return {
    focus, sessionStarted, sessionEnded, rekey, flush, setEnabled, stop,
    get enabled() { return enabled; },
    get hasPendingWork() { return enabled && (live.size > 0 || inflight.size > 0); },
    buckets: { attention: attention.id, running: running.id },
  };
}

module.exports = { createActivityWatchReporter, KEEPALIVE_MS, PULSETIME_SECONDS, CHECKPOINT_MS, IDLE_SECONDS };
