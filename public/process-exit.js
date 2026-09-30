// see .ai/contexts/window-frame.md ("The session header's controls")
'use strict';

const sessionExits = new Map();

function noteSessionExit(sessionId, exitCode, signal) {
  sessionExits.set(sessionId, { exitCode, signal: signal || null });
}

function forgetSessionExit(sessionId) {
  sessionExits.delete(sessionId);
}

function lastSessionExit(sessionId) {
  return sessionExits.get(sessionId) || null;
}

function processExitLabel(exit) {
  if (exit.signal) return `Killed (${exit.signal})`;
  if (Number.isInteger(exit.exitCode)) return `Exited (code ${exit.exitCode})`;
  return 'Exited';
}

function terminalStatusLabel(running, exit) {
  if (running) return 'Running';
  return exit ? processExitLabel(exit) : 'Stopped';
}

function exitBannerPhrase(exit) {
  const label = processExitLabel(exit);
  return label[0].toLowerCase() + label.slice(1);
}

function exitBannerColour(exit) {
  return exit.exitCode === 0 && !exit.signal ? '\x1b[2m' : '\x1b[33m';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    noteSessionExit, forgetSessionExit, lastSessionExit,
    processExitLabel, terminalStatusLabel, exitBannerPhrase, exitBannerColour,
  };
}
