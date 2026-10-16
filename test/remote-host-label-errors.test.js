'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteLaunchAdapter, handleLaunchRequest } = require('../remote-launch');
const { handleEnrolRequest } = require('../remote-enrol');

const alias = 'planificator';
const getHosts = () => [{ alias, label: 'VPS', enabled: true }];
const request = { sessionId: '3f2a9c10-7b1d-4e55-9a60-0123456789ab', cwd: '/srv/app', options: {} };

test('all host-naming launch errors use the label while SSH still receives the alias', async () => {
  for (const [result, expected] of [
    [{ timedOut: true }, /launch timed out on VPS/],
    [{ code: 9 }, /directory \/srv\/app does not exist on VPS/],
    [{ code: 10 }, /tmux is not installed on VPS/],
    [{ code: 11 }, /ssh command on VPS/],
    [{ code: 0, stdout: 'unreadable' }, /launch ran on VPS/],
  ]) {
    const calls = [];
    const adapter = createRemoteLaunchAdapter({ getHosts,
      runRemoteCommand: async host => { calls.push(host); return result; } });
    const response = await adapter.launch(alias, request);
    assert.equal(response.ok, false);
    assert.match(response.error, expected);
    assert.deepEqual(calls, [alias]);
  }
});

test('failed attachment names the label while launch and attach keep the alias', async () => {
  const calls = [];
  const response = await handleLaunchRequest({ alias, ...request }, {
    getHosts, hasHost: value => value === alias, launchBlockReason: () => null,
    adapter: { launch: async host => { calls.push(['launch', host]); return { ok: true, descriptor: { ...request, tmux: 'pane' } }; } },
    attach: async host => { calls.push(['attach', host]); return { ok: false, error: 'refused' }; },
  });
  assert.match(response.error, /started on VPS as pane but attaching failed: refused/);
  assert.deepEqual(calls, [['launch', alias], ['attach', alias]]);
});

test('a concurrent host check names its label and the transport still uses its alias', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const deps = { getHosts, isDeclared: value => value === alias,
    transport: { checkHost: async host => { calls.push(host); return gate; } } };
  const pending = handleEnrolRequest({ alias }, deps);
  try {
    const response = await handleEnrolRequest({ alias }, deps);
    assert.equal(response.error, 'a check of VPS is already running');
    assert.deepEqual(calls, [alias]);
  } finally {
    release({ reachable: false });
    await pending;
  }
});
