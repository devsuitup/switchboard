'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { setupDom, openLink, flush } = require('./touched-panel-harness');
const os = require('node:os');

function viewer(t, opts = { openExternal: true, revealInFolder: true }) {
  const dom = new JSDOM('<div id="viewer"></div>', { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = { open: [], reveal: [], alerts: [], save: [] };
  window.api = {
    watchFile() {}, unwatchFile() {},
    openPath: async (...args) => { calls.open.push(args); return ''; },
    showItemInFolder: async (...args) => { calls.reveal.push(args); return { ok: true }; },
  };
  window.appAlert = async message => calls.alerts.push(message);
  for (const name of ['viewer-toolbar.js', 'viewer-panel.js']) {
    const filename = path.join(__dirname, '../public', name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), dom.getInternalVMContext(), { filename });
  }
  const panel = new window.ViewerPanel(window.document.getElementById('viewer'), {
    ...opts, onSave: async (...args) => { calls.save.push(args); return { ok: true }; },
  });
  return { window, panel, calls, dom };
}

function buttons(panel) {
  const open = panel.toolbar.openExternalBtn;
  const reveal = panel.toolbar.revealInFolderBtn;
  assert.ok(open, 'Open in default app button exists');
  assert.ok(reveal, 'Reveal in folder button exists');
  assert.equal(open.getAttribute('aria-label'), 'Open in default app');
  assert.equal(reveal.getAttribute('aria-label'), 'Reveal in folder');
  return { open, reveal };
}

test('local viewer actions follow the current disk path without saving the buffer', async t => {
  const { panel, calls } = viewer(t);
  const { open, reveal } = buttons(panel);
  assert.equal(open.hidden, true);
  assert.equal(reveal.hidden, true);
  panel.open('Memory', '/repo/memory.md', 'unsaved text');
  assert.equal(open.hidden, false);
  assert.equal(reveal.hidden, false);
  open.click(); reveal.click();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.open)), [['/repo/memory.md', { viewer: true }]]);
  assert.deepEqual(calls.reveal, [['/repo/memory.md']]);
  assert.deepEqual(calls.save, []);
  assert.equal(panel._buffer(), 'unsaved text');
  panel.open('Trace', 'C:\\project\\trace.jsonl', 'trace');
  open.click(); reveal.click();
  await flush();
  assert.equal(calls.open[1][0], 'C:\\project\\trace.jsonl');
  assert.equal(calls.reveal[1][0], 'C:\\project\\trace.jsonl');
});

test('viewer Open refuses executable aliases while Reveal remains available', async t => {
  const { panel, calls } = viewer(t);
  const { open, reveal } = buttons(panel);
  for (const name of ['x.bat', 'x.CMD', 'x.ps1', 'x.ExE', 'x.BAT.', 'x.cmd ', 'x.Ps1. ',
    'x.exe...', 'x.com', 'x.vbs', 'x.js', 'x.msi', 'x.lnk', 'x.scr', 'x.reg', 'x.txt.exe', 'x.unknown']) {
    panel.open(name, '/repo/' + name, 'file');
    assert.equal(open.hidden, true, name + ': Open hidden');
    assert.equal(reveal.hidden, false, name + ': Reveal available');
    open.click(); reveal.click();
  }
  await flush();
  assert.deepEqual(calls.open, [], 'hidden Open never invokes the IPC');
  assert.equal(calls.reveal.length, 17);
});

test('virtual paths and a viewer without opt-in have no active disk actions', async t => {
  const { panel, calls } = viewer(t);
  const { open, reveal } = buttons(panel);
  for (const file of ['', 'virtual.md', 'ssh://server/path.md', 'https://host/path.md']) {
    panel.open('Virtual', file, 'text');
    assert.equal(open.hidden, true);
    assert.equal(reveal.hidden, true);
    open.click(); reveal.click();
  }
  await flush();
  assert.deepEqual(calls.open, []);
  assert.deepEqual(calls.reveal, []);
  const virtual = viewer(t, {}).panel;
  assert.ok(!virtual.toolbar.openExternalBtn && !virtual.toolbar.revealInFolderBtn);
});

test('action failures are reported without discarding edits', async t => {
  const { window, panel, calls } = viewer(t);
  const { open, reveal } = buttons(panel);
  panel.open('File', '/repo/file.txt', 'keep me');
  window.api.openPath = async () => 'No association';
  open.click();
  await flush();
  assert.match(calls.alerts[0]?.message || '', /No association/);
  window.api.showItemInFolder = async () => ({ ok: false, reason: 'missing' });
  reveal.click();
  await flush();
  assert.match(calls.alerts[1]?.message || '', /missing/);
  window.api.openPath = async () => { throw new Error('offline'); };
  open.click();
  await flush();
  assert.match(calls.alerts[2]?.message || '', /offline/);
  assert.equal(panel._buffer(), 'keep me');
});

