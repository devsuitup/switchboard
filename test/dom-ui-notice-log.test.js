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

for (const label of ['Restore', 'Restart']) test(`action ${label} reaches the sink as the dismissal reason`, t => {
  const { window, document } = setup(t);
  const lines = connectSink(t, window);
  let calls = 0;
  window.showAppNotice({ id: 'action-test', message: 'Ready', actionLabel: label, onAction: () => { calls++; } });
  document.querySelector('.app-notice-action').click();
  assert.equal(calls, 1);
  assert.equal(lines.at(-1).event, 'dismiss');
  assert.equal(lines.at(-1).reason, `action:${label}`);
});

for (const [label, selector] of [['Restore', 'restore-toast-restore'], ['Restart', 'update-restart-btn'], ['Later', 'update-dismiss-btn']]) {
  test(`transient ${label} click records its action label through the sink`, async t => {
    const { window, document } = setup(t);
    const lines = connectSink(t, window);
    const toast = document.createElement('div');
    toast.innerHTML = `<span class="restore-toast-msg">Ready</span><button class="${selector}" id="${selector}"><span>${label}</span></button>`;
    document.body.append(toast);
    window.trackUiNotice(toast, 'restore');
    toast.querySelector('button').addEventListener('click', () => toast.remove());
    toast.querySelector('button span').click();
    await Promise.resolve();
    assert.equal(lines.at(-1).event, 'dismiss');
    assert.equal(lines.at(-1).reason, label === 'Later' ? 'user' : `action:${label}`);
  });
}

test('Restart is logged before install without waiting for a DOM removal, and only once', async t => {
  const { window, document } = setup(t);
  const lines = connectSink(t, window);
  const toast = document.createElement('div');
  toast.innerHTML = '<span id="update-toast-msg">Update ready</span><button id="update-restart-btn">Restart</button>';
  document.body.append(toast);
  window.trackUiNotice(toast, 'updater');
  let installReason;
  toast.querySelector('button').onclick = () => { installReason = lines.at(-1).reason; };
  toast.querySelector('button').click();
  assert.equal(installReason, 'action:Restart', 'action must reach the sink before the install request');
  toast.remove();
  await Promise.resolve();
  assert.equal(lines.filter(line => line.event === 'dismiss').length, 1);
});

test('Restart without hiding the toast then Dismiss logs both through the real sink', async t => {
  const { window, document } = setup(t);
  const lines = connectSink(t, window);
  const toast = document.createElement('div');
  toast.innerHTML = '<span id="update-toast-msg">Update ready</span><button id="update-restart-btn">Restart</button><button id="update-dismiss-btn">Dismiss</button>';
  document.body.append(toast);
  window.trackUiNotice(toast, 'updater');
  toast.querySelector('#update-restart-btn').click();
  await Promise.resolve();
  assert.ok(toast.isConnected);
  assert.equal(lines.at(-1).event, 'action', 'Restart is an action, not a dismissal');
  assert.equal(lines.at(-1).reason, 'action:Restart');
  toast.querySelector('#update-dismiss-btn').onclick = () => { toast.hidden = true; };
  toast.querySelector('#update-dismiss-btn').click();
  await Promise.resolve();
  assert.deepEqual(lines.map(line => [line.event, line.reason]), [['show', ''], ['action', 'action:Restart'], ['dismiss', 'user']]);
});

test('project action failure keeps folder wording in the real log', t => {
  const { window } = setup(t);
  const lines = connectSink(t, window);
  window.showSessionActionFailure('Archive', { projectPath: '/repo' }, 'disk unavailable');
  assert.match(lines[0].text, /Archive failed for folder at \/repo/);
  assert.doesNotMatch(lines[0].text, /00000000/);
});

for (const failure of [false, 'restore', 'undo']) test(`archived session ${failure || 'restore'} marks labels through the real sink`, async t => {
  const { window, document, context } = setup(t);
  const lines = connectSink(t, window);
  const session = { sessionId: 'abcdef12-2345-6789', name: 'PRIVATE ARCHIVE LABEL', archived: 1 };
  window.loadProjects = async () => {};
  window.persistSessionArchive = async (row, value, _refresh, onError) => {
    if (failure === 'restore' || (failure === 'undo' && value === 1)) { onError(new Error('disk unavailable')); return false; }
    row.archived = value;
    return true;
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/archived-manager.js'), 'utf8'), context,
    { filename: 'public/archived-manager.js' });
  const container = document.createElement('div'); document.body.append(container);
  window.renderArchivedProjects(container, { entries: [], projects: [{ projectPath: '/repo', sessions: [session] }] });
  container.querySelector('.archived-unarchive').click();
  await new Promise(resolve => setImmediate(resolve));
  if (failure === 'undo') {
    document.querySelector('.app-notice-action').click();
    await new Promise(resolve => setImmediate(resolve));
  }
  const visible = document.querySelector(failure ? '.choice-dialog-body' : '.app-notice-message');
  assert.ok(visible.textContent.includes(session.name));
  if (failure) document.querySelector('.choice-dialog-confirm').click();
  else document.querySelector('.app-notice-dismiss').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(lines.length >= 2);
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE ARCHIVE LABEL/);
  assert.ok(lines.every(line => typeof line.text === 'string' && line.text.includes('abcdef12')));
});

