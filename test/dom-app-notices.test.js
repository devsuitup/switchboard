'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { setupSidebarDom } = require('./dom-setup');

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.setTimeout = setTimeout;
  ctx.window.clearTimeout = clearTimeout;
  ctx.window.Date = Date;
  return ctx;
}

for (const direct of [false, true]) {
  test(`clearing a member removes it from every group${direct ? ' and its direct notice' : ''}`, t => {
    const { window, document } = setup(t);
    if (direct) window.showAppNotice({ id: 'member', kind: 'error', message: 'Direct failure' });
    for (const id of ['first', 'second', 'empty']) {
      window.showAppNotice({ id, kind: 'error', members: [{ id: 'member', text: 'Remove me' }, ...(id === 'empty' ? [] : [{ id: `${id}-other`, text: 'Keep me' }])], message: members => members.map(member => member.text).join('; ') });
    }
    window.clearAppNotice('member');
    assert.equal(document.querySelector('[data-notice-id="member"]'), null);
    assert.equal(document.querySelector('[data-notice-id="empty"]'), null);
    assert.equal(document.querySelectorAll('.app-notice').length, 2);
    for (const notice of document.querySelectorAll('.app-notice')) {
      assert.match(notice.textContent, /Keep me/);
      assert.doesNotMatch(notice.textContent, /Remove me/);
    }
  });
}

test('rebuilding a group preserves its stack position and original return focus', t => {
  const { window, document } = setup(t);
  const original = document.createElement('button');
  const later = document.createElement('button');
  document.body.append(original, later);
  original.focus();
  window.showAppNotice({ id: 'group', kind: 'error', members: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], message: members => members.map(member => member.text).join('; ') });
  window.showAppNotice({ id: 'later', kind: 'error', message: 'Later' });
  later.focus();
  window.clearAppNotice('a');
  assert.deepEqual([...document.querySelectorAll('#app-notices > .app-notice')].map(el => el.dataset.noticeId), ['group', 'later']);
  const dismiss = document.querySelector('[data-notice-id="group"] .app-notice-dismiss');
  dismiss.focus();
  dismiss.click();
  assert.equal(document.activeElement, original);
});

test('updating a group does not recapture return focus from another control', t => {
  const { window, document } = setup(t);
  const original = document.createElement('button');
  const later = document.createElement('button');
  document.body.append(original, later);
  original.focus();
  const options = { id: 'group', kind: 'error', members: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], message: members => members.map(member => member.text).join('; ') };
  window.showAppNotice(options);
  later.focus();
  window.clearAppNotice('a');
  const dismiss = document.querySelector('[data-notice-id="group"] .app-notice-dismiss');
  dismiss.focus();
  dismiss.click();
  assert.equal(document.activeElement, original);
});

test('error notices stay after 20 seconds, announce as alerts and dismiss on request', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'failure', kind: 'error', message: 'Could not stop the session.' });
  t.mock.timers.tick(20_000);
  const notice = document.querySelector('[data-notice-id="failure"]');
  assert.ok(notice);
  assert.equal(notice.getAttribute('role'), 'alert');
  const dismiss = notice.querySelector('button');
  assert.equal(dismiss.getAttribute('aria-label'), 'Dismiss');
  assert.ok(dismiss.classList.contains('app-notice-dismiss'));
  dismiss.click();
  assert.equal(document.querySelector('[data-notice-id="failure"]'), null);
});

test('a persistent progress notice cancels its prior timer and keeps its action until cleared', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'progress', message: 'Starting' });
  t.mock.timers.tick(1_000);
  let cancelled = 0;
  window.showAppNotice({ id: 'progress', message: 'Moving', persistent: true,
    actionLabel: 'Cancel', dismissOnAction: false, onAction: () => { cancelled++; } });
  t.mock.timers.tick(600_000);
  const notice = document.querySelector('[data-notice-id="progress"]');
  assert.ok(notice);
  assert.equal(notice.getAttribute('role'), 'status');
  notice.querySelector('.app-notice-action').click();
  assert.equal(cancelled, 1);
  assert.ok(notice.isConnected);
  window.clearAppNotice('progress');
  assert.equal(notice.isConnected, false);
});

