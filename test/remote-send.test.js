'use strict';

// Send a prompt to an unattached remote session over its CLI messaging socket
// (issue #219, first PR) — see .ai/contexts/session-cache.md ("Remote hosts — sending a prompt").
// Fake runner for the adapter; a real `sh` with a fake `nc` on PATH for the
// command itself, where sh exists (same stance as remote-transport-shell.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  buildPromptLine,
  buildSendCommand,
  buildDeliverSegment,
  validateSocketPath,
  createRemoteSendAdapter,
  handleSendRequest,
  MAX_LINE_BYTES,
  DEDUPE_WINDOW_MS,
  NOT_CLAUDE_EXIT_CODE,
  NO_SOCKET_EXIT_CODE,
  NC_MISSING_EXIT_CODE,
} = require('../remote-send');

const silentLog = { info() {}, warn() {}, error() {} };
const SOCKET = '/run/user/1000/cc-socks/4242.sock';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function descriptor(overrides = {}) {
  return { pid: 4242, sessionId: SESSION_ID, messagingSocketPath: SOCKET, ...overrides };
}

function makeRunner(result = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const run = async (alias, command, opts) => { calls.push({ alias, command, opts }); return typeof result === 'function' ? result(calls.length) : result; };
  run.calls = calls;
  return run;
}

function makeAdapter(runRemoteCommand, now = () => 1_000_000) {
  return createRemoteSendAdapter({ runRemoteCommand, now, log: silentLog });
}

// --- buildPromptLine -------------------------------------------------------

test('buildPromptLine: one NDJSON user message carrying the session id, ending in exactly one newline', () => {
  const line = buildPromptLine('hello', SESSION_ID);
  assert.ok(line.endsWith('\n'));
  assert.ok(!line.slice(0, -1).includes('\n'));
  assert.deepEqual(JSON.parse(line), {
    type: 'user', message: { role: 'user', content: 'hello' }, msgV: 1, session_id: SESSION_ID,
  });
});

test('buildPromptLine: an embedded newline stays escaped inside the JSON string', () => {
  const line = buildPromptLine('a\nb\r\nc', SESSION_ID);
  assert.equal(line.split('\n').length, 2, 'only the terminator is a raw newline');
  assert.equal(line.indexOf('\n'), line.length - 1);
  assert.equal(JSON.parse(line).message.content, 'a\nb\r\nc');
});

// --- validateSocketPath ----------------------------------------------------

test('validateSocketPath: accepts the CLI socket shapes seen on hosts', () => {
  for (const p of [SOCKET, '/var/tmp/my-host/cc-socks/9.sock', '/tmp/a_b.c/1.sock']) {
    assert.equal(validateSocketPath(p).ok, true, p);
  }
});

test('validateSocketPath: hostile, relative, dot-dot, odd-suffix and over-long paths are refused', () => {
  const tooLong = '/' + 'a'.repeat(104) + '.sock';
  assert.equal(Buffer.byteLength(tooLong), 110);
  const exactly107 = '/' + 'a'.repeat(101) + '.sock';
  assert.equal(Buffer.byteLength(exactly107), 107);
  assert.equal(validateSocketPath(exactly107).ok, true, '107 bytes is the limit, inclusive');
  const exactly108 = '/' + 'a'.repeat(102) + '.sock';
  assert.equal(Buffer.byteLength(exactly108), 108);
  assert.equal(validateSocketPath(exactly108).ok, false, '108 bytes does not fit sockaddr_un');
  const refused = [
    "/tmp/x'$(touch x).sock", '/tmp/a b.sock', '/tmp/a;rm.sock', '/tmp/`id`.sock', '/tmp/$HOME.sock',
    'relative/1.sock', './1.sock', '1.sock', '/tmp/../etc/1.sock', '/tmp/a..b.sock', '/tmp/1.sock/',
    '/tmp/1.txt', '/tmp/1.sock\n', '/tmp/é.sock', tooLong, '', null, undefined, 42, {},
  ];
  for (const p of refused) assert.equal(validateSocketPath(p).ok, false, JSON.stringify(p));
});

// --- buildSendCommand ------------------------------------------------------

