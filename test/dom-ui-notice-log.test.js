'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');
const { EventEmitter } = require('node:events');
const { installUiNoticeLog } = require('../src/main/app/ui-notice-log');

function connectSink(t, window) {
  const ipcMain = new EventEmitter();
  const lines = [];
  const webContents = { mainFrame: {}, isDestroyed: () => false };
  const sink = installUiNoticeLog({ ipcMain, log: { info: line => lines.push(JSON.parse(line.slice('[ui-notice] '.length))) },
    getWindow: () => ({ webContents, isDestroyed: () => false }), setTimer: () => 1, clearTimer() {} });
  window.api.logUiNotice = value => ipcMain.emit('ui-notice-log', { sender: webContents, senderFrame: webContents.mainFrame }, value);
  t.after(() => sink.dispose());
  return lines;
}

for (const [summary, projectPath] of [
  ['/review', '/review/SKILL.md'], ['https://private.example/payroll', '/repo'],
  ['C:/Secret Project', 'C:/Secret Project/file.txt'], ['Delete', '/repo/Delete'],
  ['private payroll]/Cancel', '/repo'], ['please fix\nprivate payroll', '/repo'],
  ['fix src/main.js', '/repo/fix src/main.js'], ['a', '/repo/a'],
]) {
  test(`explicit delete-session label: ${JSON.stringify(summary)}`, async t => {
    const { window, document } = setup(t);
    const lines = connectSink(t, window);
    const pending = window.showDeleteSessionDialog({ sessionId: 'abcdef12-2345-6789', summary, projectPath });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(document.querySelector('h3').textContent.startsWith('Delete session "'));
    const marker = document.querySelector('h3 [data-log-session="abcdef12"]');
    assert.ok(marker, 'the visible session label has an explicit identity marker');
    document.querySelector('#dss-cancel').click();
    await pending;
    assert.equal(lines.length, 2);
    for (const event of lines) {
      assert.equal(event.title, 'Delete session "abcdef12"?');
      assert.equal(event.id, 'delete-session:Delete session "abcdef12"?');
      assert.ok(event.text.includes(`Project: ${projectPath}`), event.text);
    }
  });
}

test('unmarked session dialogs omit unsafe fields at the real sink', async t => {
  const { window, document } = setup(t);
  const lines = connectSink(t, window);
  const pending = window.appConfirm({ title: '/review', message: 'private payroll]/Cancel',
    confirmLabel: 'private payroll]/Cancel', sessions: [{ sessionId: 'abcdef12-2345-6789', summary: '/review' }] });
  document.querySelector('.choice-dialog-confirm').click();
  await pending;
  assert.equal(lines.length, 2);
  for (const event of lines) {
    assert.equal(event.unmarked, true);
    assert.deepEqual(event.sessions, ['abcdef12']);
    assert.equal(Object.hasOwn(event, 'title'), false);
    assert.equal(Object.hasOwn(event, 'text'), false);
    assert.doesNotMatch(JSON.stringify(event), /private payroll|\/review/);
  }
});

test('explicit notice logText and logId preserve visible labels and real paths', async t => {
  const { window, document, context } = setup(t);
  const lines = connectSink(t, window);
  const session = { sessionId: 'abcdef12-2345-6789', summary: '/review' };
  window.LIVE_ELSEWHERE_NOTICE_MS = 60000;
  loadAppFunctions(context, { functions: ['showRestoreNotice'] });
  window.showRestoreNotice('restore:/review', '/review at C:/Secret Project/file.txt', session,
    { logId: 'restore:abcdef12', logText: 'abcdef12 at C:/Secret Project/file.txt' });
  assert.equal(document.querySelector('.restore-toast-msg').textContent, '/review at C:/Secret Project/file.txt');
  document.querySelector('.restore-toast-dismiss').click();
  await Promise.resolve();
  window.showAppNotice({ id: 'restore:/review', sessions: [session], message: '/review at /review/SKILL.md',
    logId: 'restore:abcdef12', logText: 'abcdef12 at /review/SKILL.md' });
  document.querySelector('.app-notice-dismiss').click();
  assert.equal(lines.length, 4);
  for (const event of lines) {
    assert.equal(event.id, 'restore:abcdef12');
    assert.ok(event.text.startsWith('abcdef12 at '), event.text);
  }
  assert.equal(lines[0].text, 'abcdef12 at C:/Secret Project/file.txt');
  assert.equal(lines[2].text, 'abcdef12 at /review/SKILL.md');
});

