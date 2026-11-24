'use strict';

// Issue #1246 — a live local session whose descriptor reports `waiting` (a
// question dialog, which sends no OSC 9 attention) shows the attention glyph.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTranscriptTail } = require('../transcript-turn');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const base = Date.now() - 10 * 60 * 1000;
const toolUseAt = new Date(base).toISOString();
const waitingAt = base + 112;
const answeredAt = new Date(Date.now() + 60 * 1000).toISOString();
const prompt = { type: 'user', timestamp: new Date(base - 20000).toISOString(), message: { role: 'user', content: 'Plan it' } };
const askQuestion = { type: 'assistant', timestamp: toolUseAt,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [] } }] } };
const answer = { type: 'user', timestamp: answeredAt,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'Option A' }] } };
const jsonl = entries => entries.map(e => JSON.stringify(e)).join('\n') + '\n';

function setup(t, { ptyHere = true, active = 'other' } = {}) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const id = 'asks-question';
  const row = { sessionId: id, summary: 'local session', modified: toolUseAt,
    status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: waitingAt };
  ctx.window.sessionMap.set(id, row);
  ctx.window.activeSessionId = active;
  if (ptyHere) ctx.window.activePtyIds.add(id);
  const render = () => ctx.sidebar.renderProjects([makeSampleProject({ sessions: [row] })], true);
  let revision = 0;
  const headTurn = entries => {
    const turn = classifyTranscriptTail(jsonl(entries));
    ctx.emitHeadTurn(id, turn.state, { revision: ++revision, lastEntryAt: turn.lastEntryAt });
    return turn;
  };
  const item = () => ctx.document.getElementById(`si-${id}`);
  const icon = () => item().querySelector('.session-icon');
  const descriptor = (status, at) => {
    row.status = status;
    row.statusUpdatedAt = at;
    row.waitingFor = status === 'waiting' ? 'input needed' : null;
    render();
  };
  render();
  return { ctx, id, row, render, headTurn, item, icon, descriptor };
}

function assertAttention({ item, icon }, message) {
  assert.equal(icon().classList.contains('session-icon--attention'), true, message);
  assert.equal(item().classList.contains('needs-attention'), true, message);
  assert.equal(icon().classList.contains('session-icon--busy'), false, message);
}

function assertSpinner({ item, icon }, message) {
  assert.equal(icon().classList.contains('session-icon--busy'), true, message);
  assert.equal(item().classList.contains('cli-busy'), true, message);
  assert.equal(item().classList.contains('needs-attention'), false, message);
}

test('a PTY-here row with an open AskUserQuestion head and a waiting descriptor shows attention, not the spinner', t => {
  const s = setup(t);
  assert.equal(s.headTurn([prompt, askQuestion]).state, 'open', 'the pending tool_use keeps the head open');
  s.ctx.setActivity(s.id, false, 'onTerminalNotification');
  s.render();
  assertAttention(s, 'descriptor waiting owns the slot over the open head');
});

test('the descriptor going back to busy releases the attention and brings the spinner back', t => {
  const s = setup(t);
  s.headTurn([prompt, askQuestion]);
  s.ctx.setActivity(s.id, false, 'onTerminalNotification');
  s.render();
  assertAttention(s, 'precondition: waiting raised attention');
  assert.equal(s.headTurn([prompt, askQuestion, answer]).state, 'open', 'the answer keeps the turn open');
  s.descriptor('busy', Date.parse(answeredAt) + 100);
  assertSpinner(s, 'the dialog was answered: the open head animates again');
});

test('an OSC attention raised while the descriptor waits survives the descriptor leaving waiting', t => {
  const s = setup(t);
  s.headTurn([prompt, askQuestion]);
  s.ctx.read('setAttention')(s.id, true, 'onTerminalNotification');
  s.descriptor('busy', waitingAt + 5000);
  assertAttention(s, 'explicit OSC attention is never cleared by a descriptor');
});

test('the focused session gets no descriptor attention, like OSC attention, and gets it back once left while still waiting', t => {
  const s = setup(t, { active: 'asks-question' });
  s.headTurn([prompt, askQuestion]);
  s.render();
  assert.equal(s.item().classList.contains('needs-attention'), false, 'the session in front of the user is not flagged');
  s.ctx.window.activeSessionId = 'other';
  s.render();
  assertAttention(s, 'once another session is focused, the still-open dialog is flagged');
});

test('focusing a flagged session releases its descriptor attention', t => {
  const s = setup(t);
  s.headTurn([prompt, askQuestion]);
  s.render();
  assertAttention(s, 'precondition: waiting raised attention');
  s.ctx.window.activeSessionId = s.id;
  s.render();
  assert.equal(s.item().classList.contains('needs-attention'), false);
});

test('a waiting descriptor older than the answer in the transcript does not re-raise attention', t => {
  const s = setup(t, { active: 'asks-question' });
  s.headTurn([prompt, askQuestion]);
  s.render();
  s.headTurn([prompt, askQuestion, answer]);
  s.ctx.window.activeSessionId = 'other';
  s.render();
  assert.equal(s.row.status, 'waiting', 'precondition: the descriptor read is stale');
  assert.equal(s.item().classList.contains('needs-attention'), false, 'the tool_result is newer than the waiting status');
  assert.equal(s.icon().classList.contains('session-icon--attention'), false);
});

test('a later transcript entry releases descriptor attention a stale waiting raised', t => {
  const s = setup(t);
  s.headTurn([prompt, askQuestion]);
  s.render();
  assertAttention(s, 'precondition: waiting raised attention');
  s.headTurn([prompt, askQuestion, answer]);
  s.render();
  assert.equal(s.item().classList.contains('needs-attention'), false);
});

test('a new waiting written after the answer raises attention again', t => {
  const s = setup(t);
  s.headTurn([prompt, askQuestion, answer]);
  s.descriptor('waiting', Date.parse(answeredAt) + 100);
  assertAttention(s, 'a second dialog after the answer is flagged');
});

test('a local row without a PTY here, live elsewhere and waiting, shows attention through the transcript adapter', t => {
  const s = setup(t, { ptyHere: false });
  s.headTurn([prompt, askQuestion]);
  s.ctx.emitSessionTranscriptActivity({ sessionId: s.id, at: waitingAt - 50 });
  s.render();
  assertAttention(s, 'the transcript adapter applies descriptor-owned attention too');
  s.descriptor('busy', waitingAt + 5000);
  assert.equal(s.item().classList.contains('needs-attention'), false, 'released when the descriptor leaves waiting');
});
