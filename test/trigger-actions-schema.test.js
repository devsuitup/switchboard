'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateTriggerAction } = require('../src/main/triggers/trigger-actions');

const id = '01234567-89ab-cdef-0123-456789abcdef';
const valid = { version: 1, action: 'open', sessionId: id };
const filename = `${id}.json`;

test('versioned action schema accepts valid forms and normalizes identifiers', () => {
  for (const request of [valid, { ...valid, sessionId: id.toUpperCase(), prompt: ' hello ' },
    { version: 1, action: 'open', new: { project: '/work/project', name: ' Name ' }, prompt: 'go' },
    { version: 1, action: 'stop', sessionId: id, before: 'finish', timeout_ms: 600000 }]) {
    assert.equal(validateTriggerAction(request, filename).reason, null);
  }
  assert.equal(validateTriggerAction({ ...valid, sessionId: id.toUpperCase() }, filename).value.sessionId, id);
  assert.equal(validateTriggerAction({ version: 1, action: 'open', new: { project: '/x', name: ' Name ' }, prompt: 'go' }, filename).value.new.name, 'Name');
});

test('versioned action schema rejects invalid forms with ordered reasons', () => {
  const cases = [
    [null, filename, 'trigger must be an object'],
    [{ action: 'open' }, filename, 'unsupported version'],
    [{ version: 2, action: 'bad' }, filename, 'unsupported version'],
    [{ version: 1, action: 'bad' }, filename, 'unsupported action'],
    [valid, `${id.toUpperCase()}.json`, 'trigger filename must be a lowercase UUID'],
    [{ version: 1, action: 'open' }, filename, 'open requires exactly one of sessionId or new'],
    [{ ...valid, new: {} }, filename, 'open requires exactly one of sessionId or new'],
    [{ version: 1, action: 'stop' }, filename, 'missing required field: sessionId'],
    [{ ...valid, z: 1, a: 2 }, filename, 'unsupported field: a'],
    [{ ...valid, sessionId: 'name' }, filename, 'sessionId must be a UUID'],
    [{ version: 1, action: 'open', new: null }, filename, 'new must be an object'],
    [{ version: 1, action: 'open', new: { project: 'relative', name: 'n' }, prompt: 'x' }, filename, 'new.project must be an absolute path'],
    [{ version: 1, action: 'open', new: { project: '/x', name: ' ' }, prompt: 'x' }, filename, 'new.name must be a non-empty string'],
    [{ version: 1, action: 'open', new: { project: '/x', name: 'a'.repeat(257) }, prompt: 'x' }, filename, 'new.name too long (max 256 characters)'],
    [{ version: 1, action: 'open', new: { project: '/x', name: 'a\nb' }, prompt: 'x' }, filename, 'new.name contains control characters'],
    [{ ...valid, prompt: null }, filename, 'prompt must be a non-empty string'],
    [{ ...valid, prompt: 'x'.repeat(4097) }, filename, 'prompt too long (max 4 KB)'],
    [{ ...valid, prompt: 'x\ny' }, filename, 'prompt contains forbidden control characters (\\r \\n \\0 \\x1b)'],
    [{ ...valid, timeout_ms: 0 }, filename, 'invalid timeout_ms'],
    [{ ...valid, expectedCwd: '' }, filename, 'expectedCwd must be a non-empty string when present'],
    [{ version: 1, action: 'open', new: { project: '/x', name: 'n', options: {} }, prompt: 'x' }, filename, 'unsupported field: new.options'],
  ];
  for (const [request, file, reason] of cases) assert.equal(validateTriggerAction(request, file).reason, reason);
});
