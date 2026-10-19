const test = require('node:test');
const assert = require('node:assert/strict');
const { ESLint } = require('eslint');
const { setupSidebarDom } = require('./dom-setup');

const options = ['a', 'b', 'c'].map(id => ({ id, label: `Part ${id}`, detail: `Details ${id}` }));
const radio = (ctx, id) => ctx.document.querySelector(`input[type="radio"][data-choice-id="${id}"]`);
const button = (ctx, name) => ctx.document.querySelector(`.choice-dialog-${name}`);
function key(ctx, name, shiftKey = false) {
  const event = new ctx.window.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true });
  ctx.document.activeElement.dispatchEvent(event);
  return event;
}

test('C1: selectedId is checked and Enter accepts it with Open focused', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = ctx.window.showChoiceDialog({ options, selectedId: 'b', confirmLabel: 'Open' });
    assert.ok(radio(ctx, 'b')?.checked);
    assert.equal(ctx.document.activeElement, button(ctx, 'confirm'));
    key(ctx, 'Enter');
    assert.deepEqual({ ...await pending }, { choice: 'b' });
  } finally { ctx.destroy(); }
});

test('C2: appChoose returns the radio clicked after preselection and preserves literal text', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = ctx.window.appChoose({ options: [...options, { id: 'x', label: '<img src=x>', detail: '<b>detail</b>' }], selectedId: 'b', message: 'One\nTwo' });
    assert.equal(ctx.document.querySelector('img, b'), null);
    assert.ok(ctx.document.querySelector('.choice-dialog-body').textContent.includes('<b>detail</b>'));
    assert.deepEqual([...ctx.document.querySelectorAll('p')].map(p => p.textContent), ['One', 'Two']);
    radio(ctx, 'c').click();
    assert.equal(radio(ctx, 'b').checked, false);
    radio(ctx, 'c').focus();
    key(ctx, 'Enter');
    assert.deepEqual({ ...await pending }, { choice: 'c' });
  } finally { ctx.destroy(); }
});

test('C3: appChoose Escape cancels a selection and restores the opener', async () => {
  const ctx = setupSidebarDom();
  try {
    const opener = ctx.document.createElement('button');
    ctx.document.body.append(opener);
    opener.focus();
    const pending = ctx.window.appChoose({ options, selectedId: 'b' });
    key(ctx, 'Escape');
    assert.equal(await pending, null);
    assert.equal(ctx.document.activeElement, opener);
  } finally { ctx.destroy(); }
});

test('C4: a disabled option exposes its reason and cannot replace the selection', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = ctx.window.appChoose({ options: [...options, { id: 'd', label: 'Unavailable', disabled: true, disabledReason: 'Cannot attach' }], selectedId: 'b' });
    assert.ok(radio(ctx, 'd').disabled);
    assert.ok(radio(ctx, 'd').closest('label').textContent.includes('Cannot attach'));
    radio(ctx, 'd').click();
    key(ctx, 'Enter');
    assert.deepEqual({ ...await pending }, { choice: 'b' });
  } finally { ctx.destroy(); }
});

for (const selectedId of ['disabled', 'missing']) {
  test(`C4: ${selectedId} preselection falls back to the first enabled option`, async () => {
    const ctx = setupSidebarDom();
    try {
      const pending = ctx.window.appChoose({ options: [{ id: 'disabled', label: 'Disabled', disabled: true }, ...options], selectedId });
      assert.ok(radio(ctx, 'a').checked);
      key(ctx, 'Enter');
      assert.deepEqual({ ...await pending }, { choice: 'a' });
    } finally { ctx.destroy(); }
  });
}

test('C4: no enabled option prevents acceptance and still permits cancellation', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = ctx.window.appChoose({ options: [{ id: 'd', label: 'Disabled', disabled: true }], selectedId: 'd' });
    assert.ok(button(ctx, 'confirm').disabled);
    ctx.document.querySelector('.choice-dialog').focus();
    key(ctx, 'Enter');
    assert.ok(ctx.document.querySelector('.choice-dialog-overlay'));
    key(ctx, 'Escape');
    assert.equal(await pending, null);
  } finally { ctx.destroy(); }
});

test('C5: Tab leaves the checked radio for Cancel and Shift+Tab returns to it', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = ctx.window.appChoose({ options, selectedId: 'b' });
    radio(ctx, 'b').focus();
    assert.equal(key(ctx, 'ArrowRight').defaultPrevented, false);
    key(ctx, 'Tab');
    assert.equal(ctx.document.activeElement, button(ctx, 'cancel'));
    key(ctx, 'Tab', true);
    assert.equal(ctx.document.activeElement, radio(ctx, 'b'));
    key(ctx, 'Escape');
    await pending;
  } finally { ctx.destroy(); }
});

test('C5: each radio group contributes its checked or first enabled visible control', () => {
  const ctx = setupSidebarDom();
  try {
    const overlay = ctx.document.createElement('div');
    overlay.innerHTML = '<button>Start</button><input type="radio" name="one" disabled checked><input type="radio" name="one" hidden><input type="radio" name="one"><input type="radio" name="one"><input type="radio" name="two"><input type="radio" name="two" checked><input type="radio"><input type="radio"><button>End</button>';
    ctx.document.body.append(overlay);
    const controls = [...overlay.children];
    const unregister = ctx.window.registerModal({ overlay, cancel() {} });
    controls[0].focus();
    for (const expected of [3, 6, 7, 8, 9]) {
      key(ctx, 'Tab');
      assert.equal(ctx.document.activeElement, controls[expected]);
    }
    unregister();
  } finally { ctx.destroy(); }
});

test('C6: renderer ESLint accepts appChoose at a caller boundary', async () => {
  const lint = new ESLint();
  const [result] = await lint.lintText('appChoose({ options: [] });', { filePath: 'public/choose-fixture.js' });
  assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
});
