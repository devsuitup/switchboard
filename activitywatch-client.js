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

  async function ensureBucket(bucketId, { client, type }) {
    if (readyBuckets.has(bucketId)) return true;
    const ok = await request(`/api/0/buckets/${encodeURIComponent(bucketId)}`, {
      client, type, hostname: deps.hostname || 'unknown',
    });
    if (ok) readyBuckets.add(bucketId);
    return ok;
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
   * One event with a span the caller measured — see
   * .ai/contexts/activitywatch.md ("Two buckets, two mechanisms").
   *
   * @param {number} startedAtMs
   * @param {number} durationSeconds
   * @returns {Promise<boolean>}
   */
  async function insertEvent(bucketId, bucket, data, startedAtMs, durationSeconds) {
    if (sleeping()) return false;
    if (!(await ensureBucket(bucketId, bucket))) return false;
    return request(`/api/0/buckets/${encodeURIComponent(bucketId)}/events`, [{
      timestamp: new Date(startedAtMs).toISOString(),
      duration: Math.max(0, durationSeconds),
      data,
    }]);
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

  return {
    heartbeat,
    insertEvent,
    probe,
    get reachable() { return reachable; },
    get sleeping() { return sleeping(); },
  };
}

module.exports = { createActivityWatchClient, DEFAULT_BASE_URL, MAX_COOLDOWN_MS };
