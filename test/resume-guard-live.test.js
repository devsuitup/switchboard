'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { liveElsewhereQuestion, guardResume } = require('../public/resume-guard');
const fmt = t => new Date(t).toISOString();

test('L1 says where and when the session runs and offers Resume anyway', () => {
  const q = liveElsewhereQuestion({ pid: 4242, cwd: '/work/proj', startedAt: 1790685077444 }, 'Plan', fmt);
  assert.equal(q.title, 'Session running elsewhere');
  assert.equal(q.confirmLabel, 'Resume anyway');
  assert.equal(q.danger, true);
  assert.equal(q.message[0], '"Plan" is already running in another process: pid 4242, in /work/proj, started 2026-09-29T12:31:17.444Z.');
  assert.equal(q.message[1], 'Resuming it here starts a second Claude on the same conversation, and both write to its transcript.');
});

test('L2 missing fields are omitted with an untitled fallback', () => {
  const q = liveElsewhereQuestion({ pid: 4242, cwd: null, startedAt: null }, undefined, fmt);
  assert.equal(q.message[0], '"Untitled conversation" is already running in another process: pid 4242.');
  assert.equal(liveElsewhereQuestion({}, '', fmt).message[0], '"Untitled conversation" is already running in another process.');
});

test('L4 a scheduled run names the schedule and resumes when accepted without a notice', async () => {
  const asked = [];
  assert.equal(await guardResume({ sessionId: 's' }, {
    name: 'Nightly', live: { kind: 'schedule', pid: 7, cwd: '/w', scheduleName: 'nightly-report' },
    confirm: async q => { asked.push(q); return true; }, notify: () => assert.fail('no notice'),
  }), true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].confirmLabel, 'Resume anyway');
  assert.equal(asked[0].message[0], '"Nightly" is already running in a scheduled run of "nightly-report": pid 7, in /w.');
});

test('L5 a scheduled run without a name says in a scheduled run', () => {
  assert.equal(liveElsewhereQuestion({ kind: 'schedule', pid: 7 }, 'Nightly', fmt).message[0],
    '"Nightly" is already running in a scheduled run: pid 7.');
});

test('L6 background without job id refuses by error notice without asking', async () => {
  const notices = [];
  assert.equal(await guardResume({ sessionId: 's' }, {
    name: 'Plan', live: { kind: 'bg', pid: 9 }, confirm: () => assert.fail('no dialog'), notify: n => notices.push(n),
  }), false);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'error');
  assert.equal(notices[0].message, 'Cannot open "Plan" here: it runs as a background session whose job Switchboard cannot identify, so it cannot be attached. Find it in the Agents view.');
});

test('automatic background refusal without a job id reports the blocked session silently', async () => {
  const blocked = [];
  const live = { kind: 'bg', pid: 9 };
  assert.equal(await guardResume({ sessionId: 's' }, {
    automatic: true, allowBgAttach: true, live,
    confirm: () => assert.fail('no dialog'),
    notify: () => assert.fail('restore owns its notice'),
    onBlocked: part => blocked.push(part),
  }), false);
  assert.deepEqual(blocked, [{ sessionId: 's', live }]);
});
