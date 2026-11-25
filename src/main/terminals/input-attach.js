'use strict';

// see .ai/contexts/trigger-watcher.md, "Readiness of a freshly started CLI"
const ATTACH = '\x1b[?2004h';
const DETACH = '\x1b[?2004l';
const CARRY = ATTACH.length - 1;

function createInputAttach() {
  return { carry: '', attachedAt: null };
}

function noteInputAttach(state, data, now = Date.now()) {
  if (!state || typeof data !== 'string' || !data) return;
  if (!state.carry.includes('\x1b') && !data.includes('\x1b')) {
    state.carry = data.slice(-CARRY);
    return;
  }
  const text = state.carry + data;
  state.carry = text.slice(-CARRY);
  const on = text.lastIndexOf(ATTACH);
  const off = text.lastIndexOf(DETACH);
  if (on === -1 && off === -1) return;
  if (on < off) state.attachedAt = null;
  else if (state.attachedAt === null) state.attachedAt = now;
}

module.exports = { createInputAttach, noteInputAttach };
