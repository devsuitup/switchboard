'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup(t, extra = {}) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const row = { sessionId: 'A', mergedMemberIds: ['B', 'C'], projectPath: '/project',
    summary: 'Conversation', modified: new Date().toISOString(), ...extra };
  const { window, document } = ctx;
  const calls = { questions: [], stopped: [], remote: [], jobs: [] };
  window.sessionMap.set('A', row);
  ctx.sidebar.renderProjects([makeSampleProject({ projectPath: '/project', sessions: [row] })], true);
  window.gridViewActive = true;
  window.refreshSidebar = () => {};
  window.api.bgAgentLiveJob = async () => ({ known: true, job: null });
  window.api.stopSession = async id => { calls.stopped.push(id); return { ok: true }; };
  window.api.remoteStopSession = async (alias, id) => { calls.remote.push([alias, id]); return { ok: true }; };
  window.api.bgAgentVerb = async (...args) => { calls.jobs.push(args); return { ok: true }; };
  window.appConfirm = async options => { calls.questions.push(options); return true; };
  const app = loadAppFunctions(ctx.context, { functions: ['confirmAndStopSession'] });
  const stopRow = () => document.querySelector('#si-A .session-stop-btn').onclick({ stopPropagation() {} });
  return { ...ctx, row, calls, app, stopRow };
}

test('P3 row Stop confirms both live parts once and ends both processes while keeping the conversation', async t => {
  const h = setup(t);
  h.window.activePtyIds.add('B').add('C');
  await h.stopRow();
  assert.equal(h.calls.questions.length, 1);
  const question = h.calls.questions[0];
  assert.match(question.message, /2 parts/);
  assert.match(question.message, /B.*in this window/);
  assert.match(question.message, /C.*in this window/);
  assert.match(question.message, /process.*end/);
  assert.match(question.message, /conversation is kept.*resumed/);
  assert.equal(question.danger, true);
  assert.deepEqual(h.calls.stopped, ['B', 'C']);
  assert.equal(h.window.activePtyIds.has('C'), false);
  assert.ok(h.window.sessionMap.has('A'));
});

test('remote row Stop names the host label and stops only its alive member', async t => {
  const h = setup(t, { remoteAlias: 'host', remoteDescriptorSeen: true });
  h.window.setRemoteHostLabels([{ alias: 'host', label: 'Production' }]);
  h.read("for (const id of ['A', 'C']) remoteState(id).apply({ type: 'liveness', value: 'dead' }); remoteState('B').apply({ type: 'liveness', value: 'alive' })");
  await h.stopRow();
  assert.equal(h.calls.questions.length, 1);
  assert.match(h.calls.questions[0].message, /1 part.*B.*on Production/s);
  assert.deepEqual(h.calls.remote, [['host', 'B']]);
  assert.deepEqual(h.calls.stopped, []);
});

test('Q2 row Stop names a background part that keeps running and stops only the local part', async t => {
  const h = setup(t, { mergedMemberIds: ['B', 'J'] });
  h.window.activePtyIds.add('B');
  h.window.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'J' ? { id: 'job-J' } : null });
  await h.stopRow();
  assert.equal(h.calls.questions.length, 1);
  assert.match(h.calls.questions[0].message, /J.*job-J.*keeps running.*Agents view/s);
  assert.deepEqual(h.calls.stopped, ['B']);
  assert.deepEqual(h.calls.jobs, []);
});

test('an unseeded remote member is named as possibly running and is stopped', async t => {
  const h = setup(t, { remoteAlias: 'host', remoteHostAt: null, remoteDescriptorSeen: false });
  h.read("for (const id of ['A', 'C']) remoteState(id).apply({ type: 'liveness', value: 'dead' })");
  await h.stopRow();
  assert.equal(h.calls.questions.length, 1, 'a possibly live remote part needs confirmation');
  assert.match(h.calls.questions[0].message, /B.*possibly running.*on host/);
  assert.deepEqual(h.calls.remote, [['host', 'B']]);
});

test('a row Stop continues after failures and lists every failed part in one alert', async t => {
  const h = setup(t);
  h.window.activePtyIds.add('A').add('B').add('C');
  h.window.api.stopSession = async id => {
    h.calls.stopped.push(id);
    if (id === 'B') return { ok: true };
    if (id === 'A') throw new Error('first failure');
    return { ok: false, error: 'last failure' };
  };
  await h.stopRow();
  assert.deepEqual(h.calls.stopped, ['A', 'B', 'C']);
  const alerts = h.document.querySelectorAll('#app-notices [role="alert"]');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].textContent, /A.*first failure.*C.*last failure/s);
  assert.equal(h.window.activePtyIds.has('B'), false);
  assert.ok(h.window.activePtyIds.has('A'));
  assert.ok(h.window.activePtyIds.has('C'));
});

