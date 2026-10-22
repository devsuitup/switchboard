// showChoiceDialog (public/choice-dialog.js): a modal with checkboxes whose
// answers may be remembered in localStorage.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom } = require('./dom-setup');

function key(ctx, target, keyName, init = {}) {
  const event = new ctx.window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function open(ctx, overrides = {}) {
  return ctx.window.showChoiceDialog({
    title: 'Archive proj?',
    message: 'The folder is hidden.',
    choices: [
      { id: 'a', label: 'Box A', checked: true, rememberKey: 'k.a' },
      { id: 'b', label: 'Box B', checked: true, rememberKey: 'k.b' },
    ],
    confirmLabel: 'Archive folder',
    ...overrides,
  });
}

const overlay = (ctx) => ctx.document.querySelector('.modal-overlay');
function shown(ctx) {
  const el = overlay(ctx);
  assert.ok(el, 'the dialog must be open');
  return el;
}
const box = (ctx, id) => shown(ctx).querySelector(`input[type="checkbox"][data-choice-id="${id}"]`);
const confirmBtn = (ctx) => shown(ctx).querySelector('.choice-dialog-confirm');
const cancelBtn = (ctx) => shown(ctx).querySelector('.choice-dialog-cancel');

test('secondary action resolves its id on click and Enter while Cancel keeps initial focus', async () => {
  const ctx = setupSidebarDom();
  try {
    for (const keyboard of [false, true]) {
      const pending = open(ctx, { initialFocus: 'cancel', secondaryAction: { id: 'background', label: '<Move>', danger: true } });
      const secondary = shown(ctx).querySelector('.choice-dialog-secondary');
      assert.ok(secondary, 'secondary action must be rendered');
      assert.equal(secondary.textContent, '<Move>');
      assert.equal(secondary.querySelector('move'), null);
      assert.ok(secondary.classList.contains('delete-worktree-confirm-btn'));
      assert.equal(ctx.document.activeElement, cancelBtn(ctx));
      if (keyboard) { secondary.focus(); key(ctx, secondary, 'Enter'); }
      else secondary.click();
      assert.deepEqual({ ...await pending }, { action: 'background' });
    }
  } finally { ctx.destroy(); }
});

test('choice dialog: confirm returns each box and remembers it', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = open(ctx);
    box(ctx, 'b').checked = false;
    confirmBtn(ctx).click();
    assert.deepEqual({ ...(await pending) }, { a: true, b: false });
    assert.equal(ctx.window.localStorage.getItem('k.b'), '0');
    assert.equal(ctx.window.localStorage.getItem('k.a'), '1');
    assert.equal(overlay(ctx), null);
  } finally { ctx.destroy(); }
});

test('choice dialog: a remembered answer is the box\'s initial state', async () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.localStorage.setItem('k.b', '0');
    const pending = open(ctx);
    assert.equal(box(ctx, 'a').checked, true);
    assert.equal(box(ctx, 'b').checked, false);
    cancelBtn(ctx).click();
    await pending;
  } finally { ctx.destroy(); }
});

test('choice dialog: Escape cancels, writes nothing and gives focus back', async () => {
  const ctx = setupSidebarDom();
  try {
    const origin = ctx.document.createElement('button');
    ctx.document.body.appendChild(origin);
    const pending = open(ctx, { returnFocus: origin });
    box(ctx, 'b').checked = false;
    key(ctx, ctx.document.activeElement, 'Escape');
    assert.equal(await pending, null);
    assert.equal(overlay(ctx), null);
    assert.equal(ctx.document.activeElement, origin);
    assert.equal(ctx.window.localStorage.length, 0);
  } finally { ctx.destroy(); }
});

test('choice dialog: Escape does not reach the other keydown listeners', async () => {
  const ctx = setupSidebarDom();
  try {
    let reached = 0;
    ctx.document.addEventListener('keydown', () => { reached++; });
    const pending = open(ctx);
    key(ctx, ctx.document.activeElement, 'Escape');
    assert.equal(await pending, null);
    assert.equal(reached, 0);
  } finally { ctx.destroy(); }
});

