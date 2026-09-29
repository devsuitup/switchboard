// activitywatch-client.js — heartbeats to a local ActivityWatch server
// — see .ai/contexts/activitywatch.md

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
 * @param {Function} deps.fetchFn            fetch-compatible
 * @param {() => number} [deps.now]
 * @param {string} [deps.baseUrl]
 * @param {{info: Function, warn: Function}} [deps.log]
 */
function createActivityWatchClient(deps) {
  const fetchFn = deps.fetchFn;
  const now = deps.now || (() => Date.now());
  const baseUrl = (deps.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const log = deps.log || null;

  const readyBuckets = new Set();
  const creating = new Map(); // bucketId -> the create request in flight
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

  async function request(path, body) {
    let response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      noteFailure();
      return false;
    }
    // see .ai/contexts/activitywatch.md ("Failure")
    noteSuccess();
    if (!response) return false;
    // 304 is how bucket creation reports "already there" — see
    // .ai/contexts/activitywatch.md ("Creating a bucket is idempotent")
    return response.ok || response.status === 304;
  }

  // Resolves to {status, body} for any answer, or null when the server is absent.
  async function getJson(path) {
    let response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      noteFailure();
      return null;
    }
    noteSuccess();
    if (!response) return null;
    let body = null;
    if (response.ok && typeof response.json === 'function') {
      try { body = await response.json(); } catch { body = null; }
    }
    return { status: response.status, body };
  }

  // see .ai/contexts/activitywatch.md ("Creating a bucket is idempotent")
  function ensureBucket(bucketId, { client, type }) {
    if (readyBuckets.has(bucketId)) return Promise.resolve(true);
    if (creating.has(bucketId)) return creating.get(bucketId);
    const pending = request(`/api/0/buckets/${encodeURIComponent(bucketId)}`, {
      client, type, hostname: deps.hostname || 'unknown',
    }).then((ok) => {
      if (ok) readyBuckets.add(bucketId);
      return ok;
    }).finally(() => creating.delete(bucketId));
    creating.set(bucketId, pending);
    return pending;
  }

  /**
   * One heartbeat — see .ai/contexts/activitywatch.md ("Attention").
   *
   * @returns {Promise<boolean>} whether the server took it
   */
  async function heartbeat(bucketId, bucket, data, pulsetimeSeconds) {
    if (sleeping()) return false;
    if (!(await ensureBucket(bucketId, bucket))) return false;
    const path = `/api/0/buckets/${encodeURIComponent(bucketId)}/heartbeat`
      + `?pulsetime=${encodeURIComponent(pulsetimeSeconds)}`;
    return request(path, {
      timestamp: new Date(now()).toISOString(),
      duration: 0,
      data,
    });
  }

  /**
   * Whether the server answers now, cooldown or not — for the Settings panel.
   *
   * @returns {Promise<boolean>}
   */
  async function probe() {
    try {
      const response = await fetchFn(`${baseUrl}/api/0/info`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      noteSuccess();
      return !!(response && response.ok);
    } catch {
      noteFailure();
      return false;
    }
  }

  /**
   * Write a span that is still growing, as one event — see
   * .ai/contexts/activitywatch.md ("Checkpoints").
   *
   * @param {{key: string, value: string}} match  the `data` field, and the value
   *   it was last written with, that identifies the span among events sharing
   *   its start time
   * @returns {Promise<boolean>}
   */
  async function upsertSpan(bucketId, bucket, data, startedAtMs, durationSeconds, match) {
    if (sleeping()) return false;
    if (!(await ensureBucket(bucketId, bucket))) return false;

    const start = new Date(startedAtMs).toISOString();
    // see .ai/contexts/activitywatch.md ("Checkpoints")
    const from = new Date(startedAtMs - 1).toISOString();
    const end = new Date(startedAtMs + 1).toISOString();
    const eventsPath = `/api/0/buckets/${encodeURIComponent(bucketId)}/events`;
    const found = await getJson(`${eventsPath}?start=${encodeURIComponent(from)}&end=${encodeURIComponent(end)}&limit=50`);
    if (!found) return false;
    if (found.status === 404) {
      // The bucket went away under us; the next call asserts it again.
      readyBuckets.delete(bucketId);
      return false;
    }
    const existing = Array.isArray(found.body)
      ? found.body.find(e => e && e.data && e.data[match.key] === match.value)
      : null;

    const event = { timestamp: start, duration: Math.max(0, durationSeconds), data };
    if (existing && existing.id !== undefined) event.id = existing.id;
    return request(eventsPath, [event]);
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
