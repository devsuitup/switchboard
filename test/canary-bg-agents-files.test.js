// test/canary-bg-agents-files.test.js — canary over an external dependency.
//
// Pins the observed shape of ~/.claude/jobs/<id>/state.json, written by the
// Claude CLI's daemon for every `claude --bg` session (CLI 2.1.285, Linux,
// 2026-09-30). bg-agents-roster.js reads it for the agents view. Not a
// documented interface: this test going red means the CLI changed, not that
// Switchboard broke. Skips wherever the directory is absent.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { JOB_STATES } = require('../bg-agents-roster');

const JOBS_DIR = path.join(os.homedir(), '.claude', 'jobs');

function listStateFiles() {
  try {
    return fs.readdirSync(JOBS_DIR)
      .filter(n => /^[0-9a-f]{8}$/.test(n))
      .map(n => path.join(JOBS_DIR, n, 'state.json'))
      .filter(p => fs.existsSync(p));
  } catch {
    return [];
  }
}

test('CANARY: the Claude CLI daemon still writes jobs/<id>/state.json in the shape the agents view reads', (t) => {
  const files = listStateFiles();
  if (files.length === 0) {
    t.skip(`no ${JOBS_DIR}/<id>/state.json on this machine — nothing to pin`);
    return;
  }
  for (const file of files) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const seen = `(${file})`;
    if (!JOB_STATES.has(raw.state)) {
      t.diagnostic(`unknown job state "${raw.state}" (known: ${[...JOB_STATES].join(', ')}) ${seen}; the view shows it as Unknown`);
    }
    assert.ok(raw.detail === undefined || raw.detail === null || typeof raw.detail === 'string',
      `PINNED ASSUMPTION BROKEN: "detail" used to be a string, the one-line status the view shows ${seen}`);
    assert.ok(raw.respawnFlags === undefined || Array.isArray(raw.respawnFlags),
      `PINNED ASSUMPTION BROKEN: "respawnFlags" used to be the original argv (--agent, --model, --name) ${seen}`);
    assert.ok(raw.linkScanPath === undefined || /\.jsonl$/.test(String(raw.linkScanPath)),
      `PINNED ASSUMPTION BROKEN: "linkScanPath" used to end in the session's <sessionId>.jsonl ${seen}`);
    assert.ok(raw.fan === undefined || raw.fan === null || Array.isArray(raw.fan),
      `PINNED ASSUMPTION BROKEN: "fan" used to be an array of {id, kind, label, startedAt, doneAt} ${seen}`);
  }
});