for (const [kind, duration] of [['undo', 10_000], ['info', 15_000]]) {
  for (const interaction of ['focus', 'pointer']) {
    test(`${kind} pauses for ${interaction} and expires after only the remaining time on leave`, t => {
      const { window, document } = setup(t);
      const outside = document.createElement('button');
      document.body.append(outside);
      outside.focus();
      window.showAppNotice({ id: 'pause', kind, message: 'Saved.' });
      const notice = document.querySelector('.app-notice');
      t.mock.timers.tick(4_000);
      if (interaction === 'focus') notice.querySelector('button').focus();
      else notice.dispatchEvent(new window.MouseEvent('mouseenter'));
      t.mock.timers.tick(30_000);
      assert.ok(notice.isConnected);
      if (interaction === 'focus') outside.focus();
      else notice.dispatchEvent(new window.MouseEvent('mouseleave'));
      t.mock.timers.tick(duration - 4_001);
      assert.ok(notice.isConnected);
      t.mock.timers.tick(1);
      assert.equal(notice.isConnected, false);
    });
  }
}

test('leaving hover does not resume a focused notice, including focus moving between its buttons', t => {
  const { window, document } = setup(t);
  const outside = document.createElement('button');
  document.body.append(outside);
  window.showAppNotice({ id: 'overlap', kind: 'undo', message: 'Archived.', actionLabel: 'Undo', onAction() {} });
  const notice = document.querySelector('.app-notice');
  t.mock.timers.tick(3_000);
  notice.dispatchEvent(new window.MouseEvent('mouseenter'));
  notice.querySelector('.app-notice-action').focus();
  notice.dispatchEvent(new window.MouseEvent('mouseleave'));
  t.mock.timers.tick(20_000);
  notice.querySelector('.app-notice-dismiss').focus();
  t.mock.timers.tick(20_000);
  assert.ok(notice.isConnected);
  outside.focus();
  t.mock.timers.tick(6_999);
  assert.ok(notice.isConnected);
  t.mock.timers.tick(1);
  assert.equal(notice.isConnected, false);
});

test('the shipped page keeps an empty polite notice host before loading and after dismissal', t => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const region = dom.window.document.getElementById('app-notices');
  assert.ok(region);
  assert.equal(region.getAttribute('aria-live'), 'polite');
  assert.equal(region.childElementCount, 0);
  assert.ok(html.indexOf('id="app-notices"') < html.indexOf('src="app-notices.js"'));
  const { window, document } = setup(t);
  const persistent = document.getElementById('app-notices');
  assert.ok(persistent);
  assert.equal(persistent.getAttribute('aria-live'), 'polite');
  window.showAppNotice({ id: 'live', message: 'Saved.' });
  assert.equal(persistent.querySelector('.app-notice').getAttribute('role'), 'status');
  window.clearAppNotice('live');
  assert.equal(document.getElementById('app-notices'), persistent);
  assert.equal(persistent.childElementCount, 0);
  assert.equal(persistent.getAttribute('aria-live'), 'polite');
});

for (const selector of ['.app-notice-dismiss', '.app-notice-action']) {
  test(`${selector} preserves pointer focus and restores keyboard focus after removal`, t => {
    const { window, document } = setup(t);
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    let called = 0;
    const show = () => window.showAppNotice({ id: 'focus', kind: 'undo', message: 'Archived.', actionLabel: 'Undo', onAction: () => { called++; } });
    show();
    const pointerButton = document.querySelector(selector);
    const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    pointerButton.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    pointerButton.click();
    assert.equal(document.activeElement, outside);
    show();
    const keyboardButton = document.querySelector(selector);
    keyboardButton.focus();
    keyboardButton.click();
    assert.equal(document.activeElement, outside);
    assert.equal(called, selector === '.app-notice-action' ? 2 : 0);
  });
}

test('caller ids cannot collide with page ids and omitted ids never produce an undefined DOM id', t => {
  const { window, document } = setup(t);
  const sidebar = document.getElementById('sidebar-content');
  for (const id of ['app-notices', 'sidebar-content', 'spaces and # punctuation']) {
    window.showAppNotice({ id, kind: 'error', message: id });
    const notice = [...document.querySelectorAll('.app-notice')].find(el => el.dataset.noticeId === id);
    assert.ok(notice);
    assert.notEqual(notice.id, id);
  }
  window.showAppNotice({ message: 'No caller id' });
  assert.equal(document.querySelector('[id="undefined"]'), null);
  assert.equal(document.getElementById('sidebar-content'), sidebar);
  window.clearAppNotice('app-notices');
  assert.equal(document.querySelectorAll('#app-notices').length, 1);
  assert.equal(document.querySelectorAll('.app-notice').length, 3);
});

