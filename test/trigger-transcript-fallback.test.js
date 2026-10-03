// test/trigger-transcript-fallback.test.js
//
// The transcript fallback for a descriptor held "busy" (or "shell") by
// background work while the prompt is free (issue #360). See
// .ai/contexts/trigger-watcher.md, "Transcript fallback while the descriptor
// stays busy".
'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '400';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '50';
process.env.SWITCHBOARD_BUSY_RISE_WAIT_MS = '100';
process.env.SWITCHBOARD_TRANSCRIPT_QUIET_MS = '300';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { start, waitForBusyFall, waitForCliIdleAfter } = require('../trigger-watcher');
const { createTriggerContext } = require('../trigger-context');
const { classifyTranscriptTail, createTranscriptTurnReader } = require('../transcript-turn');

function mkTmp(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const iso = (ms) => new Date(ms).toISOString();
const userPrompt  = (at, extra = {}) => ({ type: 'user', timestamp: iso(at), message: { role: 'user', content: 'do it' }, ...extra });
const toolResult  = (at) => ({ type: 'user', timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const assistant   = (at, stopReason, extra = {}) => ({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text: 'x' }] }, ...extra });
const systemEntry = (at, subtype) => ({ type: 'system', subtype, timestamp: iso(at) });
const queueOp     = (at, operation) => ({ type: 'queue-operation', operation, timestamp: iso(at) });
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

// ── The transcript classification ───────────────────────────────────────────

test('classify: a closed assistant turn followed only by bookkeeping entries is closed, stamped at that entry', () => {
  const t = classifyTranscriptTail(jsonl([
    userPrompt(1000), assistant(2000, 'tool_use'), toolResult(2500), assistant(3000, 'end_turn'),
    systemEntry(3100, 'stop_hook_summary'), systemEntry(3200, 'turn_duration'), { type: 'last-prompt' },
  ]));
  assert.equal(t.closed, true);
  assert.equal(t.closedAt, 3000);
});

test('classify: a last assistant entry that is a tool_use is not closed', () => {
  const t = classifyTranscriptTail(jsonl([userPrompt(1000), assistant(2000, 'tool_use')]));
  assert.equal(t.closed, false);
});

for (const [name, entry] of [['a user prompt', userPrompt(4000)], ['a tool_result', toolResult(4000)], ['a meta user prompt', userPrompt(4000, { isMeta: true })]]) {
  test(`classify: ${name} after a closed turn means a turn is in progress`, () => {
    const t = classifyTranscriptTail(jsonl([assistant(3000, 'end_turn'), entry]));
    assert.equal(t.closed, false);
  });
}

test('classify: sidechain entries after the closed turn do not count as the main turn', () => {
  const t = classifyTranscriptTail(jsonl([
    assistant(3000, 'end_turn'), userPrompt(3500, { isSidechain: true }), assistant(3600, 'tool_use', { isSidechain: true }),
  ]));
  assert.equal(t.closed, true);
  assert.equal(t.closedAt, 3000);
});

test('classify: a prompt enqueued after the closed turn and not removed means a turn is coming', () => {
  assert.equal(classifyTranscriptTail(jsonl([assistant(3000, 'end_turn'), queueOp(3500, 'enqueue')])).closed, false);
  assert.equal(classifyTranscriptTail(jsonl([assistant(3000, 'end_turn'), queueOp(3500, 'enqueue'), queueOp(3600, 'dequeue')])).closed, false);
  assert.equal(classifyTranscriptTail(jsonl([assistant(3000, 'end_turn'), queueOp(3500, 'enqueue'), queueOp(3600, 'remove')])).closed, true);
});

