'use strict';

const { stripVTControlCharacters } = require('node:util');
const fs = require('node:fs');
const { scanContinuationIndex } = require('./session-continuations');
const { isComposerEmpty, noteUserInput } = require('./src/main/terminals/composer-state');
const { JOB_ID_RE } = require('./bg-agents-roster');
const { tryAcquireTabInput } = require('./src/main/terminals/tab-input-lock');
const { releaseWindowsPty } = require('./src/main/terminals/pty-ops');

const BG_HANDOFF_TIMEOUT_MS = 120000;
const BG_HANDOFF_EXIT_TIMEOUT_MS = 15000;
const BG_CONFIRM_NOTICE_MS = 1000;

function backgroundRefusal(session, status) {
  if (!session || session.exited) return 'This session is not running.';
  if (session.isPlainTerminal) return 'A plain terminal has no Claude session to send to the background.';
  if (session.isAttach) return 'This session already runs in the background.';
  if (session.kind !== 'local-pty') return 'A remote session cannot be sent to the background from Switchboard.';
  if (session.sandbox) return 'This session runs in the sandbox; the background worker would run outside it.';
  if (session.preLaunch) return 'This session was started through a pre-launch command, which the background worker would not run.';
  if (session.backgrounding) return 'This session is already moving to the background.';
  if (!isComposerEmpty(session.composerState)) return 'The prompt holds text you have not sent. Send it or clear it, then try again.';
  if (!status) return 'Switchboard cannot read this session’s state. Wait for its state to appear, then try again.';
  if (status === 'waiting') return 'Claude is waiting for an answer in the terminal. Answer it, then try again.';
  if (status === 'shell') return 'A shell command is running in the prompt. Wait for it to finish, then try again.';
  if (status === 'busy') return 'Claude is working. Send to background once it is idle.';
  return null;
}

function createContinuationReader(file, id) {
  let serialized, previous;
  const sameFile = (a, b) => a?.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
  const unchanged = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
  return async () => {
    try {
      let index;
      do {
        const stat = fs.statSync(file, { bigint: true });
        const fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(Math.min(64, Number(stat.size)));
        let head;
        try { head = buffer.toString('hex', 0, fs.readSync(fd, buffer, 0, buffer.length, 0)); }
        finally { fs.closeSync(fd); }
        if (!sameFile(previous, stat) || (!unchanged(previous, stat)
          && !(stat.size > previous.size && head.startsWith(previous.head)))) serialized = undefined;
        serialized = scanContinuationIndex(file, id, serialized);
        const after = fs.statSync(file, { bigint: true });
        previous = { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs,
          size: stat.size, mtimeNs: stat.mtimeNs, head };
        if (!unchanged(stat, after)) {
          if (!sameFile(stat, after) || after.size <= stat.size) serialized = previous = undefined;
          return null;
        }
        index = JSON.parse(serialized);
        if (index.bytes < index.size) await new Promise(resolve => setImmediate(resolve));
      } while (index.bytes < index.size);
      return index.complete && !index.unresolved ? index.ids : null;
    } catch { serialized = previous = undefined; return null; }
  };
}

function findHandoff(descriptors, ids) {
  const targets = new Set(ids.map(id => id.toLowerCase()));
  const matches = descriptors.filter(d => d.kind === 'bg' && targets.has(d.sessionId.toLowerCase()) && JOB_ID_RE.test(d.jobId));
  const unique = new Map(matches.map(d => [d.sessionId.toLowerCase() + ':' + d.jobId, d]));
  return unique.size === 1 ? unique.values().next().value : null;
}

function cancellationIn(text) {
  return stripVTControlCharacters(text).match(/Backgrounding cancelled\s*[—–-]\s*([^\r\n]+)/)?.[1] || null;
}

