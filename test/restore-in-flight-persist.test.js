'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { setup } = require('./continuations-harness');
const { loadAppFunctions } = require('./app-source');
const { encodeProjectPath } = require('../encode-project-path');

function setupExitRestore(t, graph, options) {
  const h = setup(t, graph, options);
  h.dom.window.encodeProjectPath = encodeProjectPath;
  vm.runInContext(`
    var cachedProjects = [], cachedAllProjects = [];
    function refreshSidebar() {}
  `, h.ctx, { filename: __filename });
  Object.assign(h.app, loadAppFunctions(h.ctx, {
    declarations: ['savedWorkingSetRead', 'persistWorkingSetTimer', 'exitingAppTimer', 'EXIT_FLUSH_GRACE_MS'],
    functions: ['launchNewSession', 'flushStateForExit'],
  }));
  h.ctx.savedEntries = h.saved;
  vm.runInContext(`
    savedWorkingSetRead = true;
    restoreSavedIndex = new Map(savedEntries.map((item, index) => [item.sessionId, index]));
  `, h.ctx, { filename: __filename });
  return h;
}

function holdTerminalOpen(h) {
  let release;
  const blocked = new Promise(resolve => { release = () => resolve({ ok: true }); });
  let reached;
  const opened = new Promise(resolve => { reached = resolve; });
  const openTerminal = h.dom.window.api.openTerminal;
  h.dom.window.api.openTerminal = async (...args) => {
    await openTerminal(...args);
    reached(args[0]);
    return blocked;
  };
  return { opened, release };
}

test('quitting while a fresh restore opens saves only the replacement session', { timeout: 9000 }, async t => {
  const h = setupExitRestore(t, {}, {
    savedEntries: [{ sessionId: 'cleared', projectPath: '/project', active: true, fresh: true }],
  });
  const gate = holdTerminalOpen(h);
  const restoring = h.app.runRestore(h.saved);
  const newId = await gate.opened;
  try {
    await h.app.flushStateForExit();
    assert.deepEqual(h.settings().openWorkingSet, [
      { sessionId: newId, projectPath: '/project', active: true, fresh: true },
    ]);
  } finally {
    gate.release();
    await restoring;
  }
});

test('quitting while the saved active fresh entry opens keeps the replacement active ahead of a later fresh entry', { timeout: 9000 }, async t => {
  const h = setupExitRestore(t, {}, {
    savedEntries: [
      { sessionId: 'a', projectPath: '/project', active: true, fresh: true },
      { sessionId: 'b', projectPath: '/project', active: false, fresh: true },
    ],
  });
  const gate = holdTerminalOpen(h);
  const restoring = h.app.runRestore(h.saved);
  const newId = await gate.opened;
  try {
    await h.app.flushStateForExit();
    assert.deepEqual(h.settings().openWorkingSet, [
      { sessionId: newId, projectPath: '/project', active: true, fresh: true },
      { sessionId: 'b', projectPath: '/project', active: false, fresh: true },
    ]);
  } finally {
    gate.release();
    await restoring;
  }
});

test('quitting while one fresh restore opens keeps another fresh entry in the same project', { timeout: 9000 }, async t => {
  const h = setupExitRestore(t, {}, {
    savedEntries: [
      { sessionId: 'first', projectPath: '/project', active: false, fresh: true },
      { sessionId: 'second', projectPath: '/project', active: true, fresh: true },
    ],
  });
  const gate = holdTerminalOpen(h);
  const restoring = h.app.runRestore(h.saved);
  const newId = await gate.opened;
  try {
    await h.app.flushStateForExit();
    assert.deepEqual(h.settings().openWorkingSet, [
      { sessionId: newId, projectPath: '/project', active: false, fresh: true },
      { sessionId: 'second', projectPath: '/project', active: true, fresh: true },
    ]);
  } finally {
    gate.release();
    await restoring;
  }
});

test('quitting while a continuation attaches keeps the resolved background session at its saved position', { timeout: 9000 }, async t => {
  const h = setupExitRestore(t, { old: ['new'], new: [], later: [] }, {
    live: { new: { kind: 'bg', jobId: '1234abcd', cwd: '/bg', pid: 1 } },
    savedEntries: [
      { sessionId: 'old', projectPath: '/project', active: true },
      { sessionId: 'later', projectPath: '/project', active: false },
    ],
  });
  const gate = holdTerminalOpen(h);
  const restoring = h.app.runRestore(h.saved);
  assert.equal(await gate.opened, 'new');
  try {
    await h.app.flushStateForExit();
    assert.deepEqual(h.settings().openWorkingSet, [
      { sessionId: 'new', projectPath: '/project', active: true, bg: true },
      { sessionId: 'later', projectPath: '/project', active: false },
    ]);
  } finally {
    gate.release();
    await restoring;
  }
});

test('quitting while a fresh active entry opens after an attached continuation keeps a single active entry', { timeout: 9000 }, async t => {
  const h = setupExitRestore(t, { old: ['new'], new: [] }, {
    live: { new: { kind: 'bg', jobId: '1234abcd', cwd: '/bg', pid: 1 } },
    savedEntries: [
      { sessionId: 'old', projectPath: '/project', active: false },
      { sessionId: 'a', projectPath: '/project', active: true, fresh: true },
    ],
  });
  const openTerminal = h.dom.window.api.openTerminal;
  let release;
  const blocked = new Promise(resolve => { release = () => resolve({ ok: true }); });
  let reached;
  const opened = new Promise(resolve => { reached = resolve; });
  let calls = 0;
  h.dom.window.api.openTerminal = async (...args) => {
    await openTerminal(...args);
    if (++calls < 2) return { ok: true };
    reached(args[0]);
    return blocked;
  };
  const restoring = h.app.runRestore(h.saved);
  const newId = await opened;
  try {
    await h.app.flushStateForExit();
    const set = h.settings().openWorkingSet;
    assert.equal(set.filter(entry => entry.active).length, 1);
    assert.deepEqual(set.find(entry => entry.sessionId === 'new'), { sessionId: 'new', projectPath: '/project', active: true, bg: true });
    assert.equal(set.find(entry => entry.sessionId === newId).active, false);
  } finally {
    release();
    await restoring;
  }
});

test('a failed terminal open does not leave the active mark on the pending session', { timeout: 9000 }, async t => {
  const h = setupExitRestore(t, {}, {
    savedEntries: [{ sessionId: 'a', projectPath: '/project', active: true, fresh: true }],
  });
  let newId;
  h.dom.window.api.openTerminal = async id => { newId = id; throw new Error('boom'); };
  await assert.rejects(h.app.runRestore(h.saved), /boom/);
  const pending = vm.runInContext('pendingSessions.get', h.ctx);
  assert.equal(pending.call(vm.runInContext('pendingSessions', h.ctx), newId).openingActive, undefined);
});
