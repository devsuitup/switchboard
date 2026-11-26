// see .ai/contexts/trigger-watcher.md, "The written byte sequence and the composer's input (issue #980)"
'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '300';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '50';
process.env.SWITCHBOARD_BUSY_RISE_WAIT_MS = '100';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { setTimeout: realSetTimeout } = require('node:timers');

const { start } = require('./fixtures/trigger-watcher.cjs');

const RESUME = 'Resume the work from the handoff file, then report what is left to do on the open card.';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-trigger-980-')));
}

function recordingLog() {
  const lines = [];
  const mk = (level) => (...args) => { lines.push({ level, text: args.join(' ') }); };
  return { lines, info: mk('info'), warn: mk('warn'), error: mk('error'), debug: () => {} };
}

function compactChainSession(sessionId, { attach, react = () => true }) {
  const written = [];
  const compactBoundaries = [];
  const desc = { status: 'idle', statusUpdatedAt: Date.now() - 10_000 };
  const log = recordingLog();
  const input = { attachedAt: attach === undefined ? undefined : Date.now() - 5000 };
  const ptyProcess = {
    pid: process.pid,
    write(data) {
      written.push({ data, at: Date.now() });
      if (data !== '\r') return;
      const enters = written.filter((w) => w.data === '\r').length;
      const previous = written[written.length - 2]?.data;
      if (previous === '/compact') compactBoundaries.push({ at: Date.now(), uuid: 'compact-' + enters });
      if (!react(enters, previous)) return;
      desc.status = 'busy'; desc.statusUpdatedAt = Date.now();
      setTimeout(() => { desc.status = 'idle'; desc.statusUpdatedAt = Date.now(); }, 80);
    },
  };
  const ctx = {
    log,
    getPtyForSession: (id) => (id === sessionId ? { ptyProcess } : null),
    isSessionBusy: () => false,
    isPtyAlive: () => true,
    getComposerState: () => ({ pending: 0, lastInputAt: 0 }),
    getTranscriptTurn: () => ({ compactBoundaries }),
    getCliStatus: (id) => (id === sessionId ? { ...desc } : undefined),
  };
  if (attach !== undefined) ctx.getInputAttachedAt = (id) => (id === sessionId ? input.attachedAt : undefined);
  return { ctx, written, desc, log, input };
}

