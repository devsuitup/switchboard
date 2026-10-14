'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const transitions = require('../session-transitions');
const { mergeLocalBackgroundSessions } = require('../sidebar-bg-sessions');
const { parseJobState, mergeRoster } = require('../bg-agents-roster');

const OLD = '11111111-1111-4111-8111-111111111111';
const HEAD = '22222222-2222-4222-8222-222222222222';

function fixture(t, { exited = false, transcript = true, ambiguous = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-639-'));
  t.after(() => { transitions.init({ activeSessions: new Map() }); fs.rmSync(root, { recursive: true, force: true }); });
  const folder = 'project';
  fs.mkdirSync(path.join(root, folder));
  const records = [{ type: 'continued-in', sessionId: OLD, continuedInSessionId: HEAD }];
  const continuationSnapshot = transitions.snapshotContinuations(path.join(root, folder, OLD + '.jsonl'), OLD);
  if (ambiguous) records.push({ ...records[0], continuedInSessionId: '33333333-3333-4333-8333-333333333333' });
  fs.writeFileSync(path.join(root, folder, OLD + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  if (transcript) fs.writeFileSync(path.join(root, folder, HEAD + '.jsonl'), JSON.stringify({ type: 'user', sessionId: OLD }) + '\n');
  const entry = { projectFolder: folder, pty: { pid: 7 }, exited, continuationSnapshot, backgroundCommandSource: OLD,
    knownJsonlFiles: new Set([OLD + '.jsonl', HEAD + '.jsonl']) };
  const activeSessions = new Map([[OLD, entry]]), events = [], migrated = [], timers = [];
  let proof = { sessionId: HEAD, jobId: '1234abcd', kind: 'bg', cwd: root };
  transitions.init({ PROJECTS_DIR: root, activeSessions,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } }),
    log: { info() {}, debug() {} }, rekeyMcpServer() {}, clearOwner: () => 'other',
    getBackgroundTarget: id => id === HEAD ? proof : null,
    backgroundJobExists: () => true,
    rekeyMetadata: (...args) => migrated.push(args), setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
  });
  return { root, folder, entry, activeSessions, events, migrated, timers, setProof: value => { proof = value; } };
}

for (const options of [{}, { transcript: false }, { exited: true }]) {
  test(`a proven daemon continuation rekeys the original environment ${JSON.stringify(options)}`, t => {
    const h = fixture(t, options);
    transitions.detectSessionTransitions(h.folder);
    assert.equal(h.activeSessions.get(HEAD), h.entry);
    assert.equal(h.activeSessions.has(OLD), false);
    assert.deepEqual(h.migrated, [[OLD, HEAD, 'background']]);
    assert.deepEqual(h.events.find(event => event[0] === 'session-forked').slice(1, 4), [OLD, HEAD, 'background']);
  });
}

test('late background proof is reconsidered even when the transcript mtime stays unchanged', t => {
  const h = fixture(t);
  h.setProof(null);
  transitions.detectSessionTransitions(h.folder);
  assert.equal(h.activeSessions.get(OLD), h.entry);
  h.setProof({ sessionId: HEAD, kind: 'bg', jobId: '1234abcd' });
  transitions.detectSessionTransitions(h.folder);
  assert.equal(h.activeSessions.get(HEAD), h.entry);
});

test('ambiguous continuations and interactive strangers never authorize a background rekey', t => {
  const h = fixture(t, { ambiguous: true });
  transitions.detectSessionTransitions(h.folder);
  assert.equal(h.activeSessions.get(OLD), h.entry);
  h.setProof({ sessionId: HEAD, kind: 'interactive', jobId: '1234abcd' });
  transitions.detectSessionTransitions(h.folder);
  assert.equal(h.events.length, 0);
});