test('buildSendCommand: fixed text, the integer pid and the single-quoted path only', () => {
  const cmd = buildSendCommand(4242, SOCKET);
  assert.ok(cmd.includes(`'${SOCKET}'`));
  assert.match(cmd, /\/proc\/4242\/cmdline/);
  assert.match(cmd, /-S '\/run\/user\/1000\/cc-socks\/4242\.sock'/);
  assert.match(cmd, /--send-only -U/);
  assert.match(cmd, /nc -N -U/);
  assert.ok(cmd.indexOf('/proc/4242/cmdline') < cmd.indexOf('-S '), 'the pid check runs before the socket test');
});

test('buildSendCommand: refuses an unsafe path or a bad pid by throwing, never by building', () => {
  assert.throws(() => buildSendCommand(4242, "/tmp/x'; touch y; '.sock"));
  assert.throws(() => buildSendCommand(4242, '/tmp/../x.sock'));
  assert.throws(() => buildSendCommand('4242; id', SOCKET));
  assert.throws(() => buildSendCommand(-1, SOCKET));
});

// --- adapter: argv and stdin -----------------------------------------------

test('send: the prompt text travels as the input option only, never inside the command', async () => {
  const hostile = "ZZQ'$(touch x)";
  const run = makeRunner();
  const res = await makeAdapter(run).send('planificator', descriptor(), hostile);
  assert.deepEqual(res, { ok: true });
  assert.equal(run.calls.length, 1);
  const { alias, command, opts } = run.calls[0];
  assert.equal(alias, 'planificator');
  assert.ok(!command.includes('ZZQ'), 'the text must not appear on the remote command line');
  assert.ok(!Object.entries(opts).some(([k, v]) => k !== 'input' && String(v).includes('ZZQ')));
  assert.equal(opts.input, buildPromptLine(hostile, SESSION_ID));
  assert.ok(opts.input.endsWith('\n') && opts.input.indexOf('\n') === opts.input.length - 1,
    'exactly one trailing newline');
  assert.ok(Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 && opts.timeoutMs <= 60000, 'a bounded timeout');
});

// --- adapter: refusals before any ssh --------------------------------------

test('send: no messaging socket in the descriptor has its own message and spawns nothing', async () => {
  const run = makeRunner();
  const res = await makeAdapter(run).send('h', descriptor({ messagingSocketPath: undefined }), 'hi');
  assert.equal(res.ok, false);
  assert.match(res.error, /no messaging socket/);
  assert.equal(run.calls.length, 0);
});

test('send: a Windows named pipe is refused with the key-file reason and spawns nothing', async () => {
  const run = makeRunner();
  const res = await makeAdapter(run).send('h', descriptor({ messagingSocketPath: '\\\\.\\pipe\\cc-4242' }), 'hi');
  assert.equal(res.ok, false);
  assert.match(res.error, /key file, which Switchboard does not read/);
  assert.doesNotMatch(res.error, /no messaging socket/);
  assert.equal(run.calls.length, 0);
});

test('send: a hostile or malformed socket path is refused and spawns nothing', async () => {
  for (const p of ["/tmp/x'$(id).sock", '../x.sock', '/tmp/../x.sock', '/' + 'a'.repeat(120) + '.sock', 12]) {
    const run = makeRunner();
    const res = await makeAdapter(run).send('h', descriptor({ messagingSocketPath: p }), 'hi');
    assert.equal(res.ok, false, String(p));
    assert.notEqual(res.error, undefined);
    assert.equal(run.calls.length, 0, `no spawn for ${p}`);
  }
});

test('send: a descriptor without a readable pid, or an empty text, spawns nothing', async () => {
  const run = makeRunner();
  const adapter = makeAdapter(run);
  assert.equal((await adapter.send('h', descriptor({ pid: 'x' }), 'hi')).ok, false);
  assert.equal((await adapter.send('h', descriptor(), '')).ok, false);
  assert.equal((await adapter.send('h', descriptor(), '   \n')).ok, false);
  assert.equal((await adapter.send('h', descriptor(), 42)).ok, false);
  assert.equal(run.calls.length, 0);
});

// --- adapter: size cap measured on bytes -----------------------------------

