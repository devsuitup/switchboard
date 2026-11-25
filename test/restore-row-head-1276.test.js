'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cache = require('../session-cache');
const { setup } = require('./continuations-harness');
const { loadAppFunctions } = require('./app-source');

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000a';
const JOB = 'bbbbbbbb';
const REFUSAL = { action: 'refuse', jobId: JOB, reason: `Job ${JOB} (blocked): blocked job was not respawned automatically`, recovery: 'respawn' };

function harness(t, { savedBackground = true, savedOlder = true, chosenPart = false, order = 'older-first', newest = B, merged = true, state = 'blocked', answer, refusal = REFUSAL, live = {}, graph, decorate, jobs } = {}) {
  const older = { sessionId: A, active: true, ...(chosenPart ? { chosenPart: B } : {}) };
  const background = { sessionId: B, active: false, bg: true, attachJobId: JOB };
  const savedEntries = [...(savedOlder ? [older] : []), ...(savedBackground ? [background] : [])];
  if (order === 'background-first') savedEntries.reverse();
  const h = setup(t, graph || { parent: ['sibling', A], sibling: [], [A]: [B], [B]: [] }, { savedEntries, live });
  for (const item of h.saved) item.projectPath = h.root;
  for (const row of h.rows.values()) row.modified = row.sessionId === newest ? '2026-11-25T17:53:41Z' : '2026-11-19T08:00:00Z';
  decorate?.(h.rows);
  cache.init({ PROJECTS_DIR: h.root, db: { ...h.db, isInitialScanComplete: () => true, getAllCached: () => [...h.rows.values()] },
    activeSessions: new Map(), getMainWindow: () => null, log: console, getLocalDescriptors: () => [],
    getLocalJobs: () => jobs || new Map([[JOB, { state, sessionId: B }]]) });
  const rows = cache.buildProjectsFromCache(false).flatMap(project => project.sessions);
  h.ctx.sessionMap.clear();
  for (const row of rows) {
    if (merged || row.sessionId !== A) h.ctx.sessionMap.set(row.sessionId, row);
    else {
      h.ctx.sessionMap.set(A, { ...row, headSessionId: A, mergedMemberIds: [], refusedJobState: undefined });
      h.ctx.sessionMap.set(B, { ...row, sessionId: B, headSessionId: B, mergedMemberIds: [] });
    }
  }
  const calls = { restored: [], verbs: [], prompts: [] };
  let alive = false;
  h.dom.window.api.restoreBackgroundJob = async id => {
    calls.restored.push(id);
    return alive ? { action: 'attach', sessionId: B, jobId: JOB } : refusal;
  };
  const liveElsewhere = h.dom.window.api.getSessionLiveElsewhere;
  h.dom.window.api.getSessionLiveElsewhere = async id => alive && id === B ? { kind: 'bg', jobId: JOB, cwd: h.root } : liveElsewhere(id);
  h.dom.window.api.getSessionsLiveElsewhere = async ids => alive && ids.includes(B) ? { [B]: { kind: 'bg', jobId: JOB, cwd: h.root } }
    : Object.fromEntries(ids.filter(id => live[id]).map(id => [id, live[id]]));
  h.dom.window.api.bgAgentVerb = async (verb, id) => { calls.verbs.push([verb, id]); alive = true; return { ok: true }; };
  h.revive = () => { alive = true; };
  h.dom.window.appChoose = async question => { calls.prompts.push(question); return answer ? { choice: answer } : null; };
  const row = () => h.ctx.sessionMap.get(A);
  const openRow = async (id) => {
    await h.app.openSession(id ? h.ctx.rowHeadSession(row(), id) : h.ctx.rowHeadSession(row()));
    await h.app.persistWorkingSet();
  };
  return { ...h, ...calls, calls, row, openRow, notices: () => h.dom.window.document.querySelector('#app-notices').textContent };
}

const savedIds = h => h.settings().openWorkingSet.map(item => item.sessionId).sort();

for (const order of ['older-first', 'background-first']) {
  for (const newest of [B, A]) {
    test(`#1276 restore starts neither part when the job is refused (${order}, newest ${newest === B ? 'background' : 'other'})`, async t => {
      const h = harness(t, { order, newest });
      await h.restore();
      assert.deepEqual(h.spawned, []);
      assert.deepEqual(h.calls.verbs, []);
      assert.deepEqual(h.calls.prompts, []);
      assert.deepEqual(savedIds(h), [A, B]);
      assert.equal(h.settings().openWorkingSet.find(item => item.sessionId === B).bg, true);
      assert.equal(h.settings().openWorkingSet.find(item => item.sessionId === B).attachJobId, JOB);
      assert.equal(h.settings().openWorkingSet.find(item => item.sessionId === A).bg, undefined);
      assert.match(h.notices(), /blocked job was not respawned automatically/);
      assert.match(h.notices(), /Respawn/);
    });
  }
}

