'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { continuationRollup } = require('../session-continuations');

const index = (ids, extra = {}) => JSON.stringify({ format: 3, complete: true, unresolved: false, mtime: 'now', ids, ...extra });
const row = (sessionId, ids = [], extra = {}) => ({ sessionId, folder: 'project', projectPath: '/project',
  fileMtime: 'now', continuationIndex: index(ids), ...extra });
const roll = (rows, options) => Object.fromEntries(continuationRollup(rows, options));

test('1: a linear chain rolls every later part into its root', () => {
  assert.deepEqual(roll([row('a', ['b']), row('b', ['c']), row('c')]), { b: 'a', c: 'a' });
});
test('2: a fork stays separate', () => {
  assert.deepEqual(roll([row('a', ['b', 'c']), row('b'), row('c')]), {});
});
test('3: convergence stays separate', () => {
  assert.deepEqual(roll([row('a', ['c']), row('b', ['c']), row('c')]), {});
});
test('4: rho and closed cycles stay separate', () => {
  assert.deepEqual(roll([row('a', ['b']), row('b', ['c']), row('c', ['b'])]), {});
  assert.deepEqual(roll([row('a', ['b']), row('b', ['a'])]), {});
});
for (const [name, extra] of [['5a', { mtime: 'old' }], ['5b', { complete: false }], ['5c', { unresolved: true }]]) {
  test(`${name}: an unproven interior index cannot roll`, () => {
    assert.deepEqual(roll([row('a', ['b']), row('b', [], { continuationIndex: index(['c'], extra) }), row('c')]), {});
  });
}
test('6: a null or stale final index can join', () => {
  for (const continuationIndex of [null, index([], { mtime: 'old' })]) {
    assert.deepEqual(roll([row('a', ['b']), row('b', [], { continuationIndex })]), { b: 'a' });
  }
});
test('7: an edge into the same non-null bridge is not a branch', () => {
  assert.deepEqual(roll([row('a', ['m', 'b'], { bridgeSessionId: 'bridge' }),
    row('m', [], { bridgeSessionId: 'bridge' }), row('b')]), { b: 'a' });
});
test('8: a dangling sibling counts as a branch', () => {
  assert.deepEqual(roll([row('a', ['missing', 'b']), row('b')]), {});
});

const danglingMirrorChain = () => [
  row('r', ['m', 'd'], { bridgeSessionId: 'bridge' }),
  row('m', ['b'], { bridgeSessionId: 'bridge', mergedIntoSessionId: 'r' }),
  row('b', ['c']), row('c'),
];

test('#789: a proven dangling sibling beside a lifted mirror edge rolls the chain', () => {
  assert.deepEqual(roll(danglingMirrorChain(), { initialScanComplete: true }), { b: 'r', c: 'r' });
});

test('#789: an incomplete initial scan keeps the dangling mirror chain split', () => {
  assert.deepEqual(roll(danglingMirrorChain(), { initialScanComplete: false }), {});
});

test('#789: two present successors stay split after the initial scan', () => {
  for (const ids of [['b', 'c'], ['d', 'b', 'c']]) {
    assert.deepEqual(roll([row('r', ids), row('b'), row('c')], { initialScanComplete: true }), {});
  }
});

test('#789: dangling-only successors retain their chain-ending and branch rules', () => {
  assert.deepEqual(roll([row('r', ['b']), row('b', ['d'])], { initialScanComplete: true }), { b: 'r' });
  assert.deepEqual(roll([row('r', ['b']), row('b', ['d1', 'd2'])], { initialScanComplete: true }), {});
});

test('#789: dangling exemption still requires proof from every source part', () => {
  for (const extra of [{ mtime: 'old' }, { complete: false }, { unresolved: true }, { format: 2 }]) {
    const rows = danglingMirrorChain();
    rows[1].continuationIndex = index(['b'], extra);
    assert.deepEqual(roll(rows, { initialScanComplete: true }), {});
  }
});
test('9: a single dangling tail ends the chain', () => {
  assert.deepEqual(roll([row('a', ['b']), row('b', ['missing'])]), { b: 'a' });
});

test('P10: an unproven final index with a sole missing target ends the chain', () => {
  for (const extra of [{ mtime: 'old' }, { complete: false }, { unresolved: true }]) {
    assert.deepEqual(roll([row('a', ['b']), row('b', [], { continuationIndex: index(['zz'], extra) })]), { b: 'a' });
    assert.deepEqual(roll([row('a', ['b']), row('b', [], { continuationIndex: index(['zz', 'missing'], extra) })]), {});
    assert.deepEqual(roll([row('a', ['b']), row('b', [], { continuationIndex: index(['zz', 'a'], extra) })]), {});
  }
});
test('9b: an unproven raw incoming edge blocks any chain member including mirrors', () => {
  for (const continuationIndex of [index(['m'], { mtime: 'old' }), index(['m'], { complete: false }),
    index(['m'], { unresolved: true }), index(['m'], { format: 2 }), '{"ids":["m"],broken']) {
    assert.deepEqual(roll([row('a', ['b']), row('b'), row('m', [], { mergedIntoSessionId: 'b' }),
      row('x', [], { continuationIndex })]), {});
  }
});
test('10: cross-project edges stay separate', () => {
  assert.deepEqual(roll([row('a', ['b']), row('b', [], { projectPath: '/elsewhere' })]), {});
});
test('10b: cross-folder edges stay separate', () => {
  assert.deepEqual(roll([row('a', ['b']), row('b', [], { folder: 'elsewhere' })]), {});
});
test('11: mirror edges lift to the representative and internal edges are ignored', () => {
  assert.deepEqual(roll([row('a'), row('m', ['a', 'b'], { mergedIntoSessionId: 'a' }), row('b')]), { b: 'a' });
});
test('12: an interior mirror with no index prevents rollup', () => {
  assert.deepEqual(roll([row('a', ['b']), row('m', [], { mergedIntoSessionId: 'a', continuationIndex: null }), row('b')]), {});
});
test('13: 32 hops roll and 33 hops do not', () => {
  const chain = hops => Array.from({ length: hops + 1 }, (_, i) => row(`s${i}`, i < hops ? [`s${i + 1}`] : []));
  assert.equal(continuationRollup(chain(32)).size, 32);
  assert.deepEqual(roll(chain(33)), {});
});
test('local top-level rows only, case-insensitive lookup and no-edge fast path', () => {
  assert.deepEqual(roll([row('a', ['B']), row('b')]), { b: 'a' });
  assert.deepEqual(roll([row('a', ['b'], { folder: 'host::project' }), row('b', [], { folder: 'host::project' })]), {});
  assert.deepEqual(roll([row('a', ['b'], { parentSessionId: 'parent' }), row('b')]), {});
  assert.deepEqual(roll([row('a'), row('b')]), {});
  const empty = row('empty');
  Object.defineProperty(empty, 'sessionId', { get() { throw new Error('no graph work for empty indexes'); } });
  assert.deepEqual(roll([empty]), {});
});
