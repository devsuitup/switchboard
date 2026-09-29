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

test('only a measured yes reads as connected', () => {
  assert.match(activityReportingStatusText({ ...base, enabled: true, reachable: 'yes' }), /^Checking/);
  assert.match(activityReportingStatusText({ ...base, enabled: true, reachable: 1 }), /^Checking/);
});

// --- The toggle, run against the real panel file in jsdom ---

const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const PANEL_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'activity-reporting-panel.js'), 'utf8');

function mountToggle(setEnabled) {
  const dom = new JSDOM('<input type="checkbox" id="t"><div id="s"></div>', { runScripts: 'outside-only' });
  dom.window.api = { setActivityReportingEnabled: setEnabled };
  dom.window.eval(PANEL_SRC);
  const input = dom.window.document.getElementById('t');
  const status = dom.window.document.getElementById('s');
  dom.window.wireActivityReportingToggle(input, status);
  return { dom, input, status };
}

const flip = async ({ dom, input }) => {
  input.checked = !input.checked;
  input.dispatchEvent(new dom.window.Event('change'));
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
};

test('a toggle whose save fails goes back to what is in force', async () => {
  const m = mountToggle(async () => { throw new Error('ipc down'); });
  await flip(m);
  assert.equal(m.input.checked, false, 'the checkbox does not claim a state main never took');
  assert.equal(m.input.disabled, false);
});

test('a toggle shows the state main returns, not the one clicked', async () => {
  const m = mountToggle(async () => ({ ...base, enabled: false, reachable: null }));
  await flip(m);
  assert.equal(m.input.checked, false);
  assert.match(m.status.textContent, /^Off/);
});

test('a toggle that takes reports the measured reachability', async () => {
  const m = mountToggle(async () => ({ ...base, enabled: true, reachable: true }));
  await flip(m);
  assert.equal(m.input.checked, true);
  assert.equal(m.status.textContent, 'Connected to ActivityWatch at http://localhost:5600.');
});
