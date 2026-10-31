'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { projectsWorker } = require('./fixtures/projects-worker-718.cjs');
const { projectionScope } = require('../public/session-projection-diagnostics');
const { encodeProjectPath } = require('../encode-project-path');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-742-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = encodeProjectPath(root);
  const rows = new Map([A, B, 'plain', 'child', 'remote'].map(sessionId => [sessionId, {
    sessionId, projectPath: root, folder, summary: sessionId, messageCount: 1, fileMtime: 'now',
    modified: '2026-10-19T08:15:00.000Z',
    ...(sessionId === A ? { continuationIndex: JSON.stringify({ format: 3, complete: true, mtime: 'now', ids: [B] }) } : {}),
    ...(sessionId === 'child' ? { parentSessionId: A } : {}),
    ...(sessionId === 'remote' ? { folder: 'host::' + folder } : {}),
  }]));
  const worker = projectsWorker({ root, rows, meta: new Map(), folders: new Map() });
  let id = 0;
  return { root, rows, async build() {
    await worker.handle({ id: ++id, reconcile: false, measureBytes: true,
      localDescriptors: [{ sessionId: B, jobId: 'aaaaaaaa', kind: 'bg', cwd: root }],
      localJobs: [['aaaaaaaa', { sessionId: B, state: 'done', transcriptPath: path.join(root, folder, B + '.jsonl') }]],
      activeSessions: [['terminal', { isPlainTerminal: true, projectPath: root, _openedAt: 1 }]],
    });
    const reply = worker.replies.find(reply => reply.id === id);
    assert.equal(reply.error, undefined);
    return reply.result;
  } };
}

test('742 worker shares facts across both views and covers plain roots while omitting subagents and terminals', async t => {
  const h = fixture(t), reply = await h.build();
  const rows = [...reply.defaultProjects, ...reply.allProjects].flatMap(project => project.sessions);
  assert.equal(rows.some(row => Object.hasOwn(row, 'projectionFacts')), false, 'rows must not carry projectionFacts');
  assert.ok(reply.projection.facts, 'reply envelope must contain shared facts');
  const scope = projectionScope(null, h.root), remoteScope = projectionScope('host', h.root);
  assert.deepEqual(Object.keys(reply.projection.facts).sort(), [scope + '|' + A, scope + '|plain', remoteScope + '|remote'].sort());
  const facts = reply.projection.facts[scope + '|' + A];
  assert.deepEqual(Array.from(facts.proof.partIds), [A, B]);
  assert.equal(facts.proof.kind, 'continuation');
  assert.equal(reply.allProjects.flatMap(p => p.sessions).find(row => row.bgJobId)?.sessionId, B);
  assert.equal(Object.keys(reply.projection.facts).filter(key => key.endsWith('|' + A)).length, 1);
  assert.doesNotThrow(() => structuredClone(reply));
  assert.equal(reply.replyBytes.both, Buffer.byteLength(JSON.stringify({
    defaultProjects: reply.defaultProjects, allProjects: reply.allProjects, projection: reply.projection,
  })), 'activity trace bytes include the envelope');
});

test('742 main relay derives current archive exclusions from envelope facts without mutating the worker reply', async t => {
  const h = fixture(t), result = await h.build();
  const original = JSON.stringify(result), scope = projectionScope(null, h.root);
  const filename = require.resolve('../main.js'), source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf("ipcMain.handle('get-projects'");
  let invoke;
  vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), {
    ipcMain: { handle: (_name, fn) => { invoke = fn; } }, require: require('node:module').createRequire(filename), structuredClone, console,
    TRACE: { on: false }, performance, projectsReconciledAt: Date.now(),
    getSetting: () => null, isInitialScanComplete: () => true, isCachePopulated: () => true,
    isSearchIndexPopulated: () => true, backfillEntrypoints() {}, backfillCustomTitles() {},
    projectsClient: { request: async () => result }, mergePlaceholderSessions: projects => projects,
    writer: { applyAndPersistArchived: projects => projects.filter(p => p.remoteAlias) },
    annotateRemoteAttachable: projects => projects,
  }, { filename });
  const reply = await invoke(null, 'both');
  assert.equal(reply.projection.removedInputs[scope + '|' + A]?.filterReason, 'archived');
  assert.equal(reply.projection.removedInputs[scope + '|plain']?.filterReason, 'archived');
  assert.equal(Object.keys(reply.projection.removedInputs).length, 2);
  assert.equal(JSON.stringify(result), original);
});

