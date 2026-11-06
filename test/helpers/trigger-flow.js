'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { makeWorld, startWatcher, tempRoot } = require('./trigger-world');

const ID_C = '11111111-2222-3333-4444-555555555555';
const found = id => ({ status: 'found', sessionId: id, cwd: '/work/project', projectPath: '/work/project', file: '/x', folder: 'proj' });

function arrange(t, options = {}) {
  const root = tempRoot(t);
  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(path.join(projectsDir, 'proj'), { recursive: true });
  const world = makeWorld({ projectsDir, ...options.world });
  const events = [];
  const spawns = [];
  const renderer = new Set();
  const hooks = {};
  world.onWrite = (key, data) => {
    events.push(['write', key, data]);
    options.onWrite?.(world, key, data, events);
    if (data !== '\r' || options.autoTurn === false) return;
    const session = world.activeSessions.get(key);
    session._cliBusy = true;
    world.statuses.set(key, { status: 'busy', statusUpdatedAt: Date.now() });
    setTimeout(() => { session._cliBusy = false; world.statuses.set(key, { status: 'idle', statusUpdatedAt: Date.now() }); }, options.turnMs ?? 60);
  };
  const bridge = {
    waitReady: async () => ({ ok: true }),
    async ensureOpen(op) {
      events.push(['ensureOpen', op.mode, op.requestedSessionId, op.tabKey, op.generation]);
      await hooks.beforeAck?.(op);
      if (op.mode === 'reattach') { renderer.add(op.tabKey); return { ok: true, generation: op.generation, spawned: false }; }
      const launchStartedAt = Date.now();
      const session = world.addSession(op.tabKey, options.spawnSession || {});
      if (options.afterSpawn) options.afterSpawn({ world, key: op.tabKey, launchStartedAt, session, events });
      else world.statuses.set(op.tabKey, { status: 'idle', statusUpdatedAt: launchStartedAt + 5 });
      spawns.push(op.tabKey);
      renderer.add(op.tabKey);
      return { ok: true, generation: session.generation, spawned: true, launchStartedAt };
    },
  };
  const saved = [];
  const overrides = {
    bridge, resolveClosed: async id => found(id),
    saveName: async (id, name) => { events.push(['saveName', id, name]); saved.push([id, name]); },
    ...options.deps,
  };
  const watcher = startWatcher(t, world, overrides, root);
  return { world, events, spawns, renderer, hooks, saved, ...watcher, root, projectsDir };
}

module.exports = { arrange, found, ID_C };