test('marked question paragraphs and selected radio labels log ids and retain block separators', async t => {
  const { window, document } = setup(t);
  const lines = connectSink(t, window);
  const session = { sessionId: 'abcdef12-2345-6789', summary: 'private payroll]/Cancel' };
  const pending = window.appChoose({ title: 'Open?', sessions: [session], message: `Open ${session.summary}?`,
    messageParts: [['Open ', { session, label: session.summary }, '?'], ['Path: C:/Secret Project/file.txt']],
    options: [{ id: 'a', label: session.summary, session }] });
  document.querySelector('.choice-dialog-confirm').click();
  await pending;
  assert.equal(lines[0].text.includes('Open abcdef12?\nPath:'), true);
  assert.ok(lines[0].choices.includes('abcdef12'));
  assert.equal(lines[1].choice, 'abcdef12');
  assert.doesNotMatch(JSON.stringify(lines), /private payroll/);
});

test('resume guard and continuation choices mark actual caller labels', async t => {
  const { window, document, context } = setup(t);
  const lines = connectSink(t, window);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/resume-guard.js'), 'utf8'), context,
    { filename: 'public/resume-guard.js' });
  const session = { sessionId: 'abcdef12-2345-6789', summary: '/review' };
  const pending = window.guardResume(session, { name: session.summary, live: { kind: 'interactive', cwd: 'C:/Secret Project/file.txt' },
    confirm: window.appConfirm });
  document.querySelector('.choice-dialog-confirm').click();
  assert.equal(await pending, true);
  assert.match(lines[0].text, /"abcdef12" is already running/);
  assert.ok(lines[0].text.includes('C:/Secret Project/file.txt'));
  const other = { sessionId: 'bcdef123-2345-6789', title: 'https://private.example/payroll' };
  const choice = window.resolveResumeSession(session, { choose: window.appChoose,
    api: { getSessionContinuations: async () => ({ candidates: [other] }), getSessionsLiveElsewhere: async () => ({}) } });
  await new Promise(resolve => setImmediate(resolve));
  document.querySelector('[data-choice-id="bcdef123-2345-6789"]').click();
  document.querySelector('.choice-dialog-confirm').click();
  assert.equal((await choice).sessionId, other.sessionId);
  assert.equal(lines.at(-1).choice, 'bcdef123');
  assert.doesNotMatch(JSON.stringify(lines), /\/review|private\.example/);
});

test('stop plans, archive checkbox labels and background progress use explicit identities', async t => {
  const { window, document, context } = setup(t);
  const lines = connectSink(t, window);
  const session = { sessionId: 'abcdef12-2345-6789', name: '/review' };
  const plan = window.describeSessionStopPlan(session, [{ sessionId: session.sessionId, where: 'at C:/Secret Project/file.txt' }], []);
  const stop = window.appConfirm({ title: 'Stop?', message: plan.confirmText, messageParts: plan.confirmParts, sessions: [session] });
  document.querySelector('.choice-dialog-cancel').click();
  await stop;
  assert.match(lines[0].text, /This session "abcdef12" at C:\/Secret Project\/file.txt/);
  const archive = window.showChoiceDialog({ title: 'Archive?', sessions: [session], choices: [{ id: 'archive', checked: true,
    label: checked => checked ? 'Stop /review' : 'Keep /review',
    labelParts: checked => [checked ? 'Stop ' : 'Keep ', { session, label: session.name }] }] });
  document.querySelector('input[type=checkbox]').click();
  document.querySelector('.choice-dialog-confirm').click();
  await archive;
  assert.equal(lines.at(-1).choice, 'OK; Keep abcdef12=false');
  loadAppFunctions(context, { functions: ['showExitBackgroundProgress', 'exitBackgroundFailure'] });
  window.showExitBackgroundProgress({ detail: { action: 'close' }, entries: new Map([[session.sessionId,
    { id: session.sessionId, name: session.name, phase: 'waiting' }]]) });
  assert.match(lines.at(-1).text, /abcdef12 waits for its turn to end/);
  assert.doesNotMatch(JSON.stringify(lines), /\/review/);
});

