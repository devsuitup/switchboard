'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { classifyTranscriptTail } = require('../transcript-turn');
const { createTaskRecordsClient } = require('../task-records-client');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');
const at = n => new Date(1_800_000_000_000 + n).toISOString();
const user = (text, n = 1) => ({ type: 'user', timestamp: at(n), message: { role: 'user', content: text } });
const assistant = (stop, n = 2) => ({ type: 'assistant', timestamp: at(n), message: { role: 'assistant', content: [], stop_reason: stop } });
const duration = { type: 'system', subtype: 'turn_duration', timestamp: at(3) };
const jsonl = entries => entries.map(e => JSON.stringify(e)).join('\n') + '\n';
const closed = [user('Work'), assistant('end_turn'), duration];

for (const content of ['[Request interrupted by user]', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]]) {
  test('an interrupted request closes without turn_duration: ' + JSON.stringify(content), () => {
    assert.equal(classifyTranscriptTail(jsonl([user('Work'), user(content, 4)])).state, 'closed');
  });
}
test('an API error closes without turn_duration', () => {
  for (const entry of [{ ...assistant('stop_sequence'), isApiErrorMessage: true }, { ...assistant(null), isApiErrorMessage: true, error: 'overloaded' }]) {
    assert.equal(classifyTranscriptTail(jsonl([user('Work'), entry])).state, 'closed');
  }
});
test('a task notification at rest does not reopen the closed turn, including real content blocks', () => {
  for (const content of ['<task-notification><task-id>x</task-id><status>completed</status></task-notification>', fixture.notification.message.content]) {
    assert.equal(classifyTranscriptTail(jsonl([...closed, user(content, 4)])).state, 'closed');
  }
});
test('queued and dequeued prompts reopen a closed turn', () => {
  for (const operation of ['enqueue', 'dequeue']) {
    assert.equal(classifyTranscriptTail(jsonl([...closed, { type: 'queue-operation', operation, timestamp: at(4), content: 'next' }])).state, 'open');
  }
});
test('local commands and manual compaction close; automatic compaction preserves an in-progress turn', () => {
  assert.equal(classifyTranscriptTail(jsonl([user('Work'), user('<local-command-stdout>ok</local-command-stdout>', 4)])).state, 'closed');
  for (const trigger of ['manual', 'auto']) {
    const entries = [user('Work'), { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger }, timestamp: at(4) }, { ...user('Summary', 5), isCompactSummary: true }];
    assert.equal(classifyTranscriptTail(jsonl(entries)).state, trigger === 'manual' ? 'closed' : 'open');
  }
  assert.equal(classifyTranscriptTail(jsonl([{ ...user('Summary'), isCompactSummary: true }])).state, 'unknown');
});

