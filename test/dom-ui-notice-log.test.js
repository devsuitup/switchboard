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
  assert.deepEqual(events.map(e => e.event), ['show', 'merge', 'replace', 'dismiss']);
  assert.equal(events[0].source, 'restore');
  assert.equal(events[1].text, 'One\nTwo');
  assert.equal(events[2].source, 'remote');
  assert.equal(events[3].reason, 'user');
  window.api._mainProcessErrorCb({ id: 'a', count: 1, message: 'Failure' });
  window.api._mainProcessErrorCb({ id: 'a', count: 2, message: 'Failure' });
  assert.equal(events.at(-1).event, 'merge');
  assert.deepEqual(events.at(-1).counts, [{ id: 'a', count: 2 }]);
  assert.equal(events.at(-1).text, '');
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
  window.setUpdaterStatus('Update check failed', undefined, { kind: 'error' });
  window.setUpdaterStatus('');
  assert.deepEqual(events.map(e => e.event), ['show', 'dismiss', 'show', 'dismiss']);
  assert.equal(events[0].text, 'Still running elsewhere');
  assert.equal(events[2].kind, 'error');
});

test('M4 delete-session logs short identity while keeping its prompt visible', async t => {
  const { window, document, events } = setup(t);
  const pending = window.showDeleteSessionDialog({ sessionId: 'abcdef01-2345-6789', summary: 'PRIVATE FIRST PROMPT', projectPath: '/project' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(document.querySelector('h3').textContent, /PRIVATE FIRST PROMPT/);
  document.querySelector('#dss-cancel').click();
  await pending;
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE FIRST PROMPT/);
  for (const event of events) {
    assert.match(event.title, /abcdef01/);
    assert.match(event.id, /abcdef01/);
    assert.match(event.text, /abcdef01/);
  }
});

test('M4 restore toast logs short identity while keeping its title visible', async t => {
  const { window, document, context, events } = setup(t);
  window.LIVE_ELSEWHERE_NOTICE_MS = 60000;
  loadAppFunctions(context, { functions: ['showRestoreNotice'] });
  const session = { sessionId: 'abcdef01-2345-6789', summary: 'PRIVATE FIRST PROMPT' };
  window.showRestoreNotice('background-info:' + session.sessionId, `${session.summary} now runs in the background.`, session);
  assert.match(document.querySelector('.restore-toast-msg').textContent, /PRIVATE FIRST PROMPT/);
  document.querySelector('.restore-toast-dismiss').click();
  await Promise.resolve();
  assert.equal(events.length, 2);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE FIRST PROMPT/);
  assert.match(events[0].text, /abcdef01 now runs/);
  assert.equal(events[1].reason, 'user');
});

test('R1 multiline unnamed session is redacted across question paragraphs', async t => {
  const { window, document, events } = setup(t);
  const session = { sessionId: 'abcdef12-2345-6789', summary: 'please fix the bug\n  in my secret-project payroll module' };
  const pending = window.appConfirm({ title: 'Stop?', message: `Stop background job "${session.summary}"`, sessions: [session] });
  assert.equal(document.querySelectorAll('.choice-dialog-body p').length, 2);
  document.querySelector('.choice-dialog-cancel').click();
  await pending;
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.match(event.text, /Stop background job "abcdef12"/);
    assert.doesNotMatch(event.text, /secret-project|payroll|please fix/);
  }
});

test('R1 delete-session redacts the cleaned multiline unnamed label and preserves its project', async t => {
  const { window, document, events } = setup(t);
  const session = { sessionId: 'abcdef12-2345-6789', summary: 'Implement the following plan:\n<command>please fix the bug\n  in my secret-project payroll module</command>', projectPath: '/repo/secret-project' };
  const pending = window.showDeleteSessionDialog(session);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('h3').textContent, 'Delete session "please fix the bug in my secret-project payroll module"?');
  document.querySelector('#dss-cancel').click();
  await pending;
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.title, 'Delete session "abcdef12"?');
    assert.match(event.text, /Project: \/repo\/secret-project/);
    assert.doesNotMatch(JSON.stringify(event), /payroll|please fix|<command>/);
  }
});

