'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function setup(t, overrides = {}) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const session = {
    sessionId: 'A', headSessionId: 'B', mergedMemberIds: ['B'],
    projectPath: '/project', summary: 'Conversation', modified: new Date().toISOString(),
    ...overrides,
  };
  const project = makeSampleProject({ projectPath: session.projectPath, sessions: [session] });
  ctx.window.sessionMap.set('A', session);
  ctx.window.cachedProjects = [project];
  ctx.window.cachedAllProjects = [project];
  ctx.window.refreshSidebar = () => {};
  ctx.sidebar.renderProjects([project], true);
  return { ...ctx, session, project };
}

for (const [label, selector, verb] of [
  ['Fork', '.session-fork-btn', 'forkSession'],
  ['Resume with config', '.session-launch-config-btn', 'showResumeSessionDialog'],
  ['View messages', '.session-jsonl-btn', 'showJsonlViewer'],
]) {
  test(`${label} on a merged row receives its head and retains row metadata`, async t => {
    const ctx = setup(t);
    const calls = [];
    ctx.window[verb] = (...args) => calls.push(args);
    await ctx.document.querySelector(`#si-A ${selector}`).onclick({ stopPropagation() {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].sessionId, 'B');
    assert.equal(calls[0][0].summary, ctx.session.summary);
    assert.equal(calls[0][0].projectPath, ctx.session.projectPath);
    if (verb === 'forkSession') assert.equal(calls[0][1], ctx.project);
    assert.equal(ctx.window.sessionMap.get('A').sessionId, 'A');
  });
}

test('a remote merged row without an attach target opens messages of its head', t => {
  const ctx = setup(t, { remoteAlias: 'host', remoteAttachable: false });
  const viewed = [];
  ctx.window.showJsonlViewer = session => viewed.push(session.sessionId);
  ctx.document.getElementById('si-A').click();
  assert.deepEqual(viewed, ['B']);
});

test('Pin on a merged row still targets its root', async t => {
  const ctx = setup(t);
  const pinned = [];
  ctx.window.api.toggleStar = async id => { pinned.push(id); return { starred: 1 }; };
  await ctx.document.querySelector('#si-A .session-pin').onclick({ stopPropagation() {} });
  assert.deepEqual(pinned, ['A']);
  assert.equal(ctx.session.starred, 1);
});

test('Rename on a merged row still targets its root', async t => {
  const ctx = setup(t);
  const renamed = [];
  let saved;
  const saving = new Promise(resolve => { saved = resolve; });
  ctx.window.api.renameSession = async (id, name) => { renamed.push([id, name]); saved(); };
  ctx.document.querySelector('#si-A .session-summary').ondblclick({ stopPropagation() {} });
  const input = ctx.document.querySelector('#si-A .session-rename-input');
  input.value = 'New name';
  input.blur();
  await saving;
  assert.deepEqual(renamed, [['A', 'New name']]);
});

test('Archive on a merged row keeps the archived flag on its root', async t => {
  const ctx = setup(t);
  const archived = [];
  ctx.window.api.archiveSession = async (id, value) => { archived.push([id, value]); return { ok: true }; };
  await ctx.document.querySelector('#si-A .session-archive-btn').onclick({ stopPropagation() {} });
  assert.deepEqual(archived, [['A', 1]]);
});

for (const background of [false, true]) {
  test(`Agents Transcript uses the head when its ${background ? 'daemon result' : 'interactive entry'} resolves to a merged row`, async t => {
    const ctx = setup(t);
    ctx.evalPublic('agents-view.js');
    const viewed = [];
    const daemonCalls = [];
    ctx.window.showJsonlViewer = session => viewed.push(session.sessionId);
    ctx.window.api.bgAgentVerb = async (...args) => { daemonCalls.push(args); return { ok: true, sessionId: 'A' }; };
    await ctx.window.runAgentVerb('transcript', {
      id: background ? 'job-1' : null, sessionId: 'A',
      kind: background ? 'background' : 'interactive', cwd: '/project',
    });
    assert.deepEqual(viewed, ['B']);
    assert.deepEqual(daemonCalls, background ? [['transcript', 'job-1']] : []);
    assert.equal(ctx.session.sessionId, 'A');
  });
}

for (const scheduled of [false, true]) {
  test(`two ${scheduled ? 'scheduled runs share a group' : 'interactive sessions with the same slug remain separate'}`, t => {
    const ctx = setup(t);
    const sessions = ['one', 'two'].map(sessionId => ({
      sessionId, summary: sessionId, modified: new Date().toISOString(),
      slug: 'x', ...(scheduled ? { scheduleSlug: 'nightly' } : {}),
    }));
    ctx.sidebar.renderProjects([makeSampleProject({ sessions })], true);
    const groups = ctx.document.querySelectorAll('.slug-group');
    assert.equal(groups.length, scheduled ? 1 : 0);
    assert.equal(ctx.document.querySelectorAll('.session-item:not([data-subagent])').length, 2);
    if (scheduled) assert.equal(groups[0].querySelectorAll('.session-item').length, 2);
  });
}
