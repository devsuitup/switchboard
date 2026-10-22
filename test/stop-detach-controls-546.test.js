'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup(t, { attached = true, jobId = 'abcdef12', merged = [] } = {}) {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const w = h.window;
  const session = { sessionId: 'A', name: 'Background work', projectPath: '/project',
    mergedMemberIds: merged, modified: new Date().toISOString() };
  const entry = { session, attach: attached, attachJobId: jobId, element: h.document.createElement('div'),
    terminal: { write() {} }, closed: false };
  w.sessionMap.set('A', session);
  for (const id of merged) w.sessionMap.set(id, { ...session, sessionId: id, mergedMemberIds: [] });
  w.openSessions.set('A', entry);
  w.activePtyIds.add('A');
  Object.assign(w, { gridViewActive: true, terminalsEl: h.document.getElementById('terminals'),
    refreshSidebar() {}, replayHiddenBuffer() {}, skippedWorkingSetEntries: new Map(),
    updateRunningIndicators() {}, schedulePersistWorkingSet() {} });
  const calls = [];
  w.api.bgAgentLiveJob = async () => ({ known: true, job: { id: jobId } });
  w.api.checkBgAgentVerb = async (...args) => { calls.push(['check', ...args]); return { ok: true }; };
  w.appConfirm = async question => { calls.push(['confirm', question]); return true; };
  w.api.bgAgentVerb = async (...args) => { calls.push(['verb', ...args]); return { ok: true }; };
  w.api.stopSession = async id => { calls.push(['tab', id, entry.jobEnding]); return { ok: true, detached: true }; };
  w.refreshAgentsRoster = () => calls.push(['refresh']);
  const functions = ['confirmAndStopSession', 'applyProcessExit'];
  if (/^async function detachSession\(/m.test(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'))) functions.push('detachSession');
  loadAppFunctions(h.context, { functions });
  const render = () => h.sidebar.renderProjects([makeSampleProject({ projectPath: '/project', sessions: [session] })], true);
  render();
  const stop = () => h.document.querySelector('#si-A .session-stop-btn').onclick({ stopPropagation() {} });
  return { ...h, w, session, entry, calls, render, stop };
}

test('A1 attached row has separate accessible Detach and Stop buttons', t => {
  const h = setup(t);
  const row = h.document.querySelector('#si-A');
  assert.ok(row.classList.contains('has-detachable-tab'), 'attached row exposes Detach');
  const detach = row.querySelector('.session-detach-btn');
  assert.ok(detach, 'attached row has a Detach button');
  assert.equal(detach.getAttribute('aria-label'), 'Detach (the session keeps running)');
  assert.equal(detach.title, detach.getAttribute('aria-label'));
  const stop = row.querySelector('.session-stop-btn');
  assert.equal(stop.getAttribute('aria-label'), 'Stop session');
});

test('A2 a local row never offers Detach', t => {
  const h = setup(t, { attached: false });
  assert.equal(h.document.querySelector('#si-A').classList.contains('has-detachable-tab'), false);
});

test('A3 row Stop checks the job before one danger question then stops the job before its tab', async t => {
  const h = setup(t);
  await h.stop();
  assert.equal(h.calls.filter(call => call[0] === 'confirm').length, 1, 'Stop asks exactly once');
  assert.deepEqual(h.calls.map(call => call[0]), ['check', 'confirm', 'verb', 'tab', 'refresh']);
  assert.deepEqual(h.calls[0], ['check', 'stop', 'abcdef12']);
  assert.match(h.calls[1][1].message, /background job abcdef12; its process ends/);
  assert.equal(h.calls[1][1].danger, true);
  assert.deepEqual(h.calls[2], ['verb', 'stop', 'abcdef12']);
  assert.deepEqual(h.calls[3], ['tab', 'A', 'stop']);
});

test('A4 an unattached live job stops after one confirmation without a tab stop', async t => {
  const h = setup(t);
  h.w.openSessions.clear();
  h.w.activePtyIds.clear();
  await h.stop();
  assert.equal(h.calls.filter(call => call[0] === 'confirm').length, 1, 'unattached job Stop asks once');
  assert.deepEqual(h.calls.map(call => call[0]), ['check', 'confirm', 'verb', 'refresh']);
  assert.deepEqual(h.calls[2], ['verb', 'stop', 'abcdef12']);
});

test('A5 a refused job check leaves a persistent reason without asking or executing', async t => {
  const h = setup(t);
  h.w.api.checkBgAgentVerb = async () => ({ ok: false, error: 'conversation is running outside' });
  await h.stop();
  assert.deepEqual(h.calls, [], 'refused Stop never confirms or executes');
  assert.match(h.document.querySelector('[role="alert"]')?.textContent || '', /conversation is running outside/);
  assert.equal(h.entry.closed, false);
});

test('A6 invalid job identity is explained and never stopped blind', async t => {
  const h = setup(t, { jobId: 'unknown-job' });
  await h.stop();
  assert.deepEqual(h.calls, [], 'invalid job cannot be stopped or detached by Stop');
  assert.match(h.document.querySelector('[role="alert"]')?.textContent || '', /cannot tell which background job runs this part; stop it from the Agents view/);
});

test('A7 a job not hosted by the daemon only detaches and its exit reads Detached', async t => {
  const h = setup(t);
  h.w.api.bgAgentLiveJob = async () => ({ known: true, job: null });
  await h.stop();
  const question = h.calls.find(call => call[0] === 'confirm');
  assert.match(question?.[1].message || '', /background job abcdef12 is not running in the daemon; its tab detaches/);
  assert.doesNotMatch(question?.[1].message || '', /process ends/);
  assert.match(question?.[1].message || '', /^Detach this tab\?/);
  assert.equal(question[1].title, 'Detach tab?');
  assert.equal(question[1].confirmLabel, 'Detach');
  assert.equal(question[1].danger, false);
  assert.deepEqual(h.calls.filter(call => ['check', 'verb'].includes(call[0])), []);
  assert.equal(h.entry.jobEnding, undefined);
  h.w.gridViewActive = false;
  h.w.activeSessionId = null;
  h.w.applyProcessExit('A', 0, null, true);
  assert.equal(h.w.lastSessionExit('A').detached, true);
  assert.equal(h.w.lifecycleLabel({ exit: h.w.lastSessionExit('A') }), 'Detached');
});

test('A7 mixed hosted and notHosted parts describe stopping one job and detaching the other tab', async t => {
  const h = setup(t, { merged: ['B'] });
  h.w.openSessions.set('B', { attach: true, attachJobId: '1234abcd', closed: false });
  h.w.activePtyIds.add('B');
  h.w.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'A' ? null : { id: '1234abcd' } });
  await h.stop();
  const message = h.calls.find(call => call[0] === 'confirm')?.[1].message || '';
  assert.match(message, /^Stop 1 part\?/);
  const question = h.calls.find(call => call[0] === 'confirm')[1];
  assert.equal(question.title, 'Stop session?');
  assert.equal(question.confirmLabel, 'Stop');
  assert.equal(question.danger, true);
  assert.match(message, /Part A: background job abcdef12 is not running in the daemon; its tab detaches\./);
  assert.match(message, /Part B: background job 1234abcd; its process ends\./);
  assert.deepEqual(h.calls.filter(call => call[0] === 'verb'), [['verb', 'stop', '1234abcd']]);
  assert.deepEqual(h.calls.filter(call => call[0] === 'tab').map(call => call[1]), ['A', 'B']);
  assert.equal(h.entry.jobEnding, undefined);
  assert.equal(h.w.openSessions.get('B').jobEnding, 'stop');
});