test('R2 one-letter names do not rewrite prose or path tokens', async t => {
  const { window, document, events } = setup(t);
  const message = 'Stop a session named "a" at /repo/a';
  const pending = window.appConfirm({ title: 'Stop?', message, sessions: [{ sessionId: 'abcdef12-2345-6789', name: 'a' }] });
  document.querySelector('.choice-dialog-cancel').click();
  await pending;
  assert.equal(events.length, 2);
  for (const event of events) assert.ok(event.text.includes(message), event.text);
});

test('R2 project label becomes the id without changing paths or larger words', async t => {
  const { window, document, events } = setup(t);
  const session = { sessionId: 'abcdef12-2345-6789', name: 'switchboard' };
  const message = 'Stop "switchboard" at C:\\Serveur\\switchboard\\file.txt or /repo/switchboard; switchboardish stays.';
  const pending = window.appConfirm({ title: 'Stop?', message, sessions: [session] });
  assert.equal(document.querySelector('.choice-dialog-body p').textContent, message);
  document.querySelector('.choice-dialog-cancel').click();
  await pending;
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.match(event.text, /Stop "abcdef12"/);
    assert.ok(event.text.includes('C:\\Serveur\\switchboard\\file.txt'), event.text);
    assert.ok(event.text.includes('/repo/switchboard; switchboardish stays.'), event.text);
  }
});

test('a first-prompt label that contains a path is replaced as a whole', async t => {
  const { window, document, events } = setup(t);
  const session = { sessionId: 'abcdef12-2345-6789', summary: 'fix src/main.js for the payroll export' };
  const message = 'Delete session "fix src/main.js for the payroll export"? Its files stay in /repo/src.';
  const pending = window.appConfirm({ title: 'Delete?', message, sessions: [session] });
  document.querySelector('.choice-dialog-cancel').click();
  await pending;
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.match(event.text, /Delete session "abcdef12"\?/);
    assert.ok(!event.text.includes('payroll'), event.text);
    assert.ok(event.text.includes('/repo/src.'), event.text);
  }
});

test('a single-token command or path label never rewrites a real path', async t => {
  const { window, document, events } = setup(t);
  const sessions = [{ sessionId: 'abcdef12-2345-6789', summary: '/review' },
    { sessionId: 'bcdef123-2345-6789', name: 'src/main.js' }];
  const message = 'Read /review/SKILL.md and open C:/repo/src/main.js now.';
  const pending = window.appConfirm({ title: 'Open?', message, sessions });
  document.querySelector('.choice-dialog-cancel').click();
  await pending;
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.ok(event.text.includes('/review/SKILL.md'), event.text);
    assert.ok(event.text.includes('C:/repo/src/main.js'), event.text);
  }
});

test('notice dismissals distinguish expiry and programmatic clearing', t => {
  const { window, events } = setup(t);
  let expire;
  window.setTimeout = callback => { expire = callback; return 1; };
  window.showAppNotice({ id: 'expires', message: 'Transient' });
  expire();
  assert.equal(events.at(-1).reason, 'expired');
  window.showAppNotice({ id: 'clear', message: 'Cleared' });
  window.clearAppNotice('clear');
  assert.equal(events.at(-1).reason, 'cleared');
});

test('updater progress logs only start and end, with caller-provided severity', async t => {
  const { window, document, context, events } = setup(t);
  const status = document.createElement('span');
  status.id = 'status-bar-updater';
  document.body.append(status);
  loadAppFunctions(context, { functions: ['setUpdaterStatus'], declarations: ['statusBarUpdater', 'updaterStatusTimer'] });
  window.setUpdaterStatus('Downloading v1…');
  for (let percent = 0; percent <= 100; percent++) {
    window.setUpdaterStatus(`Updating… ${percent}%`, undefined, { progress: true });
    await Promise.resolve();
  }
  window.setUpdaterStatus('Ready');
  await Promise.resolve();
  assert.deepEqual(events.map(event => event.text), ['Downloading v1…', 'Ready']);
  window.setUpdaterStatus('Localized failure', undefined, { kind: 'error' });
  assert.equal(events.at(-1).kind, 'error');
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