test('two ids stack and replacing one id preserves the other notice', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'first', kind: 'error', message: 'First failure' });
  window.showAppNotice({ id: 'second', kind: 'error', message: 'Second failure' });
  window.showAppNotice({ id: 'first', kind: 'error', message: 'Updated failure' });
  assert.equal(document.querySelectorAll('#app-notices > .app-notice').length, 2);
  assert.equal(document.querySelectorAll('[data-notice-id="first"]').length, 1);
  assert.match(document.querySelector('[data-notice-id="first"]').textContent, /Updated failure/);
  assert.match(document.querySelector('[data-notice-id="second"]').textContent, /Second failure/);
});

test('info notices announce as status and expire after 15 seconds', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'info', kind: 'info', message: 'Saved.' });
  assert.equal(document.querySelector('[data-notice-id="info"]').getAttribute('role'), 'status');
  t.mock.timers.tick(14_999);
  assert.ok(document.querySelector('[data-notice-id="info"]'));
  t.mock.timers.tick(1);
  assert.equal(document.querySelector('[data-notice-id="info"]'), null);
});

test('a replaced or cleared notice cannot expire its later replacement', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'same', kind: 'info', message: 'Old' });
  t.mock.timers.tick(5_000);
  window.showAppNotice({ id: 'same', kind: 'error', message: 'New error' });
  t.mock.timers.tick(15_000);
  assert.match(document.querySelector('[data-notice-id="same"]').textContent, /New error/);
  window.clearAppNotice('same');
  assert.equal(document.querySelector('[data-notice-id="same"]'), null);
  window.clearAppNotice('missing');
  window.showAppNotice({ id: 'same', kind: 'info', message: 'Clear this timer' });
  window.clearAppNotice('same');
  t.mock.timers.tick(5_000);
  window.showAppNotice({ id: 'same', kind: 'info', message: 'Later' });
  t.mock.timers.tick(10_000);
  assert.match(document.querySelector('[data-notice-id="same"]').textContent, /Later/);
  t.mock.timers.tick(5_000);
  assert.equal(document.querySelector('[data-notice-id="same"]'), null);
});

test('Undo gives a visible explanation, a keyboard reachable action and a 10 second window', t => {
  const { window, document } = setup(t);
  let undone = 0;
  window.showAppNotice({
    id: 'undo', kind: 'undo', message: 'Conversation archived.',
    actionLabel: 'Undo', onAction: () => { undone++; },
  });
  const notice = document.querySelector('[data-notice-id="undo"]');
  assert.equal(notice.getAttribute('role'), 'status');
  assert.match(notice.textContent, /Conversation archived\./);
  const action = [...notice.querySelectorAll('button')].find(button => button.textContent === 'Undo');
  assert.ok(action);
  assert.equal(action.type, 'button');
  assert.equal(action.tabIndex, 0);
  action.focus();
  assert.equal(document.activeElement, action);
  t.mock.timers.tick(9_999);
  assert.ok(document.querySelector('[data-notice-id="undo"]'));
  action.click();
  action.click();
  assert.equal(undone, 1);
  assert.equal(document.querySelector('[data-notice-id="undo"]'), null);
  window.showAppNotice({ id: 'expiry', kind: 'undo', message: 'Archived.', actionLabel: 'Undo', onAction: () => { undone++; } });
  t.mock.timers.tick(9_999);
  assert.ok(document.querySelector('[data-notice-id="expiry"]'));
  t.mock.timers.tick(1);
  assert.equal(document.querySelector('[data-notice-id="expiry"]'), null);
  assert.equal(undone, 1);
});

test('ordinary notice actions use the supplied label and callback without interpreting message HTML', t => {
  const { window, document } = setup(t);
  let called = 0;
  window.showAppNotice({ id: 'action', kind: 'error', message: '<img src=x onerror=alert(1)>', actionLabel: 'Retry', onAction: () => { called++; } });
  assert.equal(document.querySelector('[data-notice-id="action"] img'), null);
  assert.match(document.querySelector('[data-notice-id="action"]').textContent, /<img/);
  const action = [...document.querySelectorAll('[data-notice-id="action"] button')].find(button => button.textContent === 'Retry');
  action.click();
  assert.equal(called, 1);
  assert.equal(document.querySelector('[data-notice-id="action"]'), null);
});

test('the shipped page loads notices before their sidebar caller', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.includes('<script src="app-notices.js"></script>'));
  assert.ok(html.indexOf('src="app-notices.js"') < html.indexOf('src="sidebar.js"'));
});

