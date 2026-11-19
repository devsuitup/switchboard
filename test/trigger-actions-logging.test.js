'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
const { fixture: openFixture, ID, STEM, project } = require('./fixtures/trigger-open.cjs');
const { fixture: stopFixture } = require('./fixtures/trigger-stop.cjs');

for (const mode of ['new', 'resume', 'stop']) {
  test(`${mode} renderer-not-ready refusal logs only action, requested name and reason`, async t => {
    const f = mode === 'stop' ? stopFixture(t) : openFixture();
    const logs = [];
    const actions = createTriggerActions({ log: { info: (...args) => logs.push(args) } });
    f.ctx.lifecycle.broker.request = async () => ({ ok: false, reason: 'renderer not ready' });
    f.ctx.lifecycle.broker.waitForReady = async () => ({ ok: false, reason: 'renderer not ready' });
    const trigger = { version: 1, action: mode === 'stop' ? 'stop' : 'open',
      ...(mode === 'new' ? { new: { project, name: '  Task "1123"  ' } } : { sessionId: ID }),
      ...(mode !== 'stop' ? { prompt: 'secret prompt never logged' } : {}) };
    const result = await actions.execute(trigger, STEM, f.execution);
    assert.equal(result.reason, 'renderer not ready');
    assert.deepEqual(logs, [[`[trigger-watcher] v1 action refused: ${JSON.stringify({
      action: trigger.action, requestedName: mode === 'new' ? 'Task "1123"' : null, reason: 'renderer not ready',
    })}`]]);
  });
}

test('other refusals produce no renderer-not-ready info line', async () => {
  const f = openFixture();
  const logs = [];
  const actions = createTriggerActions({ log: { info: (...args) => logs.push(args) } });
  f.ctx.lifecycle.broker.request = async () => ({ ok: false, reason: 'renderer unavailable' });
  assert.equal((await actions.execute({ version: 1, action: 'open', sessionId: ID }, STEM, f.execution)).reason, 'renderer unavailable');
  assert.deepEqual(logs, []);
});
