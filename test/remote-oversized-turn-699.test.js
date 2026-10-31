'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSshTransport, SESSIONS_MARKER, ALIVE_MARKER_PREFIX } = require('../src/main/remote/remote-transport');
const { createRemoteIndexer, refreshRemoteHeadTurns } = require('../src/main/remote/remote-index');
const { createTaskRecordsClient } = require('../task-records-client');
const { enumerateSessionFiles, resolveJsonlPath } = require('../read-session-file');
const { mirrorProjectsDirFor } = require('../src/main/remote/remote-hosts');

const ID = '11111111-1111-4111-8111-111111111111';
const REL = `-srv-a/${ID}.jsonl`;
const WINDOW = 256 * 1024;
const entry = value => JSON.stringify(value) + '\n';
const open = entry({ type: 'user', timestamp: '2026-10-30T12:00:00Z', message: { role: 'user', content: 'work' } });
const closed = open + entry({ type: 'assistant', timestamp: '2026-10-30T12:00:01Z', message: { role: 'assistant', content: 'done', stop_reason: 'end_turn' } })
  + entry({ type: 'system', subtype: 'turn_duration', timestamp: '2026-10-30T12:00:02Z' });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-699-'));
  const state = { size: 209 * 1024 * 1024, mtime: 1793361600000, content: open, live: true, present: true, fail: false, commands: [], cached: [], meta: new Map() };
  const transport = createSshTransport({ resolveSshPath: () => 'fixture-ssh', resolveScpPath: () => 'fixture-scp', spawn(command, args) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.emit('close', -1); };
    const remote = args.at(-1);
    state.commands.push({ command, remote });
    setImmediate(() => {
      if (remote.startsWith('find ')) {
        const inventory = state.present ? `${state.mtime / 1000}\t${state.size}\t${REL}\n` : '';
        const descriptor = state.live ? entry({ pid: 42, sessionId: ID, cwd: '/srv/a', startedAt: 1793361500000 }) + `${ALIVE_MARKER_PREFIX}1\n` : '';
        child.stdout.end(inventory + SESSIONS_MARKER + '\n' + descriptor);
      } else if (remote.startsWith('if command')) child.stdout.end('tmux=1\ninotifywait=0\n');
      else if (remote.startsWith('tail -c ')) {
        if (state.fail) { child.stderr.end('fixture disconnected'); child.emit('close', 255); return; }
        const bytes = Number(remote.match(/^tail -c (\d+) /)?.[1]);
        assert.ok(bytes > 0 && bytes <= WINDOW + 1, 'remote tail must have a fixed byte ceiling');
        child.stdout.end(Buffer.concat([Buffer.alloc(WINDOW + 1, 120), Buffer.from('\n' + state.content)]).subarray(-bytes));
      } else if (command === 'fixture-scp') {
        fs.mkdirSync(path.dirname(remote), { recursive: true });
        fs.writeFileSync(remote, state.content);
        child.stdout.end();
      } else throw new Error(`unexpected command ${remote}`);
      child.emit('close', 0);
    });
    return child;
  } });
  const client = createTaskRecordsClient({ onError: error => assert.fail(error) });
  const scans = [];
  const logs = [];
  const notifications = [];
  const ctx = {
    getAllCached: () => state.cached, getAllMeta: () => state.meta,
    projectsDirForFolder: () => path.join(mirrorProjectsDirFor(dir, 'vps'), '-srv-a'),
    getRemoteSessions: alias => indexer.getRemoteSessions(alias),
    getRemoteHeadTurnFiles: alias => indexer.getRemoteHeadTurnFiles?.(alias) || [],
    readBatch: rows => client.readBatch(rows),
  };
  const indexer = createRemoteIndexer({
    dataDir: dir, getHosts: () => [{ alias: 'vps' }], transport,
    scanFolders: async args => { scans.push(args); return { ok: true }; },
    listIndexedFolderKeys: () => [],
    notify: () => notifications.push(true),
    refreshHeadTurns: alias => refreshRemoteHeadTurns(ctx, alias),
    log: { info: value => logs.push(value), warn: value => logs.push(value) },
  });
  t.after(async () => { indexer.dispose(); await client.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, client, indexer, ctx, scans, logs, notifications };
}

test('oversized remote transcript supplies open then closed head turns through the real worker', async t => {
  const f = fixture(t);
  await f.indexer.refreshNow();
  assert.equal(f.client.snapshots().find(s => s.parentSessionId === ID)?.headTurn?.state || 'unknown', 'open');
  assert.equal(f.indexer.getPlaceholderSessions('vps')[0]?.sessionId, ID, 'a never-mirrored live session remains visible');
  f.state.content = closed;
  f.state.mtime += 3000;
  f.state.size += 300;
  await f.indexer.refreshHostNow('vps');
  const snapshot = f.client.snapshots().find(s => s.parentSessionId === ID);
  assert.equal(snapshot.headTurn.state, 'closed');
  assert.equal(snapshot.headTurn.mtimeMs, f.state.mtime, 'turn evidence keeps the host clock');
  assert.deepEqual(snapshot.tasks, [], 'tail reads cannot replay tasks');
});

