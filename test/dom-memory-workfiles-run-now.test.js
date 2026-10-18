'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function setup(t, run) {
  const dom = new JSDOM('<body><div id="app-notices"></div></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const ctx = dom.getInternalVMContext();
  const calls = [];
  dom.window.api = { runScheduleNow: async filePath => { calls.push(filePath); return run(); } };
  dom.window.formatDate = () => 'today';
  dom.window.ICONS = { schedule: () => '<svg></svg>' };
  for (const name of ['app-notices.js', 'memory-workfiles-view.js']) {
    const filename = path.join(__dirname, '../public', name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  }
  const item = dom.window.buildMemoryItem({ filename: 'schedule-nightly.md', filePath: '/p/schedule-nightly.md', displayPath: '/p', modified: Date.now() });
  dom.window.document.body.append(item);
  const button = item.querySelector('.schedule-play-btn');
  const titles = [];
  new dom.window.MutationObserver(records => {
    titles.push(...records.map(record => record.oldValue), button.title);
  }).observe(button, { attributes: true, attributeFilter: ['title'], attributeOldValue: true });
  return { dom, calls, button, titles };
}

for (const [label, run, reason] of [
  ['backend refusal', () => ({ ok: false, error: 'boom' }), 'boom'],
  ['rejected IPC', () => { throw new Error('offline'); }, 'offline'],
  ['missing result', () => undefined, 'no result'],
]) {
  test(`Run now ${label} leaves a persistent error and restores its button`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = setup(t, run);
    const icon = h.button.innerHTML;
    h.button.click();
    await new Promise(resolve => setImmediate(resolve));
    const alert = h.dom.window.document.querySelector('[role="alert"]');
    assert.ok(alert, 'a failed launch must leave a visible notice');
    assert.ok(alert.textContent.includes(reason));
    assert.match(alert.textContent, /schedule-nightly\.md/);
    assert.match(alert.textContent, /try Run now again/i);
    assert.equal(h.button.title, 'Run now');
    assert.ok(!h.titles.includes('Launched!'), 'a failed launch never reports success, even briefly');
    assert.equal(h.button.innerHTML, icon);
    assert.equal(h.button.classList.contains('running'), false);
    assert.equal(h.button.classList.contains('done'), false);
    assert.deepEqual(h.calls, ['/p/schedule-nightly.md']);
    t.mock.timers.tick(20_000);
    assert.ok(alert.isConnected);
  });
}

test('Run now reports success only after ok and clears the error for that file', async t => {
  let ok = false;
  const h = setup(t, () => ({ ok, error: 'boom' }));
  h.button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.dom.window.document.querySelector('[role="alert"]'));
  ok = true;
  h.button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.button.title, 'Launched!');
  assert.equal(h.button.classList.contains('done'), true);
  assert.equal(h.dom.window.document.querySelector('[role="alert"]'), null);
});