test('a row Stop names the outside process it cannot stop', async t => {
  const h = setup(t, { mergedMemberStatuses: { C: { status: 'idle' } } });
  h.window.activePtyIds.add('B');
  await h.stopRow();
  assert.match(h.calls.questions[0].message, /C.*outside this window.*keeps running/);
  assert.deepEqual(h.calls.stopped, ['B']);
});

test('a mixed row Stop detaches an attached job tab and never kills its job', async t => {
  const h = setup(t, { mergedMemberIds: ['B', 'J'] });
  h.window.activePtyIds.add('B').add('J');
  h.window.openSessions.set('J', { attach: true, attachJobId: 'job-J', session: { sessionId: 'J' } });
  h.window.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'J' ? { id: 'job-J' } : null });
  await h.stopRow();
  assert.match(h.calls.questions[0].message, /J.*detach/i);
  assert.match(h.calls.questions[0].message, /job-J.*keeps running.*Agents view/s);
  assert.deepEqual(h.calls.stopped, ['B', 'J']);
  assert.deepEqual(h.calls.jobs, []);
  assert.equal(h.window.activePtyIds.has('J'), false);
});

test('unknown background ownership is declared and excluded before stopping other row parts', async t => {
  const h = setup(t);
  h.window.activePtyIds.add('B').add('C');
  h.window.api.bgAgentLiveJob = async id => ({ known: id !== 'C', reason: 'daemon unavailable', job: null });
  await h.stopRow();
  assert.match(h.calls.questions[0].message, /C.*cannot tell.*daemon unavailable/);
  assert.deepEqual(h.calls.stopped, ['B']);
  assert.ok(h.window.activePtyIds.has('C'));
});

test('tab Stop names the loss and location but only stops that tab of a merged conversation', async t => {
  const h = setup(t);
  h.window.activePtyIds.add('A').add('B');
  await h.app.confirmAndStopSession('A');
  assert.match(h.calls.questions[0].message, /1 part.*A.*in this window/s);
  assert.match(h.calls.questions[0].message, /conversation is kept/);
  assert.deepEqual(h.calls.stopped, ['A']);
  assert.ok(h.window.activePtyIds.has('B'));
});

test('a closed job tab remains excluded while other local parts stop', async t => {
  const h = setup(t, { mergedMemberIds: ['B', 'J'] });
  h.window.activePtyIds.add('B');
  h.window.openSessions.set('J', { attach: true, closed: true, attachJobId: 'job-J' });
  h.window.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'J' ? { id: 'job-J' } : null });
  await h.stopRow();
  assert.deepEqual(h.calls.stopped, ['B']);
  assert.match(h.calls.questions[0].message, /job-J.*keeps running.*Agents view/s);
  assert.doesNotMatch(h.calls.questions[0].message, /detach/i);
});

test('a null backend rejection is reported without preventing the other parts from stopping', async t => {
  const h = setup(t);
  h.window.activePtyIds.add('B').add('C');
  h.window.api.stopSession = async id => {
    h.calls.stopped.push(id);
    if (id === 'B') return Promise.reject(null);
    return { ok: true };
  };
  await h.stopRow();
  assert.deepEqual(h.calls.stopped, ['B', 'C']);
  assert.match(h.document.querySelector('[role="alert"]').textContent, /B.*unknown error/);
  assert.ok(h.window.activePtyIds.has('B'));
  assert.equal(h.window.activePtyIds.has('C'), false);
});

test('a background-only row explains the exclusion without asking to stop zero parts', async t => {
  const h = setup(t, { mergedMemberIds: ['J'] });
  h.window.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'J' ? { id: 'job-J' } : null });
  await h.stopRow();
  assert.deepEqual(h.calls.questions, []);
  assert.deepEqual(h.calls.stopped, []);
  const notice = h.document.querySelector('[role="alert"]');
  assert.match(notice.textContent, /J.*job-J.*keeps running.*Agents view/s);
  assert.doesNotMatch(notice.textContent, /Stop 0 parts\?/);
});

test('Retry clears a mixed row failure when only its failed detach target remains', async t => {
  const h = setup(t, { mergedMemberIds: ['B', 'J'] });
  h.window.activePtyIds.add('B').add('J');
  h.window.openSessions.set('J', { attach: true, attachJobId: 'job-J' });
  let failed = true;
  h.window.api.stopSession = async id => id === 'J' && failed ? { ok: false, error: 'detach refused' } : { ok: true };
  await h.stopRow();
  const notice = h.document.querySelector('[role="alert"]');
  assert.match(notice.textContent, /detach refused/);
  assert.equal(h.window.activePtyIds.has('B'), false);
  failed = false;
  notice.querySelector('.app-notice-action').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.window.activePtyIds.has('J'), false);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});