test('choice dialog: text is never parsed as markup', async () => {
  const ctx = setupSidebarDom();
  try {
    const img = '<img src="x" onerror="window.__pwned = 1">';
    const pending = open(ctx, {
      title: img, message: [img],
      choices: [{ id: 'a', label: img, checked: true }],
      confirmLabel: img, cancelLabel: img,
    });
    assert.equal(shown(ctx).querySelectorAll('img').length, 0);
    assert.ok(shown(ctx).textContent.includes('<img'), 'the text must be shown as typed');
    cancelBtn(ctx).click();
    await pending;
  } finally { ctx.destroy(); }
});

test('choice dialog: Tab from the last control wraps to the first, Shift+Tab back', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = open(ctx);
    const controls = [...shown(ctx).querySelectorAll('button, input')];
    controls[controls.length - 1].focus();
    key(ctx, ctx.document.activeElement, 'Tab');
    assert.equal(ctx.document.activeElement, controls[0]);
    key(ctx, ctx.document.activeElement, 'Tab', { shiftKey: true });
    assert.equal(ctx.document.activeElement, controls[controls.length - 1]);
    cancelBtn(ctx).click();
    await pending;
  } finally { ctx.destroy(); }
});

test('choice dialog: a box without rememberKey neither reads nor writes localStorage', async () => {
  const ctx = setupSidebarDom();
  try {
    const choices = [{ id: 'c', label: 'Box C', checked: true }];
    const first = open(ctx, { choices });
    box(ctx, 'c').checked = false;
    confirmBtn(ctx).click();
    assert.deepEqual({ ...(await first) }, { c: false });
    assert.equal(ctx.window.localStorage.length, 0);

    ctx.window.localStorage.setItem('c', '0');
    const second = open(ctx, { choices });
    assert.equal(box(ctx, 'c').checked, true);
    cancelBtn(ctx).click();
    await second;
  } finally { ctx.destroy(); }
});

test('choice dialog: Enter on Cancel cancels', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = open(ctx);
    cancelBtn(ctx).focus();
    key(ctx, cancelBtn(ctx), 'Enter');
    assert.equal(await pending, null);
    assert.equal(ctx.window.localStorage.length, 0);
  } finally { ctx.destroy(); }
});

test('choice dialog: Enter on a box does nothing, Enter elsewhere in the dialog confirms', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = open(ctx);
    key(ctx, box(ctx, 'a'), 'Enter');
    assert.ok(overlay(ctx), 'Enter on a box must leave the dialog open');
    assert.equal(box(ctx, 'a').checked, true);
    key(ctx, shown(ctx).querySelector('.modal-dialog'), 'Enter');
    assert.deepEqual({ ...(await pending) }, { a: true, b: true });
  } finally { ctx.destroy(); }
});

test('choice dialog: initialFocus and danger', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = open(ctx, { initialFocus: 'cancel', danger: true });
    assert.equal(ctx.document.activeElement, cancelBtn(ctx));
    assert.ok(confirmBtn(ctx).classList.contains('delete-worktree-confirm-btn'));
    cancelBtn(ctx).click();
    await pending;

    const plain = open(ctx);
    assert.equal(ctx.document.activeElement, confirmBtn(ctx));
    assert.ok(!confirmBtn(ctx).classList.contains('delete-worktree-confirm-btn'));
    cancelBtn(ctx).click();
    await plain;
  } finally { ctx.destroy(); }
});

test('choice dialog: one paragraph per message line', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = open(ctx, { message: ['l1', 'l2'] });
    const paragraphs = [...shown(ctx).querySelectorAll('p')].map(p => p.textContent);
    assert.deepEqual(paragraphs, ['l1', 'l2']);
    cancelBtn(ctx).click();
    await pending;
  } finally { ctx.destroy(); }
});