test('send: the 1 MiB cap is measured on the UTF-8 bytes of the whole line, boundary inclusive', async () => {
  const overhead = Buffer.byteLength(buildPromptLine('', SESSION_ID));
  const exact = 'a'.repeat(MAX_LINE_BYTES - overhead);
  assert.equal(Buffer.byteLength(buildPromptLine(exact, SESSION_ID)), MAX_LINE_BYTES);
  const run = makeRunner();
  assert.equal((await makeAdapter(run).send('h', descriptor(), exact)).ok, true, 'exactly at the cap is sent');

  const over = makeRunner();
  const tooBig = await makeAdapter(over).send('h', descriptor(), exact + 'a');
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /1 MiB/);
  assert.equal(over.calls.length, 0);

  const multibyte = 'é'.repeat(Math.ceil(MAX_LINE_BYTES / 2));
  assert.ok(multibyte.length < MAX_LINE_BYTES, 'fewer characters than the cap');
  const mb = makeRunner();
  const res = await makeAdapter(mb).send('h', descriptor(), multibyte);
  assert.equal(res.ok, false, 'but more bytes than the cap');
  assert.equal(mb.calls.length, 0);
});

// --- adapter: exit codes ---------------------------------------------------

test('send: exit codes map to their own messages and "sent" is never "delivered"', async () => {
  const cases = [
    [NOT_CLAUDE_EXIT_CODE, /not a claude CLI.*gone|gone.*not a claude/is],
    [NO_SOCKET_EXIT_CODE, /socket is gone|no longer there/i],
    [NC_MISSING_EXIT_CODE, /nc.*-U.*not found|not found.*nc/is],
  ];
  const seen = new Set();
  for (const [code, re] of cases) {
    const res = await makeAdapter(makeRunner({ code, stdout: '', stderr: '' })).send('h', descriptor(), 'hi');
    assert.equal(res.ok, false);
    assert.match(res.error, re, `exit ${code}`);
    seen.add(res.error);
  }
  assert.equal(seen.size, 3, 'three distinct messages');

  const other = await makeAdapter(makeRunner({ code: 255, stdout: '', stderr: 'ssh: Could not resolve hostname\n' })).send('h', descriptor(), 'hi');
  assert.equal(other.ok, false);
  assert.match(other.error, /exit 255/);
  assert.match(other.error, /Could not resolve hostname/);
  assert.doesNotMatch(other.error, /hi$/);

  const ok = await makeAdapter(makeRunner()).send('h', descriptor(), 'hi');
  assert.deepEqual(ok, { ok: true });
  assert.ok(!JSON.stringify(ok).includes('deliver'));
});

test('send: a timeout is a failure saying nothing confirms the line was written', async () => {
  const res = await makeAdapter(makeRunner({ code: -1, stdout: '', stderr: '', timedOut: true })).send('h', descriptor(), 'hi');
  assert.equal(res.ok, false);
  assert.match(res.error, /no confirmation that the line was written/);
});

test('send: a timeout arms the dedupe window, since the line may already be on the socket', async () => {
  let t = 1;
  const run = makeRunner({ code: -1, stdout: '', stderr: '', timedOut: true });
  const adapter = makeAdapter(run, () => t);
  const first = await adapter.send('h', descriptor(), 'maybe');
  assert.match(first.error, /may have been sent/);
  const again = await adapter.send('h', descriptor(), 'maybe');
  assert.match(again.error, /30 s/);
  assert.equal(run.calls.length, 1);
  t += 30_000;
  assert.match((await adapter.send('h', descriptor(), 'maybe')).error, /may have been sent/);
  assert.equal(run.calls.length, 2);
});

test('send: two concurrent sends of the same text spawn once; a definite failure releases the reservation', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const run = async (alias, command, opts) => { calls.push(opts); await gate; return { code: calls.length === 1 ? 255 : 0, stdout: '', stderr: 'down' }; };
  const adapter = makeAdapter(run, () => 1);
  const a = adapter.send('h', descriptor(), 'twice');
  const b = adapter.send('h', descriptor(), 'twice');
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls.length, 1, 'the second send is refused before any spawn');
  assert.equal(ra.ok, false);
  assert.match(rb.error, /30 s/);
  assert.equal((await adapter.send('h', descriptor(), 'twice')).ok, true, 'after the definite failure a retry is allowed');
});

test('send: a thrown runner and an empty answer release the reservation', async () => {
  const adapter1 = makeAdapter(async () => { throw new Error('boom'); }, () => 1);
  await adapter1.send('h', descriptor(), 'x');
  const adapter2 = makeAdapter(async () => null, () => 1);
  await adapter2.send('h', descriptor(), 'x');
  for (const [a, label] of [[adapter1, 'throw'], [adapter2, 'empty']]) {
    const res = await a.send('h', descriptor(), 'x');
    assert.doesNotMatch(res.error, /30 s/, label);
  }
});

