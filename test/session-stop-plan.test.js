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
  const app = loadAppFunctions(ctx.context, { functions: ['confirmAndStopSession', 'detachSession'] });
  const stopRow = () => document.querySelector('#si-A .session-stop-btn').onclick({ stopPropagation() {} });
  return { ...ctx, row, calls, app, stopRow };
}

test('Stop routes a remote member by its open tab under a local row', async t => {
  const h = setup(t, { mergedMemberIds: ['B'] });
  h.window.activePtyIds.add('A');
  h.window.openSessions.set('B', { session: { sessionId: 'B', remoteAlias: 'host', remoteDescriptorSeen: true }, closed: false });
  h.window.setRemoteHostLabels([{ alias: 'host', label: 'Production' }]);
  await h.stopRow();
  assert.deepEqual(h.calls.remote, [['host', 'B']], 'the remote member must stop on its own host');
  assert.deepEqual(h.calls.stopped, ['A']);
  assert.deepEqual(h.calls.jobs, []);
  assert.match(h.calls.questions[0].message, /Part B on Production/);
});

test('Stop routes a local member by its open tab under a remote row', async t => {
  const h = setup(t, { mergedMemberIds: ['B'], remoteAlias: 'host', remoteDescriptorSeen: true });
  h.window.openSessions.set('B', { session: { sessionId: 'B', projectPath: '/project' }, closed: false });
  await h.stopRow();
  assert.deepEqual(h.calls.jobs, []);
  assert.deepEqual(h.calls.remote, [['host', 'A']]);
  assert.deepEqual(h.calls.stopped, ['B'], 'the local member must stop through its own terminal');
  assert.match(h.calls.questions[0].message, /Part B in this window/);
});

test('Stop routes a member without an open tab or session record through its row host', async t => {
  const h = setup(t, { mergedMemberIds: ['B'], remoteAlias: 'host', remoteDescriptorSeen: true });
  h.window.sessionMap.delete('B');
  h.window.api.bgAgentLiveJob = async () => { throw new Error('remote members must not query the local daemon'); };
  await h.stopRow();
  assert.deepEqual(h.calls.remote, [['host', 'A'], ['host', 'B']], 'unopened members inherit their row host');
  assert.deepEqual(h.calls.stopped, []);
  assert.deepEqual(h.calls.jobs, []);
  assert.match(h.calls.questions[0].message, /Part B on host/);
});

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

test('Q2 row Stop names and stops the live background part and the local part', async t => {
  const h = setup(t, { mergedMemberIds: ['B', 'J'] });
  h.window.activePtyIds.add('B');
  h.window.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'J' ? { id: 'abcd1234' } : null });
  await h.stopRow();
  assert.equal(h.calls.questions.length, 1);
  assert.match(h.calls.questions[0].message, /J.*abcd1234; its process ends/s);
  assert.deepEqual(h.calls.stopped, ['B']);
  assert.deepEqual(h.calls.jobs, [['stop', 'abcd1234']]);
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

test('a mixed row Stop ends an attached job before closing its tab', async t => {
  const h = setup(t, { mergedMemberIds: ['B', 'J'] });
  h.window.activePtyIds.add('B').add('J');
  h.window.openSessions.set('J', { attach: true, attachJobId: 'abcd1234', session: { sessionId: 'J' } });
  h.window.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'J' ? { id: 'abcd1234' } : null });
  await h.stopRow();
  assert.match(h.calls.questions[0].message, /J.*background job/i);
  assert.match(h.calls.questions[0].message, /abcd1234; its process ends/s);
  assert.deepEqual(h.calls.stopped, ['B', 'J']);
  assert.deepEqual(h.calls.jobs, [['stop', 'abcd1234']]);
  assert.equal(h.window.activePtyIds.has('J'), false);
});

test('active local parts stop even when background ownership is unknown or names a job', async t => {
  const h = setup(t);
  h.window.activePtyIds.add('B').add('C');
  h.window.api.bgAgentLiveJob = async id => ({ known: id !== 'C', reason: 'daemon unavailable', job: id === 'B' ? { id: '1234abcd' } : null });
  await h.stopRow();
  assert.equal(h.calls.questions.length, 1);
  assert.deepEqual(h.calls.stopped, ['B', 'C']);
  assert.equal(h.window.activePtyIds.has('C'), false);
});

test('tab Stop names the loss and location but only stops that tab of a merged conversation', async t => {
  const h = setup(t);
  h.window.activePtyIds.add('A').add('B');
  await h.app.confirmAndStopSession('A');
  assert.match(h.calls.questions[0].message, /this session.*Conversation.*in this window/is);
  assert.doesNotMatch(h.calls.questions[0].message, /\bpart\b/i);
  assert.match(h.calls.questions[0].message, /conversation is kept/);
  assert.deepEqual(h.calls.stopped, ['A']);
  assert.ok(h.window.activePtyIds.has('B'));
});

