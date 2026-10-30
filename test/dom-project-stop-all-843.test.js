'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, answerChoiceDialog } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup() {
  const ctx = setupSidebarDom();
  const { window: w } = ctx;
  loadAppFunctions(ctx.context, { functions: ['confirmAndStopSession'] });
  const row = (sessionId, name, extra = {}) => ({ sessionId, name, modified: new Date().toISOString(), ...extra });
  const project = { projectPath: '/p', folder: '-p', sessions: [
    row('local', 'Local work'),
    row('job-row', 'Background conversation', { mergedMemberIds: ['job-part'] }),
    row('remote', 'Remote work', { remoteAlias: 'vps', remoteDescriptorSeen: true }),
    row('elsewhere', 'Other terminal'),
  ] };
  const nested = { projectPath: '/p/.claude/worktrees/branch', folder: '-wt', sessions: [row('nested', 'Nested work')] };
  const otherHost = { projectPath: '/p', folder: '-host', remoteAlias: 'other', sessions: [row('other-host', 'Other host', { remoteAlias: 'other', remoteDescriptorSeen: true })] };
  const calls = [];
  w.cachedAllProjects = [project, nested, otherHost];
  w.activePtyIds = new Set(['local', 'job-row', 'nested']);
  w.gridViewActive = false;
  w.refreshSidebar = () => {};
  const stored = w.storedActivitySnapshot;
  w.storedActivitySnapshot = (id, r) => id === 'elsewhere' ? { liveness: 'alive' } : stored(id, r);
  w.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'job-part' ? { id: 'aabbccdd' } : null });
  w.api.checkBgAgentVerb = async () => ({ ok: true });
  w.api.stopSession = async id => { calls.push(['stop', id]); return { ok: true }; };
  w.api.remoteStopSession = async (alias, id) => { calls.push(['remote', alias, id]); return { ok: true }; };
  w.api.bgAgentVerb = async (verb, id) => { calls.push([verb, id]); return { ok: true }; };
  ctx.sidebar.renderProjects(w.cachedAllProjects, true);
  ctx.emitHeadTurn('local', 'open', { revision: 1 });
  const button = (p = project) => ctx.document.getElementById('ph-' + ctx.sidebar.folderId(p.projectPath, p.remoteAlias))?.querySelector('.project-stop-all-btn');
  return { ctx, w, calls, project, nested, button };
}

async function start(h, project) {
  const btn = h.button(project);
  assert.ok(btn, 'folder header offers Stop all');
  const done = btn.onclick(new h.w.MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 50 && !h.ctx.document.querySelector('.modal-overlay'); i++) await new Promise(r => setTimeout(r, 0));
  const overlay = h.ctx.document.querySelector('.modal-overlay');
  assert.ok(overlay, 'one confirmation opens');
  return { done, overlay };
}

test('default stops non-job conversations including nested worktree and names background and live-elsewhere refusals', async () => {
  const h = setup();
  try {
    const { done, overlay } = await start(h);
    assert.match(overlay.textContent, /Local work.*mid-turn/);
    assert.doesNotMatch(overlay.textContent, /Nested work[^\n]*mid-turn/);
    assert.match(overlay.textContent, /Background conversation.*background/);
    assert.match(overlay.textContent, /Other terminal.*outside this window/);
    assert.match(overlay.textContent, /Nested work/);
    assert.equal(overlay.querySelector('input[type=radio]:checked').dataset.choiceId, 'others');
    assert.ok(overlay.querySelector('.delete-worktree-confirm-btn'), 'danger styling');
    assert.ok(overlay.querySelector('.choice-dialog-cancel') === h.ctx.document.activeElement, 'Cancel initially focused');
    await answerChoiceDialog(h.ctx, { confirm: true });
    await done;
    assert.deepEqual(h.calls, [['stop', 'local'], ['remote', 'vps', 'remote'], ['stop', 'nested']]);
    assert.equal(h.ctx.document.querySelectorAll('.modal-overlay').length, 0);
  } finally { h.ctx.destroy(); }
});