test('send: a descriptor without a session id spawns nothing', async () => {
  const run = makeRunner();
  const res = await makeAdapter(run).send('h', descriptor({ sessionId: undefined }), 'hi');
  assert.equal(res.ok, false);
  assert.match(res.error, /no session id/);
  assert.equal(run.calls.length, 0);
});

test('send: a runner that throws or answers nothing is a failure', async () => {
  const thrower = async () => { throw new Error('boom'); };
  assert.equal((await makeAdapter(thrower).send('h', descriptor(), 'hi')).ok, false);
  assert.equal((await makeAdapter(async () => null).send('h', descriptor(), 'hi')).ok, false);
});

test('send: an error message never carries the prompt text', async () => {
  const secret = 'SECRET-PROMPT-TEXT';
  for (const result of [{ code: 1, stdout: '', stderr: 'x' }, { code: -1, timedOut: true, stdout: '', stderr: '' }, { code: 7, stdout: '', stderr: '' }]) {
    const res = await makeAdapter(makeRunner(result)).send('h', descriptor(), secret);
    assert.ok(!res.error.includes(secret));
  }
});

// --- adapter: 30 s dedupe on an injected clock -----------------------------

test('send: the same text to the same session less than 30 s later is refused, then allowed after', async () => {
  let t = 5_000;
  const run = makeRunner();
  const adapter = makeAdapter(run, () => t);
  assert.equal((await adapter.send('h', descriptor(), 'same')).ok, true);

  t += 29_999;
  const dup = await adapter.send('h', descriptor(), 'same');
  assert.equal(dup.ok, false);
  assert.match(dup.error, /30 s/);
  assert.equal(run.calls.length, 1, 'the duplicate spawns nothing');

  t += 1;
  assert.equal(DEDUPE_WINDOW_MS, 30_000);
  assert.equal((await adapter.send('h', descriptor(), 'same')).ok, true, 'exactly 30 s later it goes through');
  assert.equal(run.calls.length, 2);
});

test('send: the dedupe is per session, per host and per text', async () => {
  const run = makeRunner();
  const adapter = makeAdapter(run, () => 1);
  assert.equal((await adapter.send('h', descriptor(), 'same')).ok, true);
  assert.equal((await adapter.send('h', descriptor(), 'other')).ok, true);
  assert.equal((await adapter.send('h', descriptor({ sessionId: 'another-session' }), 'same')).ok, true);
  assert.equal((await adapter.send('h2', descriptor(), 'same')).ok, true);
  assert.equal(run.calls.length, 4);
});

test('send: a failed send does not arm the dedupe window', async () => {
  const run = makeRunner((n) => (n === 1 ? { code: 255, stdout: '', stderr: 'down' } : { code: 0, stdout: '', stderr: '' }));
  const adapter = makeAdapter(run, () => 1);
  assert.equal((await adapter.send('h', descriptor(), 'again')).ok, false);
  assert.equal((await adapter.send('h', descriptor(), 'again')).ok, true, 'a retry after a failure is not a duplicate');
});

// --- handleSendRequest: the IPC contract -----------------------------------

test('handleSendRequest: the descriptor, and so the socket path, comes from the main side only', async () => {
  const sent = [];
  const adapter = { send: async (alias, d, text) => { sent.push({ alias, d, text }); return { ok: true }; } };
  const mine = descriptor();
  const res = await handleSendRequest(
    { alias: 'h', sessionId: SESSION_ID, text: 'hi', messagingSocketPath: '/tmp/evil.sock', pid: 1, descriptor: { messagingSocketPath: '/tmp/evil2.sock' } },
    { getDescriptor: (alias, id) => (alias === 'h' && id === SESSION_ID ? mine : undefined), isAttached: () => false, adapter },
  );
  assert.deepEqual(res, { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].d, mine);
  assert.equal(sent[0].d.messagingSocketPath, SOCKET);
});

test('handleSendRequest: a text longer than the cap in characters is refused before the adapter', async () => {
  let calls = 0;
  const res = await handleSendRequest({ alias: 'h', sessionId: 'x', text: 'a'.repeat(MAX_LINE_BYTES + 1) },
    { getDescriptor: () => descriptor(), isAttached: () => false, adapter: { send: async () => { calls++; return { ok: true }; } } });
  assert.equal(res.ok, false);
  assert.match(res.error, /1 MiB/);
  assert.equal(calls, 0);
});

