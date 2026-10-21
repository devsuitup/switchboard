'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inventory } = require('../session-exit');

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
