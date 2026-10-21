'use strict';

const generations = new WeakMap();
let nextGeneration = 1;
const EXIT_BUSY_WAIT_MS = 10 * 60 * 1000;

function inventory(records, refusal = () => true, status = record => record.status) {
  const result = { rows: [], counts: { sessions: 0, plain: 0, panels: 0, attached: 0 }, remote: {} };
  const seen = new Set();
  for (const [id, record] of records) {
    if (!record || record.exited || record.backgrounded || !record.pty || seen.has(record.pty)) continue;
    seen.add(record.pty);
    if (record.kind === 'remote-attach') {
      const alias = record.remoteAlias || record.host || 'remote';
      result.remote[alias] = (result.remote[alias] || 0) + 1;
      continue;
    }
    if (record.kind !== 'local-pty') continue;
    if (record.isAttach) { result.counts.attached++; continue; }
    const type = record.panelFor ? 'panel' : record.isPlainTerminal ? 'plain' : 'session';
    if (!generations.has(record)) generations.set(record, nextGeneration++);
    if (!generations.has(record.pty)) generations.set(record.pty, nextGeneration++);
    const generation = `${generations.get(record)}:${generations.get(record.pty)}:${id}`;
    const row = { id, type, generation, cwd: record.cwd || record.projectPath || '', owner: record.panelFor || null,
      canBackground: false };
    if (type === 'session') {
      row.reason = refusal(record, id) || null;
      row.canBackground = !row.reason;
      row.background = !row.reason ? 'ready' : status(record, id) === 'busy' && !refusal(record, id, 'idle') ? 'busy' : 'refused';
    }
    result.rows.push(row);
    result.counts[type === 'panel' ? 'panels' : type === 'plain' ? 'plain' : 'sessions']++;
  }
  return result;
}

async function runExitHandoffs(ids, { send, status, waitForChange, now = Date.now, busyBoundMs = EXIT_BUSY_WAIT_MS, signal, progress = () => {} }) {
  const rows = ids.map(id => ({ id, started: false, result: null }));
  let cancelled = false;
  let external = false;
  let wake;
  let finishExternal;
  const interrupted = new Promise(resolve => { wake = resolve; });
  const externalExit = new Promise(resolve => { finishExternal = resolve; });
  const abort = () => {
    cancelled = true;
    wake();
    if (signal?.reason?.external === true) {
      external = true;
      finishExternal(rows.map(row => row.result || { id: row.id, ok: false, code: row.started ? 'pending' : 'cancelled' }));
    }
  };
  signal?.addEventListener('abort', abort);
  if (signal?.aborted) abort();
  const settle = (row, result) => {
    row.result = { ...result, id: row.id };
    if (!row.started && !result.ok) { cancelled = true; wake(); }
    if (!external) progress({ id: row.id, phase: 'done', result: row.result });
    return row.result;
  };
  const run = async row => {
    const deadline = now() + busyBoundMs;
    let waited = false;
    try {
      for (;;) {
        if (cancelled) return settle(row, { ok: false, code: 'cancelled' });
        const state = status(row.id);
        if (waited && now() >= deadline) return settle(row, { ok: false, code: 'busy-timeout' });
        if (state === 'waiting') return settle(row, { ok: false, code: 'needs-answer' });
        if (state === 'shell') return settle(row, { ok: false, code: 'shell' });
        if (!state) return settle(row, { ok: false, code: 'refused' });
        if (state !== 'busy') break;
        if (!waited) progress({ id: row.id, phase: 'waiting' });
        waited = true;
        if (now() >= deadline) return settle(row, { ok: false, code: 'busy-timeout' });
        await Promise.race([waitForChange(Math.min(1000, deadline - now())), interrupted]);
      }
      if (cancelled) return settle(row, { ok: false, code: 'cancelled' });
      progress({ id: row.id, phase: 'moving' });
      row.started = true;
      const result = await send(row.id);
      if (result?.code === 'refused' && result.ok === false) row.started = false;
      return settle(row, result && typeof result.ok === 'boolean' ? result : { ok: false, code: 'failed' });
    } catch (error) {
      return settle(row, { ok: false, code: 'failed', error: error.message });
    }
  };
  try { return await Promise.race([Promise.all(rows.map(run)), externalExit]); }
  finally { signal?.removeEventListener('abort', abort); }
}

