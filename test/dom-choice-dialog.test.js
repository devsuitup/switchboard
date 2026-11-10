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

function planRequests() {
  const requests = [];
  const onChange = values => new Promise((resolve, reject) => {
    requests.push({ values: { ...values }, resolve, reject });
  });
  return { requests, onChange };
}

const flushPlans = () => new Promise(resolve => setImmediate(resolve));

test('choice plan: restored answers request an initial plan and block click and Enter until ready', async () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.localStorage.setItem('k.b', '0');
    const { requests, onChange } = planRequests();
    const pending = open(ctx, { onChange });
    assert.equal(confirmBtn(ctx).disabled, true, 'Confirm must be disabled during initial planning');
    assert.equal(ctx.document.activeElement, cancelBtn(ctx));
    assert.deepEqual(requests[0].values, { a: true, b: false });
    confirmBtn(ctx).click();
    confirmBtn(ctx).dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
    key(ctx, shown(ctx).querySelector('.modal-dialog'), 'Enter');
    assert.ok(overlay(ctx), 'pending planning cannot be accepted by any activation path');
    assert.equal(ctx.window.localStorage.getItem('k.a'), null);
    const plan = { token: 'initial' };
    requests[0].resolve(plan);
    await flushPlans();
    assert.equal(confirmBtn(ctx).disabled, false);
    confirmBtn(ctx).click();
    assert.deepEqual({ ...await pending }, { a: true, b: false, plan });
    assert.equal(ctx.window.localStorage.getItem('k.a'), '1');
  } finally { ctx.destroy(); }
});

test('choice plan: an older response cannot enable Confirm while the current request is pending', async () => {
  const ctx = setupSidebarDom();
  try {
    const { requests, onChange } = planRequests();
    const pending = open(ctx, { onChange });
    box(ctx, 'a').click();
    assert.equal(requests.length, 2, 'each changed selection must request a new plan');
    requests[0].resolve({ token: 'stale' });
    await flushPlans();
    assert.equal(confirmBtn(ctx).disabled, true, 'an obsolete plan must not enable Confirm');
    key(ctx, shown(ctx).querySelector('.modal-dialog'), 'Enter');
    assert.ok(overlay(ctx));
    const plan = { token: 'current' };
    requests[1].resolve(plan);
    await flushPlans();
    confirmBtn(ctx).click();
    assert.deepEqual({ ...await pending }, { a: false, b: true, plan });
  } finally { ctx.destroy(); }
});

test('choice plan: late success or failure cannot replace a current ready plan', async () => {
  const ctx = setupSidebarDom();
  try {
    for (const rejected of [false, true]) {
      ctx.window.localStorage.clear();
      const { requests, onChange } = planRequests();
      const pending = open(ctx, { onChange });
      box(ctx, 'a').click();
      assert.equal(requests.length, 2, 'both choice snapshots must be planned');
      const plan = { token: 'latest' };
      requests[1].resolve(plan);
      await flushPlans();
      if (rejected) requests[0].reject(new Error('obsolete failure'));
      else requests[0].resolve({ token: 'obsolete' });
      await flushPlans();
      assert.equal(confirmBtn(ctx).disabled, false);
      assert.equal(shown(ctx).querySelector('[role="alert"]').hidden, true);
      confirmBtn(ctx).click();
      assert.deepEqual({ ...await pending }, { a: false, b: true, plan });
    }
  } finally { ctx.destroy(); }
});

test('choice plan: returning to the same answers still requires the newest request', async () => {
  const ctx = setupSidebarDom();
  try {
    const { requests, onChange } = planRequests();
    const pending = open(ctx, { onChange });
    box(ctx, 'a').click();
    box(ctx, 'a').click();
    assert.equal(requests.length, 3, 'each change, including a return to old answers, must refresh');
    requests[0].resolve({ token: 'same-answers-old-request' });
    requests[1].resolve({ token: 'different-answers' });
    await flushPlans();
    assert.equal(confirmBtn(ctx).disabled, true);
    const plan = { token: 'newest' };
    requests[2].resolve(plan);
    await flushPlans();
    confirmBtn(ctx).click();
    assert.deepEqual({ ...await pending }, { a: true, b: true, plan });
  } finally { ctx.destroy(); }
});

