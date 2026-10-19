'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveResumeSession, guardResume } = require('../public/resume-guard');
const { setup } = require('./continuations-harness');
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const session = { sessionId: A, name: 'Plan', modified: '2026-10-17', messageCount: 812 };
const candidates = [{ sessionId: B, modified: '2026-10-18', title: 'Plan', messageCount: 1 }, { sessionId: C, modified: '2026-10-19', title: 'Plan' }];
function harness(result = { candidates }, answer) {
  const asked = [], batches = [];
  const opts = {
    api: { getSessionContinuations: async () => result, getSessionsLiveElsewhere: async ids => { batches.push(ids); return {}; } },
    confirm: async q => { asked.push(q); return answer === true; },
    choose: async q => { asked.push(q); return answer === undefined ? { choice: q.selectedId } : answer; },
    formatDate: t => new Date(t).toISOString(),
  };
  return { asked, batches, opts };
}
test('T1 one chooser lists named parts newest first and preselects the newest', async () => {
  const h = harness();
  assert.equal((await resolveResumeSession(session, h.opts)).sessionId, C);
  assert.equal(h.asked.length, 1);
  const q = h.asked[0];
  assert.equal(q.title, 'Open which part?');
  assert.equal(q.confirmLabel, 'Open');
  assert.deepEqual(q.options.map(o => o.id), [C, B, A]);
  assert.equal(q.selectedId, C);
  assert.equal(q.message[0], '"Plan" continues in 2 other parts. Choose the one to open.');
  assert.equal(q.message.length, 1, 'memory is deferred to PR 6');
  assert.deepEqual(h.batches[0].slice().sort(), [A, B, C].sort());
  for (const text of [q.message.join(' '), ...q.options.map(o => o.label + o.detail)]) assert.doesNotMatch(text, /[a-f]{8}-0000|undefined|null|NaN|Invalid Date/);
  assert.match(q.options[2].detail, /the part you clicked/);
});
test('T2 missing or blank names, invalid or missing dates and unknown counts stay explicit', async () => {
  const h = harness({ candidates: [{ sessionId: B, title: ' ', modified: 'bad date' }, { sessionId: C, modified: null }] });
  await resolveResumeSession({ sessionId: A }, h.opts);
  for (const o of h.asked[0].options) {
    assert.equal(o.label, 'Untitled conversation');
    assert.match(o.detail, /^last active unknown/);
    assert.doesNotMatch(o.detail, /messages|undefined|null|NaN|Invalid Date/);
  }
  assert.equal(h.asked[0].options.at(-1).id, A);
});
test('T7 Cancel opens nothing, repeated manual opens still ask and the clicked part can be chosen', async () => {
  const h = harness(undefined, null);
  assert.equal(await resolveResumeSession(session, h.opts), null);
  h.opts.choose = async q => { h.asked.push(q); return { choice: A }; };
  assert.equal(await resolveResumeSession(session, h.opts), session);
  assert.equal(h.asked.length, 2);
});
test('T9 automatic ambiguity holds without a chooser or liveness batch; a single candidate follows', async () => {
  const h = harness();
  h.opts.describe = () => { assert.fail('automatic resolution must not describe chooser options'); };
  assert.equal(await resolveResumeSession(session, { ...h.opts, automatic: true }), null);
  assert.deepEqual(h.asked, []);
  assert.deepEqual(h.batches, []);
  h.opts.api.getSessionContinuations = async () => ({ candidates: [candidates[0]] });
  assert.equal((await resolveResumeSession(session, { ...h.opts, automatic: true })).sessionId, B);
});
test('T18 counts distinguish identically named parts, singular and unknown count', async () => {
  const h = harness();
  await resolveResumeSession(session, h.opts);
  assert.match(h.asked[0].options.find(o => o.id === A).detail, / · 812 messages/);
  assert.match(h.asked[0].options.find(o => o.id === B).detail, / · 1 message$/);
  assert.doesNotMatch(h.asked[0].options.find(o => o.id === C).detail, /messages/);
});
test('unresolved graphs with known candidates use one incomplete-list chooser', async () => {
  const h = harness({ candidates: [candidates[0]], unresolved: true });
  assert.equal((await resolveResumeSession(session, h.opts)).sessionId, B);
  assert.equal(h.asked[0].message[0], '"Plan" continues in another part. Choose the one to open.');
  assert.equal(h.asked[0].message[1], 'Some continuation records could not be read, so this list may be incomplete. This choice is not remembered.');
});
for (const state of ['failed', 'unresolved', 'indexing']) test('no-candidate ' + state + ' uses the named Open as it was question', async () => {
  const h = harness({ candidates: [], unresolved: true, waitingForIndex: state === 'indexing' }, true);
  if (state === 'failed') h.opts.api.getSessionContinuations = async () => { throw new Error('IPC failed'); };
  assert.equal(await resolveResumeSession(session, h.opts), session);
  const q = h.asked[0];
  assert.equal(q.title, 'Open this conversation?');
  assert.equal(q.confirmLabel, 'Open as it was');
  assert.match(q.message[0], state === 'failed' ? /could not check whether "Plan" continued/ : state === 'indexing' ? /still being indexed/ : /continuation records are damaged/);
  assert.doesNotMatch(q.message.join(' '), /[a-f]{8}-0000/);
});
test('main supplies title and message count for a candidate missing from renderer rows', async t => {
  const metadata = {};
  const h = setup(t, { old: ['new'], new: [] }, { metadata });
  h.rows.get('new').customTitle = 'Archived plan';
  h.rows.get('new').messageCount = 17;
  let result = await h.ctx.api.getSessionContinuations('old');
  assert.equal(result.candidates[0].title, 'Archived plan');
  assert.equal(result.candidates[0].messageCount, 17);
  metadata.new = { name: 'Renamed plan' };
  result = await h.ctx.api.getSessionContinuations('old');
  assert.equal(result.candidates[0].title, 'Renamed plan');
});
async function mounted(h, promise) {
  const doc = h.dom.window.document;
  for (let n = 0; n < 100; n++) {
    if (doc.querySelector('.choice-dialog')) return doc.querySelector('.choice-dialog');
    await new Promise(resolve => setImmediate(resolve));
  }
  await promise;
  assert.fail('chooser did not mount');
}
function dialogs(h) {
  for (const name of ['modal-stack', 'choice-dialog', 'app-dialogs']) {
    const filename = path.join(__dirname, '../public/' + name + '.js');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), h.ctx, { filename });
  }
}
test('D1 real open path mounts one chooser with three radios, row names and no UUID, and Cancel spawns nothing', async t => {
  const h = setup(t, { old: [B, C], [B]: [], [C]: [] });
  dialogs(h);
  h.ctx.sessionMap.get('old').name = 'Clicked';
  h.ctx.sessionMap.get(B).name = 'Named part';
  const pending = h.click();
  const dialog = await mounted(h, pending);
  assert.equal(h.dom.window.document.querySelectorAll('.choice-dialog').length, 1);
  assert.equal(dialog.querySelectorAll('input[type=radio]').length, 3);
  assert.match(dialog.textContent, /Named part/);
  assert.doesNotMatch(dialog.textContent, /[a-f]{8}-0000/);
  assert.equal(h.dom.window.document.activeElement.textContent, 'Open');
  dialog.querySelector('.choice-dialog-cancel').click();
  await pending;
  assert.deepEqual(h.spawned, []);
});
test('D2 background without job id is disabled; scheduled part is enabled and choosing it asks Resume anyway without a second probe', async t => {
  const h = setup(t, { old: ['a', 'b'], a: [], b: [] }, { live: { a: { kind: 'bg' }, b: { kind: 'schedule', scheduleName: 'Build', pid: 7 } } });
  dialogs(h);
  const probe = t.mock.method(h.ctx.api, 'getSessionLiveElsewhere');
  const pending = h.click();
  let dialog = await mounted(h, pending);
  assert.equal(dialog.querySelector('[data-choice-id="a"]').disabled, true);
  assert.match(dialog.textContent, /running in the background, cannot be attached/);
  const scheduled = dialog.querySelector('[data-choice-id="b"]');
  assert.equal(scheduled.disabled, false);
  scheduled.click();
  dialog.querySelector('.choice-dialog-confirm').click();
  dialog = await mounted(h, pending);
  assert.match(dialog.textContent, /Session running elsewhere/);
  assert.match(dialog.textContent, /in a scheduled run of "Build"/);
  dialog.querySelector('.choice-dialog-confirm').click();
  await pending;
  assert.deepEqual(h.spawned.map(s => s.id), ['b']);
  assert.equal(probe.mock.callCount(), 0);
});
test('D3 failed liveness batch states uncertainty and rechecks the selected part', async t => {
  const h = setup(t, { old: ['a', 'b'], a: [], b: [] });
  dialogs(h);
  h.ctx.api.getSessionsLiveElsewhere = async () => { throw new Error('IPC failed'); };
  const probe = t.mock.method(h.ctx.api, 'getSessionLiveElsewhere');
  const pending = h.click();
  const dialog = await mounted(h, pending);
  assert.match(dialog.textContent, /Switchboard could not check which parts are running./);
  dialog.querySelector('[data-choice-id="b"]').click();
  dialog.querySelector('.choice-dialog-confirm').click();
  await pending;
  assert.deepEqual(h.spawned.map(s => s.id), ['b']);
  assert.equal(probe.mock.callCount(), 1);
});
test('all location words share chooser details and renderer data overrides the main fallback', async () => {
  const h = harness();
  h.opts.describe = id => id === B ? { name: 'Renderer name' } : {};
  h.opts.api.getSessionsLiveElsewhere = async () => ({ [B]: { kind: 'interactive' }, [C]: { kind: 'bg', jobId: 'job' } });
  await resolveResumeSession(session, h.opts);
  assert.equal(h.asked[0].options.find(o => o.id === B).label, 'Renderer name');
  assert.match(h.asked[0].options.find(o => o.id === B).detail, /running elsewhere/);
  assert.match(h.asked[0].options.find(o => o.id === C).detail, /running in the background$/);
  const here = harness();
  here.opts.describe = id => ({ name: id === B ? 'Here' : 'Other', runningHere: id === B });
  await resolveResumeSession(session, here.opts);
  assert.match(here.asked[0].options.find(o => o.id === B).detail, /running here/);
});

