'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyTranscriptTail } = require('../transcript-turn');
const { renderSessionIcon } = require('../public/session-state');
const { normalizeTaskEvidence } = require('../task-records');
const { createTaskRegistry } = require('../public/task-registry');
const { createTaskRecordsClient } = require('../task-records-client');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { extractFunction } = require('./app-source');
const vm = require('node:vm');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');

const stamp = '2026-10-14T01:00:00.000Z';
const prompt = { type: 'user', timestamp: stamp, message: { role: 'user', content: 'Work' } };
const answer = { type: 'assistant', timestamp: stamp, message: { role: 'assistant', content: [], stop_reason: 'end_turn' } };
const duration = { type: 'system', subtype: 'turn_duration', timestamp: stamp };
const jsonl = entries => entries.map(e => JSON.stringify(e)).join('\n') + '\n';

test('the icon reducer refuses an animated hint against closed or unknown head evidence', () => {
  for (const headTurn of ['closed', 'unknown']) {
    assert.equal(renderSessionIcon({ busy: true, headTurn, backgroundWork: true }).slotClasses[0], 'session-icon--agents-busy');
  }
});

test('the live CLI shell fan kind reaches the existing background registry and the static glyph', () => {
  const job = structuredClone(fixture.job);
  job.fan = [{ id: 'background-shell', kind: 'shell', startedAt: Date.parse(stamp) }];
  const evidence = normalizeTaskEvidence(job);
  assert.equal(evidence.valid, true, 'CLI shell is a supported background Bash task');
  const registry = createTaskRegistry();
  registry.applyJob(fixture.parentSessionId, evidence);
  assert.equal(registry.background(fixture.parentSessionId), true);
  assert.equal(registry.agents(fixture.parentSessionId).length, 0);
  assert.equal(renderSessionIcon({ headTurn: 'closed', backgroundWork: registry.background(fixture.parentSessionId) }).slotClasses[0], 'session-icon--agents-busy');
});

test('head turn is unknown without evidence, open through a silent tool call, closed only with closure evidence', () => {
  for (const text of ['', 'broken\n', jsonl([{ type: 'system', subtype: 'progress', timestamp: stamp }])]) {
    assert.equal(classifyTranscriptTail(text).state, 'unknown');
  }
  assert.equal(classifyTranscriptTail(jsonl([prompt])).state, 'open');
  assert.equal(classifyTranscriptTail(jsonl([prompt, answer])).state, 'open');
  assert.equal(classifyTranscriptTail(jsonl([prompt, answer, duration])).state, 'closed');
  assert.equal(classifyTranscriptTail(jsonl([prompt, answer, duration, { type: 'queue-operation', operation: 'enqueue', timestamp: stamp, content: 'next' }])).state, 'open');
});

function setup(t, { merged = false, remote = false, status = 'idle' } = {}) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const row = { sessionId: 'root', status, modified: stamp,
    ...(merged ? { headSessionId: 'head', mergedMemberIds: ['old', 'head'], mergedMemberStatuses: { head: { status: 'idle' }, old: { status: 'busy' } } } : {}),
    ...(remote ? { remoteAlias: 'host', remoteDescriptorSeen: !merged,
      mergedMemberStatuses: undefined, remoteMemberDescriptorSeen: merged ? { head: true } : {} } : {}) };
  ctx.window.sessionMap.set('root', row);
  ctx.window.activeSessionId = merged ? 'head' : 'root';
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: [row], ...(remote ? { remoteAlias: 'host' } : {}) })], true);
  let revision = 0;
  const turn = (state, id = merged ? 'head' : 'root') => ctx.emitTaskSnapshot({ parentSessionId: id, revision: ++revision, tasks: [], headTurn: { sessionId: id, state, revision } });
  const icon = () => ctx.document.getElementById('si-root').querySelector('.session-icon');
  return { ctx, row, turn, icon };
}

