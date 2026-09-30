// test/bg-agents-roster.test.js — pure parsing and merging for the agents view.
// See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseJobState, parseCliList, mergeRoster, dispatchArgs, parseDispatchOutput, JOB_ID_RE, stripShellNoise,
} = require('../bg-agents-roster');

const STATE = JSON.stringify({
  state: 'done',
  detail: 'backlog reviewed; awaiting !196 merge',
  tempo: 'idle',
  tokens: 172999,
  fan: [{ id: 'a4a8', kind: 'agent', label: 'Spawn developer', startedAt: 1790590786510, doneAt: 1790590813354 }, 'junk'],
  children: [{ id: '195', href: 'https://gitlab.com/x/-/merge_requests/195', kind: 'merge_request' }],
  output: { result: 'no new action needed' },
  template: 'fleet:em',
  respawnFlags: ['--plugin-dir', '/x', '--agent', 'fleet:em', '--permission-mode', 'auto', '--name', 'em-platform', '--model', 'claude-sonnet-5'],
  linkScanPath: '/home/u/.claude/projects/-home-u-p/bc3fd129-60bb-4bd2-8f38-63fecd1256e5.jsonl',
});

test('parseJobState keeps the fields the view shows and derives agent/model/name/sessionId', () => {
  const job = parseJobState(STATE);
  assert.equal(job.state, 'done');
  assert.equal(job.detail, 'backlog reviewed; awaiting !196 merge');
  assert.equal(job.tokens, 172999);
  assert.deepEqual(job.fan, [{ id: 'a4a8', kind: 'agent', label: 'Spawn developer', startedAt: 1790590786510, doneAt: 1790590813354 }]);
  assert.deepEqual(job.children, [{ id: '195', href: 'https://gitlab.com/x/-/merge_requests/195', kind: 'merge_request' }]);
  assert.equal(job.result, 'no new action needed');
  assert.equal(job.agent, 'fleet:em');
  assert.equal(job.model, 'claude-sonnet-5');
  assert.equal(job.name, 'em-platform');
  assert.equal(job.sessionId, 'bc3fd129-60bb-4bd2-8f38-63fecd1256e5');
});

test('parseJobState: unknown state, missing output and garbage are tolerated', () => {
  assert.equal(parseJobState(''), null);
  assert.equal(parseJobState('[]'), null);
  const job = parseJobState('{"state":"weird","fan":null}');
  assert.equal(job.state, null);
  assert.deepEqual(job.fan, []);
  assert.equal(job.result, null);
  assert.equal(job.sessionId, null);
});

test('parseCliList keeps background and interactive entries and drops the rest', () => {
  const list = parseCliList(JSON.stringify([
    { id: 'bc3fd129', pid: 346590, cwd: '/w', kind: 'background', startedAt: 1, sessionId: 's-bg', name: 'em', status: 'idle', state: 'working' },
    { pid: 5, cwd: '/w', kind: 'interactive', startedAt: 2, sessionId: 's-int', name: 'n', status: 'busy' },
    { kind: 'background', sessionId: '' },
    'junk',
  ]));
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { id: 'bc3fd129', sessionId: 's-bg', name: 'em', cwd: '/w', kind: 'background', state: 'working', status: 'idle', pid: 346590, startedAt: 1 });
  assert.equal(list[1].kind, 'interactive');
  assert.equal(list[1].id, null);
  assert.equal(parseCliList('not json'), null);
  assert.equal(parseCliList('{}'), null);
});

test('parseCliList tolerates login-shell noise printed around the JSON', () => {
  const json = JSON.stringify([{ id: 'bc3fd129', kind: 'background', sessionId: 's-bg', state: 'working' }], null, 2);
  const before = 'Now using node v22.1.0 (npm v10)\n[nvm] default alias set\n"The fortune cookie says: [sic]"\n';
  const after = '\nlogout [done]\n';
  for (const text of [before + json, json + after, before + json + after]) {
    const list = parseCliList(text);
    assert.ok(Array.isArray(list), text);
    assert.equal(list.length, 1);
    assert.equal(list[0].sessionId, 's-bg');
  }
  assert.equal(parseCliList('Now using node v22\n[not json]\ngarbage ]'), null);
  assert.equal(parseCliList('fortune: be happy\n{"a":1}\n'), null);
  assert.equal(parseCliList(''), null);
});

test('stripShellNoise drops the leading login-shell job-control lines and keeps the CLI stderr verbatim', () => {
  const noise = 'bash: cannot set terminal process group (-1): Inappropriate ioctl for device\nbash: no job control in this shell\n';
  assert.equal(stripShellNoise(noise + 'Error: session aaaaaaaa is not running\n  at x'), 'Error: session aaaaaaaa is not running\n  at x');
  assert.equal(stripShellNoise('Error: bash: no job control in this shell is quoted here'), 'Error: bash: no job control in this shell is quoted here');
  assert.equal(stripShellNoise(noise), '');
  assert.equal(stripShellNoise(undefined), '');
});

