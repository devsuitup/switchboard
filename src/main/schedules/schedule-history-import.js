// see .ai/contexts/schedule-runner.md ("Imported history")
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encodeProjectPath, encodedFolderMayExtend } = require('../../../encode-project-path');
const { renameWithRetry } = require('../shared/atomic-write');

const STORE_VERSION = 2;
const SEED_FIRST_BYTES = 8 * 1024;
const SEED_MAX_BYTES = 64 * 1024;
const BATCH = 32;
const RETRY_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = '(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z)';
const HEADING_RE = new RegExp(`^Scheduled Task(?: \\(catch-up: due ${ISO}, started ${ISO}\\))?: `);
const LOOKALIKE_RE = /^Scheduled Task[ :(]/;
const SEED_KEYS = ['cwd', 'message', 'parentUuid', 'sessionId', 'slug', 'timestamp', 'type', 'uuid'].join();

function storeFileOf(dataDir) {
  return path.join(dataDir, 'schedule-history', 'imported.json');
}

async function readSeedLine(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    let text = '';
    let offset = 0;
    for (const size of [SEED_FIRST_BYTES, SEED_MAX_BYTES - SEED_FIRST_BYTES]) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      offset += bytesRead;
      text += buffer.toString('latin1', 0, bytesRead);
      const end = text.indexOf('\n');
      if (end >= 0) return Buffer.from(text.slice(0, end), 'latin1').toString('utf8');
      if (bytesRead < size) return null;
    }
    return null;
  } finally { await handle.close(); }
}

function isoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function caseKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function samePath(a, b) {
  return caseKey(a) === caseKey(b);
}

function inside(child, parent) {
  const relative = path.relative(caseKey(parent), caseKey(child));
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function realpathsOf(realpath, nativeRealpath) {
  return nativeRealpath ? [realpath, nativeRealpath] : [realpath];
}

function pathForms(target, realpaths) {
  const forms = new Set([path.resolve(target)]);
  for (const realpath of realpaths) {
    try { forms.add(realpath(target)); } catch {}
  }
  return [...forms];
}

function readFolderNames(projectsDir) {
  try { return fs.readdirSync(projectsDir); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function projectFolders(projectPath, folderNames, { realpath = fs.realpathSync, nativeRealpath = fs.realpathSync.native } = {}) {
  const folders = new Set(pathForms(projectPath, realpathsOf(realpath, nativeRealpath)).map(encodeProjectPath));
  if (process.platform === 'win32') {
    const keys = new Set([...folders].map(caseKey));
    for (const name of folderNames) if (keys.has(caseKey(name))) folders.add(name);
  }
  return folders;
}

function seedAttribution(line, { sessionId, folder, projectPath, realpath = fs.realpathSync, nativeRealpath = fs.realpathSync.native, worktree = false }) {
  let seed;
  try { seed = JSON.parse(line); } catch { return null; }
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return null;
  if (Object.keys(seed).sort().join() !== SEED_KEYS) return null;
  const { type, parentUuid, uuid, cwd, slug, timestamp, message } = seed;
  if (type !== 'user' || parentUuid !== null || seed.sessionId !== sessionId) return null;
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid) || !UUID_RE.test(sessionId)) return null;
  if (typeof slug !== 'string' || !slug || !isoTime(timestamp)) return null;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !samePath(encodeProjectPath(cwd), folder)) return null;
  if (projectPath !== undefined) {
    const realpaths = realpathsOf(realpath, nativeRealpath);
    const owners = pathForms(projectPath, realpaths);
    const owned = worktree ? inside : samePath;
    if (!pathForms(cwd, realpaths).some(form => owners.some(owner => owned(form, owner)))) return null;
  }
  if (!message || typeof message !== 'object' || Object.keys(message).sort().join() !== 'content,role') return null;
  if (message.role !== 'user' || typeof message.content !== 'string') return null;
  const heading = HEADING_RE.exec(message.content);
  if (!heading) return null;
  let dueMs = null;
  if (heading[1]) {
    if (heading[2] !== timestamp || !isoTime(heading[1]) || Date.parse(heading[1]) > Date.parse(timestamp)) return null;
    dueMs = Date.parse(heading[1]);
  }
  return { slug, created: timestamp, dueMs, cwd };
}