test('A8 row Detach asks nothing, keeps the job running and offers Undo', async t => {
  const h = setup(t);
  const button = h.document.querySelector('#si-A .session-detach-btn');
  assert.ok(button, 'row has a Detach action');
  await button.onclick({ stopPropagation() {} });
  assert.deepEqual(h.calls, [['tab', 'A', undefined]]);
  assert.equal(h.entry.detachRequested, true);
  assert.equal(h.document.querySelector('.app-notice-action')?.textContent, 'Undo');
});

test('A9 grid Detach follows the card rekey and hides on closure', t => {
  const h = setup(t);
  h.evalPublic('shortcuts.js');
  h.evalPublic('grid-view.js');
  h.w.wrapInGridCard('A');
  const card = h.document.querySelector('.grid-card');
  const button = card.querySelector('.grid-card-detach-btn');
  assert.ok(button, 'attached card has a Detach action');
  assert.equal(button.getAttribute('aria-label'), 'Detach (the session keeps running)');
  assert.equal(button.style.display, '');
  const detached = [];
  h.w.detachSession = (id, btn) => detached.push([id, btn]);
  card.rekeySessionId('bg');
  h.w.openSessions.delete('A');
  h.w.openSessions.set('bg', h.entry);
  h.w.activePtyIds.delete('A');
  h.w.activePtyIds.add('bg');
  button.click();
  assert.deepEqual(detached, [['bg', button]]);
  h.entry.closed = true;
  h.w.updateGridCardActivity('bg', card, { ...h.session, sessionId: 'bg' });
  assert.equal(button.style.display, 'none');
});

