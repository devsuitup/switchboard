'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

test('loadMemories preserves the previous list on rejection and shows a persistent retry notice', async t => {
  const dom = new JSDOM('<body><div id="app-notices"></div><div id="memory-content"></div></body>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const context = dom.getInternalVMContext();
  const file = { filename: 'note.md', filePath: '/project/.claude/note.md', modified: '2026-01-01', displayPath: 'Global' };
  const initial = { global: { files: [file] }, projects: [] };
  window.api = { getMemories: async () => initial };
  window.memoryContent = window.document.getElementById('memory-content');
  for (const name of ['utils.js', 'icons.js', 'app-notices.js', 'memory-workfiles-view.js']) {
    const filename = path.join(__dirname, '../public', name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  await window.loadMemories();
  const content = window.memoryContent;
  const previous = content.firstChild;
  const html = content.innerHTML;
  window.api.getMemories = async () => { throw new Error('worker timed out'); };
  await assert.doesNotReject(window.loadMemories());
  assert.equal(content.firstChild, previous);
  window.renderMemories();
  assert.equal(content.innerHTML, html);
  const notice = window.document.querySelector('#app-notices [role="alert"]');
  assert.ok(notice);
  assert.match(notice.textContent, /Memory/);
  assert.match(notice.textContent, /reopen.*tab.*retry/i);
  assert.equal(vm.runInContext("appNoticeEntries.get('getMemories').timer", context), null);
  window.api.getMemories = async () => initial;
  await window.loadMemories();
  assert.equal(window.document.querySelector('#app-notices [role="alert"]'), null);
});
