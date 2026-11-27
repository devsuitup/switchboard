'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');
const { scanContinuationIndex } = require('../session-continuations');

const P = '00000000-0000-4000-8000-00000000000a';
const X = '11111111-0000-4000-8000-00000000000a';
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000a';
const MEASURED = { [P]: [X, A], [X]: [], [A]: [B], [B]: [] };
const OLD = '2026-11-19T08:00:00.000Z';
const NEW = '2026-11-25T17:53:41.722Z';

function project(t, { graph = MEASURED, modified = {}, descriptors = [], active = new Map(), state = 'blocked', failedRoot = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-row-head-1276-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project'), projectsDir = path.join(root, 'projects');
  const folder = encodeProjectPath(projectPath);
  fs.mkdirSync(projectPath);
  fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
  const rows = Object.entries(graph).map(([id, targets]) => {
    const file = path.join(projectsDir, folder, id + '.jsonl');
    fs.writeFileSync(file, [{ type: 'user', sessionId: id, cwd: projectPath, timestamp: OLD, message: { content: 'fixture' } },
      ...targets.map(target => ({ type: 'continued-in', sessionId: id, continuedInSessionId: target, timestamp: OLD }))]
      .map(JSON.stringify).join('\n') + '\n');
    return { sessionId: id, folder, projectPath, modified: modified[id] || (id === B ? NEW : OLD),
      fileMtime: fs.statSync(file).mtime.toISOString(), messageCount: 1, summary: 'fixture', continuationIndex: scanContinuationIndex(file, id) };
  });
  const jobs = new Map([...(failedRoot ? [['aaaaaaaa', { state: 'failed', sessionId: A }]] : []),
    ['bbbbbbbb', { state, sessionId: B }]]);
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions: active, getMainWindow: () => null, log: console,
    getLocalDescriptors: () => descriptors.map(d => ({ cwd: projectPath, pid: 1, ...d })), getLocalJobs: () => jobs,
    db: { getAllCached: () => rows, getAllMeta: () => new Map(), isInitialScanComplete: () => true,
      getAllFolderMeta: () => new Map([[folder, { projectPath }]]), getSetting: () => ({}) } });
  return cache.buildProjectsFromCache(false).flatMap(p => p.sessions).find(row => [row.sessionId, ...row.mergedMemberIds].includes(B));
}

test('#1276 a blocked job without a worker heads the row it merged into', t => {
  const row = project(t);
  assert.deepEqual([row.sessionId, ...row.mergedMemberIds], [A, B]);
  assert.equal(row.headSessionId, B);
  assert.equal(row.bgJobId, undefined);
  assert.equal(row.identityJobId, 'bbbbbbbb');
  assert.equal(row.identitySessionId, B);
  assert.equal(row.refusedJobState, 'blocked');
});

test('#1276 the linear roll-up already picks the newer job as head', t => {
  const row = project(t, { graph: { [A]: [B], [B]: [] } });
  assert.equal(row.headSessionId, B);
});

test('#1276 a newer conversation stays head over the older copy its record points to', t => {
  const row = project(t, { modified: { [A]: NEW, [B]: OLD } });
  assert.equal(row.headSessionId, A);
});

for (const kind of ['interactive', 'own tab']) {
  test(`#1276 a live conversation (${kind}) stays head over a newer dead copy`, t => {
    const row = project(t, kind === 'own tab' ? { active: new Map([[A, { exited: false }]]) }
      : { descriptors: [{ sessionId: A, kind: 'interactive' }] });
    assert.deepEqual([row.sessionId, ...row.mergedMemberIds], [A, B]);
    assert.equal(row.headSessionId, A);
  });
}

test('#1276 an exited tab does not hold the head', t => {
  assert.equal(project(t, { active: new Map([[A, { exited: true }]]) }).headSessionId, B);
});

test('#1276 a live worker still represents its row', t => {
  const row = project(t, { descriptors: [{ sessionId: B, kind: 'bg', jobId: 'bbbbbbbb' }] });
  assert.equal(row.sessionId, B);
  assert.equal(row.headSessionId, B);
  assert.equal(row.bgJobId, 'bbbbbbbb');
  assert.equal(row.refusedJobState, undefined);
});

test('#1276 a conversation with two continuation records is not merged with either target', t => {
  const row = project(t, { graph: { [A]: [B, X], [B]: [], [X]: [] } });
  assert.deepEqual([row.sessionId, ...row.mergedMemberIds], [B]);
});
