'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { parseJobState, mergeRoster } = require('../src/main/bg-agents/bg-agents-roster');

const SID = 'bbbbbbbb-1249-4321-abcd-123456789abc';
const JOB = 'bbbbbbbb';
const DAY = 86400000;
const OLD = Date.now() - 10 * DAY;

function liveRoster() {
  const job = parseJobState(JSON.stringify({ state: 'working', updatedAt: new Date().toISOString(),
    inFlight: { tasks: 0, kinds: [] }, sessionId: SID, fan: [] }));
  const entries = mergeRoster({ cli: [{ id: JOB, kind: 'background', sessionId: SID, state: 'working', status: 'busy' }],
    jobs: new Map([[JOB, job]]), descriptors: [{ kind: 'bg', jobId: JOB, sessionId: SID,
      status: 'busy', statusUpdatedAt: Date.now(), startedAt: OLD, cwd: '/repo', pid: 10 }] });
  entries[0].hosted = true;
  return entries;
}

async function setup(t, { live = true } = {}) {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  h.window.sessionMaxAgeDays = 3;
  h.window.api.getBgAgents = async () => ({ roster: live ? liveRoster() : [], daemonReachable: true });
  h.window.api.onBgAgentsChanged = () => {};
  h.evalPublic('agents-view.js');
  h.window.initAgentsView();
  await Promise.resolve();
  await Promise.resolve();
  return h;
}

function bgRow(modified) {
  return { sessionId: SID, bgJobId: JOB, descriptorOnly: true, summary: 'Background job',
    status: 'busy', messageCount: 0, modified, created: modified };
}

function projectWith(projectPath, sessions) {
  return { projectPath, folder: projectPath.replace(/[\\/:.]/g, '-'), sessions };
}

function header(h) {
  const found = h.document.querySelector('.project-header');
  assert.ok(found, 'project header rendered');
  return found;
}

function render(h, projects) {
  for (const p of projects) for (const s of p.sessions) h.window.sessionMap.set(s.sessionId, s);
  h.sidebar.renderProjects(projects, true);
}

test('a project holding only a descriptor-only live background job with an old start renders expanded', async t => {
  const h = await setup(t);
  const project = projectWith('/repo', [bgRow(new Date(OLD).toISOString())]);
  render(h, [project]);
  assert.equal(h.window.rowHasLiveBackgroundJob(project.sessions[0]), true, 'fixture must be a live background job');
  assert.equal(header(h).classList.contains('collapsed'), false);

  project.sessions[0] = { ...project.sessions[0], descriptorOnly: false, modified: new Date().toISOString() };
  render(h, [project]);
  assert.equal(header(h).classList.contains('collapsed'), false, 'a later render with a current date keeps it expanded');
});

test('an automatic collapse is re-evaluated once its reason is gone', async t => {
  const h = await setup(t, { live: false });
  const project = projectWith('/repo', [bgRow(new Date(OLD).toISOString())]);
  render(h, [project]);
  assert.equal(header(h).classList.contains('collapsed'), true, 'a stale idle project is auto-collapsed');

  project.sessions[0] = { ...project.sessions[0], modified: new Date().toISOString() };
  render(h, [project]);
  assert.equal(header(h).classList.contains('collapsed'), false, 'the cache gives the row a current date');
});

test('a project collapse made by the user survives re-renders', async t => {
  const h = await setup(t);
  const project = projectWith('/repo', [bgRow(new Date(OLD).toISOString())]);
  render(h, [project]);
  header(h).click();
  assert.equal(header(h).classList.contains('collapsed'), true);
  render(h, [project]);
  project.sessions[0] = { ...project.sessions[0], modified: new Date().toISOString() };
  render(h, [project]);
  assert.equal(header(h).classList.contains('collapsed'), true, 'user collapse is sticky');
  header(h).click();
  render(h, [project]);
  assert.equal(header(h).classList.contains('collapsed'), false, 'user expand is sticky too');
});

function worktreeFixture(modified) {
  const parent = projectWith('/repo', [{ sessionId: 'parent-1', summary: 'Parent', modified: new Date().toISOString() }]);
  const wt = projectWith('/repo/.claude/worktrees/agent-1249', [bgRow(modified)]);
  return [parent, wt];
}

