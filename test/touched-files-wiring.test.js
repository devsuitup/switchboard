// Reads the shipped sources as TEXT: it shows the glue between the touched-files
// listing and the rest of the app is still written down. Behaviour is in
// session-touched-files.test.js and dom-file-panel-touched.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { listSessionTouchedFiles } = require('../session-touched-files');
const { isRemoteFolder } = require('../remote-hosts');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('shipped Touched list IPC reads the mirror under DB_PATH and makes one fake transport call', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-remote-touched-wire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mirror = path.join(root, 'remote', 'host', 'projects', '-repo');
  fs.mkdirSync(mirror, { recursive: true });
  fs.writeFileSync(path.join(mirror, 'S1.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Write', input: { file_path: '/repo/a' } },
  ] } }) + '\n');
  const handlers = new Map();
  let attempts = 0;
  const src = read('main.js');
  const start = src.indexOf("ipcMain.handle('session-touched-files'");
  const end = src.indexOf('\n});', start) + '\n});'.length;
  vm.runInNewContext(src.slice(start, end), {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, path,
    PROJECTS_DIR: path.join(root, 'local-projects'), DB_PATH: path.join(root, 'switchboard.db'),
    getCachedFolder: () => 'host::-repo', isRemoteFolder,
    isSensitivePathAsync: () => { assert.fail('remote paths must not be inspected on the local disk'); },
    listSessionTouchedFiles: (id, deps) => listSessionTouchedFiles(id, { ...deps, runRemoteCommand: async () => {
      attempts++; return { code: 0, stdout: 'present\t1700000000\n' };
    } }),
  });
  const mirrorResult = await handlers.get('session-touched-files')(null, 'S1', { diskInfo: false });
  assert.equal(mirrorResult.ok, true, mirrorResult.error);
  assert.equal(mirrorResult.files[0].state, 'unknown');
  assert.equal(mirrorResult.diskInfoPending, true);
  assert.equal(attempts, 0, 'mirror response must precede any remote inspection');
  const result = await handlers.get('session-touched-files')(null, 'S1');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.files[0].path, '/repo/a');
  assert.equal(result.files[0].diskMtime, 1700000000000);
  assert.equal(attempts, 1);
});

test('main.js serves session-touched-files through the sensitive-path guard and the cached folder', () => {
  const src = read('main.js');
  const at = src.indexOf("ipcMain.handle('session-touched-files'");
  assert.notEqual(at, -1, 'the handler is registered');
  const body = src.slice(at, src.indexOf('});', src.indexOf('listSessionTouchedFiles(', at)) + 3);
  assert.match(body, /isSensitive:\s*isSensitivePathAsync/);
  assert.match(body, /getCachedFolder/);
  assert.match(body, /isRemoteFolder/);
  assert.match(body, /projectsDir:\s*PROJECTS_DIR/);
  assert.match(body, /dataDir:\s*path\.dirname\(DB_PATH\)/);
});

test('preload.js exposes sessionTouchedFiles on the same channel and nothing that reads a path', () => {
  const src = read('preload.js');
  assert.match(src, /sessionTouchedFiles:\s*\(sessionId, options\)\s*=>\s*ipcRenderer\.invoke\('session-touched-files',\s*sessionId, options\)/);
});

test('index.html loads the touched tab after the file panel it hooks into', () => {
  const html = read('public/index.html');
  const panel = html.indexOf('src="file-panel.js"');
  const touched = html.indexOf('src="touched-files-view.js"');
  assert.ok(panel !== -1 && touched > panel);
});

test('the touched tab opens a file only through readFileForPanel', () => {
  const src = read('public/touched-files-view.js');
  const apis = [...src.matchAll(/window\.api\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(apis)].sort(), ['readFileForPanel', 'resolveTerminalPaths', 'sessionTouchedFiles']);
});

test('a path is shown in its own bidi isolate, so an override in it cannot reorder the row', () => {
  const css = read('public/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.touched-file-path\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the rule exists');
  assert.match(rule[1], /unicode-bidi:\s*isolate/);
});
