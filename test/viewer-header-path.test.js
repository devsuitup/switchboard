'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const source = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');

for (const filePath of ['/work/deep/folder/report.md', 'C:\\Users\\JB\\Temp\\project\\report.md', 'report.md', '<folder>/report.md', '']) {
  test(`shared viewer path keeps the filename separate and the full hover path: ${filePath}`, () => {
    const dom = new JSDOM('<!DOCTYPE html>', { runScripts: 'outside-only' });
    try {
      vm.runInContext(source('viewer-toolbar.js'), dom.getInternalVMContext());
      const toolbar = dom.window.createViewerToolbar();
      toolbar.setPath(filePath);
      const el = toolbar.pathEl;
      assert.equal(el.title, filePath);
      assert.equal(el.textContent, filePath);
      assert.ok(el.classList.contains('viewer-header-path'));
      assert.equal(el.querySelector('.viewer-path-tail').textContent, filePath.split(/[\\/]/).at(-1));
      assert.equal(el.querySelectorAll('span').length, 2);
      assert.equal(el.querySelectorAll('folder').length, 0);
      toolbar.setPath('/new/file.txt');
      assert.equal(el.querySelectorAll('span').length, 2);
      assert.equal(el.title, '/new/file.txt');
    } finally { dom.window.close(); }
  });
}

test('Settings selects retain their alias and carry the shared select class when rendered', async () => {
  const dom = new JSDOM('<!DOCTYPE html>' + ['settings-viewer', 'settings-viewer-title', 'settings-viewer-body',
    'placeholder', 'terminal-area', 'stats-viewer', 'memory-viewer', 'jsonl-viewer'].map(id => `<div id="${id}"></div>`).join(''),
  { url: 'http://localhost/', runScripts: 'outside-only' });
  try {
    const w = dom.window;
    w.api = { getSetting: async () => ({}), getShellProfiles: async () => [], getAppVersion: async () => '1.0.0', onUpdaterEvent() {} };
    w.shortProjectPath = p => p;
    w.PERMISSION_MODES = [{ value: null }];
    w.TERMINAL_THEMES = { default: { label: 'Default' } };
    w.escapeHtml = text => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    for (const file of ['setting-defaults.js', 'shortcuts.js', 'settings-panel.js']) vm.runInContext(source(file), dom.getInternalVMContext());
    await w.openSettingsViewer('global');
    const selects = [...w.document.querySelectorAll('#settings-viewer-body select')];
    assert.ok(selects.length >= 4);
    for (const select of selects) {
      assert.ok(select.classList.contains('settings-select'));
      assert.ok(select.classList.contains('control-select'));
    }
  } finally { dom.window.close(); }
});

for (const filePath of ['/work/deep/folder/', 'C:\\Users\\JB\\folder\\', '/work/folder///', 'folder/']) {
  test(`shared viewer path uses the last non-empty segment for a separator-ending path: ${filePath}`, () => {
    const dom = new JSDOM('<!DOCTYPE html>', { runScripts: 'outside-only' });
    try {
      vm.runInContext(source('viewer-toolbar.js'), dom.getInternalVMContext());
      const toolbar = dom.window.createViewerToolbar();
      toolbar.setPath(filePath);
      assert.equal(toolbar.pathEl.title, filePath);
      assert.equal(toolbar.pathEl.textContent, filePath.replace(/[\\/]+$/, ''));
      assert.equal(toolbar.pathEl.querySelector('.viewer-path-tail').textContent, 'folder');
      assert.equal(toolbar.pathEl.querySelectorAll('span').length, 2);
    } finally { dom.window.close(); }
  });
}

test('shared path CSS shrinks the head first and lets an oversized filename tail show an ellipsis', () => {
  const css = source('style.css');
  const head = css.match(/\.viewer-path-head\s*\{([^}]*)\}/s)[1];
  const tail = css.match(/\.viewer-path-tail\s*\{([^}]*)\}/s)[1];
  for (const rule of [head, tail]) {
    assert.match(rule, /min-width:\s*0\s*;/);
    assert.match(rule, /overflow:\s*hidden\s*;/);
    assert.match(rule, /text-overflow:\s*ellipsis\s*;/);
    assert.match(rule, /white-space:\s*nowrap\s*;/);
  }
  const headShrink = Number(head.match(/flex:\s*0\s+(\d+)\s+auto/)[1]);
  const tailShrink = Number(tail.match(/flex:\s*0\s+(\d+)\s+auto/)[1]);
  assert.ok(tailShrink > 0);
  assert.ok(headShrink > tailShrink);
});

for (const storageKey of ['markdownPreviewMode', 'workFilesPreviewMode']) {
  test(`ViewerPanel headers use the shared path structure for ${storageKey}`, () => {
    const dom = new JSDOM('<!DOCTYPE html><div id="viewer"></div>', { url: 'http://localhost/', runScripts: 'outside-only' });
    try {
      dom.window.api = { onFileChanged() {} };
      for (const file of ['viewer-toolbar.js', 'viewer-panel.js']) vm.runInContext(source(file), dom.getInternalVMContext());
      const panel = new dom.window.ViewerPanel(dom.window.document.getElementById('viewer'), { storageKey });
      panel.open('report.txt', '/work/deep/report.txt', 'text');
      assert.equal(panel.toolbar.pathEl.title, '/work/deep/report.txt');
      assert.equal(panel.toolbar.pathEl.querySelector('.viewer-path-tail').textContent, 'report.txt');
      panel.destroy();
    } finally { dom.window.close(); }
  });
}