test('A10 header Detach follows Stop, is visible only on a running attach and invokes Detach', t => {
  const h = setup(t);
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const holder = h.document.createElement('div');
  holder.innerHTML = html;
  const controls = holder.querySelector('#terminal-header-session');
  h.document.body.append(controls);
  const detach = controls.querySelector('#terminal-detach-btn');
  assert.ok(detach, 'header has a Detach action');
  assert.equal(controls.querySelector('#terminal-stop-btn').nextElementSibling, detach);
  Object.assign(h.w, { activeSessionId: 'A', terminalStopBtn: controls.querySelector('#terminal-stop-btn'),
    paintTerminalHeaderStatus() {}, updatePtyTitle() {}, backgroundActionReason: () => null });
  loadAppFunctions(h.context, { functions: ['initTerminalDetachControl', 'updateTerminalHeader'] });
  const calls = [];
  h.w.detachSession = (id, btn) => calls.push([id, btn]);
  h.w.initTerminalDetachControl();
  h.w.updateTerminalHeader();
  assert.equal(detach.style.display, '');
  assert.equal(h.w.terminalStopBtn.title, 'Stop session');
  assert.equal(detach.getAttribute('aria-label'), 'Detach (the session keeps running)');
  detach.click();
  assert.deepEqual(calls, [['A', detach]]);
  h.entry.attach = false;
  h.w.updateTerminalHeader();
  assert.equal(detach.style.display, 'none');
});

test('A13 successful job Stop exit reads Stopped', async t => {
  const h = setup(t);
  await h.stop();
  h.w.gridViewActive = false;
  h.w.activeSessionId = null;
  h.w.applyProcessExit('A', 0, null, true);
  assert.equal(h.w.lastSessionExit('A').detached, false, 'job Stop must not read Detached');
  assert.equal(h.w.lifecycleLabel({ exit: h.w.lastSessionExit('A') }), 'Stopped');
});

for (const attached of [false, true]) {
  test(`unknown job ownership is an exclusion with its reason (attached ${attached})`, async t => {
    const h = setup(t);
    if (!attached) {
      h.w.openSessions.clear();
      h.w.activePtyIds.clear();
    }
    h.w.api.bgAgentLiveJob = async () => ({ known: false, reason: 'daemon read failed' });
    await h.stop();
    assert.deepEqual(h.calls, [], 'unknown ownership cannot trigger a stop or a dialog');
    assert.match(h.document.querySelector('[role="alert"]')?.textContent || '', /daemon read failed/);
    assert.doesNotMatch(h.document.querySelector('#app-notices').textContent, /Nothing is running/);
  });
}

test('a rejected job check reports its reason without asking or executing', async t => {
  const h = setup(t);
  h.w.api.checkBgAgentVerb = async () => { throw new Error('check transport failed'); };
  await h.stop();
  assert.deepEqual(h.calls, [], 'rejected check cannot trigger a stop or a dialog');
  assert.match(h.document.querySelector('[role="alert"]')?.textContent || '', /check transport failed/);
});

test('an invalid unattached job id is excluded with its reason', async t => {
  const h = setup(t, { jobId: 'unknown-job' });
  h.w.openSessions.clear();
  h.w.activePtyIds.clear();
  await h.stop();
  assert.deepEqual(h.calls, []);
  assert.match(h.document.querySelector('[role="alert"]')?.textContent || '', /cannot tell which background job runs this part/);
});