test('partial turn cache never becomes a complete transcript or indexing input', async t => {
  const f = fixture(t);
  await f.indexer.refreshNow();
  const tails = f.indexer.getRemoteHeadTurnFiles?.('vps') || [];
  assert.equal(tails.length, 1, 'a separate partial cache is available');
  const projects = mirrorProjectsDirFor(f.dir, 'vps');
  assert.equal(path.relative(projects, tails[0].file).startsWith('..'), true);
  assert.ok(fs.statSync(tails[0].file).size <= WINDOW);
  assert.equal(fs.readFileSync(tails[0].file, 'utf8'), open, 'discard the cut first JSONL record');
  assert.deepEqual(enumerateSessionFiles(projects), []);
  assert.deepEqual(f.scans, [], 'no search, metrics, counts or continuation scan receives the tail');
  assert.equal(fs.existsSync(resolveJsonlPath(projects, { folder: '-srv-a', sessionId: ID })), false, 'viewer cannot resolve a partial tail as a transcript');
  assert.ok(f.logs.some(line => line.includes('turn-state tail')));
  assert.ok(!f.logs.some(line => line.includes('skipped: over')));
  const before = fs.readFileSync(tails[0].file);
  await f.indexer.refreshNow();
  assert.equal(f.state.commands.filter(c => c.remote.startsWith('tail -c ')).length, 1, 'unchanged inventory does not refetch');
  assert.deepEqual(fs.readFileSync(tails[0].file), before);
  const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
  const dom = setupSidebarDom();
  try {
    const session = { ...f.indexer.getPlaceholderSessions('vps')[0], remoteAttachable: true };
    dom.window.sessionMap.set(ID, session);
    dom.sidebar.renderProjects([makeSampleProject({ projectPath: '/srv/a', folder: 'vps::-srv-a', remoteAlias: 'vps', sessions: [session] })], true);
    const row = dom.document.getElementById('si-' + ID);
    assert.ok(row, 'the oversized head is shown as a live placeholder');
    assert.equal(row.querySelector('.session-jsonl-btn'), null, 'partial evidence offers no complete-transcript action');
  } finally { dom.destroy(); }
});

test('failed tails retry without growing disk, and inactive tails are removed', async t => {
  const f = fixture(t);
  await f.indexer.refreshNow();
  const tails = f.indexer.getRemoteHeadTurnFiles?.('vps') || [];
  assert.equal(tails.length, 1);
  const before = fs.readFileSync(tails[0].file);
  f.state.content = closed;
  f.state.mtime += 3000;
  f.state.fail = true;
  await f.indexer.refreshNow();
  assert.deepEqual(fs.readFileSync(tails[0].file), before);
  f.state.fail = false;
  await f.indexer.refreshNow();
  assert.equal(f.client.snapshots()[0].headTurn.state, 'closed');
  assert.ok(fs.statSync(tails[0].file).size <= WINDOW);
  f.state.live = false;
  await f.indexer.refreshNow();
  assert.equal(fs.existsSync(tails[0].file), false);
  assert.deepEqual(f.indexer.getRemoteHeadTurnFiles('vps'), []);
});

test('turn tails override stale complete mirrors and respect archive and bootstrap filtering', async t => {
  const f = fixture(t);
  const complete = path.join(mirrorProjectsDirFor(f.dir, 'vps'), REL);
  fs.mkdirSync(path.dirname(complete), { recursive: true });
  fs.writeFileSync(complete, closed);
  f.state.cached = [{ sessionId: ID, folder: 'vps::-srv-a' }];
  await f.indexer.refreshNow();
  assert.equal(f.client.snapshots()[0].headTurn.state, 'open', 'latest remote tail wins over the old full copy');
  assert.equal(fs.readFileSync(complete, 'utf8'), closed, 'a complete historical snapshot is preserved');
  const batches = [];
  f.state.meta.set(ID, { archived: true });
  await refreshRemoteHeadTurns({ ...f.ctx, readBatch: async rows => batches.push(rows) });
  assert.deepEqual(batches, [], 'bootstrap must exclude archived tail-only heads too');
  f.state.meta.clear();
  await refreshRemoteHeadTurns({ ...f.ctx, readBatch: async rows => batches.push(rows) });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1, 'one head read even when both a tail and a cached full row exist');
  assert.ok(batches[0][0].file.endsWith('.tail'));
});