test('handleSendRequest: a malformed payload, an unknown session or an attached one is refused before the adapter', async () => {
  let calls = 0;
  const adapter = { send: async () => { calls++; return { ok: true }; } };
  const deps = { getDescriptor: () => descriptor(), isAttached: () => false, adapter };
  for (const payload of [null, undefined, {}, { alias: 'h' }, { alias: 'h', sessionId: 'x' }, { alias: '', sessionId: 'x', text: 'a' },
    { alias: 'h', sessionId: 'x', text: 5 }, { alias: 5, sessionId: 'x', text: 'a' }]) {
    const res = await handleSendRequest(payload, deps);
    assert.equal(res.ok, false, JSON.stringify(payload));
  }
  const unknown = await handleSendRequest({ alias: 'h', sessionId: 'x', text: 'a' }, { ...deps, getDescriptor: () => undefined });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /not found on that host/);
  const attached = await handleSendRequest({ alias: 'h', sessionId: 'x', text: 'a' }, { ...deps, isAttached: () => true });
  assert.equal(attached.ok, false);
  assert.match(attached.error, /attached/);
  assert.equal(calls, 0);
});

// --- real sh with a fake nc ------------------------------------------------

function shAvailable() {
  const r = spawnSync('sh', ['-c', 'exit 0']);
  return !r.error && r.status === 0;
}
const SH_SKIP = shAvailable() ? false : 'sh is not available on this machine';

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-send-'));
}

const OPENBSD_HELP = 'usage: nc [-46CDdFhklNnrStUuvZz] [-I length] [-i interval] [-M ttl]';
const BUSYBOX_HELP = 'BusyBox v1.36.1 multi-call binary.\nUsage: nc [OPTIONS] HOST PORT  - connect\n -l -p PORT -w SEC -s ADDR -e PROG';
const TRADITIONAL_HELP = '[v1.10-47]\nconnect to somewhere:\tnc [-options] hostname port[s] [ports] ...\n\t-U\t\tUse UNIX domain socket';
const NCAT_HELP = 'Ncat 7.93\n  --send-only  Only send data, ignoring received; quit on EOF';