test('choice dialog: a second call waits until the first closes', async () => {
  const ctx = setupSidebarDom();
  try {
    const first = open(ctx);
    let secondSettled = false;
    const second = open(ctx, { title: 'Second dialog' }).then(value => { secondSettled = true; return value; });
    await Promise.resolve();
    assert.equal(secondSettled, false, 'the queued call must remain pending');
    assert.equal(ctx.document.querySelectorAll('.modal-overlay').length, 1);
    confirmBtn(ctx).click();
    assert.deepEqual({ ...(await first) }, { a: true, b: true });
    assert.equal(shown(ctx).querySelector('h2').textContent, 'Second dialog');
    assert.equal(secondSettled, false, 'opening the queued dialog must not settle it');
    cancelBtn(ctx).click();
    assert.equal(await second, null);
    assert.equal(overlay(ctx), null);
  } finally { ctx.destroy(); }
});

for (const keyName of ['Escape', 'Tab']) {
  test(`choice dialog: ${keyName} works after focus drifts to the body`, async () => {
    const ctx = setupSidebarDom();
    try {
      const pending = open(ctx);
      ctx.document.activeElement.blur();
      assert.equal(ctx.document.activeElement, ctx.document.body);
      const event = key(ctx, ctx.document.body, keyName);
      assert.equal(event.defaultPrevented, true);
      if (keyName === 'Escape') assert.equal(await pending, null);
      else {
        assert.equal(ctx.document.activeElement, shown(ctx).querySelector('button'));
        cancelBtn(ctx).click();
        assert.equal(await pending, null);
      }
    } finally { ctx.destroy(); }
  });
}

test('choice dialog: only the topmost overlay handles keys from the body', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = open(ctx);
    const foreground = ctx.document.createElement('div');
    foreground.className = 'choice-dialog-overlay';
    ctx.document.body.append(foreground);
    const unregister = ctx.window.registerModal({ overlay: foreground, cancel: () => { foreground.remove(); unregister(); } });
    key(ctx, ctx.document.body, 'Escape');
    assert.equal(ctx.document.querySelectorAll('.choice-dialog-overlay').length, 1);
    assert.ok(overlay(ctx), 'only the registered topmost modal closes');
    key(ctx, ctx.document.body, 'Escape');
    assert.equal(ctx.document.querySelector('.choice-dialog-overlay'), null);
    assert.equal(await pending, null);
  } finally { ctx.destroy(); }
});

test('choice dialog: Enter on a danger dialog container waits for a focused button', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = open(ctx, { danger: true, initialFocus: 'cancel' });
    const dialog = shown(ctx).querySelector('.choice-dialog');
    dialog.focus();
    key(ctx, dialog, 'Enter');
    assert.ok(overlay(ctx), 'container Enter must not accept a dangerous action');
    assert.equal(ctx.window.localStorage.length, 0);
    confirmBtn(ctx).focus();
    key(ctx, ctx.document.activeElement, 'Enter');
    assert.deepEqual({ ...(await pending) }, { a: true, b: true });
  } finally { ctx.destroy(); }
});

test('choice dialog: the close button and a click on the overlay cancel', async () => {
  const ctx = setupSidebarDom();
  try {
    const first = open(ctx);
    shown(ctx).querySelector('.choice-dialog-close').click();
    assert.equal(await first, null);

    const second = open(ctx);
    shown(ctx).dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
    assert.equal(await second, null);
    assert.equal(overlay(ctx), null);
  } finally { ctx.destroy(); }
});

test('choice dialog: once closed, Escape and Tab reach the rest of the app again', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = open(ctx);
    cancelBtn(ctx).click();
    await pending;
    const seen = [];
    ctx.document.addEventListener('keydown', (e) => seen.push(e.key));
    const esc = key(ctx, ctx.document.body, 'Escape');
    const tab = key(ctx, ctx.document.body, 'Tab');
    assert.deepEqual(seen, ['Escape', 'Tab']);
    assert.equal(esc.defaultPrevented, false);
    assert.equal(tab.defaultPrevented, false);
  } finally { ctx.destroy(); }
});

