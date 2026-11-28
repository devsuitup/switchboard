'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiscoveryBounds } = require('../src/main/projects/project-delete-deadline');

for (const capped of [false, true]) test(
  `an early discovery timer accepts a read before the budget clock expires, capped=${capped}`, async () => {
    const origin = Date.now(), now = () => (Date.now() - origin) * 0.1;
    const budget = { deadline: capped ? 400.5 : 40.5, signal: new AbortController().signal };
    let readTimer, error;
    try {
      const value = await createDiscoveryBounds({ now })('slow-read', () => new Promise(resolve => {
        readTimer = setTimeout(() => resolve('ready'), 80);
      }), budget, undefined, capped ? 40.5 : Infinity).catch(caught => { error = caught; });
      assert.equal(error, undefined, 'discovery must not reject while its injected clock has budget remaining');
      assert.equal(value, 'ready');
      assert.equal(budget.pendingPorts.size, 0);
    } finally { clearTimeout(readTimer); }
  });