test('a plain local tab stops once after one confirmation when the job directory is unreadable', async t => {
  const h = setup(t, { mergedMemberIds: [] });
  h.window.activePtyIds.add('A');
  h.window.api.bgAgentLiveJob = async () => ({ known: false, reason: 'unreadable unrelated job' });
  await h.app.confirmAndStopSession('A');
  assert.equal(h.calls.questions.length, 1);
  assert.deepEqual(h.calls.stopped, ['A']);
});

test('an unseeded remote row accepts absent members while stopping its only running member', async t => {
  const h = setup(t, { remoteAlias: 'host', remoteHostAt: null });
  h.window.api.remoteStopSession = async (alias, id) => {
    h.calls.remote.push([alias, id]);
    return id === 'B' ? { ok: true } : { ok: false, error: 'session not found on that host' };
  };
  await h.stopRow();
  assert.deepEqual(h.calls.remote, [['host', 'A'], ['host', 'B'], ['host', 'C']]);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});

test('an unreachable host is asked only once and every remaining target reports its reason', async t => {
  const h = setup(t, { remoteAlias: 'host', remoteHostAt: null });
  h.window.api.remoteStopSession = async (alias, id) => {
    h.calls.remote.push([alias, id]);
    return { ok: false, hostUnreachable: true, error: 'ssh timed out' };
  };
  await h.stopRow();
  assert.deepEqual(h.calls.remote, [['host', 'A']]);
  const alerts = h.document.querySelectorAll('[role="alert"]');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].textContent, /A.*ssh timed out.*B.*ssh timed out.*C.*ssh timed out/s);
});

for (const [field, value] of [['name', 'My named session'], ['aiTitle', 'Generated title'], ['summary', 'Conversation']]) {
  test(`a single-part Stop uses the row display ${field} without a raw id or part wording`, async t => {
    const h = setup(t, { mergedMemberIds: [], [field]: value });
    h.window.activePtyIds.add('A');
    await h.stopRow();
    const message = h.calls.questions[0].message;
    assert.match(message, /Stop this session\?/);
    assert.ok(message.includes(value));
    assert.doesNotMatch(message, /\bpart\b|\bA\b/);
    assert.match(message, /process ends.*conversation is kept.*resumed/s);
  });
}

test('a single-part Stop without a display name never exposes its raw id', async t => {
  const h = setup(t, { mergedMemberIds: [], summary: '' });
  h.window.activePtyIds.add('A');
  await h.stopRow();
  assert.match(h.calls.questions[0].message, /Untitled conversation/);
  assert.doesNotMatch(h.calls.questions[0].message, /\bpart\b|\bA\b/);
});

test('a Stop with an empty plan explains that nothing is running', async t => {
  const h = setup(t);
  await h.stopRow();
  assert.deepEqual(h.calls.questions, []);
  assert.deepEqual(h.calls.stopped, []);
  assert.match(h.document.querySelector('#app-notices').textContent, /nothing is running to stop/i);
});

test('Retry confirms only failed targets and does not stop a successful open tab again before its exit event', async t => {
  const h = setup(t);
  h.window.activePtyIds.add('B').add('C');
  h.window.openSessions.set('B', { closed: false });
  h.window.openSessions.set('C', { closed: false });
  let failed = true;
  h.window.api.stopSession = async id => {
    h.calls.stopped.push(id);
    return id === 'C' && failed ? { ok: false, error: 'stop refused' } : { ok: true };
  };
  await h.stopRow();
  failed = false;
  h.document.querySelector('.app-notice-action').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.questions.length, 2);
  assert.match(h.calls.questions[1].message, /C.*in this window/);
  assert.doesNotMatch(h.calls.questions[1].message, /\bB\b/);
  assert.deepEqual(h.calls.stopped, ['B', 'C', 'C']);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});

for (const closedTab of [false, true]) {
  test(`Retry clears the failed B notice without confirming or stopping after B exits (${closedTab ? 'closed tab' : 'no tab'})`, async t => {
    const h = setup(t);
    h.window.activePtyIds.add('B');
    h.window.api.stopSession = async id => {
      h.calls.stopped.push(id);
      return { ok: false, error: h.window.activePtyIds.has(id) ? 'boom' : 'not running' };
    };
    await h.stopRow();
    const notice = h.document.querySelector('[role="alert"]');
    assert.match(notice.textContent, /B.*boom/);
    h.window.activePtyIds.delete('B');
    if (closedTab) h.window.openSessions.set('B', { closed: true });
    notice.querySelector('.app-notice-action').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.questions.length, 1, 'Retry must not confirm an exited part');
    assert.deepEqual(h.calls.stopped, ['B']);
    assert.equal(h.document.querySelector('[role="alert"]'), null);
    assert.equal(h.document.querySelector('.app-notice-action'), null);
    assert.match(h.document.querySelector('#app-notices').textContent, /Nothing is running to stop\./);
  });
}

