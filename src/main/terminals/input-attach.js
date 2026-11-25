'use strict';

// see .ai/contexts/trigger-watcher.md, "Readiness of a freshly started CLI"
const CARRY = '\x1b[?2004h'.length - 1;

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
  const marker = /\x1b\[\?2004([hl])/g;
  let match;
  while ((match = marker.exec(text)) !== null) {
    if (match[1] === 'l') state.attachedAt = null;
    else if (state.attachedAt === null) state.attachedAt = now;
  }
}

module.exports = { createInputAttach, noteInputAttach };
