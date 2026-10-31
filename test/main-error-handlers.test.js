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
  ['50 MB Buffer', () => Buffer.alloc(50e6)],
  ['array', () => new Array(5e6).fill(0)],
  ['typed array', () => new Uint8Array(2e5)],
  ['DataView', () => new DataView(new ArrayBuffer(2e5))],
  ['String object', () => new String('x'.repeat(2000))],
]) {
  test(`large ${name} rejection retains bounded inspect output`, t => {
    const { target, logs, notices } = setup(t);
    let reason = create();
    const length = reason.length ?? reason.byteLength;
    const start = performance.now();
    target.emit('unhandledRejection', reason);
    const elapsed = performance.now() - start;
    reason = null;
    t.diagnostic(`reporting ${name}: ${elapsed.toFixed(1)} ms`);
    assert.ok(elapsed < 200, `reporting ${name} took ${elapsed} ms; budget is 200 ms`);
    assert.ok(logs[0][1].length <= 16000);
    assert.ok(notices[0].message.length <= 550);
    if (name === 'String object') assert.match(logs[0][1], /String/);
    else {
      assert.ok(logs[0][1].includes(String(length)), 'preview must include the real length');
      assert.match(logs[0][1], /named properties not inspected/);
      assert.match(logs[0][1], new RegExp(name === 'array' ? 'Array' : name === 'typed array' ? 'Uint8Array' : name.replace('50 MB ', '')));
      assert.match(logs[0][1], /0/);
    }
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

test('multi-megabyte String objects bypass enumeration within 200 ms', t => {
  const { target, logs, notices } = setup(t);
  for (const length of [5e6, 5e7]) {
    let reason = new String('x'.repeat(length));
    const start = performance.now();
    target.emit('unhandledRejection', reason);
    const elapsed = performance.now() - start;
    reason = null;
    t.diagnostic(`reporting String length=${length}: ${elapsed.toFixed(1)} ms`);
    assert.ok(elapsed < 200, `String length=${length} took ${elapsed} ms; budget is 200 ms`);
    assert.match(logs.at(-1)[1], new RegExp(`String length=${length}; named properties not inspected`));
    assert.ok(logs.at(-1)[1].length <= 16000);
    assert.ok(notices.at(-1).message.length <= 550);
  }
});

test('large cross-realm String objects bypass enumeration within 200 ms', t => {
  const { target, logs, notices } = setup(t);
  let reason = require('node:vm').runInNewContext('new String("x".repeat(5e6))');
  reason.named = 'not inspected';
  const start = performance.now();
  target.emit('unhandledRejection', reason);
  const elapsed = performance.now() - start;
  reason = null;
  t.diagnostic(`reporting cross-realm String: ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 200, `cross-realm String took ${elapsed} ms; budget is 200 ms`);
  assert.match(logs[0][1], /String length=5000000; named properties not inspected/);
  assert.ok(logs[0][1].length <= 16000);
  assert.ok(notices[0].message.length <= 550);
});

test('Buffer classification never walks a Proxy prototype', t => {
  const { target, logs } = setup(t);
  let reads = 0;
  const reason = new Uint8Array(5000);
  Object.setPrototypeOf(reason, new Proxy(Buffer.prototype, {
    getPrototypeOf(value) { reads++; return Reflect.getPrototypeOf(value); },
  }));
  target.emit('unhandledRejection', reason);
  assert.equal(reads, 0, 'Buffer classification must not walk a Proxy prototype');
  assert.match(logs[0][1], /Uint8Array length=5000/);
});

test('large array sampling invokes neither species nor index accessors', t => {
  const { target, logs, notices } = setup(t);
  let speciesReads = 0;
  let indexReads = 0;
  class Reason extends Array {
    static get [Symbol.species]() { speciesReads++; return Array; }
  }
  const subclass = new Reason(5000).fill(7);
  const accessor = new Array(5000).fill(8);
  Object.defineProperty(accessor, '0', { get() { indexReads++; throw new Error('index getter'); } });
  target.emit('unhandledRejection', subclass);
  target.emit('unhandledRejection', accessor);
  assert.equal(speciesReads, 0, 'sampling must not consult Symbol.species');
  assert.equal(indexReads, 0, 'sampling must not read index accessors');
  for (const log of logs) assert.match(log[1], /Array length=5000; named properties not inspected/);
  assert.match(logs[0][1], /7/);
  assert.match(logs[1][1], /\[Getter\]/);
  assert.equal(notices.length, 2);
});

for (const [name, create, expected] of [
  ['typed array', () => new Uint16Array(5000), 'Uint16Array length=5000'],
  ['Buffer', () => Buffer.alloc(5000), 'Buffer length=5000'],
  ['DataView', () => new DataView(new Uint8Array(5005).fill(42).buffer, 5, 5000), 'DataView byteLength=5000'],
  ['cross-realm typed array', () => require('node:vm').runInNewContext('new Uint8Array(5000)'), 'Uint8Array length=5000'],
]) {
  test(`large ${name} uses intrinsic metadata despite shadowing accessors`, t => {
    const { target, logs, notices } = setup(t);
    const reason = create();
    let reads = 0;
    for (const key of ['length', 'byteLength', 'buffer', 'byteOffset', 'constructor']) {
      Object.defineProperty(reason, key, { get() { reads++; throw new Error(`shadow ${key}`); } });
    }
    target.emit('unhandledRejection', reason);
    assert.equal(reads, 0, 'metadata access must bypass user getters');
    assert.ok(logs[0][1].includes(expected), logs[0][1]);
    assert.match(logs[0][1], /named properties not inspected/);
    if (name === 'DataView') assert.match(logs[0][1], /42/);
    assert.doesNotMatch(notices[0].message, /Unreadable error/);
  });
}

test('large typed array sampling never consults species', t => {
  const { target, logs } = setup(t);
  let reads = 0;
  class Reason extends Uint8Array {
    static get [Symbol.species]() { reads++; throw new Error('species getter'); }
  }
  target.emit('unhandledRejection', new Reason(5000).fill(9));
  assert.equal(reads, 0);
  assert.match(logs[0][1], /length=5000/);
  assert.match(logs[0][1], /9/);
});

test('50 MB messages bound logs and hash only the prefix plus original length', t => {
  const { target, logs, notices, clock } = setup(t);
  let message = 'x'.repeat(50e6);
  let stackReads = 0;
  const emit = value => target.emit('unhandledRejection', {
    message: value,
    get stack() { stackReads++; throw new Error('must not format an oversized stack'); },
  });
  target.emit('unhandledRejection', new Error(message));
  assert.ok(logs[0][1].length <= 16000, 'message log must be capped before logging');
  emit(message.slice(0, -1) + 'y');
  clock.advance(1000);
  assert.equal(notices.at(-1).id, notices[0].id, 'equal prefixes and lengths intentionally share an id');
  assert.equal(notices.at(-1).count, 2);
  emit(message + 'z');
  assert.notEqual(notices.at(-1).id, notices[0].id, 'original length participates in oversized-message ids');
  target.emit('unhandledRejection', { message: message.slice(0, 16000) });
  assert.notEqual(notices.at(-1).id, notices[0].id, 'an uncapped prefix is a separate identity');
  assert.equal(stackReads, 0);
  for (const log of logs) assert.ok(log[1].length <= 16000);
  message = null;
});

test('oversized explicit stacks are bounded even when the message is short', t => {
  const { target, logs } = setup(t);
  target.emit('uncaughtException', { message: 'short', stack: 's'.repeat(50000) });
  assert.equal(logs[0][1], 's'.repeat(16000));
});

for (const length of [15990, 16001, 50e6]) {
  test(`message length ${length} retains a bounded prefix, truncation marker and stack frames`, t => {
    const { target, logs } = setup(t);
    const error = new Error('stderr '.padEnd(length, 'x'));
    const formatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    const start = performance.now();
    target.emit('uncaughtException', error);
    t.diagnostic(`reporting Error length=${length}: ${(performance.now() - start).toFixed(1)} ms`);
    assert.match(logs[0][1], /\n\s+at /, 'a truncated message must retain stack frames');
    assert.match(logs[0][1], new RegExp(`\\[truncated; length=${length}\\]`));
    assert.ok(logs[0][1].startsWith('stderr '));
    assert.ok(logs[0][1].length <= 16000);
    assert.deepEqual(Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'), formatter);
  });
}

test('oversized native Error custom stack getter cannot contaminate an inner Error', t => {
  const { target, logs } = setup(t);
  const error = new Error('reported '.padEnd(16001, 'x'));
  let inner;
  let reads = 0;
  Object.defineProperty(error, 'stack', { configurable: true, get() {
    reads++;
    inner = new Error('innocent');
    return inner.stack;
  } });
  const descriptor = Object.getOwnPropertyDescriptor(error, 'stack');
  const formatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  target.emit('uncaughtException', error);
  assert.equal(inner, undefined, 'custom getter must not create an inner Error under the swapped formatter');
  assert.equal(reads, 0, 'oversized custom stack getter must not run');
  assert.deepEqual(Object.getOwnPropertyDescriptor(error, 'stack'), descriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'), formatter);
  assert.equal(logs[0][1], `${error.message.slice(0, 11000)}\n[truncated; length=16001]`);
});

test('oversized native stack logs its message prefix and truncation marker exactly once', t => {
  const { target, logs } = setup(t);
  const error = new Error('message-prefix '.repeat(1200));
  target.emit('uncaughtException', error);
  const header = `${error.message.slice(0, 11000)}\n[truncated; length=${error.message.length}]`;
  assert.equal(logs[0][1].split('[truncated;').length - 1, 1, 'log must contain exactly one truncation marker');
  assert.ok(logs[0][1].startsWith(header + '\n'));
  const frames = logs[0][1].slice(header.length + 1);
  assert.match(frames, /^    at /);
  assert.doesNotMatch(frames, /message-prefix/, 'frames must not duplicate the message prefix');
  assert.ok(logs[0][1].length <= 16000);
});

for (const length of [16001, 50e6]) {
  test(`reporting an unread native stack with message length ${length} caches bounded frames only`, t => {
    const { target } = setup(t);
    const error = new Error('unread-message '.padEnd(length, 'x'));
    const formatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    target.emit('uncaughtException', error);
    const stack = error.stack;
    assert.ok(stack.length <= 4000, `cached stack must be bounded; received ${stack.length} characters`);
    assert.match(stack, /^    at /);
    assert.doesNotMatch(stack, /unread-message|xxxx/, 'cached stack must contain no message text');
    assert.deepEqual(Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'), formatter);
  });
}

test('an oversized native stack read before reporting stays unchanged and retains its frame', t => {
  const { target, logs } = setup(t);
  const error = new Error('cached '.padEnd(16001, 'x'));
  const before = error.stack;
  target.emit('uncaughtException', error);
  assert.equal(error.stack, before, 'reporting must preserve an already cached stack');
  assert.equal(logs[0][1], `${error.message.slice(0, 11000)}\n[truncated; length=16001]\n${before.slice(-4000)}`);
  assert.match(logs[0][1], /main-error-handlers\.test\.js:\d+:\d+/);
});

for (const native of [false, true]) {
  test(`oversized ${native ? 'native Error' : 'non-Error'} own stack string retains its frame`, t => {
    const { target, logs } = setup(t);
    const error = native ? new Error() : {};
    error.message = 'explicit '.padEnd(16001, 'x');
    Object.defineProperty(error, 'stack', { configurable: true, value: 'Explicit stack\n    at retained-frame:7:9' });
    target.emit('uncaughtException', error);
    assert.equal(logs[0][1], `${error.message.slice(0, 11000)}\n[truncated; length=16001]\n${error.stack}`);
  });
}

test('oversized native Error without own stack ignores an inherited custom getter', t => {
  const { target, logs } = setup(t);
  const error = new Error('absent '.padEnd(16001, 'x'));
  delete error.stack;
  let reads = 0;
  Object.setPrototypeOf(error, Object.create(Error.prototype, { stack: { get() { reads++; return new Error('inner').stack; } } }));
  target.emit('uncaughtException', error);
  assert.equal(reads, 0, 'missing own stack must not fall through to an inherited getter');
  assert.equal(logs[0][1], `${error.message.slice(0, 11000)}\n[truncated; length=16001]`);
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
  ['cross-realm String object', () => require('node:vm').runInNewContext('new String("x".repeat(1000))')],
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

test('display summaries are truncated while distinct suffixes keep distinct ids and fitting stacks remain intact', t => {
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
