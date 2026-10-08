'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SHORTCUTS, SHORTCUT_DEFS, matchShortcut, normalizeShortcuts, formatBinding } = require('../public/shortcuts');

test('agentsToggle defaults to Primary+Shift+A and is a rebindable key-family action', () => {
  assert.deepEqual(DEFAULT_SHORTCUTS.agentsToggle, { primary: true, alt: false, shift: true, key: 'a' });
  const def = SHORTCUT_DEFS.find(d => d.id === 'agentsToggle');
  assert.equal(def.family, 'key');
  assert.equal(formatBinding('agentsToggle', false, normalizeShortcuts(null)), 'Ctrl+Shift+A');
  const e = { key: 'A', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
  assert.equal(matchShortcut('agentsToggle', e, false, normalizeShortcuts(null)), true);
  assert.equal(matchShortcut('gridToggle', e, false, normalizeShortcuts(null)), false);
});
