'use strict';

// see .ai/contexts/session-cache.md ("Remote hosts — ssh and scp binaries")

const test = require('node:test');
const assert = require('node:assert/strict');

const binary = require('../remote-ssh-binary');
const { createBinaryResolver } = binary;

const WIN_ENV = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };

function recordingLog() {
  const warnings = [];
  return { warnings, warn: (m) => warnings.push(m), info() {}, error() {} };
}

function make({ env = {}, platform = 'linux', exists = [], log = recordingLog() } = {}) {
  const probes = [];
  const isExecutable = (p) => { probes.push(p); return exists.includes(p); };
  const r = createBinaryResolver({ env, platform, isExecutable, log });
  return { ...r, probes, log };
}

// ── ssh ──────────────────────────────────────────────────────────────────

test('ssh: SWITCHBOARD_SSH_PATH comes first, without probing the disk', () => {
  const r = make({ env: { SWITCHBOARD_SSH_PATH: '/opt/wrap/ssh', PATH: '/usr/bin' }, exists: ['/usr/bin/ssh'] });
  assert.equal(r.resolveSshPath(), '/opt/wrap/ssh');
  assert.deepEqual(r.probes, []);
});

test('ssh: ssh from the PATH comes before the system candidates', () => {
  const r = make({ env: { PATH: '/opt/homebrew/bin:/usr/bin' }, exists: ['/opt/homebrew/bin/ssh', '/usr/bin/ssh'] });
  assert.equal(r.resolveSshPath(), '/opt/homebrew/bin/ssh');
});

test('ssh: relative PATH entries are skipped', () => {
  const r = make({ env: { PATH: '.:bin::/usr/local/bin' }, exists: ['/usr/local/bin/ssh'] });
  assert.equal(r.resolveSshPath(), '/usr/local/bin/ssh');
  assert.deepEqual(r.probes, ['/usr/local/bin/ssh']);
});

test('ssh: /usr/bin/ssh is the fallback when ssh is not on the PATH', () => {
  for (const platform of ['linux', 'darwin']) {
    const r = make({ platform, env: { PATH: '/nowhere' }, exists: ['/usr/bin/ssh'] });
    assert.equal(r.resolveSshPath(), '/usr/bin/ssh');
  }
});

