// flashButtonText on the toolbar's icon buttons — see .ai/contexts/changes-view.md ("Look and feel")
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const TOOLBAR = path.join(__dirname, '..', 'public', 'viewer-toolbar.js');

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  vm.runInContext(fs.readFileSync(TOOLBAR, 'utf8'), dom.getInternalVMContext(), { filename: TOOLBAR });
  return dom.window;
}

test('a Save or Copy flash on an icon button keeps its icon and flashes its colour (mutation target: the icon-button check)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = setup();
  try {
    const toolbar = window.createViewerToolbar({ save: true, copyContent: true });
    for (const [btn, flash, word] of [[toolbar.saveBtn, 'flashSave', 'Saved!'], [toolbar.copyContentBtn, 'flashCopyContent', 'Copied!']]) {
      assert.ok(btn.classList.contains('icon-btn'));
      const icon = btn.innerHTML;
      toolbar[flash]();
      assert.ok(btn.querySelector('svg'), `${word}: the icon survives the flash`);
      assert.equal(btn.textContent.includes(word), false, `${word}: no word replaces the icon`);
      assert.notEqual(btn.style.color, '', 'the flash is a colour');
      t.mock.timers.tick(1300);
      assert.equal(btn.innerHTML, icon);
      assert.equal(btn.style.color, '', 'and the colour comes back');
    }
  } finally { window.close(); }
});

test('a text button still flashes its word', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = setup();
  try {
    const btn = window.document.createElement('button');
    btn.textContent = 'Apply';
    window.flashButtonText(btn, 'Done', 500);
    assert.equal(btn.textContent, 'Done');
    t.mock.timers.tick(600);
    assert.equal(btn.textContent, 'Apply');
  } finally { window.close(); }
});
