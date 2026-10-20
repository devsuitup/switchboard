'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lifecycleLabel } = require('../public/process-exit');

test('#563 lifecycle words follow all twelve ranked rows and preserve unknown evidence', () => {
  const detached = { detached: true, stopped: true, exitCode: 0 };
  const job = { kind: 'background', hosted: true, state: 'working' };
  const cases = [
    ['open here', { ptyHere: true }, 'Open here'],
    ['local attach', { ptyHere: true, attach: true }, 'Attached here · keeps running in the background'],
    ['remote attach', { ptyHere: true, attach: true, remoteAlias: 'vps' }, 'Attached here · runs on vps'],
    ...['done', 'stopped', 'failed'].map(state => [`finished ${state}`, { job: { ...job, hosted: false, state } }, `Job ${state}`]),
    ['live job', { job }, 'Running in background'],
    ['live remote', { remoteAlias: 'vps', liveness: 'alive' }, 'Running on vps'],
    ['live elsewhere', { liveness: 'alive' }, 'Running elsewhere'],
    ['dead without exit', { liveness: 'dead' }, 'Not running'],
    ['detached', { exit: detached }, 'Detached'],
    ['stopped', { exit: { stopped: true } }, 'Stopped'],
    ['exited code', { exit: { exitCode: 3 } }, 'Exited (code 3)'],
    ['killed', { exit: { signal: 'SIGTERM' } }, 'Killed (SIGTERM)'],
    ['exited', { exit: {} }, 'Exited'],
    ['dormant', { dormant: true }, 'Not reopened · restores on click'],
    ['unknown', {}, 'Liveness unknown'],
    ['explicit unknown', { liveness: 'unknown' }, 'Liveness unknown'],
    ['attach without PTY', { attach: true }, 'Liveness unknown'],
    ['host without proof', { remoteAlias: 'vps' }, 'Liveness unknown'],
    ['unknown job', { job: { ...job, state: null, hosted: false } }, 'Liveness unknown'],
    ['PTY before everything', { ptyHere: true, job, liveness: 'dead', exit: detached, dormant: true }, 'Open here'],
    ['local attach before job', { ptyHere: true, attach: true, job, exit: detached }, 'Attached here · keeps running in the background'],
    ['remote PTY without attach flag', { ptyHere: true, remoteAlias: 'vps' }, 'Attached here · runs on vps'],
    ...['done', 'stopped', 'failed'].map(state => [`finished ${state} before detached`, {
      job: { ...job, hosted: false, state }, remoteAlias: 'vps', liveness: 'alive', exit: detached, dormant: true,
    }, `Job ${state}`]),
    ['hosted done is live', { job: { ...job, state: 'done' }, exit: detached }, 'Running in background'],
    ['job before remote', { job, remoteAlias: 'vps', liveness: 'alive', exit: detached }, 'Running in background'],
    ['remote before exit', { remoteAlias: 'vps', liveness: 'alive', exit: detached }, 'Running on vps'],
    ['alive before detached', { liveness: 'alive', exit: detached }, 'Running elsewhere'],
    ['dead before detached', { liveness: 'dead', exit: detached }, 'Not running'],
    ...[{ exitCode: 2 }, { signal: 'SIGKILL' }, { stopped: true }, {}].map(exit => [
      `recorded exit before dead ${JSON.stringify(exit)}`, { liveness: 'dead', exit },
      exit.stopped ? 'Stopped' : exit.signal ? 'Killed (SIGKILL)' : exit.exitCode === 2 ? 'Exited (code 2)' : 'Exited',
    ]),
    ['exit before dormant', { exit: detached, dormant: true }, 'Detached'],
    ['dead before dormant', { liveness: 'dead', dormant: true }, 'Not running'],
  ];
  for (const [name, input, expected] of cases) assert.equal(lifecycleLabel(input), expected, name);
});