test('restore groups merge safe text and unmarked notices fail closed', t => {
  const { window, document, context } = setup(t);
  const lines = connectSink(t, window);
  loadAppFunctions(context, { functions: ['showLiveElsewhereNotice'] });
  window.showLiveElsewhereNotice([{ session: { sessionId: 'abcdef12-2345-6789', name: '/review' }, live: { pid: 1, cwd: 'C:/Secret Project/file.txt' } }]);
  window.showLiveElsewhereNotice([{ session: { sessionId: 'bcdef123-2345-6789', name: 'https://private.example/payroll' }, live: { pid: 2 } }]);
  assert.equal(lines.at(-1).event, 'merge');
  assert.match(lines.at(-1).text, /abcdef12/);
  assert.match(lines.at(-1).text, /bcdef123/);
  assert.ok(lines.at(-1).text.includes('C:/Secret Project/file.txt'));
  assert.doesNotMatch(JSON.stringify(lines), /\/review|private\.example/);
  window.showAppNotice({ id: '/review', message: '/review', sessions: [{ sessionId: 'abcdef12-2345-6789' }] });
  assert.equal(lines.at(-1).unmarked, true);
  assert.equal(Object.hasOwn(lines.at(-1), 'text'), false);
  assert.ok(document.querySelector('[data-notice-id="/review"]'));
  assert.doesNotMatch(JSON.stringify(lines.at(-1)), /\/review/);
});

test('a partially marked session list still fails closed', async t => {
  const { window, document } = setup(t);
  const lines = connectSink(t, window);
  const session = { sessionId: 'abcdef12-2345-6789', name: '/review' };
  const pending = window.appConfirm({ title: 'Open?', sessions: [session, { sessionId: 'bcdef123-2345-6789', name: 'private payroll' }],
    message: '/review and private payroll', messageParts: [[{ session, label: session.name }, ' and private payroll']] });
  document.querySelector('.choice-dialog-cancel').click();
  await pending;
  assert.equal(lines[0].unmarked, true);
  assert.doesNotMatch(JSON.stringify(lines), /\/review|private payroll/);
});

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
  window.showRestoreNotice('background-info:' + session.sessionId, `${session.summary} now runs in the background.`, session, { logText: 'abcdef01 now runs in the background.' });
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
  const pending = window.appConfirm({ title: 'Stop?', message: `Stop background job "${session.summary}"`, messageParts: [['Stop background job "', { session, label: session.summary }, '"']], sessions: [session] });
  assert.ok(document.querySelector('.choice-dialog-body').textContent.includes(session.summary));
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

test('explicit labels preserve prose, real paths and multiline content', async t => {
  const { window, document, events } = setup(t);
  const session = { sessionId: 'abcdef12-2345-6789', name: 'Delete' };
  const pending = window.appConfirm({ title: 'Stop?', sessions: [session],
    messageParts: [['Delete [', { session, label: 'Delete' }, ']/Cancel'],
      ['Path: C:/Secret Project/file.txt and /review/SKILL.md'],
      ['Multi: ', { session, label: 'fix src/main.js\n for payroll' }]] });
  assert.ok(document.querySelector('[data-log-session]'), 'explicit label marker is present');
  assert.equal(document.querySelector('[data-log-session]').textContent, 'Delete');
  document.querySelector('.choice-dialog-cancel').click();
  await pending;
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.ok(event.text.includes('Delete [abcdef12]/Cancel\nPath:'), event.text);
    assert.ok(event.text.includes('C:/Secret Project/file.txt and /review/SKILL.md'), event.text);
    assert.ok(event.text.includes('Multi: abcdef12'), event.text);
    assert.doesNotMatch(JSON.stringify(event), /payroll/);
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