test('a failed job Stop leaves its tab open and Retry stops only the failed job', async t => {
  const h = setup(t, { merged: ['B'] });
  h.w.activePtyIds.add('B');
  let failed = true;
  h.w.api.bgAgentVerb = async (...args) => {
    h.calls.push(['verb', ...args]);
    return failed ? { ok: false, error: 'job stop refused' } : { ok: true };
  };
  await h.stop();
  assert.equal(h.entry.jobEnding, undefined);
  assert.equal(h.entry.closed, false);
  assert.ok(h.w.activePtyIds.has('A'));
  assert.deepEqual(h.calls.filter(call => call[0] === 'tab'), [['tab', 'B', undefined]]);
  const retry = h.document.querySelector('[role="alert"] .app-notice-action');
  assert.equal(retry?.textContent, 'Retry');
  failed = false;
  retry.click();
  for (let i = 0; i < 24; i++) await Promise.resolve();
  assert.deepEqual(h.calls.filter(call => call[0] === 'tab'), [['tab', 'B', undefined], ['tab', 'A', 'stop']]);
  assert.equal(h.calls.filter(call => call[0] === 'confirm').length, 2);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});

test('Retry after job Stop succeeds only retries the failed tab and retains the Stopped exit', async t => {
  const h = setup(t);
  let failed = true;
  h.w.api.stopSession = async id => {
    h.calls.push(['tab', id, h.entry.jobEnding]);
    if (failed) throw new Error('tab detach transport failed');
    return { ok: true, detached: true };
  };
  await h.stop();
  assert.equal(h.entry.jobEnding, 'stop');
  assert.deepEqual(h.calls.filter(call => call[0] === 'check'), [['check', 'stop', 'abcdef12']]);
  assert.deepEqual(h.calls.filter(call => call[0] === 'verb'), [['verb', 'stop', 'abcdef12']]);
  assert.deepEqual(h.calls.filter(call => call[0] === 'tab'), [['tab', 'A', 'stop']]);
  const retry = h.document.querySelector('[role="alert"] .app-notice-action');
  assert.equal(retry?.textContent, 'Retry');
  failed = false;
  retry.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.filter(call => call[0] === 'check'), [['check', 'stop', 'abcdef12']], 'Retry must not check the already stopped job again');
  assert.deepEqual(h.calls.filter(call => call[0] === 'verb'), [['verb', 'stop', 'abcdef12']], 'Retry must not stop the already stopped job again');
  assert.deepEqual(h.calls.filter(call => call[0] === 'tab'), [['tab', 'A', 'stop'], ['tab', 'A', 'stop']]);
  assert.equal(h.entry.jobEnding, 'stop');
  assert.equal(h.document.querySelector('[role="alert"]'), null);
  const question = h.calls.filter(call => call[0] === 'confirm').at(-1)[1];
  assert.equal(question.title, 'Detach tab?');
  assert.equal(question.confirmLabel, 'Detach');
  assert.equal(question.danger, false);
  h.w.gridViewActive = false;
  h.w.activeSessionId = null;
  h.w.applyProcessExit('A', 0, null, true);
  assert.equal(h.w.lifecycleLabel({ exit: h.w.lastSessionExit('A') }), 'Stopped');
});

test('an attached tab refuses a different daemon job and accepts its own id case-insensitively', async t => {
  const h = setup(t);
  h.w.api.bgAgentLiveJob = async () => ({ known: true, job: { id: '1234abcd' } });
  await h.stop();
  assert.deepEqual(h.calls, [], 'a changed daemon job must neither be confirmed nor stopped nor detached');
  assert.match(h.document.querySelector('[role="alert"]')?.textContent || '',
    /background job abcdef12 is no longer the running job \(1234abcd\); stop it from the Agents view/);
  assert.ok(h.w.activePtyIds.has('A'));
  assert.equal(h.entry.jobEnding, undefined);
  h.w.api.bgAgentLiveJob = async () => ({ known: true, job: { id: 'ABCDEF12' } });
  await h.stop();
  assert.deepEqual(h.calls.filter(call => call[0] === 'verb'), [['verb', 'stop', 'abcdef12']]);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});

test('Detach with nothing attached explains the empty plan without a dialog', async t => {
  const h = setup(t, { attached: false });
  const button = h.document.querySelector('#si-A .session-detach-btn');
  assert.ok(button, 'the row carries the hidden Detach control');
  await button.onclick({ stopPropagation() {} });
  assert.deepEqual(h.calls, []);
  assert.match(h.document.querySelector('#app-notices').textContent, /Nothing is attached to detach/);
});