function writeFakeNc(binDir, name, outDir, help) {
  const file = path.join(binDir, name);
  const outPath = outDir.split(path.sep).join('/');
  const helpText = help || (name === 'ncat' ? NCAT_HELP : OPENBSD_HELP);
  fs.writeFileSync(`${file}.help`, helpText);
  fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in -h|--help) cat "$0.help"; exit 0;; esac\nprintf '%s\\n' "${name} $*" > "${outPath}/${name}.argv"\ncat > "${outPath}/${name}.stdin"\nexit \${FAKE_NC_EXIT:-0}\n`, { mode: 0o755 });
}

function runSh(script, input, binDir, extraEnv = {}) {
  return spawnSync('sh', ['-c', script], {
    input, encoding: 'utf8',
    env: { ...process.env, PATH: binDir + path.delimiter + process.env.PATH, ...extraEnv },
  });
}

test('deliver segment: the fake nc receives the exact line on stdin and the path in argv (nc variant)', { skip: SH_SKIP }, () => {
  const dir = sandbox();
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    writeFakeNc(bin, 'nc', dir);
    const line = buildPromptLine("ZZQ'$(touch x)\nsecond", SESSION_ID);
    const r = runSh(buildDeliverSegment(SOCKET), line, bin);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'nc.stdin'), 'utf8'), line, 'stdin is byte-exact');
    assert.equal(fs.readFileSync(path.join(dir, 'nc.argv'), 'utf8').trim(), `nc -N -U ${SOCKET}`);
    assert.ok(!fs.existsSync(path.join(dir, 'x')), 'nothing was evaluated');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deliver segment: ncat wins over nc and uses --send-only', { skip: SH_SKIP }, () => {
  const dir = sandbox();
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    writeFakeNc(bin, 'nc', dir);
    writeFakeNc(bin, 'ncat', dir);
    const line = buildPromptLine('hello', SESSION_ID);
    const r = runSh(buildDeliverSegment(SOCKET), line, bin);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'ncat.stdin'), 'utf8'), line);
    assert.equal(fs.readFileSync(path.join(dir, 'ncat.argv'), 'utf8').trim(), `ncat --send-only -U ${SOCKET}`);
    assert.ok(!fs.existsSync(path.join(dir, 'nc.stdin')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deliver segment: an nc without -N/-U (busybox, netcat-traditional) is never run and exits 127', { skip: SH_SKIP }, () => {
  for (const help of [BUSYBOX_HELP, TRADITIONAL_HELP]) {
    const dir = sandbox();
    try {
      const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
      writeFakeNc(bin, 'nc', dir, help);
      const r = runSh(buildDeliverSegment(SOCKET), 'x\n', bin);
      assert.equal(r.status, NC_MISSING_EXIT_CODE, help);
      assert.ok(!fs.existsSync(path.join(dir, 'nc.argv')), 'the unsupported nc never received the line');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('deliver segment: an ncat without --send-only falls back to a capable nc', { skip: SH_SKIP }, () => {
  const dir = sandbox();
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    writeFakeNc(bin, 'ncat', dir, 'Ncat 5.0 no such flag');
    writeFakeNc(bin, 'nc', dir);
    const r = runSh(buildDeliverSegment(SOCKET), 'x\n', bin);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(dir, 'ncat.argv')));
    assert.ok(fs.existsSync(path.join(dir, 'nc.argv')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deliver segment: the exit status of nc is the exit status of the command', { skip: SH_SKIP }, () => {
  const dir = sandbox();
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    writeFakeNc(bin, 'nc', dir);
    const r = runSh(buildDeliverSegment(SOCKET), 'x\n', bin, { FAKE_NC_EXIT: '3' });
    assert.equal(r.status, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('send command: a pid that is not a claude process exits with the not-claude status before any nc', { skip: SH_SKIP }, () => {
  const dir = sandbox();
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    writeFakeNc(bin, 'nc', dir);
    const r = runSh(buildSendCommand(2147483000, SOCKET), 'x\n', bin);
    assert.equal(r.status, NOT_CLAUDE_EXIT_CODE);
    assert.ok(!fs.existsSync(path.join(dir, 'nc.argv')), 'nc never ran');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function procCmdlineWorks() {
  try { return fs.existsSync('/proc/self/cmdline'); } catch { return false; }
}

test('send command: a live claude pid with a missing socket exits with the no-socket status; with a socket the line reaches nc', { skip: SH_SKIP || (procCmdlineWorks() ? false : 'no /proc/<pid>/cmdline here') }, async () => {
  const dir = sandbox();
  const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)', 'claude'], { stdio: 'ignore' });
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    writeFakeNc(bin, 'nc', dir);
    const sock = path.join(dir, 'a.sock').split(path.sep).join('/');
    if (!validateSocketPath(sock).ok) return;
    const missing = runSh(buildSendCommand(child.pid, sock), 'x\n', bin);
    assert.equal(missing.status, NO_SOCKET_EXIT_CODE);
    const server = require('net').createServer();
    await new Promise((resolve, reject) => {
      server.listen(sock, () => {
        const line = buildPromptLine('hi', SESSION_ID);
        const r = runSh(buildSendCommand(child.pid, sock), line, bin);
        server.close();
        try {
          assert.equal(r.status, 0, r.stderr);
          assert.equal(fs.readFileSync(path.join(dir, 'nc.stdin'), 'utf8'), line);
          resolve();
        } catch (e) { reject(e); }
      });
    });
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- wiring: the renderer sends {alias, sessionId, text} and nothing else -----

test('wiring: preload forwards exactly {alias, sessionId, text} and main routes through handleSendRequest', () => {
  const root = path.join(__dirname, '..');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const m = /remoteSendPrompt:\s*\(([^)]*)\)\s*=>\s*ipcRenderer\.invoke\('remote-send-prompt',\s*(\{[^}]*\})\)/.exec(preload);
  assert.ok(m, 'preload exposes remoteSendPrompt over remote-send-prompt');
  assert.equal(m[1].replace(/\s/g, ''), 'alias,sessionId,text');
  assert.equal(m[2].replace(/\s/g, ''), '{alias,sessionId,text}');

  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('remote-send-prompt'");
  assert.notEqual(start, -1);
  const handler = main.slice(start, main.indexOf('\n}));', start) + 5);
  assert.match(handler, /handleSendRequest\(payload,/);
  assert.match(handler, /remoteIndexer\.getRemoteSessions\(alias\)/);
  assert.doesNotMatch(handler, /messagingSocketPath/, 'the socket path is never read at the IPC edge');
});