for (const scenario of ['plain', 'mixed', 'unknown', 'moving-only', 'untitled']) test(`session exit ${scenario} retains text and maps marked row offsets`, async t => {
  const { window, document, context } = setup(t);
  const lines = connectSink(t, window);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/file-panel.js'), 'utf8'), context, { filename: 'public/file-panel.js' });
  const owner = { sessionId: 'abcdef12-2345-6789', name: 'PRIVATE EXIT LABEL' };
  window.openSessions.set(owner.sessionId, { session: owner });
  window.backgroundActionReason = () => '';
  const moving = { id: owner.sessionId, type: 'session', cwd: '/repo/alpha', background: 'busy' };
  const plain = { id: '12345678-terminal', type: 'plain', cwd: '/repo/beta' };
  const panel = { id: '87654321-panel', owner: owner.sessionId, type: 'panel' };
  const untitled = { id: 'fedcba98-2345-6789', type: 'session', cwd: '/repo/gamma' };
  const rows = scenario === 'plain' ? [plain] : scenario === 'untitled' ? [untitled]
    : scenario === 'moving-only' ? [moving] : [plain, panel, moving, untitled];
  const pending = window.confirmSessionExit({ action: 'close', snapshot: { rows, unknown: scenario === 'unknown',
    counts: { sessions: rows.filter(row => row.type === 'session').length, plain: rows.includes(plain) ? 1 : 0, panels: rows.includes(panel) ? 1 : 0 }, remote: {} } });
  const paragraphs = [...document.querySelectorAll('.choice-dialog-body p')];
  const rowText = row => row === plain ? 'Plain terminal · beta · 12345678'
    : row === panel ? 'Panel shell of "PRIVATE EXIT LABEL" · 87654321'
    : row === untitled ? 'Untitled conversation · gamma · fedcba98'
    : '"PRIVATE EXIT LABEL" · alpha · abcdef12' + (scenario === 'unknown' ? '' : ' · waits for its turn to end (up to 10 minutes)');
  const expectedRows = scenario === 'unknown'
    ? ['Switchboard could not list the local work that will stop.', ...rows.map(rowText)]
    : rows.includes(moving) ? ['Move to background: 1 session', rowText(moving),
      ...(rows.length > 1 ? ['Stops after moving: 1 session, 1 plain terminal and 1 panel shell', ...rows.filter(row => row !== moving).map(rowText)] : [])] : rows.map(rowText);
  const total = scenario === 'plain' ? '1 plain terminal' : ['untitled', 'moving-only'].includes(scenario) ? '1 session' : '2 sessions, 1 plain terminal and 1 panel shell';
  expectedRows.push(scenario === 'plain' ? 'Stop and close ends 1 plain terminal and anything running in it.'
    : 'Stop and close ends ' + total + ', idle or working, and anything running in ' + (rows.length === 1 ? 'it' : 'them') + '. Conversations are kept and can be resumed.');
  if (rows.includes(moving) && scenario !== 'unknown') expectedRows.push("Moved sessions keep running in the background. They can reopen at the next start according to your startup restore setting, unless it is set to Don't restore.");
  assert.deepEqual(paragraphs.map(p => p.textContent), expectedRows, 'row offsets preserve every exact paragraph');
  assert.equal(document.querySelector('h2').textContent, 'Stop ' + total + ' and close Switchboard?');
  if (rows.includes(moving)) {
    assert.ok(paragraphs.find(p => p.textContent.startsWith('"PRIVATE EXIT LABEL"')).querySelector('[data-log-session="abcdef12"]'));
    if (rows.includes(panel)) assert.ok(paragraphs.find(p => p.textContent.startsWith('Panel shell')).querySelector('[data-log-session="abcdef12"]'));
  }
  document.querySelector('.choice-dialog-cancel').click();
  await pending;
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.title, 'Stop ' + total + ' and close Switchboard?');
    const moveLabel = scenario === 'moving-only' ? 'Move to background and close' : scenario === 'mixed' ? 'Move to background, stop the rest and close' : null;
    assert.equal(line.text, ['Stop ' + total + ' and close Switchboard?', '×', '',
      ...expectedRows.map(text => text.replaceAll('PRIVATE EXIT LABEL', 'abcdef12')), '', 'Cancel',
      ...(moveLabel ? [moveLabel] : []), 'Stop and close', '', ''].join('\n'));
    if (rows.includes(plain)) assert.match(line.text, /Plain terminal · beta · 12345678/);
    if (rows.includes(untitled)) assert.match(line.text, /Untitled conversation · gamma · fedcba98/);
    if (rows.includes(panel)) assert.match(line.text, /Panel shell of "abcdef12" · 87654321/);
    if (rows.includes(moving)) assert.match(line.text, /"abcdef12" · alpha · abcdef12/);
    if (rows.includes(moving) && scenario !== 'unknown') assert.match(line.text, /Move to background: 1 session\n"abcdef12" · alpha · abcdef12/);
    if (scenario === 'unknown') assert.match(line.text, /could not list the local work/);
  }
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE EXIT LABEL/);
});

