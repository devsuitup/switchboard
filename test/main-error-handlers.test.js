'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const createClock = require('./fixtures/main-error-clock.cjs');

function install(options) {
  const modulePath = path.join(__dirname, '..', 'src', 'main', 'app', 'main-error-handlers.js');
  assert.ok(fs.existsSync(modulePath), 'main process errors need an installed error-handler module');
  return require(modulePath).installMainErrorHandlers(options);
}

function setup(t, options = {}) {
  const target = new EventEmitter();
  const logs = [];
  const notices = [];
  const clock = createClock();
  const handlers = install({ target, log: { error: (...args) => logs.push(args) }, notify: notice => notices.push(notice), ...clock, ...options });
  t.after(() => handlers.dispose());
  return { target, logs, notices, handlers, clock };
}

test('both real process events log stacks and send one error notice each', () => {
  install({ target: new EventEmitter(), log: { error() {} }, notify() {} }).dispose();
  const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'main-error-events.cjs')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /both process events verified/);
});

test('normalized recurring messages keep their id and update their count', t => {
  const { target, logs, notices, clock } = setup(t);
  target.emit('uncaughtException', new Error('same'));
  target.emit('unhandledRejection', new Error(' same\n '), Promise.resolve());
  clock.advance(1000);
  assert.equal(logs.length, 2);
  assert.equal(notices.length, 2);
  assert.equal(notices[1].id, notices[0].id);
  assert.equal(notices[1].count, 2);
  target.emit('uncaughtException', new Error('same'));
  clock.advance(1000);
  assert.equal(logs.length, 3);
  assert.equal(notices.length, 3);
  assert.equal(notices[2].id, notices[0].id);
  assert.equal(notices[2].count, 3);
});

test('1000 synchronous repeats log exactly and deliver at most twice with the final count', t => {
  const { target, logs, notices, clock } = setup(t);
  for (let i = 0; i < 1000; i++) target.emit('uncaughtException', new Error('storm'));
  assert.ok(notices.length <= 2, 'a synchronous storm must not flood IPC');
  assert.equal(notices[0].count, 1, 'first occurrence is immediate');
  assert.equal(logs.length, 1000);
  assert.equal(clock.size, 1, 'one trailing timer per id');
  clock.advance(999);
  assert.equal(notices.length, 1);
  clock.advance(1);
  assert.equal(notices.length, 2);
  assert.equal(notices[1].count, 1000);
  target.emit('uncaughtException', new Error('storm'));
  clock.advance(1000);
  assert.equal(notices.at(-1).count, 1001);
  target.emit('uncaughtException', new Error('different'));
  assert.equal(notices.at(-1).count, 1, 'distinct ids send independently');
  target.emit('uncaughtException', new Error('storm'));
  assert.ok(clock.size > 0);
  const before = notices.length;
  const timerCount = clock.size;
  assert.ok(timerCount <= 2);
  const handlers = setup(t);
  handlers.target.emit('uncaughtException', new Error('dispose'));
  handlers.target.emit('uncaughtException', new Error('dispose'));
  handlers.handlers.dispose();
  assert.equal(handlers.clock.size, 0, 'dispose cancels trailing delivery');
  clock.advance(1000);
  assert.equal(notices.length, before + 1);
});

test('trailing count survives count-cache eviction and all queued timers are disposed', t => {
  const { target, notices, clock, handlers } = setup(t);
  target.emit('uncaughtException', new Error('burst before other ids'));
  target.emit('uncaughtException', new Error('burst before other ids'));
  for (let i = 0; i < 100; i++) target.emit('uncaughtException', new Error(`other-${i}`));
  clock.advance(1000);
  assert.equal(notices.filter(notice => notice.message.endsWith('burst before other ids')).at(-1).count, 2, 'count-cache eviction must not lose a queued trailing update');
  target.emit('uncaughtException', new Error('pending at disposal'));
  target.emit('uncaughtException', new Error('pending at disposal'));
  for (let i = 0; i < 100; i++) target.emit('uncaughtException', new Error(`more-${i}`));
  handlers.dispose();
  assert.equal(clock.size, 0, 'dispose also cancels timers whose count cache entry was evicted');
});

