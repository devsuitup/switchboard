'use strict';

function createTaskRegistry({ now = () => Date.now(), onChange = () => {}, onRekey = () => {} } = {}) {
  const parents = new Map();
  const redirects = new Map();
  function resolve(id) {
    const seen = new Set();
    while (redirects.has(id) && !seen.has(id)) { seen.add(id); id = redirects.get(id); }
    return id;
  }
  function parent(id) {
    if (!parents.has(id)) parents.set(id, { tasks: new Map(), calls: new Map(), pending: new Map(), seen: new Set(), revision: 0, known: false, backgroundUnknown: false });
    return parents.get(id);
  }
  function changed(id) {
    const p = parent(id);
    p.revision++;
    onChange(snapshot(id));
  }
  function task(id, taskId, kind = 'agent') {
    const p = parent(id);
    if (!p.tasks.has(taskId)) p.tasks.set(taskId, { id: taskId, kind, sources: new Map(), origins: new Set(), terminal: false, at: 0, subagentType: null });
    return p.tasks.get(taskId);
  }
  function list(id) {
    return [...(parents.get(id)?.tasks.values() || [])].filter(t => !t.terminal && t.sources.size);
  }
  function agents(id) { return list(id).filter(t => t.kind === 'agent'); }
  function note(id, taskId, source = 'local-ipc', info = {}) {
    id = resolve(id);
    if (source === 'cli-task' && info.toolUseId && !correlateAgent(id, taskId, info)) return false;
    const t = task(id, taskId, info.kind || 'agent');
    if (t.at <= Math.max(parent(id).diedAt || 0, parent(id).terminalJobAt || 0) &&
        (parent(id).diedAt !== undefined || parent(id).terminalJobAt !== undefined) &&
        !(parent(id).aliveAt > Math.max(parent(id).diedAt || 0, parent(id).terminalJobAt || 0))) return false;
    if (t.terminal) return false;
    t.sources.set(source, now());
    if (info.subagentType) t.subagentType = info.subagentType;
    if (source === 'cli-task') parent(id).known = true;
    changed(id);
    return true;
  }
  function release(id, taskId, source) {
    id = resolve(id);
    const t = parents.get(id)?.tasks.get(taskId);
    if (!t) return;
    if (source === undefined) t.sources.clear();
    else t.sources.delete(source);
    changed(id);
  }
  function end(id, taskId, at = now()) {
    id = resolve(id);
    const t = parents.get(id)?.tasks.get(taskId);
    if (!t || at < t.at) return;
    t.terminal = true;
    t.at = at;
    t.sources.clear();
    changed(id);
  }
  function prune(ttl) {
    for (const [id, p] of parents) for (const t of p.tasks.values()) {
      for (const [source, at] of t.sources) if (source !== 'cli-task' && at < now() - ttl) release(id, t.id, source);
    }
  }
  function oldestFallback() {
    let oldest = Infinity;
    for (const p of parents.values()) for (const t of p.tasks.values()) for (const [source, at] of t.sources) {
      if (source !== 'cli-task' && at < oldest) oldest = at;
    }
    return oldest;
  }
  function primary(id, taskId) { return parents.get(id)?.tasks.get(taskId)?.sources.has('cli-task') || false; }
  function open(id, taskId, kind, at, info = {}) {
    const t = task(id, taskId, kind);
    const p = parent(id);
    const cutoff = Math.max(p.diedAt || 0, p.terminalJobAt || 0);
    if (at <= cutoff) {
      t.terminal = true;
      t.at = cutoff;
      t.sources.clear();
      return t;
    }
    if (t.terminal && at <= t.at) return t;
    t.terminal = false;
    t.kind = kind;
    t.at = Math.max(at, t.at);
    t.subagentType = info.subagentType || t.subagentType;
    if (info.origin) t.origins.add(info.origin);
    t.sources.set('cli-task', at);
    parent(id).known = true;
    return t;
  }
  function notification(entry) {
    if (entry.type !== 'user' || entry.message?.role !== 'user' || typeof entry.message.content !== 'string') return null;
    const text = entry.message.content.trim();
    if (!/^<task-notification>\s*[\s\S]*\s*<\/task-notification>$/.test(text)) return null;
    const field = name => {
      const matches = [...text.matchAll(new RegExp(`<${name}>([^<]+)</${name}>`, 'g'))];
      return matches.length === 1 ? matches[0][1].trim() : null;
    };
    const id = field('task-id');
    const tool = field('tool-use-id');
    const status = field('status');
    const output = field('output-file');
    if (!id || !tool || !['completed', 'failed', 'stopped'].includes(status) || !output ||
        !output.replace(/\\/g, '/').endsWith(`/tasks/${id}.output`)) return null;
    return { id, tool, status };
  }
  function correlateAgent(id, agentId, meta) {
    id = resolve(id);
    const p = parent(id);
    const call = p.calls.get(meta.toolUseId);
    if (!call || typeof agentId !== 'string') return false;
    const old = p.tasks.get(call.id);
    const previousId = call.id;
    call.id = agentId;
    open(id, agentId, 'agent', call.at, { ...call, subagentType: meta.agentType || meta.subagentType });
    if (old?.terminal) end(id, agentId, old.at);
    const terminal = p.pending.get(`notification:${meta.toolUseId}`);
    if (terminal?.id === agentId) {
      end(id, agentId, terminal.at);
      p.pending.delete(`notification:${meta.toolUseId}`);
    }
    if (previousId !== agentId) p.tasks.delete(previousId);
    return true;
  }
  function ingest(id, entry) {
    if (!entry || entry.isSidechain) return;
    const at = Date.parse(entry.timestamp);
    if (!Number.isFinite(at)) return;
    id = resolve(id);
    if (entry.type === 'continued-in' && entry.sessionId === id && /^[0-9a-f-]{36}$/i.test(entry.continuedInSessionId || '')) {
      rekey(id, entry.continuedInSessionId);
      return;
    }
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const n = notification(entry);
    if (!n && !blocks.some(b => b.type === 'tool_use' && b.name === 'Agent') &&
        !blocks.some(b => b.type === 'tool_result' && (parents.get(id)?.calls.has(b.tool_use_id) || entry.toolUseResult?.agentId))) return;
    const p = parent(id);
    const key = entry.uuid || `${entry.type}:${entry.timestamp}:${blocks.map(b => b.id || b.tool_use_id).join(',')}:${n?.id || ''}`;
    if (p.seen.has(key)) return;
    p.seen.add(key);
    if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
      for (const b of blocks) {
        if (b.type !== 'tool_use' || b.name !== 'Agent' || typeof b.id !== 'string') continue;
        if (p.calls.has(b.id)) continue;
        const call = { id: `tool:${b.id}`, at, async: b.input?.run_in_background === true, origin: 'transcript', subagentType: b.input?.subagent_type || null };
        p.calls.set(b.id, call);
        open(id, call.id, 'agent', at, call);
        const deferred = p.pending.get(`result:${b.id}`);
        if (deferred) {
          p.pending.delete(`result:${b.id}`);
          const deferredBlocks = deferred.message.content;
          const deferredKey = deferred.uuid || `${deferred.type}:${deferred.timestamp}:${deferredBlocks.map(b => b.id || b.tool_use_id).join(',')}:`;
          p.seen.delete(deferredKey);
          ingest(id, deferred);
        }
      }
    }
    if (entry.type === 'user' && entry.message?.role === 'user') {
      for (const b of blocks) {
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const call = p.calls.get(b.tool_use_id);
        if (!call) { p.pending.set(`result:${b.tool_use_id}`, entry); continue; }
        const result = entry.toolUseResult;
        if (b.is_error === true) { end(id, call.id, at); continue; }
        if (result?.isAsync === true && result.status === 'async_launched' && typeof result.agentId === 'string') {
          const old = call.id;
          call.id = result.agentId;
          if (old !== call.id) p.tasks.delete(old);
          open(id, call.id, 'agent', call.at, call);
          const n = p.pending.get(`notification:${b.tool_use_id}`);
          if (n && n.id === call.id) { end(id, call.id, n.at); p.pending.delete(`notification:${b.tool_use_id}`); }
        } else if (!call.async && result?.isAsync !== true) {
          if (typeof result?.agentId === 'string') {
            const old = call.id;
            call.id = result.agentId;
            if (old !== call.id) p.tasks.delete(old);
            open(id, call.id, 'agent', call.at, call);
          }
          end(id, call.id, at);
        }
      }
      if (n) {
        const call = p.calls.get(n.tool);
        if (call && call.id === n.id) end(id, n.id, at);
        else p.pending.set(`notification:${n.tool}`, { ...n, at });
      }
    }
    changed(id);
  }
  function applyJob(id, evidence) {
    if (!evidence?.valid || !Number.isFinite(evidence.at)) return;
    id = resolve(id);
    const p = parent(id);
    if (p.jobAt !== undefined && evidence.at <= p.jobAt) return;
    p.jobAt = evidence.at;
    p.known = true;
    p.backgroundUnknown = evidence.inFlight > 0;
    for (const f of evidence.tasks) {
      if (f.doneAt !== null) {
        open(id, f.id, f.kind, f.startedAt, { origin: 'job' });
        end(id, f.id, f.doneAt);
      } else open(id, f.id, f.kind, f.startedAt, { origin: 'job' });
    }
    if (evidence.fanKnown && evidence.inFlight === 0) {
      const reported = new Set(evidence.tasks.map(t => t.id));
      for (const t of p.tasks.values()) {
        if (t.origins.has('job') && !t.origins.has('transcript') && !reported.has(t.id)) end(id, t.id, evidence.at);
      }
    }
    if (evidence.terminal) {
      p.terminalJobAt = evidence.at;
      p.backgroundUnknown = false;
      for (const t of p.tasks.values()) end(id, t.id, evidence.at);
    }
    changed(id);
  }
  function ownerDied(id) {
    id = resolve(id);
    const p = parent(id);
    p.diedAt = now();
    p.known = true;
    p.backgroundUnknown = false;
    for (const t of p.tasks.values()) end(id, t.id);
    changed(id);
  }
  function ownerAlive(id) {
    id = resolve(id);
    const p = parent(id);
    p.aliveAt = now();
    changed(id);
  }
  function snapshot(id) {
    const p = parent(id);
    return { parentSessionId: id, revision: p.revision, known: p.known, ownerDiedAt: p.diedAt, ownerAliveAt: p.aliveAt, terminalJobAt: p.terminalJobAt, backgroundUnknown: p.backgroundUnknown,
      tasks: [...p.tasks.values()].filter(t => t.terminal || t.sources.has('cli-task')).map(t => ({ id: t.id, kind: t.kind, terminal: t.terminal, at: t.at, subagentType: t.subagentType })) };
  }
  function applySnapshot(s) {
    if (!s || typeof s.parentSessionId !== 'string' || !Array.isArray(s.tasks)) return;
    const sourceId = s.parentSessionId;
    const id = resolve(sourceId);
    const p = parent(id);
    p.receivedRevisions ||= new Map();
    if (s.revision <= (p.receivedRevisions.get(sourceId) ?? -1)) return;
    p.receivedRevisions.set(sourceId, s.revision);
    p.known = s.known;
    if (Number.isFinite(s.ownerDiedAt)) p.diedAt = Math.max(p.diedAt || 0, s.ownerDiedAt);
    if (Number.isFinite(s.terminalJobAt)) p.terminalJobAt = Math.max(p.terminalJobAt || 0, s.terminalJobAt);
    if (Number.isFinite(s.ownerAliveAt)) p.aliveAt = Math.max(p.aliveAt || 0, s.ownerAliveAt);
    p.backgroundUnknown = !!s.backgroundUnknown;
    for (const t of p.tasks.values()) {
      if (t.snapshotOwners?.delete(sourceId) && !t.snapshotOwners.size) t.sources.delete('cli-task');
    }
    for (const t of s.tasks) {
      if (t.terminal) { task(id, t.id, t.kind); end(id, t.id, t.at); }
      else {
        const active = open(id, t.id, t.kind, t.at, t);
        active.snapshotOwners ||= new Set();
        active.snapshotOwners.add(sourceId);
      }
    }
    changed(id);
  }
  function rekey(oldId, newId) {
    oldId = resolve(oldId);
    newId = resolve(newId);
    if (oldId === newId) return;
    const old = parents.get(oldId);
    redirects.set(oldId, newId);
    onRekey(oldId, newId);
    if (!old) return;
    const next = parent(newId);
    next.known ||= old.known;
    next.backgroundUnknown ||= old.backgroundUnknown;
    for (const field of ['diedAt', 'aliveAt', 'terminalJobAt', 'jobAt']) {
      if (old[field] !== undefined) next[field] = Math.max(old[field], next[field] || 0);
    }
    for (const [key, value] of old.calls) next.calls.set(key, value);
    for (const [key, value] of old.pending) next.pending.set(key, value);
    for (const key of old.seen) next.seen.add(key);
    if (old.receivedRevisions) {
      next.receivedRevisions ||= new Map();
      for (const [key, value] of old.receivedRevisions) next.receivedRevisions.set(key, Math.max(value, next.receivedRevisions.get(key) || 0));
    }
    for (const [id, t] of old.tasks) {
      const target = next.tasks.get(id);
      if (!target) next.tasks.set(id, t);
      else if (t.terminal && t.at >= target.at) next.tasks.set(id, t);
      else if (!target.terminal) {
        for (const [source, at] of t.sources) target.sources.set(source, Math.max(target.sources.get(source) || 0, at));
        for (const origin of t.origins) target.origins.add(origin);
        if (t.snapshotOwners) {
          target.snapshotOwners ||= new Set();
          for (const source of t.snapshotOwners) target.snapshotOwners.add(source);
        }
      }
    }
    parents.delete(oldId);
    changed(oldId);
    changed(newId);
  }
  function agentMap(id) {
    const map = new Map(agents(id).map(t => [t.id, t.sources]));
    return map.size ? map : undefined;
  }
  const agentView = {
    get: agentMap,
    has: id => !!agentMap(id),
    *[Symbol.iterator]() { for (const id of parents.keys()) { const map = agentMap(id); if (map) yield [id, map]; } },
    *values() { for (const [, map] of this) yield map; },
    get size() { return [...this].length; },
  };
  return { note, release, end, prune, oldestFallback, primary, ingest, notification, correlateAgent, applyJob, ownerDied, ownerAlive, snapshot, applySnapshot, rekey, resolve, agents, list, agentView,
    snapshots: () => [...parents.keys()].map(snapshot),
    known: id => !!parents.get(id)?.known,
    background: id => !!parents.get(id)?.backgroundUnknown || list(id).length > 0 };
}

