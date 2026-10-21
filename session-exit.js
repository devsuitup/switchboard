'use strict';

const generations = new WeakMap();
let nextGeneration = 1;

function inventory(records, refusal = () => true) {
  const result = { rows: [], counts: { sessions: 0, plain: 0, panels: 0, attached: 0 }, remote: {} };
  const seen = new Set();
  for (const [id, record] of records) {
    if (!record || record.exited || !record.pty || seen.has(record.pty)) continue;
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
    result.rows.push({ id, type, generation, cwd: record.cwd || record.projectPath || '', owner: record.panelFor || null,
      canBackground: type === 'session' && !refusal(record, id) });
    result.counts[type === 'panel' ? 'panels' : type === 'plain' ? 'plain' : 'sessions']++;
  }
  return result;
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
    current = null;
    previous.phase = 'cancelled';
    cancelCheck(previous.window);
    invalidateRenderer(previous.window, previous.id);
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
      if (current?.id === detail?.attempt && current.version === detail?.version && current.phase !== 'committed' && ['checking', 'choosing', 'flushing'].includes(phase)) current.phase = phase;
    },
  };
}

module.exports = { inventory, createExitAttempts };
