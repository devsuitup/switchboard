'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupSidebarDom } = require('./dom-setup');

test('the last registered modal is visually above the previous question', async () => {
  const ctx = setupSidebarDom();
  try {
    const style = ctx.document.createElement('style');
    const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
    style.textContent = ['.modal-overlay,', '.new-session-overlay {']
      .map(selector => {
        const start = css.indexOf(selector);
        assert.notEqual(start, -1);
        return css.slice(start, css.indexOf('}', start) + 1);
      }).join('\n');
    ctx.document.head.append(style);
    const question = ctx.window.appConfirm({ title: 'Underneath', danger: true });
    const underneath = ctx.document.querySelector('.choice-dialog-overlay');
    const top = ctx.document.createElement('div');
    top.className = 'new-session-overlay';
    top.innerHTML = '<button>Cancel</button>';
    ctx.document.body.append(top);
    const unregister = ctx.window.registerModal({ overlay: top, cancel: () => { top.remove(); unregister(); } });
    assert.ok(Number(ctx.window.getComputedStyle(top).zIndex) >= Number(ctx.window.getComputedStyle(underneath).zIndex),
      'keyboard ownership and visible stacking must agree');
    top.firstElementChild.focus();
    top.firstElementChild.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(top.isConnected, false);
    assert.equal(underneath.isConnected, true);
    underneath.querySelector('.choice-dialog-cancel').click();
    assert.equal(await question, false);
  } finally { ctx.destroy(); }
});

test('settleWith resolves a queued question before it opens and removes it from the queue', async () => {
  const ctx = setupSidebarDom();
  try {
    const { enqueueModalQuestion, hasActiveModalQuestion } = ctx.window;
    let release;
    enqueueModalQuestion(() => new Promise((r) => { release = r; }));
    assert.equal(hasActiveModalQuestion(), true);
    let opened = 0;
    let settle;
    const queued = enqueueModalQuestion(() => { opened++; return 'opened'; }, { settleWith: new Promise((r) => { settle = r; }) });
    settle('settled');
    assert.equal(await Promise.race([queued, new Promise((r) => setTimeout(() => r('still queued'), 50))]), 'settled');
    release();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(opened, 0, 'a settled question never opens');
    assert.equal(hasActiveModalQuestion(), false);
  } finally { ctx.destroy(); }
});
