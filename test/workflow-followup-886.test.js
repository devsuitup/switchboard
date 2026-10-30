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

test('deleted snapshot publishes the run-id fallback once and forgets the old title', async t => {
  const h = layout(t), w = watcher(h);
  w.event();
  await w.flush();
  w.notifications.length = 0;
  fs.unlinkSync(h.snapshot);
  w.event();
  await w.flush();
  assert.deepEqual(w.notifications, ['watcher'], 'deleted snapshot must publish the run-id fallback');
  w.notifications.length = 0;
  w.event();
  await w.flush();
  assert.deepEqual(w.notifications, [], 'repeated missing snapshots do not notify again');
  fs.writeFileSync(h.snapshot, JSON.stringify({ workflowName: 'Original title' }));
  w.event();
  await w.flush();
  assert.deepEqual(w.notifications, ['watcher'], 'recreated title must be observed anew');
});

for (const baseline of ['cold', 'pruned-first', 'pruned-last']) {
  test(`deleted snapshot without a title baseline notifies once: ${baseline}`, async t => {
    const h = layout(t), w = watcher(h);
    cache.refreshFolder(h.folder);
    const workflow = () => h.views().find(row => row.workflowRunId === RUN);
    assert.equal(workflow().workflowName, 'Original title');
    if (baseline !== 'cold') {
      w.event();
      await w.flush();
      w.notifications.length = 0;
    }
    fs.unlinkSync(h.snapshot);
    if (baseline === 'pruned-first') w.event(h.folder);
    w.event();
    if (baseline === 'pruned-last') w.event(h.folder);
    await w.flush();
    assert.deepEqual(w.notifications, ['watcher'], 'a missing baseline must publish the run-id fallback');
    assert.equal(workflow().workflowName, RUN);
    assert.equal(w.refreshes.length, baseline === 'cold' ? 0 : 1);
    w.notifications.length = 0;
    w.event();
    await w.flush();
    assert.deepEqual(w.notifications, [], 'the missing snapshot retains a run-id baseline');
  });
}

test('deleting a snapshot already showing the run id does not notify', async t => {
  const h = layout(t), w = watcher(h);
  fs.writeFileSync(h.snapshot, '{}');
  w.event();
  await w.flush();
  w.notifications.length = 0;
  fs.unlinkSync(h.snapshot);
  w.event();
  await w.flush();
  assert.deepEqual(w.notifications, []);
  fs.writeFileSync(h.snapshot, '{}');
  w.event();
  await w.flush();
  assert.deepEqual(w.notifications, [], 'recreating the same fallback title does not notify');
});

for (const snapshotFirst of [false, true]) {
  test(`folder and snapshot in one flush retain the newly read baseline: snapshotFirst=${snapshotFirst}`, async t => {
    const h = layout(t), w = watcher(h);
    w.event();
    await w.flush();
    w.notifications.length = 0;
    fs.writeFileSync(h.snapshot, JSON.stringify({ workflowName: 'Renamed title' }));
    if (snapshotFirst) w.event();
    w.event(h.folder);
    if (!snapshotFirst) w.event();
    await w.flush();
    assert.deepEqual(w.notifications, ['watcher']);
    assert.equal(w.refreshes.length, 1);
    w.notifications.length = 0;
    fs.writeFileSync(h.snapshot, JSON.stringify({ workflowName: 'Renamed title', status: 'completed' }));
    w.event();
    await w.flush();
    assert.deepEqual(w.notifications, [], 'status-only event must retain the snapshot baseline from the mixed flush');
  });
}

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

for (const transition of ['failed scan', 'stop/start', 'host removal/re-add']) {
  test(`remote ghost check retries after ${transition} with a full scan`, async t => {
    const h = layout(t);
    const dataDir = path.join(h.root, 'data');
    const projectsDir = mirrorProjectsDirFor(dataDir, 'vps');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.cpSync(h.dir, path.join(projectsDir, h.folder), { recursive: true });
    const key = 'vps::' + h.folder;
    let hosts = [{ alias: 'vps' }];
    let scanOk = transition !== 'failed scan';
    let changed = true;
    const scans = [];
    let ghostChecks = 0;
    const indexer = createRemoteIndexer({
      dataDir, getHosts: () => hosts, log: h.log,
      timers: { setInterval: () => 1, clearInterval() {} },
      getCachedByFolder: folder => {
        assert.equal(folder, key);
        ghostChecks++;
        return [{ sessionId: 'agent-finished', parentSessionId: null }];
      },
      listIndexedFolderKeys: () => [key], dropFolder: async () => {},
      scanFolders: async options => { scans.push(options); return { ok: scanOk }; },
      sync: async () => ({ changedFolders: new Set(changed ? [h.folder] : []),
        changedFilesByFolder: new Map([[h.folder, new Set([P + '.jsonl'])]]),
        sessions: [], fetched: 0, unchanged: 3, removed: 0, failed: 0 }),
    });
    t.after(() => indexer.dispose());
    const refresh = async () => {
      const result = await indexer.refreshNow();
      assert.equal(result.skipped, false);
      assert.deepEqual(result.errors, []);
    };
    await refresh();
    assert.equal(scans.length, 1);
    assert.equal(scans[0].fileSubsets, undefined, 'initial ghost repair overrides the changed-file subset');
    changed = false;
    if (transition === 'failed scan') {
      scanOk = true;
    } else if (transition === 'stop/start') {
      indexer.stop();
      assert.equal(indexer.start(), true);
      await new Promise(resolve => setImmediate(resolve));
    } else {
      hosts = [{ alias: 'peer' }];
      await refresh();
      hosts = [{ alias: 'vps' }];
    }
    await refresh();
    assert.equal(ghostChecks, 2, 'the transition must re-check the mirrored folder');
    assert.equal(scans.length, 2, 'the ghost repair must repeat after the transition');
    assert.equal(scans[1].fileSubsets, undefined, 'the retry must be a full scan even without changed files');
    assert.deepEqual(scans[1].folders, [h.folder]);
    await refresh();
    assert.equal(scans.length, 2, 'successful repair is remembered until the next transition');
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
