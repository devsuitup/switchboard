// see .ai/contexts/trigger-watcher.md, "Re-keyed sessions"
'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '400';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '50';
process.env.SWITCHBOARD_BUSY_RISE_WAIT_MS = '100';
process.env.SWITCHBOARD_TRANSCRIPT_QUIET_MS = '300';
process.env.SWITCHBOARD_PENDING_OWN_ENTRY_MS = '1000';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { start } = require('../trigger-watcher');
const { createTriggerContext } = require('../trigger-context');
const sessionTransitions = require('../session-transitions');

function mkTmp(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const iso = (ms) => new Date(ms).toISOString();
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
const prompt = (id, at, content) => ({ sessionId: id, type: 'user', timestamp: iso(at), message: { role: 'user', content } });
const endTurn = (id, at) => ({ sessionId: id, type: 'assistant', timestamp: iso(at), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] } });
const system = (id, at, subtype) => ({ sessionId: id, type: 'system', subtype, timestamp: iso(at) });
const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop };

const CLEAR_TEXT = '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>';

// A CLI under one PTY: /clear moves it to a new transcript and a new id, as the real one does.
function clearingSession(onText = noop) {
  const projectsDir = mkTmp('sw-clear-chain-projects-');
  const folderPath = path.join(projectsDir, 'proj');
  fs.mkdirSync(folderPath);
  const old = Date.now() - 60_000;
  const oldFile = path.join(folderPath, 'old-id.jsonl');
  fs.writeFileSync(oldFile, jsonl([prompt('old-id', old - 1000, 'earlier'), endTurn('old-id', old), system('old-id', old + 100, 'turn_duration')]));
  fs.utimesSync(oldFile, new Date(old + 200), new Date(old + 200));

  let current = 'old-id';
  const status = { 'old-id': { status: 'idle', statusUpdatedAt: old + 300 } };
  const written = [];
  let lastText = null;
  const pty = {
    pid: 4242,
    write(data) {
      written.push(data);
      if (data !== '\r') { lastText = data; onText(data); return; }
      if (!fs.existsSync(folderPath)) return;
      const at = Date.now();
      if (lastText === '/clear') {
        setTimeout(() => {
          if (!fs.existsSync(folderPath)) return;
          current = 'new-id';
          fs.writeFileSync(path.join(folderPath, 'new-id.jsonl'), jsonl([
            { sessionId: 'new-id', type: 'mode', mode: 'normal' },
            { type: 'file-history-snapshot', messageId: 'm1', snapshot: {} },
            { sessionId: 'new-id', type: 'user', isMeta: true, timestamp: iso(at), message: { role: 'user', content: '<local-command-caveat>Caveat: synthetic.</local-command-caveat>' } },
            prompt('new-id', at, CLEAR_TEXT),
          ]));
          status['new-id'] = { status: 'idle', statusUpdatedAt: Date.now() };
          sessionTransitions.detectSessionTransitions('proj');
        }, 30);
      } else {
        const id = current;
        status[id] = { status: 'busy', statusUpdatedAt: Date.now() };
        fs.appendFileSync(path.join(folderPath, id + '.jsonl'), jsonl([prompt(id, at, lastText)]));
        setTimeout(() => {
          if (!fs.existsSync(folderPath)) return;
          fs.appendFileSync(path.join(folderPath, id + '.jsonl'), jsonl([endTurn(id, Date.now()), system(id, Date.now(), 'turn_duration')]));
          status[id] = { status: 'idle', statusUpdatedAt: Date.now() };
        }, 100);
      }
    },
  };
  const session = {
    pty, cwd: '/w', projectFolder: 'proj', exited: false, isPlainTerminal: false,
    knownJsonlFiles: new Set(['old-id.jsonl']), forkFrom: null, realSessionId: null,
    _cliBusy: false, composerState: { pending: 0, lastInputAt: 0 },
  };
  const activeSessions = new Map([['old-id', session]]);
  sessionTransitions.init({
    PROJECTS_DIR: projectsDir, activeSessions, getMainWindow: () => null, log,
    rekeyMcpServer: noop, clearOwner: (id, pid) => (pid === 4242 ? 'mine' : 'other'),
  });
  const ctx = createTriggerContext({
    activeSessions, log, projectsDir,
    isPtyAlive: () => true,
    getCliStatus: (id) => status[id] && { ...status[id] },
    resolveSessionId: (id) => sessionTransitions.currentSessionId(id),
  });
  return { ctx, written, activeSessions, cleanup: () => fs.rmSync(projectsDir, { recursive: true, force: true }) };
}

