const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

for (const target of ['detail', 'row padding']) {
  test(`C2: clicking the option ${target} selects it before Enter`, async () => {
    const ctx = setupSidebarDom();
    try {
      const pending = ctx.window.appChoose({ options, selectedId: 'b' });
      const input = radio(ctx, 'c');
      const row = input.closest('.choice-dialog-choice');
      (target === 'detail' ? row.querySelector('.choice-dialog-detail') : row).click();
      assert.equal(input.checked, true);
      assert.equal(radio(ctx, 'b').checked, false);
      key(ctx, 'Enter');
      assert.deepEqual({ ...await pending }, { choice: 'c' });
    } finally { ctx.destroy(); }
  });
}

test('C2: clicking an option label activates its radio exactly once', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = ctx.window.appChoose({ options, selectedId: 'b' });
    const input = radio(ctx, 'c');
    let clicks = 0;
    let changes = 0;
    input.addEventListener('click', () => clicks++);
    input.addEventListener('change', () => changes++);
    input.labels[0].click();
    assert.equal(input.checked, true);
    assert.equal(radio(ctx, 'b').checked, false);
    assert.equal(clicks, 1);
    assert.equal(changes, 1);
    key(ctx, 'Enter');
    assert.deepEqual({ ...await pending }, { choice: 'c' });
  } finally { ctx.destroy(); }
});

test('C4: clicking a disabled option row does nothing and uses a default cursor', async (t) => {
  const ctx = setupSidebarDom();
  try {
    const style = ctx.document.createElement('style');
    style.textContent = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
    ctx.document.head.append(style);
    const pending = ctx.window.appChoose({ options: [...options, { id: 'd', label: 'Unavailable', detail: 'Details D', disabled: true }], selectedId: 'b' });
    const input = radio(ctx, 'd');
    const click = t.mock.method(input, 'click');
    const row = input.closest('.choice-dialog-choice');
    assert.equal(ctx.window.getComputedStyle(row).cursor, 'default');
    assert.equal(ctx.window.getComputedStyle(radio(ctx, 'b').closest('.choice-dialog-choice')).cursor, 'pointer');
    row.click();
    row.querySelector('.choice-dialog-detail').click();
    assert.equal(click.mock.callCount(), 0);
    assert.equal(input.checked, false);
    assert.equal(radio(ctx, 'b').checked, true);
    key(ctx, 'Enter');
    assert.deepEqual({ ...await pending }, { choice: 'b' });
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
    const description = ctx.document.getElementById(radio(ctx, 'd').getAttribute('aria-describedby'));
    assert.equal(description?.textContent, 'Cannot attach');
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

for (const shiftKey of [false, true]) {
  test(`C5: ${shiftKey ? 'Shift+Tab' : 'Tab'} leaves a focused unchecked radio omitted from the group stop`, () => {
    const ctx = setupSidebarDom();
    try {
      const overlay = ctx.document.createElement('div');
      overlay.innerHTML = '<button>S</button><input type="radio" name="g"><input type="radio" name="g"><input type="radio" name="g"><button>E</button>';
      ctx.document.body.append(overlay);
      const [start, , middle, , end] = overlay.children;
      const unregister = ctx.window.registerModal({ overlay, cancel() {} });
      middle.focus();
      assert.equal(overlay.querySelector(':checked'), null);
      key(ctx, 'Tab', shiftKey);
      assert.equal(ctx.document.activeElement, shiftKey ? start : end);
      unregister();
    } finally { ctx.destroy(); }
  });
}

test('C5: Shift+Tab enters an unchecked group at its last enabled visible radio', () => {
  const ctx = setupSidebarDom();
  try {
    const overlay = ctx.document.createElement('div');
    overlay.innerHTML = '<button>S</button><input type="radio" name="g"><input type="radio" name="g"><input type="radio" name="g"><input type="radio" name="g" hidden><input type="radio" name="g" disabled><button>E</button>';
    ctx.document.body.append(overlay);
    const [start, first, , last, , , end] = overlay.children;
    const unregister = ctx.window.registerModal({ overlay, cancel() {} });
    end.focus();
    key(ctx, 'Tab', true);
    assert.equal(ctx.document.activeElement, last);
    key(ctx, 'Tab', true);
    assert.equal(ctx.document.activeElement, start);
    key(ctx, 'Tab');
    assert.equal(ctx.document.activeElement, first);
    unregister();
  } finally { ctx.destroy(); }
});

test('C4: a radio uses only its label as its native accessible name', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = ctx.window.appChoose({ options: [
      { id: 'a', label: 'Available', detail: 'Details A' },
      { id: 'd', label: 'Unavailable', detail: 'Details D', disabled: true, disabledReason: 'Cannot attach' },
    ] });
    for (const [id, name] of [['a', 'Available'], ['d', 'Unavailable']]) {
      const input = radio(ctx, id);
      assert.equal(input.labels.length, 1);
      assert.equal(input.labels[0].textContent, name);
      assert.equal(input.getAttribute('aria-label'), null);
      assert.equal(input.getAttribute('aria-labelledby'), null);
    }
    key(ctx, 'Escape');
    await pending;
  } finally { ctx.destroy(); }
});

test('C4: radio descriptions link to unique literal details and disabled reasons', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = ctx.window.appChoose({ options: [
      { id: 'a', label: 'Available', detail: '<b>Details</b>' },
      { id: 'd', label: 'Unavailable', detail: 'Details', disabled: true, disabledReason: '<img src=x>' },
    ] });
    const ids = [];
    for (const [id, expected] of [['a', '<b>Details</b>'], ['d', 'Details · <img src=x>']]) {
      const descriptionId = radio(ctx, id).getAttribute('aria-describedby');
      assert.ok(descriptionId);
      ids.push(descriptionId);
      const detail = ctx.document.getElementById(descriptionId);
      assert.equal(detail?.textContent, expected);
      assert.equal(detail.closest('label'), null);
      assert.equal(ctx.document.querySelectorAll(`[id="${descriptionId}"]`).length, 1);
    }
    assert.notEqual(ids[0], ids[1]);
    assert.equal(ctx.document.querySelector('img, b'), null);
    key(ctx, 'Escape');
    await pending;
  } finally { ctx.destroy(); }
});

test('C4: an enabled option with only a disabled reason has no empty detail element', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = ctx.window.appChoose({ options: [{ id: 'a', label: 'Available', disabledReason: 'Unused reason' }] });
    assert.equal(ctx.document.querySelector('.choice-dialog-detail'), null);
    assert.equal(radio(ctx, 'a').hasAttribute('aria-describedby'), false);
    key(ctx, 'Escape');
    await pending;
  } finally { ctx.destroy(); }
});