function remoteSetup(t, options) {
  const h = setup(t, { attached: false, ...options });
  Object.assign(h.session, { remoteAlias: 'vps', remoteAttachable: true, remoteAttachSessionId: 'A' });
  h.w.remoteHostLabel = alias => alias === 'vps' ? 'Build server' : alias;
  h.w.api.remoteStopSession = async (...args) => { h.calls.push(['remoteStop', ...args]); return { ok: true }; };
  h.render();
  return h;
}

for (const [failure, stop] of [
  ['hostUnreachable', async () => ({ ok: false, hostUnreachable: true, error: 'host unreachable' })],
  ['non-ok result', async () => ({ ok: false, error: 'remote stop refused' })],
  ['rejection', async () => { throw new Error('remote stop rejected'); }],
]) {
  test(`failed remote Stop after pending Detach still exits as Detached (${failure})`, async t => {
    const h = remoteSetup(t);
    const writes = [];
    h.entry.terminal.write = data => writes.push(data);
    await h.w.detachSession('A');
    assert.equal(h.entry.detachRequested, true, 'Detach is still awaiting its exit');
    h.w.api.remoteStopSession = stop;
    await h.stop();
    assert.equal(h.entry.closed, false, 'the pending Detach exit has not arrived');
    assert.equal(h.document.querySelector('[role="alert"] .app-notice-action')?.textContent, 'Retry');
    h.w.gridViewActive = false;
    h.w.activeSessionId = null;
    h.w.applyProcessExit('A', 0, null, true);
    assert.equal(h.w.lifecycleLabel({ exit: h.w.lastSessionExit('A') }), 'Detached');
    assert.match(writes.at(-1), /session detached .*it keeps running on Build server/);
  });
}

test('remote Stop after pending Detach reads Stopped when the host session is already gone', async t => {
  const h = remoteSetup(t);
  const writes = [];
  h.entry.terminal.write = data => writes.push(data);
  await h.w.detachSession('A');
  assert.equal(h.entry.detachRequested, true);
  h.w.api.remoteStopSession = async () => ({ ok: false, error: 'session not found on that host' });
  await h.stop();
  h.w.gridViewActive = false;
  h.w.activeSessionId = null;
  h.w.applyProcessExit('A', 0, null, true);
  assert.equal(h.w.lifecycleLabel({ exit: h.w.lastSessionExit('A') }), 'Stopped', 'an already absent host session completes Stop');
  assert.doesNotMatch(writes.at(-1), /keeps running on/);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});

for (const result of [{ ok: true, detached: true }, { ok: false, error: 'not running' }]) {
  test(`remote Stop after Detach before exit reads Stopped (${result.error || 'success'})`, async t => {
    const h = remoteSetup(t);
    const writes = [];
    h.entry.terminal.write = data => writes.push(data);
    h.w.api.stopSession = async id => { h.calls.push(['tab', id]); return result; };
    await h.w.detachSession('A');
    assert.equal(h.entry.detachRequested, true, 'Detach is still awaiting its exit');
    assert.equal(h.entry.closed, false);
    h.w.api.remoteStopSession = async (...args) => {
      h.calls.push(['remoteStop', ...args]);
      h.w.gridViewActive = false;
      h.w.activeSessionId = null;
      h.w.applyProcessExit('A', 0, null, true);
      return { ok: true };
    };
    await h.stop();
    assert.deepEqual(h.calls.filter(call => call[0] === 'remoteStop'), [['remoteStop', 'vps', 'A']]);
    assert.equal(h.w.lifecycleLabel({ exit: h.w.lastSessionExit('A') }), 'Stopped', 'Stop supersedes pending Detach');
    assert.doesNotMatch(writes.at(-1), /keeps running on/);
    assert.equal(h.calls.filter(call => call[0] === 'confirm').length, 1);
  });
}

