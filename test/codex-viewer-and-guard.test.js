'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { createTranscriptFollower } = require('../src/main/viewer/transcript-follower');
const { deleteSessionRefusal, makeDeleteSessionGuard } = require('../delete-session-guard');

const ID = '01a03f6c-fdf9-7c83-86e3-c388f81d765c';

function codexLines(texts) {
  return texts.map((text, i) => JSON.stringify({ timestamp: `t${i}`, type: 'response_item',
    payload: { type: 'message', role: i % 2 ? 'assistant' : 'user', content: [{ type: 'input_text', text }] } })).join('\n') + '\n';
}

test('the transcript follower maps every record through the harness transform, on open, append and reset', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-follow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { cwd: '/p' } }) + '\n' + codexLines(['first', 'reply']));
  const { toViewerEntry } = require('../harnesses/codex');
  const follower = createTranscriptFollower();
  const opened = follower.open(ID, file, undefined, toViewerEntry);
  assert.deepEqual(opened.entries.map(e => [e.type, e.message.content[0].text]), [['user', 'first'], ['assistant', 'reply']]);
  fs.appendFileSync(file, codexLines(['second']));
  const next = await follower.read(ID, opened.token, file);
  assert.deepEqual(next.entries.map(e => [e.type, e.message.content[0].text]), [['user', 'second']]);
  fs.writeFileSync(file, codexLines(['rewritten']));
  const reset = await follower.read(ID, opened.token, file);
  assert.equal(reset.reset, true);
  assert.deepEqual(reset.entries.map(e => e.message.content[0].text), ['rewritten']);
  assert.equal(follower.close(ID, opened.token, true).ok, true);
  const resumed = await follower.open(ID, file, opened.token);
  assert.equal(resumed.reset, false, 'the parked cursor is resumed, not reset');
  fs.appendFileSync(file, codexLines(['after park']));
  const tail = await follower.read(ID, resumed.token, file);
  assert.deepEqual(tail.entries.map(e => e.message.content[0].text), ['after park'], 'a parked follower keeps its transform');
  const plain = createTranscriptFollower().open(ID, file);
  assert.equal(plain.entries.length, 0, 'without a transform the raw codex records are not viewer types');
});

test('deleting a session whose CLI does not allow it is refused before any live check', async () => {
  const { getHarness } = require('../harnesses');
  const rows = new Map([[ID, { sessionId: ID, runtime: 'codex', sessionFile: '/sessions/x.jsonl' }], ['c1', { sessionId: 'c1' }]]);
  const guard = makeDeleteSessionGuard({
    activeSessions: new Map(), sessionHasPty: () => false, ptyPids: new Set(),
    bgAgents: { liveJobCheck: () => ({ known: true, job: null }) },
    cliSessionState: { liveElsewhereChecked: async () => ({ known: true, live: null }) },
    getCachedSession: id => rows.get(id), getHarness,
  });
  assert.match(await guard(ID), /Codex transcripts are not deleted by Switchboard/);
  assert.equal(await guard('c1'), null);
  assert.equal(await guard('unknown-row'), null, 'an unknown row falls back to the default CLI');
  let liveChecks = 0;
  const refusal = await deleteSessionRefusal(ID, {
    activeSessions: new Map(), transcriptRefusal: () => 'nope',
    liveJobCheck: () => { liveChecks++; return { known: true, job: null }; },
    liveElsewhereChecked: async () => { liveChecks++; return { known: true, live: null }; },
  });
  assert.equal(refusal, 'nope');
  assert.equal(liveChecks, 0);
});

test('the sidebar row and the grid card show a CLI badge only for a non-default runtime', t => {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const base = { sessionId: ID, projectPath: '/repo', summary: 'Fix the parser', modified: new Date().toISOString(), messageCount: 2 };
  const claudeItem = h.sidebar.buildSessionItem({ ...base, runtime: 'claude', runtimeLabel: null });
  assert.equal(claudeItem.querySelector('.runtime-badge'), null);
  assert.ok(claudeItem.querySelector('.session-fork-btn'), 'a Claude row keeps its fork button');
  const codexItem = h.sidebar.buildSessionItem({ ...base, runtime: 'codex', runtimeLabel: 'Codex', canLaunch: false });
  const badge = codexItem.querySelector('.runtime-badge');
  assert.ok(badge, 'a Codex row carries the badge');
  assert.equal(badge.textContent, 'Codex');
  assert.equal(badge.dataset.runtime, 'codex');
  assert.equal(codexItem.querySelector('.session-summary')?.firstChild, badge, 'the badge leads the summary line');
  for (const cls of ['.session-fork-btn', '.session-launch-config-btn', '.session-delete-btn']) {
    assert.equal(codexItem.querySelector(cls), null, `${cls} is not offered on a read-only row`);
  }
  assert.ok(codexItem.querySelector('.session-jsonl-btn'), 'the transcript stays readable');
  const opened = [];
  h.window.showJsonlViewer = session => opened.push(['viewer', session.sessionId]);
  h.window.openSession = session => opened.push(['terminal', session.sessionId]);
  const codexRow = { ...base, runtime: 'codex', runtimeLabel: 'Codex', canLaunch: false, starred: false, archived: 0 };
  const claudeRow = { ...base, sessionId: 'claude-row', runtime: 'claude', runtimeLabel: null, canLaunch: true, starred: false, archived: 0 };
  h.window.sessionMap.set(ID, codexRow);
  h.window.sessionMap.set('claude-row', claudeRow);
  h.sidebar.renderProjects([makeSampleProject({ projectPath: '/repo', sessions: [codexRow, claudeRow] })], true);
  h.document.getElementById('si-' + ID).onclick();
  h.document.getElementById('si-claude-row').onclick();
  assert.deepEqual(opened, [['viewer', ID], ['terminal', 'claude-row']], 'a click on a read-only row opens the transcript, never a terminal');
});

test('main wires the harness watchers and the viewer mapping', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(source, /startProjectsWatcher\(\);\r?\n\s*startHarnessWatchers\(\);/);
  assert.match(source, /harness\.watchFolderKey\(filename\.split\(path\.sep\)\)/);
  assert.match(source, /\(\) => stopHarnessWatchers\(\)/);
  const viewer = source.slice(source.indexOf("ipcMain.handle('read-session-jsonl'"), source.indexOf("ipcMain.handle('read-subagent-jsonl'"));
  assert.match(viewer, /harness\.transcriptPath\(row\)/);
  assert.match(viewer, /transcriptFollower\.open\(sessionId, jsonlPath, options\.checkpoint, harness\.toViewerEntry\)/);
  assert.match(viewer, /return \{ entries: harness\.toViewerEntries\(entries\) \}/);
  assert.match(source, /getMergedMemberIds, getCachedSession, getHarness,\r?\n\}\);/);
});
