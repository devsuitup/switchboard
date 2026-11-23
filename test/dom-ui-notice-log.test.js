'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const events = [];
  ctx.window.api.logUiNotice = event => events.push(JSON.parse(JSON.stringify(event)));
  return { ...ctx, events };
}

test('notices report shown text, source, merge, replace and dismissal, including main error merges', t => {
  const { window, document, events } = setup(t);
  window.showAppNotice({ id: 'restore:jobs', kind: 'warning', members: [{ id: 'a', text: 'One' }], message: members => members.map(m => m.text).join('\n') });
  window.showAppNotice({ id: 'restore:jobs', kind: 'warning', mergeMembers: true, members: [{ id: 'b', text: 'Two' }], message: members => members.map(m => m.text).join('\n') });
  window.showAppNotice({ id: 'restore:jobs', kind: 'error', source: 'remote', message: 'Replacement' });
  document.querySelector('.app-notice-dismiss').click();
  assert.deepEqual(events.map(e => e.event), ['show', 'merge', 'show', 'replace', 'show', 'dismiss']);
  assert.equal(events[0].source, 'restore');
  assert.equal(events[2].text, 'One\nTwo');
  assert.equal(events[4].source, 'remote');
  window.api._mainProcessErrorCb({ id: 'a', count: 1, message: 'Failure' });
  window.api._mainProcessErrorCb({ id: 'a', count: 2, message: 'Failure' });
  assert.deepEqual(events.slice(-2).map(e => e.event), ['merge', 'show']);
  assert.match(events.at(-1).text, /2 occurrences/);
});

test('queued questions log when mounted and their real confirm, radio, secondary and cancel choices', async t => {
  const { window, document, events } = setup(t);
  const first = window.appConfirm({ title: 'Delete?', message: 'Remove file', confirmLabel: 'Delete' });
  const second = window.appChoose({ title: 'Choose part', options: [{ id: 'a', label: 'Part A' }, { id: 'b', label: 'Part B' }] });
  assert.equal(events.length, 1, 'only the mounted question is logged');
  assert.equal(events[0].title, 'Delete?');
  assert.ok(events[0].choices.includes('Delete'));
  document.querySelector('.choice-dialog-confirm').click();
  assert.equal(await first, true);
  assert.equal(events[1].choice, 'Delete');
  document.querySelector('[data-choice-id="b"]').click();
  document.querySelector('.choice-dialog-confirm').click();
  assert.equal((await second).choice, 'b');
  assert.equal(events.at(-1).choice, 'Part B');
  const alert = window.appAlert({ title: 'Error', message: 'Failure' });
  document.querySelector('.choice-dialog-close').click();
  await alert;
  assert.equal(events.at(-1).choice, 'cancel');
  const secondary = window.showChoiceDialog({ title: 'Exit', secondaryAction: { id: 'bg', label: 'Background' } });
  document.querySelector('.choice-dialog-secondary').click();
  assert.equal((await secondary).action, 'bg');
  assert.equal(events.at(-1).choice, 'Background');
});

test('checkbox dialogs record visible labels and selected checkbox answers without opaque plans', async t => {
  const { window, document, events } = setup(t);
  const pending = window.showChoiceDialog({ title: 'Archive?', choices: [{ id: 'stop', label: checked => checked ? 'Stop live sessions' : 'Keep live sessions', checked: false }] });
  document.querySelector('input[type=checkbox]').click();
  document.querySelector('.choice-dialog-confirm').click();
  await pending;
  assert.equal(events.at(-1)?.choice, 'OK; Stop live sessions=true');
});

test('session and worktree deletion questions report acceptance and cancellation', async t => {
  const { window, document, events } = setup(t);
  const pending = window.showDeleteSessionDialog({ sessionId: 's', name: 'Session', projectPath: '/project' });
  await new Promise(resolve => setImmediate(resolve));
  document.querySelector('#dss-confirm').click();
  await pending;
  assert.equal(events.at(-1)?.choice, 'Delete permanently');
  const worktree = window.showDeleteWorktreeDialog('branch', '/project/wt', { ok: true, dirty: [], fingerprint: 'f', total: 0 });
  document.querySelector('#dwt-cancel').click();
  assert.equal(await worktree, false);
  assert.equal(events.at(-1)?.choice, 'cancel');
});

test('restore toasts and updater status report show and dismiss through the shipped helpers', async t => {
  const { window, document, context, events } = setup(t);
  const updater = document.createElement('span');
  updater.id = 'status-bar-updater';
  document.body.append(updater);
  window.LIVE_ELSEWHERE_NOTICE_MS = 60000;
  loadAppFunctions(context, { functions: ['showRestoreNotice', 'setUpdaterStatus'], declarations: ['statusBarUpdater', 'updaterStatusTimer'] });
  window.showRestoreNotice('restore-legacy', 'Still running elsewhere');
  document.querySelector('.restore-toast-dismiss').click();
  await Promise.resolve();
  window.setUpdaterStatus('Update check failed');
  window.setUpdaterStatus('');
  assert.deepEqual(events.map(e => e.event), ['show', 'dismiss', 'show', 'dismiss']);
  assert.equal(events[0].text, 'Still running elsewhere');
  assert.equal(events[2].kind, 'error');
});

test('missing, throwing and rejected IPC APIs leave notices and questions usable', async t => {
  const { window, document } = setup(t);
  for (const api of [undefined, {}, { logUiNotice() { throw new Error('IPC unavailable'); } }, { logUiNotice: () => Promise.reject(new Error('IPC rejected')) }]) {
    window.api = api;
    assert.doesNotThrow(() => window.showAppNotice({ id: 'failure', kind: 'error', message: 'Visible' }));
    const pending = window.appConfirm({ title: 'Still usable' });
    document.querySelector('.choice-dialog-cancel').click();
    assert.equal(await pending, false);
    document.querySelector('.app-notice-dismiss').click();
    assert.equal(document.querySelector('.app-notice'), null);
  }
});

test('preload exposes a fire-and-forget UI notice bridge', () => {
  const source = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  assert.match(source, /logUiNotice:\s*.*ui-notice-log/, 'preload exposes ui-notice-log');
  const match = source.match(/logUiNotice:\s*(\w+\s*=>\s*\{[^}]+\})/);
  assert.ok(match);
  const sent = [];
  const fn = vm.runInNewContext(match[1], { ipcRenderer: { send: (...args) => sent.push(args) } }, { filename: 'preload.js:logUiNotice' });
  assert.equal(fn({ event: 'show' }), undefined);
  assert.equal(sent[0][0], 'ui-notice-log');
});
