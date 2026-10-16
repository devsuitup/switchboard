'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function scenario(name, body) {
  test(name, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-archive-675-'));
    try {
      const result = spawnSync(require('electron'), ['-e', `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const path = require('node:path');
        const vm = require('node:vm');
        const { Worker } = require('node:worker_threads');
        const archive = require('./archived-projects');
        const { createSessionIndexWriter } = require('./session-index-writer');
        const root = process.env.SWITCHBOARD_DATA_DIR.replaceAll('\\\\', '/');
        const project = root + '/project';
        const other = root + '/other';
        const entry = archive.archivedEntry(null, project);
        const otherEntry = archive.archivedEntry(null, other);
        const messages = [];
        let beforePost = () => {};
        let onWorkerMessage = () => {};
        const writer = createSessionIndexWriter({ workerFactory: () => {
          const worker = new Worker(path.resolve('workers/session-index-writer.js'));
          worker.on('message', message => onWorkerMessage(message));
          const post = worker.postMessage.bind(worker);
          worker.postMessage = message => {
            messages.push(structuredClone(message));
            beforePost(message, post);
            post(message);
          };
          return worker;
        } });
        const projects = [{ projectPath: project, sessions: [{ sessionId: 'known', summary: 'PROJECT_PAYLOAD' }] }];
        const views = { defaultProjects: projects, allProjects: projects, rows: 1 };
        const source = fs.readFileSync('main.js', 'utf8');
        const start = source.indexOf("ipcMain.handle('get-projects'");
        const end = source.indexOf('\\n});', start) + 4;
        let invoke;
        (async () => {
          try {
            await writer.ready;
            const db = require('./db');
            vm.runInNewContext(source.slice(start, end), {
              ipcMain: { handle: (_name, fn) => { invoke = fn; } },
              console, TRACE: { on: false }, performance, projectsReconciledAt: Date.now(),
              getSetting: db.getSetting, normalizeHosts: () => [],
              parseFolderKey: require('./remote-hosts').parseFolderKey,
              isInitialScanComplete: () => true, isCachePopulated: () => true,
              isSearchIndexPopulated: () => true,
              populateCacheViaWorker: () => assert.fail('warm cache populated'),
              backfillEntrypoints() {}, backfillCustomTitles() {}, writer,
              projectsClient: { request: async () => structuredClone(views) },
              mergePlaceholderSessions: rows => rows, annotateRemoteAttachable: rows => rows,
            });
            ${body}
          } finally { await writer.closeDb(); }
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 20000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

scenario('unchanged archives in paired and single get-projects post no writer messages', `
  await writer.setSetting('archivedProjects', { [entry]: { knownSessionIds: ['known'] } });
  messages.length = 0;
  const revision = db.getSetting('_writer_revision');
  for (const mode of ['both', false, true]) await invoke(null, mode);
  assert.deepEqual(messages, [], 'effect-free get-projects must not post project lists or queue reads');
  assert.equal(db.getSetting('_writer_revision'), revision);
`);

scenario('reappearing projects persist only archive keys through the writer and retain offers', `
  const schedule = root + '/schedule.md';
  fs.writeFileSync(schedule, '---\\nname: Restart me\\nenabled: false\\n---\\n');
  await writer.setSetting('archivedProjects', {
    [entry]: { archivedAt: 12, knownSessionIds: [], disabledSchedules: [schedule] },
    [otherEntry]: { archivedAt: 13, knownSessionIds: ['other'] },
  });
  await writer.setSetting('scheduleReenableOffers', { [otherEntry]: { disabledSchedules: ['other.md'] } });
  messages.length = 0;
  const snapshot = { archivedProjects: db.getSetting('archivedProjects'), hiddenProjects: [],
    scheduleReenableOffers: db.getSetting('scheduleReenableOffers') };
  const reply = await invoke(null, 'both');
  assert.deepEqual(db.getSetting('archivedProjects'), {
    [otherEntry]: { archivedAt: 13, knownSessionIds: ['other'] },
  });
  assert.deepEqual(db.getSetting('scheduleReenableOffers'), {
    [otherEntry]: { disabledSchedules: ['other.md'] },
    [entry]: { archivedAt: 12, disabledSchedules: [schedule] },
  });
  assert.deepEqual(reply.defaultProjects[0].reenableOffer, { names: ['Restart me'] });
  assert.equal(JSON.stringify(reply.defaultProjects), JSON.stringify(reply.allProjects));
  assert.deepEqual(messages.map(({ command, args }) => ({ command, args })), [
    { command: 'retireArchivedEntries', args: [[entry], snapshot] },
  ]);
  assert.ok(!JSON.stringify(messages).includes('PROJECT_PAYLOAD'));
`);

scenario('archive filtering is byte-identical to the old helper for paired and single fixtures', `
  const hidden = root + '/hidden';
  const parent = root + '/parent';
  const worktree = parent + '/.claude/worktrees/new';
  const hiddenWorktree = hidden + '/.claude/worktrees/visible';
  const schedule = root + '/offered.md';
  fs.writeFileSync(schedule, '---\\nname: Offered task\\n---\\n');
  const record = { archivedAt: 12, knownSessionIds: ['known'], disabledSchedules: [schedule] };
  const rows = [
    ...projects,
    { projectPath: other, sessions: [{ sessionId: 'known' }, { sessionId: 'child', parentSessionId: 'known' }] },
    { projectPath: hidden, sessions: [{ sessionId: 'hidden' }] },
    { projectPath: hiddenWorktree, sessions: [{ sessionId: 'worktree' }] },
    { projectPath: project, remoteAlias: 'host', sessions: [{ sessionId: 'remote' }] },
    { projectPath: '/remote-new', remoteAlias: 'host', sessions: [{ sessionId: 'remote-new' }] },
    { projectPath: parent, sessions: [] },
    { projectPath: worktree, sessions: [{ sessionId: 'new-worktree' }] },
    { projectPath: root + '/remote-hidden', remoteAlias: 'host', sessions: [] },
    { projectPath: root + '/archived-only', sessions: [{ sessionId: 'archived', archived: 1 }] },
  ];
  views.defaultProjects = structuredClone(rows);
  views.allProjects = structuredClone(rows);
  views.allProjects[0].sessions.push({ sessionId: 'new-but-archived', archived: 1 });
  const initial = {
    global: { hiddenProjects: [hidden, 'host::' + root + '/remote-hidden'] },
    archivedProjects: { [entry]: record, [otherEntry]: record,
      [archive.archivedEntry('host', '/remote-new')]: record,
      [archive.archivedEntry(null, parent)]: record,
      [archive.archivedEntry(null, root + '/archived-only')]: record },
    scheduleReenableOffers: { [archive.archivedEntry('host', project)]: {
      disabledSchedules: [schedule, root + '/missing.md'], failed: [{ name: 'Offered task', error: 'denied' }],
    } },
  };
  for (const mode of ['both', false, true]) {
    for (const [key, value] of Object.entries(initial)) await writer.setSetting(key, value);
    const state = structuredClone(initial);
    const old = (rows, show) => archive.applyAndPersistArchived(structuredClone(rows), show, {
      getSetting: key => state[key], setSetting: (key, value) => { state[key] = value; },
    });
    const expected = mode === 'both'
      ? { defaultProjects: old(views.defaultProjects, false), allProjects: old(views.allProjects, true) }
      : old(mode ? views.allProjects : views.defaultProjects, !!mode);
    assert.equal(JSON.stringify(await invoke(null, mode)), JSON.stringify(expected));
    assert.deepEqual(db.getSetting('archivedProjects'), state.archivedProjects);
    assert.deepEqual(db.getSetting('scheduleReenableOffers'), state.scheduleReenableOffers);
  }
  const before = JSON.stringify(rows);
  await writer.applyAndPersistArchived(rows, true);
  assert.equal(JSON.stringify(rows), before, 'main filtering must preserve worker-era input isolation');
`);

scenario('archive results retain separate session objects for later main-side annotations', `
  const before = JSON.stringify(projects);
  const result = await writer.applyAndPersistArchived(projects, true);
  result[0].sessions[0].status = 'working';
  assert.equal(JSON.stringify(projects), before, 'session annotations must not leak into the source views');
`);

scenario('three retirement conflicts return projects without persisting a stale archive decision', `
  await writer.setSetting('archivedProjects', { [entry]: { archivedAt: 12, knownSessionIds: [] } });
  let conflicts = 0;
  beforePost = (message, post) => {
    if (message.command !== 'retireArchivedEntries') return;
    post({ id: -1, command: 'setSetting', args: ['archivedProjects', {
      [entry]: { archivedAt: 12 + ++conflicts, knownSessionIds: [] },
    }] });
  };
  messages.length = 0;
  const reply = await invoke(null, false);
  assert.equal(reply.length, 1);
  assert.equal(reply[0].projectPath, project);
  assert.equal(conflicts, 3);
  assert.equal(messages.length, 3);
  assert.deepEqual(db.getSetting('archivedProjects'), { [entry]: { archivedAt: 15, knownSessionIds: [] } });
  assert.equal(db.getSetting('scheduleReenableOffers'), null);
  beforePost = () => {};
  await invoke(null, false);
  assert.deepEqual(db.getSetting('archivedProjects'), {});
`);

for (const count of [50, 200]) {
  scenario('get-projects retires archives during a ' + count + '-entry background search write', `
    await writer.setSetting('archivedProjects', { [entry]: { knownSessionIds: [] } });
    let started;
    const running = new Promise(resolve => { started = resolve; });
    onWorkerMessage = message => { if (message.started) started(); };
    let completed = false;
    const background = writer.upsertSearchEntries(Array.from({ length: ${count} }, (_, i) => ({
      id: 'background-' + i, type: 'memory', title: 'Background ' + i, body: 'x'.repeat(20000),
    }))).then(() => { completed = true; });
    await running;
    beforePost = message => {
      if (message.command === 'retireArchivedEntries') assert.equal(completed, false);
    };
    messages.length = 0;
    const reply = await invoke(null, false);
    assert.equal(reply.length, 1);
    assert.deepEqual(db.getSetting('archivedProjects'), {});
    assert.equal(messages.filter(m => m.command === 'retireArchivedEntries').length, 1);
    await background;
    assert.equal(db.searchByType('memory', 'Background', ${count}).length, ${count});
  `);
}

scenario('unrelated global changes do not conflict with archive retirement', `
  await writer.setSetting('archivedProjects', { [entry]: { knownSessionIds: [] } });
  beforePost = (message, post) => {
    if (message.command === 'retireArchivedEntries') {
      post({ id: -1, command: 'patchGlobal', args: [{ unrelated: true }] });
    }
  };
  messages.length = 0;
  const reply = await invoke(null, false);
  assert.equal(reply.length, 1);
  assert.deepEqual(db.getSetting('archivedProjects'), {});
  assert.equal(db.getSetting('global').unrelated, true);
  assert.equal(messages.length, 1);
`);

scenario('remote root retirement preserves the exact archive key and creates its offer once', `
  const remoteEntry = archive.archivedEntry('host', '/');
  assert.equal(remoteEntry, 'host::');
  const schedule = root + '/remote-schedule.md';
  fs.writeFileSync(schedule, '---\\nname: Remote task\\n---\\n');
  await writer.setSetting('archivedProjects', {
    [remoteEntry]: { archivedAt: 12, knownSessionIds: [], disabledSchedules: [schedule] },
    [otherEntry]: { knownSessionIds: ['other'] },
  });
  views.defaultProjects = [{ projectPath: '/', remoteAlias: 'host', sessions: [{ sessionId: 'new' }] }];
  messages.length = 0;
  const reply = await invoke(null, false);
  assert.deepEqual(db.getSetting('archivedProjects'), { [otherEntry]: { knownSessionIds: ['other'] } });
  assert.deepEqual(db.getSetting('scheduleReenableOffers'), {
    [remoteEntry]: { archivedAt: 12, disabledSchedules: [schedule] },
  });
  assert.deepEqual(reply[0].reenableOffer, { names: ['Remote task'] });
  assert.equal(messages.length, 1);
  messages.length = 0;
  await invoke(null, false);
  assert.equal(messages.length, 0);
`);

for (const race of ['rearchive', 'hide', 'offer', 'worktree']) {
  scenario('retirement rechecks queued ' + race + ' changes without sending project rows', `
    const record = { archivedAt: 12, knownSessionIds: [], disabledSchedules: [] };
    await writer.setSetting('archivedProjects', { [entry]: record });
    if ('${race}' === 'worktree') {
      views.defaultProjects = [{ projectPath: project + '/.claude/worktrees/new', sessions: [] }];
      views.allProjects = views.defaultProjects;
    }
    let injected = false;
    beforePost = (message, post) => {
      if (message.command !== 'retireArchivedEntries' || injected) return;
      injected = true;
      let key, value;
      if ('${race}' === 'rearchive') {
        key = 'archivedProjects'; value = { [entry]: { ...record, knownSessionIds: ['known'] } };
      } else if ('${race}' === 'hide') {
        key = 'global'; value = { hiddenProjects: [project] };
      } else if ('${race}' === 'worktree') {
        key = 'archivedProjects'; value = { [entry]: record,
          [archive.archivedEntry(null, project + '/.claude/worktrees/new')]: record };
      } else {
        key = 'scheduleReenableOffers'; value = { [otherEntry]: { disabledSchedules: ['concurrent.md'] } };
      }
      post({ id: -1, command: 'setSetting', args: [key, value] });
    };
    messages.length = 0;
    const reply = await invoke(null, false);
    assert.equal(injected, true, 'retirement must use the guarded writer command');
    if ('${race}' === 'offer') {
      assert.equal(reply.length, 1);
      assert.deepEqual(db.getSetting('archivedProjects'), {});
      assert.deepEqual(db.getSetting('scheduleReenableOffers'), {
        [otherEntry]: { disabledSchedules: ['concurrent.md'] },
      });
      assert.equal(messages.length, 2);
    } else {
      assert.deepEqual(reply, []);
      assert.ok(db.getSetting('archivedProjects')[entry]);
      assert.equal(messages.length, 1);
    }
    assert.ok(!JSON.stringify(messages).includes('PROJECT_PAYLOAD'));
  `);
}