test('force explicitly stops the background job and every part of its conversation', async () => {
  const h = setup();
  try {
    const { done, overlay } = await start(h);
    const force = overlay.querySelector('input[type=radio][data-choice-id=force]');
    assert.ok(force, 'force is offered separately');
    force.checked = true;
    await answerChoiceDialog(h.ctx, { confirm: true });
    await done;
    assert.deepEqual(h.calls, [['stop', 'local'], ['stop', 'job-row'], ['stop', 'aabbccdd'], ['remote', 'vps', 'remote'], ['stop', 'nested']]);
  } finally { h.ctx.destroy(); }
});

test('cancel stops nothing', async () => {
  const h = setup();
  try {
    const { done } = await start(h);
    await answerChoiceDialog(h.ctx, { confirm: false });
    await done;
    assert.deepEqual(h.calls, []);
  } finally { h.ctx.destroy(); }
});

test('multiple failures produce one persistent Retry notice and retry only failed conversations', async () => {
  const h = setup();
  try {
    h.w.api.stopSession = async id => { h.calls.push(['stop', id]); return id === 'local' ? { ok: false, error: 'local refused' } : { ok: true }; };
    h.w.api.remoteStopSession = async () => { h.calls.push(['remote-failed']); throw new Error('ssh refused'); };
    const { done } = await start(h);
    await answerChoiceDialog(h.ctx, { confirm: true });
    await done;
    const alerts = h.ctx.document.querySelectorAll('#app-notices [role=alert]');
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].textContent, /Local work.*local refused/);
    assert.match(alerts[0].textContent, /Remote work.*ssh refused/);
    assert.equal(alerts[0].querySelector('.app-notice-action').textContent, 'Retry');
    assert.ok(h.w.activePtyIds.has('local'));
    h.w.activePtyIds.add('nested');
    h.calls.length = 0;
    h.w.api.stopSession = async id => { h.calls.push(['stop', id]); return { ok: true }; };
    h.w.api.remoteStopSession = async (alias, id) => { h.calls.push(['remote', alias, id]); return { ok: true }; };
    const retry = h.ctx.read('appNoticeEntries').values().next().value.options.onAction();
    await answerChoiceDialog(h.ctx, { confirm: true });
    await retry;
    assert.deepEqual(h.calls, [['stop', 'local'], ['remote', 'vps', 'remote']]);
    assert.equal(h.ctx.document.querySelectorAll('#app-notices [role=alert]').length, 0);
  } finally { h.ctx.destroy(); }
});

test('nested worktree header stops only its own folder', async () => {
  const h = setup();
  try {
    const { done } = await start(h, h.nested);
    await answerChoiceDialog(h.ctx, { confirm: true });
    await done;
    assert.deepEqual(h.calls, [['stop', 'nested']]);
  } finally { h.ctx.destroy(); }
});

test('unknown daemon state on an idle merged part does not keep a plain PTY conversation', async () => {
  const h = setup();
  try {
    h.project.sessions = [{ sessionId: 'local', name: 'Plain conversation', mergedMemberIds: ['idle-part'] }];
    h.w.cachedAllProjects = [h.project];
    h.w.api.bgAgentLiveJob = async () => ({ known: false, reason: 'unrelated job has an unreadable state' });
    const { done, overlay } = await start(h);
    assert.doesNotMatch(overlay.textContent, /background job|unreadable state/);
    assert.equal(overlay.querySelector('input[type=radio]'), null);
    await answerChoiceDialog(h.ctx, { confirm: true });
    await done;
    assert.deepEqual(h.calls, [['stop', 'local']]);
  } finally { h.ctx.destroy(); }
});

