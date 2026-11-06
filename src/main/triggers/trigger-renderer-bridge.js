// trigger-renderer-bridge.js — see .ai/contexts/ipc-bridge.md, "Trigger session actions"
'use strict';

const CHANNEL_READY = 'trigger-actions-ready';
const CHANNEL_ACTION = 'trigger-session-action';
const CHANNEL_RESULT = 'trigger-session-action-result';

const REASON_NO_WINDOW = 'window not available';
const REASON_NOT_READY = 'renderer not ready';
const REASON_UNAVAILABLE = 'renderer unavailable';
const REASON_ACTION_TIMEOUT = 'renderer action timed out';
const REASON_CLOSING = 'Switchboard is closing.';
const REASON_CHANGED = 'session target changed';
const REASON_OPEN_FAILED = 'session open failed';

function createTriggerRendererBridge(deps) {
  const { ipcMain, getWindow, getSession, isClosing } = deps;
  const clock = deps.now || Date.now;
  const newId = deps.randomUUID || require('crypto').randomUUID;
  const schedule = deps.setTimeout || setTimeout;
  const unschedule = deps.clearTimeout || clearTimeout;
  const permits = new Map();
  const readyWaiters = new Set();
  let ready = null;
  let epoch = 0;
  let wired = null;

  const liveWindow = () => {
    const win = getWindow();
    return win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed?.() ? win : null;
  };
  const trustedSender = event => {
    const win = liveWindow();
    return !!win && !!event && event.sender === win.webContents && !!event.senderFrame
      && event.senderFrame === win.webContents.mainFrame;
  };
  const isReady = () => {
    const win = liveWindow();
    return !!ready && !!win && ready.webContents === win.webContents && ready.frame === win.webContents.mainFrame;
  };

  function settlePermit(permit, outcome) {
    if (permit.settled) return;
    permit.settled = true;
    if (permit.state !== 'revoked') permit.state = 'settled';
    unschedule(permit.timer);
    permit.resolve(outcome);
  }

  function revokePermit(permit, reason) {
    if (permit.state === 'revoked' || permit.state === 'settled') return;
    permit.state = 'revoked';
    settlePermit(permit, {
      ok: false, reason, spawned: permit.spawned, generation: null,
      preSpawn: !permit.spawnAttempted,
      ...(permit.spawnAttempted && !permit.spawned ? { uncertain: true } : {}),
    });
  }

  function revokeAll(reason = REASON_UNAVAILABLE) {
    ready = null;
    for (const permit of permits.values()) revokePermit(permit, reason);
    for (const waiter of [...readyWaiters]) waiter.finish({ ok: false, reason: reason === REASON_CLOSING ? reason : REASON_NOT_READY });
  }

  function wire(win) {
    if (wired === win) return;
    wired = win;
    const wc = win.webContents;
    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) revokeAll(REASON_UNAVAILABLE);
    });
    wc.on('render-process-gone', () => revokeAll(REASON_UNAVAILABLE));
    wc.once('destroyed', () => revokeAll(REASON_UNAVAILABLE));
    win.on('closed', () => revokeAll(REASON_UNAVAILABLE));
  }

  function waitReady({ deadline }) {
    const win = liveWindow();
    if (!win) return Promise.resolve({ ok: false, reason: REASON_NO_WINDOW });
    if (isClosing()) return Promise.resolve({ ok: false, reason: REASON_CLOSING });
    wire(win);
    if (isReady()) return Promise.resolve({ ok: true, documentEpoch: ready.epoch });
    return new Promise(resolve => {
      const waiter = {
        finish(result) { unschedule(waiter.timer); readyWaiters.delete(waiter); resolve(result); },
      };
      waiter.timer = schedule(() => waiter.finish({ ok: false, reason: REASON_NOT_READY }), Math.max(0, deadline - clock()));
      readyWaiters.add(waiter);
    });
  }

  function expectedTuple(permit, msg) {
    return msg.mode === permit.mode && (msg.requestedSessionId ?? null) === permit.requestedSessionId && msg.tabKey === permit.tabKey;
  }

  function verifyEntry(permit, msg) {
    const session = getSession(permit.tabKey);
    if (!session || session.exited) return false;
    if (permit.mode === 'reattach') {
      return session === permit.session && session.pty === permit.pty && msg.generation === permit.generation
        && session.generation === permit.generation;
    }
    return permit.spawned && session.pty === permit.spawnedPty && msg.generation === session.generation;
  }

  function onResult(event, msg) {
    if (!trustedSender(event) || !msg || typeof msg !== 'object') return;
    const permit = permits.get(msg.requestId);
    if (!permit || permit.settled || permit.state === 'revoked' || permit.state === 'settled') return;
    if (!ready || msg.documentEpoch !== permit.epoch || permit.epoch !== ready.epoch) return;
    if (!expectedTuple(permit, msg)) return;
    if (clock() >= permit.deadline) return;
    if (isClosing()) {
      settlePermit(permit, { ok: false, reason: REASON_CLOSING, spawned: permit.spawned, preSpawn: !permit.spawnAttempted });
      return;
    }
    if (msg.ok !== true) {
      settlePermit(permit, { ok: false, reason: typeof msg.reason === 'string' && msg.reason ? msg.reason : REASON_OPEN_FAILED,
        ...(typeof msg.error === 'string' ? { error: msg.error } : {}), spawned: permit.spawned, preSpawn: !permit.spawnAttempted,
        ...(permit.spawnAttempted && !permit.spawned ? { uncertain: true } : {}) });
      return;
    }
    if (!verifyEntry(permit, msg)) {
      settlePermit(permit, { ok: false, reason: REASON_CHANGED, spawned: permit.spawned, preSpawn: false });
      return;
    }
    settlePermit(permit, { ok: true, generation: msg.generation, spawned: permit.spawned, launchStartedAt: permit.launchStartedAt ?? null });
  }

  function register() {
    ipcMain.handle(CHANNEL_READY, event => {
      if (!trustedSender(event)) return { ok: false, reason: REASON_NO_WINDOW };
      const win = liveWindow();
      wire(win);
      ready = { webContents: win.webContents, frame: event.senderFrame, epoch: ++epoch };
      for (const waiter of [...readyWaiters]) waiter.finish({ ok: true, documentEpoch: ready.epoch });
      return { ok: true, documentEpoch: ready.epoch };
    });
    ipcMain.on(CHANNEL_RESULT, onResult);
  }

  async function ensureOpen(op) {
    const gate = await waitReady({ deadline: op.deadline });
    if (!gate.ok) return { ok: false, reason: gate.reason, preSpawn: true, spawned: false };
    const win = liveWindow();
    if (!win || !isReady()) return { ok: false, reason: REASON_NOT_READY, preSpawn: true, spawned: false };
    const permit = {
      requestId: newId(), epoch: ready.epoch, mode: op.mode, requestedSessionId: op.requestedSessionId ?? null, tabKey: op.tabKey,
      generation: op.generation ?? null, project: op.project ?? null, name: op.name ?? null, target: op.target ?? null,
      session: op.mode === 'reattach' ? op.session : null, pty: op.mode === 'reattach' ? op.session?.pty : null,
      deadline: op.deadline, state: 'issued', spawnAttempted: false, spawned: false, launchStartedAt: null, settled: false,
    };
    permits.set(permit.requestId, permit);
    const outcome = new Promise(resolve => {
      permit.resolve = resolve;
      permit.timer = schedule(() => {
        if (permit.settled) return;
        permit.state = 'revoked';
        settlePermit(permit, { ok: false, reason: REASON_ACTION_TIMEOUT, spawned: permit.spawned, preSpawn: false,
          ...(permit.spawnAttempted && !permit.spawned ? { uncertain: true } : {}) });
      }, Math.max(0, op.deadline - clock()));
    });
    outcome.finally(() => { if (permit.settled) permits.delete(permit.requestId); }).catch(() => {});
    win.webContents.send(CHANNEL_ACTION, {
      requestId: permit.requestId, documentEpoch: permit.epoch, mode: permit.mode, requestedSessionId: permit.requestedSessionId,
      tabKey: permit.tabKey, generation: permit.generation,
      session: op.session ? { sessionId: op.session.sessionId ?? permit.tabKey, projectPath: op.session.projectPath ?? permit.project } : null,
      project: permit.project, name: permit.name, deadline: permit.deadline,
    });
    return outcome;
  }

  function consumePermit(requestId, { sessionId, isNew, sessionOptions } = {}) {
    const permit = permits.get(requestId);
    const refuse = reason => ({ ok: false, error: reason });
    if (!permit || permit.state !== 'issued') return refuse('trigger permit rejected');
    if (clock() >= permit.deadline) { permit.state = 'revoked'; return refuse('trigger permit expired'); }
    if (permit.tabKey !== sessionId) return refuse('trigger permit rejected');
    const options = sessionOptions || {};
    const accepted = !options.forkFrom && !options.type && (permit.mode === 'new' ? isNew === true
      : permit.mode === 'resume' ? isNew === false
        : isNew === false && options.reattachOnly === true);
    if (!accepted) return refuse('trigger permit rejected');
    permit.state = 'opening';
    return { ok: true, permit: { mode: permit.mode, tabKey: permit.tabKey, requestedSessionId: permit.requestedSessionId,
      project: permit.project, target: permit.target } };
  }

  function beforeSpawn(requestId) {
    const permit = permits.get(requestId);
    if (!permit || permit.state !== 'opening') return { ok: false, reason: REASON_UNAVAILABLE };
    if (isClosing()) return { ok: false, reason: REASON_CLOSING };
    if (clock() >= permit.deadline) { permit.state = 'revoked'; return { ok: false, reason: REASON_ACTION_TIMEOUT }; }
    permit.spawnAttempted = true;
    permit.launchStartedAt = clock();
    return { ok: true, launchStartedAt: permit.launchStartedAt };
  }

  function spawned(requestId, spawnedPty) {
    const permit = permits.get(requestId);
    if (permit && permit.state === 'opening') { permit.spawned = true; permit.spawnedPty = spawnedPty; }
  }

  function guardedSpawn(requestId, spawn) {
    const gate = beforeSpawn(requestId);
    if (!gate.ok) return gate;
    const value = spawn();
    spawned(requestId, value);
    return { ok: true, launchStartedAt: gate.launchStartedAt, value };
  }

  return { register, ensureOpen, waitReady, consumePermit, beforeSpawn, guardedSpawn, spawned, revokeAll, isReady,
    channels: { ready: CHANNEL_READY, action: CHANNEL_ACTION, result: CHANNEL_RESULT } };
}

function createPendingOpens() {
  const pending = new Map();
  async function acquire(sessionId) {
    while (pending.has(sessionId)) await pending.get(sessionId);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    pending.set(sessionId, held);
    return () => { if (pending.get(sessionId) === held) pending.delete(sessionId); release(); };
  }
  async function serialized(sessionId, open) {
    const release = await acquire(sessionId);
    try { return await open(); } finally { release(); }
  }
  serialized.acquire = acquire;
  return serialized;
}

module.exports = { createTriggerRendererBridge, createPendingOpens };
