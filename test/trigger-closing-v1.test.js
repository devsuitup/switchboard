'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExitAttempts } = require('../src/main/app/session-exit');
test('close commitment immediately notifies the trigger permit owner', async () => {
  const notifications = []; const win = {};
  const attempts = createExitAttempts({ snapshot: () => ({ rows: [] }), check: async () => ({ proceed: true }),
    cancelCheck() {}, invalidateRenderer() {}, onCommitted: window => notifications.push(window) });
  await attempts.request(win, 'close');
  assert.deepEqual(notifications, [win]); assert.equal(attempts.launchAllowed(), false);
});
