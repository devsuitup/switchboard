'use strict';

// Issue #222: the checklist built from the host's answer, and the request guard.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildChecklist, handleEnrolRequest, UNKNOWN_AUTH_TEXT } = require('../remote-enrol');

const GOOD = {
  tmux: true, inotifywait: true, claude: true, claudeVersion: '2.1.288 (Claude Code)', claudeDir: true, auth: true,
};

function byId(items) {
  return Object.fromEntries(items.map(i => [i.id, i]));
}

test('a fully enrolled host is all ok, with the version, and hands out nothing to run', () => {
  const items = buildChecklist('vps', { reachable: true, facts: GOOD, detail: '' });
  assert.deepEqual(items.map(i => i.id), ['ssh', 'claude', 'tmux', 'claude-dir', 'auth']);
  assert.ok(items.every(i => i.status === 'ok'));
  assert.ok(items.every(i => i.command === null));
  assert.match(byId(items).claude.detail, /2\.1\.288/);
});

test('an unreachable host fails ssh with a workstation command and leaves the rest unknown', () => {
  const items = byId(buildChecklist('vps', { reachable: false, facts: null, detail: 'Connection refused' }));
  assert.equal(items.ssh.status, 'missing');
  assert.match(items.ssh.detail, /Connection refused/);
  assert.deepEqual({ where: items.ssh.where, command: items.ssh.command }, { where: 'workstation', command: 'ssh -o BatchMode=yes vps true' });
  for (const id of ['claude', 'tmux', 'claude-dir', 'auth']) {
    assert.equal(items[id].status, 'unknown', id);
    assert.equal(items[id].command, null, id);
  }
});

test('a host that connected but gave no facts says so and does not claim anything missing', () => {
  const items = byId(buildChecklist('winbox', { reachable: true, facts: null, detail: 'the check failed on the host (exit 127): no stderr' }));
  assert.equal(items.ssh.status, 'ok');
  for (const id of ['claude', 'tmux', 'claude-dir', 'auth']) assert.equal(items[id].status, 'unknown', id);
  assert.match(items.claude.detail, /exit 127/);
  assert.match(items.claude.detail, /Linux/);
});

test('a missing claude hands the install command, and auth waits on it', () => {
  const items = byId(buildChecklist('vps', {
    reachable: true, facts: { ...GOOD, claude: false, claudeVersion: null, claudeDir: false, auth: null }, detail: '',
  }));
  assert.equal(items.claude.status, 'missing');
  assert.equal(items.claude.where, 'host');
  assert.equal(items.claude.command, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(items.auth.status, 'unknown');
  assert.equal(items.auth.command, null);
});

test('a missing tmux is reported as optional and hands a package-manager command', () => {
  const items = byId(buildChecklist('vps', { reachable: true, facts: { ...GOOD, tmux: false }, detail: '' }));
  assert.equal(items.tmux.status, 'missing');
  assert.equal(items.tmux.optional, true);
  assert.equal(items.tmux.command, 'sudo apt install tmux');
  assert.match(items.tmux.detail, /cannot be launched/);
  assert.equal(items.claude.optional, undefined);
});

test('a missing ~/.claude hands the login command', () => {
  const items = byId(buildChecklist('vps', { reachable: true, facts: { ...GOOD, claudeDir: false, auth: null }, detail: '' }));
  assert.equal(items['claude-dir'].status, 'missing');
  assert.equal(items['claude-dir'].command, 'claude auth login');
  assert.equal(items.auth.status, 'unknown');
});

test('a logged-out account hands the login command to run on the host', () => {
  const items = byId(buildChecklist('vps', { reachable: true, facts: { ...GOOD, auth: false }, detail: '' }));
  assert.equal(items.auth.status, 'missing');
  assert.equal(items.auth.where, 'host');
  assert.equal(items.auth.command, 'claude auth login');
  assert.match(items.auth.detail, /on the host/);
});

test('an unknown login state is reported unknown, never as logged out', () => {
  const items = byId(buildChecklist('vps', { reachable: true, facts: { ...GOOD, auth: null }, detail: '' }));
  assert.equal(items.auth.status, 'unknown');
  assert.equal(items.auth.detail, UNKNOWN_AUTH_TEXT);
  assert.equal(UNKNOWN_AUTH_TEXT, 'unknown — run `claude` on the host once to log in');
  assert.equal(items.auth.command, 'claude');
});

test('a hostile version or detail is carried as plain data: the checklist is made of strings only', () => {
  const items = buildChecklist('vps', { reachable: false, facts: null, detail: '<img src=x onerror=alert(1)>' });
  for (const item of items) {
    for (const key of ['id', 'label', 'status', 'detail']) assert.equal(typeof item[key], 'string', key);
    assert.ok(item.command === null || typeof item.command === 'string');
  }
});

function deps(over = {}) {
  const calls = [];
  return {
    calls,
    isDeclared: (alias) => alias === 'vps',
    transport: { checkHost: async (alias) => { calls.push(alias); return { reachable: true, facts: GOOD, detail: '' }; } },
    ...over,
  };
}

test('handleEnrolRequest answers a declared host with its checklist', async () => {
  const d = deps();
  const r = await handleEnrolRequest({ alias: 'vps' }, d);
  assert.equal(r.ok, true);
  assert.equal(r.alias, 'vps');
  assert.equal(r.items.length, 5);
  assert.deepEqual(d.calls, ['vps']);
});

test('handleEnrolRequest refuses anything that is not a valid, declared alias before any ssh', async () => {
  const d = deps();
  for (const payload of [null, {}, { alias: 5 }, { alias: '-oProxyCommand=x' }, { alias: 'a b' }, { alias: 'other' }, { alias: 'vps; id' }]) {
    const r = await handleEnrolRequest(payload, d);
    assert.equal(r.ok, false, JSON.stringify(payload));
  }
  assert.deepEqual(d.calls, []);
});

test('handleEnrolRequest refuses an alias that is not a valid ssh alias even when the settings declare it', async () => {
  const d = deps({ isDeclared: () => true });
  for (const alias of ['-oProxyCommand=x', 'a b', 'vps; id', '', 'x'.repeat(64)]) {
    const r = await handleEnrolRequest({ alias }, d);
    assert.equal(r.ok, false, alias);
  }
  assert.deepEqual(d.calls, []);
});

test('handleEnrolRequest refuses a second check of a host while one is running', async () => {
  let release;
  let started = 0;
  const gate = new Promise((res) => { release = res; });
  const d = deps({ transport: { checkHost: async () => {
    if (started++ === 0) await gate;
    return { reachable: true, facts: GOOD, detail: '' };
  } } });
  const first = handleEnrolRequest({ alias: 'vps' }, d);
  const second = await handleEnrolRequest({ alias: 'vps' }, d);
  assert.equal(second.ok, false);
  assert.match(second.error, /already running/);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await handleEnrolRequest({ alias: 'vps' }, d)).ok, true);
});

test('handleEnrolRequest turns a throwing transport into an error and frees the host', async () => {
  const d = deps({ transport: { checkHost: async () => { throw new Error('boom'); } } });
  const r = await handleEnrolRequest({ alias: 'vps' }, d);
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
  d.transport.checkHost = async () => ({ reachable: true, facts: GOOD, detail: '' });
  assert.equal((await handleEnrolRequest({ alias: 'vps' }, d)).ok, true);
});
