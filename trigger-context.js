// trigger-context.js — see .ai/contexts/trigger-watcher.md
'use strict';

const path = require('path');
const fs = require('fs');
const cliSessionState = require('./cli-session-state');
const { normalizeSessionId, isClearCommand } = require('./session-transitions');
const { scanContinuationIndex, resolveContinuationsSync, validId } = require('./session-continuations');
const { classifyUserText } = require('./read-session-file');

const { createTranscriptTurnReader } = require('./transcript-turn');

// Local session handle — see .ai/contexts/trigger-watcher.md, "Session handle".
function createLocalSessionHandle(ptyProcess) {
  return {
    write(data) { ptyProcess.write(data); },
    isAlive() {
      if (!ptyProcess || typeof ptyProcess.pid !== 'number') return false;
      try {
        process.kill(ptyProcess.pid, 0);
        return true;
      } catch (e) {
        return e.code === 'EPERM';
      }
    },
  };
}

/**
 * Build the `ctx` object trigger-watcher's `start(ctx)` expects.
 *
 * @param {object} deps
 * @param {Map} deps.activeSessions
 * @param {object} deps.log  electron-log compatible logger
 * @param {function} [deps.isPtyAlive]  (ptyProcess) => boolean
 * @param {function} [deps.getCliStatus]  (sessionId) => { status, statusUpdatedAt } | undefined
 * @param {string} [deps.projectsDir]  root of the CLI's transcript folders (~/.claude/projects)
 * @returns {object} ctx
 */
