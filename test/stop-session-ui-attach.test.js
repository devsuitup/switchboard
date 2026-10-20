'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSessionStop } = require('../public/stop-session-ui');

test('an attach tab describes a reversible detach without asking and stays local', () => {
  const plan = resolveSessionStop({ sessionId: 's' }, { attach: true });
  assert.equal(plan.remote, false);
  assert.equal(plan.attach, true);
  assert.match(plan.confirmText, /Detach/);
  assert.match(plan.confirmText, /keeps running/);
  assert.doesNotMatch(plan.confirmText, /\?/);
  assert.equal(resolveSessionStop({ sessionId: 's' }).attach, false);
  assert.equal(resolveSessionStop({ sessionId: 's', remoteAlias: 'h' }, { attach: true }).remote, true);
});