test('OSC busy alone cannot animate an unknown or closed head; background shells use the one static slot', t => {
  const { ctx, turn, icon } = setup(t);
  ctx.window.activePtyIds.add('root');
  ctx.setActivity('root', true, 'OSC');
  assert.equal(icon().classList.contains('session-icon--busy'), false, 'unknown head cannot be inferred open from OSC');
  turn('closed');
  ctx.setActivity('root', true, 'OSC');
  ctx.window.taskRegistry.note('root', 'shell', 'cli-task', { kind: 'shell' });
  assert.equal(icon().classList.contains('session-icon--busy'), false);
  assert.equal(icon().classList.contains('session-icon--agents-busy'), true);
  assert.equal(icon().dataset.glyph, '⠿');
  assert.equal(ctx.document.getElementById('si-root').querySelectorAll('.session-icon').length, 1);
  ctx.window.taskRegistry.end('root', 'shell');
  assert.equal(icon().classList.contains('session-icon--idle'), true);
});

test('the task registry alone decides when known fallback background work has ended', t => {
  const { ctx, turn, icon } = setup(t);
  turn('closed');
  ctx.window.onLocalTranscriptSubagentActivity({ parentSessionId: 'root', agentId: 'fallback' });
  assert.equal(icon().classList.contains('session-icon--agents-busy'), true);
  ctx.window.taskRegistry.release('root', 'fallback', 'local-transcript');
  assert.equal(icon().classList.contains('session-icon--waiting'), true, 'an adapter hint cannot retain background work after registry release');
});

test('open head remains animated across silence and hint decay; attention retains priority', t => {
  const { ctx, turn, icon } = setup(t);
  turn('open');
  ctx.window.onLocalTranscriptActivity({ sessionId: 'root', at: Date.now() });
  ctx.window.decayLocalTranscriptBusy('root');
  assert.equal(icon().classList.contains('session-icon--busy'), true);
  ctx.window.setAttention('root', true);
  assert.equal(icon().classList.contains('session-icon--attention'), true);
  ctx.window.setAttention('root', false);
  turn('closed');
  assert.equal(icon().classList.contains('session-icon--waiting'), true);
});

test('merged row animates only its head, while older members can supply background work', t => {
  const { ctx, turn, icon } = setup(t, { merged: true });
  turn('closed');
  turn('open', 'old');
  ctx.window.taskRegistry.note('old', 'agent', 'cli-task');
  assert.equal(icon().classList.contains('session-icon--busy'), false);
  assert.equal(icon().classList.contains('session-icon--agents-busy'), true);
  turn('open');
  assert.equal(icon().classList.contains('session-icon--busy'), true);
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: [ctx.window.sessionMap.get('root')] })], true);
  assert.equal(icon().classList.contains('session-icon--busy'), true, 'rebuild keeps head selection');
});

test('remote hints and agent clocks cannot reopen a closed head or close an open head', t => {
  const { ctx, turn, icon } = setup(t, { remote: true });
  turn('closed');
  ctx.window.onRemoteActivityEvent({ sessionId: 'root', at: Date.now() });
  ctx.window.taskRegistry.note('root', 'monitor', 'cli-task', { kind: 'monitor' });
  assert.equal(icon().classList.contains('session-icon--agents-busy'), true);
  turn('open');
  ctx.window.decayRemoteBusy('root');
  assert.equal(icon().classList.contains('session-icon--busy'), true);
});

test('an unattached remote merged head uses its own live descriptor and turn on initial paint and updates', t => {
  const { ctx, row, turn, icon } = setup(t, { remote: true, merged: true });
  turn('open');
  assert.equal(icon().classList.contains('session-icon--busy'), true);
  ctx.sidebar.renderProjects([makeSampleProject({ remoteAlias: 'host', sessions: [row] })], true);
  assert.equal(icon().classList.contains('session-icon--busy'), true);
});

test('a remote descriptor disappearance makes turn liveness unknown without ending background tasks', t => {
  const { ctx, row, turn, icon } = setup(t, { remote: true });
  turn('open');
  ctx.window.taskRegistry.note('root', 'agent', 'cli-task');
  row.remoteDescriptorSeen = false;
  row.status = null;
  ctx.sidebar.renderProjects([makeSampleProject({ remoteAlias: 'host', sessions: [row] })], true);
  assert.equal(icon().classList.contains('session-icon--busy'), false);
  assert.equal(icon().classList.contains('session-icon--agents-busy'), true);
  assert.equal(ctx.window.taskRegistry.agents('root').length, 1);
});

