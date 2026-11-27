'use strict';

const test = require('node:test');
require('./fixtures/isolated-codex-home.cjs')(test);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');
const { readMessageCount, lastConversationAt } = require('../src/main/session-index/message-count');

const A = 'aaaaaaaa-0000-4000-8000-000000001282';
const B = 'bbbbbbbb-0000-4000-8000-000000001282';
const C = 'cccccccc-0000-4000-8000-000000001282';
const OLD = '2026-11-19T08:00:00.000Z';
const NEW = '2026-11-25T17:53:41.722Z';
const LATER = '2026-11-26T09:00:00.000Z';
const line = entry => JSON.stringify(entry) + '\n';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-row-head-1282-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project');
  const projectsDir = path.join(root, 'projects');
  const folder = encodeProjectPath(projectPath);
  const dir = path.join(projectsDir, folder);
  fs.mkdirSync(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const rows = new Map(), meta = new Map(), settings = new Map();
  const db = {
    getCachedByFolder: key => [...rows.values()].filter(r => r.folder === key),
    getAllCached: () => [...rows.values()], getAllMeta: () => new Map(), getAllFolderMeta: () => meta,
    getFolderMeta: key => meta.get(key), getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, value),
    getMeta: () => null, setName() {}, isInitialScanComplete: () => true,
    setFolderMeta: (key, projectPath, indexMtimeMs) => meta.set(key, { projectPath, indexMtimeMs }),
    upsertCachedSessions: fresh => fresh.forEach(r => rows.set(r.sessionId, { ...r })),
    deleteCachedSession: id => rows.delete(id), deleteCachedFolder() {}, deleteSearchFolder() {}, deleteSearchSession() {},
    upsertSearchEntries() {}, replaceSessionMetrics() {}, setTranscriptName() {}, setCachedFileSize() {},
    touchCachedModified: (id, modified, fileMtime = modified) => Object.assign(rows.get(id), { modified, fileMtime }),
  };
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db });
  cache.setRemoteRoots(new Map());
  t.after(() => cache.setRemoteRoots(new Map()));
  let tick = Date.parse('2026-11-26T10:00:00.000Z');
  const file = id => path.join(dir, id + '.jsonl');
  const stamp = id => { tick += 60000; fs.utimesSync(file(id), new Date(tick), new Date(tick)); };
  const user = (id, timestamp, content = 'fixture') => ({ type: 'user', uuid: id + timestamp, sessionId: id, cwd: projectPath, timestamp, message: { content } });
  const write = (id, entries) => { fs.writeFileSync(file(id), entries.map(line).join('')); stamp(id); };
  const append = (id, entries) => { fs.appendFileSync(file(id), entries.map(line).join('')); stamp(id); };
  const refresh = ids => cache.refreshFolder(folder, ids ? { files: new Set(ids.map(id => id + '.jsonl')) } : undefined);
  const row = id => cache.buildProjectsFromCache(false).flatMap(p => p.sessions).find(s => [s.sessionId, ...(s.mergedMemberIds || [])].includes(id));
  return { rows, file, user, write, append, refresh, row };
}

function rolled(t, extraA = []) {
  const f = fixture(t);
  f.write(A, [f.user(A, OLD), { type: 'continued-in', sessionId: A, continuedInSessionId: B, timestamp: OLD }, ...extraA]);
  f.write(B, [f.user(B, NEW)]);
  f.refresh();
  return f;
}

const METADATA = [
  ['custom-title', { type: 'custom-title', customTitle: 'Renamed', sessionId: A }],
  ['ai-title', { type: 'ai-title', aiTitle: 'Retitled', sessionId: A }],
  ['last-prompt', { type: 'last-prompt', lastPrompt: 'fixture', sessionId: A }],
  ['summary', { type: 'summary', summary: 'Recap', leafUuid: 'leaf' }],
  ['queue-operation', { type: 'queue-operation', operation: 'enqueue', sessionId: A, timestamp: LATER }],
  ['system', { type: 'system', subtype: 'informational', sessionId: A, timestamp: LATER, content: 'note' }],
  ['file-history-snapshot', { type: 'file-history-snapshot', messageId: 'm', snapshot: { timestamp: LATER } }],
];

test('#1282 the rolled row starts on its newer part', t => {
  const f = rolled(t);
  const row = f.row(B);
  assert.deepEqual([row.sessionId, ...row.mergedMemberIds], [A, B]);
  assert.equal(row.headSessionId, B);
});

for (const [kind, record] of METADATA) {
  test(`#1282 a ${kind} record appended to the older part keeps the head on the newer part`, t => {
    const f = rolled(t);
    f.append(A, [record]);
    f.refresh([A]);
    assert.ok(f.rows.get(A).modified > NEW, 'the older part\'s modified still follows the file');
    const row = f.row(B);
    assert.deepEqual([row.sessionId, ...row.mergedMemberIds], [A, B]);
    assert.equal(row.headSessionId, B);
  });
}

test('#1282 a timestamped metadata record read in full does not make the older part newer', t => {
  const f = rolled(t, [METADATA.find(([kind]) => kind === 'system')[1]]);
  assert.equal(f.rows.get(A).modified, LATER);
  assert.equal(f.row(B).headSessionId, B);
});

