'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { encodeProjectPath } = require('../encode-project-path');
const { resolveWorktreePath } = require('../derive-project-path');
const { mergeLocalBackgroundSessions, conversationMemberIds } = require('../sidebar-bg-sessions');
const { createTaskRegistry } = require('../public/task-registry');
const { setupSidebarDom } = require('./dom-setup');
const A = '2a633039-956f-48b4-979a-ce3d4b801ca1', B = '369b1c23-9bd7-47a2-b4bf-36ee3ca4b55f', J = '369b1c23', K = 'aaaaaaaa';
for (const layout of ['.claude/worktrees', '.worktrees', '.claude-worktrees']) for (const transcript of [false, true]) {
  test(`F1 worktree conversation retains one row: ${layout}, transcript=${transcript}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-719b-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cwd = path.join(root, ...layout.split('/'), 'feature');
    fs.mkdirSync(cwd, { recursive: true });
    const projectPath = resolveWorktreePath(cwd), folder = encodeProjectPath(cwd), projectsDir = path.join(root, 'projects');
    const row = { sessionId: A, folder, projectPath, messageCount: 2,
      continuationIndex: JSON.stringify({ format: 3, complete: true, ids: [B] }) };
    const projects = [{ projectPath, folder, sessions: [row] }];
    const jobs = new Map([[J, { state: 'working', sessionId: B,
      ...(transcript ? { transcriptPath: path.join(projectsDir, folder, B + '.jsonl') } : {}) }]]);
    mergeLocalBackgroundSessions(projects, [row], [{ sessionId: B, jobId: J, kind: 'bg', cwd }], {
      hiddenProjects: new Set(), metaMap: new Map(), showArchived: true, jobs, projectsDir,
      folderMeta: new Map([[folder, { projectPath }]]),
    });
    assert.equal(projects.flatMap(p => p.sessions).length, 1);
    assert.equal(row.sessionId, B);
    assert.deepEqual(row.mergedMemberIds, [A]);
  });
}
const evidence = (at, terminal = false) => ({ valid: true, at, terminal, fanKnown: true, inFlight: terminal ? 0 : 1, tasks: [] });
test('F2 terminal job retires CLI tasks through renderer ingress and snapshot after ten hours', t => {
  const h = setupSidebarDom(); t.after(() => h.destroy()); h.evalPublic('agents-view.js');
  const w = h.window;
  let at = 100;
  const registry = w.taskRegistry = createTaskRegistry({ now: () => at });
  registry.note(B, 'agent', 'cli-task');
  at++;
  w.applyAgentsSnapshot({ roster: [{ id: J, sessionId: B, kind: 'background', state: 'done', taskEvidence: evidence(at, true) }] });
  at += 10 * 3600000;
  registry.prune(60000);
  assert.equal(registry.background(B, J), false);
  assert.equal(registry.agents(B, J).length, 0);
  assert.equal(registry.known(B), true);
  const copy = createTaskRegistry(); copy.applySnapshot(registry.snapshot(B));
  assert.equal(copy.background(B, J), false);
});
test('F2 known and unknown activity are projected for the unique selected job', () => {
  const registry = createTaskRegistry();
  registry.applyJob(B, evidence(100), { jobId: J });
  assert.equal(registry.known(B), true);
  assert.equal(registry.background(B), true);
  registry.applyJob(B, evidence(200, true), { jobId: J });
  assert.equal(registry.background(B), false);
});
test('F2 a terminal job does not terminate another job contribution or accept older evidence', () => {
  const registry = createTaskRegistry();
  registry.applyJob(B, { ...evidence(10), tasks: [{ id: 'other', kind: 'agent', startedAt: 1, doneAt: null }] }, { jobId: K });
  registry.applyJob(B, evidence(200, true), { jobId: J });
  registry.applyJob(B, evidence(100), { jobId: J });
  assert.equal(registry.background(B, J), false);
  assert.equal(registry.background(B, K), true);
  assert.equal(registry.agents(B, K)[0].id, 'other');
});
test('F2 repaired evidence at the last valid timestamp replaces an intervening corrupt read', () => {
  const registry = createTaskRegistry();
  registry.applyJob(B, evidence(100), { jobId: J });
  registry.applyJob(B, { valid: false }, { jobId: J });
  registry.applyJob(B, evidence(100), { jobId: J });
  assert.equal(registry.background(B, J), true);
});
test('F2 a terminal job ends existing CLI tasks durably after its roster entry disappears', () => {
  const registry = createTaskRegistry({ now: () => 1 });
  registry.note(B, 'finished-agent', 'cli-task');
  registry.applyJob(B, evidence(100, true), { jobId: J });
  assert.equal(registry.primary(B, 'finished-agent'), false);
  assert.equal(registry.snapshot(B).tasks[0].terminal, true);
  registry.applyJob(B, null, { jobId: J });
  assert.equal(registry.agents(B).length, 0);
  assert.equal(registry.known(B), true);
});
test('F5 grid labels the blocked selected head when the representative differs', t => {
  const h = setupSidebarDom(); t.after(() => h.destroy());
  for (const file of ['agents-view.js', 'shortcuts.js', 'grid-view.js']) h.evalPublic(file);
  const w = h.window;
  w.applyAgentsSnapshot({ roster: [{ id: J, sessionId: B, kind: 'background', state: 'blocked', hosted: true, taskEvidence: evidence(100) }] });
  const row = { sessionId: A, headSessionId: B, mergedMemberIds: [B], bgSessionId: B, bgJobId: J };
  const card = h.document.createElement('div'); card.innerHTML = '<span class="grid-card-dot"></span>';
  w.updateGridCardActivity(A, card, row);
  assert.match(card.querySelector('.grid-card-dot').title, /job blocked/);
});
test('F6 a scoped orphan keeps its representative membership for operation guards', () => {
  assert.deepEqual(conversationMemberIds([{ sessionId: B, mergedIntoSessionId: A, projectPath: '/p', folder: '-p' }], A), [B]);
});
test('F7 unknown identifiers retain their supplied case in the main operation resolver', () => {
  const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
  const start = source.indexOf('function getConversationPartIds('), end = source.indexOf('\n}', start) + 2;
  const resolve = vm.runInNewContext(source.slice(start, end) + '\ngetConversationPartIds;', {
    getAllCached: () => [], activeSessions: new Map(), cliSessionState: { getSidebarDescriptors: () => [] },
    sessionCache: { conversationMemberIds: () => [] },
  });
  assert.deepEqual(Array.from(resolve('Unknown-ID')), ['Unknown-ID']);
});
test('worker and direct project views have identical projection facts; build identity stays in the envelope', async t => {
  const cache = require('../session-cache');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equivalence-719b-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = [{ sessionId: A, projectPath: dir, folder: encodeProjectPath(dir), summary: 'fixture' }];
  cache.init({ PROJECTS_DIR: dir, activeSessions: new Map(), getMainWindow: () => null, log: console,
    db: { getAllCached: () => rows, getAllMeta: () => new Map(), getAllFolderMeta: () => new Map(), getSetting: () => null } });
  const expected = cache.buildProjectsFromCache(true);
  const source = fs.readFileSync(require.resolve('../workers/projects-query'), 'utf8');
  const start = source.indexOf('async function build('), end = source.indexOf('\nparentPort.on(', start);
  const build = vm.runInNewContext(source.slice(start, end) + '\nbuild;', {
    cache, readSnapshot: () => ({ rows, meta: [], folders: [], settings: [] }),
    workerData: { projectsDir: dir }, console, structuredClone, Buffer,
    ...require('../session-name'),
  });
  const actual = await build({ id: 42 });
  assert.deepEqual(JSON.parse(JSON.stringify(actual.allProjects)), JSON.parse(JSON.stringify(expected)));
  assert.equal(actual.projection.buildId, 42);
});