test('ssh: on Windows the PATH is searched for ssh.exe only, whatever the case of the Path key', () => {
  const r = make({ platform: 'win32', env: { ...WIN_ENV, Path: 'C:\\Tools;C:\\Program Files\\Git\\usr\\bin' },
    exists: ['C:\\Tools\\ssh.cmd', 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe'] });
  assert.equal(r.resolveSshPath(), 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe');
});

test('ssh: on Windows the system OpenSSH client comes before Git\'s when ssh is not on the PATH', () => {
  const openssh = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
  const git = 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe';
  assert.equal(make({ platform: 'win32', env: WIN_ENV, exists: [openssh, git] }).resolveSshPath(), openssh);
  assert.equal(make({ platform: 'win32', env: WIN_ENV, exists: [git] }).resolveSshPath(), git);
});

test('ssh: the bare name is the last resort', () => {
  assert.equal(make({ env: { PATH: '/nowhere' } }).resolveSshPath(), 'ssh');
  assert.equal(make({ platform: 'win32', env: WIN_ENV }).resolveSshPath(), 'ssh');
});

test('ssh: a probe that throws counts as absent', () => {
  const r = createBinaryResolver({ env: { PATH: '/usr/bin' }, platform: 'linux', isExecutable: () => { throw new Error('EACCES'); }, log: recordingLog() });
  assert.equal(r.resolveSshPath(), 'ssh');
});

test('ssh: a blank or whitespace-only SWITCHBOARD_SSH_PATH is unset', () => {
  for (const value of ['', '   ', '\t\n']) {
    const r = make({ env: { SWITCHBOARD_SSH_PATH: value, PATH: '/usr/bin' }, exists: ['/usr/bin/ssh'] });
    assert.equal(r.resolveSshPath(), '/usr/bin/ssh', JSON.stringify(value));
    assert.deepEqual(r.log.warnings, []);
  }
});

test('ssh: surrounding whitespace is trimmed from SWITCHBOARD_SSH_PATH', () => {
  assert.equal(make({ env: { SWITCHBOARD_SSH_PATH: '  /opt/wrap/ssh \n' } }).resolveSshPath(), '/opt/wrap/ssh');
});

test('ssh: a relative SWITCHBOARD_SSH_PATH is ignored with a warning', () => {
  for (const value of ['./wrap/ssh', 'wrap/ssh', 'ssh-wrapper']) {
    const r = make({ env: { SWITCHBOARD_SSH_PATH: value, PATH: '/usr/bin' }, exists: ['/usr/bin/ssh'] });
    assert.equal(r.resolveSshPath(), '/usr/bin/ssh', value);
    assert.equal(r.log.warnings.length, 1);
    assert.match(r.log.warnings[0], /SWITCHBOARD_SSH_PATH/);
    assert.match(r.log.warnings[0], /absolute/);
  }
});

test('ssh: a Windows .cmd or .bat SWITCHBOARD_SSH_PATH is kept, with a warning that it cannot be spawned', () => {
  for (const value of ['C:\\Tools\\ssh.cmd', 'C:\\Tools\\SSH.BAT']) {
    const r = make({ platform: 'win32', env: { ...WIN_ENV, SWITCHBOARD_SSH_PATH: value } });
    assert.equal(r.resolveSshPath(), value);
    assert.equal(r.log.warnings.length, 1);
    assert.match(r.log.warnings[0], /SWITCHBOARD_SSH_PATH/);
    assert.match(r.log.warnings[0], /\.exe/);
  }
});

test('ssh: the result is resolved once per resolver, and the warning logged once', () => {
  const r = make({ env: { SWITCHBOARD_SSH_PATH: 'relative/ssh', PATH: '/usr/bin' }, exists: ['/usr/bin/ssh'] });
  r.resolveSshPath();
  r.resolveSshPath();
  r.resolveSshPath();
  assert.deepEqual(r.probes, ['/usr/bin/ssh']);
  assert.equal(r.log.warnings.length, 1);
});

// ── scp ──────────────────────────────────────────────────────────────────

test('scp: SWITCHBOARD_SCP_PATH comes first, whatever SWITCHBOARD_SSH_PATH says', () => {
  const r = make({ env: { SWITCHBOARD_SCP_PATH: '/elsewhere/scp', SWITCHBOARD_SSH_PATH: '/opt/ssh/bin/ssh' }, exists: ['/opt/ssh/bin/scp'] });
  assert.equal(r.resolveScpPath(), '/elsewhere/scp');
});

test('scp: then the scp beside SWITCHBOARD_SSH_PATH, before the PATH', () => {
  const r = make({ env: { SWITCHBOARD_SSH_PATH: '/opt/ssh/bin/ssh', PATH: '/usr/bin' }, exists: ['/opt/ssh/bin/scp', '/usr/bin/scp'] });
  assert.equal(r.resolveScpPath(), '/opt/ssh/bin/scp');
});

test('scp: the sibling keeps the .exe suffix of a Windows SWITCHBOARD_SSH_PATH', () => {
  const r = make({ platform: 'win32', env: { ...WIN_ENV, SWITCHBOARD_SSH_PATH: 'D:\\Tools\\OpenSSH\\ssh.exe' }, exists: ['D:\\Tools\\OpenSSH\\scp.exe'] });
  assert.equal(r.resolveScpPath(), 'D:\\Tools\\OpenSSH\\scp.exe');
});

test('scp: with no scp beside SWITCHBOARD_SSH_PATH, the PATH, then the system candidates', () => {
  const env = { SWITCHBOARD_SSH_PATH: '/home/u/bin/ssh-wrapper', PATH: '/opt/homebrew/bin' };
  assert.equal(make({ env, exists: ['/opt/homebrew/bin/scp', '/usr/bin/scp'] }).resolveScpPath(), '/opt/homebrew/bin/scp');
  assert.equal(make({ env, exists: ['/usr/bin/scp'] }).resolveScpPath(), '/usr/bin/scp');
  assert.equal(make({ env }).resolveScpPath(), 'scp');
});

test('scp: a relative SWITCHBOARD_SSH_PATH gives no sibling', () => {
  const r = make({ env: { SWITCHBOARD_SSH_PATH: 'bin/ssh', PATH: '/nowhere' }, exists: ['bin/scp', '/usr/bin/scp'] });
  assert.equal(r.resolveScpPath(), '/usr/bin/scp');
  assert.ok(!r.probes.includes('bin/scp'));
});

test('scp: a blank SWITCHBOARD_SCP_PATH is unset, a relative one ignored with a warning', () => {
  assert.equal(make({ env: { SWITCHBOARD_SCP_PATH: '  ', PATH: '/usr/bin' }, exists: ['/usr/bin/scp'] }).resolveScpPath(), '/usr/bin/scp');
  const r = make({ env: { SWITCHBOARD_SCP_PATH: './scp', PATH: '/usr/bin' }, exists: ['/usr/bin/scp'] });
  assert.equal(r.resolveScpPath(), '/usr/bin/scp');
  assert.equal(r.log.warnings.length, 1);
  assert.match(r.log.warnings[0], /SWITCHBOARD_SCP_PATH/);
});

test('scp: a Windows .bat SWITCHBOARD_SCP_PATH is kept, with a warning', () => {
  const r = make({ platform: 'win32', env: { ...WIN_ENV, SWITCHBOARD_SCP_PATH: 'C:\\Tools\\scp.bat' } });
  assert.equal(r.resolveScpPath(), 'C:\\Tools\\scp.bat');
  assert.equal(r.log.warnings.length, 1);
});

test('scp: the result is resolved once per resolver', () => {
  const r = make({ env: { PATH: '/a:/b' }, exists: ['/b/scp'] });
  r.resolveScpPath();
  r.resolveScpPath();
  assert.deepEqual(r.probes, ['/a/scp', '/b/scp']);
});

// ── the process-wide resolver ────────────────────────────────────────────

test('the module-level resolvers read process.env once, until reset', (t) => {
  const saved = process.env.SWITCHBOARD_SSH_PATH;
  t.after(() => {
    if (saved === undefined) delete process.env.SWITCHBOARD_SSH_PATH; else process.env.SWITCHBOARD_SSH_PATH = saved;
    binary.resetResolvedBinaries();
  });
  binary.resetResolvedBinaries();
  process.env.SWITCHBOARD_SSH_PATH = '/first/ssh';
  assert.equal(binary.resolveSshPath(), '/first/ssh');
  process.env.SWITCHBOARD_SSH_PATH = '/second/ssh';
  assert.equal(binary.resolveSshPath(), '/first/ssh', 'memoised for the process');
  binary.resetResolvedBinaries();
  assert.equal(binary.resolveSshPath(), '/second/ssh');
});

test('the module-level resolver logs through the log it is given', (t) => {
  const saved = process.env.SWITCHBOARD_SSH_PATH;
  const log = recordingLog();
  t.after(() => {
    if (saved === undefined) delete process.env.SWITCHBOARD_SSH_PATH; else process.env.SWITCHBOARD_SSH_PATH = saved;
    binary.setResolverLog(null);
    binary.resetResolvedBinaries();
  });
  binary.setResolverLog(log);
  binary.resetResolvedBinaries();
  process.env.SWITCHBOARD_SSH_PATH = 'relative/ssh';
  binary.resolveSshPath();
  assert.equal(log.warnings.length, 1);
});