test('notices use a bottom-right flex stack and wrap long text within the viewport', t => {
  const { window, document } = setup(t);
  const style = document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  document.head.append(style);
  window.showAppNotice({ id: 'layout', kind: 'error', message: 'Long message '.repeat(100) });
  const stack = window.getComputedStyle(document.querySelector('#app-notices'));
  assert.equal(stack.position, 'fixed');
  assert.equal(stack.bottom, '32px');
  assert.equal(stack.right, '12px');
  assert.equal(stack.display, 'flex');
  assert.equal(stack.flexDirection, 'column');
  assert.notEqual(stack.gap, '0px');
  assert.equal(stack.overflowY, 'auto');
  const message = window.getComputedStyle(document.querySelector('.app-notice-message'));
  assert.equal(message.whiteSpace, 'pre-wrap');
  assert.equal(message.overflowWrap, 'anywhere');
});

test('re-showing a notice under a new action label keeps keyboard focus on its action', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'restore', message: 'Could not reattach.', actionLabel: 'Respawn', onAction() {} });
  document.querySelector('.app-notice-action').focus();
  window.showAppNotice({ id: 'restore', message: 'Respawned, not attached.', actionLabel: 'Attach', onAction() {} });
  assert.equal(document.activeElement.textContent, 'Attach');
});

for (const rebuild of ['replacement', 'member removal']) {
  test('rebuilding a multi-action notice preserves the second action focus on ' + rebuild, t => {
    const { window, document } = setup(t);
    const options = { id: 'ended', message: 'This job has ended.',
      members: [{ id: 'first' }, { id: 'second' }],
      actions: [{ label: 'Respawn', onAction() {} }, { label: 'Open transcript', onAction() {} }] };
    window.showAppNotice(options);
    document.querySelectorAll('.app-notice-action')[1].focus();
    if (rebuild === 'replacement') window.showAppNotice(options);
    else window.clearAppNotice('first');
    assert.equal(document.activeElement.textContent, 'Open transcript', 'focus must stay on the second action');
    assert.equal(document.querySelectorAll('.app-notice').length, 1);
    t.mock.timers.tick(20_000);
    assert.ok(document.querySelector('.app-notice'), 'restored focus must keep expiry paused');
  });
}

test('1023 the kind is set on the notice element', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'e', kind: 'error', message: 'Failed.' });
  window.showAppNotice({ id: 'i', message: 'Saved.' });
  window.showAppNotice({ id: 'u', kind: 'undo', message: 'Archived.', actionLabel: 'Undo', onAction() {} });
  assert.deepEqual([...document.querySelectorAll('.app-notice')].map(notice => notice.dataset.kind), ['error', 'info', 'undo']);
  window.showAppNotice({ id: 'i', kind: 'error', message: 'Now failed.' });
  assert.equal(document.querySelector('[data-notice-id="i"]').dataset.kind, 'error', 'a replacement carries its own kind');
});

test('1023 only an expiring notice carries the drain line, which pauses with the timer', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'info', message: 'Saved.' });
  window.showAppNotice({ id: 'undo', kind: 'undo', message: 'Archived.', actionLabel: 'Undo', onAction() {} });
  window.showAppNotice({ id: 'error', kind: 'error', message: 'Failed.' });
  window.showAppNotice({ id: 'kept', message: 'Moving.', persistent: true });
  const notice = id => document.querySelector(`[data-notice-id="${id}"]`);
  assert.ok(notice('info').querySelector('.app-notice-expiry'));
  assert.equal(notice('info').style.getPropertyValue('--notice-expiry'), '15000ms');
  assert.equal(notice('undo').style.getPropertyValue('--notice-expiry'), '10000ms');
  assert.equal(notice('error').querySelector('.app-notice-expiry'), null, 'an error never expires, so it has no line');
  assert.equal(notice('kept').querySelector('.app-notice-expiry'), null, 'a persistent notice has no line');
  notice('info').dispatchEvent(new window.MouseEvent('mouseenter'));
  assert.equal(notice('info').dataset.paused, 'true');
  notice('info').dispatchEvent(new window.MouseEvent('mouseleave'));
  assert.equal(notice('info').dataset.paused, undefined);
});