function createExitAttempts({ snapshot, check, cancelCheck, invalidateRenderer }) {
  let current = null;
  let nextId = 1;
  const rank = { close: 0, quit: 1, update: 2 };
  const read = () => {
    try { return snapshot(); }
    catch { return { rows: [], counts: { sessions: 0, plain: 0, panels: 0, attached: 0 }, remote: {}, unknown: true }; }
  };
  function invalidate(action) {
    if (!current || (action && current.action !== action)) return false;
    const previous = current;
    const wasCommitted = previous.phase === 'committed';
    current = null;
    previous.phase = 'cancelled';
    cancelCheck(previous.window);
    invalidateRenderer(previous.window, previous.id, wasCommitted);
    return true;
  }
  function request(win, action, external = false) {
    if (current && current.window !== win) invalidate();
    if (current) {
      if (current.phase === 'committed') return current.promise;
      if ((external && !current.external) || (!current.external && rank[action] > rank[current.action])) {
        current.action = action;
        current.external = external;
        current.version++;
        current.snapshot = read();
        current.checkPromise = check(win, action === 'close' ? 'close' : 'quit', {
          attempt: current.id, action, version: current.version, external, snapshot: current.snapshot,
        });
      }
      return current.promise;
    }
    const attempt = { id: nextId++, window: win, action, external, version: 1, phase: 'checking' };
    current = attempt;
    attempt.promise = run(attempt);
    return attempt.promise;
  }
  async function run(attempt) {
    while (current === attempt) {
      attempt.snapshot = read();
      const detail = { attempt: attempt.id, action: attempt.action, version: attempt.version, external: attempt.external, snapshot: attempt.snapshot };
      let waiting = check(attempt.window, attempt.action === 'close' ? 'close' : 'quit', detail);
      attempt.checkPromise = waiting;
      let result = await waiting;
      while (current === attempt && attempt.checkPromise !== waiting) {
        waiting = attempt.checkPromise;
        result = await waiting;
      }
      if (current !== attempt) return { proceed: false };
      if (!result.proceed) { invalidate(); return result; }
      const fresh = read();
      const consent = new Set(attempt.snapshot.rows.map(row => row.generation));
      if (!result.ended && !attempt.external && ((fresh.unknown && !attempt.snapshot.unknown) || fresh.rows.some(row => !consent.has(row.generation)))) {
        attempt.version++;
        invalidateRenderer(attempt.window, attempt.id);
        continue;
      }
      attempt.phase = 'committed';
      return { ...result, token: attempt.id, action: attempt.action };
    }
    return { proceed: false };
  }
  return { request, invalidate, token: win => current?.window === win && current.phase === 'committed' ? current.id : null,
    committed: token => token != null && current?.phase === 'committed' && current.id === token,
    launchAllowed: () => current?.phase !== 'committed', current: () => current,
    refresh: (win, detail) => {
      if (current?.window !== win || current.id !== detail?.attempt || current.version !== detail?.version || current.phase === 'committed') return null;
      current.snapshot = read();
      return current.snapshot;
    },
    phase: (detail, phase) => {
      if (current?.id === detail?.attempt && current.version === detail?.version && current.phase !== 'committed' && ['checking', 'choosing', 'flushing', 'backgrounding'].includes(phase)) current.phase = phase;
    },
  };
}

module.exports = { inventory, createExitAttempts, runExitHandoffs, EXIT_BUSY_WAIT_MS };