test('a worktree group holding a live background job with an old start renders expanded', async t => {
  const h = await setup(t);
  const projects = worktreeFixture(new Date(OLD).toISOString());
  render(h, projects);
  const wtHeader = () => h.document.querySelector('.worktree-header');
  assert.ok(wtHeader(), 'worktree is nested under its parent');
  assert.equal(wtHeader().classList.contains('collapsed'), false);

  projects[1].sessions[0] = { ...projects[1].sessions[0], descriptorOnly: false, modified: new Date().toISOString() };
  render(h, projects);
  assert.equal(wtHeader().classList.contains('collapsed'), false, 'a later render keeps it expanded');

  wtHeader().click();
  render(h, projects);
  assert.equal(wtHeader().classList.contains('collapsed'), true, 'a worktree collapse made by the user survives re-renders');
});

test('a stale idle worktree is auto-collapsed and reopens once its row is current', async t => {
  const h = await setup(t, { live: false });
  const projects = worktreeFixture(new Date(OLD).toISOString());
  render(h, projects);
  const wtHeader = () => h.document.querySelector('.worktree-header');
  assert.equal(wtHeader().classList.contains('collapsed'), true);
  projects[1].sessions[0] = { ...projects[1].sessions[0], modified: new Date().toISOString() };
  render(h, projects);
  assert.equal(wtHeader().classList.contains('collapsed'), false);
});

const oldRow = (sessionId, extra = {}) => ({ sessionId, summary: sessionId, modified: new Date(OLD).toISOString(), ...extra });

test('an old idle parent is not auto-collapsed over a nested worktree holding a running session', async t => {
  const h = await setup(t, { live: false });
  const projects = [projectWith('/repo', [oldRow('idle-parent')]),
    projectWith('/repo/.claude/worktrees/worker', [oldRow('live-worker')])];
  h.window.activePtyIds.add('live-worker');
  render(h, projects);
  assert.ok(h.document.querySelector('.worktree-header'), 'worktree is nested under its parent');
  assert.equal(header(h).classList.contains('collapsed'), false, 'parent stays open over the running worktree');
  assert.equal(h.document.querySelector('.worktree-header').classList.contains('collapsed'), false);
});

test('a stale parent collapsed automatically reopens when its nested worktree starts running', async t => {
  const h = await setup(t, { live: false });
  const projects = [projectWith('/repo', [oldRow('idle-parent')]),
    projectWith('/repo/.claude/worktrees/worker', [oldRow('live-worker')])];
  render(h, projects);
  assert.equal(header(h).classList.contains('collapsed'), true, 'nothing runs: the stale parent is auto-collapsed');
  h.window.activePtyIds.add('live-worker');
  render(h, projects);
  assert.equal(header(h).classList.contains('collapsed'), false);
});

for (const filter of ['search', 'starred', 'running']) {
  test(`a stale group opened by the ${filter} filter collapses again once the filter is cleared`, async t => {
    const h = await setup(t, { live: false });
    const projects = [projectWith('/repo', [oldRow('idle', { starred: true })])];
    render(h, projects);
    assert.equal(header(h).classList.contains('collapsed'), true, 'stale idle group is auto-collapsed');
    const on = { search: () => { h.window.searchMatchIds = new Set(['idle']); },
      starred: () => { h.window.showStarredOnly = true; },
      running: () => { h.window.showRunningOnly = true; h.window.activePtyIds.add('idle'); } }[filter];
    const off = { search: () => { h.window.searchMatchIds = null; },
      starred: () => { h.window.showStarredOnly = false; },
      running: () => { h.window.showRunningOnly = false; h.window.activePtyIds.delete('idle'); } }[filter];
    on();
    render(h, projects);
    assert.equal(header(h).classList.contains('collapsed'), false, 'the filter opens the group');
    render(h, projects);
    off();
    render(h, projects);
    assert.equal(header(h).classList.contains('collapsed'), true, 'clearing the filter restores the automatic collapse');
  });
}

test('a group the user expands during a search stays expanded after it', async t => {
  const h = await setup(t, { live: false });
  const projects = [projectWith('/repo', [oldRow('idle')])];
  render(h, projects);
  h.window.searchMatchIds = new Set(['idle']);
  render(h, projects);
  header(h).click();
  header(h).click();
  h.window.searchMatchIds = null;
  render(h, projects);
  assert.equal(header(h).classList.contains('collapsed'), false, 'a click turns the state into the user\'s');
});

test('a user collapse survives a search cycle', async t => {
  const h = await setup(t, { live: false });
  const projects = [projectWith('/repo', [oldRow('idle', { modified: new Date().toISOString() })])];
  render(h, projects);
  header(h).click();
  h.window.searchMatchIds = new Set(['idle']);
  render(h, projects);
  assert.equal(header(h).classList.contains('collapsed'), true);
  h.window.searchMatchIds = null;
  render(h, projects);
  assert.equal(header(h).classList.contains('collapsed'), true);
});
