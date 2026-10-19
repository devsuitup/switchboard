'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveResumeSession } = require('../public/resume-guard');

function harness(ids = ['b', 'c'], record = { chosen: 'b', candidates: ['b', 'c'] }) {
  const choices = new Map(record ? [['continuationChoice:root', record]] : []);
  const asked = [], writes = [], deleted = [], notices = [], lookups = [];
  const opts = { choices, rowKey: 'root',
    api: {
      getSessionContinuations: async id => { lookups.push(id); return { candidates: (id === 'a' ? ids : []).map(sessionId => ({ sessionId, modified: sessionId === 'b' ? '2026-10-18' : '2026-10-19' })) }; },
      getSessionsLiveElsewhere: async () => ({}),
      setSetting: async (key, value) => { writes.push([key, value]); },
      deleteSetting: async key => { deleted.push(key); },
    },
    choose: async q => { asked.push(q); return null; }, confirm: async () => false,
    memoryNotify: n => notices.push(n),
  };
  const open = extra => resolveResumeSession({ sessionId: 'a' }, { ...opts, ...extra });
  return { opts, choices, asked, writes, deleted, notices, lookups, open };
}

test('T3 valid memory opens the chosen part without a dialog and resolves afresh', async () => {
  const h = harness();
  assert.equal((await h.open()).sessionId, 'b');
  assert.equal((await h.open()).sessionId, 'b');
  assert.deepEqual(h.asked, []);
  assert.deepEqual(h.lookups, ['a', 'a']);
});
for (const [name, ids] of [['T4 new candidate', ['b', 'c', 'd']], ['T5b same-size swap', ['b', 'd']]]) {
  test(name + ' asks with remembered choice preselected', async () => {
    const h = harness(ids);
    assert.equal(await h.open(), null);
    assert.equal(h.asked[0].selectedId, 'b');
  });
}
test('T5 missing chosen part with no continuation asks again', async () => {
  const h = harness(['c']);
  assert.equal(await h.open(), null);
  assert.equal(h.asked.length, 1);
});
test('T5c disappearing unchosen part narrows the record without asking', async () => {
  const h = harness(['b']);
  assert.equal((await h.open()).sessionId, 'b');
  assert.deepEqual(h.writes, [['continuationChoice:root', { chosen: 'b', candidates: ['b'] }]]);
  assert.deepEqual(h.asked, []);
});
test('T6 linear row forgets its stale record', async () => {
  const h = harness([]);
  assert.equal((await h.open()).sessionId, 'a');
  assert.equal(h.choices.size, 0);
  assert.deepEqual(h.deleted, ['continuationChoice:root']);
});
test('T7 Cancel stores nothing and preserves an invalidated record', async () => {
  const h = harness(['b', 'd']);
  await h.open();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.choices.get('continuationChoice:root'), { chosen: 'b', candidates: ['b', 'c'] });
});
test('T8 automatic restore uses valid memory before ambiguity holds', async () => {
  const h = harness();
  assert.equal((await h.open({ automatic: true })).sessionId, 'b');
  assert.deepEqual(h.asked, []);
});
for (const state of ['unresolved', 'failed']) {
  test('T10 ' + state + ' graph neither applies nor writes memory', async () => {
    const h = harness();
    h.opts.api.getSessionContinuations = async () => {
      if (state === 'failed') throw new Error('lookup failed');
      return { unresolved: true, candidates: [{ sessionId: 'b' }] };
    };
    h.opts.choose = async q => { h.asked.push(q); return { choice: 'b' }; };
    assert.equal(await h.open({ automatic: true }), null);
    await h.open();
    assert.equal(h.asked.length, state === 'failed' ? 0 : 1);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.deleted, []);
  });
}
test('T11 chooseAgain preselects memory and Cancel keeps it', async () => {
  const h = harness();
  assert.equal(await h.open({ chooseAgain: true }), null);
  assert.equal(h.asked[0].selectedId, 'b');
  assert.deepEqual(h.writes, []);
  assert.equal(h.choices.get('continuationChoice:root').chosen, 'b');
});
test('T12 remembered clicked part opens the current row head', async () => {
  const h = harness(undefined, { chosen: null, candidates: ['b', 'c'] });
  assert.equal((await h.open()).sessionId, 'a');
  assert.deepEqual(h.asked, []);
});
for (const choice of ['b', 'a']) {
  test('T13 choosing ' + choice + ' stores the sorted candidates separately from global settings', async () => {
    const h = harness(['c', 'b'], null);
    h.opts.choose = async () => ({ choice });
    assert.equal((await h.open()).sessionId, choice);
    assert.deepEqual(h.writes, [['continuationChoice:root', { chosen: choice === 'a' ? null : choice, candidates: ['b', 'c'] }]]);
  });
}
test('T14 linearly continued choice follows and updates its record', async () => {
  const h = harness(['b2', 'c']);
  h.opts.api.getSessionContinuations = async id => ({ candidates: (id === 'b' ? ['b2'] : ['b2', 'c']).map(sessionId => ({ sessionId })) });
  assert.equal((await h.open()).sessionId, 'b2');
  assert.deepEqual(h.writes, [['continuationChoice:root', { chosen: 'b2', candidates: ['b2', 'c'] }]]);
  assert.deepEqual(h.asked, []);
});
for (const [name, current, next] of [
  ['T15 branched choice', ['b2', 'b3', 'c'], { candidates: [{ sessionId: 'b2' }, { sessionId: 'b3' }] }],
  ['T16 new sibling', ['b2', 'c', 'd'], { candidates: [{ sessionId: 'b2' }] }],
  ['T17 unresolved chosen lookup', ['b2', 'c'], { candidates: [{ sessionId: 'b2' }], unresolved: true }],
  ['T17 failed chosen lookup', ['b2', 'c'], null],
]) {
  test(name + ' asks instead of following', async () => {
    const h = harness(current);
    h.opts.api.getSessionContinuations = async id => {
      if (id === 'b') { if (!next) throw new Error('unavailable'); return next; }
      return { candidates: current.map(sessionId => ({ sessionId })) };
    };
    assert.equal(await h.open(), null);
    assert.equal(h.asked.length, 1);
    assert.deepEqual(h.writes, []);
  });
}
for (const record of [null, {}, { chosen: 7, candidates: ['b'] }, { chosen: 'b', candidates: [1] }, { chosen: 'b', candidates: ['c'] }, { chosen: 'b', candidates: 'b' }]) {
  test('malformed persisted record asks safely: ' + JSON.stringify(record), async () => {
    const h = harness(undefined, record);
    assert.equal(await h.open(), null);
    assert.equal(h.asked.length, 1);
  });
}
test('S7 pending and rejected writes do not delay opening and report the persistence failure', async () => {
  const h = harness(undefined, null);
  h.opts.choose = async () => ({ choice: 'b' });
  let reject;
  h.opts.api.setSetting = () => new Promise((_, fail) => { reject = fail; });
  assert.equal((await h.open()).sessionId, 'b');
  reject(new Error('disk full'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notices[0].kind, 'error');
  assert.equal(h.notices[0].message, 'Switchboard could not remember this choice: disk full. It will ask again next time.');
  assert.equal(h.choices.size, 0);
});

test('T10 incomplete chooser ignores remembered preselection', async () => {
  const h = harness();
  h.opts.api.getSessionContinuations = async () => ({ unresolved: true, candidates: [{ sessionId: 'c' }, { sessionId: 'b' }] });
  await h.open();
  assert.equal(h.asked[0].selectedId, 'c');
});

test('malformed string candidates cannot silently reuse a persisted choice', async () => {
  const h = harness(undefined, { chosen: 'b', candidates: 'bc' });
  assert.equal(await h.open(), null);
  assert.equal(h.asked.length, 1);
  assert.deepEqual(h.writes, []);
});

test('a choice absent from its recorded candidates cannot follow a continuation silently', async () => {
  const h = harness(['b2', 'c'], { chosen: 'b', candidates: ['b2', 'c'] });
  h.opts.api.getSessionContinuations = async id => {
    h.lookups.push(id);
    return { candidates: (id === 'b' ? ['b2'] : ['b2', 'c']).map(sessionId => ({ sessionId })) };
  };
  assert.equal(await h.open(), null);
  assert.equal(h.asked.length, 1);
  assert.deepEqual(h.lookups, ['a']);
  assert.deepEqual(h.writes, []);
});

test('T10 waiting for indexing with zero candidates neither reads nor writes the saved choice', async () => {
  const h = harness([]);
  const record = h.choices.get('continuationChoice:root');
  const reads = [];
  h.choices.get = key => { reads.push(key); return Map.prototype.get.call(h.choices, key); };
  h.opts.api.getSessionContinuations = async () => ({ unresolved: true, waitingForIndex: true, candidates: [] });
  const holds = [];
  assert.equal(await h.open({ automatic: true, onHold: reason => holds.push(reason) }), null);
  assert.equal(await h.open(), null);
  assert.deepEqual(holds, [{ waitingForIndex: true }]);
  assert.deepEqual(reads, []);
  assert.equal(Map.prototype.get.call(h.choices, 'continuationChoice:root'), record);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.deleted, []);
});

test('a rejected delete reports that the earlier choice could not be forgotten', async () => {
  const h = harness([]);
  h.opts.api.deleteSetting = async () => { throw new Error('disk full'); };
  assert.equal((await h.open()).sessionId, 'a');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.choices.size, 0);
  assert.equal(h.notices[0].kind, 'error');
  assert.equal(h.notices[0].message, 'Switchboard could not forget the earlier choice: disk full. It is still saved for the next restart.');
});