test('#1276 restore holds both parts before the sidebar has merged them', async t => {
  const h = harness(t, { merged: false });
  await h.restore();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.calls.prompts, []);
  assert.deepEqual(savedIds(h), [A, B]);
  assert.equal(h.settings().openWorkingSet.find(item => item.sessionId === B).bg, true);
});

test('#1276 restore of the older part alone does not resume its blocked continuation or the older part', async t => {
  for (const merged of [true, false]) {
    const h = harness(t, { savedBackground: false, merged });
    await h.restore();
    assert.deepEqual(h.spawned, []);
    assert.deepEqual(savedIds(h), [A]);
  }
});

test('#1276 opening the row asks once and opens nothing when cancelled', async t => {
  const h = harness(t, { savedOlder: false });
  await h.restore();
  await h.openRow();
  assert.deepEqual(h.spawned, []);
  assert.equal(h.calls.prompts.length, 1);
  const [question] = h.calls.prompts;
  assert.equal(question.title, 'Background session not restored');
  assert.equal(question.selectedId, 'background');
  assert.deepEqual(Array.from(question.options, option => option.id), ['background', 'part:' + A]);
  assert.equal(question.options[0].label, 'Respawn the background session');
  assert.match(question.options[1].detail, /older than the background session/);
  assert.match(question.message.join('\n'), /blocked job was not respawned automatically/);
  assert.deepEqual(savedIds(h), [B]);
});

for (const part of [A, undefined]) {
  test(`#1276 choosing Respawn from ${part ? 'the older part' : 'the row'} attaches the refused job`, async t => {
    const h = harness(t, { savedOlder: false, answer: 'background', newest: part ? A : B });
    await h.restore();
    await h.openRow(part);
    assert.deepEqual(h.calls.verbs, [['respawn', JOB]]);
    assert.deepEqual(h.spawned.map(call => [call.id, call.options.type, call.options.jobId]), [[B, 'attach', JOB]]);
    assert.equal(h.calls.prompts.length, 1);
    assert.deepEqual(h.settings().openWorkingSet.map(item => [item.sessionId, item.bg, item.attachJobId]), [[B, true, JOB]]);
    assert.equal(h.notices(), '');
  });
}

test('#1276 a failed Respawn opens nothing and keeps the saved background entry', async t => {
  const h = harness(t, { savedOlder: false, answer: 'background' });
  await h.restore();
  h.dom.window.api.bgAgentVerb = async () => ({ ok: false, error: 'daemon unavailable' });
  await h.openRow();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(savedIds(h), [B]);
  assert.match(h.notices(), /daemon unavailable/);
});

test('#1276 choosing the older part opens it, releases the background entry and is kept at the next restore', async t => {
  const h = harness(t, { answer: 'part:' + A });
  await h.restore();
  await h.openRow();
  assert.deepEqual(h.spawned.map(call => [call.id, call.options.type]), [[A, undefined]]);
  assert.deepEqual(h.calls.verbs, []);
  assert.deepEqual(JSON.parse(JSON.stringify(h.settings().openWorkingSet)), [{ sessionId: A, projectPath: h.root, active: true, chosenPart: B }]);
  assert.equal(h.notices(), '');

  const next = harness(t, { savedBackground: false, chosenPart: true });
  await next.restore();
  assert.deepEqual(next.spawned.map(call => call.id), [A]);
  assert.equal(next.settings().openWorkingSet[0].chosenPart, B);
  assert.deepEqual(next.calls.prompts, []);
});

test('#1276 a resume that starts elsewhere while the question is open still keeps the background entry', async t => {
  const h = harness(t, { savedOlder: false, answer: 'part:' + A });
  await h.restore();
  h.dom.window.api.getSessionsLiveElsewhere = async () => ({ [A]: { kind: 'interactive', pid: 4 } });
  h.dom.window.appConfirm = async () => false;
  await h.openRow();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(savedIds(h), [B]);
});

test('#1276 an undetermined worker never opens the older part by itself and offers another try', async t => {
  const h = harness(t, { savedOlder: false, refusal: { action: 'refuse', jobId: JOB, reason: 'conversation liveness unknown' } });
  await h.restore();
  await h.openRow();
  assert.deepEqual(h.spawned, []);
  assert.equal(h.calls.prompts[0].options[0].label, 'Try the background session again');
});

test('#1276 a saved older part still shows the attached background tab of its row', async t => {
  const h = harness(t, { live: { [B]: { kind: 'bg', jobId: JOB } }, refusal: { action: 'attach', sessionId: B, jobId: JOB } });
  await h.restore();
  assert.deepEqual(h.spawned.map(call => [call.id, call.options.type]), [[B, 'attach']]);
});

