'use strict';

function createTaskRegistry({ now = () => Date.now(), onChange = () => {}, onRekey = () => {}, maxEntries = 2048 } = {}) {
  const parents = new Map();
  const redirects = new Map();
  function bound(collection) {
    while (collection.size > maxEntries) collection.delete(collection.keys().next().value);
  }
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
  function list(id, jobId) {
    if (jobId === undefined && parents.get(id)?.jobs?.size === 1) jobId = parents.get(id).jobs.keys().next().value;
    const cutoff = parents.get(id)?.jobTerminalAts?.get(jobId) ?? -Infinity;
    const tasks = [...(parents.get(id)?.tasks.values() || [])].filter(t => !t.terminal && t.sources.size && t.at > cutoff);
    const evidence = parents.get(id)?.jobs?.get(jobId);
    if (evidence?.valid && !evidence.terminal) for (const t of evidence.tasks || []) {
      if (t.doneAt === null) tasks.push({ ...t, terminal: false, sources: new Map([['cli-task', evidence.at]]) });
    }
    return tasks;
  }
  function agents(id, jobId) { return list(id, jobId).filter(t => t.kind === 'agent'); }
  function runningAgentCount(ids) {
    const active = new Set();
    for (const id of ids) {
      for (const t of agents(resolve(id))) {
        if (t.sources.has('cli-task')) active.add(t.id);
      }
    }
    return active.size;
  }
  function note(id, taskId, source = 'local-ipc', info = {}) {
    id = resolve(id);
    const previousSnapshot = source === 'cli-task' && info.toolUseId ? JSON.stringify(snapshot(id)) : null;
    const previous = parents.get(id)?.tasks.get(taskId);
    const hadSource = previous?.sources.has(source);
    const previousType = previous?.subagentType;
    if (source === 'cli-task' && info.toolUseId && !correlateAgent(id, taskId, info)) return false;
    const t = task(id, taskId, info.kind || 'agent');
    if (t.at <= Math.max(parent(id).diedAt || 0, parent(id).terminalJobAt || 0) &&
        (parent(id).diedAt !== undefined || parent(id).terminalJobAt !== undefined) &&
        !(parent(id).aliveAt > Math.max(parent(id).diedAt || 0, parent(id).terminalJobAt || 0))) return false;
    if (t.terminal) return false;
    t.sources.set(source, now());
    if (info.subagentType) t.subagentType = info.subagentType;
    if (source === 'cli-task') parent(id).known = true;
    if (!hadSource || previousType !== t.subagentType ||
        (previousSnapshot !== null && previousSnapshot !== JSON.stringify(snapshot(id)))) changed(id);
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
  function end(id, taskId, at = now(), notify = true) {
    id = resolve(id);
    const t = parents.get(id)?.tasks.get(taskId);
    if (!t || at < t.at || (t.terminal && at === t.at)) return;
    t.terminal = true;
    t.at = at;
    t.sources.clear();
    delete t.reopenGroup;
    if (notify) changed(id);
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
    let content;
    if (entry.type === 'user' && entry.message?.role === 'user' && entry.origin?.kind === 'task-notification') content = entry.message.content;
    else if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command' &&
        ((entry.attachment.origin === undefined && entry.attachment.commandMode === 'task-notification') ||
        entry.attachment.origin?.kind === 'task-notification')) content = entry.attachment.prompt;
    if (typeof content !== 'string') return null;
    const text = content.trim();
    if (!/^<task-notification>\s*[\s\S]*\s*<\/task-notification>$/.test(text)) return null;
    const field = name => {
      const matches = [...text.matchAll(new RegExp(`<${name}>([^<]+)</${name}>`, 'g'))];
      return matches.length === 1 ? matches[0][1].trim() : null;
    };
    const id = field('task-id');
    const ids = [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(match => match[1].trim());
    const tool = field('tool-use-id');
    const status = field('status');
    const output = field('output-file');
    if ((text.includes('<tool-use-id>') && !tool) || (text.includes('<output-file>') && !output)) return null;
    if (ids.length > 1 && ids.every(Boolean) && status === 'stopped' && !tool && !output) return { ids, tool, status };
    if (!id || !['completed', 'failed', 'stopped', 'killed'].includes(status) ||
        (!output && status !== 'stopped') || (output && !output.replace(/\\/g, '/').endsWith(`/tasks/${id}.output`))) return null;
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
  function backgroundShell(entry, blocks) {
    const taskId = entry.toolUseResult?.backgroundTaskId;
    const results = blocks.filter(b => b.type === 'tool_result');
    if (entry.type !== 'user' || entry.message?.role !== 'user' || typeof taskId !== 'string' || !/^[a-z][a-z0-9]+$/.test(taskId) ||
        entry.toolUseResult?.agentId !== undefined || entry.toolUseResult?.backgroundEndsWithFinalResponse === true || results.length !== 1 || typeof results[0].tool_use_id !== 'string' || results[0].is_error === true) return null;
    return { id: taskId, tool: results[0].tool_use_id,
      backgrounded: entry.toolUseResult.backgroundedByUser === true || Number.isFinite(entry.toolUseResult.timedOutAfterMs) };
  }
  function shellStop(id, b) {
    const target = b.input?.task_id ?? b.input?.shell_id;
    return b.type === 'tool_use' && (b.name === 'TaskStop' || b.name === 'KillShell') && typeof b.id === 'string' &&
      typeof target === 'string' && parents.get(id)?.tasks.get(target)?.kind === 'bash' ? target : null;
  }
  function ingest(id, entry) {
    if (!entry || entry.isSidechain) return;
    const at = Date.parse(entry.timestamp);
    if (!Number.isFinite(at)) return;
    id = resolve(id);
    if (entry.type === 'continued-in' && entry.sessionId === id && /^[0-9a-f-]{36}$/i.test(entry.continuedInSessionId || '')) {
      rekey(id, entry.continuedInSessionId, { continued: true });
      return;
    }
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const n = notification(entry);
    const shell = backgroundShell(entry, blocks);
    if (!n && !shell && !blocks.some(b => shellStop(id, b)) && !blocks.some(b => b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Bash' || b.name === 'SendMessage' && parents.get(id)?.tasks.get(b.input?.to)?.kind === 'agent')) &&
        !blocks.some(b => b.type === 'tool_result' && (parents.get(id)?.calls.has(b.tool_use_id) || entry.toolUseResult?.agentId))) return;
    const p = parent(id);
    const key = entry.uuid || `${entry.type}:${entry.timestamp}:${blocks.map(b => b.id || b.tool_use_id).join(',')}:${n?.id || n?.ids?.join(',') || ''}`;
    if (p.seen.has(key)) return;
    p.seen.add(key);
    bound(p.seen);
    if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
      for (const b of blocks) {
        const stopped = shellStop(id, b);
        if (stopped) { if (!p.calls.has(b.id)) p.calls.set(b.id, { id: stopped, at, stop: true }); continue; }
        if (b.type === 'tool_use' && b.name === 'SendMessage' && typeof b.id === 'string' && p.tasks.get(b.input?.to)?.kind === 'agent') {
          const previous = p.tasks.get(b.input.to);
          const reopenGroup = previous.terminal ? { pending: new Set(), succeeded: false, at } :
            previous.reopenGroup?.at === previous.at ? previous.reopenGroup : undefined;
          const call = { id: b.input.to, at, sendMessage: true, reopenGroup };
          const active = open(id, b.input.to, 'agent', at, { origin: 'transcript' });
          if (!active.terminal && active.at === at) {
            if (reopenGroup) { reopenGroup.pending.add(b.id); reopenGroup.at = at; }
            active.reopenGroup = reopenGroup;
            p.calls.set(b.id, call);
          }
          continue;
        }
        if (b.type !== 'tool_use' || (b.name !== 'Agent' && b.name !== 'Bash') || typeof b.id !== 'string') continue;
        if (p.calls.has(b.id)) continue;
        const call = { id: `tool:${b.id}`, at, async: b.input?.run_in_background === true, origin: 'transcript', subagentType: b.input?.subagent_type || null };
        if (b.name === 'Bash') p.calls.set(b.id, { ...call, bash: true });
        else { p.calls.set(b.id, call); open(id, call.id, 'agent', at, call); }
        bound(p.pending);
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
        if (shell && b.tool_use_id === shell.tool && (!call || call.bash)) {
          if (!call?.bash) { p.pending.set(`result:${b.tool_use_id}`, entry); bound(p.pending); continue; }
          p.pending.delete(`result:${b.tool_use_id}`);
          if (!call?.async && !shell.backgrounded) continue;
          p.calls.set(b.tool_use_id, { id: shell.id, at, shell: true });
          if (at > (p.ownerStartedAt ?? -Infinity)) open(id, shell.id, 'bash', at, { origin: 'transcript' });
          const early = p.pending.get(`notification:${b.tool_use_id}`);
          if (early && early.id === shell.id) { end(id, shell.id, early.at); p.pending.delete(`notification:${b.tool_use_id}`); }
          continue;
        }
        if (!call) { p.pending.set(`result:${b.tool_use_id}`, entry); bound(p.pending); continue; }
        if (call.bash) { p.pending.delete(`result:${b.tool_use_id}`); continue; }
        if (call.shell) continue;
        if (call.stop) { if (b.is_error !== true) end(id, call.id, at); continue; }
        if (call.sendMessage) {
          const active = p.tasks.get(call.id);
          const group = call.reopenGroup;
          if (group && active?.reopenGroup === group && active.at === group.at) {
            group.pending.delete(b.tool_use_id);
            group.succeeded ||= b.is_error !== true;
            group.finishedAt = Math.max(group.finishedAt || 0, at);
            if (!group.pending.size) {
              delete active.reopenGroup;
              if (!group.succeeded) end(id, call.id, Math.max(group.at, group.finishedAt));
            }
          }
          continue;
        }
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
    }
    if (n) {
      if (n.ids) {
        for (const taskId of n.ids) if (['agent', 'bash'].includes(p.tasks.get(taskId)?.kind)) end(id, taskId, at);
      } else {
        const call = p.calls.get(n.tool);
        if ((n.tool && call && call.id === n.id) || (!n.tool && ['agent', 'bash'].includes(p.tasks.get(n.id)?.kind))) end(id, n.id, at);
        else if (n.tool) { p.pending.set(`notification:${n.tool}`, { ...n, at }); bound(p.pending); }
      }
    }
    changed(id);
  }
  function applyJob(id, evidence, { jobId } = {}) {
    if (jobId) {
      id = resolve(id);
      const p = parent(id);
      p.jobs ||= new Map();
      p.jobWatermarks ||= new Map();
      const previous = p.jobs.get(jobId);
      if (!evidence) {
        if (!p.jobs.delete(jobId)) return;
        p.jobWatermarks.delete(jobId);
        p.jobTerminalAts?.delete(jobId);
        changed(id);
        return;
      }
      if (evidence?.valid && (!Number.isFinite(evidence.at) || evidence.at < (p.jobWatermarks.get(jobId) ?? -Infinity))) return;
      if (evidence?.valid) {
        p.jobWatermarks.set(jobId, evidence.at);
        p.known = true;
      }
      if (evidence?.valid && evidence.terminal) {
        p.jobTerminalAts ||= new Map();
        p.jobTerminalAts.set(jobId, evidence.at);
        for (const t of p.tasks.values()) end(id, t.id, evidence.at, false);
      }
      if (JSON.stringify(previous) === JSON.stringify(evidence)) return;
      p.jobs.set(jobId, evidence);
      if (JSON.stringify({ ...previous, at: null }) !== JSON.stringify({ ...evidence, at: null })) changed(id);
      return;
    }
    if (!evidence?.valid || !Number.isFinite(evidence.at)) return;
    id = resolve(id);
    const p = parent(id);
    if (p.jobAt !== undefined && evidence.at <= p.jobAt) return;
    const previous = JSON.stringify(snapshot(id));
    p.jobAt = evidence.at;
    p.known = true;
    p.backgroundUnknown = evidence.inFlight > 0;
    for (const f of evidence.tasks) {
      if (f.doneAt !== null) {
        open(id, f.id, f.kind, f.startedAt, { origin: 'job' });
        end(id, f.id, f.doneAt, false);
      } else open(id, f.id, f.kind, f.startedAt, { origin: 'job' });
    }
    if (evidence.fanKnown && evidence.inFlight === 0) {
      const reported = new Set(evidence.tasks.map(t => t.id));
      for (const t of p.tasks.values()) {
        if (t.origins.has('job') && !t.origins.has('transcript') && !reported.has(t.id)) end(id, t.id, evidence.at, false);
      }
    }
    if (evidence.terminal) {
      p.terminalJobAt = evidence.at;
      p.backgroundUnknown = false;
      for (const t of p.tasks.values()) end(id, t.id, evidence.at, false);
    }
    if (previous !== JSON.stringify(snapshot(id))) changed(id);
  }
  function ownerDied(id) {
    id = resolve(id);
    const p = parent(id);
    p.diedAt = now();
    p.known = true;
    p.backgroundUnknown = false;
    for (const t of p.tasks.values()) end(id, t.id);
    p.pending.clear();
    p.seen.clear();
    changed(id);
  }
  function ownerAlive(id, { startedAt } = {}) {
    id = resolve(id);
    const p = parent(id);
    if (Number.isFinite(startedAt) && startedAt > (p.ownerStartedAt ?? -Infinity)) {
      p.ownerStartedAt = startedAt;
      let ended = false;
      for (const t of p.tasks.values()) {
        if (t.kind === 'bash' && t.origins.has('transcript') && !t.terminal && t.at < startedAt) { end(id, t.id, startedAt, false); ended = true; }
      }
      if (ended) changed(id);
    }
    if (p.aliveAt !== undefined && (p.diedAt === undefined || p.aliveAt > p.diedAt)) return;
    p.aliveAt = now();
    changed(id);
  }
  function snapshot(id) {
    const p = parent(id);
    return { parentSessionId: id, revision: p.revision, known: known(id), ownerDiedAt: p.diedAt, ownerAliveAt: p.aliveAt, terminalJobAt: p.terminalJobAt, backgroundUnknown: p.backgroundUnknown, jobs: [...(p.jobs || [])], jobTerminalAts: [...(p.jobTerminalAts || [])],
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
    const jobIds = new Set((s.jobs || []).map(([jobId]) => jobId));
    for (const jobId of p.snapshotJobIds || []) if (!jobIds.has(jobId)) applyJob(id, null, { jobId });
    p.snapshotJobIds = jobIds;
    for (const [jobId, evidence] of s.jobs || []) applyJob(id, evidence, { jobId });
    for (const [jobId, at] of s.jobTerminalAts || []) {
      p.jobTerminalAts ||= new Map();
      p.jobTerminalAts.set(jobId, Math.max(at, p.jobTerminalAts.get(jobId) ?? -Infinity));
    }
    p.known = s.known;
    if (Number.isFinite(s.ownerDiedAt)) p.diedAt = Math.max(p.diedAt || 0, s.ownerDiedAt);
    if (Number.isFinite(s.terminalJobAt)) p.terminalJobAt = Math.max(p.terminalJobAt || 0, s.terminalJobAt);
    if (Number.isFinite(s.ownerAliveAt)) p.aliveAt = Math.max(p.aliveAt || 0, s.ownerAliveAt);
    p.backgroundUnknown = !!s.backgroundUnknown;
    for (const t of p.tasks.values()) {
      if (t.snapshotOwners?.delete(sourceId) && !t.snapshotOwners.size) t.sources.delete('cli-task');
    }
    for (const t of s.tasks) {
      if (t.terminal) { task(id, t.id, t.kind); end(id, t.id, t.at, false); }
      else {
        const active = open(id, t.id, t.kind, t.at, t);
        active.snapshotOwners ||= new Set();
        active.snapshotOwners.add(sourceId);
      }
    }
    changed(id);
  }
  function rekey(oldId, newId, { continued = false } = {}) {
    oldId = resolve(oldId);
    newId = resolve(newId);
    if (oldId === newId) return;
    const old = parents.get(oldId);
    if (continued) { redirects.set(oldId, newId); bound(redirects); }
    onRekey(oldId, newId, continued);
    if (!old) return;
    const next = parent(newId);
    if (old.jobs) {
      next.jobs ||= new Map();
      next.jobWatermarks ||= new Map();
      for (const [jobId, evidence] of old.jobs) {
        if (!next.jobs.has(jobId) || (evidence?.at ?? -Infinity) > (next.jobs.get(jobId)?.at ?? -Infinity)) next.jobs.set(jobId, evidence);
        next.jobWatermarks.set(jobId, Math.max(next.jobWatermarks.get(jobId) ?? -Infinity, old.jobWatermarks?.get(jobId) ?? -Infinity));
      }
    }
    if (old.jobTerminalAts) {
      next.jobTerminalAts ||= new Map();
      for (const [jobId, at] of old.jobTerminalAts) next.jobTerminalAts.set(jobId, Math.max(at, next.jobTerminalAts.get(jobId) ?? -Infinity));
    }
    next.known ||= old.known;
    next.backgroundUnknown ||= old.backgroundUnknown;
    for (const field of ['diedAt', 'aliveAt', 'terminalJobAt', 'jobAt']) {
      if (old[field] !== undefined) next[field] = Math.max(old[field], next[field] || 0);
    }
    for (const [key, value] of old.calls) next.calls.set(key, value);
    for (const [key, value] of old.pending) next.pending.set(key, value);
    for (const key of old.seen) next.seen.add(key);
    bound(next.pending);
    bound(next.seen);
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
  function known(id) {
    const p = parents.get(id);
    return !!p?.known || [...(p?.jobs?.values() || [])].some(evidence => evidence?.valid);
  }
  function background(id, jobId) {
    const p = parents.get(id);
    if (jobId === undefined && p?.jobs?.size === 1) jobId = p.jobs.keys().next().value;
    const evidence = p?.jobs?.get(jobId);
    return !!p?.backgroundUnknown || !!(evidence?.valid && !evidence.terminal && evidence.inFlight > 0) || list(id, jobId).length > 0;
  }
  return { note, release, end, prune, oldestFallback, primary, ingest, notification, correlateAgent, applyJob, ownerDied, ownerAlive, snapshot, applySnapshot, rekey, resolve, agents, runningAgentCount, list, agentView,
    snapshots: () => [...parents.keys()].map(snapshot),
    known, background };
}

if (typeof module !== 'undefined') module.exports = { createTaskRegistry };
if (typeof window !== 'undefined') window.taskRegistry = createTaskRegistry({ onChange: snapshot => {
  if (typeof reflectSubagentRunningState === 'function') reflectSubagentRunningState(snapshot.parentSessionId, null);
  if (typeof updateGridSubagentPills === 'function') updateGridSubagentPills(snapshot.parentSessionId);
  if (typeof agentsViewActive !== 'undefined' && agentsViewActive && typeof renderAgentsView === 'function') renderAgentsView();
} });

if (typeof window !== 'undefined' && window.api) {
  if (typeof window.api.onTaskRekey === 'function') window.api.onTaskRekey(({ oldId, newId, continued }) => window.taskRegistry.rekey(oldId, newId, { continued }));
  if (typeof window.api.onTaskSnapshot === 'function') window.api.onTaskSnapshot(s => {
    if (typeof applyHeadTurnSnapshot === 'function') applyHeadTurnSnapshot(s?.headTurn);
    window.taskRegistry.applySnapshot(s);
  });
  if (typeof window.api.getTaskSnapshots === 'function') {
    Promise.resolve(window.api.getTaskSnapshots()).then(snapshots => {
      if (Array.isArray(snapshots)) for (const s of snapshots) {
        if (typeof applyHeadTurnSnapshot === 'function') applyHeadTurnSnapshot(s?.headTurn);
        window.taskRegistry.applySnapshot(s);
      }
    }).catch(() => {});
  }
}
