const test = require('node:test');
const assert = require('node:assert/strict');

const { bridgeSessionUrl } = require('../public/bridge-url');

test('a cse_ bridge id maps to the claude.ai/code/session_ URL with the same suffix', () => {
  assert.equal(
    bridgeSessionUrl('cse_0189wicjnQ3j6mppaWVWuntM'),
    'https://claude.ai/code/session_0189wicjnQ3j6mppaWVWuntM',
  );
});

test('a session_ bridge id (CLI descriptor form) is used as is', () => {
  assert.equal(
    bridgeSessionUrl('session_01HPxeAbC123'),
    'https://claude.ai/code/session_01HPxeAbC123',
  );
});

test('no id, or an id of an unknown shape, gives no URL', () => {
  for (const bad of [null, undefined, '', 42, 'cse_', 'session_', 'abc', 'cse_a/b', 'cse_a b', 'cse_../x', 'cse_a?x=1']) {
    assert.equal(bridgeSessionUrl(bad), null, String(bad));
  }
});