const HELD_STATES = new Set(['running', 'working', 'blocked']);
function respawnRoute({ oldId, lookup, check, owned, elsewhere = [] }) {
  const refuse = error => ({ route: 'refuse', error });
  if (lookup?.missing) return { route: 'bg' };
  if (!lookup?.known || !lookup.job) return refuse('Cannot tell which background job holds this conversation (' + (lookup?.reason || 'background job record unavailable') + '). Check the Agents view, then try again.');
  const job = lookup.job;
  const target = job.resumeTarget || null;
  if (target !== oldId.toLowerCase()) return refuse('Job ' + job.id + ' would resume conversation ' + (target || 'unknown') + ', not this one. Open that job from the Agents view instead.');
  if (!check?.known) return refuse('Cannot tell whether job ' + job.id + ' is running (' + (check?.reason || 'conversation liveness unknown') + '). Check the Agents view, then try again.');
  if (!owned?.known) return refuse('Cannot tell which job runs this conversation (' + (owned?.reason || 'unknown') + '). Check the Agents view, then try again.');
  if (owned.job) return refuse('Job ' + owned.job.id + ' still runs this conversation. Stop it from the Agents view, then try again.');
  if (check.workerLiveness === 'live') return refuse('Job ' + job.id + "'s worker is running. Attach it from the Agents view.");
  if (HELD_STATES.has(check.state) && check.workerLiveness !== 'dead') return refuse('Job ' + job.id + "'s worker may still be running. Stop it from the Agents view, then try again.");
  for (const entry of elsewhere) {
    if (!entry || entry.known === false) return refuse('Cannot tell whether this conversation runs elsewhere (' + (entry?.reason || 'unknown') + '). Check where it is open, then try again.');
    if (entry.live) return refuse('This conversation is running in another process' + (entry.live.pid ? ' (pid ' + entry.live.pid + ')' : '') + '. Close it there, then try again.');
  }
  return { route: 'respawn', jobId: job.id, job };
}

async function respawnHandoff(session, sessionId, oldId, job, deps) {
  const jobId = job.id;
  const exitTimeoutMs = deps.exitTimeoutMs ?? BG_HANDOFF_EXIT_TIMEOUT_MS;
  const exitBy = deps.now() + exitTimeoutMs;
  while (!session.exited) {
    if (deps.now() >= exitBy) return { ok: false, code: 'exit-timeout', jobId, error: 'Sent /exit, but the terminal did not exit within ' + (exitTimeoutMs / 1000) + ' s; nothing was relaunched. Check the terminal.' };
    await deps.waitForChange(Math.max(0, Math.min(100, exitBy - deps.now())));
  }
  let result;
  try { result = await deps.respawnJob(job); }
  catch (err) { result = { ok: false, error: err.message || String(err) }; }
  if (!result?.ok) {
    return { ok: false, code: 'respawn-failed', jobId, error: result?.refused
      ? 'The session left its terminal, but job ' + jobId + ' was not relaunched: ' + result.error + '. Respawn it from the Agents view, or open the conversation from the sidebar.'
      : 'The session left its terminal, and relaunching job ' + jobId + ' failed or timed out: ' + (result?.error || 'no result') + '. It may still start; check the Agents view before respawning it.' };
  }
  session.backgrounded = true;
  return { ok: true, oldSessionId: sessionId, jobId, sessionId: oldId, cwd: result.cwd || session.cwd, respawned: true, attached: result.attached === true };
}

// see .ai/contexts/bg-agents.md ("Send to background")
function holdBackgroundExit(session, finish) {
  if (session.backgrounded) { finish(true); return true; }
  if (!session.backgrounding) return false;
  session.backgroundExit = finish;
  return true;
}

