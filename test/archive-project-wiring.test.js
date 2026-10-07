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
  const bodies = [handlerBody('archive-project'), functionBody(read('main.js'), 'archiveDeps'),
    functionBody(read('archived-projects.js'), 'archiveProjectFolders')];
  for (const body of bodies) {
    for (const call of ['deleteSetting', 'deleteCachedFolder', 'deleteSearchFolder', '.remove(']) {
      assert.ok(!body.includes(call), `the archive must not reach ${call}`);
    }
  }
});

test('archive-project: wires the real effects into archiveProjectFolders', () => {
  assert.match(handlerBody('archive-project'), /archiveProjectFolders\(groups, opts, archiveDeps\(\)\)/);
  const deps = functionBody(read('main.js'), 'archiveDeps');
  for (const wiring of [
    /isInitialScanComplete,/, /plan: projectArchivePlan,/, /setEnabled: setScheduleEnabled,/,
    /getAllCached, resolveFolderDir, refreshFolder,/,
    /buildProjects: \(\) => mergePlaceholderSessions\(buildProjectsFromCache\(true\)\),/,
    /activeSessions, getSetting, setSetting,/, /notify: notifyRendererProjectsChanged,/,
  ]) assert.match(deps, wiring);
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

test('archive plan: refused while the initial scan is incomplete', () => {
  assert.match(handlerBody('get-project-archive-plan'), /if \(!isInitialScanComplete\(\)\) return \{ indexing: true \};/);
  assert.match(handlerBody('get-project-archive-plan'), /projectArchivePlan\(validArchiveGroups\(groups\)\)/);
});

test('remote launch dialog: suggests the paths of archived folders too', () => {
  assert.match(functionBody(read('public/dialogs.js'), 'knownRemotePaths'), /for \(const p of cachedAllProjects\)/);
});

test('re-enable and dismiss: wired to their functions with the real effects', () => {
  assert.match(handlerBody('reenable-project-schedules'), /reenableOfferedSchedules\(projectPath, folderKey, archiveDeps\(\)\)/);
  assert.match(handlerBody('dismiss-schedule-reenable-offer'), /dismissReenableOffer\(projectPath, folderKey, archiveDeps\(\)\)/);
});

test('preload: the offer bridges forward the project path and folder key', () => {
  const src = read('preload.js');
  assert.match(src, /reenableProjectSchedules: \(projectPath, folderKey\) => ipcRenderer\.invoke\('reenable-project-schedules', projectPath, folderKey\)/);
  assert.match(src, /dismissScheduleReenableOffer: \(projectPath, folderKey\) => ipcRenderer\.invoke\('dismiss-schedule-reenable-offer', projectPath, folderKey\)/);
});
