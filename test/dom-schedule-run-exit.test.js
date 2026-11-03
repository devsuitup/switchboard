'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { setupSidebarDom } = require('./dom-setup');

function setup(t) {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const ipcRenderer = new EventEmitter();
  const preload = path.join(__dirname, '../preload.js');
  vm.runInNewContext(fs.readFileSync(preload, 'utf8'), {
    process: { platform: process.platform, argv: [] },
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (_name, api) => { h.window.api = api; } }, ipcRenderer };
    },
  }, { filename: preload });
  const filename = path.join(__dirname, '../public/memory-workfiles-view.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), h.context, { filename });
  return { ...h, exit: payload => ipcRenderer.emit('schedule-run-exit', {}, payload) };
}

for (const [failure, code, hint] of [
  ['claude-path', 127, /claude not found on the shell PATH.*check.*PATH/i],
  ['claude-path', 1, /claude not found on the shell PATH.*check.*PATH/i],
  ['sandbox', 1, /check.*Linux.*bubblewrap.*sandbox.*log/i],
  ['exit', 42, /exited with code 42.*see the log/i],
]) {
  test(`schedule exit ${code} (${failure}) leaves a named persistent B8 error with recovery`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = setup(t);
    h.exit({ name: 'Nightly <health>', projectPath: '/p', sessionId: 'run-1', code, signal: null, failure });
    const alert = h.document.querySelector('[role="alert"]');
    assert.ok(alert, 'the exit event must produce a B8 error notice');
    assert.match(alert.textContent, /Nightly <health>/);
    assert.ok(alert.textContent.includes(String(code)), 'notice includes the actual exit code');
    assert.match(alert.textContent, hint);
    assert.equal(alert.querySelector('health'), null);
    t.mock.timers.tick(60_000);
    assert.ok(alert.isConnected, 'failure must remain until dismissed');
    alert.querySelector('button').click();
    assert.ok(!alert.isConnected);
  });
}

test('successful exit is silent at the renderer boundary', t => {
  const h = setup(t);
  h.exit({ name: 'Nightly', sessionId: 'ok', code: 0, failure: 'exit' });
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});

test('a fast failure survives the later successful launch acknowledgement', async t => {
  const h = setup(t);
  h.window.api.runScheduleNow = async () => {
    h.exit({ name: 'Nightly', sessionId: 'fast', code: 127, failure: 'claude-path' });
    return { ok: true, sessionId: 'fast' };
  };
  h.window.formatDate = () => 'today';
  h.window.ICONS = { schedule: () => '<svg></svg>' };
  const item = h.window.buildMemoryItem({ filename: 'schedule-nightly.md', filePath: '/p/schedule-nightly.md' });
  h.document.body.append(item);
  item.querySelector('.schedule-play-btn').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.querySelector('.schedule-play-btn').title, 'Launched!');
  assert.match(h.document.querySelector('[role="alert"]')?.textContent || '', /Nightly.*127.*PATH/);
});

test('manual runs retain separate failures and signal exits name their signal', t => {
  const h = setup(t);
  h.exit({ name: 'Nightly', projectPath: '/p', manual: true, sessionId: 'first', code: 1, failure: 'exit' });
  h.exit({ name: 'Nightly', projectPath: '/p', manual: true, sessionId: 'second', code: null, signal: 'SIGTERM', failure: 'exit' });
  const alerts = h.document.querySelectorAll('[role="alert"]');
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].dataset.noticeId, 'ScheduleRun:first');
  assert.equal(alerts[1].dataset.noticeId, 'ScheduleRun:second');
  assert.match(alerts[1].textContent, /SIGTERM.*log/i);
});

test('cron failures replace the schedule notice with a count and the latest failure', t => {
  const h = setup(t);
  for (const [sessionId, code, failure] of [['first', 127, 'claude-path'], ['second', 42, 'exit'], ['third', 1, 'exit']]) {
    h.exit({ name: 'Nightly', projectPath: '/p', manual: false, sessionId, code, failure });
  }
  const alerts = h.document.querySelectorAll('[role="alert"]');
  assert.equal(alerts.length, 1, 'repeated cron failures must replace the previous notice');
  assert.equal(alerts[0].dataset.noticeId, 'ScheduleRun:/p:Nightly');
  assert.match(alerts[0].textContent, /Schedule Nightly failed 3 times, last: exited with code 1.*log/i);
  assert.doesNotMatch(alerts[0].textContent, /PATH|127|42/);
});

test('cron notice keys distinguish projects and schedule names from manual runs', t => {
  const h = setup(t);
  const payload = { name: 'Nightly', projectPath: '/p', manual: false, code: 1, failure: 'exit' };
  h.exit({ ...payload, sessionId: 'first' });
  h.exit({ ...payload, sessionId: 'second' });
  h.exit({ ...payload, projectPath: '/other', sessionId: 'other-project' });
  h.exit({ ...payload, name: 'Weekly', sessionId: 'other-name' });
  h.exit({ ...payload, manual: true, sessionId: 'manual' });
  const alerts = [...h.document.querySelectorAll('[role="alert"]')];
  assert.equal(alerts.length, 4);
  assert.deepEqual(alerts.map(alert => alert.dataset.noticeId), [
    'ScheduleRun:/p:Nightly', 'ScheduleRun:/other:Nightly', 'ScheduleRun:/p:Weekly', 'ScheduleRun:manual',
  ]);
  assert.match(alerts[0].textContent, /failed 2 times/);
  for (const alert of alerts.slice(1)) assert.doesNotMatch(alert.textContent, /failed 2 times/);
});

test('manual run wording uses the plain schedule name and the manual flag', t => {
  const h = setup(t);
  h.exit({ name: 'nightly', projectPath: '/p', manual: true, sessionId: 'manual', code: 1, failure: 'exit' });
  const alert = h.document.querySelector('[role="alert"]');
  assert.match(alert.textContent, /^Manual run of schedule nightly exited with code 1/);
  assert.doesNotMatch(alert.textContent, /Schedule Manual run/);
});
