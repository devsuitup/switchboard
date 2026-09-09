// remove-project used to derive the cache folder key from projectPath alone
// (encodeProjectPath(projectPath)), which is wrong for a remote group: its real
// cache key is `<alias>::<encoded path>` (joinFolderKey in remote-hosts.js).
// Hiding a remote project therefore left its rows in session_cache and its
// entries in the search index forever. See session-cache-hidden-alias.test.js
// for the companion filtering fix (hidden entries becoming alias-qualified).
//
// main.js requires('electron'), so it cannot be require()'d under node:test
// (see test/delete-session.test.js and test/auto-update-setting.test.js for
// the same constraint). These assertions run against the handler's own source
// text, extracted by its ipcMain.handle(...) boundary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function handlerBody() {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('remove-project'");
  assert.ok(start !== -1, 'remove-project handler must exist');
  return src.slice(start, src.indexOf('\n});', start));
}

test('remove-project: accepts an explicit folder key and uses it for cache cleanup', () => {
  const body = handlerBody();
  assert.match(body, /\('remove-project',\s*\(_event,\s*projectPath,\s*folderKey\)/,
    'the handler must accept a second folderKey argument');
  assert.match(body, /const folder = folderKey \|\| encodeProjectPath\(projectPath\);/,
    'the cache folder key must prefer the passed folderKey over deriving one from projectPath alone');
  const folderLine = body.indexOf('const folder = folderKey');
  const cleanup = body.slice(folderLine);
  assert.match(cleanup, /deleteCachedFolder\(folder\)/,
    'session_cache cleanup must use the resolved folder key, not a re-derived one');
  assert.match(cleanup, /deleteSearchFolder\(folder\)/,
    'the search index cleanup must use the same resolved folder key');
});

test('remove-project: writes an alias-qualified hidden entry for a remote group', () => {
  const body = handlerBody();
  assert.match(body, /const \{ alias \} = folderKey \? parseFolderKey\(folderKey\) : \{ alias: null \};/,
    'the alias must be derived from the passed folder key, not guessed');
  assert.match(body, /const hiddenEntry = alias === null \? projectPath : joinFolderKey\(alias, projectPath\);/,
    'a remote group must be hidden under its alias-qualified entry, a local one under the bare path');
  const entryLine = body.indexOf('const hiddenEntry');
  const push = body.slice(entryLine);
  assert.match(push, /hidden\.includes\(hiddenEntry\)/);
  assert.match(push, /hidden\.push\(hiddenEntry\)/,
    'the computed hiddenEntry must be what gets pushed, not the bare projectPath');
});

test('preload: removeProject forwards the folder key to the main process', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.match(preload,
    /removeProject: \(projectPath, folderKey\) => ipcRenderer\.invoke\('remove-project', projectPath, folderKey\)/,
    'the bridge must widen to two arguments end to end');
});

test('renderer: the settings viewer threads the group folder key through to remove-project', () => {
  const sidebar = fs.readFileSync(path.join(ROOT, 'public', 'sidebar.js'), 'utf8');
  assert.match(sidebar, /openSettingsViewer\('project', project\.projectPath, project\.folder\)/,
    'the folder key must be passed into the settings viewer alongside the project path');

  const panel = fs.readFileSync(path.join(ROOT, 'public', 'settings-panel.js'), 'utf8');
  assert.match(panel, /async function openSettingsViewer\(scope, projectPath, folderKey\)/,
    'the settings viewer must accept the folder key it is given');
  assert.match(panel, /window\.api\.removeProject\(projectPath, folderKey\)/,
    'Hide Project must pass the folder key through, not just the projectPath');
});