test('#1276 opening a part that is not the head lists the refused head instead of dropping it', async t => {
  const h = harness(t, { savedBackground: false, savedOlder: false, answer: A });
  const part = { ...h.row(), sessionId: A, mergedMemberIds: [B] };
  await h.app.openSession(part);
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(h.calls.prompts[0].title, 'Open which part?');
  assert.deepEqual(new Set(Array.from(h.calls.prompts[0].options, option => option.id)), new Set([A, B]));
  assert.deepEqual(h.spawned.map(call => call.id), [A]);
});

test('#1276 a chosen part that continued again is still followed', async t => {
  for (const merged of [true, false]) {
    const h = harness(t, { savedBackground: false, chosenPart: true, merged });
    h.dom.window.api.getSessionContinuations = async () => ({ candidates: [{ sessionId: B }, { sessionId: 'next' }], unresolved: false });
    await h.restore();
    assert.deepEqual(h.spawned.map(call => call.id), ['next']);
  }
});

const C = 'cccccccc-0000-4000-8000-00000000000a';
const mirror = rows => {
  const c = rows.get(C);
  Object.assign(c, { mergedIntoSessionId: A, bridgeSessionId: 'cse_same', modified: '2026-11-26T12:00:00Z' });
  rows.get(A).bridgeSessionId = 'cse_same';
};

for (const [name, graph] of [['a later mirror', { parent: ['sibling', A], sibling: [], [A]: [B], [B]: [], [C]: [] }],
  ['a mirror A also points to', { parent: ['sibling', A], sibling: [], [A]: [B, C], [B]: [], [C]: [] }]]) {
  test(`#1276 a chosen part still follows ${name} of its own (review R3)`, async t => {
    const h = harness(t, { savedBackground: false, chosenPart: true, graph, decorate: mirror });
    assert.equal(h.row().headSessionId, C);
    await h.restore();
    assert.deepEqual(h.spawned.map(call => call.id), [C]);
  });
}

test('#1276 a stale choice does not pin the old part of a different continuation (review)', async t => {
  const h = harness(t, { savedBackground: false, chosenPart: true, newest: C, graph: { [A]: [C], [C]: [] }, jobs: new Map() });
  assert.equal(h.row().headSessionId, C);
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), [C]);
});

test('#1276 a released background entry is not consent to start the other part (review R2)', async t => {
  for (const refusal of [{ action: 'refuse', missing: true, reason: 'background job not found' }, { action: 'retire', jobId: JOB }]) {
    const h = harness(t, { newest: A, refusal });
    await h.restore();
    assert.deepEqual(h.spawned, []);
    assert.ok(h.settings().openWorkingSet.some(item => item.sessionId === A));
  }
});

test('#1276 a click on a refused head that was never saved asks instead of resuming it (review R1)', async t => {
  const h = harness(t, { savedBackground: false });
  await h.restore();
  await h.openRow();
  assert.deepEqual(h.spawned, []);
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(h.calls.prompts[0].title, 'Background session not restored');
  assert.deepEqual(savedIds(h), [A]);
});

test('#1276 Respawn from a refused head that was never saved attaches to it', async t => {
  const h = harness(t, { savedBackground: false, answer: 'background' });
  await h.restore();
  await h.openRow();
  assert.deepEqual(h.calls.verbs, [['respawn', JOB]]);
  assert.deepEqual(h.spawned.map(call => [call.id, call.options.type, call.options.jobId]), [[B, 'attach', JOB]]);
  assert.deepEqual(h.settings().openWorkingSet.map(item => [item.sessionId, !!item.bg]).sort(), [[A, false], [B, true]]);
});

test('#1276 a refused head that was never saved can be skipped for the older part', async t => {
  const h = harness(t, { savedBackground: false, answer: 'part:' + A });
  await h.restore();
  await h.openRow();
  assert.deepEqual(h.spawned.map(call => call.id), [A]);
  assert.equal(h.settings().openWorkingSet.find(item => item.sessionId === A).chosenPart, B);
});

for (const [name, saved, expected] of [
  ['without a choice', { sessionId: A, active: true }, []],
  ['after a choice', { sessionId: A, active: true, chosenPart: B }, [A]],
]) {
  test(`#1276 the remembered active older part ${name}`, async t => {
    const h = harness(t, { savedBackground: !saved.chosenPart });
    h.ctx.activeSessionId = A;
    h.ctx.api.getActiveSessions = async () => [];
    h.ctx.api.getSetting = async () => ({ restoreOnStartup: 'auto', openWorkingSet: [saved, ...(saved.chosenPart ? [] : [{ sessionId: B, bg: true, attachJobId: JOB }])] });
    const { reopenActiveSessionAfterReload } = loadAppFunctions(h.ctx, { functions: ['reopenActiveSessionAfterReload'], sourcePath: path.join(__dirname, '../public/app.js') });
    await reopenActiveSessionAfterReload();
    assert.deepEqual(h.spawned.map(call => call.id), expected);
  });
}