test('choice dialog: a click on a box keeps the dialog open', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = open(ctx);
    box(ctx, 'a').click();
    assert.ok(overlay(ctx), 'the dialog must stay open');
    assert.equal(box(ctx, 'a').checked, false);
    confirmBtn(ctx).click();
    assert.deepEqual({ ...(await pending) }, { a: false, b: true });
  } finally { ctx.destroy(); }
});

test('choice dialog: Enter outside the dialog does nothing', async () => {
  const ctx = setupSidebarDom();
  try {
    const outside = ctx.document.createElement('input');
    ctx.document.body.appendChild(outside);
    const pending = open(ctx);
    const event = key(ctx, outside, 'Enter');
    assert.ok(overlay(ctx), 'the dialog must stay open');
    assert.equal(event.defaultPrevented, true);
    cancelBtn(ctx).click();
    assert.equal(await pending, null);
  } finally { ctx.destroy(); }
});

test('choice dialog: closeWith closes it with its value, and does nothing once the user has answered', async () => {
  const ctx = setupSidebarDom();
  try {
    let settle;
    const pending = open(ctx, { closeWith: new Promise((r) => { settle = r; }) });
    settle({ a: true });
    assert.deepEqual(await pending, { a: true });
    assert.equal(overlay(ctx), null);

    const before = ctx.document.createElement('button');
    ctx.document.body.appendChild(before);
    before.focus();
    let late;
    const answered = open(ctx, { closeWith: new Promise((r) => { late = r; }), returnFocus: before });
    cancelBtn(ctx).click();
    assert.equal(await answered, null);
    const elsewhere = ctx.document.createElement('button');
    ctx.document.body.appendChild(elsewhere);
    elsewhere.focus();
    late({});
    await new Promise((r) => setTimeout(r));
    assert.equal(ctx.document.activeElement, elsewhere, 'the focus is not taken back a second time');
  } finally { ctx.destroy(); }
});

test('choice dialog: replace cancels the open one and goes ahead of the queue; Escape on it gives the focus back', async () => {
  const ctx = setupSidebarDom();
  try {
    const origin = ctx.document.createElement('button');
    ctx.document.body.appendChild(origin);
    origin.focus();
    const first = open(ctx, { title: 'First' });
    const queued = open(ctx, { title: 'Queued' });
    const closing = open(ctx, { title: 'Close?', replace: true, initialFocus: 'cancel', returnFocus: origin });
    assert.equal(await first, null, 'the open dialog is cancelled');
    await new Promise((r) => setTimeout(r));
    assert.equal(ctx.document.querySelectorAll('.choice-dialog-overlay').length, 1);
    assert.equal(shown(ctx).querySelector('#choice-dialog-title').textContent, 'Close?', 'it is not behind the queued one');
    assert.equal(ctx.document.activeElement, cancelBtn(ctx));
    key(ctx, ctx.document.activeElement, 'Escape');
    assert.equal(await closing, null);
    await new Promise((r) => setTimeout(r));
    assert.equal(shown(ctx).querySelector('#choice-dialog-title').textContent, 'Queued', 'the queue resumes');
    key(ctx, ctx.document.activeElement, 'Escape');
    assert.equal(await queued, null);
    assert.equal(ctx.window.hasOpenModal(), false, 'every path unregistered from the modal stack');
    assert.equal(ctx.document.activeElement, origin);
  } finally { ctx.destroy(); }
});

test('choice dialog: closeWith closes a replaced-in dialog and leaves the modal stack empty', async () => {
  const ctx = setupSidebarDom();
  try {
    let settle;
    const pending = open(ctx, { replace: true, closeWith: new Promise((r) => { settle = r; }) });
    assert.equal(ctx.window.hasOpenModal(), true);
    settle({});
    assert.deepEqual(await pending, {});
    assert.equal(ctx.window.hasOpenModal(), false);
  } finally { ctx.destroy(); }
});