async function runChain(chain, session, uuid, timeoutMs = 8000) {
  const tmp = mkTmp();
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;
  const watcher = start(session.ctx);
  try {
    fs.writeFileSync(path.join(tmp, uuid + '.json'),
      JSON.stringify({ sessionId: uuid, wait: 'none', chain, timeout_ms: timeoutMs }), 'utf8');
    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    const deadline = performance.now() + timeoutMs + 5000;
    while (!fs.existsSync(resultPath)) {
      if (performance.now() > deadline) throw new Error('no result file');
      await new Promise((r) => realSetTimeout(r, 20));
    }
    await new Promise((r) => realSetTimeout(r, 20));
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } finally {
    watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const COMPACT_THEN_RESUME = [{ command: '/compact' }, { command: RESUME }];

test('#980: with the CLI input attached, the resume step is a bracketed paste, then a separate bare Enter', async () => {
  const uuid = 'sess-980-paste-' + Date.now();
  const session = compactChainSession(uuid, { attach: true });

  const result = await runChain(COMPACT_THEN_RESUME, session, uuid);

  assert.deepEqual(session.written.map((w) => w.data), ['/compact', '\r', PASTE_START + RESUME + PASTE_END, '\r']);
  assert.ok(session.written[3].at >= session.written[2].at);
  assert.ok(session.written.every((w) => !w.data.includes('\n')), 'no line feed is ever written');
  assert.equal(result.ok, true);
  assert.equal(result.steps[1].submitted, 'confirmed');
});

test('#980: without input tracking, the step is written as plain text then a bare Enter, and the recovery Enter is bare too', async () => {
  const uuid = 'sess-980-plain-' + Date.now();
  const session = compactChainSession(uuid, { attach: undefined, react: (_n, previous) => previous === '/compact' });

  const result = await runChain(COMPACT_THEN_RESUME, session, uuid, 4000);

  assert.deepEqual(session.written.map((w) => w.data), ['/compact', '\r', RESUME, '\r', '\r']);
  assert.ok(session.written.every((w) => !w.data.includes('\n') && !w.data.includes('\x1b')));
  assert.equal(result.ok, false);
  assert.equal(result.steps[1].submit_retries, 1);
});

test('#980: a slash command is never wrapped in a paste, even with the input attached', async () => {
  const uuid = 'sess-980-slash-' + Date.now();
  const session = compactChainSession(uuid, { attach: true });

  await runChain([{ command: RESUME }, { command: '/compact' }], session, uuid);

  assert.deepEqual(session.written.map((w) => w.data), [PASTE_START + RESUME + PASTE_END, '\r', '/compact', '\r']);
});

test('#980: the step after /compact is not written while the CLI input is detached, and is written once it attaches again', async () => {
  const uuid = 'sess-980-detached-' + Date.now();
  const session = compactChainSession(uuid, {
    attach: true,
    react(_n, previous) {
      if (previous === '/compact') {
        session.input.attachedAt = null;
        setTimeout(() => { session.input.attachedAt = Date.now(); attachedAt = Date.now(); }, 700);
      }
      return true;
    },
  });
  let attachedAt = null;

  const result = await runChain(COMPACT_THEN_RESUME, session, uuid);

  const resume = session.written.find((w) => w.data.includes(RESUME));
  assert.ok(attachedAt, 'the input never attached again');
  assert.ok(resume, 'the resume step was never written');
  assert.ok(resume.at >= attachedAt, `resume written ${attachedAt - resume.at} ms before the input attached`);
  assert.equal(result.ok, true);
});

test('#980: input still detached at the step deadline: the resume step is not written and the reason names the input', async () => {
  process.env.SWITCHBOARD_STARTUP_INPUT_WAIT_MS = '60000';
  try {
    const uuid = 'sess-980-deadline-' + Date.now();
    const session = compactChainSession(uuid, {
      attach: true,
      react(_n, previous) {
        if (previous === '/compact') session.input.attachedAt = null;
        return true;
      },
    });

    const result = await runChain([{ command: '/compact' }, { command: RESUME, timeout_ms: 1200 }], session, uuid);

    assert.deepEqual(session.written.map((w) => w.data), ['/compact', '\r']);
    assert.equal(result.ok, false);
    assert.equal(result.steps_completed, 1);
    assert.equal(result.steps[1].submitted, 'no');
    assert.match(result.reason, /input was not attached/);
  } finally {
    delete process.env.SWITCHBOARD_STARTUP_INPUT_WAIT_MS;
  }
});

test('#980: input detached past the bound: the step falls back to the descriptor, written as plain text, with a warning', async () => {
  process.env.SWITCHBOARD_STARTUP_INPUT_WAIT_MS = '500';
  try {
    const uuid = 'sess-980-bound-' + Date.now();
    let detachedAt = null;
    const session = compactChainSession(uuid, {
      attach: true,
      react(_n, previous) {
        if (previous === '/compact') { session.input.attachedAt = null; detachedAt = Date.now(); }
        return true;
      },
    });

    const result = await runChain(COMPACT_THEN_RESUME, session, uuid);

    const resume = session.written.find((w) => w.data.includes(RESUME));
    assert.ok(resume, 'the resume step was never written');
    assert.equal(resume.data, RESUME);
    assert.ok(resume.at - detachedAt >= 450, `written ${resume.at - detachedAt} ms after the detach`);
    assert.ok(session.log.lines.some((l) => l.level === 'warn' && /input attached/.test(l.text)));
    assert.equal(result.ok, true);
  } finally {
    delete process.env.SWITCHBOARD_STARTUP_INPUT_WAIT_MS;
  }
});

for (const status of ['busy', 'shell', undefined]) {
  test(`#980 r1: descriptor ${status}, input tracked and detached: nothing is written before the bound, the reason names the input`, async () => {
    const saved = { ...process.env };
    process.env.SWITCHBOARD_TRANSCRIPT_QUIET_MS = '1';
    process.env.SWITCHBOARD_STARTUP_INPUT_WAIT_MS = '15000';
    try {
      const uuid = `sess-980-r1-${status}-${Date.now()}`;
      const old = Date.now() - 10000;
      const written = [];
      const ctx = {
        log: recordingLog(),
        getPtyForSession: () => ({ ptyProcess: { pid: process.pid, write(data) { written.push(data); } } }),
        isSessionBusy: () => status === 'busy',
        isPtyAlive: () => true,
        getComposerState: () => ({ pending: 0, lastInputAt: 0 }),
        getInputAttachedAt: () => null,
        getCliStatus: () => (status === undefined ? undefined : { status, statusUpdatedAt: old }),
        getTranscriptTurn: () => ({ closed: true, closedAt: old, mtimeMs: old, prompts: [], compactBoundaries: [] }),
      };

      const result = await runChain([{ command: RESUME }], { ctx }, uuid, 450);

      assert.deepEqual(written, []);
      assert.equal(result.ok, false);
      assert.match(result.reason, /input was not attached/);
    } finally {
      delete process.env.SWITCHBOARD_TRANSCRIPT_QUIET_MS;
      delete process.env.SWITCHBOARD_STARTUP_INPUT_WAIT_MS;
      Object.assign(process.env, saved);
    }
  });
}

test('#980 r1: a slash command with leading blanks is not wrapped in a paste', async () => {
  const uuid = 'sess-980-r1-slash-' + Date.now();
  const session = compactChainSession(uuid, { attach: true });

  await runChain([{ command: '  /compact' }, { command: RESUME }], session, uuid);

  assert.equal(session.written[0].data, '  /compact');
});
