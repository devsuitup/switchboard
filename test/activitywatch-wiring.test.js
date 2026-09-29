// Where main feeds the ActivityWatch reporter.
//
// Source-text assertions, the house pattern for main.js (see
// read-file-for-panel-bounds.test.js): they prove each hook is written where it
// must be, not that it runs. The reporter behind them is tested behaviourally
// in activitywatch-reporter.test.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Line endings normalised: a Windows checkout has CRLF, and the markers below are LF.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('main.js');
const TRANSITIONS = read('session-transitions.js');

function block(src, marker, endMarker = '\n});') {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `${marker} not found`);
  const end = src.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end of ${marker} not found`);
  return src.slice(start, end);
}

test('a spawned session is reported unless it is a shell or a panel shell', () => {
  assert.match(MAIN, /if \(!isPlainTerminal && !panelOwnerId\) activityReporter\.sessionStarted\(\{ sessionId, project: projectPath \}\);/);
});

test('a PTY exit ends the span under both ids, since a re-key may not have run yet', () => {
  const exit = block(MAIN, 'ptyProcess.onExit(', '\n  });');
  assert.match(exit, /activityReporter\.sessionEnded\(realId\);/);
  assert.match(exit, /activityReporter\.sessionEnded\(sessionId\);/);
});

test('a re-key reaches the reporter, beside the MCP server that follows it the same way', () => {
  assert.match(TRANSITIONS, /rekeyMcpServer\(sessionId, newId\);\s*\n\s*rekeyActivity\(sessionId, newId\);/);
  assert.match(MAIN, /rekeyActivity: \(fromId, toId\) => activityReporter\.rekey\(fromId, toId\)/);
});

test('a scheduled run is a running session, ended on exit and on a spawn error alike', () => {
  const run = block(MAIN, 'function runScheduleCommand(', '\n    }\n');
  assert.match(run, /activityReporter\.sessionStarted\(\{ sessionId: activityId, project: cwd, name: `Scheduled: \$\{name\}` \}\)/);
  assert.equal((run.match(/activityReporter\.sessionEnded\(activityId\)/g) || []).length, 2);
});

test('focus from the renderer is bounded before it is forwarded', () => {
  const focus = block(MAIN, "ipcMain.on('activity-focus'");
  assert.match(focus, /typeof focus\.sessionId !== 'string'/);
  assert.match(focus, /focus\.sessionId\.length > 200/);
  assert.match(focus, /focus\.name\.slice\(0, 200\)/);
  assert.match(focus, /focus\.project\.slice\(0, 1024\)/);
});

// Without the flag the second app.quit() would be held again, flushed again,
// and quit again, forever.
test('the quit is held at most once', () => {
  const quit = block(MAIN, "app.on('before-quit'");
  assert.match(quit, /if \(!activityFlushedForQuit && activityReporter\.hasPendingWork\) \{/);
  assert.ok(quit.indexOf('activityFlushedForQuit = true') < quit.indexOf('app.quit()'),
    'the flag is set before the quit is re-issued');
  assert.match(quit, /setTimeout\(resolve, 1500\)/, 'and the hold is bounded');
});

test('an update install is never held', () => {
  const install = block(MAIN, "ipcMain.handle('updater-install'");
  assert.ok(install.indexOf('activityFlushedForQuit = true') !== -1
    && install.indexOf('activityFlushedForQuit = true') < install.indexOf('quitAndInstall'));
});

test('idle time comes from the system, and cannot throw into the keepalive', () => {
  assert.match(MAIN, /idleSeconds: \(\) => \{ try \{ return powerMonitor\.getSystemIdleTime\(\); \} catch \{ return 0; \} \}/);
});

test('reporting starts from the stored setting, falling back to the one table of defaults', () => {
  assert.match(MAIN, /activityReporter\.setEnabled\(\s*\(getSetting\('global'\) \|\| \{\}\)\.activityReporting \?\? SETTING_DEFAULTS\.activityReporting\s*\)/);
});

// An install that fails does not quit. Left set, the flag would skip the flush
// on every later, ordinary quit.
test('a failed update install gives the next quit its flush back', () => {
  const onError = block(MAIN, "autoUpdater.on('error'", '\n  });');
  assert.match(onError, /activityFlushedForQuit = false;/);
});