test('queued repeat becomes newest before bounded eviction and flush', t => {
  let ready = false;
  const delivered = [];
  const { target, handlers } = setup(t, { notify: notice => {
    if (!ready) return false;
    delivered.push(notice);
  } });
  for (let i = 0; i < 100; i++) target.emit('uncaughtException', new Error(`order-${i}`));
  target.emit('uncaughtException', new Error('order-0'));
  target.emit('uncaughtException', new Error('order-100'));
  ready = true;
  handlers.flushNotices();
  assert.equal(delivered.length, 100);
  assert.ok(delivered.some(notice => notice.message.endsWith('order-0') && notice.count === 2), 'fresh repeat must survive eviction');
  assert.ok(!delivered.some(notice => notice.message.endsWith('order-1')), 'least recent queued id must be evicted');
  assert.match(delivered.at(-2).message, /order-0$/);
});

test('empty messages fall back to name or type and keep different identities', t => {
  const { target, notices } = setup(t);
  target.emit('uncaughtException', new TypeError(''));
  target.emit('uncaughtException', new RangeError('  \n '));
  target.emit('unhandledRejection', { message: '', name: '' });
  assert.match(notices[0].message, /TypeError$/);
  assert.match(notices[1].message, /RangeError$/);
  assert.match(notices[2].message, /object$/);
  assert.equal(new Set(notices.map(notice => notice.id)).size, 3);
});

test('empty message with a throwing name getter still uses a type fallback', t => {
  const { target, notices } = setup(t);
  target.emit('unhandledRejection', { message: '', get name() { throw new Error('hostile name'); } });
  assert.match(notices[0].message, /object$/, 'empty summary must survive an unreadable name');
});

test('wide objects are capped before logging and hashing without invoking getters', t => {
  const { target, logs, notices, clock } = setup(t);
  const wide = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`key${i}`, 'value'.repeat(10)]));
  let getterCalls = 0;
  Object.defineProperty(wide, 'hostile', { enumerable: true, get() { getterCalls++; throw new Error('must not run'); } });
  wide.tail = 'one';
  target.emit('unhandledRejection', wide);
  assert.ok(logs[0][1].length <= 16000, 'inspected wide objects must be capped before hashing');
  assert.equal(getterCalls, 0, 'inspection must not invoke object getters');
  wide.tail = 'two';
  target.emit('unhandledRejection', wide);
  clock.advance(1000);
  assert.equal(notices.at(-1).id, notices[0].id, 'object keys beyond the inspected prefix do not enter the hash');
});

test('a 100000-key rejection is summarized before inspecting property values', t => {
  const { target, logs, notices } = setup(t);
  const wide = Object.fromEntries(Array.from({ length: 100000 }, (_, i) => [`key${i}`, 'must not serialize']));
  let getterCalls = 0;
  Object.defineProperty(wide, 'hostile', { enumerable: true, get() { getterCalls++; throw new Error('must not run'); } });
  target.emit('unhandledRejection', wide);
  assert.equal(logs[0][1], '[Object with 100001 keys; inspection omitted]');
  assert.equal(notices[0].message, 'Unhandled rejection: [Object with 100001 keys; inspection omitted]');
  assert.equal(getterCalls, 0);
});

for (const [name, create] of [
  ['Buffer', () => Buffer.alloc(5e6)],
  ['array', () => new Array(2e5).fill(0)],
  ['typed array', () => new Uint8Array(2e5)],
  ['String object', () => new String('x'.repeat(2000))],
]) {
  test(`large ${name} rejection retains bounded inspect output`, t => {
    const { target, logs, notices } = setup(t);
    const reason = create();
    const expected = require('node:util').inspect(reason, { customInspect: false, getters: false, depth: 3, maxArrayLength: 20, maxStringLength: 2000, breakLength: Infinity }).slice(0, 16000);
    target.emit('unhandledRejection', reason);
    assert.equal(logs[0][1], expected);
    assert.doesNotMatch(notices[0].message, /inspection omitted/);
  });
}

