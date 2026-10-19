'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveResumeSession, guardResume } = require('../public/resume-guard');
const { setup } = require('./continuations-harness');
const cache = require('../session-cache');
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
  assert.equal(q.message[1], 'Switchboard opens your choice directly next time, as long as it is still there and no new part appears. To choose again, use Choose part to open in the row\'s menu.');
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
  metadata.new = { name: 'Renamed plan', nameSource: 'user', nameRevision: 1 };
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
    live: null, freshLive: true,
    api: { getSessionsLiveElsewhere: async ids => { checked.push(ids); return { [B]: { kind: 'interactive', pid: 9 } }; } },
    confirm: async q => { questions.push(q); return false; },
  }), false);
  assert.deepEqual(checked, [[B]]);
  assert.equal(questions.length, 1);
});


test('choosing another row opens its head and checks its representative and every member', async () => {
  const h = harness(undefined, { choice: B });
  h.opts.resolveRow = candidate => candidate.sessionId === B
    ? { sessionId: C, headSessionId: C, mergedMemberIds: [B, 'target-root'] } : candidate;
  let selectedLive;
  h.opts.onLive = live => { selectedLive = live; };
  const chosen = await resolveResumeSession({ ...session, headSessionId: A, mergedMemberIds: ['source-mirror'] }, h.opts);
  const checked = [];
  assert.equal(chosen.sessionId, C);
  const verdict = await guardResume(chosen, { live: selectedLive, freshLive: true,
    api: { getSessionsLiveElsewhere: async ids => { checked.push(ids); return { 'target-root': { kind: 'interactive', pid: 7 } }; } },
    confirm: async () => false,
  });
  assert.equal(verdict, false);
  assert.deepEqual(checked, [[B, 'target-root']]);
});

function mergeTarget(h) {
  const row = h.rows.get('y');
  Object.assign(row, { headSessionId: 'z', mergedMemberIds: ['z', 'x'] });
  h.ctx.sessionMap.delete('x');
  h.ctx.sessionMap.delete('z');
  return row;
}

test('chosen member of another row asks once when its representative is live and Cancel spawns nothing', async t => {
  const h = setup(t, { old: ['x', 'b'], x: [], b: [], y: [], z: [] }, {
    choice: 'x', live: { y: { kind: 'interactive', pid: 71 } },
  });
  mergeTarget(h);
  await h.click();
  assert.equal(h.prompts.length, 2);
  assert.match(h.prompts[1][0], /pid 71/);
  assert.deepEqual(h.spawned, []);
});

test('chosen non-head member of another row opens that row head with all its parts', async t => {
  const h = setup(t, { old: ['x', 'b'], x: [], b: [], y: [], z: [] }, { choice: 'x' });
  mergeTarget(h);
  await h.click();
  assert.deepEqual(h.spawned.map(call => call.id), ['z']);
  assert.deepEqual(Array.from(h.ctx.openSessions.get('z').session.mergedMemberIds), ['x', 'y']);
});

test('two candidate members of one other row give one option', async t => {
  const h = setup(t, { old: ['x', 'z'], x: [], y: [], z: [] });
  mergeTarget(h);
  await h.click();
  assert.equal(h.prompts[0].options.length, 2);
  assert.match(h.prompts[0].message[0], /continues in another part/);
});

test('candidate date and count survive newer larger renderer row metadata', async () => {
  const h = harness({ candidates: [candidates[0]] });
  h.opts.describe = id => id === B ? { name: 'Named row', modified: '2099-01-01', messageCount: 999 } : {};
  await resolveResumeSession({ ...session, modified: '2026-10-19' }, h.opts);
  const question = h.asked[0];
  assert.equal(question.selectedId, A);
  assert.deepEqual(question.options.map(option => option.id), [A, B]);
  assert.match(question.options[1].detail, /2026-10-18T00:00:00.000Z · 1 message$/);
});

test('merged guard rechecks supplied stale head liveness outside the chooser', async () => {
  const checked = [];
  const verdict = await guardResume({ sessionId: A, mergedMemberIds: [B] }, {
    automatic: true, live: null,
    api: { getSessionsLiveElsewhere: async ids => { checked.push(ids); return ids.includes(A) ? { [A]: { kind: 'interactive', pid: 9 } } : {}; } },
    confirm: () => assert.fail('automatic opens never ask'),
  });
  assert.equal(verdict, false);
  assert.deepEqual(checked, [[A, B]]);
});

for (const [raw, expected] of [
  ['<command>Build the project</command>', 'Build the project'],
  ['Implement the following plan: Fix the chooser', 'Fix the chooser'],
  ['x'.repeat(300), 'x'.repeat(200)],
]) {
  test('main cleans and caps fallback candidate title: ' + expected.slice(0, 24), async t => {
    const h = setup(t, { old: ['new'], new: [] });
    h.rows.get('new').customTitle = raw;
    assert.equal((await h.ctx.api.getSessionContinuations('old')).candidates[0].title, expected);
  });
}