function readStore(file) {
  try {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    if ((store?.v === 1 || store?.v === STORE_VERSION) && store.projects && typeof store.projects === 'object' && !Array.isArray(store.projects)) return store;
  } catch {}
  return null;
}

function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(store) + '\n');
    renameWithRetry(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

function createScheduleHistoryImport(deps) {
  const { dataDir, projectsDir, scheduleProjects, listSchedules, getCachedByFolder,
    isIndexReady = () => true, onProgress = () => {}, onSettled = () => {}, log = console,
    readHead = readSeedLine, pause = () => new Promise(resolve => setImmediate(resolve)), realpath = fs.realpathSync,
    nativeRealpath = realpath === fs.realpathSync ? fs.realpathSync.native : null, now = Date.now, retryMs = RETRY_MS } = deps;
  const file = storeFileOf(dataDir);
  const realpaths = realpathsOf(realpath, nativeRealpath);
  let store = readStore(file);
  let state = store ? 'done' : 'pending';
  let error = null;
  let running = null;
  let imported = null;
  let retryAt = 0;
  const readThisLaunch = new Set();

  function importedRuns() {
    if (imported) return imported;
    imported = new Map();
    for (const [projectPath, entry] of Object.entries(store?.projects || {})) {
      for (const [sessionId, run] of Object.entries(entry?.runs || {})) imported.set(sessionId, { projectPath, ...run });
    }
    return imported;
  }

  function status(projectPaths = null) {
    const listed = projectPaths && new Set(projectPaths);
    const unattributed = Object.entries(store?.projects || {})
      .reduce((sum, [projectPath, entry]) => sum + (!listed || listed.has(projectPath) ? entry?.unattributed || 0 : 0), 0);
    return error ? { state, unattributed, error } : { state, unattributed };
  }

  function needsReading(projectPath) {
    const entry = store?.projects[projectPath];
    return !entry || entry.final !== true && !readThisLaunch.has(projectPath);
  }

  async function importProject(projectPath, pass) {
    const previous = store?.projects[projectPath];
    const runs = { ...(previous?.runs || {}) };
    const orphans = { ...(previous?.orphans || {}) };
    const rejected = { ...(previous?.rejected || {}) };
    if (!isDirectory(projectPath)) return { runs, orphans, rejected, unattributed: previous?.unattributed || 0, final: false };
    let scanError = null;
    const schedules = listSchedules([projectPath], { onScanError: (_projectPath, error) => { scanError ||= error; } });
    const unreadable = scanError || schedules.find(schedule => schedule.readError)?.readError;
    if (unreadable) throw Object.assign(new Error(`schedules of ${projectPath} could not be read: ${unreadable.message}`), { code: unreadable.code });
    const slugs = new Set(schedules.map(schedule => schedule.slug).filter(Boolean));
    const claimed = new Set();
    for (const [owner, entry] of Object.entries(store?.projects || {})) {
      if (owner !== projectPath) for (const sessionId of Object.keys(entry?.runs || {})) claimed.add(sessionId);
    }
    const owners = pass.forms.get(projectPath);
    const nested = [...pass.forms].filter(([other, forms]) => other !== projectPath
      && forms.some(form => owners.some(owner => inside(form, owner)))).flatMap(([, forms]) => forms);
    const folders = projectFolders(projectPath, pass.folderNames, { realpath, nativeRealpath });
    const ownKeys = new Set([...folders].map(caseKey));
    const worktreeFolders = pass.folderNames.filter(name => !ownKeys.has(caseKey(name))
      && owners.some(owner => encodedFolderMayExtend(caseKey(name), caseKey(owner))));
    let unattributed = 0;
    let orphaned = 0;
    let read = 0;
    const seen = new Set();
    const scan = async (folder, worktree) => {
      for (const row of await getCachedByFolder(folder)) {
        if (seen.has(row.sessionId) || claimed.has(row.sessionId) || row.scheduleSlug || row.parentSessionId || !UUID_RE.test(row.sessionId || '')) continue;
        const lookalike = LOOKALIKE_RE.test(row.firstPrompt || row.summary || '');
        if (!lookalike && !slugs.has(row.slug)) continue;
        seen.add(row.sessionId);
        if (runs[row.sessionId]) {
          if (!slugs.has(runs[row.sessionId].slug)) orphaned++;
          continue;
        }
        if (orphans[row.sessionId]) {
          if (slugs.has(orphans[row.sessionId].slug)) {
            runs[row.sessionId] = orphans[row.sessionId];
            delete orphans[row.sessionId];
          } else orphaned++;
          continue;
        }
        if (Object.hasOwn(rejected, row.sessionId)) {
          unattributed += rejected[row.sessionId];
          continue;
        }
        if (++read % BATCH === 0) await pause();
        let line;
        try { line = await readHead(path.join(projectsDir, folder, `${row.sessionId}.jsonl`)); }
        catch (readError) {
          if (readError.code === 'ENOENT') continue;
          throw readError;
        }
        let attribution = line === null ? null : seedAttribution(line, { sessionId: row.sessionId, folder, projectPath, realpath, nativeRealpath, worktree });
        if (attribution && worktree && pathForms(attribution.cwd, realpaths).some(form => nested.some(owner => samePath(form, owner) || inside(form, owner)))) attribution = null;
        if (attribution) {
          const record = { slug: attribution.slug, folder, created: attribution.created, dueMs: attribution.dueMs };
          if (slugs.has(attribution.slug)) runs[row.sessionId] = record;
          else {
            orphans[row.sessionId] = record;
            orphaned++;
          }
        } else {
          const counted = !worktree && lookalike && (line === null || !seedAttribution(line, { sessionId: row.sessionId, folder })) ? 1 : 0;
          rejected[row.sessionId] = counted;
          unattributed += counted;
        }
      }
    };
    for (const folder of folders) await scan(folder, false);
    for (const folder of worktreeFolders) await scan(folder, true);
    return { runs, orphans, rejected, unattributed: unattributed + orphaned, final: Object.keys(runs).length > 0 && orphaned === 0 };
  }

  async function run() {
    const before = state;
    let changed = false;
    try {
      const registry = await scheduleProjects().list();
      const todo = registry.filter(needsReading);
      if (todo.length) {
        if (state !== 'done') state = 'running';
        error = null;
        if (!store) store = { v: STORE_VERSION, projects: {} };
        const forms = new Map(registry.map(projectPath => [projectPath, pathForms(projectPath, realpaths)]));
        const pass = { forms, folderNames: readFolderNames(projectsDir) };
        let firstFailure = null;
        for (const projectPath of todo) {
          try {
            const entry = await importProject(projectPath, pass);
            if (store.v !== STORE_VERSION || JSON.stringify(entry) !== JSON.stringify(store.projects[projectPath])) {
              const next = { v: STORE_VERSION, projects: { ...store.projects, [projectPath]: entry } };
              writeStore(file, next);
              store = next;
              imported = null;
              changed = true;
              onProgress(projectPath);
            }
            readThisLaunch.add(projectPath);
          } catch (failure) { firstFailure ||= failure; }
          await pause();
        }
        if (firstFailure) throw firstFailure;
      }
      state = 'done';
      error = null;
      if (changed || before !== 'done') log.info?.(`[schedules] Imported ${importedRuns().size} run(s) made before the schedule marker`);
    } catch (failure) {
      state = 'failed';
      error = failure.message;
      retryAt = now() + retryMs;
      log.warn?.(`[schedules] Run history import incomplete, retried in ${Math.round(retryMs / 60000)} min: ${failure.message}`);
    }
    if (changed || state !== 'done' || before !== 'done') onSettled(state);
  }

  function ensureStarted() {
    if (running || state === 'failed' && now() < retryAt) return;
    if (!isIndexReady()) {
      if (state !== 'done') state = 'waiting';
      return;
    }
    running = run().finally(() => { running = null; });
  }

  return { ensureStarted, status, importedRuns, whenIdle: () => running || Promise.resolve() };
}

module.exports = { RETRY_MS, SEED_MAX_BYTES, storeFileOf, readSeedLine, readFolderNames, projectFolders, seedAttribution, createScheduleHistoryImport };
