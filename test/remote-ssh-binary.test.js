'use strict';

// Which ssh and scp binaries the remote modules run (issue #359) — see
// docs/remote-hosts.md ("Which ssh and scp run"). env, platform and the
// filesystem probe are injected: nothing here looks at the real machine.

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSshPath, resolveScpPath } = require('../remote-ssh-binary');

const existing = (...paths) => (p) => paths.includes(p);
const nothingExists = () => false;

test('resolveSshPath returns SWITCHBOARD_SSH_PATH when it is set, without probing the disk', () => {
  let probed = 0;
  const existsSync = () => { probed++; return true; };
  assert.equal(
    resolveSshPath({ env: { SWITCHBOARD_SSH_PATH: '/opt/wrap/ssh' }, platform: 'linux', existsSync }),
    '/opt/wrap/ssh',
  );
  assert.equal(probed, 0);
});

test('resolveSshPath ignores an empty SWITCHBOARD_SSH_PATH', () => {
  assert.equal(
    resolveSshPath({ env: { SWITCHBOARD_SSH_PATH: '' }, platform: 'linux', existsSync: existing('/usr/bin/ssh') }),
    '/usr/bin/ssh',
  );
});

test('resolveSshPath takes /usr/bin/ssh on Linux and macOS when it exists', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.equal(resolveSshPath({ env: {}, platform, existsSync: existing('/usr/bin/ssh') }), '/usr/bin/ssh');
  }
});

test('resolveSshPath takes the Windows OpenSSH client first, then Git\'s', () => {
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  const openssh = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
  const git = 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe';
  assert.equal(resolveSshPath({ env, platform: 'win32', existsSync: existing(openssh, git) }), openssh);
  assert.equal(resolveSshPath({ env, platform: 'win32', existsSync: existing(git) }), git);
});

test('resolveSshPath falls back to ssh from the PATH when no candidate exists', () => {
  assert.equal(resolveSshPath({ env: {}, platform: 'linux', existsSync: nothingExists }), 'ssh');
  assert.equal(resolveSshPath({ env: {}, platform: 'win32', existsSync: nothingExists }), 'ssh');
});

test('resolveSshPath survives a probe that throws', () => {
  const existsSync = () => { throw new Error('EACCES'); };
  assert.equal(resolveSshPath({ env: {}, platform: 'linux', existsSync }), 'ssh');
});

test('resolveScpPath returns SWITCHBOARD_SCP_PATH first, whatever SWITCHBOARD_SSH_PATH says', () => {
  const env = { SWITCHBOARD_SCP_PATH: '/elsewhere/scp', SWITCHBOARD_SSH_PATH: '/opt/ssh/bin/ssh' };
  assert.equal(
    resolveScpPath({ env, platform: 'linux', existsSync: existing('/opt/ssh/bin/scp') }),
    '/elsewhere/scp',
  );
});

test('resolveScpPath takes the scp next to SWITCHBOARD_SSH_PATH when one is there', () => {
  assert.equal(
    resolveScpPath({ env: { SWITCHBOARD_SSH_PATH: '/opt/ssh/bin/ssh' }, platform: 'linux', existsSync: existing('/opt/ssh/bin/scp', '/usr/bin/scp') }),
    '/opt/ssh/bin/scp',
  );
});

test('resolveScpPath keeps the .exe suffix of a Windows SWITCHBOARD_SSH_PATH', () => {
  const ssh = 'D:\\Tools\\OpenSSH\\ssh.exe';
  const scp = 'D:\\Tools\\OpenSSH\\scp.exe';
  assert.equal(
    resolveScpPath({ env: { SWITCHBOARD_SSH_PATH: ssh }, platform: 'win32', existsSync: existing(scp) }),
    scp,
  );
});

test('resolveScpPath falls back to the default search when SWITCHBOARD_SSH_PATH has no scp beside it', () => {
  assert.equal(
    resolveScpPath({ env: { SWITCHBOARD_SSH_PATH: '/home/u/bin/ssh-wrapper' }, platform: 'linux', existsSync: existing('/usr/bin/scp') }),
    '/usr/bin/scp',
  );
});

test('resolveScpPath does not derive a directory from a bare SWITCHBOARD_SSH_PATH name', () => {
  const probes = [];
  const existsSync = (p) => { probes.push(p); return false; };
  assert.equal(resolveScpPath({ env: { SWITCHBOARD_SSH_PATH: 'ssh' }, platform: 'linux', existsSync }), 'scp');
  assert.deepEqual(probes, ['/usr/bin/scp']);
});

test('resolveScpPath searches the same places as ssh, then the PATH', () => {
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  assert.equal(resolveScpPath({ env: {}, platform: 'linux', existsSync: existing('/usr/bin/scp') }), '/usr/bin/scp');
  assert.equal(
    resolveScpPath({ env, platform: 'win32', existsSync: existing('C:\\Program Files\\Git\\usr\\bin\\scp.exe') }),
    'C:\\Program Files\\Git\\usr\\bin\\scp.exe',
  );
  assert.equal(resolveScpPath({ env: {}, platform: 'linux', existsSync: nothingExists }), 'scp');
});