// The shape /compact leaves in a real transcript (CLI measured 2026-10-03),
// with synthetic text: boundary, summary, caveat, the command, its stdout,
// then attachments.
const localStdout   = (at, text = 'Compacted') => ({ type: 'user', timestamp: iso(at), message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } });
const slashCommand  = (at, name) => ({ type: 'user', timestamp: iso(at), message: { role: 'user', content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args></command-args>` } });
const caveat        = (at) => ({ type: 'user', isMeta: true, timestamp: iso(at), message: { role: 'user', content: '<local-command-caveat>Caveat: synthetic.</local-command-caveat>' } });
const compactSummary = (at) => ({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: iso(at), message: { role: 'user', content: 'This session is being continued. Synthetic summary.' } });
const attachment    = (at) => ({ type: 'attachment', timestamp: iso(at), attachment: { type: 'file' } });
const compactWrites = (enterAt, doneAt) => [
  systemEntry(doneAt + 800, 'compact_boundary'), compactSummary(doneAt), caveat(enterAt), slashCommand(enterAt, 'compact'),
  localStdout(doneAt + 900), attachment(doneAt + 100), attachment(doneAt + 110),
];

test('classify: what /compact leaves (stdout of the local command last) is a closed turn, stamped at the stdout', () => {
  const t = classifyTranscriptTail(jsonl([userPrompt(1000), assistant(2000, 'end_turn'), ...compactWrites(3000, 50_000)]));
  assert.equal(t.closed, true);
  assert.equal(t.closedAt, 50_900);
});

test('classify: the compaction summary as the last main-thread entry is a closed turn, stamped at the summary', () => {
  const t = classifyTranscriptTail(jsonl([assistant(2000, 'end_turn'), systemEntry(50_800, 'compact_boundary'), compactSummary(50_000)]));
  assert.equal(t.closed, true);
  assert.equal(t.closedAt, 50_000);
});

test('classify: the output of another local command (/model) last is a closed turn', () => {
  const t = classifyTranscriptTail(jsonl([assistant(2000, 'end_turn'), caveat(3000), slashCommand(3000, 'model'), localStdout(3100, 'Set model to x')]));
  assert.equal(t.closed, true);
  assert.equal(t.closedAt, 3100);
});

for (const [name, entries] of [
  ['a slash command expanding into a prompt', [slashCommand(3000, 'tdd')]],
  ['the local command caveat alone', [caveat(3000)]],
  ['user text quoting a stdout block', [{ ...localStdout(3000), message: { role: 'user', content: 'see this: <local-command-stdout>x</local-command-stdout>' } }]],
  ['a stdout block followed by more user text', [{ ...localStdout(3000), message: { role: 'user', content: '<local-command-stdout>x</local-command-stdout> and go on' } }]],
  ['a tool_result carrying a stdout block', [{ type: 'user', timestamp: iso(3000), message: { role: 'user', content: [{ type: 'tool_result', content: '<local-command-stdout>x</local-command-stdout>' }] } }]],
  ['a user prompt followed by a sidechain stdout', [userPrompt(2900), { ...localStdout(3000, 'x'), isSidechain: true }]],
]) {
  test(`classify: ${name} last is not a closed turn`, () => {
    const t = classifyTranscriptTail(jsonl([assistant(2000, 'end_turn'), ...entries]));
    assert.equal(t.closed, false);
  });
}

test('classify: a local command output followed by a queued prompt, or unstamped, is not closed', () => {
  assert.equal(classifyTranscriptTail(jsonl([localStdout(3000), queueOp(3500, 'enqueue')])).closed, false);
  const unstamped = localStdout(3000);
  delete unstamped.timestamp;
  assert.equal(classifyTranscriptTail(jsonl([unstamped])).closed, false);
});

test('classify: no message entry at all, or an unstamped closed turn, is never closed', () => {
  assert.equal(classifyTranscriptTail(jsonl([systemEntry(1, 'x')])).closed, false);
  const unstamped = assistant(3000, 'end_turn');
  delete unstamped.timestamp;
  assert.equal(classifyTranscriptTail(jsonl([unstamped])).closed, false);
});

test('classify: the latest stamp of any main-thread entry is reported, sidechain stamps are not', () => {
  const t = classifyTranscriptTail(jsonl([assistant(3000, 'end_turn'), queueOp(5000, 'enqueue'), userPrompt(9000, { isSidechain: true })]));
  assert.equal(t.lastEntryAt, 5000);
});

test('classify: a tail cut mid-line skips the unparseable partial line', () => {
  const text = '"stop_reason":"end_turn"}}\n' + jsonl([toolResult(4000)]);
  assert.equal(classifyTranscriptTail(text).closed, false);
});

test('reader: reads the file tail, reports its mtime, and returns null for a missing file', () => {
  const dir = mkTmp('sw-transcript-reader-');
  try {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, 'x'.repeat(5000) + '\n' + jsonl([assistant(3000, 'end_turn')]));
    const reader = createTranscriptTurnReader({ tailBytes: 1024 });
    const t = reader.read(file);
    assert.equal(t.closed, true);
    assert.equal(t.mtimeMs, fs.statSync(file).mtimeMs);
    fs.appendFileSync(file, jsonl([toolResult(4000)]));
    assert.equal(reader.read(file).closed, false);
    assert.equal(reader.read(path.join(dir, 'missing.jsonl')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trigger context: getTranscriptTurn reads <projectsDir>/<projectFolder>/<real id>.jsonl of a local session only', () => {
  const dir = mkTmp('sw-transcript-ctx-');
  try {
    fs.mkdirSync(path.join(dir, 'C--proj'));
    fs.writeFileSync(path.join(dir, 'C--proj', 'real-id.jsonl'), jsonl([assistant(3000, 'end_turn')]));
    const base = { pty: { pid: process.pid, write() {} }, projectFolder: 'C--proj' };
    const ctx = createTriggerContext({
      activeSessions: new Map([
        ['tmp-id', { ...base, realSessionId: 'real-id' }],
        ['remote', { ...base, host: 'h', realSessionId: 'real-id' }],
        ['nofolder', { pty: base.pty }],
      ]),
      log: { info() {}, warn() {}, error() {} },
      projectsDir: dir,
    });
    assert.equal(ctx.getTranscriptTurn('tmp-id').closed, true);
    assert.equal(ctx.getTranscriptTurn('remote'), null);
    assert.equal(ctx.getTranscriptTurn('nofolder'), null);
    assert.equal(ctx.getTranscriptTurn('unknown'), null);
    assert.equal(createTriggerContext({ activeSessions: new Map(), log: {} }).getTranscriptTurn, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The wait helpers, under mocked timers ───────────────────────────────────

function fakeClock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
}

async function settleRun(t, promise, maxMs = 5000) {
  let done = false;
  let value;
  promise.then((v) => { done = true; value = v; });
  for (let i = 0; i < maxMs && !done; i += 5) {
    t.mock.timers.tick(5);
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(done, 'still pending');
  return value;
}

function fallbackCtx(desc, turn) {
  return {
    getPtyForSession: () => ({}),
    isSessionBusy: () => true,
    getCliStatus: () => ({ ...desc }),
    getTranscriptTurn: () => (turn ? { ...turn } : null),
  };
}

const T = { transcriptAfterMs: -Infinity };

test('readiness: busy descriptor, closed turn quiet for the window -> ready from the transcript', async (t) => {
  fakeClock(t);
  const ctx = fallbackCtx({ status: 'busy', statusUpdatedAt: 900_000 }, { closed: true, closedAt: 999_000, lastEntryAt: 999_000, mtimeMs: 999_900 });
  const r = await settleRun(t, waitForCliIdleAfter('sid', ctx, -Infinity, 1_000_000 + 3000, 50, false, T));
  assert.equal(r.ready, true);
  assert.equal(r.source, 'transcript');
  assert.ok(r.waited_ms >= 200, 'ready after ' + r.waited_ms + ' ms, before the file had been quiet for 300 ms');
});

test('readiness: the fallback also applies to a "shell" descriptor', async (t) => {
  fakeClock(t);
  const ctx = fallbackCtx({ status: 'shell', statusUpdatedAt: 900_000 }, { closed: true, closedAt: 999_000, lastEntryAt: 999_000, mtimeMs: 990_000 });
  const r = await settleRun(t, waitForCliIdleAfter('sid', ctx, -Infinity, 1_000_000 + 3000, 50, false, T));
  assert.equal(r.ready, true);
  assert.equal(r.source, 'transcript');
});

test('readiness: a transcript still in a turn keeps the wait going to the deadline', async (t) => {
  fakeClock(t);
  const ctx = fallbackCtx({ status: 'busy', statusUpdatedAt: 900_000 }, { closed: false, closedAt: 980_000, lastEntryAt: 990_000, mtimeMs: 990_000 });
  const r = await settleRun(t, waitForCliIdleAfter('sid', ctx, -Infinity, 1_000_000 + 1000, 50, false, T));
  assert.equal(r.ready, false);
  assert.equal(r.timedOut, true);
});

test('readiness: a closed turn whose file changed inside the window waits until it is quiet', async (t) => {
  fakeClock(t);
  const turn = { closed: true, closedAt: 999_000, lastEntryAt: 999_000, mtimeMs: 1_000_000 };
  const ctx = { ...fallbackCtx({ status: 'busy', statusUpdatedAt: 900_000 }, null), getTranscriptTurn: () => ({ ...turn }) };
  setTimeout(() => { turn.mtimeMs = Date.now(); }, 200);
  const r = await settleRun(t, waitForCliIdleAfter('sid', ctx, -Infinity, 1_000_000 + 3000, 50, false, T));
  assert.equal(r.ready, true);
  assert.ok(r.waited_ms >= 500, 'ready after ' + r.waited_ms + ' ms, the write at 200 ms must restart the quiet window');
});

test('readiness: a closed turn older than the anchor (the previous step\'s Enter) is not readiness', async (t) => {
  fakeClock(t);
  const ctx = fallbackCtx({ status: 'busy', statusUpdatedAt: 900_000 }, { closed: true, closedAt: 999_000, lastEntryAt: 999_000, mtimeMs: 990_000 });
  const r = await settleRun(t, waitForCliIdleAfter('sid', ctx, -Infinity, 1_000_000 + 1000, 50, false, { transcriptAfterMs: 999_500 }));
  assert.equal(r.ready, false);
  assert.equal(r.timedOut, true);
});

test('readiness: a dialog seen inside the window blocks the fallback', async (t) => {
  fakeClock(t);
  const desc = { status: 'waiting', statusUpdatedAt: 1_000_000 };
  const ctx = { ...fallbackCtx(desc, { closed: true, closedAt: 999_000, lastEntryAt: 999_000, mtimeMs: 990_000 }), getCliStatus: () => ({ ...desc }) };
  setTimeout(() => { desc.status = 'busy'; desc.statusUpdatedAt = Date.now(); }, 50);
  const r = await settleRun(t, waitForCliIdleAfter('sid', ctx, -Infinity, 1_000_000 + 2000, 300, false, T));
  assert.equal(r.ready, true);
  assert.equal(r.source, 'transcript');
  assert.ok(r.waited_ms >= 350, 'ready after ' + r.waited_ms + ' ms, while the dialog was still inside the window');
});

test('readiness: an idle descriptor older than the compact anchor stays in charge, the transcript is not read', async (t) => {
  fakeClock(t);
  let transcriptReads = 0;
  const ctx = {
    ...fallbackCtx({ status: 'idle', statusUpdatedAt: 999_000 }, null),
    getTranscriptTurn: () => { transcriptReads += 1; return { closed: true, closedAt: 999_900, lastEntryAt: 999_900, mtimeMs: 990_000 }; },
  };
  const r = await settleRun(t, waitForCliIdleAfter('sid', ctx, 999_500, 1_000_000 + 1000, 50, false, T));
  assert.equal(r.ready, false);
  assert.equal(transcriptReads, 0);
});

test('readiness: without the transcript option the busy descriptor keeps the wait going (single triggers unchanged)', async (t) => {
  fakeClock(t);
  const ctx = fallbackCtx({ status: 'busy', statusUpdatedAt: 900_000 }, { closed: true, closedAt: 999_000, lastEntryAt: 999_000, mtimeMs: 990_000 });
  const r = await settleRun(t, waitForCliIdleAfter('sid', ctx, -Infinity, 1_000_000 + 1000, 50));
  assert.equal(r.ready, false);
});

test('readiness: an idle descriptor keeps its own path and reports it', async (t) => {
  fakeClock(t);
  let transcriptReads = 0;
  const ctx = { ...fallbackCtx({ status: 'idle', statusUpdatedAt: 900_000 }, null), getTranscriptTurn: () => { transcriptReads += 1; return null; } };
  const r = await settleRun(t, waitForCliIdleAfter('sid', ctx, -Infinity, 1_000_000 + 1000, 50, false, T));
  assert.equal(r.ready, true);
  assert.equal(r.source, 'descriptor');
  assert.equal(transcriptReads, 0);
});

test('readiness: a transcript reader that throws is not readiness', async (t) => {
  fakeClock(t);
  const ctx = { ...fallbackCtx({ status: 'busy', statusUpdatedAt: 900_000 }, null), getTranscriptTurn: () => { throw new Error('EBUSY'); } };
  const r = await settleRun(t, waitForCliIdleAfter('sid', ctx, -Infinity, 1_000_000 + 600, 50, false, T));
  assert.equal(r.ready, false);
  assert.equal(r.timedOut, true);
});

test('busy-fall: busy descriptor, _cliBusy stuck, turn closed after the Enter and quiet -> ends from the transcript', async (t) => {
  fakeClock(t);
  const ctx = fallbackCtx({ status: 'busy', statusUpdatedAt: 900_000 }, { closed: true, closedAt: 1_000_100, lastEntryAt: 1_000_100, mtimeMs: 1_000_100 });
  const r = await settleRun(t, waitForBusyFall('sid', ctx, 1_000_000 + 3000, 1_000_000));
  assert.equal(r.timedOut, false);
  assert.equal(r.source, 'transcript');
  assert.ok(r.waited_ms >= 350, 'ended after ' + r.waited_ms + ' ms, before the file had been quiet for 300 ms');
});

test('busy-fall: a closed turn that predates the Enter does not end the wait', async (t) => {
  fakeClock(t);
  const ctx = fallbackCtx({ status: 'busy', statusUpdatedAt: 900_000 }, { closed: true, closedAt: 999_000, lastEntryAt: 999_000, mtimeMs: 999_000 });
  const r = await settleRun(t, waitForBusyFall('sid', ctx, 1_000_000 + 1000, 1_000_000));
  assert.equal(r.timedOut, true);
});

test('busy-fall: a long tool call (transcript not closed) keeps the wait going', async (t) => {
  fakeClock(t);
  const ctx = fallbackCtx({ status: 'busy', statusUpdatedAt: 900_000 }, { closed: false, closedAt: null, lastEntryAt: 1_000_050, mtimeMs: 1_000_050 });
  const r = await settleRun(t, waitForBusyFall('sid', ctx, 1_000_000 + 1000, 1_000_000));
  assert.equal(r.timedOut, true);
});

test('busy-fall: the descriptor idle path reports its source', async (t) => {
  fakeClock(t);
  const desc = { status: 'busy', statusUpdatedAt: 900_000 };
  setTimeout(() => { desc.status = 'idle'; desc.statusUpdatedAt = Date.now(); }, 100);
  const ctx = { ...fallbackCtx(desc, null), getCliStatus: () => ({ ...desc }) };
  const r = await settleRun(t, waitForBusyFall('sid', ctx, 1_000_000 + 3000, 1_000_000));
  assert.equal(r.source, 'descriptor');
});

test('busy-fall: the level probe and the never-rose bound report their sources', async (t) => {
  fakeClock(t);
  let busy = true;
  setTimeout(() => { busy = false; }, 50);
  const level = { getPtyForSession: () => ({}), isSessionBusy: () => busy };
  assert.equal((await settleRun(t, waitForBusyFall('sid', level, 1_000_000 + 3000))).source, 'busy_flag');
  const never = { getPtyForSession: () => ({}), isSessionBusy: () => false };
  assert.equal((await settleRun(t, waitForBusyFall('sid', never, Date.now() + 3000))).source, 'no_rise');
});

// ── The chain, through the real watcher and the real trigger context ───────

function transcriptSession(sessionId, { onEnter }) {
  const projectsDir = mkTmp('sw-transcript-projects-');
  fs.mkdirSync(path.join(projectsDir, 'C--proj'));
  const file = path.join(projectsDir, 'C--proj', sessionId + '.jsonl');
  const old = Date.now() - 60_000;
  fs.writeFileSync(file, jsonl([userPrompt(old - 1000), assistant(old, 'end_turn'), systemEntry(old + 100, 'turn_duration')]));
  const past = new Date(old + 200);
  fs.utimesSync(file, past, past);

  const written = [];
  const desc = { status: 'busy', statusUpdatedAt: Date.now() - 30_000 };
  const append = (entries) => {
    if (fs.existsSync(projectsDir)) fs.appendFileSync(file, jsonl(entries));
  };
  const session = {
    pty: {
      pid: process.pid,
      write(data) {
        written.push({ data, at: Date.now() });
        if (data === '\r') onEnter({ append, desc, n: written.filter((w) => w.data === '\r').length });
      },
    },
    projectFolder: 'C--proj',
    _cliBusy: true,
    composerState: { pending: 0, lastInputAt: 0 },
  };
  const ctx = createTriggerContext({
    activeSessions: new Map([[sessionId, session]]),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    isPtyAlive: () => true,
    getCliStatus: () => ({ ...desc }),
    projectsDir,
  });
  return { ctx, written, desc, file, session, cleanup: () => fs.rmSync(projectsDir, { recursive: true, force: true }) };
}

async function runChain(chain, session, uuid, timeoutMs) {
  const tmp = mkTmp('sw-transcript-triggers-');
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;
  const watcher = start(session.ctx);
  try {
    fs.writeFileSync(path.join(tmp, uuid + '.json'),
      JSON.stringify({ sessionId: uuid, wait: 'none', chain, timeout_ms: timeoutMs }), 'utf8');
    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    const deadline = Date.now() + timeoutMs + 5000;
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline) throw new Error('no result file');
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 20));
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } finally {
    watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function closedTurnAfter(delayMs) {
  return ({ append }) => {
    append([queueOp(Date.now(), 'enqueue'), queueOp(Date.now(), 'dequeue'), userPrompt(Date.now())]);
    setTimeout(() => append([assistant(Date.now(), 'end_turn'), systemEntry(Date.now(), 'turn_duration')]), delayMs);
  };
}

test('chain: a descriptor held busy by background agents, the turn closed and quiet -> step 1 is written', async () => {
  const uuid = 'sess-tx-proceeds-' + Date.now();
  const s = transcriptSession(uuid, { onEnter: closedTurnAfter(100) });
  try {
    const result = await runChain([{ command: 'first step' }, { command: 'second step' }], s, uuid, 6000);

    assert.ok(s.written.some((w) => w.data === 'second step'), 'step 1 was never written: ' + JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.steps[0].idle_source, 'transcript');
    assert.equal(result.steps[0].ready_source, 'transcript');
    assert.equal(result.steps[1].ready_source, 'transcript');
    assert.equal(result.steps[0].submit_confirmed, true);
  } finally {
    s.cleanup();
  }
});

test('chain: a closed turn older than the previous step\'s Enter does not release the next step', async () => {
  const uuid = 'sess-tx-anchor-' + Date.now();
  let s;
  s = transcriptSession(uuid, {
    onEnter: ({ desc }) => {
      desc.statusUpdatedAt = Date.now();
      s.session._cliBusy = true;
      setTimeout(() => { s.session._cliBusy = false; }, 100);
    },
  });
  s.session._cliBusy = false;
  try {
    const result = await runChain([{ command: 'first step' }, { command: 'second step' }], s, uuid, 2500);

    assert.ok(!s.written.some((w) => w.data === 'second step'), 'the turn closed before step 0 released step 1');
    assert.equal(result.ok, false);
    assert.equal(result.steps_completed, 1);
    assert.equal(result.steps[0].idle_source, 'busy_flag');
  } finally {
    s.cleanup();
  }
});

test('chain: busy descriptor and a long tool call (last entry tool_use) -> step 1 is never written', async () => {
  const uuid = 'sess-tx-tooluse-' + Date.now();
  const s = transcriptSession(uuid, {
    onEnter: ({ append }) => {
      append([userPrompt(Date.now())]);
      setTimeout(() => append([assistant(Date.now(), 'tool_use')]), 100);
    },
  });
  try {
    const result = await runChain([{ command: 'first step' }, { command: 'second step' }], s, uuid, 2500);

    assert.ok(!s.written.some((w) => w.data === 'second step'), 'false idle: step 1 was written during a tool call');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'chain timeout');
  } finally {
    s.cleanup();
  }
});

test('chain: busy descriptor and the last entry a tool_result -> step 1 is never written', async () => {
  const uuid = 'sess-tx-toolresult-' + Date.now();
  const s = transcriptSession(uuid, {
    onEnter: ({ append }) => {
      append([userPrompt(Date.now())]);
      setTimeout(() => append([assistant(Date.now(), 'tool_use'), toolResult(Date.now())]), 100);
    },
  });
  try {
    const result = await runChain([{ command: 'first step' }, { command: 'second step' }], s, uuid, 2500);

    assert.ok(!s.written.some((w) => w.data === 'second step'));
    assert.equal(result.ok, false);
  } finally {
    s.cleanup();
  }
});

test('chain: a closed turn followed by sidechain entries still releases step 1', async () => {
  const uuid = 'sess-tx-sidechain-' + Date.now();
  const s = transcriptSession(uuid, {
    onEnter: ({ append }) => {
      append([userPrompt(Date.now())]);
      setTimeout(() => append([assistant(Date.now(), 'end_turn'), userPrompt(Date.now(), { isSidechain: true }), assistant(Date.now(), 'tool_use', { isSidechain: true })]), 100);
    },
  });
  try {
    const result = await runChain([{ command: 'first step' }, { command: 'second step' }], s, uuid, 6000);

    assert.ok(s.written.some((w) => w.data === 'second step'), JSON.stringify(result));
    assert.equal(result.ok, true);
  } finally {
    s.cleanup();
  }
});

test('chain: /compact as step 0 with the descriptor held busy -> step 1 is written once the compaction output is quiet', async () => {
  const uuid = 'sess-tx-compact-' + Date.now();
  const s = transcriptSession(uuid, {
    onEnter: ({ append, n }) => {
      const enterAt = Date.now();
      if (n === 1) setTimeout(() => append(compactWrites(enterAt, Date.now())), 100);
      else closedTurnAfter(100)({ append });
    },
  });
  try {
    const result = await runChain([{ command: '/compact' }, { command: 'second step' }], s, uuid, 6000);

    assert.ok(s.written.some((w) => w.data === 'second step'), 'step 1 was never written after /compact: ' + JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.steps[0].idle_source, 'transcript');
    assert.equal(result.steps[1].ready_source, 'transcript');
  } finally {
    s.cleanup();
  }
});

test('chain: a slash command expanding into a prompt, model turn still running -> step 1 is never written', async () => {
  const uuid = 'sess-tx-skill-' + Date.now();
  const s = transcriptSession(uuid, {
    onEnter: ({ append }) => {
      setTimeout(() => append([slashCommand(Date.now(), 'tdd'), userPrompt(Date.now(), { isMeta: true })]), 100);
    },
  });
  try {
    const result = await runChain([{ command: '/tdd' }, { command: 'second step' }], s, uuid, 2500);

    assert.ok(!s.written.some((w) => w.data === 'second step'), 'false idle: step 1 was written while the expanded prompt ran');
    assert.equal(result.ok, false);
  } finally {
    s.cleanup();
  }
});

test('chain: an idle descriptor keeps the descriptor path, the transcript is not the source', async () => {
  const uuid = 'sess-tx-idle-' + Date.now();
  const s = transcriptSession(uuid, {
    onEnter: ({ desc, append }) => {
      desc.status = 'busy'; desc.statusUpdatedAt = Date.now();
      append([userPrompt(Date.now())]);
      setTimeout(() => { desc.status = 'idle'; desc.statusUpdatedAt = Date.now(); }, 100);
    },
  });
  s.desc.status = 'idle';
  try {
    const result = await runChain([{ command: 'first step' }, { command: 'second step' }], s, uuid, 6000);

    assert.equal(result.ok, true);
    assert.equal(result.steps[0].ready_source, 'descriptor');
    assert.equal(result.steps[0].idle_source, 'descriptor');
    assert.equal(result.steps[1].ready_source, 'descriptor');
  } finally {
    s.cleanup();
  }
});
