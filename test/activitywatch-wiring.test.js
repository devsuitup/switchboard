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
  assert.match(TRANSITIONS, /rekeyMcpServer\(sessionId, newId\);\s*\n\s*rekeyActivity\(sessionId, newId, kind\);/);
  assert.match(MAIN, /rekeyActivity: \(fromId, toId, kind\) => \{ activityReporter\.rekey\(fromId, toId\); taskRecords\.rekey/);
});

test('a scheduled run is a running session, each start paired with its ends, headless and background alike', () => {
  const run = block(MAIN, 'function runScheduleCommand(', '\n    }\n');
  const spans = run.split(/\n\s*const activityId = /).slice(1);
  assert.equal(spans.length, 2, 'one span for the background branch, one for the headless spawn');
  const [background, headless] = spans;
  for (const span of spans) {
    assert.match(span, /^`schedule:\$\{runName\}:\$\{Date\.now\(\)\}`;/);
    assert.equal((span.match(/activityReporter\.sessionStarted\(\{ sessionId: activityId, project: cwd, name: `Scheduled: \$\{runName\}` \}\)/g) || []).length, 1);
  }
  assert.match(background, /launchBackgroundSchedule\(/);
  assert.match(background, /\.finally\(\(\) => \{\s*activityReporter\.sessionEnded\(activityId\);/, 'the background span ends once, after completion or failure');
  assert.equal((background.match(/activityReporter\.sessionEnded\(activityId\)/g) || []).length, 1);
  assert.match(headless, /child\.on\('exit'[\s\S]*activityReporter\.sessionEnded\(activityId\)[\s\S]*child\.on\('error'[\s\S]*activityReporter\.sessionEnded\(activityId\)/,
    'the headless span ends on exit and on a spawn error alike');
  assert.equal((headless.match(/activityReporter\.sessionEnded\(activityId\)/g) || []).length, 2);
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
test('quit waits for the shared shutdown and exits immediately only after completion', () => {
  const quit = block(MAIN, "app.on('before-quit', event =>");
  assert.ok(quit.includes('if (shutdownComplete) return;'));
  assert.ok(quit.includes('if (!updateInstalling && unsavedGuard.beforeQuit(event, mainWindow, quitAttemptToken)) return;'));
  assert.ok(quit.includes('event.preventDefault();'));
  assert.ok(quit.includes('shutdownForExit().finally(exitOnce)'));
});

test('update install awaits the bounded reversible drain', () => {
  const install = block(MAIN, "ipcMain.handle('updater-install'");
  assert.ok(install.indexOf('await drainForUpdate()') >= 0);
  assert.ok(install.indexOf('await drainForUpdate()') < install.indexOf('quitAndInstall'));
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
  assert.match(onError, /resetUpdateAttempt\(\)/);
  assert.match(block(MAIN, 'function resetUpdateAttempt()'), /activityFlushedForQuit = false;/);
});

test('titles from the renderer are bounded before they are forwarded', () => {
  const titles = block(MAIN, "ipcMain.on('activity-titles'");
  assert.match(titles, /if \(!Array\.isArray\(list\)\) return;/);
  assert.match(titles, /typeof t\.name === 'string'/);
  assert.match(titles, /list\.slice\(0, 500\)/);
  assert.match(titles, /t\.sessionId\.length <= 200/);
  assert.match(titles, /t\.name\.slice\(0, 200\)/);
});
