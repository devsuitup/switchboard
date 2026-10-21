'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inventory } = require('../session-exit');
const { backgroundRefusal } = require('../bg-handoff');

test('C2 inventory classifies ready, busy and refused sessions with the main reason', () => {
  const cases = [
    ['idle', 'ready', {}], ['busy', 'busy', {}],
    ['busy', 'refused', { sandbox: true }], ['busy', 'refused', { composerState: { text: 'unsent' } }],
    ['waiting', 'refused', {}], ['shell', 'refused', {}], [undefined, 'refused', {}],
    ['busy', 'refused', { preLaunch: true }], ['busy', 'refused', { backgrounding: true }],
  ];
  for (const [status, expected, extra] of cases) {
    const record = { kind: 'local-pty', pty: {}, status, ...extra };
    const [row] = inventory(new Map([['tab', record]]), (r, _id, override) => backgroundRefusal(r, override ?? r.status)).rows;
    assert.equal(row.background, expected, `${status} ${JSON.stringify(extra)}`);
    assert.equal(row.reason, backgroundRefusal(record, status));
    assert.equal(row.canBackground, expected === 'ready');
  }
  for (const extra of [{ isPlainTerminal: true }, { panelFor: 'tab' }]) {
    const [row] = inventory(new Map([['other', { kind: 'local-pty', pty: {}, ...extra }]])).rows;
    assert.equal('background' in row, false);
    assert.equal('reason' in row, false);
  }
});

test('A1 inventory names each local process regardless of activity, aliases or sidebar visibility', () => {
  const local = (extra = {}) => ({ kind: 'local-pty', pty: {}, cwd: '/work', ...extra });
  const idle = local({ status: 'idle' });
  const records = new Map([
    ['idle', idle], ['alias', idle], ['busy', local({ status: 'busy' })],
    ['plain', local({ isPlainTerminal: true })], ['hidden', local({ panelFor: 'idle' })],
    ['same-transcript', local({ sessionId: 'idle' })], ['attach', local({ isAttach: true })],
    ['remote', { kind: 'remote-attach', pty: {}, host: 'vps' }],
    ['exited', local({ exited: true })], ['dormant', { kind: 'local-pty' }],
    ['background', { kind: 'background', pty: {} }],
  ]);
  const snapshot = inventory(records, () => null);
  assert.deepEqual(snapshot.counts, { sessions: 3, plain: 1, panels: 1, attached: 1 });
  assert.deepEqual(snapshot.rows.map(({ id, type }) => [id, type]), [
    ['idle', 'session'], ['busy', 'session'], ['plain', 'plain'], ['hidden', 'panel'], ['same-transcript', 'session'],
  ]);
  assert.deepEqual(snapshot.remote, { vps: 1 });
  assert.ok(snapshot.rows.every(row => row.cwd === '/work' && row.generation));
  assert.equal(snapshot.rows.find(row => row.id === 'hidden').owner, 'idle');
});

test('#769 backgrounded sources are neither listed nor counted under their old or new id', () => {
  for (const id of ['source', 'continuation']) {
    const source = { kind: 'local-pty', pty: {}, cwd: '/work', backgrounded: true };
    const snapshot = inventory(new Map([[id, source]]), () => null);
    assert.deepEqual(snapshot.rows, [], 'a confirmed background source must not be listed');
    assert.deepEqual(snapshot.counts, { sessions: 0, plain: 0, panels: 0, attached: 0 });
    assert.deepEqual(snapshot.remote, {});
  }
});

test('#769 a foreground session in the same project remains listed and counted', () => {
  for (const backgroundFirst of [true, false]) {
    const background = ['background', { kind: 'local-pty', pty: {}, cwd: '/work', backgrounded: true }];
    const foreground = ['foreground', { kind: 'local-pty', pty: {}, cwd: '/work', backgrounded: false }];
    const snapshot = inventory(new Map(backgroundFirst ? [background, foreground] : [foreground, background]), () => null);
    assert.deepEqual(snapshot.rows.map(({ id, cwd }) => ({ id, cwd })), [{ id: 'foreground', cwd: '/work' }]);
    assert.deepEqual(snapshot.counts, { sessions: 1, plain: 0, panels: 0, attached: 0 });
    assert.equal(snapshot.rows[0].canBackground, true);
  }
});