function fixture() {
  const cli = [
    { id: 'aaaaaaaa', sessionId: 's-a', name: 'a', cwd: '/a', kind: 'background', state: 'working', status: 'idle', pid: 10, startedAt: 100 },
    { id: 'bbbbbbbb', sessionId: 's-b', name: 'b', cwd: '/b', kind: 'background', state: 'done', status: null, pid: null, startedAt: 50 },
    { id: null, sessionId: 's-own', name: 'own', cwd: '/o', kind: 'interactive', state: null, status: 'busy', pid: 20, startedAt: 70 },
  ];
  const jobs = new Map([
    ['aaaaaaaa', parseJobState(JSON.stringify({ state: 'done', detail: 'stale detail', tokens: 5, respawnFlags: ['--agent', 'fleet:em'] }))],
    ['cccccccc', parseJobState(JSON.stringify({ state: 'stopped', detail: 'orphan' }))],
  ]);
  const descriptors = [
    { pid: 10, sessionId: 's-a', kind: 'bg', jobId: 'aaaaaaaa', agent: 'fleet:em', name: 'a', cwd: '/a', status: 'busy', startedAt: 100 },
    { pid: 20, sessionId: 's-own', kind: 'interactive', jobId: null, agent: null, name: 'own', cwd: '/o', status: 'busy', startedAt: 70 },
    { pid: 30, sessionId: 's-ext', kind: 'interactive', jobId: null, agent: null, name: 'ext', cwd: '/e', status: 'waiting', startedAt: 80 },
    { pid: 40, sessionId: 's-nojob', kind: 'bg', jobId: 'dddddddd', agent: null, name: 'x', cwd: '/x', status: 'idle', startedAt: 90 },
  ];
  return { cli, jobs, descriptors, isOwnPid: (pid) => pid === 20, isAttachedHere: (id) => id === 'aaaaaaaa' };
}

test('mergeRoster: the CLI list decides which jobs exist and their state; the file and the descriptor enrich', () => {
  const roster = mergeRoster(fixture());
  const ids = roster.map(e => e.kind === 'background' ? e.id : e.sessionId);
  assert.deepEqual(ids, ['aaaaaaaa', 'bbbbbbbb', 's-ext']);
  const a = roster[0];
  assert.equal(a.state, 'working', 'the CLI state wins over the file');
  assert.equal(a.status, 'busy', 'the descriptor status wins over the CLI snapshot');
  assert.equal(a.detail, 'stale detail');
  assert.equal(a.tokens, 5);
  assert.equal(a.agent, 'fleet:em');
  assert.equal(a.attachedHere, true);
  assert.equal(roster[1].attachedHere, false);
  assert.equal(roster[1].detail, null, 'a job without a file still lists');
  const ext = roster[2];
  assert.equal(ext.kind, 'interactive');
  assert.equal(ext.id, null);
  assert.equal(ext.status, 'waiting');
});

test('mergeRoster without the CLI lists the jobs on disk instead', () => {
  const f = fixture();
  const roster = mergeRoster({ ...f, cli: null });
  assert.deepEqual(roster.filter(e => e.kind === 'background').map(e => e.id).sort(), ['aaaaaaaa', 'cccccccc']);
  const a = roster.find(e => e.id === 'aaaaaaaa');
  assert.equal(a.state, 'done', 'file state stands when the CLI is unreachable');
  assert.equal(a.sessionId, 's-a', 'the descriptor supplies the session id');
  assert.equal(a.pid, 10);
});

test('dispatchArgs builds the argv in a fixed order and omits empty options', () => {
  const r = dispatchArgs({ prompt: '  do the thing  ', name: 'n1', agent: 'fleet:em', permissionMode: 'auto', addDirs: '/a, /b', cwd: '/proj' });
  assert.deepEqual(r, { ok: true, cwd: '/proj', args: ['--bg', '--name', 'n1', '--agent', 'fleet:em', '--permission-mode', 'auto', '--add-dir', '/a', '--add-dir', '/b', 'do the thing'] });
  const bare = dispatchArgs({ prompt: 'p', cwd: '/proj', name: '', agent: '  ', dangerouslySkipPermissions: true, permissionMode: 'auto' });
  assert.deepEqual(bare.args, ['--bg', '--dangerously-skip-permissions', 'p']);
});

test('dispatchArgs refuses an empty prompt, a missing cwd, and a prompt that looks like a flag', () => {
  assert.equal(dispatchArgs({ prompt: '', cwd: '/p' }).ok, false);
  assert.equal(dispatchArgs({ prompt: 'p' }).ok, false);
  const flag = dispatchArgs({ prompt: '--help', cwd: '/p' });
  assert.equal(flag.ok, false);
  assert.match(flag.error, /cannot start with/);
});

test('parseDispatchOutput finds an eight-hex id anywhere in the output, or returns null', () => {
  assert.equal(parseDispatchOutput('Started background session de3dfd18\nattach with claude attach de3dfd18\n'), 'de3dfd18');
  assert.equal(parseDispatchOutput('de3dfd18'), 'de3dfd18');
  assert.equal(parseDispatchOutput('deadbeefcafe is not an id, nor is 12345'), null);
  assert.equal(parseDispatchOutput(''), null);
  assert.ok(JOB_ID_RE.test('de3dfd18'));
  assert.ok(!JOB_ID_RE.test('DE3DFD18'));
});

test('parseDispatchOutput reads the id from the output measured on CLI 2.1.285, ANSI colour included', () => {
  const measured = 'backgrounded · \x1b[36m3f9a0c1e\x1b[39m · plan-check\n'
    + '\x1b[2m  claude agents\n  claude attach 3f9a0c1e\n  claude logs 3f9a0c1e\n  claude stop 3f9a0c1e\x1b[22m\n';
  assert.equal(parseDispatchOutput(measured), '3f9a0c1e');
  assert.equal(parseDispatchOutput('backgrounded · plan-check\n'), null);
});

test('parseJobState and parseCliList keep the blocked state a job reports while it waits', () => {
  assert.equal(parseJobState('{"state":"blocked","detail":"awaiting developer MR"}').state, 'blocked');
  const [s] = parseCliList(JSON.stringify([{ id: 'aaaaaaaa', sessionId: 's1', kind: 'background', state: 'blocked' }]));
  assert.equal(s.state, 'blocked');
});
