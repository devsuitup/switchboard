'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { extractFunction } = require('./app-source');
const { createLastKnownProjectsStore } = require('../src/main/projects/last-known-projects');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-quit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const debounce = new Map(), deadlines = new Map(), errors = [], warnings = [], events = [];
  const store = createLastKnownProjectsStore({ dir, appVersion: '1.2.3',
    log: { warn: line => warnings.push(line) },
    setTimeout: (callback, ms) => { debounce.set(callback, ms); return callback; },
    clearTimeout: callback => debounce.delete(callback),
  });
  const app = new EventEmitter();
  app.exit = () => events.push('exit');
  const reader = { shutdown: async () => {} };
  const context = vm.createContext({
    app, lastKnownProjects: store, shutdownPromise: null, shutdownComplete: false, exitRequested: false,
    managedBrowser: { stopForQuit() {} }, appQuitting: false, TRACE: {}, updateInstalling: false,
    stopNonDatabaseResources() {}, closedSessions: new Map(), activeSessions: new Map(), killPty() {},
    writer: { beginShutdown: drain => drain(), releaseLiveSession: async () => {} },
    flushProjectsBeforeExit: async () => {}, flushWindowBounds: async () => {},
    sessionCache: { shutdownProducers: async () => {} }, sessionTransitions: { drainMetadataWrites: async () => {} },
    activityFlushedForQuit: false, activityReporter: { flush: async () => {}, stop() {} },
    projectsClient: reader, fileListsClient: reader, searchClient: reader,
    closeDb: async () => events.push('close-db'), activityTrace: { close() {} },
    stopWorkersForExit: async () => { events.push('stop-workers'); return true; },
    log: { error: (...args) => errors.push(args.join(' ')) },
    setTimeout: (callback, ms) => { deadlines.set(callback, ms); return callback; },
    clearTimeout: callback => deadlines.delete(callback),
    unsavedGuard: { beforeQuit: () => false }, mainWindow: null, quitAttemptToken: null,
  });
  const filename = require.resolve('../main');
  const source = fs.readFileSync(filename, 'utf8');
  for (const name of ['boundedShutdown', 'shutdownForExit', 'exitOnce']) {
    vm.runInContext(extractFunction(source, name), context, { filename });
  }
  const start = source.indexOf("app.on('before-quit', event =>");
  const end = source.indexOf('\n});', start) + 4;
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context, { filename });
  function quit() {
    app.emit('before-quit', { preventDefault: () => events.push('prevent-default') });
    return context.shutdownPromise;
  }
  return { dir, store, debounce, deadlines, errors, warnings, events, context, quit };
}

const latest = { defaultProjects: [{ projectPath: '/latest', sessions: [{ sessionId: 'new' }] }],
  allProjects: [{ projectPath: '/latest', sessions: [{ sessionId: 'new' }] }, { projectPath: '/archived', sessions: [] }] };

test('remember then quit within the debounce window persists the latest projects for the next start', async t => {
  const s = setup(t);
  s.store.remember({ defaultProjects: [], allProjects: [] });
  await s.store.flush();
  s.store.remember(latest);
  assert.deepEqual([...s.debounce.values()], [2000]);
  await s.quit();
  assert.ok(s.events.includes('exit'));
  const restarted = createLastKnownProjectsStore({ dir: s.dir, appVersion: '1.2.3' });
  const saved = await restarted.load();
  assert.deepEqual(saved.defaultProjects, latest.defaultProjects, 'quit must persist the latest default projects');
  assert.deepEqual(saved.allProjects, latest.allProjects, 'quit must persist the latest archived projects too');
  assert.equal(s.debounce.size, 0, 'quit cancels the pending debounce');
  assert.deepEqual(fs.readdirSync(s.dir), ['last-known-projects.json']);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.warnings, []);
});

test('flush with no pending write leaves an absent file absent and an existing file untouched at quit', async t => {
  const s = setup(t);
  await s.store.flush();
  assert.deepEqual(fs.readdirSync(s.dir), []);
  fs.writeFileSync(s.store.filename, 'untouched');
  const before = fs.statSync(s.store.filename, { bigint: true }).mtimeNs;
  await s.quit();
  assert.equal(fs.readFileSync(s.store.filename, 'utf8'), 'untouched');
  assert.equal(fs.statSync(s.store.filename, { bigint: true }).mtimeNs, before);
  assert.deepEqual(fs.readdirSync(s.dir), ['last-known-projects.json']);
  assert.deepEqual(s.errors, []);
  assert.ok(s.events.includes('exit'));
});

for (const mode of ['throw', 'reject']) {
  test(`a flush ${mode} is logged and does not prevent the remaining shutdown or exit`, async t => {
    const s = setup(t);
    s.store.flush = () => {
      const error = new Error('flush unavailable');
      if (mode === 'throw') throw error;
      return Promise.reject(error);
    };
    await s.quit();
    assert.ok(s.errors.some(line => line.includes('flush unavailable')), 'the flush failure must be logged');
    assert.ok(s.events.includes('close-db'), 'remaining shutdown work must still run');
    assert.ok(s.events.includes('exit'));
  });
}

test('a pending flush shares the existing 1500ms drain deadline and cannot hold quit past it', async t => {
  const s = setup(t);
  let started = false;
  s.store.flush = () => { started = true; return new Promise(() => {}); };
  const quitting = s.quit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, true, 'quit must start the flush');
  assert.ok(s.events.includes('close-db'), 'a pending snapshot must not delay closing the database');
  assert.equal(s.events.includes('exit'), false, 'quit must wait for the flush inside its budget');
  assert.deepEqual([...s.deadlines.values()], [1500]);
  const [expire] = s.deadlines.keys();
  expire();
  await quitting;
  assert.ok(s.events.includes('stop-workers'));
  assert.ok(s.events.includes('exit'));
  assert.ok(s.errors.some(line => line.includes('shutdown drain timed out')));
  assert.equal(s.deadlines.size, 0);
});

test('remember during shutdown is flushed before exit after metadata and database work', async t => {
  const s = setup(t);
  s.store.remember({ defaultProjects: [], allProjects: [] });
  const flush = s.store.flush;
  let flushes = 0;
  let pendingAtClose;
  s.store.flush = () => { flushes++; return flush(); };
  s.context.sessionTransitions.drainMetadataWrites = async () => {
    assert.equal(flushes, 1, 'the first flush starts before metadata drains');
    s.store.remember(latest);
  };
  s.context.closeDb = async () => {
    pendingAtClose = s.debounce.size;
    s.events.push('close-db');
  };
  await s.quit();
  assert.ok(s.events.includes('close-db'), 'database closure must complete');
  assert.equal(pendingAtClose, 0, 'the final flush must cancel a timer armed during the drain before closing the database');
  const saved = await createLastKnownProjectsStore({ dir: s.dir, appVersion: '1.2.3' }).load();
  assert.deepEqual(saved.defaultProjects, latest.defaultProjects, 'quit must persist a snapshot remembered during the drain');
  assert.deepEqual(saved.allProjects, latest.allProjects);
  assert.deepEqual(s.errors, []);
});
