// terminal-input.js — see docs/automation.md ("Politeness")
'use strict';

const { noteUserInput } = require('./composer-state');
const { writePty } = require('./pty-ops');

/**
 * Handle one chunk of renderer keystrokes for `sessionId`.
 *
 * @param {Map} activeSessions
 * @param {string} sessionId
 * @param {string|Buffer} data
 * @param {number} now  epoch ms
 */
function handleTerminalInput(activeSessions, sessionId, data, now) {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    if (session.composerState) {
      for (const part of String(data).split(/([\r\n\x03])/)) {
        if (!part) continue;
        if (part === '\x03' && !session.composerState.inPaste) session.backgroundCommandSource = null;
        if ((part === '\r' || part === '\n') && !session.composerState.inPaste && !session.composerState.partial && session.composerState.text.trim()) {
          session.backgroundCommandSource = /^\/bg(?:\s|$)/.test(session.composerState.text.trim()) ? session.realSessionId || sessionId : null;
          session.backgroundCommandOutput = '';
        }
        noteUserInput(session.composerState, part, now);
      }
    }
    if (!writePty(session, data, sessionId)) session.backgroundCommandSource = null;
  }
}

module.exports = { handleTerminalInput };