test('mixed local and remote merged row detaches only remote and stops both parts', async t => {
  const h = setup(t, { attached: false, merged: ['B'] });
  const remote = { sessionId: 'B', remoteAlias: 'vps', remoteAttachable: true, projectPath: '/remote' };
  h.w.sessionMap.set('B', remote);
  h.w.openSessions.set('B', { session: remote, closed: false });
  h.w.activePtyIds.add('B');
  h.w.remoteHostLabel = () => 'Build server';
  h.w.api.remoteStopSession = async (...args) => { h.calls.push(['remoteStop', ...args]); return { ok: true }; };
  h.render();
  await h.document.querySelector('#si-A .session-detach-btn').onclick({ stopPropagation() {} });
  assert.deepEqual(h.calls, [['tab', 'B', undefined]], 'Detach only closes the remote attach client');
  assert.ok(h.w.activePtyIds.has('A'), 'local terminal remains open');
  h.calls.length = 0;
  await h.stop();
  assert.deepEqual(h.calls.map(call => call[0]), ['confirm', 'tab', 'remoteStop']);
  assert.deepEqual(h.calls[1], ['tab', 'A', undefined]);
  assert.deepEqual(h.calls[2], ['remoteStop', 'vps', 'B']);
  assert.match(h.calls[0][1].message, /Stop 2 parts/);
});

test('B1 remote row Detach is accessible only while attached, including merged members and refresh', t => {
  const h = remoteSetup(t, { merged: ['B'] });
  const row = h.document.querySelector('#si-A');
  assert.equal(row.classList.contains('has-detachable-tab'), true, 'remote attached row exposes Detach');
  const button = row.querySelector('.session-detach-btn');
  assert.equal(button.title, 'Detach (the session keeps running on Build server)');
  assert.equal(button.getAttribute('aria-label'), button.title);
  h.w.openSessions.set('B', { session: { ...h.session, sessionId: 'B' }, closed: false });
  h.w.activePtyIds.add('B');
  h.entry.closed = true;
  h.w.activePtyIds.delete('A');
  h.w.renderDefaultStatus = () => {};
  loadAppFunctions(h.context, { declarations: ['_lastPtySignature'], functions: ['updateRunningIndicators'] });
  h.w.updateRunningIndicators();
  assert.equal(row.classList.contains('has-detachable-tab'), true, 'merged member remains detachable');
  h.w.openSessions.get('B').closed = true;
  h.w.activePtyIds.delete('B');
  h.w.updateRunningIndicators();
  assert.equal(row.classList.contains('has-detachable-tab'), false);
  h.render();
  assert.equal(h.document.querySelector('#si-A').classList.contains('has-detachable-tab'), false);
});

test('B1 remote card and header expose host-labelled Detach and hide after closure', t => {
  const h = remoteSetup(t);
  h.evalPublic('shortcuts.js');
  h.evalPublic('grid-view.js');
  h.w.wrapInGridCard('A');
  const card = h.document.querySelector('.grid-card');
  const button = card.querySelector('.grid-card-detach-btn');
  assert.equal(button.style.display, '', 'remote card exposes Detach');
  assert.equal(button.title, 'Detach (the session keeps running on Build server)');
  assert.equal(button.getAttribute('aria-label'), button.title);
  const holder = h.document.createElement('div');
  holder.innerHTML = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const controls = holder.querySelector('#terminal-header-session');
  h.document.body.append(controls);
  Object.assign(h.w, { activeSessionId: 'A', terminalStopBtn: controls.querySelector('#terminal-stop-btn'),
    paintTerminalHeaderStatus() {}, updatePtyTitle() {}, backgroundActionReason: () => null });
  loadAppFunctions(h.context, { functions: ['initTerminalDetachControl', 'updateTerminalHeader'] });
  h.w.initTerminalDetachControl();
  h.w.updateTerminalHeader();
  const headerButton = controls.querySelector('#terminal-detach-btn');
  assert.equal(headerButton.style.display, '', 'remote header exposes Detach');
  assert.equal(headerButton.title, button.title);
  assert.equal(headerButton.getAttribute('aria-label'), button.title);
  const detached = [];
  h.w.detachSession = id => detached.push(id);
  card.rekeySessionId('B');
  button.click();
  headerButton.click();
  assert.deepEqual(detached, ['B', 'A']);
  h.entry.closed = true;
  h.w.updateGridCardActivity('A', card, h.session);
  h.w.updateTerminalHeader();
  assert.equal(button.style.display, 'none');
  assert.equal(headerButton.style.display, 'none');
});