if (typeof module !== 'undefined') module.exports = { createTaskRegistry };
if (typeof window !== 'undefined') window.taskRegistry = createTaskRegistry({ onChange: snapshot => {
  if (typeof reflectSubagentRunningState === 'function') {
    const ids = new Set([...snapshot.tasks.map(t => t.id), ...window.taskRegistry.agents(snapshot.parentSessionId).map(t => t.id)]);
    if (!ids.size) reflectSubagentRunningState(snapshot.parentSessionId, null);
    for (const id of ids) reflectSubagentRunningState(snapshot.parentSessionId, id);
  }
  if (typeof updateGridSubagentPills === 'function') updateGridSubagentPills(snapshot.parentSessionId);
} });

if (typeof window !== 'undefined' && window.api) {
  if (typeof window.api.onTaskRekey === 'function') window.api.onTaskRekey(({ oldId, newId }) => window.taskRegistry.rekey(oldId, newId));
  if (typeof window.api.onTaskSnapshot === 'function') window.api.onTaskSnapshot(s => window.taskRegistry.applySnapshot(s));
  if (typeof window.api.getTaskSnapshots === 'function') {
    Promise.resolve(window.api.getTaskSnapshots()).then(snapshots => {
      if (Array.isArray(snapshots)) for (const s of snapshots) window.taskRegistry.applySnapshot(s);
    }).catch(() => {});
  }
}