test('a typed /bg exit with an existing job holds a partial fresh tail until it completes', t => {
  const h = fixture(t, { exited: true, transcript: false });
  const file = path.join(h.root, h.folder, OLD + '.jsonl');
  fs.appendFileSync(file, '{"type":"assistant"');
  const exits = [];
  assert.equal(typeof transitions.holdContinuationExit, 'function');
  assert.equal(transitions.holdContinuationExit(OLD, h.entry, suppress => exits.push(suppress)), true);
  assert.deepEqual(exits, []);
  fs.appendFileSync(file, '}\n');
  transitions.detectSessionTransitions(h.folder);
  assert.deepEqual(exits, [true]);
  assert.equal(h.activeSessions.get(HEAD), h.entry);
});

test('a typed /bg exit survives a continuation beyond the first transcript scan chunk', t => {
  const h = fixture(t, { exited: true, transcript: false });
  const file = path.join(h.root, h.folder, OLD + '.jsonl');
  const link = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(2 * 1024 * 1024) } }) + '\n' + link);
  const exits = [];
  assert.equal(transitions.holdContinuationExit(OLD, h.entry, suppress => exits.push(suppress)), true);
  for (let n = 0; n < 5 && !h.activeSessions.has(HEAD); n++) {
    const next = h.timers.findIndex(timer => timer.ms < 15000);
    assert.notEqual(next, -1);
    h.timers.splice(next, 1)[0].fn();
  }
  assert.equal(h.activeSessions.get(HEAD), h.entry);
  assert.deepEqual(exits, [true]);
});