test('B2 remote Detach calls only stopSession without confirmation and Undo follows the row head', async t => {
  const h = remoteSetup(t, { merged: ['B'] });
  Object.assign(h.session, { headSessionId: 'B', remoteAttachSessionId: 'B' });
  h.w.api.stopSession = async id => {
    h.calls.push(['tab', id]);
    h.entry.closed = true;
    return { ok: true, detached: true };
  };
  const opened = [];
  h.w.openSession = (...args) => { opened.push(args); return true; };
  h.render();
  await h.document.querySelector('#si-A .session-detach-btn').onclick({ stopPropagation() {} });
  assert.deepEqual(h.calls, [['tab', 'A']], 'remote Detach uses the local attach adapter only');
  assert.equal(h.entry.detachRequested, true);
  const undo = h.document.querySelector('.app-notice-action');
  assert.equal(undo?.textContent, 'Undo');
  assert.match(undo.parentElement.textContent, /keeps running on Build server/);
  undo.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].length, 1, 'remote Undo uses ordinary row opening without background attach options');
  assert.equal(opened[0][0].sessionId, 'B');
  assert.equal(opened[0][0].remoteAlias, 'vps');
});

test('B2 remote Detach without remoteAttachable gives information without Undo', async t => {
  const h = remoteSetup(t);
  h.session.remoteAttachable = false;
  await h.w.detachSession('A');
  assert.deepEqual(h.calls, [['tab', 'A', undefined]]);
  assert.equal(h.document.querySelector('.app-notice-action'), null);
  assert.match(h.document.querySelector('#app-notices').textContent, /keeps running on Build server/);
});

test('B3 remote detach exit reads Detached with its host, while remote Stop reads Stopped', async t => {
  const h = remoteSetup(t);
  const writes = [];
  h.entry.terminal.write = data => writes.push(data);
  h.w.gridViewActive = false;
  h.w.activeSessionId = null;
  h.entry.detachRequested = true;
  h.w.applyProcessExit('A', 0, null, true);
  assert.equal(h.w.lastSessionExit('A').detached, true, 'requested remote detach is recorded');
  assert.equal(h.w.lifecycleLabel({ exit: h.w.lastSessionExit('A') }), 'Detached');
  assert.match(writes.at(-1), /session detached .*it keeps running on Build server/);
  h.entry.closed = false;
  delete h.entry.detachRequested;
  h.w.activePtyIds.add('A');
  await h.stop();
  h.w.applyProcessExit('A', 0, null, true);
  assert.equal(h.w.lastSessionExit('A').detached, false);
  assert.equal(h.w.lifecycleLabel({ exit: h.w.lastSessionExit('A') }), 'Stopped');
  assert.match(writes.at(-1), /session stopped/);
  assert.doesNotMatch(writes.at(-1), /keeps running/);
});

test('B4 remote row Stop confirms once and stops on the host without detaching locally', async t => {
  const h = remoteSetup(t);
  await h.stop();
  assert.deepEqual(h.calls.map(call => call[0]), ['confirm', 'remoteStop']);
  const question = h.calls[0][1];
  assert.equal(question.title, 'Stop session?');
  assert.equal(question.confirmLabel, 'Stop');
  assert.equal(question.danger, true);
  assert.match(question.message, /on Build server/);
  assert.deepEqual(h.calls[1], ['remoteStop', 'vps', 'A']);
  assert.equal(h.entry.detachRequested, undefined);
});

test('B3 a failed remote Detach followed by Stop still exits as Stopped', async t => {
  const h = remoteSetup(t);
  h.w.api.stopSession = async () => ({ ok: false, error: 'detach transport failed' });
  await h.w.detachSession('A');
  assert.equal(h.entry.detachRequested, undefined, 'failed Detach does not mark a later Stop as detached');
  assert.ok(h.w.activePtyIds.has('A'));
  assert.equal(h.document.querySelector('[role="alert"] .app-notice-action')?.textContent, 'Retry');
  await h.stop();
  h.w.gridViewActive = false;
  h.w.activeSessionId = null;
  h.w.applyProcessExit('A', 0, null, true);
  assert.equal(h.w.lifecycleLabel({ exit: h.w.lastSessionExit('A') }), 'Stopped');
});