test('all idle conversations with unknown daemon state show Nothing is running and say what was not checked', async () => {
  const h = setup();
  try {
    h.project.sessions = [{ sessionId: 'idle-a' }, { sessionId: 'idle-b' }];
    h.w.cachedAllProjects = [h.project];
    h.w.api.bgAgentLiveJob = async () => ({ known: false, reason: 'unrelated job has an unreadable state' });
    await h.button().onclick(new h.w.MouseEvent('click'));
    assert.equal(h.ctx.document.querySelector('.modal-overlay'), null);
    assert.equal(h.ctx.document.querySelector('#app-notices [role=alert]'), null);
    assert.equal(h.ctx.document.querySelector('#app-notices [role=status] .app-notice-message').textContent,
      'Nothing is running to stop. 2 idle parts could not be checked for background jobs (unrelated job has an unreadable state).');
    assert.deepEqual(h.calls, []);
  } finally { h.ctx.destroy(); }
});

test('a background conversation refused by the job check does not offer the background choice', async () => {
  const h = setup();
  try {
    h.project.sessions = [{ sessionId: 'local', name: 'Local work' }, { sessionId: 'job-part', name: 'Background only' }];
    h.w.cachedAllProjects = [h.project];
    h.w.api.checkBgAgentVerb = async () => ({ ok: false, error: 'daemon refused the check' });
    const { done, overlay } = await start(h);
    assert.equal(overlay.querySelector('input[type=radio]'), null);
    assert.match(overlay.textContent, /Background only \(part job-part\): daemon refused the check/);
    await answerChoiceDialog(h.ctx, { confirm: true });
    await done;
    assert.deepEqual(h.calls, [['stop', 'local']]);
  } finally { h.ctx.destroy(); }
});

test('unknown attached job refuses its part without classifying a plain conversation as background', async () => {
  const h = setup();
  try {
    h.project.sessions = [{ sessionId: 'local', name: 'Plain conversation', mergedMemberIds: ['unknown-attach'] }];
    h.w.cachedAllProjects = [h.project];
    h.w.activePtyIds.add('unknown-attach');
    h.w.openSessions.set('unknown-attach', { attach: true, attachJobId: 'eeff0011', session: { sessionId: 'unknown-attach' } });
    h.w.api.bgAgentLiveJob = async () => ({ known: false, reason: 'unreadable state' });
    const { done, overlay } = await start(h);
    assert.match(overlay.textContent, /cannot tell whether a background job.*unreadable state/);
    assert.equal(overlay.querySelector('input[type=radio]'), null);
    await answerChoiceDialog(h.ctx, { confirm: true });
    await done;
    assert.deepEqual(h.calls, [['stop', 'local']]);
    assert.ok(h.w.activePtyIds.has('unknown-attach'));
  } finally { h.ctx.destroy(); }
});

test('ended attached jobs detach by default without classifying the conversation as background', async () => {
  const h = setup();
  try {
    h.project.sessions = [{ sessionId: 'ended', name: 'Ended job' }];
    h.w.cachedAllProjects = [h.project];
    h.w.activePtyIds.add('ended');
    h.w.openSessions.set('ended', { attach: true, attachJobId: 'eeff0011', session: h.project.sessions[0] });
    const { done, overlay } = await start(h);
    assert.equal(overlay.querySelector('input[type=radio]'), null);
    assert.doesNotMatch(overlay.textContent, /refused unless/);
    await answerChoiceDialog(h.ctx, { confirm: true });
    await done;
    assert.deepEqual(h.calls, [['stop', 'ended']]);
    assert.ok(!h.w.activePtyIds.has('ended'));
  } finally { h.ctx.destroy(); }
});

