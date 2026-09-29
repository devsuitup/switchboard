// The status line says what is in force: off means nothing is contacted, and a
// reachability the app has not measured is not reported as one.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { activityReportingStatusText } = require('../public/activity-reporting-panel');

const base = { destination: 'ActivityWatch', url: 'http://localhost:5600' };

test('off says that nothing is sent and nothing is contacted', () => {
  assert.match(activityReportingStatusText({ ...base, enabled: false, reachable: null }), /nothing is sent.*no connection/i);
});

test('on and answering names the destination and its address', () => {
  assert.equal(activityReportingStatusText({ ...base, enabled: true, reachable: true }),
    'Connected to ActivityWatch at http://localhost:5600.');
});

test('on and not answering says so, and that nothing is queued', () => {
  const text = activityReportingStatusText({ ...base, enabled: true, reachable: false });
  assert.match(text, /not answering/);
  assert.match(text, /nothing is queued/i, 'the loss while it is down is stated, not implied away');
});

test('on but not yet measured is not reported as reachable or unreachable', () => {
  const text = activityReportingStatusText({ ...base, enabled: true, reachable: null });
  assert.match(text, /^Checking/);
});

test('a missing state reads as off rather than throwing', () => {
  assert.match(activityReportingStatusText(null), /^Off/);
});
