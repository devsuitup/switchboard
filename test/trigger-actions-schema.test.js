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

test('exact boundaries are accepted and their neighbours refused in every mode', () => {
  const newReq = (extra = {}, name = 'n') => ({ version: 1, action: 'open', new: { project: '/x', name }, prompt: 'go', ...extra });
  const modes = {
    resume: text => ({ ...valid, prompt: text }),
    new: text => newReq({ prompt: text }),
    stop: text => ({ version: 1, action: 'stop', sessionId: id, before: text }),
  };
  for (const [mode, build] of Object.entries(modes)) {
    const field = mode === 'stop' ? 'before' : 'prompt';
    assert.equal(validateTriggerAction(build('x'.repeat(4096)), filename).reason, null, `${mode} 4096`);
    assert.equal(validateTriggerAction(build('x'.repeat(4097)), filename).reason, `${field} too long (max 4 KB)`, `${mode} 4097`);
    assert.equal(validateTriggerAction(build('x'), filename).reason, null, `${mode} 1`);
  }
  assert.equal(validateTriggerAction(newReq({}, 'n'.repeat(256)), filename).reason, null);
  assert.equal(validateTriggerAction(newReq({}, 'n'.repeat(257)), filename).reason, 'new.name too long (max 256 characters)');
  for (const [value, reason] of [[1, null], [600000, null], [0, 'invalid timeout_ms'], [600001, 'invalid timeout_ms'], [1.5, 'invalid timeout_ms'], ['5', 'invalid timeout_ms']]) {
    assert.equal(validateTriggerAction({ ...valid, timeout_ms: value }, filename).reason, reason, String(value));
  }
});
