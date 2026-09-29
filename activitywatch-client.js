// activitywatch-client.js — heartbeats and spans to a local ActivityWatch
// server — see .ai/contexts/activitywatch.md

'use strict';

const DEFAULT_BASE_URL = 'http://localhost:5600';
const FIRST_COOLDOWN_MS = 5000;
const MAX_COOLDOWN_MS = 60000;
const REQUEST_TIMEOUT_MS = 2000;

/**
 * A client that assumes the server is absent — see
 * .ai/contexts/activitywatch.md ("Failure").
 *
 * @param {object} deps
 * @param {Function} deps.fetchFn     fetch-compatible
 * @param {string} deps.hostname      sent when a bucket is created
 * @param {() => number} [deps.now]
 * @param {{info: Function}} [deps.log]
 */
function createActivityWatchClient(deps) {
  const fetchFn = deps.fetchFn;
  const now = deps.now || (() => Date.now());
  const log = deps.log || null;

  const readyBuckets = new Set();
  const creating = new Map(); // bucketId -> the create request in flight
  const fresh = new Set();    // buckets this client created and has not yet beaten
  let cooldownMs = 0;
  let nextAttemptAt = 0;
  let reachable = null; // null until the first call resolves it either way

  function sleeping() {
    return nextAttemptAt > now();
  }

  function noteFailure() {
    readyBuckets.clear();
    cooldownMs = cooldownMs ? Math.min(cooldownMs * 2, MAX_COOLDOWN_MS) : FIRST_COOLDOWN_MS;
    nextAttemptAt = now() + cooldownMs;
    if (reachable !== false && log) log.info('[activitywatch] server unreachable, backing off');
    reachable = false;
  }

  function noteSuccess() {
    cooldownMs = 0;
    nextAttemptAt = 0;
    if (reachable === false && log) log.info('[activitywatch] server reachable again');
    reachable = true;
  }

  // The response, or null when none came — see .ai/contexts/activitywatch.md ("Failure")
  async function send(path, init) {
    let response;
    try {
      response = await fetchFn(`${DEFAULT_BASE_URL}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      noteFailure();
      return null;
    }
    noteSuccess();
    return response || null;
  }

  function post(path, body) {
    return send(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  const is2xx = (r) => !!r && r.status >= 200 && r.status < 300;

  // see .ai/contexts/activitywatch.md ("Creating a bucket is idempotent")
  function ensureBucket(bucketId, { client, type }) {
    if (readyBuckets.has(bucketId)) return Promise.resolve(true);
    if (creating.has(bucketId)) return creating.get(bucketId);
    const pending = post(`/api/0/buckets/${encodeURIComponent(bucketId)}`, {
      client, type, hostname: deps.hostname || 'unknown',
    }).then((r) => {
      const ok = is2xx(r) || (!!r && r.status === 304);
      if (ok) readyBuckets.add(bucketId);
      if (is2xx(r)) fresh.add(bucketId);
      return ok;
    }).finally(() => creating.delete(bucketId));
    creating.set(bucketId, pending);
    return pending;
  }

  const bucketPath = (bucketId) => `/api/0/buckets/${encodeURIComponent(bucketId)}`;

  /**
   * One heartbeat — see .ai/contexts/activitywatch.md ("Attention").
   *
   * @returns {Promise<boolean>} whether the server took it
   */
  async function heartbeat(bucketId, bucket, data, pulsetimeSeconds) {
    if (sleeping()) return false;
    if (!(await ensureBucket(bucketId, bucket))) return false;
    // see .ai/contexts/activitywatch.md ("Creating a bucket is idempotent")
    const pulse = fresh.has(bucketId) ? 0 : pulsetimeSeconds;
    const r = await post(`${bucketPath(bucketId)}/heartbeat?pulsetime=${encodeURIComponent(pulse)}`, {
      timestamp: new Date(now()).toISOString(),
      duration: 0,
      data,
    });
    if (is2xx(r)) fresh.delete(bucketId);
    // see .ai/contexts/activitywatch.md ("Failure")
    if (r && r.status === 404) readyBuckets.delete(bucketId);
    return is2xx(r);
  }

  /**
   * Write a span that is still growing, as one event — see
   * .ai/contexts/activitywatch.md ("Checkpoints").
   *
   * @param {{key: string, values: string[]}} match  the `data` field, and every
   *   value it may carry on the server, that identify the span among events
   *   sharing its start time
   * @returns {Promise<boolean>}
   */
  async function upsertSpan(bucketId, bucket, data, startedAtMs, durationSeconds, match) {
    if (sleeping()) return false;
    if (!(await ensureBucket(bucketId, bucket))) return false;

    const start = new Date(startedAtMs).toISOString();
    // see .ai/contexts/activitywatch.md ("Checkpoints")
    const from = new Date(startedAtMs - 1).toISOString();
    const end = new Date(startedAtMs + 1).toISOString();
    const eventsPath = `${bucketPath(bucketId)}/events`;
    const found = await send(`${eventsPath}?start=${encodeURIComponent(from)}&end=${encodeURIComponent(end)}&limit=50`, {});
    if (!found) return false;
    if (found.status === 404) {
      readyBuckets.delete(bucketId);
      return false;
    }
    if (found.status !== 200) return false;
    let stored = null;
    try { stored = await found.json(); } catch { return false; }

    const existing = Array.isArray(stored)
      ? stored.find(e => e && e.data && match.values.includes(e.data[match.key]))
      : null;
    const event = { timestamp: start, duration: Math.max(0, durationSeconds), data };
    if (existing && existing.id !== undefined) event.id = existing.id;
    return is2xx(await post(eventsPath, [event]));
  }

  /**
   * Whether the server answers now, cooldown or not — for the Settings panel.
   *
   * @returns {Promise<boolean>}
   */
  async function probe() {
    return is2xx(await send('/api/0/info', {}));
  }

  return {
    heartbeat,
    upsertSpan,
    probe,
    get reachable() { return reachable; },
    get sleeping() { return sleeping(); },
  };
}

module.exports = { createActivityWatchClient, DEFAULT_BASE_URL, MAX_COOLDOWN_MS };