test('same-size rewrites refetch tails; shrinking back under the cap restores complete mirroring', async t => {
  const f = fixture(t);
  await f.indexer.refreshNow();
  const tail = f.indexer.getRemoteHeadTurnFiles('vps')[0].file;
  f.state.content = closed;
  f.state.mtime += 3000;
  await f.indexer.refreshNow();
  assert.equal(f.client.snapshots()[0].headTurn.state, 'closed');
  assert.equal(f.state.commands.filter(c => c.remote.startsWith('tail -c ')).length, 2);
  f.state.size = Buffer.byteLength(closed);
  f.state.mtime += 3000;
  await f.indexer.refreshNow();
  assert.deepEqual(f.indexer.getRemoteHeadTurnFiles('vps'), []);
  assert.equal(fs.existsSync(tail), false);
  assert.equal(fs.readFileSync(path.join(mirrorProjectsDirFor(f.dir, 'vps'), REL), 'utf8'), closed);
  assert.ok(f.scans.length > 0, 'complete transcript enters normal indexing after shrinking');
});

test('tail transport rejects invalid paths and excessive output without replacing existing bytes', async t => {
  const f = fixture(t);
  await f.indexer.refreshNow();
  const file = f.indexer.getRemoteHeadTurnFiles('vps')[0].file;
  const before = fs.readFileSync(file);
  let calls = 0;
  const transport = createSshTransport({ resolveSshPath: () => 'fixture-ssh', spawn() {
    calls++;
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('close', -1);
    setImmediate(() => child.stdout.end(Buffer.alloc(WINDOW + 2)));
    return child;
  } });
  t.after(() => transport.dispose());
  await assert.rejects(transport.readTurnTail('vps', { rel: '../escape.jsonl', mtimeMs: 1 }, file), /invalid/);
  assert.equal(calls, 0);
  await assert.rejects(transport.readTurnTail('vps', { rel: REL, mtimeMs: 1 }, file), /size cap/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(file + '.part'), false);
});

test('a persisted tail cache is reused by a fresh indexer without remote bytes', async t => {
  const f = fixture(t);
  await f.indexer.refreshNow();
  let tailReads = 0;
  const transport = {
    listFiles: async () => ({ files: [{ rel: REL, size: f.state.size, mtimeMs: f.state.mtime }], sessions: [{ sessionId: ID, cwd: '/srv/a' }] }),
    readTurnTail: async () => { tailReads++; throw new Error('must use cached bytes'); },
  };
  const indexer = createRemoteIndexer({ dataDir: f.dir, getHosts: () => [{ alias: 'vps' }], transport });
  t.after(() => indexer.dispose());
  await indexer.refreshNow();
  assert.equal(tailReads, 0);
  assert.equal(indexer.getRemoteHeadTurnFiles('vps').length, 1);
});

test('partial tails feed only turn state even when they contain background task records', async t => {
  const f = fixture(t);
  const task = require('./fixtures/cli-tasks-2.1.296.json');
  f.state.content = open + entry(task.use) + entry(task.launch);
  await f.indexer.refreshNow();
  const snapshot = f.client.snapshots().find(s => s.parentSessionId === ID);
  assert.equal(snapshot?.headTurn?.state, 'open');
  assert.deepEqual(snapshot.tasks, [], 'partial task history must not be presented as a complete task snapshot');
});

test('tail pass caps changed heads at 200 and ignores subagents and inactive transcripts', async t => {
  const { syncTurnTails } = require('../src/main/remote/remote-turn-tails');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-699-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = Array.from({ length: 201 }, (_, i) => ({ sessionId: 'head-' + i }));
  const oversizedFiles = sessions.map(s => ({ rel: `-srv-a/${s.sessionId}.jsonl`, size: 209 * 1024 * 1024, mtimeMs: 1000 }));
  oversizedFiles.unshift({ rel: '-srv-a/dead.jsonl', size: 209 * 1024 * 1024, mtimeMs: 1000 },
    { rel: '-srv-a/head-0/subagents/head-1.jsonl', size: 209 * 1024 * 1024, mtimeMs: 1000 });
  let reads = 0;
  const args = { alias: 'vps', projectsDir: path.join(dir, 'projects'), sessions, oversizedFiles,
    log: { info() {}, warn: message => assert.fail(message) },
    transport: { async readTurnTail(_alias, _request, file) {
      reads++;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, open);
    } } };
  const rows = await syncTurnTails(args);
  assert.equal(reads, 200);
  assert.equal(rows.length, 200);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'turn-state/inventory.json'), 'utf8'));
  assert.equal(Object.keys(manifest.files).length, 200);
  assert.ok(Object.values(manifest.files).every(meta => meta.partial === true));
  await syncTurnTails(args);
  assert.equal(reads, 200, 'unchanged pull transfers no additional bytes');
});

test('a never-mirrored oversized head appearing after an idle pull notifies the sidebar once', async t => {
  const f = fixture(t);
  f.state.live = false;
  await f.indexer.refreshNow();
  const before = f.notifications.length;
  f.state.live = true;
  await f.indexer.refreshNow();
  assert.equal(f.notifications.length, before + 1, 'new placeholder must appear without an unrelated indexed change');
  await f.indexer.refreshNow();
  assert.equal(f.notifications.length, before + 1, 'unchanged tail and placeholder must not trigger extra reloads');
});