function createTriggerContext(deps) {
  const { activeSessions, log, isPtyAlive, getCliStatus, getLiveDescriptor, projectsDir } = deps;
  // see .ai/contexts/trigger-watcher.md, "Re-keyed sessions"
  const resolve = id => normalizeSessionId((deps.resolveSessionId || (value => value))(normalizeSessionId(id)));
  const source = deps.cliSessionState || cliSessionState;
  const observe = deps.observeTabWriter || ((pid) => source.observeTabWriter(pid));
  const eligible = session => !session.isPlainTerminal && session.host == null && !session.isAttach;
  const live = () => [...new Set([...activeSessions.values()].filter(session => session && !session.exited))];
  const matching = id => [...new Set([...activeSessions].filter(([key, session]) => normalizeSessionId(key) === normalizeSessionId(id)
    && session && !session.exited).map(([, session]) => session))];
  const makeEntry = (session, keyKind = 'direct') => ({ session, generation: session.generation, ptyProcess: session.pty,
    cwd: session.cwd, keyKind, handle: session.host == null ? createLocalSessionHandle(session.pty) : session.handle });
  function transcriptPath(session, id) {
    const folder = path.join(projectsDir, session.projectFolder);
    const expected = path.join(folder, id + '.jsonl');
    try {
      const names = fs.readdirSync(folder).filter(name => name.endsWith('.jsonl') && normalizeSessionId(name.slice(0, -6)) === normalizeSessionId(id));
      return names.length === 1 ? path.join(folder, names[0]) : names.length ? null : expected;
    } catch (err) { return err.code === 'ENOENT' ? expected : null; }
  }
  function lookup(id) {
    const direct = matching(id);
    if (direct.length > 1) return { ambiguous: true };
    if (direct.length) return makeEntry(direct[0]);
    const aliases = matching(resolve(id));
    if (aliases.length > 1) return { ambiguous: true };
    return aliases.length ? makeEntry(aliases[0], 'historical') : null;
  }
  function bounded(promise, deadline) {
    let timer;
    return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); })])
      .finally(() => clearTimeout(timer));
  }
  const ctx = {
    log,
    resolveSessionId: resolve,
    getPtyForSession(sessionId) {
      return lookup(sessionId);
    },
    isSessionBusy(sessionId, binding) {
      const session = binding?.tab || lookup(sessionId)?.session;
      return session ? !!session._cliBusy : false;
    },
    getComposerState(sessionId) {
      const session = lookup(sessionId)?.session;
      if (!session || session.exited || !session.composerState) return null;
      const { pending, lastInputAt } = session.composerState;
      return { pending, lastInputAt };
    },
  };
  ctx.lookupDeliveryFallback = async (id, deadline) => {
    const tabs = live().filter(eligible);
    function find(hint) {
      const found = source.findDeliveryTab(id, tabs, hint);
      if (found.background || found.ambiguous) return found;
      const matches = tabs.filter(tab => {
        const writer = observe(tab.pty?.pid).writer;
        return writer && normalizeSessionId(writer.sessionId) === normalizeSessionId(id);
      });
      if (matches.length > 1) return { ambiguous: true };
      return matches.length ? { tab: matches[0] } : found;
    }
    let found = find();
    if (found.pending && Date.now() < deadline) {
      await bounded(source.refreshProcessTable(), deadline);
      found = find(found.hint);
    }
    return found.tab ? { entry: makeEntry(found.tab, 'descriptor') } : found;
  };
  ctx.pinDelivery = (requestedId, entry, chain) => {
    const session = entry.session;
    const pty = entry.ptyProcess;
    const generation = session.generation;
    const pid = pty?.pid;
    const own = eligible(session);
    let start = own ? source.deliveryPtyStart(pid) : null;
    const indexes = new Map();
    const binding = { tab: session, entry, requestedId, effectiveId: normalizeSessionId(requestedId), reset: null,
      resetAuthorized: false, step: null, observation: null, lastDialog: null };
    function fail(reason, background, deadline = false) {
      const error = new Error(reason);
      error.deliveryRefusal = true;
      error.background = background;
      error.deadline = deadline;
      throw error;
    }
    function valid() {
      if (!live().includes(session) || session.exited || session.generation !== generation || session.pty !== pty || pty?.pid !== pid) return false;
      if (session.host != null && session.handle !== entry.handle) return false;
      const currentStart = own ? source.deliveryPtyStart(pid) : null;
      if (start != null && currentStart != null && start !== currentStart) return false;
      start ??= currentStart;
      const direct = matching(requestedId);
      return binding.resetAuthorized || !direct.length || (direct.length === 1 && direct[0] === session);
    }
    function graph(id) {
      if (!projectsDir || !session.projectFolder) return { unresolved: true, reachable: [], candidates: [] };
      return resolveContinuationsSync(id, nodeId => {
        const folder = path.join(projectsDir, session.projectFolder);
        const names = fs.readdirSync(folder).filter(name => name.endsWith('.jsonl') && normalizeSessionId(name.slice(0, -6)) === normalizeSessionId(nodeId));
        if (names.length > 1) return null;
        if (!names.length) return { missing: true };
        const file = path.join(folder, names[0]);
        try {
          const serialized = scanContinuationIndex(file, names[0].slice(0, -6), indexes.get(file));
          indexes.set(file, serialized);
          const index = JSON.parse(serialized);
          return { index: { ...index, ids: index.ids.map(normalizeSessionId), unresolved: index.unresolved || !index.complete } };
        } catch (err) { return err.code === 'ENOENT' ? { missing: true } : null; }
      }, { includeReachable: true });
    }
    function forget() {
      ctx.forgetTranscriptTurn?.(requestedId, binding);
    }
    function resetBookkeeping() {
      const reset = binding.reset;
      const id = normalizeSessionId(session.realSessionId);
      if (!reset || binding.resetCompletionObserved || !valid() || !validId(id) || id === reset.uiId || id === reset.preId) return;
      const file = transcriptPath(session, id);
      if (!file) return;
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        for (const line of buffer.toString('utf8', 0, length).split('\n')) {
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          const at = Date.parse(record.timestamp);
          if (record.type !== 'user' || normalizeSessionId(record.sessionId) !== id || !Number.isFinite(at) || at < reset.enterAt) continue;
          const text = record.message?.content;
          if (typeof text !== 'string') continue;
          const classified = classifyUserText(text);
          if (classified.kind === 'command' && isClearCommand(classified.text)) { binding.resetCompletionObserved = true; return; }
        }
      } catch {} finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
    }
    function inspect() {
      if (!own) return { outcome: 'mine' };
      resetBookkeeping();
      let observation;
      try { observation = observe(pid); } catch { return { outcome: 'unknown' }; }
      binding.observation = observation;
      const writer = observation?.writer;
      if (!writer) return { outcome: 'unknown' };
      const id = normalizeSessionId(writer.sessionId);
      if (binding.reset) {
        const reset = binding.reset;
        if (reset.identity && observation.identity !== reset.identity) return { outcome: 'other', reason: 'ownership writer process generation changed after reset' };
        reset.identity ||= observation.identity;
        if (id === reset.preId) return { outcome: 'mine', lag: true };
        binding.effectiveId = id;
        binding.reset = null;
        binding.resetCompletionObserved = true;
        forget();
        return { outcome: 'mine', writer };
      }
      if (id === binding.effectiveId) return { outcome: 'mine', writer };
      const continuation = graph(binding.effectiveId);
      if (continuation.unresolved || continuation.waitingForIndex) return { outcome: 'unknown' };
      if (continuation.reachable?.includes(id)) {
        binding.effectiveId = id;
        forget();
        return { outcome: 'mine', writer };
      }
      if (continuation.incomplete) return { outcome: 'unknown' };
      return { outcome: 'other', reason: `ownership writer names ${id}, outside conversation ${binding.effectiveId}` };
    }
    function check(phase) {
      const boundedWrite = phase === 'text' || binding.boundEnter;
      if (boundedWrite && Number.isFinite(binding.deadline) && Date.now() >= binding.deadline) fail('the delivery deadline passed; no further bytes were written', null, true);
      if (!valid()) fail('the pinned tab/PTY generation binding changed; no further bytes were written');
      if (!(isPtyAlive ? isPtyAlive(pty) : entry.handle.isAlive())) fail('the pinned tab process exited; no further bytes were written');
      const outcome = inspect();
      if (boundedWrite && Number.isFinite(binding.deadline) && Date.now() >= binding.deadline) fail('the ownership inspection exhausted the delivery deadline; no further bytes were written', null, true);
      if (outcome.outcome === 'other') fail(outcome.reason);
      if (outcome.outcome === 'unknown' && entry.keyKind !== 'direct' && !binding.reset) fail('ownership of the pinned alias writer is unknown; no further bytes were written');
      return outcome;
    }
    binding.prepareText = async deadline => {
      while (true) {
        if (Date.now() >= deadline) fail('the ownership wait exhausted the delivery deadline; nothing more was written', null, true);
        if (!valid()) fail('the pinned tab/PTY generation binding changed; nothing more was written');
        const observation = inspect();
        if (Date.now() >= deadline) fail('the ownership inspection exhausted the delivery deadline; nothing more was written', null, true);
        if (observation.outcome === 'other') fail(observation.reason);
        if (observation.outcome === 'mine' || entry.keyKind === 'direct' || binding.reset) return;
        if (Date.now() >= deadline) fail('ownership of the pinned alias writer stayed unknown at the deadline; nothing more was written');
        await bounded(source.refreshProcessTable(), Math.min(deadline, Date.now() + 50));
        await bounded(new Promise(resolve => setTimeout(resolve, 10)), deadline);
      }
    };
    binding.admit = async deadline => {
      if (own) {
        const continuation = graph(normalizeSessionId(requestedId));
        for (const candidate of continuation.candidates || []) {
          if (lookup(candidate.sessionId)) continue;
          const background = source.findDeliveryTab(candidate.sessionId, []).background;
          if (background) fail('background session, not attached here', background);
        }
      }
      await binding.prepareText(deadline);
      check();
    };
    binding.beginStep = command => { binding.resetCompletionObserved = false; binding.step = { command, text_written: false, enter_written: false, written: false }; };
    binding.resetCompleted = () => { inspect(); return binding.resetCompletionObserved; };
    binding.readId = () => {
      const observed = inspect();
      if (binding.reset || observed.outcome === 'other') return null;
      return binding.effectiveId;
    };
    const handle = { isAlive: () => valid() && entry.handle.isAlive(), write(data) {
      const outcome = check(data === '\r' ? 'enter' : 'text');
      const preId = binding.effectiveId;
      const identity = binding.observation?.identity;
      const uiId = normalizeSessionId(session.realSessionId);
      const enterAt = Date.now();
      if (data === '\r' && binding.step.enter_written && isClearCommand(binding.step.command) && binding.resetCompletionObserved) {
        fail('ownership reset completion was observed; recovery Enter was suppressed in the successor');
      }
      entry.handle.write(data);
      if (data !== '\r') binding.step.text_written = true;
      else {
        const firstEnter = !binding.step.enter_written;
        binding.step.enter_written = true;
        binding.step.written = binding.step.text_written;
        if (firstEnter && chain && isClearCommand(binding.step.command)) {
          binding.reset = own ? { preId, identity, uiId, enterAt } : null;
          binding.resetAuthorized = true;
          forget();
        }
      }
      return outcome;
    } };
    const scoped = { ...ctx, delivery: binding, getPtyForSession: () => valid() ? { ...entry, handle } : null,
      isSessionBusy: () => ctx.isSessionBusy(requestedId, binding),
      getComposerState: () => valid() && session.composerState ? { pending: session.composerState.pending, lastInputAt: session.composerState.lastInputAt } : null,
      getCliStatus: () => {
        const observed = inspect();
        const unavailable = binding.reset || observed.outcome === 'other';
        const status = unavailable ? undefined : ctx.getCliStatus?.(requestedId, binding);
        if (status?.status === 'waiting') binding.lastDialog = status;
        else if (status) binding.lastDialog = null;
        return status || binding.lastDialog || undefined;
      },
      getTranscriptTurn: (_id, cursor) => {
        return ctx.getTranscriptTurn?.(requestedId, cursor, binding) ?? null;
      }, forgetTranscriptTurn: forget,
    };
    return { binding, ctx: scoped, handle };
  };
  if (isPtyAlive) ctx.isPtyAlive = isPtyAlive;
  if (getLiveDescriptor) ctx.getLiveDescriptor = (sessionId) => getLiveDescriptor(resolve(sessionId));
  if ('remote' in deps) Object.defineProperty(ctx, 'remote', {
    get() {
      const remote = deps.remote;
      if (!remote) return undefined;
      return {
        lookup(sessionId) {
          const aliases = remote.indexer.findSessionAliases(sessionId, remote.isEnabled);
          if (!aliases.length) return null;
          if (aliases.length > 1) return { aliases };
          const alias = aliases[0];
          const { sessions, at, error } = remote.indexer.getRemoteSessions(alias);
          const descriptor = sessions.find(s => s && s.sessionId === sessionId);
          if (!descriptor) return null;
          return { alias, descriptor, at, error, maxAgeMs: remote.maxAgeMs };
        },
        send(alias, descriptor, text) { return remote.adapter.send(alias, descriptor, text); },
      };
    },
  });
  // see .ai/contexts/trigger-watcher.md, "Transcript fallback while the descriptor stays busy"
  if (projectsDir) {
    const reader = createTranscriptTurnReader();
    const readPaths = new Map();
    ctx.getTranscriptTurn = (sessionId, compactionCursor, binding) => {
      const session = binding?.tab || lookup(sessionId)?.session;
      if (!session || session.exited || session.host != null || !session.projectFolder) return null;
      const id = binding ? binding.readId() : session.realSessionId || resolve(sessionId);
      if (id == null) return null;
      const filePath = transcriptPath(session, id);
      if (!filePath) return null;
      const key = binding || sessionId;
      const previous = readPaths.get(key);
      if (previous !== undefined && previous !== filePath) reader.forget(previous);
      readPaths.set(key, filePath);
      return reader.read(filePath, compactionCursor);
    };
    ctx.forgetTranscriptTurn = (sessionId, binding) => {
      const key = binding || sessionId;
      const filePath = readPaths.get(key);
      if (filePath === undefined) return;
      readPaths.delete(key);
      reader.forget(filePath);
    };
  }
  if (getCliStatus) {
    ctx.getCliStatus = (sessionId, binding) => {
      const id = binding ? binding.readId() : resolve(sessionId);
      if (id == null) return undefined;
      const session = binding?.tab || lookup(sessionId)?.session;
      if (!session || session.host != null) return undefined;
      return getCliStatus(id);
    };
  }
  return ctx;
}

module.exports = { createTriggerContext, createLocalSessionHandle };
