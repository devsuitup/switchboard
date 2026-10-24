// see .ai/contexts/window-frame.md ("The session header's controls")
'use strict';

const sessionExits = new Map();

function noteSessionExit(sessionId, exitCode, signal, stopped, detached) {
  sessionExits.set(sessionId, { exitCode, signal: signal || null, stopped: !!stopped, detached: !!detached });
}

function forgetSessionExit(sessionId) {
  sessionExits.delete(sessionId);
}

function lastSessionExit(sessionId) {
  return sessionExits.get(sessionId) || null;
}

function processExitLabel(exit) {
  if (exit.detached) return 'Detached';
  if (exit.stopped) return 'Stopped';
  if (exit.signal) return `Killed (${exit.signal})`;
  if (Number.isInteger(exit.exitCode)) return `Exited (code ${exit.exitCode})`;
  return 'Exited';
}

function lifecycleLabel({ ptyHere, attach, job, remoteAlias, liveness, exit, dormant }) {
  if (ptyHere) {
    if (remoteAlias) return `Attached here · runs on ${remoteAlias}`;
    return attach ? 'Attached here · keeps running in the background' : 'Open here';
  }
  const liveJob = job?.kind === 'background' && job.hosted === true;
  if (!liveJob && ['done', 'stopped', 'failed'].includes(job?.state)) return `Job ${job.state}`;
  if (liveJob) return 'Running in background';
  if (liveness === 'alive') return remoteAlias ? `Running on ${remoteAlias}` : 'Running elsewhere';
  if (liveness === 'dead' && (!exit || exit.detached)) return 'Not running';
  if (exit) return processExitLabel(exit);
  if (dormant) return 'Not reopened · restores on click';
  return 'Liveness unknown';
}

function exitBannerPhrase(exit) {
  const label = processExitLabel(exit);
  return label[0].toLowerCase() + label.slice(1);
}

function exitBannerColour(exit) {
  return exit.stopped || (exit.exitCode === 0 && !exit.signal) ? '\x1b[2m' : '\x1b[33m';
}

function writeSessionExitBanner(entry, exit, { correction = false } = {}) {
  try {
    entry.terminal.write(
      `\r\n${exitBannerColour(exit)}── ${correction ? 'correction: previous exit status superseded; ' : ''}session ${exitBannerPhrase(exit)} — ${exit.detached ? entry.session?.remoteAlias ? `it keeps running on ${remoteHostLabel(entry.session.remoteAlias)}` : 'it keeps running in the background' : 're-click this session in the sidebar to relaunch, or click another to dismiss'} ──\x1b[0m\r\n`
    );
  } catch {}
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    noteSessionExit, forgetSessionExit, lastSessionExit,
    processExitLabel, lifecycleLabel, exitBannerPhrase, exitBannerColour, writeSessionExitBanner,
  };
}