test('selected clicked row reuses its liveness while still checking every other row part', async () => {
  const checked = [], questions = [];
  assert.equal(await guardResume({ sessionId: A, mergedMemberIds: [B] }, {
    live: null,
    api: { getSessionsLiveElsewhere: async ids => { checked.push(ids); return { [B]: { kind: 'interactive', pid: 9 } }; } },
    confirm: async q => { questions.push(q); return false; },
  }), false);
  assert.deepEqual(checked, [[B]]);
  assert.equal(questions.length, 1);
});


test('choosing another row checks that target row members rather than the source row members', async () => {
  const h = harness(undefined, { choice: B });
  h.opts.describe = id => id === B ? { mergedMemberIds: ['target-mirror'] } : {};
  let selectedLive;
  h.opts.onLive = live => { selectedLive = live; };
  const chosen = await resolveResumeSession({ ...session, headSessionId: A, mergedMemberIds: ['source-mirror'] }, h.opts);
  const checked = [];
  const verdict = await guardResume(chosen, { live: selectedLive,
    api: { getSessionsLiveElsewhere: async ids => { checked.push(ids); return { 'target-mirror': { kind: 'interactive', pid: 7 } }; } },
    confirm: async () => false,
  });
  assert.equal(verdict, false);
  assert.deepEqual(checked, [['target-mirror']]);
});