async function runTriggers(ctx, triggers, timeoutMs, tmp = mkTmp('sw-clear-chain-triggers-')) {
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;
  const watcher = start(ctx);
  try {
    for (const [uuid, trigger] of triggers) {
      fs.writeFileSync(path.join(tmp, uuid + '.json'), JSON.stringify({ wait: 'none', timeout_ms: timeoutMs, ...trigger }), 'utf8');
    }
    const results = {};
    const deadline = Date.now() + timeoutMs + 5000;
    for (const [uuid] of triggers) {
      const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
      while (!fs.existsSync(resultPath)) {
        if (Date.now() > deadline) throw new Error('no result file for ' + uuid);
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 20));
      results[uuid] = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    }
    return results;
  } finally {
    watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a [/clear, reply] chain follows the session to its new id and writes the reply', async () => {
  const s = clearingSession();
  try {
    const { chain } = await runTriggers(s.ctx, [['chain', { sessionId: 'old-id', chain: [{ command: '/clear' }, { command: 'reply' }] }]], 6000);
    assert.ok(s.activeSessions.has('new-id'), 'the session was re-keyed by the /clear');
    assert.equal(chain.ok, true, JSON.stringify(chain));
    assert.deepEqual(s.written.filter((d) => d !== '\r'), ['/clear', 'reply']);
  } finally {
    s.cleanup();
  }
});

test('a trigger for the new id waits for a chain still running under the old id', async () => {
  const tmp = mkTmp('sw-clear-chain-triggers-');
  const s = clearingSession((text) => {
    if (text !== 'first') return;
    fs.writeFileSync(path.join(tmp, 'single.json'), JSON.stringify({ sessionId: 'new-id', command: 'other', wait: 'none', timeout_ms: 6000 }), 'utf8');
  });
  try {
    const { chain } = await runTriggers(s.ctx, [['chain', { sessionId: 'old-id', chain: [{ command: '/clear' }, { command: 'first' }, { command: 'second' }] }]], 6000, tmp);
    assert.equal(chain.ok, true, JSON.stringify(chain));
    const resultPath = path.join(tmp, 'processed', 'single.result.json');
    const deadline = Date.now() + 6000;
    while (!fs.existsSync(resultPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(s.written.filter((d) => d !== '\r'), ['/clear', 'first', 'second', 'other'], 'one terminal, one queue, whichever id names it');
  } finally {
    s.cleanup();
  }
});

test('a trigger waits for a chain whose session got a new PTY under the same id', async () => {
  const tmp = mkTmp('sw-clear-chain-triggers-');
  let s = null;
  s = clearingSession((text) => {
    if (text !== 'first') return;
    const session = s.activeSessions.get('old-id');
    const previous = session.pty;
    session.pty = { pid: previous.pid, write: (data) => previous.write(data) };
    fs.writeFileSync(path.join(tmp, 'single.json'), JSON.stringify({ sessionId: 'old-id', command: 'other', wait: 'none', timeout_ms: 6000 }), 'utf8');
  });
  try {
    const { chain } = await runTriggers(s.ctx, [['chain', { sessionId: 'old-id', chain: [{ command: 'first' }, { command: 'second' }] }]], 6000, tmp);
    assert.equal(chain.ok, true, JSON.stringify(chain));
    const resultPath = path.join(tmp, 'processed', 'single.result.json');
    const deadline = Date.now() + 6000;
    while (!fs.existsSync(resultPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(s.written.filter((d) => d !== '\r'), ['first', 'second', 'other']);
  } finally {
    s.cleanup();
  }
});