test('background rekey writes an activity trace after Diagnostics is enabled at runtime', async t => {
  const h = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-trace-639-'));
  const trace = require('../activity-trace');
  try {
    trace.init(dir);
    trace.setEnabled(true);
    transitions.detectSessionTransitions(h.folder);
    const file = trace.currentFile();
    await new Promise(resolve => trace.setEnabled(false, resolve));
    const events = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(events.some(event => event.cat === 'session.forked' && event.kind === 'background' && event.jobId === '1234abcd'));
  } finally { await new Promise(resolve => trace.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sidebar keeps one original conversation under its background UUID and original title', () => {
  const row = { sessionId: OLD, folder: 'project', projectPath: '/project', name: 'JB rename', summary: 'original', messageCount: 2,
    continuationIndex: JSON.stringify({ format: 3, complete: true, ids: [HEAD] }) };
  const child = { sessionId: HEAD, folder: 'project', name: 'daemon (2)', summary: 'copied', messageCount: 3 };
  const projects = [{ projectPath: '/project', sessions: [row, child] }];
  mergeLocalBackgroundSessions(projects, [row, child], [{ sessionId: HEAD, kind: 'bg', jobId: '1234abcd', name: 'daemon (2)', nameSource: 'collision' }],
    { hiddenProjects: new Set(), metaMap: new Map([[HEAD, { name: 'JB rename', starred: 1, archived: 1 }]]), showArchived: true,
      jobs: new Map([['1234abcd', { state: 'working', name: 'daemon (2)', nameSource: 'collision' }]]) });
  assert.equal(projects[0].sessions.length, 1);
  assert.equal(row.sessionId, HEAD);
  assert.equal(row.name, 'JB rename');
  assert.equal(row.bgSessionId, HEAD);
  assert.ok(row.mergedMemberIds.includes(OLD));
});

test('a reindexed predecessor title yields to the name migrated to its background head', () => {
  const row = { sessionId: OLD, folder: 'project', projectPath: '/project', name: 'original title', customTitle: 'original title', messageCount: 2,
    continuationIndex: JSON.stringify({ format: 3, complete: true, ids: [HEAD] }) };
  const projects = [{ projectPath: '/project', sessions: [row] }];
  mergeLocalBackgroundSessions(projects, [row], [{ sessionId: HEAD, kind: 'bg', jobId: '1234abcd', name: 'original title (2)', nameSource: 'collision' }],
    { hiddenProjects: new Set(), metaMap: new Map([[OLD, { name: 'original title' }], [HEAD, { name: 'JB rename' }]]), showArchived: false,
      jobs: new Map([['1234abcd', { state: 'working', nameSource: 'collision' }]]) });
  assert.equal(row.name, 'JB rename');
});

test('the archive filter follows metadata migrated to the background UUID before its first turn', () => {
  const row = { sessionId: OLD, folder: 'project', projectPath: '/project', name: 'original', messageCount: 2,
    continuationIndex: JSON.stringify({ format: 3, complete: true, ids: [HEAD] }) };
  const projects = [{ projectPath: '/project', sessions: [row] }];
  mergeLocalBackgroundSessions(projects, [row], [{ sessionId: HEAD, kind: 'bg', jobId: '1234abcd', nameSource: 'collision' }],
    { hiddenProjects: new Set(), metaMap: new Map([[HEAD, { name: 'original', archived: 1 }]]), showArchived: false,
      jobs: new Map([['1234abcd', { state: 'working' }]]) });
  assert.equal(projects.flatMap(project => project.sessions).length, 0);
});

test('collision job names are suppressed even when the CLI list repeats them', () => {
  const job = parseJobState(JSON.stringify({ state: 'working', sessionId: HEAD, name: 'original (2)', nameSource: 'collision', respawnFlags: ['--name', 'original (2)'] }));
  const roster = mergeRoster({ cli: [{ kind: 'background', id: '1234abcd', sessionId: HEAD, name: 'original (2)' }],
    jobs: new Map([['1234abcd', job]]), descriptors: [{ kind: 'bg', jobId: '1234abcd', sessionId: HEAD, name: 'original (2)', nameSource: 'collision' }] });
  assert.equal(roster[0].name, null);
});

test('SQLite copies original metadata atomically without persisting a title fallback', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-meta-639-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict');
    const db = require('./db');
    db.setName('${OLD}', 'JB rename'); db.toggleStar('${OLD}'); db.setArchived('${OLD}', true);
    db.setName('${HEAD}', 'daemon (2)');
    assert.equal(typeof db.rekeySessionMeta, 'function');
    db.rekeySessionMeta('${OLD}', '${HEAD}', 'original title');
    assert.deepEqual(db.getMeta('${HEAD}'), { sessionId: '${HEAD}', name: 'daemon (2)', starred: 1, archived: 1 });
    assert.deepEqual(db.getMeta('${OLD}'), { sessionId: '${OLD}', name: 'JB rename', starred: 1, archived: 1 });
    db.rekeySessionMeta('no-meta', 'new-meta', 'original title');
    assert.equal(db.getMeta('new-meta'), null);
    db.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a daemon collision custom-title refresh cannot overwrite the migrated Switchboard name', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-refresh-639-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
    const db = require('./db'), cache = require('./session-cache');
    const root = process.env.SWITCHBOARD_DATA_DIR, folder = require('./encode-project-path').encodeProjectPath(root), projects = path.join(root, 'projects');
    fs.mkdirSync(path.join(projects, folder), { recursive: true });
    db.setFolderMeta(folder, root, 0);
    db.setName('${OLD}', 'JB rename'); db.rekeySessionMeta('${OLD}', '${HEAD}', 'original');
    fs.writeFileSync(path.join(projects, folder, '${HEAD}.jsonl'), [
      { type: 'custom-title', sessionId: '${HEAD}', customTitle: 'daemon (2)' },
      { type: 'user', sessionId: '${HEAD}', cwd: root, timestamp: '2026-10-14T00:00:00Z', message: { content: 'prompt' } }
    ].map(JSON.stringify).join('\\n') + '\\n');
    cache.init({ PROJECTS_DIR: projects, activeSessions: new Map(), getMainWindow: () => null, db,
      getLocalDescriptors: () => [{ sessionId: '${HEAD}', kind: 'bg', jobId: '1234abcd', nameSource: 'collision', name: 'daemon (2)' }],
      getLocalJobs: () => new Map([['1234abcd', { sessionId: '${HEAD}', state: 'working', nameSource: 'collision' }]]),
      log: { info() {}, warn() {}, error() {}, debug() {} } });
    cache.refreshFolder(folder);
    assert.equal(db.getMeta('${HEAD}').name, 'JB rename');
    assert.equal(cache.buildProjectsFromCache(false)[0].sessions[0].name, 'JB rename');
    db.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
