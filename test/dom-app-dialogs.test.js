const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');
function setup() {
  const ctx = setupSidebarDom();
  const filename = path.join(__dirname, '../public/app-dialogs.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx.context, { filename });
  return ctx;
}
function key(ctx, name) {
  ctx.document.activeElement.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
}
test('app dialogs queue confirmations and alerts without treating busy as cancel', async () => {
  const ctx = setup();
  try {
    const first = ctx.window.appConfirm({ title: 'First', message: 'One' });
    const second = ctx.window.appConfirm({ title: 'Second', message: 'Two' });
    const third = ctx.window.appAlert({ title: 'Third', message: 'Three' });
    assert.equal(ctx.document.querySelectorAll('.choice-dialog-overlay').length, 1);
    key(ctx, 'Enter');
    assert.equal(await first, true);
    assert.equal(ctx.document.querySelector('h2').textContent, 'Second');
    key(ctx, 'Escape');
    assert.equal(await second, false);
    assert.equal(ctx.document.querySelector('h2').textContent, 'Third');
    assert.equal(ctx.document.querySelector('.choice-dialog-cancel').hidden, true);
    key(ctx, 'Enter');
    await third;
    assert.equal(ctx.document.querySelector('.choice-dialog-overlay'), null);
  } finally { ctx.destroy(); }
});
test('destructive confirm focuses Cancel, styles danger, and restores its connected opener', async () => {
  const ctx = setup();
  try {
    const opener = ctx.document.createElement('button');
    ctx.document.body.append(opener);
    opener.focus();
    const pending = ctx.window.appConfirm({ title: 'Delete', message: 'Really?', confirmLabel: 'Delete', danger: true });
    assert.equal(ctx.document.activeElement, ctx.document.querySelector('.choice-dialog-cancel'));
    assert.ok(ctx.document.querySelector('.choice-dialog-confirm').classList.contains('delete-worktree-confirm-btn'));
    key(ctx, 'Enter');
    assert.equal(await pending, false);
    assert.equal(ctx.document.activeElement, opener);
    const again = ctx.window.appConfirm({ message: 'Again' });
    assert.equal(ctx.document.activeElement, ctx.document.querySelector('.choice-dialog-confirm'));
    key(ctx, 'Escape');
    assert.equal(await again, false);
    assert.equal(ctx.document.activeElement, opener);
  } finally { ctx.destroy(); }
});
test('app confirmation waits behind an existing choice dialog', async () => {
  const ctx = setup();
  try {
    const existing = ctx.window.showChoiceDialog({ title: 'Choices' });
    const pending = ctx.window.appConfirm({ title: 'Queued' });
    key(ctx, 'Enter');
    await existing;
    assert.equal(ctx.document.querySelector('h2').textContent, 'Queued');
    key(ctx, 'Enter');
    assert.equal(await pending, true);
  } finally { ctx.destroy(); }
});
test('closing does not focus a disconnected opener', async () => {
  const ctx = setup();
  try {
    const opener = ctx.document.createElement('button');
    ctx.document.body.append(opener);
    opener.focus();
    const pending = ctx.window.appConfirm({ message: 'Really?' });
    opener.remove();
    let focused = false;
    opener.focus = () => { focused = true; };
    key(ctx, 'Escape');
    assert.equal(await pending, false);
    assert.equal(focused, false);
  } finally { ctx.destroy(); }
});

test('queued dialogs restore the external opener after the entire queue closes', async () => {
  const ctx = setup();
  try {
    const opener = ctx.document.createElement('button');
    ctx.document.body.append(opener);
    opener.focus();
    const first = ctx.window.appConfirm({ title: 'First' });
    const second = ctx.window.appConfirm({ title: 'Second' });
    key(ctx, 'Enter');
    await first;
    key(ctx, 'Escape');
    await second;
    assert.equal(ctx.document.activeElement, opener);
  } finally { ctx.destroy(); }
});

test('messages preserve the line breaks used by resume and error details', async () => {
  const ctx = setup();
  try {
    const pending = ctx.window.appAlert({ message: 'First line\nSecond line' });
    assert.deepEqual([...ctx.document.querySelectorAll('.choice-dialog-body p')].map(p => p.textContent), ['First line', 'Second line']);
    key(ctx, 'Enter');
    await pending;
  } finally { ctx.destroy(); }
});