test('choice plan: failed refresh clears the old plan, shows literal error and allows retry', async () => {
  const ctx = setupSidebarDom();
  try {
    const { requests, onChange } = planRequests();
    const pending = open(ctx, { onChange });
    assert.equal(requests.length, 1, 'opening must request a plan');
    requests[0].resolve({ token: 'before-change' });
    await flushPlans();
    box(ctx, 'b').click();
    requests[1].reject(new Error('<img src=x> refresh failed'));
    await flushPlans();
    assert.equal(confirmBtn(ctx).disabled, true);
    assert.equal(cancelBtn(ctx).disabled, false);
    const error = shown(ctx).querySelector('[role="alert"]');
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, '<img src=x> refresh failed');
    assert.equal(error.querySelector('img'), null);
    confirmBtn(ctx).dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
    key(ctx, shown(ctx).querySelector('.modal-dialog'), 'Enter');
    assert.ok(overlay(ctx), 'failed refresh must not accept the previous token');
    assert.equal(ctx.window.localStorage.length, 0);
    box(ctx, 'b').click();
    assert.equal(error.hidden, true);
    const plan = { token: 'retry' };
    requests[2].resolve(plan);
    await flushPlans();
    confirmBtn(ctx).click();
    assert.deepEqual({ ...await pending }, { a: true, b: true, plan });
  } finally { ctx.destroy(); }
});

test('choice plan: synchronous hook errors leave Cancel usable', async () => {
  const ctx = setupSidebarDom();
  try {
    const pending = open(ctx, { onChange: () => { throw new Error('Planning unavailable'); } });
    assert.equal(confirmBtn(ctx).disabled, true, 'synchronous planning failure must disable Confirm');
    assert.equal(shown(ctx).querySelector('[role="alert"]').textContent, 'Planning unavailable');
    key(ctx, cancelBtn(ctx), 'Enter');
    assert.equal(await pending, null);
    assert.equal(ctx.window.localStorage.length, 0);
  } finally { ctx.destroy(); }
});

test('choice plan: cancellation ignores late responses and leaves the next queued question alone', async () => {
  const ctx = setupSidebarDom();
  try {
    for (const rejected of [false, true]) {
      const { requests, onChange } = planRequests();
      const pending = open(ctx, { onChange });
      assert.equal(requests.length, 1, 'initial plan must be requested');
      const next = open(ctx, { title: 'Next' });
      key(ctx, ctx.document.body, 'Escape');
      assert.equal(await pending, null);
      assert.equal(ctx.window.localStorage.length, 0);
      if (rejected) requests[0].reject(new Error('after cancellation'));
      else requests[0].resolve({ token: 'after cancellation' });
      await flushPlans();
      assert.equal(shown(ctx).querySelector('h2').textContent, 'Next');
      assert.equal(confirmBtn(ctx).disabled, false);
      cancelBtn(ctx).click();
      assert.equal(await next, null);
    }
  } finally { ctx.destroy(); }
});

test('choice plan: a response for values changed without an event cannot be accepted', async () => {
  const ctx = setupSidebarDom();
  try {
    const { requests, onChange } = planRequests();
    const pending = open(ctx, { onChange });
    assert.equal(requests.length, 1, 'initial plan must be requested');
    box(ctx, 'a').checked = false;
    requests[0].resolve({ token: 'wrong-answers' });
    await flushPlans();
    assert.equal(confirmBtn(ctx).disabled, true, 'only a response matching the live answers may be installed');
    box(ctx, 'a').dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
    const plan = { token: 'matching' };
    requests[1].resolve(plan);
    await flushPlans();
    box(ctx, 'b').checked = false;
    confirmBtn(ctx).click();
    assert.ok(overlay(ctx), 'acceptance must recheck the plan against the live answers');
    assert.equal(ctx.window.localStorage.length, 0);
    cancelBtn(ctx).click();
    assert.equal(await pending, null);
  } finally { ctx.destroy(); }
});

test('choice plan: radio changes refresh the plan and an empty enabled group stays blocked', async () => {
  const ctx = setupSidebarDom();
  try {
    const { requests, onChange } = planRequests();
    const options = [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }];
    const pending = open(ctx, { options, onChange });
    assert.equal(requests.length, 1, 'radio selection must be included in initial planning');
    assert.deepEqual(requests[0].values, { choice: 'one', a: true, b: true });
    shown(ctx).querySelector('input[type="radio"][data-choice-id="two"]').click();
    assert.equal(requests.length, 2);
    const plan = { token: 'two' };
    requests[1].resolve(plan);
    await flushPlans();
    confirmBtn(ctx).click();
    assert.deepEqual({ ...await pending }, { choice: 'two', a: true, b: true, plan });
    requests[0].resolve({ token: 'closed' });
    await flushPlans();
    const blocked = open(ctx, { options: options.map(option => ({ ...option, disabled: true })), onChange });
    requests[2].resolve({ token: 'no-enabled-option' });
    await flushPlans();
    assert.equal(confirmBtn(ctx).disabled, true);
    key(ctx, shown(ctx).querySelector('.modal-dialog'), 'Enter');
    assert.ok(overlay(ctx));
    cancelBtn(ctx).click();
    assert.equal(await blocked, null);
  } finally { ctx.destroy(); }
});

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
