'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture, OLD: P, line } = require('./fixtures/continuation-718.cjs');
const { loadAppFunctions } = require('./app-source');
const cache = require('../session-cache');
const { createRemoteIndexer } = require('../remote-index');
const { mirrorProjectsDirFor } = require('../remote-hosts');
const { enumerateSessionFiles } = require('../read-session-file');

const RUN = 'wf_abcdef-886';

function layout(t) {
  const h = fixture(t);
  h.descriptors.length = 0;
  h.write(P);
  const relative = path.join(P, 'subagents', 'workflows', RUN, 'agent-finished.jsonl');
  fs.mkdirSync(path.dirname(path.join(h.dir, relative)), { recursive: true });
  const agent = line({ type: 'user', sessionId: P, agentId: 'finished', isSidechain: true,
    cwd: h.root, message: { content: 'Finished agent' } });
  fs.writeFileSync(path.join(h.dir, relative), agent);
  const ordinary = path.join(P, 'subagents', 'agent-ordinary.jsonl');
  fs.writeFileSync(path.join(h.dir, ordinary), agent.replace('"agentId":"finished"', '"agentId":"ordinary"'));
  const snapshot = path.join(h.dir, P, 'workflows', RUN + '.json');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, JSON.stringify({ workflowName: 'Original title' }));
  return { ...h, relative, ordinary, snapshot };
}

function watcher(h) {
  let watch, flush;
  const notifications = [], refreshes = [], reads = [], syncReads = [];
  const context = vm.createContext({
    fs: { ...fs,
      readFileSync: (...args) => {
        syncReads.push(String(args[0]));
        return fs.readFileSync(...args);
      },
      promises: { ...fs.promises, readFile: async (...args) => {
        reads.push(String(args[0]));
        return fs.promises.readFile(...args);
      } },
      watch: (_dir, _opts, callback) => { watch = callback; return { on() {} }; },
    },
    path, PROJECTS_DIR: h.root, projectsWatcher: null, console,
    detectSessionTransitions() {}, localTranscriptTracker: { record() {} },
    writer: {
      refreshFolder: async (folder, opts) => { refreshes.push({ folder, opts }); return false; },
      dropFolderRows: async folder => { refreshes.push({ folder, dropped: true }); return false; },
    },
    notifyRendererProjectsChanged: cause => notifications.push(cause), log: h.log,
    setTimeout: callback => { flush = callback; return 1; }, clearTimeout() {},
  });
  loadAppFunctions(context, { sourcePath: require.resolve('../main'), functions: ['startProjectsWatcher'] }).startProjectsWatcher();
  return { notifications, refreshes, reads, syncReads,
    event: (filename = path.relative(h.root, h.snapshot)) => watch('change', filename),
    flush: async () => { assert.equal(typeof flush, 'function'); await flush(); },
  };
}

test('snapshot reads wait for the debounced flush and coalesce to the final title', async t => {
  const h = layout(t), w = watcher(h);
  w.event();
  fs.writeFileSync(h.snapshot, JSON.stringify({ workflowName: 'Final title' }));
  w.event();
  assert.deepEqual(w.syncReads, [], 'watcher must not synchronously read the snapshot');
  assert.equal(w.reads.length, 0, 'events only queue snapshot paths');
  await w.flush();
  assert.deepEqual(w.reads, [h.snapshot]);
  assert.deepEqual(w.notifications, ['watcher']);
  assert.equal(w.refreshes.length, 0);
  w.notifications.length = 0;
  w.event();
  await w.flush();
  assert.deepEqual(w.notifications, [], 'the final title is the remembered baseline');
});

test('partial snapshot JSON keeps the last title and a complete rename notifies once', async t => {
  const h = layout(t), w = watcher(h);
  w.event();
  await w.flush();
  w.notifications.length = 0;
  fs.writeFileSync(h.snapshot, '{"workflowName":');
  w.event();
  await w.flush();
  assert.deepEqual(w.notifications, [], 'partial JSON must not publish the run-id fallback');
  fs.writeFileSync(h.snapshot, JSON.stringify({ workflowName: 'Original title' }));
  w.event();
  await w.flush();
  assert.deepEqual(w.notifications, [], 'partial JSON must not replace the remembered title');
  fs.writeFileSync(h.snapshot, JSON.stringify({ workflowName: 'Renamed title' }));
  w.event();
  w.event();
  await w.flush();
  assert.deepEqual(w.notifications, ['watcher']);
});

