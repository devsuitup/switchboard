'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupSidebarDom } = require('./dom-setup');

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.setTimeout = setTimeout;
  ctx.window.clearTimeout = clearTimeout;
  return ctx;
}

test('error notices stay after 20 seconds, announce as alerts and dismiss on request', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'failure', kind: 'error', message: 'Could not stop the session.' });
  t.mock.timers.tick(20_000);
  const notice = document.querySelector('#failure');
  assert.ok(notice);
  assert.equal(notice.getAttribute('role'), 'alert');
  const dismiss = notice.querySelector('button');
  assert.equal(dismiss.textContent, 'Dismiss');
  dismiss.click();
  assert.equal(document.querySelector('#failure'), null);
});

test('two ids stack and replacing one id preserves the other notice', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'first', kind: 'error', message: 'First failure' });
  window.showAppNotice({ id: 'second', kind: 'error', message: 'Second failure' });
  window.showAppNotice({ id: 'first', kind: 'error', message: 'Updated failure' });
  assert.equal(document.querySelectorAll('#app-notices > .app-notice').length, 2);
  assert.equal(document.querySelectorAll('#first').length, 1);
  assert.match(document.querySelector('#first').textContent, /Updated failure/);
  assert.match(document.querySelector('#second').textContent, /Second failure/);
});

test('info notices announce as status and expire after 15 seconds', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'info', kind: 'info', message: 'Saved.' });
  assert.equal(document.querySelector('#info').getAttribute('role'), 'status');
  t.mock.timers.tick(14_999);
  assert.ok(document.querySelector('#info'));
  t.mock.timers.tick(1);
  assert.equal(document.querySelector('#info'), null);
});

test('a replaced or cleared notice cannot expire its later replacement', t => {
  const { window, document } = setup(t);
  window.showAppNotice({ id: 'same', kind: 'info', message: 'Old' });
  t.mock.timers.tick(5_000);
  window.showAppNotice({ id: 'same', kind: 'error', message: 'New error' });
  t.mock.timers.tick(15_000);
  assert.match(document.querySelector('#same').textContent, /New error/);
  window.clearAppNotice('same');
  assert.equal(document.querySelector('#same'), null);
  window.clearAppNotice('missing');
  window.showAppNotice({ id: 'same', kind: 'info', message: 'Clear this timer' });
  window.clearAppNotice('same');
  t.mock.timers.tick(5_000);
  window.showAppNotice({ id: 'same', kind: 'info', message: 'Later' });
  t.mock.timers.tick(10_000);
  assert.match(document.querySelector('#same').textContent, /Later/);
  t.mock.timers.tick(5_000);
  assert.equal(document.querySelector('#same'), null);
});

test('Undo gives a visible explanation, a keyboard reachable action and a 10 second window', t => {
  const { window, document } = setup(t);
  let undone = 0;
  window.showAppNotice({
    id: 'undo', kind: 'undo', message: 'Conversation archived.',
    actionLabel: 'Undo', onAction: () => { undone++; },
  });
  const notice = document.querySelector('#undo');
  assert.equal(notice.getAttribute('role'), 'status');
  assert.match(notice.textContent, /Conversation archived\./);
  const action = [...notice.querySelectorAll('button')].find(button => button.textContent === 'Undo');
  assert.ok(action);
  assert.equal(action.type, 'button');
  assert.equal(action.tabIndex, 0);
  action.focus();
  assert.equal(document.activeElement, action);
  t.mock.timers.tick(9_999);
  assert.ok(document.querySelector('#undo'));
  action.click();
  action.click();
  assert.equal(undone, 1);
  assert.equal(document.querySelector('#undo'), null);
  window.showAppNotice({ id: 'expiry', kind: 'undo', message: 'Archived.', actionLabel: 'Undo', onAction: () => { undone++; } });
  t.mock.timers.tick(9_999);
  assert.ok(document.querySelector('#expiry'));
  t.mock.timers.tick(1);
  assert.equal(document.querySelector('#expiry'), null);
  assert.equal(undone, 1);
});

test('ordinary notice actions use the supplied label and callback without interpreting message HTML', t => {
  const { window, document } = setup(t);
  let called = 0;
  window.showAppNotice({ id: 'action', kind: 'error', message: '<img src=x onerror=alert(1)>', actionLabel: 'Retry', onAction: () => { called++; } });
  assert.equal(document.querySelector('#action img'), null);
  assert.match(document.querySelector('#action').textContent, /<img/);
  const action = [...document.querySelectorAll('#action button')].find(button => button.textContent === 'Retry');
  action.click();
  assert.equal(called, 1);
  assert.equal(document.querySelector('#action'), null);
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