test('proxy rejection inspection runs no traps', t => {
  const { target, logs } = setup(t);
  let traps = 0;
  const reason = new Proxy({ problem: 'proxy reason' }, Object.fromEntries(
    ['get', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'].map(name => [name, (...args) => {
      traps++;
      return Reflect[name](...args);
    }]),
  ));
  target.emit('unhandledRejection', reason);
  assert.equal(traps, 0, 'error reporting must not run proxy traps');
  assert.equal(logs[0][1], '[Proxy; inspection omitted]');
});

for (const [name, create] of [
  ['array', () => [1, 2, 3]],
  ['Buffer', () => Buffer.alloc(3)],
  ['typed array', () => new Uint8Array(3)],
  ['String object', () => new String('abc')],
  ['cross-realm String object', () => require('node:vm').runInNewContext('new String("abc")')],
  ['Proxy', () => new Proxy({}, {})],
]) {
  test(`300000 named keys on a ${name} rejection are summarized before inspection`, t => {
    const { target, logs, notices } = setup(t);
    const reason = create();
    for (let i = 0; i < 300000; i++) reason[`k${i}`] = 'value';
    const start = performance.now();
    target.emit('unhandledRejection', reason);
    const elapsed = performance.now() - start;
    assert.match(logs[0][1], /inspection omitted\]$/, 'wide named properties must bypass inspection');
    assert.ok(logs[0][1].length <= 16000);
    assert.ok(notices[0].message.length <= 550);
    assert.ok(elapsed < 1000, `reporting took ${elapsed} ms`);
    t.diagnostic(`reporting ${name}: ${elapsed.toFixed(1)} ms`);
  });
}

for (const [name, create] of [
  ['array', () => [1]],
  ['Buffer', () => Buffer.alloc(1)],
  ['typed array', () => new Uint8Array(1)],
  ['String object', () => new String('a')],
  ['cross-realm String object', () => require('node:vm').runInNewContext('new String("x".repeat(2000))')],
]) {
  test(`${name} named-key cap permits 1000 keys and summarizes 1001 without getters`, t => {
    const { target, logs } = setup(t);
    const reason = create();
    let reads = 0;
    for (let i = 0; i < 1000; i++) Object.defineProperty(reason, `k${i}`, { enumerable: true, get() { reads++; return 'unused'; } });
    target.emit('unhandledRejection', reason);
    assert.doesNotMatch(logs[0][1], /inspection omitted/);
    reason.extra = 'overflow';
    target.emit('unhandledRejection', reason);
    assert.match(logs[1][1], /inspection omitted/);
    assert.equal(reads, 0);
  });
}

test('large error messages are truncated for display but distinct suffixes keep distinct ids and full stacks', t => {
  const { target, logs, notices } = setup(t);
  const error = new Error('command stderr '.repeat(1000));
  target.emit('uncaughtException', error);
  target.emit('uncaughtException', new Error(error.message + ' different'));
  assert.ok(notices[0].message.length <= 550, 'display text must be bounded');
  assert.match(notices[0].message, /…/);
  assert.notEqual(notices[0].id, notices[1].id);
  assert.equal(logs[0][1], error.stack);
  target.emit('unhandledRejection', { values: Array.from({ length: 1000 }, () => 'x'.repeat(1000)) });
  assert.ok(notices[2].message.length <= 550, 'object display text must be bounded');
});

test('unavailable renderer queue drops the oldest beyond 100 distinct messages and preserves repeat counts', t => {
  let ready = false;
  const delivered = [];
  const { target, handlers, logs } = setup(t, { notify: notice => {
    if (!ready) return false;
    delivered.push(notice);
  } });
  for (let i = 0; i < 105; i++) target.emit('uncaughtException', new Error(`queued-${i}`));
  target.emit('uncaughtException', new Error('queued-104'));
  ready = true;
  handlers.flushNotices();
  handlers.flushNotices();
  assert.equal(delivered.length, 100, 'queue retains at most 100 distinct messages');
  assert.match(delivered[0].message, /queued-5\b/, 'oldest five queued messages must be dropped');
  assert.match(delivered.at(-1).message, /queued-104\b/);
  assert.equal(delivered.at(-1).count, 2);
  assert.equal(logs.length, 106);
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