test('main candidate title uses the latest user rename across its conversation', async t => {
  const metadata = {
    new: { name: 'Earlier', nameSource: 'user', nameRevision: 1 },
    mirror: { name: 'Latest rename', nameSource: 'user', nameRevision: 2 },
  };
  const h = setup(t, { old: ['new'], new: [], mirror: [] }, { metadata });
  h.rows.get('mirror').mergedIntoSessionId = 'new';
  assert.equal((await h.ctx.api.getSessionContinuations('old')).candidates[0].title, 'Latest rename');
});

for (const openId of ['y', 'x', 'z']) {
  test(`chosen row with ${openId} open shows its tab and marks the option running here`, async t => {
    const h = setup(t, { old: ['x', 'b'], x: [], b: [], y: [], z: [] }, { choice: 'x' });
    mergeTarget(h);
    h.ctx.openSessions.set(openId, { session: { sessionId: openId, projectPath: h.root } });
    await h.click();
    assert.deepEqual(h.spawned, [], 'an open part must be shown without spawning the head');
    assert.equal(h.ctx.activeSessionId, openId);
    assert.match(h.prompts[0].options.find(option => option.id === 'x').detail, /running here/);
  });
}

test('zero continuation candidates skip every enrichment helper', async t => {
  const h = setup(t, { old: [] });
  const called = [];
  const record = (name, value) => () => { called.push(name); return value; };
  cache.init({ PROJECTS_DIR: h.root, activeSessions: new Map(), getMainWindow: () => null, log: console,
    db: { ...h.db, getAllCached: record('cache', [...h.rows.values()]), getAllMeta: record('meta', new Map()) },
    getLocalDescriptors: record('descriptors', []), getLocalJobs: record('jobs', new Map()),
  });
  const result = await h.ctx.api.getSessionContinuations('old');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.unresolved, false);
  assert.deepEqual(called, []);
});

for (const failing of ['getAllCached', 'getLocalDescriptors', 'getLocalJobs', 'getAllMeta']) {
  test(`continuation enrichment failure in ${failing} retains candidates without titles or counts and logs once`, async t => {
    const h = setup(t, { old: ['a', 'b'], a: [], b: [] });
    const warnings = [];
    const fail = () => { throw new Error('enrichment unavailable'); };
    const context = { PROJECTS_DIR: h.root, activeSessions: new Map(), getMainWindow: () => null,
      log: { warn: (...args) => warnings.push(args.join(' ')) }, db: { ...h.db } };
    if (failing.startsWith('getLocal')) context[failing] = fail;
    else context.db[failing] = fail;
    cache.init(context);
    const result = await h.ctx.api.getSessionContinuations('old');
    assert.equal(result.unresolved, false);
    assert.deepEqual(result.candidates.map(candidate => candidate.sessionId), ['a', 'b']);
    for (const candidate of result.candidates) {
      assert.equal(candidate.title, null);
      assert.equal(Object.hasOwn(candidate, 'messageCount'), false);
      assert.ok(candidate.modified);
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /enrichment unavailable/);
  });
}

test('deduplicated option shows the opened head name date and own count from the sidebar payload', async t => {
  const h = setup(t, { old: ['x', 'b'], x: [], b: [], y: [], z: [] }, { choice: 'x' });
  Object.assign(h.rows.get('old'), { modified: '2026-10-20T12:00:00Z' });
  Object.assign(h.rows.get('x'), { mergedIntoSessionId: 'y', aiTitle: 'First candidate', modified: '2026-10-18T12:00:00Z', messageCount: 1 });
  Object.assign(h.rows.get('y'), { aiTitle: 'Representative', modified: '2026-10-17T12:00:00Z', messageCount: 100 });
  Object.assign(h.rows.get('z'), { mergedIntoSessionId: 'y', aiTitle: 'Opened head', modified: '2026-10-21T12:00:00Z', messageCount: 7 });
  const projects = cache.buildProjectsFromCache(false);
  h.ctx.sessionMap.clear();
  for (const project of projects) for (const row of project.sessions) h.ctx.sessionMap.set(row.sessionId, row);
  await h.click();
  assert.deepEqual(h.spawned.map(call => call.id), ['z']);
  const question = h.prompts[0];
  const option = question.options.find(part => part.id === 'x');
  assert.equal(option.label, 'Opened head');
  assert.match(option.detail, /7 messages$/);
  assert.ok(option.detail.includes(new Date('2026-10-21T12:00:00Z').toLocaleString()));
  assert.equal(question.selectedId, 'x', 'preselection follows the head activity, not the first member');
});