function sidebar(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.activeSessionId = 'root';
  const row = { sessionId: 'root', status: 'busy', modified: at(1) };
  ctx.window.sessionMap.set('root', row);
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: [row] })], true);
  let revision = 0;
  const turn = (state, lastEntryAt = 1_800_000_000_001) => ctx.emitTaskSnapshot({ parentSessionId: 'root', revision: ++revision, tasks: [], headTurn: { sessionId: 'root', revision, state, lastEntryAt } });
  const icon = () => ctx.document.querySelector('#si-root .session-icon');
  return { ctx, turn, icon };
}
test('a newer descriptor idle neutralises open evidence, while newer transcript evidence wins', t => {
  const { ctx, turn, icon } = sidebar(t);
  ctx.window.sessionMap.set('root', { sessionId: 'root', status: 'idle', statusUpdatedAt: 1_800_000_000_010 });
  turn('open');
  assert.equal(icon().title, 'Waiting for input');
  turn('open', 1_800_000_000_020);
  assert.equal(icon().title, 'Working');
});
test('OSC idle is ordered against local head observation; stale progress and decay cannot resurrect Working', t => {
  const { ctx, turn, icon } = sidebar(t);
  ctx.window.activePtyIds.add('root');
  ctx.window.Date.now = () => 1_800_000_000_001;
  turn('open');
  ctx.window.Date.now = () => 1_800_000_000_010;
  ctx.setActivity('root', false, 'onCliBusyState');
  assert.equal(icon().title, 'Waiting for input');
  ctx.setActivity('root', true, 'onCliBusyState');
  assert.equal(icon().title, 'Waiting for input');
  ctx.window.Date.now = () => 1_800_000_000_020;
  turn('open', 1_800_000_000_020);
  assert.equal(icon().title, 'Working');
  ctx.setActivity('root', false, 'onCliBusyState', { at: 1_800_000_000_015 });
  assert.equal(icon().title, 'Working');
});
test('projection is pure, attention consumes the ready glyph while unseen title writing survives', t => {
  const { ctx, turn, icon } = sidebar(t);
  ctx.window.activeSessionId = 'elsewhere';
  turn('open'); turn('closed');
  ctx.window.noteWrittenActivity('root');
  assert.equal(icon().title, 'Response ready');
  const before = JSON.stringify(ctx.read('headTurns.get("root")'));
  ctx.window.headActivitySnapshot('root', { attention: true, liveness: 'alive' });
  assert.equal(JSON.stringify(ctx.read('headTurns.get("root")')), before);
  ctx.window.setAttention('root', true);
  ctx.window.setAttention('root', false);
  assert.equal(icon().title, 'Waiting for input');
  assert.equal(ctx.document.querySelector('#si-root').classList.contains('unseen-written-activity'), true);
});
test('the slot exposes accessible text on initial paint and incremental updates', t => {
  const { turn, icon } = sidebar(t);
  assert.equal(icon().getAttribute('aria-label'), 'Turn state unavailable');
  assert.equal(icon().getAttribute('role'), 'img');
  turn('open');
  assert.equal(icon().getAttribute('aria-label'), 'Working');
});
test('blocked Agents jobs suppress an open head even when the descriptor says busy', t => {
  const { ctx, turn } = sidebar(t);
  ctx.evalPublic('agents-view.js'); turn('open');
  ctx.window.taskRegistry.note('root', 'shell', 'cli-task', { kind: 'shell' });
  for (const status of ['idle', null, 'busy']) {
    assert.equal(ctx.window.agentRowIcon({ sessionId: 'root', kind: 'background', state: 'blocked', hosted: true, status }).slotClass, 'session-icon--attention');
  }
});
test('Agents background idle descriptor cannot close a validated head turn', t => {
  const { ctx, turn } = sidebar(t);
  ctx.evalPublic('agents-view.js');
  const entry = { sessionId: 'root', kind: 'background', state: 'working', hosted: true, status: 'idle', statusUpdatedAt: 1_800_000_000_010 };
  turn('open');
  assert.equal(ctx.window.agentRowIcon(entry).slotClass, 'session-icon--busy');
  turn('open', 1_800_000_000_020);
  assert.equal(ctx.window.agentRowIcon(entry).slotClass, 'session-icon--busy');
});
test('static spinner explicitly cancels animation on its element and pseudo-element', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  for (const selector of ['.session-icon--agents-busy', '.session-icon--agents-busy::before']) {
    const rule = css.slice(css.indexOf(selector + ' {')).split('}')[0];
    assert.match(rule, /animation:\s*none/);
  }
});
test('grid dots use head evidence, ignore OSC progress and show static background work', t => {
  const { ctx, turn } = sidebar(t);
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
  const card = ctx.document.createElement('div');
  card.innerHTML = '<span class="grid-card-dot"></span>';
  ctx.window.registerGridCard('root', card);
  ctx.read('globalThis._lastPtySignature = ""');
  ctx.window.renderDefaultStatus = () => {};
  loadAppFunctions(ctx.context, { functions: ['updateRunningIndicators'], installSpies: false });
  ctx.window.activePtyIds.add('root');
  turn('open'); ctx.window.updateRunningIndicators();
  assert.ok(card.querySelector('.grid-card-dot').classList.contains('session-icon--busy'));
  turn('closed'); ctx.setActivity('root', true, 'onCliBusyState'); ctx.window.updateRunningIndicators();
  assert.ok(!card.querySelector('.grid-card-dot').classList.contains('session-icon--busy'));
});
test('real worker and DOM sequence: prompt, silent tool, closed background shell, later prompt', async t => {
  const { ctx, icon } = sidebar(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-head-638b-'));
  const file = path.join(dir, 'root.jsonl');
  const client = createTaskRecordsClient({ onSnapshot: s => ctx.emitTaskSnapshot(s) });
  t.after(async () => { await client.dispose(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const entries = [user('Work')];
  const read = async () => { fs.writeFileSync(file, jsonl(entries)); await client.read(file, 'root'); return icon().title; };
  assert.equal(await read(), 'Working');
  entries.push({ ...assistant('tool_use'), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_sync', name: 'Bash', input: { command: 'sleep 60' } }] } });
  assert.equal(await read(), 'Working');
  entries.push(fixture.use, fixture.launch, assistant('end_turn'), duration);
  assert.equal(await read(), 'Background work running');
  entries.push(user('Later prompt', 10));
  assert.equal(await read(), 'Working');
  ctx.window.taskRegistry.end('root', fixture.agentId);
  entries.push(assistant('end_turn', 11), { ...duration, timestamp: at(12) });
  assert.equal(await read(), 'Waiting for input');
  for (const kind of ['shell', 'monitor', 'cron']) {
    ctx.window.taskRegistry.note('root', kind, 'cli-task', { kind });
    assert.equal(icon().title, 'Background work running');
    assert.ok(icon().classList.contains('session-icon--agents-busy'));
    assert.equal(ctx.window.taskRegistry.agents('root').length, 0);
    ctx.window.taskRegistry.end('root', kind);
  }
  assert.equal(ctx.window.taskRegistry.agents('root').length, 0);
});
test('worker turn retention caps at 2048, evicts oldest first and retains the latest timestamps', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-cap-638b-'));
  const file = path.join(dir, 'root.jsonl');
  const client = createTaskRecordsClient();
  t.after(async () => { await client.dispose(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  fs.writeFileSync(file, jsonl([user('Work')]));
  for (let i = 0; i < 2049; i++) await client.read(file, 's' + i, { turnOnly: true });
  await client.ownerAlive('s0');
  assert.equal(client.snapshots().find(s => s.parentSessionId === 's0').headTurn, undefined);
  assert.equal(client.snapshots().find(s => s.parentSessionId === 's2048').headTurn.lastEntryAt, 1_800_000_000_001);
});
test('real cached rows batch only live remote heads, excluding local, archived, dead and child rows', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-head-698-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const { extractFunction } = require('./test/app-source');
    const { parseFolderKey } = require('./remote-hosts');
    const store = require('./session-index-store').openSessionIndexStore({ readonly: false });
    const root = process.env.SWITCHBOARD_DATA_DIR;
    const row = (sessionId, folder, extra = {}) => ({ sessionId, folder,
      projectPath: '/p', summary: '', firstPrompt: '', created: null, modified: null, ...extra });
    store.upsertCachedSessions([
      row('live', 'dev::-p'), row('local', '-p'),
      row('child', 'dev::-p', { parentSessionId: 'live', agentId: 'child' }),
      row('archived', 'dev::-p'), row('dead', 'dev::-p'), row('other', 'dev2::-p'),
    ]);
    store.setArchived('archived', true);
    assert.equal(store.getMeta('live'), null);
    assert.equal(store.getAllMeta().get('archived').archived, 1);
    const batches = [];
    const hosts = [];
    const context = vm.createContext({ path, ...store, parseFolderKey,
      remoteIndexer: { getRemoteSessions: alias => {
        hosts.push(alias);
        return { sessions: (alias === 'dev' ? ['live', 'child', 'archived', 'local'] : ['other']).map(sessionId => ({ sessionId })) };
      } },
      projectsDirForFolder: folder => path.join(root, 'mirror', folder),
      taskRecords: { readBatch: async rows => batches.push(Array.from(rows, r => ({ ...r }))) },
    });
    const source = fs.readFileSync('./main.js', 'utf8');
    vm.runInContext(extractFunction(source, 'refreshRemoteHeadTurns'), context);
    (async () => {
      try {
        await context.refreshRemoteHeadTurns('dev');
        assert.deepEqual(batches, [[{
          file: path.join(root, 'mirror', 'dev::-p', 'live.jsonl'),
          parentSessionId: 'live', turnOnly: true,
        }]], 'only the live remote head from real cache rows enters the batch');
        assert.deepEqual(hosts, ['dev']);
        batches.length = 0;
        await context.refreshRemoteHeadTurns();
        assert.deepEqual(batches.map(rows => rows.map(r => r.parentSessionId).sort()), [['live', 'other']]);
        store.setArchived('live', true);
        batches.length = 0;
        await context.refreshRemoteHeadTurns('dev');
        assert.deepEqual(batches, [], 'an archive change is read from current session metadata');
        store.setArchived('live', false);
        await context.refreshRemoteHeadTurns('dev');
        assert.equal(batches[0][0].parentSessionId, 'live');
      } finally { store.closeDb(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root, HOME: root, USERPROFILE: root },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});
