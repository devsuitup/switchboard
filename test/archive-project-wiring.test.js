// Wiring of the archived-folder state in main.js, preload.js and dialogs.js.
// main.js requires('electron'), so these assertions read the handlers' own
// source text, the way test/remove-project-folder-key.test.js does.
// See .ai/contexts/session-cache.md ("Archived projects").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function handlerBody(channel) {
  const src = read('main.js');
  const start = src.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(start !== -1, `${channel} handler must exist`);
  return src.slice(start, src.indexOf('\n});', start));
}

function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} must exist`);
  return src.slice(start, src.indexOf('\n}', start));
}

test('archive-project: deletes no setting, cache row, search row or schedule registration', () => {
  const body = handlerBody('archive-project');
  for (const call of ['deleteSetting(', 'deleteCachedFolder(', 'deleteSearchFolder(', '.remove(']) {
    assert.ok(!body.includes(call), `archive-project must not call ${call}`);
  }
});

test('add-project: clears the archived entry of the folder', () => {
  assert.match(handlerBody('add-project'), /clearArchivedEntry\(getSetting, setSetting, null, projectPath\)/);
});

test('get-projects: applies the archived folders with the requested showArchived', () => {
  assert.match(handlerBody('get-projects'),
    /applyAndPersistArchived\(mergePlaceholderSessions\(buildProjectsFromCache\(showArchived\)\), showArchived, \{ getSetting, setSetting \}\)/);
});

test('preload: both bridges forward their arguments', () => {
  const src = read('preload.js');
  assert.match(src, /getProjectArchivePlan: \(groups\) => ipcRenderer\.invoke\('get-project-archive-plan', groups\)/);
  assert.match(src, /archiveProject: \(groups, opts\) => ipcRenderer\.invoke\('archive-project', groups, opts\)/);
});

test('delete-worktree: clears the archived entry of the removed worktree', () => {
  assert.match(handlerBody('delete-worktree'), /clearArchivedEntry\(getSetting, setSetting, null, normalizedPath\)/);
});

test('archive plan and archive refuse while the initial scan is incomplete', () => {
  assert.match(handlerBody('get-project-archive-plan'), /if \(!isInitialScanComplete\(\)\) return \{ indexing: true \};/);
  assert.match(handlerBody('archive-project'), /if \(!isInitialScanComplete\(\)\) return \{ error: 'indexing' \};/);
});

test('archive-project: no await between reading and writing archivedProjects', () => {
  const body = handlerBody('archive-project');
  const start = body.indexOf("getSetting('archivedProjects')");
  const end = body.indexOf("setSetting('archivedProjects'");
  assert.ok(start !== -1 && end > start, 'archive-project must read then write archivedProjects');
  assert.ok(!/\bawait\b/.test(body.slice(start, end)), 'the read-modify-write must be synchronous');
});

test('remote launch dialog: suggests the paths of archived folders too', () => {
  assert.match(functionBody(read('public/dialogs.js'), 'knownRemotePaths'), /for \(const p of cachedAllProjects\)/);
});

test('archive-project: records the files it disabled per group and replaces the folder\'s offer', () => {
  const body = handlerBody('archive-project');
  assert.match(body, /if \(res\.ok\) \{\s*disabledFiles\[i\]\.push\(schedule\.filePath\);/,
    'only the files actually disabled are recorded');
  assert.match(body, /disabledSchedules: disabledFiles\[i\],/);
  assert.match(body, /delete offers\[entry\];/, 'archiving again replaces any existing offer');
  const start = body.indexOf("getSetting('archivedProjects')");
  const end = body.indexOf("setSetting('scheduleReenableOffers'");
  assert.ok(start !== -1 && end > start, 'both settings are written in the same step');
  assert.ok(!/\bawait\b/.test(body.slice(start, end)));
});

test('reenable-project-schedules: turns back on the offered files, keeps only the failures, never awaits', () => {
  const body = handlerBody('reenable-project-schedules');
  assert.match(body, /reenableScheduleFiles\(offer\.disabledSchedules, projectPath\)/);
  assert.match(body, /if \(result\.failed\.length > 0\) next\[entry\] = \{ \.\.\.offer, disabledSchedules: result\.failed\.map\(f => f\.filePath\), failed: result\.failed\.map\(f => \(\{ name: f\.name, error: f\.error \}\)\) \};\s*else delete next\[entry\];/);
  assert.ok(!/\bawait\b/.test(body));
});

test('dismiss-schedule-reenable-offer: deletes the folder\'s offer', () => {
  assert.match(handlerBody('dismiss-schedule-reenable-offer'), /delete next\[entry\];\s*setSetting\('scheduleReenableOffers', next\);/);
});

test('preload: the offer bridges forward the project path and folder key', () => {
  const src = read('preload.js');
  assert.match(src, /reenableProjectSchedules: \(projectPath, folderKey\) => ipcRenderer\.invoke\('reenable-project-schedules', projectPath, folderKey\)/);
  assert.match(src, /dismissScheduleReenableOffer: \(projectPath, folderKey\) => ipcRenderer\.invoke\('dismiss-schedule-reenable-offer', projectPath, folderKey\)/);
});