test('multipart stop and archive confirmations keep their id-only text', async t => {
  const { window, document, context } = setup(t);
  const lines = connectSink(t, window);
  const session = { sessionId: 'abcdef12-2345-6789', name: 'PRIVATE PART LABEL',
    mergedMemberIds: ['abcdef12-2345-6789', 'bcdef123-2345-6789'], projectPath: '/repo' };
  window.sessionMap.set(session.sessionId, session);
  window.activePtyIds.add(session.sessionId);
  loadAppFunctions(context, { functions: ['confirmAndStopSession'] });
  const pending = window.confirmAndStopSession(session);
  await new Promise(resolve => setImmediate(resolve));
  document.querySelector('.choice-dialog-cancel').click(); await pending;
  const archive = window.archiveSessionRows([session]);
  await new Promise(resolve => setImmediate(resolve));
  document.querySelector('.choice-dialog-cancel').click(); await archive;
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert.equal(typeof line.text, 'string', 'multipart plan keeps its id-only text');
    assert.match(line.text, /Part abcdef12/);
  }
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE PART LABEL/);
});

test('folder archive logs only its five rendered running labels and handles unchecking', async t => {
  const { window, document } = setup(t);
  const lines = connectSink(t, window);
  const sessions = Array.from({ length: 7 }, (_, i) => ({ sessionId: `${i + 1}bcdef12-2345-6789`, name: `PRIVATE FOLDER ${i}`, projectPath: '/repo', archived: 0 }));
  const project = { projectPath: '/repo', sessions };
  window.cachedAllProjects = [project];
  sessions.slice(0, 6).forEach(row => window.activePtyIds.add(row.sessionId));
  window.api.getProjectArchivePlan = async () => ({ schedules: [] });
  const pending = window.archiveProjectFolder(project);
  await new Promise(resolve => setImmediate(resolve));
  const checkbox = document.querySelector('input[data-choice-id="archiveSessions"]');
  assert.ok(checkbox);
  assert.equal(typeof lines[0].text, 'string', 'folder archive keeps its checked text');
  assert.match(lines[0].text, /1bcdef12/);
  assert.match(lines[0].text, /\+1 more/);
  checkbox.click();
  document.querySelector('.choice-dialog-cancel').click(); await pending;
  assert.equal(typeof lines.at(-1).text, 'string', 'unchecked archive keeps its text');
  assert.match(lines.at(-1).text, /Archive the 7 sessions/);
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE FOLDER/);
});

test('stop folder excludes idle labels from the marking contract', async t => {
  const { window, document } = setup(t);
  const lines = connectSink(t, window);
  const sessions = ['abcdef12-2345-6789', 'bcdef123-2345-6789'].map(sessionId => ({ sessionId, name: 'PRIVATE STOP FOLDER', projectPath: '/repo' }));
  const project = { projectPath: '/repo', sessions };
  window.cachedAllProjects = [project];
  window.activePtyIds.add(sessions[0].sessionId);
  const pending = window.confirmAndStopProjectFolder(project);
  await new Promise(resolve => setImmediate(resolve));
  document.querySelector('.choice-dialog-cancel').click(); await pending;
  assert.equal(typeof lines[0].text, 'string', 'stop folder keeps its text with idle rows');
  assert.match(lines[0].text, /abcdef12/);
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE STOP FOLDER/);
});