test('Memory and Activity trace opt into both file actions', t => {
  const dom = new JSDOM('<div></div>', { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const configurations = [];
  window.ViewerPanel = class { constructor(_host, opts) { configurations.push(opts); } };
  window.memoryViewer = window.document.createElement('div');
  const filename = path.join(__dirname, '../public/app.js');
  const app = fs.readFileSync(filename, 'utf8');
  const start = app.indexOf('const memoryPanel = new ViewerPanel(');
  vm.runInContext(app.slice(start, app.indexOf('\n});', start) + 4), dom.getInternalVMContext(), { filename });
  window.document.body.innerHTML += '<div id="activity-trace-viewer"></div>';
  const trace = path.join(__dirname, '../public/activity-trace-panel.js');
  vm.runInContext(fs.readFileSync(trace, 'utf8'), dom.getInternalVMContext(), { filename: trace });
  window.getActivityTracePanel();
  assert.equal(configurations.length, 2);
  for (const opts of configurations) {
    assert.equal(opts.openExternal, true, 'real file viewer opts into Open');
    assert.equal(opts.revealInFolder, true, 'real file viewer opts into Reveal');
  }
});

test('Touched and .work-files have both toolbar actions, scripts only Reveal, remote neither', async t => {
  const ctx = setupDom({ readImpl: filePath => ({ ok: true, original: 'base', current: 'disk', version: 'v1',
    git: true, kind: filePath.endsWith('remote.md') ? 'remote' : 'local' }) });
  t.after(() => ctx.destroy());
  ctx.window.switchPanel('s1');
  await openLink(ctx, '/repo/.work-files/report.md');
  const header = ctx.document.querySelector('#changes-diff-view .viewer-toolbar');
  const open = header.querySelector('[aria-label="Open in default app"]');
  const reveal = header.querySelector('[aria-label="Reveal in folder"]');
  assert.ok(open && reveal, 'file-panel editor has both actions');
  assert.equal(open.hidden, false);
  assert.equal(reveal.hidden, false);
  ctx.editors.at(-1).setText('unsaved');
  open.click(); reveal.click();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls.openPath)), [['/repo/.work-files/report.md', { viewer: true }]]);
  assert.deepEqual(ctx.calls.showItem, [['/repo/.work-files/report.md']]);
  assert.deepEqual(ctx.calls.save, []);
  await openLink(ctx, '/repo/run.cmd');
  assert.equal(open.hidden, true);
  assert.equal(reveal.hidden, false);
  await openLink(ctx, '/repo/remote.md');
  assert.equal(open.hidden, true);
  assert.equal(reveal.hidden, true);
  open.click(); reveal.click();
  await flush();
  assert.equal(ctx.calls.openPath.length, 1);
  assert.equal(ctx.calls.showItem.length, 1);
});

test('local image previews also offer Open and Reveal', async t => {
  const ctx = setupDom({ readImpl: () => ({ ok: true, kind: 'image', mime: 'image/png', base64: 'AA==', bytes: 1 }) });
  t.after(() => ctx.destroy());
  ctx.window.switchPanel('s1');
  await openLink(ctx, '/repo/image.png');
  const header = ctx.document.querySelector('#changes-diff-view .viewer-toolbar');
  const open = header.querySelector('[aria-label="Open in default app"]');
  const reveal = header.querySelector('[aria-label="Reveal in folder"]');
  assert.ok(open && reveal);
  assert.equal(open.hidden, false);
  assert.equal(reveal.hidden, false);
});

test('toolbar and IPC document allowlists stay identical', t => {
  const { dom } = viewer(t);
  const extensions = vm.runInContext('VIEWER_OPEN_EXTENSIONS', dom.getInternalVMContext());
  assert.deepEqual(Array.from(extensions), require('../src/main/files/panel-image').SYSTEM_VIEWER_EXTENSIONS);
});

test('the shipped icon styles cannot expose a hidden file action', t => {
  const { window, panel } = viewer(t);
  const style = window.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  window.document.head.appendChild(style);
  const { open, reveal } = buttons(panel);
  panel.open('Script', '/repo/run.cmd', 'script');
  assert.equal(window.getComputedStyle(open).display, 'none', 'Open is visually hidden for scripts');
  assert.notEqual(window.getComputedStyle(reveal).display, 'none');
  panel.open('Document', '/repo/note.md', 'text');
  assert.notEqual(window.getComputedStyle(open).display, 'none');
  panel.open('Virtual', '', 'text');
  assert.equal(window.getComputedStyle(open).display, 'none');
  assert.equal(window.getComputedStyle(reveal).display, 'none');
});

test('Changes reads return the guarded on-disk path for the viewer actions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-actions-1203-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'note.md');
  fs.writeFileSync(file, 'disk text');
  const { readChangesFile } = require('../src/main/changes/git-changes-file');
  const pair = await readChangesFile({ cwd: root, relPath: 'note.md', maxBytes: 1024 }, {
    runGit: async args => ({ code: 0, stdout: args[0] === 'rev-parse' ? root + '\n' : Buffer.from('base text') }),
  });
  assert.equal(pair.ok, true);
  assert.equal(typeof pair.path, 'string', 'the viewer gets the validated disk path');
  assert.equal(fs.realpathSync.native(pair.path), fs.realpathSync.native(file), 'the path identifies the file read');
  const ctx = setupDom();
  t.after(() => ctx.destroy());
  ctx.window.api.gitChangesFile = async () => pair;
  ctx.window.switchPanel('s1');
  await ctx.window.openChangesTab('s1');
  await ctx.window.openChangesDiff('s1', { path: 'note.md' });
  await flush();
  const header = ctx.document.querySelector('#changes-diff-view .viewer-toolbar');
  const open = header.querySelector('[aria-label="Open in default app"]');
  const reveal = header.querySelector('[aria-label="Reveal in folder"]');
  assert.equal(open.hidden, false);
  assert.equal(reveal.hidden, false);
  open.click(); reveal.click();
  await flush();
  assert.equal(ctx.calls.openPath[0]?.[0], pair.path);
  assert.equal(ctx.calls.showItem[0]?.[0], pair.path);
});