test('Stop the others only with all background candidates explains that nothing else was running', async () => {
  const h = setup();
  try {
    h.project.sessions = [h.project.sessions[1], { sessionId: 'job-part', name: 'Second background conversation' }];
    h.w.cachedAllProjects = [h.project];
    const { done } = await start(h);
    await answerChoiceDialog(h.ctx, { confirm: true });
    await done;
    assert.deepEqual(h.calls, []);
    assert.match(h.ctx.document.querySelector('#app-notices [role=status]')?.textContent || '', /Kept 2 conversations with background jobs; nothing else was running/);
  } finally { h.ctx.destroy(); }
});

test('Retry after a forced background failure preselects force and retries the failed job', async () => {
  const h = setup();
  try {
    h.project.sessions = [{ sessionId: 'job-part', name: 'Background conversation' }];
    h.w.cachedAllProjects = [h.project];
    h.w.api.bgAgentVerb = async (verb, id) => { h.calls.push([verb, id]); return { ok: false, error: 'daemon refused' }; };
    const { done, overlay } = await start(h);
    overlay.querySelector('input[data-choice-id=force]').checked = true;
    await answerChoiceDialog(h.ctx, { confirm: true });
    await done;
    assert.match(h.ctx.document.querySelector('#app-notices [role=alert]').textContent, /daemon refused/);
    h.w.api.bgAgentVerb = async (verb, id) => { h.calls.push([verb, id]); return { ok: true }; };
    const retry = h.ctx.read('appNoticeEntries').values().next().value.options.onAction();
    const question = await answerChoiceDialog(h.ctx, { confirm: true });
    const selected = question.querySelector('input[type=radio]:checked').dataset.choiceId;
    await retry;
    assert.equal(selected, 'force');
    assert.deepEqual(h.calls, [['stop', 'aabbccdd'], ['stop', 'aabbccdd']]);
    assert.equal(h.ctx.document.querySelector('#app-notices [role=alert]'), null);
  } finally { h.ctx.destroy(); }
});

test('an unsynced unreachable host is attempted once across remote conversations and afresh on Retry', async () => {
  const h = setup();
  try {
    h.project.sessions = ['remote-a', 'remote-b', 'remote-c'].map(sessionId => ({ sessionId, name: sessionId,
      remoteAlias: 'vps', remoteHostAt: null }));
    h.w.cachedAllProjects = [h.project];
    h.w.api.remoteStopSession = async (alias, id) => { h.calls.push(['remote', alias, id]); return { ok: false, hostUnreachable: true, error: 'host has not synced' }; };
    const { done } = await start(h);
    await answerChoiceDialog(h.ctx, { confirm: true });
    await done;
    assert.deepEqual(h.calls, [['remote', 'vps', 'remote-a']]);
    const alert = h.ctx.document.querySelector('#app-notices [role=alert]');
    for (const id of ['remote-a', 'remote-b', 'remote-c']) assert.match(alert.textContent, new RegExp(id + '.*host has not synced'));
    h.w.api.remoteStopSession = async (alias, id) => { h.calls.push(['remote', alias, id]); return { ok: true }; };
    const retry = h.ctx.read('appNoticeEntries').values().next().value.options.onAction();
    await answerChoiceDialog(h.ctx, { confirm: true });
    await retry;
    assert.deepEqual(h.calls.slice(1), ['remote-a', 'remote-b', 'remote-c'].map(id => ['remote', 'vps', id]));
    assert.equal(h.ctx.document.querySelector('#app-notices [role=alert]'), null);
  } finally { h.ctx.destroy(); }
});

test('archived running conversations remain in the full folder Stop scope', async () => {
  const h = setup();
  try {
    h.project.sessions = [{ sessionId: 'local', name: 'Archived work', archived: true }];
    h.w.cachedAllProjects = [h.project];
    const { done, overlay } = await start(h);
    assert.match(overlay.textContent, /Archived work/);
    await answerChoiceDialog(h.ctx, { confirm: true });
    await done;
    assert.deepEqual(h.calls, [['stop', 'local']]);
    assert.equal(h.project.sessions[0].archived, true);
  } finally { h.ctx.destroy(); }
});
