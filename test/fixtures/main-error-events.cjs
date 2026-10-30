'use strict';

const assert = require('node:assert/strict');
const { installMainErrorHandlers } = require('../../src/main/app/main-error-handlers');
const logs = [];
const notices = [];
const before = [process.listenerCount('uncaughtException'), process.listenerCount('unhandledRejection')];
const handlers = installMainErrorHandlers({ log: { error: (...args) => logs.push(args) }, notify: notice => notices.push(notice) });
try {
  const rejection = new Error('x');
  const exception = new Error('y');
  process.emit('unhandledRejection', rejection, Promise.resolve());
  process.emit('uncaughtException', exception);
  assert.equal(logs.length, 2);
  assert.match(logs[0][0], /unhandledRejection/);
  assert.equal(logs[0][1], rejection.stack);
  assert.match(logs[1][0], /uncaughtException/);
  assert.equal(logs[1][1], exception.stack);
  assert.equal(notices.length, 2);
  for (const notice of notices) {
    assert.equal(notice.kind, 'error');
    assert.match(notice.message, /Settings → Diagnostics/);
    assert.match(notice.message, /log/i);
  }
  assert.match(notices[0].message, /Unhandled rejection.*x/);
  assert.match(notices[1].message, /Uncaught exception.*y/);
} finally {
  handlers.dispose();
}
assert.deepEqual([process.listenerCount('uncaughtException'), process.listenerCount('unhandledRejection')], before);
console.log('both process events verified');