test('an unseen closure keeps response-ready priority, and OSC cannot create or consume unread turn evidence', t => {
  const { ctx, turn, icon } = setup(t);
  ctx.window.activeSessionId = 'other';
  turn('open');
  turn('closed');
  assert.equal(icon().classList.contains('session-icon--response-ready'), true);
  assert.equal(ctx.document.getElementById('si-root').classList.contains('response-ready'), true);
  ctx.setActivity('root', true, 'OSC');
  assert.equal(ctx.document.getElementById('si-root').classList.contains('response-ready'), true);
  ctx.window.taskRegistry.note('root', 'cron', 'cli-task', { kind: 'cron' });
  assert.equal(icon().classList.contains('session-icon--response-ready'), true);
  ctx.window.clearUnread('root');
  assert.equal(ctx.document.getElementById('si-root').classList.contains('response-ready'), false);
});

test('an unknown live head exposes degraded information, and owner death gates stale open evidence', t => {
  const { ctx, turn, icon } = setup(t, { status: 'busy' });
  turn('unknown');
  assert.equal(icon().title, 'Turn state unavailable · Running elsewhere\nCLI status: busy');
  turn('open');
  ctx.window.sessionMap.set('root', { sessionId: 'root', modified: stamp });
  ctx.window.projectLocalPtyState('root');
  assert.equal(icon().classList.contains('session-icon--busy'), false);
});

test('the Agents row projects descriptor busy while an idle descriptor preserves turn and background facts', t => {
  const { ctx, turn } = setup(t);
  ctx.evalPublic('agents-view.js');
  const entry = { kind: 'background', id: 'short', sessionId: 'root', state: 'working', hosted: true, status: 'busy' };
  turn('closed');
  ctx.window.taskRegistry.note('root', 'cron', 'cli-task', { kind: 'cron' });
  assert.equal(ctx.window.agentRowIcon(entry).slotClass, 'session-icon--busy');
  entry.status = 'idle';
  assert.equal(ctx.window.agentRowIcon(entry).slotClass, 'session-icon--agents-busy');
  turn('open');
  assert.equal(ctx.window.agentRowIcon(entry).slotClass, 'session-icon--busy');
});

test('descriptor attention consumes unread turn evidence before releasing the one slot', t => {
  const { ctx, turn } = setup(t, { remote: true });
  ctx.window.activeSessionId = 'other';
  turn('open');
  turn('closed');
  ctx.window.applyRemoteDescriptor({ sessionId: 'root', remoteAlias: 'host', remoteDescriptorSeen: true, status: 'waiting' });
  ctx.window.applyRemoteDescriptor({ sessionId: 'root', remoteAlias: 'host', remoteDescriptorSeen: true, status: 'idle' });
  assert.equal(ctx.document.getElementById('si-root').classList.contains('response-ready'), false);
});

