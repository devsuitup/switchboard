'use strict';

// see .ai/contexts/ipc-bridge.md ("Last known projects")
const fs = require('node:fs');
const path = require('node:path');

const FORMAT_VERSION = 1;
const FILENAME = 'last-known-projects.json';
const MAX_BYTES = 8 * 1024 * 1024;
const WRITE_DELAY_MS = 2000;

function createLastKnownProjectsStore({ dir, appVersion, log = console, maxBytes = MAX_BYTES, writeDelayMs = WRITE_DELAY_MS,
  setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout }) {
  const filename = path.join(dir, FILENAME);
  let queued = null;
  let timer = null;
  let writing = Promise.resolve();

  const validRows = sessions => Array.isArray(sessions)
    && sessions.every(session => session && typeof session === 'object' && typeof session.sessionId === 'string');
  const validProjects = projects => Array.isArray(projects)
    && projects.every(project => project && typeof project === 'object' && typeof project.projectPath === 'string' && validRows(project.sessions));

  async function discard(reason) {
    log.warn(`[projects] last known projects discarded (${reason}); the sidebar starts empty`);
    await fs.promises.unlink(filename).catch(() => {});
  }

  async function load() {
    let text;
    try { text = await fs.promises.readFile(filename, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') log.warn(`[projects] last known projects unreadable (${error.message}); the sidebar starts empty`);
      return null;
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { await discard('corrupt file'); return null; }
    if (!parsed || typeof parsed !== 'object') { await discard('not an object'); return null; }
    if (parsed.version !== FORMAT_VERSION) { await discard(`format ${parsed.version} is not ${FORMAT_VERSION}`); return null; }
    if (parsed.appVersion !== appVersion) { await discard(`written by ${parsed.appVersion}, running ${appVersion}`); return null; }
    if (!validProjects(parsed.defaultProjects) || !validProjects(parsed.allProjects)) { await discard('invalid shape'); return null; }
    return { defaultProjects: parsed.defaultProjects, allProjects: parsed.allProjects, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : null };
  }

  async function write(payload) {
    let text;
    try { text = JSON.stringify(payload); }
    catch (error) { log.warn(`[projects] last known projects not saved: ${error.message}`); return; }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) {
      log.warn(`[projects] last known projects not saved: ${bytes} bytes exceed ${maxBytes}; the previous file is removed`);
      await fs.promises.unlink(filename).catch(() => {});
      return;
    }
    const temporary = filename + '.tmp';
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(temporary, text, 'utf8');
      await fs.promises.rename(temporary, filename);
    } catch (error) {
      log.warn(`[projects] last known projects not saved: ${error.message}`);
      await fs.promises.unlink(temporary).catch(() => {});
    }
  }

  function flush() {
    if (timer) { cancel(timer); timer = null; }
    const payload = queued;
    queued = null;
    if (payload) writing = writing.then(() => write(payload));
    return writing;
  }

  function remember({ defaultProjects, allProjects }) {
    queued = { version: FORMAT_VERSION, appVersion, savedAt: Date.now(), defaultProjects, allProjects };
    if (!timer) timer = schedule(() => { timer = null; flush(); }, writeDelayMs);
  }

  return { load, remember, flush, filename };
}

module.exports = { createLastKnownProjectsStore, FORMAT_VERSION, MAX_BYTES, WRITE_DELAY_MS };