async function sendToBackground(sessionId, deps) {
  const session = deps.getSession(sessionId);
  const oldId = session?.realSessionId || sessionId;
  const refusal = backgroundRefusal(session, deps.getStatus(oldId));
  if (refusal) return { ok: false, code: 'refused', error: refusal };
  const unlock = tryAcquireTabInput(session);
  if (!unlock) return { ok: false, code: 'refused', error: 'An automation trigger is using this terminal. Wait for it to finish, then try again.' };
  session.backgrounding = true;
  let output = '', dispose;
  const deadline = deps.now() + (deps.timeoutMs ?? BG_HANDOFF_TIMEOUT_MS);
  let exitDeadline = Infinity, notified = false, waitingSince = null;
  const bound = () => deps.getSession(sessionId) === session && (session.realSessionId || sessionId).toLowerCase() === oldId.toLowerCase();
  try {
    const snapshot = await deps.readContinuationIds(oldId, session) || await deps.readContinuationIds(oldId, session);
    if (!snapshot) return { ok: false, code: 'refused', error: 'Switchboard could not read this conversation’s transcript, so it could not tell a new handoff from an earlier one. Try again in a moment.' };
    const previous = new Set(snapshot.map(id => id.toLowerCase()));
    const recheck = backgroundRefusal({ ...session, backgrounding: false }, deps.getStatus(oldId));
    if (recheck || !bound() || deps.now() >= deadline) return { ok: false, code: 'refused', error: recheck || 'The tab changed or its handoff deadline passed. Check the terminal, then try again.' };
    const route = deps.decideRoute ? await deps.decideRoute(oldId, session) : { route: 'bg' };
    const afterRoute = backgroundRefusal({ ...session, backgrounding: false }, deps.getStatus(oldId));
    if (afterRoute || !bound() || deps.now() >= deadline) return { ok: false, code: 'refused', error: afterRoute || 'The tab changed or its handoff deadline passed. Check the terminal, then try again.' };
    if (route.route === 'refuse') return { ok: false, code: 'refused', error: route.error };
    const command = route.route === 'respawn' ? '/exit' : '/bg';
    dispose = deps.tapOutput(session, text => { output = (output + text).slice(-16384); });
    const composer = session.composerState;
    const previousComposer = composer && { ...composer };
    if (composer) {
      if (composer.partial === '\x1b') composer.partial = '';
      noteUserInput(composer, command, deps.now());
    }
    const inputAt = composer?.lastInputAt;
    let written = false;
    try { written = deps.write(session, command); }
    finally { if (!written && composer) Object.assign(composer, previousComposer); }
    if (!written) return { ok: false, code: 'write-failed', error: 'Could not write to the terminal. Try again when it is running.' };
    await deps.delay(300);
    const status = deps.getStatus(oldId);
    if (!bound() || session.exited || status === 'waiting' || status === 'shell' || status === 'busy' || !status || (composer && (composer.text !== command || composer.inPaste)) || session.composerState?.lastInputAt !== inputAt) {
      return { ok: false, code: 'write-failed', error: 'The terminal changed after ' + command + ' was typed, so Enter was withheld. Check the terminal and clear the command before trying again.' };
    }
    if (!deps.write(session, '\r')) return { ok: false, code: 'write-failed', error: 'Could not submit ' + command + ' to the terminal. Check the terminal before trying again.' };
    if (composer) noteUserInput(composer, '\r', deps.now());
    if (route.route === 'respawn') return await respawnHandoff(session, sessionId, oldId, route.job, deps);
    for (;;) {
      if (session.exited && exitDeadline === Infinity) exitDeadline = deps.now() + (deps.exitTimeoutMs ?? BG_HANDOFF_EXIT_TIMEOUT_MS);
      if (deps.now() >= Math.min(deadline, exitDeadline)) {
        return { ok: false, code: 'timeout', error: session.exited
          ? 'The terminal exited, but its background handoff was not confirmed. Open the conversation from the sidebar to check where it is running.'
          : 'The background handoff was not confirmed within 2 minutes. Check the terminal for a confirmation or a finishing tool; open the conversation from the sidebar if it moves later.' };
      }
      const reason = cancellationIn(output);
      if (reason) return { ok: false, code: 'cancelled', error: 'Claude cancelled it: ' + reason };
      const ids = (await deps.readContinuationIds(oldId, session) || []).filter(id => id.toLowerCase() !== oldId.toLowerCase() && !previous.has(id.toLowerCase()));
      let waiting = false;
      if (deps.now() < Math.min(deadline, exitDeadline)) {
        const descriptors = deps.readDescriptors();
        const job = findHandoff(descriptors, ids);
        if (job) {
          session.backgrounded = true;
          await releaseWindowsPty(session.pty);
          deps.onConfirmed?.(job);
          deps.schedule?.(() => { if (!session.exited) deps.kill(session); }, deps.exitTimeoutMs ?? BG_HANDOFF_EXIT_TIMEOUT_MS);
          return { ok: true, oldSessionId: sessionId, jobId: job.jobId, sessionId: job.sessionId, cwd: job.cwd || session.cwd };
        }
        waiting = descriptors.some(d => d.sessionId.toLowerCase() === oldId.toLowerCase() && d.status === 'waiting');
      }
      if (!waiting) waitingSince = null;
      else if (waitingSince === null) waitingSince = deps.now();
      if (!notified && waitingSince !== null && deps.now() - waitingSince >= BG_CONFIRM_NOTICE_MS) {
        notified = true;
        deps.notify?.('Claude asks you to confirm in the terminal (Background / Stay).');
      }
      await deps.waitForChange(Math.max(0, Math.min(100, deadline - deps.now(), exitDeadline - deps.now())));
    }
  } catch (err) {
    return { ok: false, code: 'failed', error: 'The background handoff could not be checked: ' + err.message + '. Check the terminal or open the conversation from the sidebar.' };
  } finally {
    session.backgrounding = false;
    const finish = session.backgroundExit;
    delete session.backgroundExit;
    try { dispose?.(); } catch {}
    try { finish?.(!!session.backgrounded); } finally { unlock(); }
  }
}

module.exports = { respawnRoute, backgroundRefusal, createContinuationReader, findHandoff, cancellationIn, holdBackgroundExit, sendToBackground, BG_HANDOFF_TIMEOUT_MS, BG_HANDOFF_EXIT_TIMEOUT_MS };
