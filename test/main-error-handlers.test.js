'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

function install(options) {
  const modulePath = path.join(__dirname, '..', 'src', 'main', 'app', 'main-error-handlers.js');
  assert.ok(fs.existsSync(modulePath), 'main process errors need an installed error-handler module');
  return require(modulePath).installMainErrorHandlers(options);
}

function setup(t, options = {}) {
  const target = new EventEmitter();
  const logs = [];
  const notices = [];
  const handlers = install({ target, log: { error: (...args) => logs.push(args) }, notify: notice => notices.push(notice), ...options });
  t.after(() => handlers.dispose());
  return { target, logs, notices, handlers };
}

test('both real process events log stacks and send one error notice each', () => {
  install({ target: new EventEmitter(), log: { error() {} }, notify() {} }).dispose();
  const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'main-error-events.cjs')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /both process events verified/);
});

test('identical messages log every time but notify only once per 60 seconds', t => {
  let now = 1000;
  const { target, logs, notices } = setup(t, { now: () => now });
  target.emit('uncaughtException', new Error('same'));
  now += 59999;
  target.emit('unhandledRejection', new Error('same'), Promise.resolve());
  assert.equal(logs.length, 2);
  assert.equal(notices.length, 1);
  now++;
  target.emit('uncaughtException', new Error('same'));
  assert.equal(logs.length, 3);
  assert.equal(notices.length, 2);
});

test('throwing logger cannot throw or prevent the notice for either event', t => {
  const { target, notices } = setup(t, { log: { error() { throw new Error('broken logger'); } } });
  assert.doesNotThrow(() => target.emit('uncaughtException', new Error('x')));
  assert.doesNotThrow(() => target.emit('unhandledRejection', new Error('y'), Promise.resolve()));
  assert.equal(notices.length, 2);
});

test('unavailable or throwing notifier queues errors until a later flush', t => {
  let ready = false;
  const delivered = [];
  const { target, logs, handlers } = setup(t, { notify: notice => {
    if (!ready) return false;
    delivered.push(notice);
  } });
  target.emit('uncaughtException', new Error('early'));
  target.emit('uncaughtException', new Error('early'));
  handlers.flushNotices();
  assert.equal(delivered.length, 0);
  ready = true;
  handlers.flushNotices();
  handlers.flushNotices();
  assert.equal(delivered.length, 1);
  assert.equal(logs.length, 2);

  const other = setup(t, { notify() { throw new Error('closed window'); } });
  assert.doesNotThrow(() => other.target.emit('uncaughtException', new Error('gone')));
  assert.doesNotThrow(() => other.handlers.flushNotices());
});

test('non-Error rejections and hostile error values cannot break handling', t => {
  const { target, logs, notices } = setup(t);
  for (const reason of ['string reason', null, { problem: 'object reason' }, new Proxy({}, { get() { throw new Error('getter'); } })]) {
    assert.doesNotThrow(() => target.emit('unhandledRejection', reason, Promise.resolve()));
  }
  assert.equal(logs.length, 4);
  assert.equal(notices.length, 4);
  assert.match(logs[2].join(' '), /object reason/);
});

test('dispose removes only its own process listeners', t => {
  const { target, handlers } = setup(t);
  const other = () => {};
  target.on('uncaughtException', other);
  handlers.dispose();
  assert.deepEqual(target.listeners('uncaughtException'), [other]);
  assert.equal(target.listenerCount('unhandledRejection'), 0);
});
