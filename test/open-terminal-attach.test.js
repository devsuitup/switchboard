// test/open-terminal-attach.test.js — main.js boots Electron, so these are source-level pins; see .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('open-terminal builds `claude attach <id>` for an attach session and never a --resume', () => {
  assert.match(MAIN, /const isAttach = sessionOptions\?\.type === 'attach';/);
  assert.match(MAIN, /claudeArgs\.push\('attach', attachJobId\);/);
  assert.match(MAIN, /if \(!isAttach && sessionOptions\?\.sandbox\)/);
  assert.match(MAIN, /if \(!isAttach && sessionOptions\?\.preLaunchCmd\)/);
  assert.match(MAIN, /if \(!isAttach && sessionOptions\?\.mcpEmulation !== false\)/);
  assert.match(MAIN, /isAttach, attachJobId,/, 'the session record must carry both fields');
});

test('a reattach reports whether the live session is an attach, and the renderer keeps it on the tab', () => {
  assert.match(MAIN, /ok: true, reattached: true, attach: !!session\.isAttach,/);
  const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = APP.indexOf('async function openSession(');
  const body = APP.slice(start, APP.indexOf('\nasync function ', start + 10));
  const openIdx = body.indexOf('await window.api.openTerminal(sessionId');
  assert.ok(openIdx > 0);
  assert.match(body.slice(openIdx), /if \(result\.reattached\) entry\.attach = !!result\.attach;/);
});

test('an attach job id is validated against the eight-hex shape before anything is spawned', () => {
  assert.match(MAIN, /JOB_ID_RE\.test\(String\(sessionOptions\.jobId\)\)/);
});

test('stop-session detaches an attach session instead of killing it', () => {
  const idx = MAIN.indexOf("ipcMain.handle('stop-session'");
  const body = MAIN.slice(idx, idx + 600);
  assert.match(body, /if \(session\.isAttach\)/);
  assert.match(body, /detachPty\(session, sessionId\)/);
  assert.match(body, /detached: true/);
});

test('the window closing releases the agents watchers', () => {
  const idx = MAIN.indexOf("mainWindow.on('closed'");
  assert.match(MAIN.slice(idx, idx + 900), /bgAgents\.stop\(\);/);
});

test('preload exposes the four agents-view entries', () => {
  for (const name of ['getBgAgents', 'bgAgentVerb', 'dispatchBgAgent', 'onBgAgentsChanged']) {
    assert.ok(PRELOAD.includes(name + ':'), `${name} missing from preload.js`);
  }
  assert.match(PRELOAD, /ipcRenderer\.on\('bg-agents-changed'/);
});