test('1023 at most three notices show; older ones fold into a +N more pill that expands them', t => {
  const { window, document } = setup(t);
  for (const id of ['a', 'b', 'c', 'd', 'e']) window.showAppNotice({ id, kind: 'error', message: `Failure ${id}` });
  const visible = () => [...document.querySelectorAll('#app-notices > .app-notice')].filter(el => !el.hidden).map(el => el.dataset.noticeId);
  assert.deepEqual(visible(), ['c', 'd', 'e'], 'the newest three stay visible');
  const pill = document.querySelector('#app-notices > .app-notice-more');
  assert.ok(pill);
  assert.equal(pill.textContent, '+2 more');
  assert.equal(pill.getAttribute('aria-expanded'), 'false');
  window.clearAppNotice('e');
  assert.deepEqual(visible(), ['b', 'c', 'd']);
  assert.equal(document.querySelector('.app-notice-more').textContent, '+1 more');
  document.querySelector('.app-notice-more').click();
  assert.deepEqual(visible(), ['a', 'b', 'c', 'd']);
  assert.equal(document.querySelector('.app-notice-more'), null);
  window.showAppNotice({ id: 'f', kind: 'error', message: 'Failure f' });
  window.showAppNotice({ id: 'g', kind: 'error', message: 'Failure g' });
  assert.equal(visible().length, 6, 'the stack stays expanded while more than three are shown');
  for (const id of ['a', 'b', 'c']) window.clearAppNotice(id);
  assert.deepEqual(visible(), ['d', 'f', 'g']);
  window.showAppNotice({ id: 'h', kind: 'error', message: 'Failure h' });
  assert.deepEqual(visible(), ['f', 'g', 'h'], 'dropping to three folds the stack again');
  assert.equal(document.querySelector('.app-notice-more').textContent, '+1 more');
});

test('1023 the first line is the title, the rest the body, and technical detail is collapsed', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'd', kind: 'error', message: 'Could not stop Nightly audit.\nCheck the connection, then retry.',
    details: members => members.map(member => member.text).join('\n'), members: [{ id: 'm1', text: '8c41f0a2 at /srv' }, { id: 'm2', text: 'ssh: timed out' }],
    actionLabel: 'Retry', onAction() {} });
  const notice = document.querySelector('[data-notice-id="d"]');
  assert.equal(notice.querySelector('.app-notice-title').textContent, 'Could not stop Nightly audit.');
  assert.equal(notice.querySelector('.app-notice-body').textContent, 'Check the connection, then retry.');
  assert.equal(notice.querySelector('.app-notice-message').textContent, 'Could not stop Nightly audit.\nCheck the connection, then retry.',
    'the message text, which is logged, is unchanged');
  const details = notice.querySelector('details.app-notice-details');
  assert.ok(details);
  assert.equal(details.open, false, 'Details starts collapsed');
  assert.equal(details.querySelector('summary').textContent, 'Details');
  assert.equal(details.querySelector('.app-notice-details-body').textContent, '8c41f0a2 at /srv\nssh: timed out');
  assert.equal(notice.querySelector('.app-notice-message').contains(details), false, 'Details is not part of the logged message');
  details.open = true;
  window.clearAppNotice('m2');
  const rebuilt = document.querySelector('[data-notice-id="d"] details.app-notice-details');
  assert.equal(rebuilt.querySelector('.app-notice-details-body').textContent, '8c41f0a2 at /srv');
  assert.equal(rebuilt.open, true, 'a rebuild keeps Details open once the user opened it');
  window.showAppNotice({ id: 'plain', message: 'Saved.' });
  const plain = document.querySelector('[data-notice-id="plain"]');
  assert.equal(plain.querySelector('.app-notice-body'), null);
  assert.equal(plain.querySelector('.app-notice-details'), null);
  assert.equal(plain.querySelector('.app-notice-action'), null);
  assert.equal(plain.querySelector('.app-notice-dismiss').getAttribute('aria-label'), 'Dismiss');
});

test('1023 the first action is primary and the others are secondary', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'multi', message: 'This job has ended.', actions: [{ label: 'Respawn', onAction() {} }, { label: 'Open transcript', onAction() {} }] });
  const actions = [...document.querySelectorAll('.app-notice-action')];
  assert.deepEqual(actions.map(button => button.classList.contains('app-notice-primary')), [true, false]);
});

test('1023 the surviving secondary action now styled primary must keep focus', t => {
  const { window, document } = setup(t);
  const transcript = { label: 'Open transcript', onAction() {} };
  window.showAppNotice({ id: 'ended', message: 'This job has ended.', actions: [{ label: 'Respawn', onAction() {} }, transcript] });
  document.querySelectorAll('.app-notice-action')[1].focus();
  window.showAppNotice({ id: 'ended', message: 'This job has ended.', actions: [transcript] });
  assert.equal(document.activeElement.tagName, 'BUTTON');
  assert.equal(document.activeElement.textContent, 'Open transcript');
  t.mock.timers.tick(20_000);
  assert.ok(document.querySelector('[data-notice-id="ended"]'), 'restored focus keeps expiry paused');
});