test('resume settings title marks its session label', async t => {
  const { window, document, context } = setup(t);
  for (const file of ['setting-defaults.js', 'dialogs.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), context, { filename: 'public/' + file });
  }
  await window.showResumeSessionDialog({ sessionId: 'abcdef12-2345-6789', name: 'PRIVATE RESUME LABEL', projectPath: '/repo' });
  assert.equal(document.querySelector('h3 [data-log-session="abcdef12"]')?.textContent, 'PRIVATE RESUME LABEL');
  document.querySelector('.new-session-cancel-btn').click();
});

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

for (const action of ['quit', 'close', 'update']) test('1023 exit progress gives a short outcome and next step for ' + action, t => {
  const { window, document, context } = setup(t);
  const lines = connectSink(t, window);
  window.api.platform = 'win32';
  loadAppFunctions(context, { functions: ['showExitBackgroundProgress', 'exitBackgroundFailure'] });
  window.showExitBackgroundProgress({ detail: { action }, entries: new Map([
    ['abcdef12-session', { id: 'abcdef12-session', name: 'PRIVATE PROGRESS LABEL', phase: 'waiting' }],
    ['fedcba98-session', { id: 'fedcba98-session', name: 'PRIVATE CONFIRM LABEL', phase: 'confirming' }],
    ['12345678-session', { id: '12345678-session', name: 'PRIVATE FAILED LABEL', result: { ok: false, error: 'RAW_EXIT_ERROR /repo/failure' } }],
  ]) });
  const notice = document.querySelector('[data-notice-id="exit-background"]');
  assert.equal(notice.querySelector('.app-notice-title').textContent, 'Moving sessions to the background.');
  const verb = action === 'quit' ? 'exit' : action;
  assert.equal(notice.querySelector('.app-notice-body').textContent,
    'Switchboard is preparing to ' + verb + '. Check the sessions below. 0 of 3 confirmed.\nPRIVATE PROGRESS LABEL waits for its turn to end\nPRIVATE CONFIRM LABEL asks you to confirm in its terminal\nPRIVATE FAILED LABEL: RAW_EXIT_ERROR /repo/failure');
  assert.equal(notice.querySelector('.app-notice-action').textContent, 'Cancel');
  assert.equal(notice.dataset.kind, 'info');
  assert.equal(lines.at(-1).text,
    'Moving sessions to the background.\nSwitchboard is preparing to ' + verb + '. Check the sessions below. 0 of 3 confirmed.\nabcdef12 waits for its turn to end\nfedcba98 asks you to confirm in its terminal\n12345678: RAW_EXIT_ERROR /repo/failure');
});

for (const [platform, action, verb] of [['win32', 'quit', 'Exit'], ['linux', 'quit', 'Quit'], ['darwin', 'close', 'Close'], ['linux', 'update', 'Update']])
  for (const scenario of ['failed', 'save-error', 'all-moved', 'all-moved-attached']) test('1023 exit recovery keeps names visible and identifiers in the log: ' + scenario + ' ' + verb, async t => {
  const { window, document, context } = setup(t);
  const lines = connectSink(t, window);
  window.releaseExitState = () => {};
  window.api.platform = platform;
  const attaches = [];
  window.attachBackgroundContinuation = async (...args) => { attaches.push(args); };
  loadAppFunctions(context, { functions: ['recoverExitBackground', 'exitBackgroundFailure'], declarations: ['exitHandoffs', 'exitBackgroundAttempts'] });
  const row = { id: 'abcdef12-session', name: 'PRIVATE RECOVERY LABEL', entry: {},
    result: scenario === 'failed' ? { ok: false, error: 'RAW_EXIT_ERROR /repo/failure' } : { ok: true, sessionId: 'fedcba98-session' } };
  if (scenario === 'all-moved-attached') window.openSessions.set(row.result.sessionId, row.entry);
  const batch = { detail: { attempt: 7, action }, entries: new Map([[row.id, row]]) };
  if (scenario === 'save-error') batch.saveError = 'RAW_SAVE_ERROR /repo/save';
  await window.recoverExitBackground(batch);
  assert.equal(attaches.length, scenario === 'all-moved-attached' ? 1 : 0);
  const notice = document.querySelector('[data-notice-id="exit-background-failure"]');
  assert.equal(notice.querySelector('.app-notice-title').textContent, 'Switchboard stayed open.');
  const instruction = scenario === 'failed'
    ? 'Check Details for each session, then try again or stop it. 1 of 1 sessions could not move to the background.'
    : scenario === 'save-error'
      ? 'Check the save error in Details before trying again. Moved sessions keep running in the background.'
      : verb + ' again when you are ready. 1 of 1 sessions moved to the background and keep running there.';
  assert.equal(notice.querySelector('.app-notice-body').textContent, instruction + '\nSessions: PRIVATE RECOVERY LABEL');
  assert.equal(notice.querySelector('details').open, false);
  const detail = scenario === 'failed' ? 'PRIVATE RECOVERY LABEL: RAW_EXIT_ERROR /repo/failure'
    : scenario === 'save-error' ? 'RAW_SAVE_ERROR /repo/save' : 'Moved: PRIVATE RECOVERY LABEL';
  assert.equal(notice.querySelector('.app-notice-details').textContent, 'Details' + detail);
  assert.equal(notice.dataset.kind, 'error');
  assert.equal(lines.at(-1).text, 'Switchboard stayed open.\n' + instruction + '\nSessions: abcdef12\n' + detail.replaceAll('PRIVATE RECOVERY LABEL', 'abcdef12'));
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE RECOVERY LABEL/);
});