for (const openTabOnly of [false, true]) {
  test(`Retry confirms and stops only failed B while it has ${openTabOnly ? 'an open tab' : 'a live PTY'}`, async t => {
    const h = setup(t);
    h.window.activePtyIds.add('A').add('B').add('C');
    let failed = true;
    h.window.api.stopSession = async id => {
      h.calls.stopped.push(id);
      return failed && id !== 'A' ? { ok: false, error: 'boom' } : { ok: true };
    };
    await h.stopRow();
    h.window.activePtyIds.delete('C');
    h.window.openSessions.set('C', { closed: true });
    if (openTabOnly) {
      h.window.activePtyIds.delete('B');
      h.window.openSessions.set('B', { closed: false });
    }
    failed = false;
    h.document.querySelector('.app-notice-action').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.questions.length, 2);
    assert.match(h.calls.questions[1].message, /Stop 1 part\?.*Part B in this window\./s);
    assert.doesNotMatch(h.calls.questions[1].message, /Part [AC]\b/);
    assert.deepEqual(h.calls.stopped, ['A', 'B', 'C', 'B']);
    assert.equal(h.document.querySelector('[role="alert"]'), null);
  });
}

test('a first local Stop that returns not running clears liveness without a failure notice', async t => {
  const h = setup(t);
  h.window.activePtyIds.add('B');
  h.window.api.stopSession = async id => {
    h.calls.stopped.push(id);
    return { ok: false, error: 'not running' };
  };
  await h.stopRow();
  assert.equal(h.calls.questions.length, 1);
  assert.deepEqual(h.calls.stopped, ['B']);
  assert.equal(h.window.activePtyIds.has('B'), false);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});

test('Retry clears a remote failure after the unseeded member is confirmed dead', async t => {
  const h = setup(t, { remoteAlias: 'host', remoteHostAt: null, remoteDescriptorSeen: true });
  h.read("for (const id of ['A', 'C']) remoteState(id).apply({ type: 'liveness', value: 'dead' })");
  h.window.api.remoteStopSession = async (alias, id) => {
    h.calls.remote.push([alias, id]);
    return { ok: false, error: 'boom' };
  };
  await h.stopRow();
  h.read("remoteState('B').apply({ type: 'liveness', value: 'dead' })");
  h.document.querySelector('.app-notice-action').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.questions.length, 1);
  assert.deepEqual(h.calls.remote, [['host', 'B']]);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
  assert.match(h.document.querySelector('#app-notices').textContent, /Nothing is running to stop\./);
});

test('Retry retains a possibly running remote B while dropping confirmed dead C', async t => {
  const h = setup(t, { remoteAlias: 'host', remoteHostAt: null, remoteDescriptorSeen: false });
  h.read("remoteState('A').apply({ type: 'liveness', value: 'dead' })");
  let failed = true;
  h.window.api.remoteStopSession = async (alias, id) => {
    h.calls.remote.push([alias, id]);
    return failed ? { ok: false, error: 'boom' } : { ok: true };
  };
  await h.stopRow();
  h.read("remoteState('C').apply({ type: 'liveness', value: 'dead' })");
  failed = false;
  h.document.querySelector('.app-notice-action').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.questions.length, 2);
  assert.match(h.calls.questions[1].message, /Stop 1 part\?.*B.*possibly running/s);
  assert.doesNotMatch(h.calls.questions[1].message, /Part C\b/);
  assert.deepEqual(h.calls.remote, [['host', 'B'], ['host', 'C'], ['host', 'B']]);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});

test('a closed job tab stops its live job while other local parts stop', async t => {
  const h = setup(t, { mergedMemberIds: ['B', 'J'] });
  h.window.activePtyIds.add('B');
  h.window.openSessions.set('J', { attach: true, closed: true, attachJobId: 'abcd1234' });
  h.window.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'J' ? { id: 'abcd1234' } : null });
  await h.stopRow();
  assert.deepEqual(h.calls.stopped, ['B']);
  assert.match(h.calls.questions[0].message, /abcd1234; its process ends/s);
  assert.deepEqual(h.calls.jobs, [['stop', 'abcd1234']]);
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

test('a background-only row confirms and stops job abcd1234', async t => {
  const h = setup(t, { mergedMemberIds: ['J'] });
  h.window.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'J' ? { id: 'abcd1234' } : null });
  await h.stopRow();
  assert.equal(h.calls.questions.length, 1);
  assert.deepEqual(h.calls.stopped, []);
  assert.deepEqual(h.calls.jobs, [['stop', 'abcd1234']]);
  assert.match(h.calls.questions[0].message, /J.*abcd1234; its process ends/s);
});

test('Retry clears a mixed row failure when only its failed detach target remains', async t => {
  const h = setup(t, { mergedMemberIds: ['B', 'J'] });
  h.window.activePtyIds.add('B').add('J');
  h.window.openSessions.set('J', { attach: true, attachJobId: 'abcd1234' });
  let failed = true;
  h.window.api.stopSession = async id => id === 'J' && failed ? { ok: false, error: 'detach refused' } : { ok: true };
  await h.app.detachSession(h.row);
  const notice = h.document.querySelector('[role="alert"]');
  assert.match(notice.textContent, /detach refused/);
  assert.equal(h.window.activePtyIds.has('B'), true);
  failed = false;
  notice.querySelector('.app-notice-action').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.window.activePtyIds.has('J'), false);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});