test('742 accepted envelope facts preserve plain-to-background transitions, splits and current disappearance reasons', async t => {
  const { setupSidebarDom } = require('./dom-setup'), { loadAppFunctions } = require('./app-source');
  const h = setupSidebarDom(); t.after(() => h.destroy()); const w = h.window, records = [];
  w.TextEncoder = TextEncoder; h.evalPublic('session-projection-diagnostics.js');
  w.cachedProjects = []; w.cachedAllProjects = []; w.loadingStatus = w.document.createElement('div');
  for (const name of ['reportActivityFocus', 'reportActivityTitles', 'renderDefaultStatus', 'refreshSidebar']) w[name] = () => {};
  w.pollActiveSessions = async () => {}; w.api.getSetting = async () => ({}); w.api.getActiveTerminals = async () => [];
  w.api.sessionProjectionChanged = record => records.push(record);
  let reply;
  w.api.getProjects = async () => structuredClone(reply);
  loadAppFunctions(h.context, { functions: ['dedup', 'loadProjects', 'observeSessionProjection'] });
  const scope = projectionScope(null, '/fixture');
  const inputs = (rootId, partIds, reason = null) => ({ cachedJob: false, descriptors: [],
    proof: { kind: partIds.length > 1 ? 'continuation' : 'single', rootId, partIds, valid: !reason, reason }, filterReason: null });
  const accept = async (rows, facts, removedInputs = {}) => {
    reply = { defaultProjects: [{ projectPath: '/fixture', sessions: rows }],
      allProjects: [{ projectPath: '/fixture', sessions: rows }], projection: { buildId: 42, facts, removedInputs } };
    await w.loadProjects();
  };
  await accept([{ sessionId: A }], { [scope + '|' + A]: inputs(A, [A]) });
  assert.equal(records.length, 0);
  await accept([{ sessionId: A, bgJobId: 'aaaaaaaa', bgSessionId: A }], { [scope + '|' + A]: inputs(A, [A], 'proof-invalid') });
  assert.equal(records.length, 1); assert.ok(records[0].changes.includes('background-membership'));
  assert.equal(records[0].inputs.proof.reason, 'proof-invalid', 'transition must use accepted envelope inputs');
  await accept([{ sessionId: B, headSessionId: B, mergedMemberIds: [A] }], { [scope + '|' + A]: inputs(A, [A, B]) });
  assert.equal(records.length, 2); assert.equal(records[1].rootId, A, 'representative B keeps graph root A');
  assert.equal(records[1].inputs.proof.kind, 'continuation');
  await accept([{ sessionId: A }, { sessionId: B }], {
    [scope + '|' + A]: inputs(A, [A], 'identity-lost'), [scope + '|' + B]: inputs(B, [B]),
  });
  assert.equal(records.length, 4);
  assert.deepEqual(new Set(records.slice(-2).map(record => record.rootId)), new Set([A, B]));
  assert.ok(records.slice(-2).every(record => record.changes.includes('merge-membership')));
  const removed = { ...inputs(A, [A]), projectsBuildId: 43, filterReason: 'hidden-project' };
  await accept([{ sessionId: B }], { [scope + '|' + B]: inputs(B, [B]) }, { [scope + '|' + A]: removed });
  assert.equal(records.length, 5); assert.deepEqual(Array.from(records[4].changes), ['removed']);
  assert.equal(records[4].inputs.filterReason, 'hidden-project'); assert.equal(records[4].priorInputs, undefined);
  assert.equal(records[4].projectsBuildId, 43);
});