for (const method of ['refreshNow', 'refreshHostNow']) {
  for (const changed of [false, true]) {
    test(`${method} with ${changed ? 'changed' : 'unchanged'} mirror batches the live head and pushes its turn to the renderer`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-refresh-698b-'));
      const dir = path.join(root, 'remote', 'host', 'projects', '-p');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'root.jsonl'), jsonl([prompt, fixture.use, fixture.launch]));
      const { ctx, icon } = setup(t, { remote: true, status: 'busy' });
      const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
      const batches = [];
      const pushes = [];
      let scans = 0;
      const context = vm.createContext({
        path, getAllCached: () => [{ sessionId: 'root', folder: 'host::-p' }, { sessionId: 'local', folder: '-p' }],
        getAllMeta: () => new Map(), parseFolderKey: require('../remote-hosts').parseFolderKey,
        projectsDirForFolder: () => dir,
        getAllFolderMeta: () => new Map([['host::-p', {}]]),
        getSetting: () => ({ remoteHosts: [{ alias: 'host' }] }),
        createRemoteIndexer: options => require('../remote-index').createRemoteIndexer({
          ...options,
          sync: async () => ({ fetched: changed ? 1 : 0, unchanged: changed ? 0 : 1,
            removed: 0, failed: 0, changedFolders: new Set(changed ? ['-p'] : []),
            sessions: [{ sessionId: 'root', status: 'idle' }] }),
        }),
        createTaskRecordsClient: options => {
          const client = createTaskRecordsClient(options);
          const readBatch = client.readBatch;
          client.readBatch = rows => {
            batches.push(Array.from(rows, row => ({ ...row })));
            return readBatch(rows);
          };
          return client;
        },
        scanFoldersViaWorker: async () => { scans++; },
        DB_PATH: path.join(root, 'db'), remoteTransport: {}, setRemoteRoots() {},
        writer: { dropRemoteFolder: async () => assert.fail('the mirrored folder must remain indexed') },
        notifyRendererProjectsChanged() {},
        log: { info() {}, warn: error => assert.fail(error) },
        mainWindow: { isDestroyed: () => false, webContents: { send: (channel, snapshot) => {
          pushes.push({ channel, snapshot });
          if (channel === 'task-snapshot') ctx.emitTaskSnapshot(snapshot);
        } } },
      });
      const evaluate = (declaration, exported) => {
        const start = source.indexOf(`const ${declaration} = `);
        assert.notEqual(start, -1);
        const end = source.indexOf('\n});', start) + 4;
        vm.runInContext(source.slice(start, end) + `\nglobalThis.${exported} = ${declaration};`, context);
      };
      evaluate('taskRecords', 'client');
      t.after(async () => { await context.client.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
      vm.runInContext(extractFunction(source, 'refreshRemoteHeadTurns'), context);
      evaluate('remoteIndexer', 'indexer');
      const result = await context.indexer[method](...(method === 'refreshHostNow' ? ['host'] : []));
      assert.deepEqual(result.errors || [], []);
      assert.equal(result.error || null, null);
      assert.equal(scans, changed ? 1 : 0);
      assert.deepEqual(batches, [[{ file: path.join(dir, 'root.jsonl'), parentSessionId: 'root', turnOnly: true }]],
        'every successful refresh batches the live head exactly once, even without a scan');
      assert.equal(pushes.length, 1);
      assert.equal(pushes[0].channel, 'task-snapshot');
      assert.equal(pushes[0].snapshot.headTurn.state, 'open');
      assert.deepEqual(pushes[0].snapshot.tasks, []);
      assert.equal(icon().title, 'Working · Running on host\nCLI status: busy');
    });
  }
}

test('real worker delivers turn evidence and task lifecycle together, including missing and empty tails', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'head-turn-625-'));
  const file = path.join(root, 'session.jsonl');
  const ctx = setupSidebarDom();
  const received = [];
  const client = createTaskRecordsClient({ onSnapshot: s => { received.push(s); ctx.emitTaskSnapshot(s); } });
  t.after(async () => { await client.dispose(); ctx.destroy(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  const id = fixture.parentSessionId;
  const row = { sessionId: id, status: 'busy', modified: stamp };
  ctx.window.activeSessionId = id;
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: [row] })], true);
  fs.writeFileSync(file, jsonl([prompt, fixture.use, fixture.launch, answer, duration]));
  await client.read(file, id);
  assert.equal(received.at(-1).headTurn?.state, 'closed');
  assert.equal(ctx.document.getElementById('si-' + id).querySelector('.session-icon').classList.contains('session-icon--agents-busy'), true);
  fs.appendFileSync(file, jsonl([prompt]));
  await client.read(file, id);
  assert.equal(received.at(-1).headTurn.state, 'open');
  fs.writeFileSync(file, '');
  await client.read(file, id);
  assert.equal(received.at(-1).headTurn.state, 'unknown');
  fs.unlinkSync(file);
  await client.read(file, id);
  assert.equal(received.at(-1).headTurn.state, 'unknown');
});