for (const [kind, entry] of [['user', u => u], ['assistant', u => ({ ...u, type: 'assistant', message: { role: 'assistant', content: 'reply' } })]]) {
  test(`#1282 a new ${kind} message in the older part still makes it the head`, t => {
    const f = rolled(t);
    f.append(A, [entry(f.user(A, LATER, 'resumed'))]);
    f.refresh([A]);
    assert.equal(f.row(B).headSessionId, A);
  });
}

test('#1282 a message after a metadata record is still found by the next refresh', t => {
  const f = rolled(t);
  f.append(A, [METADATA[0][1]]);
  f.refresh([A]);
  f.append(A, [f.user(A, LATER, 'resumed')]);
  f.refresh([A]);
  assert.equal(f.row(B).headSessionId, A);
});

test('#1282 nothing changes for a single-part row', t => {
  const f = fixture(t);
  f.write(C, [f.user(C, OLD)]);
  f.refresh();
  f.append(C, [METADATA[0][1]]);
  f.refresh([C]);
  const row = f.row(C);
  assert.equal(row.headSessionId, C);
  assert.deepEqual(row.mergedMemberIds, []);
  assert.equal(row.modified, f.rows.get(C).fileMtime, 'a single row still sorts by the file\'s last write');
});

test('#1282 the incremental count keeps the last conversation time across metadata appends', t => {
  const f = fixture(t);
  f.write(C, [f.user(C, OLD)]);
  f.refresh();
  const initial = f.rows.get(C);
  assert.equal(lastConversationAt(initial), OLD);
  f.append(C, [METADATA[4][1]]);
  const after = readMessageCount(f.file(C), initial.messageCountIndex, fs.statSync(f.file(C), { bigint: true }));
  assert.equal(after.messageCount, 1);
  assert.equal(lastConversationAt({ ...initial, ...after, modified: LATER }), OLD);
});

test('#1282 a row indexed before the change falls back to its modified date', () => {
  const legacy = JSON.stringify({ version: 1, stamp: {}, count: 1, sealedCount: 1, bytes: 1, filtered: false, head: '', tail: '' });
  assert.equal(lastConversationAt({ modified: NEW, messageCountIndex: legacy }), NEW);
  assert.equal(lastConversationAt({ modified: NEW, messageCountIndex: null }), NEW);
  assert.equal(lastConversationAt({ modified: NEW, messageCountIndex: '{' }), NEW);
  assert.equal(lastConversationAt({ modified: null }), '');
});

test('#1282 a row whose count cursor predates the change recounts and keeps the newer head', t => {
  const f = rolled(t);
  const cursor = JSON.parse(f.rows.get(A).messageCountIndex);
  delete cursor.conversationAt;
  delete cursor.sealedConversationAt;
  f.rows.get(A).messageCountIndex = JSON.stringify(cursor);
  f.append(A, [METADATA[0][1]]);
  f.refresh([A]);
  assert.equal(lastConversationAt(f.rows.get(A)), OLD);
  assert.equal(f.row(B).headSessionId, B);
});

test('#1282 a background row rolled through its job keeps its newest conversation as head', t => {
  const { scanContinuationIndex } = require('../session-continuations');
  const P = '00000000-0000-4000-8000-000000001282', X = '11111111-0000-4000-8000-000000001282';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-row-head-1282-bg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project'), projectsDir = path.join(root, 'projects');
  const folder = encodeProjectPath(projectPath);
  fs.mkdirSync(projectPath);
  fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
  const conversation = { [P]: OLD, [X]: OLD, [A]: OLD, [B]: NEW };
  const rows = Object.entries({ [P]: [X, A], [X]: [], [A]: [B], [B]: [] }).map(([id, targets]) => {
    const file = path.join(projectsDir, folder, id + '.jsonl');
    fs.writeFileSync(file, [{ type: 'user', sessionId: id, cwd: projectPath, timestamp: OLD, message: { content: 'fixture' } },
      ...targets.map(target => ({ type: 'continued-in', sessionId: id, continuedInSessionId: target, timestamp: OLD }))].map(line).join(''));
    return { sessionId: id, folder, projectPath, modified: id === A ? LATER : conversation[id], messageCountIndex: JSON.stringify({ version: 1, conversationAt: conversation[id] }),
      fileMtime: fs.statSync(file).mtime.toISOString(), messageCount: 1, summary: 'fixture', continuationIndex: scanContinuationIndex(file, id) };
  });
  const jobs = new Map([['aaaaaaaa', { state: 'failed', sessionId: A }], ['bbbbbbbb', { state: 'blocked', sessionId: B }]]);
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console,
    getLocalDescriptors: () => [], getLocalJobs: () => jobs,
    db: { getAllCached: () => rows, getAllMeta: () => new Map(), isInitialScanComplete: () => true,
      getAllFolderMeta: () => new Map([[folder, { projectPath }]]), getSetting: () => ({}) } });
  const row = cache.buildProjectsFromCache(false).flatMap(p => p.sessions).find(s => [s.sessionId, ...s.mergedMemberIds].includes(B));
  assert.deepEqual([row.sessionId, ...row.mergedMemberIds], [A, B]);
  assert.equal(row.headSessionId, B);
});
