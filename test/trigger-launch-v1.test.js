'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTriggerOpen } = require('../src/main/triggers/trigger-launch');

for (const mode of ['new', 'resume']) {
  test(`${mode} launch ${mode === 'new' ? 'ignores unrelated torn descriptors' : 'retains the checked liveness gate'}`, async () => {
    let scans = 0, projects = 0;
    const result = await validateTriggerOpen({ mode, tabKey: 'reserved-id', project: '/project', deadline: Date.now() + 2000 }, {
      launchAllowed: () => true, broker: { checkPermit: () => true }, remoteTarget: async () => false,
      liveElsewhere: async () => { scans++; return { known: false }; },
      resolveProject: async project => { projects++; return { ok: true, project }; },
    });
    assert.equal(result.ok, mode === 'new', 'a fresh UUID needs project admission, while resume requires liveness proof');
    assert.equal(scans, mode === 'new' ? 0 : 1);
    assert.equal(projects, mode === 'new' ? 1 : 0);
  });
}
