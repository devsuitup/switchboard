const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const projectPath = '/home/dev/shared';

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  loadAppFunctions(ctx.context, { functions: ['getExpandedSlugs', 'saveExpandedSlugs'], installSpies: false });
  return ctx;
}

function session(sessionId, seconds = 0, extra = {}) {
  return { sessionId, modified: new Date(Date.now() - seconds * 1000).toISOString(), ...extra };
}

function project(remoteAlias, sessions = [], location = projectPath) {
  return makeSampleProject({ projectPath: location, remoteAlias, sessions });
}

function render(ctx, projects, resort = false) {
  ctx.window.cachedAllProjects = projects;
  for (const p of projects) for (const s of p.sessions) ctx.window.sessionMap.set(s.sessionId, s);
  ctx.sidebar.renderProjects(projects, resort);
}

function group(ctx, p) {
  return ctx.document.getElementById(ctx.window.folderId(p.projectPath, p.remoteAlias));
}

function orphans(alias) {
  return Array.from({ length: 12 }, (_, i) => session(alias + '-orphan-' + i, i,
    { parentSessionId: alias + '-missing', agentId: alias + '-' + i, remoteAlias: alias }));
}

test('same-path hosts preserve independent project order across reordered input', t => {
  const ctx = setup(t);
  const a = project('a');
  const b = project('b');
  const middle = project('middle', [], '/other');
  render(ctx, [a, middle, b], true);
  const ids = () => [...ctx.document.querySelectorAll('.project-group')].map(node => node.id);
  const before = ids();
  render(ctx, [b, middle, a]);
  assert.deepEqual(ids(), before, 'each host keeps its position around the third project');
});

test('same-path hosts preserve their own session order when timestamps change', t => {
  const ctx = setup(t);
  const a = project('a', [session('a-1'), session('a-2', 10)]);
  const b = project('b', [session('b-1'), session('b-2', 10)]);
  const ids = p => [...group(ctx, p).querySelectorAll('.session-item')].map(node => node.dataset.sessionId);
  render(ctx, [a, b], true);
  b.sessions[1].modified = new Date(Date.now() + 10000).toISOString();
  render(ctx, [a, b]);
  assert.deepEqual(ids(b), ['b-1', 'b-2'], 'second host retains its previous row order');
  assert.deepEqual(ids(a), ['a-1', 'a-2']);
});

test('same-path hosts persist orphan expansion independently', t => {
  const ctx = setup(t);
  const a = project('a', orphans('a'));
  const b = project('b', orphans('b'));
  render(ctx, [a, b], true);
  group(ctx, a).querySelector('.sidebar-orphan-label').click();
  render(ctx, [a, b]);
  assert.equal(group(ctx, a).querySelector('.sidebar-orphan-subagents').classList.contains('collapsed'), false);
  assert.equal(group(ctx, b).querySelector('.sidebar-orphan-subagents').classList.contains('collapsed'), true,
    'expanding host a must not expand host b after a render');
  assert.equal(ctx.window.localStorage.getItem('orphanExpanded:' + projectPath), null,
    'remote expansion must not write the local legacy key');
});

test('same-path hosts persist orphan rest expansion independently', t => {
  const ctx = setup(t);
  const a = project('a', orphans('a'));
  const b = project('b', orphans('b'));
  const count = p => group(ctx, p).querySelectorAll('[data-subagent]').length;
  render(ctx, [a, b], true);
  assert.equal(count(a), 10);
  group(ctx, a).querySelector('.subagents-more-toggle').click();
  assert.equal(count(a), 12);
  render(ctx, [a, b]);
  assert.equal(count(a), 12);
  assert.equal(count(b), 10, 'host b must keep its capped orphan list');
  assert.ok(group(ctx, b).querySelector('.subagents-more-toggle'));
  assert.equal(ctx.window.getExpandedSubagentRest().has('o:' + projectPath), false);
});

test('local persisted orphan and rest keys survive and do not expand same-path remote hosts', t => {
  const ctx = setup(t);
  const local = project(undefined, orphans('local'));
  const remote = project('remote', orphans('remote'));
  ctx.window.localStorage.setItem('orphanExpanded:' + projectPath, '1');
  ctx.window.localStorage.setItem('expandedSubagentRest', JSON.stringify(['o:' + projectPath]));
  render(ctx, [local, remote], true);
  const localOrphans = group(ctx, local).querySelector('.sidebar-orphan-subagents');
  assert.equal(localOrphans.classList.contains('collapsed'), false, 'legacy local expansion is read');
  assert.equal(localOrphans.querySelectorAll('[data-subagent]').length, 12, 'legacy local rest is read');
  assert.equal(group(ctx, remote).querySelector('.sidebar-orphan-subagents').classList.contains('collapsed'), true);
  assert.equal(group(ctx, remote).querySelectorAll('[data-subagent]').length, 10);
  localOrphans.querySelector('.sidebar-orphan-label').click();
  assert.equal(ctx.window.localStorage.getItem('orphanExpanded:' + projectPath), '0', 'local writes keep the legacy key');
  assert.ok(ctx.window.getExpandedSubagentRest().has('o:' + projectPath));
});

test('same-path host schedule groups keep unique ids and independent persisted expansion', t => {
  const ctx = setup(t);
  const a = project('a', [session('a-schedule', 0, { scheduleSlug: 'nightly' })]);
  const b = project('b', [session('b-schedule', 0, { scheduleSlug: 'nightly' })]);
  render(ctx, [a, b], true);
  const slug = p => group(ctx, p).querySelector('.slug-group');
  assert.notEqual(slug(a).id, slug(b).id);
  slug(a).querySelector('.slug-group-header').click();
  assert.deepEqual([...ctx.window.getExpandedSlugs()], [slug(a).id]);
  render(ctx, [b, a]);
  assert.equal(slug(a).classList.contains('collapsed'), false);
  assert.equal(slug(b).classList.contains('collapsed'), true);
  const ids = [...ctx.document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('nested same-path worktrees keep orphan state and rest independent by host', t => {
  const ctx = setup(t);
  const location = projectPath + '/.claude/worktrees/topic';
  const children = ['a', 'b'].map(alias => project(alias, orphans(alias), location));
  const projects = children.flatMap(child => [project(child.remoteAlias), child]);
  const nested = p => ctx.document.getElementById('sessions-' + ctx.window.folderId(p.projectPath, p.remoteAlias));
  render(ctx, projects, true);
  assert.equal(ctx.document.querySelectorAll('.worktree-header').length, 2);
  nested(children[0]).querySelector('.sidebar-orphan-label').click();
  nested(children[0]).querySelector('.subagents-more-toggle').click();
  render(ctx, projects);
  assert.equal(nested(children[0]).querySelector('.sidebar-orphan-subagents').classList.contains('collapsed'), false);
  assert.equal(nested(children[0]).querySelectorAll('[data-subagent]').length, 12);
  assert.equal(nested(children[1]).querySelector('.sidebar-orphan-subagents').classList.contains('collapsed'), true);
  assert.equal(nested(children[1]).querySelectorAll('[data-subagent]').length, 10);
});