for (const dropped of [false, true]) {
  test(`folder-wide refresh forgets title baselines: dropped=${dropped}`, async t => {
    const h = layout(t), w = watcher(h);
    w.event();
    await w.flush();
    w.notifications.length = 0;
    const parked = h.dir + '-parked';
    if (dropped) fs.renameSync(h.dir, parked);
    w.event(h.folder);
    await w.flush();
    assert.equal(w.refreshes.length, 1);
    if (dropped) fs.renameSync(parked, h.dir);
    w.notifications.length = 0;
    w.event();
    await w.flush();
    assert.deepEqual(w.notifications, ['watcher'], 'a removed baseline is observed anew');
  });
}

for (const root of [false, true]) {
  test(`remote index repairs a finished ghost once through real worker scans: root=${root}`, async t => {
    const h = layout(t);
    if (root) h.write('agent-finished');
    const dataDir = path.join(h.root, 'data');
    const projectsDir = mirrorProjectsDirFor(dataDir, 'vps');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.cpSync(h.dir, path.join(projectsDir, h.folder), { recursive: true });
    const key = 'vps::' + h.folder;
    h.rows.set('agent-finished', { sessionId: 'agent-finished', folder: key, parentSessionId: null, projectPath: h.root });
    h.folders.set(key, { folder: key, projectPath: h.root, indexMtimeMs: Date.now() });
    cache.init({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions, getMainWindow: () => null, log: h.log, db: h.db });
    const scans = [];
    let changed = false;
    const indexer = createRemoteIndexer({
      dataDir, getHosts: () => [{ alias: 'vps' }], log: h.log,
      getCachedByFolder: h.db.getCachedByFolder,
      listIndexedFolderKeys: () => [...h.folders.keys()], setRemoteRoots: cache.setRemoteRoots,
      scanFolders: async options => {
        scans.push(options);
        const result = await cache.scanFoldersViaWorker(options);
        assert.equal(result.ok, true, result.error);
        return result;
      },
      sync: async () => ({ changedFolders: new Set(changed ? [h.folder] : []),
        changedFilesByFolder: new Map([[h.folder, new Set([P + '.jsonl'])]]),
        sessions: [], fetched: 0, unchanged: 3, removed: 0, failed: 0 }),
    });
    t.after(() => { indexer.dispose(); cache.setRemoteRoots(new Map()); });
    const refresh = async () => {
      const result = await indexer.refreshNow();
      assert.deepEqual(result.errors, []);
    };
    await refresh();
    assert.equal(scans.length, root ? 0 : 1, 'unchanged finished runs still get one full repair');
    assert.equal(h.rows.has('agent-finished'), root);
    if (!root) {
      assert.equal(scans[0].fileSubsets?.has(h.folder) || false, false);
      assert.ok(h.rows.has(`sub:${P}:finished`), 'full scan regroups the finished agent');
    }
    await refresh();
    changed = true;
    await refresh();
    changed = false;
    await refresh();
    assert.equal(scans.length, root ? 1 : 2, 'later refreshes do not repeat the full repair');
    assert.deepEqual([...scans.at(-1).fileSubsets.get(h.folder)], [P + '.jsonl']);
    assert.equal(h.rows.has('agent-finished'), root, 'a real legacy root is preserved');
  });
}

test('a junctioned subagents directory does not duplicate ordinary agents under the fork', t => {
  const h = layout(t);
  const fork = '44444444-4444-4444-8444-444444444444';
  h.write(fork);
  const link = path.join(h.dir, fork, 'subagents');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(h.dir, P, 'subagents'), link, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => { if (fs.existsSync(link)) fs.unlinkSync(link); });
  const entries = enumerateSessionFiles(h.dir);
  assert.equal(entries.some(row => row.parentSessionId === fork), false, 'linked ordinary agents belong only to the original parent');
  assert.equal(entries.filter(row => row.parentSessionId === P && !row.workflowRunId).length, 1);
  cache.refreshFolder(h.folder);
  assert.equal(h.rows.has(`sub:${fork}:ordinary`), false);
  assert.ok(h.rows.has(`sub:${P}:ordinary`));
});
