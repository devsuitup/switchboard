// test/trigger-busy-chain-stall.test.js
//
// Issue #360: a chain stalls after step 0 while the CLI descriptor stays
// "busy" because background agents run, although the turn is over and the
// session transcript says so. End to end through the real watcher and the
// real trigger context, with the transcript as a file on disk.
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

const { start } = require('../trigger-watcher');
const { createTriggerContext } = require('../trigger-context');

function mkTmp(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const iso = (ms) => new Date(ms).toISOString();
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
const prompt = (at, content) => ({ type: 'user', timestamp: iso(at), message: { role: 'user', content } });
const endTurn = (at) => ({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] } });
const system = (at, subtype, extra = {}) => ({ type: 'system', subtype, timestamp: iso(at), ...extra });
const enqueue = (at, content) => ({ type: 'queue-operation', operation: 'enqueue', content, timestamp: iso(at) });
const dequeue = (at) => ({ type: 'queue-operation', operation: 'dequeue', timestamp: iso(at) });

// What a turn answered while background agents keep the descriptor busy
// leaves: the queued prompt, the answer, then the Stop hook and turn_duration.
function closedTurn(command, delayMs) {
  return (append) => {
    append([enqueue(Date.now(), command), dequeue(Date.now()), prompt(Date.now(), command)]);
    setTimeout(() => append([endTurn(Date.now()), system(Date.now(), 'stop_hook_summary'), system(Date.now(), 'turn_duration')]), delayMs);
  };
}

// What /compact leaves, written only when compaction ends (synthetic text).
function compactionOutput(enterAt) {
  const done = Date.now();
  return [
    system(done + 800, 'compact_boundary', { compactMetadata: { trigger: 'manual', preTokens: 1 } }),
    { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: iso(done), message: { role: 'user', content: 'This session is being continued. Synthetic summary.' } },
    { type: 'user', isMeta: true, timestamp: iso(enterAt), message: { role: 'user', content: '<local-command-caveat>Caveat: synthetic.</local-command-caveat>' } },
    prompt(enterAt, '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>'),
    prompt(done + 900, '<local-command-stdout>Compacted</local-command-stdout>'),
    { type: 'attachment', timestamp: iso(done + 100), attachment: { type: 'file' } },
  ];
}

function busySession(sessionId, onEnter) {
  const projectsDir = mkTmp('sw-busy-stall-projects-');
  fs.mkdirSync(path.join(projectsDir, 'C--proj'));
  const file = path.join(projectsDir, 'C--proj', sessionId + '.jsonl');
  const old = Date.now() - 60_000;
  fs.writeFileSync(file, jsonl([prompt(old - 1000, 'earlier'), endTurn(old), system(old + 100, 'turn_duration')]));
  const past = new Date(old + 200);
  fs.utimesSync(file, past, past);

  const written = [];
  let lastText = null;
  const desc = { status: 'busy', statusUpdatedAt: Date.now() - 30_000 };
  const append = (entries) => {
    if (fs.existsSync(projectsDir)) fs.appendFileSync(file, jsonl(entries));
  };
  const session = {
    pty: {
      pid: process.pid,
      write(data) {
        written.push({ data, at: Date.now() });
        if (data !== '\r') lastText = data;
        if (data === '\r') onEnter({ append, command: lastText, n: written.filter((w) => w.data === '\r').length });
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
  return { ctx, written, cleanup: () => fs.rmSync(projectsDir, { recursive: true, force: true }) };
}

async function runChain(chain, s, uuid, timeoutMs) {
  const tmp = mkTmp('sw-busy-stall-triggers-');
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;
  const watcher = start(s.ctx);
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

test('#360: a descriptor held busy by background agents, the turn closed in the transcript -> step 1 is written', async () => {
  const uuid = 'sess-busy-stall-' + Date.now();
  const s = busySession(uuid, ({ append, command }) => closedTurn(command, 100)(append));
  try {
    const result = await runChain([{ command: 'first step' }, { command: 'second step' }], s, uuid, 6000);

    assert.ok(s.written.some((w) => w.data === 'second step'), 'step 1 was never written: ' + JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.steps[0].submit_confirmed, true);
  } finally {
    s.cleanup();
  }
});

test('#360: /compact under a descriptor held busy, its output written when compaction ends -> step 1 is written', async () => {
  const uuid = 'sess-busy-stall-compact-' + Date.now();
  const s = busySession(uuid, ({ append, command, n }) => {
    const enterAt = Date.now();
    if (n === 1) setTimeout(() => append(compactionOutput(enterAt)), 3000);
    else closedTurn(command, 100)(append);
  });
  try {
    const result = await runChain([{ command: '/compact' }, { command: 'second step' }], s, uuid, 10000);

    assert.ok(s.written.some((w) => w.data === 'second step'), 'step 1 was never written after /compact: ' + JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.steps[0].submit_confirmed, true);
  } finally {
    s.cleanup();
  }
});
