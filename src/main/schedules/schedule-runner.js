// schedule-runner.js — Scan schedule-*.md files, match cron, build commands
const fs = require('fs');
const { renameWithRetry } = require('../shared/atomic-write');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { encodeProjectPath, verifiedTranscriptCwd } = require('../../../encode-project-path');
const { normalizeProjectPath } = require('../shared/normalize-project-path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const MINUTE_MS = 60 * 1000;
const CATCH_UP_WINDOW_MS = 7 * 24 * 60 * MINUTE_MS;

/** Parse YAML-like frontmatter from a markdown file (simple key: value parser). */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta = {};
  let currentKey = null;
  const nested = {};

  for (const line of match[1].split('\n')) {
    if (currentKey && line.match(/^\s+/) && line.includes(':')) {
      const m = line.match(/^\s+([^:]+):\s*(.*)$/);
      if (m && !m[1].trim().startsWith('#')) {
        if (!nested[currentKey]) nested[currentKey] = {};
        nested[currentKey][m[1].trim()] = m[2].trim();
      }
      continue;
    }
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (val === '' || val === undefined) {
        currentKey = key;
      } else {
        meta[key] = val;
        currentKey = null;
      }
    }
  }
  for (const [k, v] of Object.entries(nested)) {
    meta[k] = v;
  }
  return { meta, body: match[2].trim() };
}

// Check if a cron field matches a value. Supports *, ranges (1-5), lists (1,3,5), and steps.
function cronFieldMatches(field, value) {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return value % step === 0;
  }
  if (field.includes(',')) {
    return field.split(',').some(f => cronFieldMatches(f.trim(), value));
  }
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  return parseInt(field, 10) === value;
}

/** Check if a 5-field cron expression matches the current time. */
function cronMatches(cronExpr, now) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts;
  return (
    cronFieldMatches(minute, now.getMinutes()) &&
    cronFieldMatches(hour, now.getHours()) &&
    cronFieldMatches(dom, now.getDate()) &&
    cronFieldMatches(month, now.getMonth() + 1) &&
    cronFieldMatches(dow, now.getDay())
  );
}

function cronCanMatch(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const values = bounds.map(([lo, hi], i) => Array.from({ length: hi - lo + 1 }, (_, n) => lo + n).filter(n => cronFieldMatches(parts[i], n)));
  if (values.some(v => !v.length)) return false;
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return values[3].some(month => values[2].some(day => day <= days[month - 1]));
}

function nextCronMatch(expr, afterMs, horizonMs = 366 * 24 * 60 * MINUTE_MS) {
  if (!Number.isFinite(afterMs) || !Number.isFinite(horizonMs) || !cronCanMatch(expr)) return null;
  const [minute, hour, dom, month, dow] = expr.trim().split(/\s+/);
  let t = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  while (t <= afterMs + horizonMs) {
    const date = new Date(t);
    if (!cronFieldMatches(dom, date.getDate()) || !cronFieldMatches(month, date.getMonth() + 1) || !cronFieldMatches(dow, date.getDay())) {
      t = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
      continue;
    }
    const remaining = Array.from({ length: 60 - date.getMinutes() }, (_, i) => i + date.getMinutes());
    if (!cronFieldMatches(hour, date.getHours()) || !remaining.some(m => cronFieldMatches(minute, m))) {
      t += (60 - date.getMinutes()) * MINUTE_MS;
      continue;
    }
    if (cronMatches(expr, date)) return t;
    t += MINUTE_MS;
  }
  return null;
}

function describeCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || !cronCanMatch(expr)) return expr;
  const [minute, hour, dom, month, dow] = parts;
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
    if (minute === '*') return 'every min';
    if (/^\*\/[1-9]\d*$/.test(minute) && 60 % Number(minute.slice(2)) === 0) return `every ${Number(minute.slice(2))} min`;
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && month === '*') {
    const time = `${Number(hour)}:${String(Number(minute)).padStart(2, '0')}`;
    if (dow === '*') return `daily at ${time}`;
    if (dow === '1-5') return `weekdays at ${time}`;
  }
  return expr;
}

/** The latest minute in (afterMs, uptoMs] that the cron expression matches, or null. */
function latestCronMatch(cronExpr, afterMs, uptoMs) {
  for (let m = Math.floor(uptoMs / MINUTE_MS) * MINUTE_MS; m > afterMs; m -= MINUTE_MS) {
    if (cronMatches(cronExpr, new Date(m))) return m;
  }
  return null;
}

function scheduleStateKey(schedule) {
  return crypto.createHash('sha256').update(schedule.filePath).digest('hex').slice(0, 16);
}

/**
 * Read the catch-up record: Map<key, { handled, files }>, where `handled` is
 * the latest minute (epoch ms) already run or deliberately passed over.
 */
function readScheduleState(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  return readScheduleStateOnly(stateDir);
}

function readScheduleStateOnly(stateDir) {
  const state = new Map();
  let names;
  try { names = fs.readdirSync(stateDir); }
  catch (err) { if (err.code === 'ENOENT') return state; throw err; }
  for (const name of names) {
    const m = name.match(/^([0-9a-f]{16})-(\d+)\.json$/);
    if (!m) continue;
    const entry = state.get(m[1]) || { handled: -Infinity, files: [] };
    entry.handled = Math.max(entry.handled, Number(m[2]));
    entry.files.push(name);
    state.set(m[1], entry);
  }
  return state;
}

/**
 * Mark a minute of a schedule as handled. The exclusive create is the claim:
 * of two instances deciding on the same minute, only one gets `true`.
 */
function claimScheduleMinute(stateDir, key, minuteMs, info) {
  try {
    fs.writeFileSync(path.join(stateDir, `${key}-${minuteMs}.json`), JSON.stringify(info) + '\n', { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function pruneScheduleState(stateDir, entry) {
  for (const name of entry.files) {
    try { fs.unlinkSync(path.join(stateDir, name)); } catch {}
  }
}

/**
 * Resolve a project folder name to its project path from the SQLite cache.
 * Returns a Map<folder, projectPath>, or an empty Map if the cache is
 * unavailable (e.g. in tests that don't load the native DB binding).
 */
function loadFolderMetaMap() {
  try {
    // Lazy require so requiring schedule-runner.js never forces the native
    // better-sqlite3 binding to load (keeps the module test-friendly).
    const { getAllFolderMeta } = require('../../../db');
    const meta = getAllFolderMeta();
    const map = new Map();
    for (const [folder, row] of meta) {
      if (row && row.projectPath) map.set(folder, row.projectPath);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Read a project folder's first JSONL just enough to extract its cwd. */
function readProjectPathFromJsonl(folderPath) {
  try {
    const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
    for (const jf of jsonlFiles) {
      const head = fs.readFileSync(path.join(folderPath, jf), 'utf8').slice(0, 4000);
      for (const line of head.split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          if (entry.cwd) return entry.cwd;
        } catch {}
      }
    }
  } catch {}
  return null;
}

/**
 * The projects to seed the schedule registry with, the first time it is read:
 * the local directories that have a `project:<path>` setting, and the git
 * checkouts under a ~/.claude/projects folder named after them that already
 * hold a schedule. see docs/sandbox.md ("Schedules")
 */
function initialScheduleProjects(listProjectSettingKeys) {
  const found = new Set();
  const prefix = 'project:';
  for (const key of listProjectSettingKeys()) {
    if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
    const projectPath = key.slice(prefix.length);
    if (!path.isAbsolute(projectPath)) continue;
    try {
      if (fs.statSync(projectPath).isDirectory()) found.add(projectPath);
    } catch {}
  }
  if (!fs.existsSync(PROJECTS_DIR)) return [...found];
  const folderMeta = loadFolderMetaMap();
  for (const folder of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const recorded = folderMeta.get(folder.name) || readProjectPathFromJsonl(path.join(PROJECTS_DIR, folder.name));
    if (!recorded) continue;
    const projectPath = verifiedTranscriptCwd(recorded, folder.name);
    if (!projectPath) continue;
    try {
      if (!fs.existsSync(path.join(projectPath, '.git'))) continue;
      const commandsDir = path.join(projectPath, '.claude', 'commands');
      if (fs.readdirSync(commandsDir).some(isRunnerScheduleFileName)) {
        found.add(projectPath);
      }
    } catch {}
  }
  return [...found];
}

// see .ai/contexts/schedule-runner.md ("Schedule project registry")
function scheduleRegistry(getSetting, setSetting, seed = () => []) {
  const read = () => {
    const stored = getSetting('scheduleProjects');
    const projects = (Array.isArray(stored) ? stored : seed().map(p => path.resolve(p)))
      .filter(p => typeof p === 'string' && p !== '');
    const seen = new Set();
    const unique = projects.filter(p => {
      const key = normalizeProjectPath(p);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!Array.isArray(stored) || unique.length !== stored.length) setSetting('scheduleProjects', unique);
    return unique;
  };
  return {
    list: read,
    add(projectPath) {
      if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) return;
      const p = path.resolve(projectPath);
      const current = read();
      const key = normalizeProjectPath(p);
      if (!current.some(x => normalizeProjectPath(x) === key)) setSetting('scheduleProjects', [...current, p]);
    },
    remove(projectPath) {
      const p = path.resolve(projectPath);
      const current = read();
      const key = normalizeProjectPath(p);
      const remaining = current.filter(x => normalizeProjectPath(x) !== key);
      if (remaining.length !== current.length) setSetting('scheduleProjects', remaining);
    },
  };
}

/**
 * Whether a schedule running in `cwd` is sandboxed: the `project:` setting of
 * `cwd` or, failing that, of the nearest directory above it that has one, then
 * the global setting, then the default.
 */
function resolveScheduleSandbox(cwd, getSetting, defaultValue) {
  let dir = path.resolve(cwd);
  for (;;) {
    const project = getSetting('project:' + dir);
    if (project && project.sandbox !== undefined) return !!project.sandbox;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const global = getSetting('global');
  if (global && global.sandbox !== undefined) return !!global.sandbox;
  return !!defaultValue;
}

/** The real path of `p`; for a path that does not exist, its nearest existing ancestor's real path plus the rest. */
function canonicalPath(p) {
  const resolved = path.resolve(p);
  const rest = [];
  let dir = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return resolved;
      rest.push(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * The add-dirs of a sandboxed schedule that the wrapper must not bind: any at
 * or inside a `.claude` or `.git` directory, and any under $HOME that is
 * neither a known project nor inside one. A relative one is taken from the
 * schedule's directory, `baseDir`. Each is judged both as spelled
 * (normalised) and by its real path.
 * see docs/sandbox.md ("Additional directories")
 */
function scheduleBindRefusals(addDirs, knownProjects, home, baseDir = process.cwd()) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
  const homeDir = canonicalPath(home);
  const projects = knownProjects.map(canonicalPath);
  const protectedName = (p) => p.split(path.sep).some(c => c === '.claude' || c === '.git');
  const refusals = [];
  for (const dir of addDirs) {
    const lexical = path.resolve(baseDir, dir);
    const real = canonicalPath(lexical);
    if (protectedName(lexical) || protectedName(real)) {
      refusals.push({ dir, reason: 'at or inside a .claude or .git directory' });
    } else if (inside(real, homeDir) && !projects.some(project => inside(real, project))) {
      refusals.push({ dir, reason: 'under the home directory and not a Switchboard project' });
    }
  }
  return refusals;
}

function refusedScheduleBinds(addDirs, knownProjects, home, baseDir) {
  return scheduleBindRefusals(addDirs, knownProjects, home, baseDir).map(r => r.dir);
}

function scheduleLaunchRefusal({ sandbox, platform = process.platform, addDirs = [], projectPaths = [], home = os.homedir(), cwd = process.cwd() }) {
  if (!sandbox) return null;
  if (platform !== 'linux') return {
    problem: 'sandbox needs Linux',
    error: 'The schedule sandbox requires Linux (bubblewrap). Run it on Linux with bubblewrap, or disable Sandbox in the project or global settings and try Run now again.',
  };
  const refused = scheduleBindRefusals(addDirs, projectPaths, home, cwd);
  if (!refused.length) return null;
  const detail = refused.map(r => `${r.dir} (${r.reason})`).join(', ');
  return { problem: `add-dirs refused: ${detail}`, error: `Sandbox add-dirs refused: ${detail}. Remove or change these add-dirs in the schedule file, then try Run now again.` };
}

function isRunnerScheduleFileName(name) {
  return name.startsWith('schedule-') && name.endsWith('.md');
}

async function createScheduleFile(projectPath, fields, deps) {
  let tmp;
  let field = 'projectPath';
  const fail = (field, error) => ({ ok: false, field, error });
  try {
    const { scheduleProjects, getSetting = () => null, defaultSandbox = false, isArchived = () => false,
      platform = process.platform, home = os.homedir(), stateDir, runsDir, link = fs.linkSync } = deps;
    const projectPaths = await scheduleProjects().list();
    if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) return fail(field, 'Choose a registered project');
    const registered = projectPaths.find(p => normalizeProjectPath(p) === normalizeProjectPath(projectPath));
    if (!registered) return fail(field, 'Choose a registered project');
    projectPath = registered;
    if (isArchived(projectPath)) return fail(field, 'This project is archived; unarchive it first');
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return fail('name', 'Schedule fields are required');
    const scalar = (key, value, required = false) => {
      field = key;
      if (value == null && !required) return '';
      if (typeof value !== 'string' || !isSafeScalar(value) || /[\r\n]/.test(value)) throw new Error('Enter a single line without control characters');
      const result = value.trim();
      if (required && !result) throw new Error('This field is required');
      return result;
    };
    const name = scalar('name', fields.name, true);
    const slug = scalar('slug', fields.slug, true);
    if (slug.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return fail('slug', 'Use at most 64 lowercase letters, digits and single hyphens');
    const cron = scalar('cron', fields.cron, true);
    if (!cronCanMatch(cron)) return fail('cron', 'cron can never match');
    for (const key of ['enabled', 'catch-up']) {
      if (fields[key] !== undefined && typeof fields[key] !== 'boolean') return fail(key, 'Choose on or off');
    }
    const cli = {};
    if (fields.cli != null && (typeof fields.cli !== 'object' || Array.isArray(fields.cli))) return fail('cli', 'CLI fields must be an object');
    for (const key of ['permission-mode', 'allowed-tools', 'model', 'max-budget-usd', 'append-system-prompt']) {
      const value = scalar(`cli.${key}`, fields.cli?.[key]);
      if (value) cli[key] = value;
    }
    if (cli['max-budget-usd'] && !/^\d+(\.\d+)?$/.test(cli['max-budget-usd'])) return fail('cli.max-budget-usd', 'Enter a non-negative number');
    const rawDirs = fields.cli?.['add-dirs'];
    let addDirs = [];
    if (rawDirs !== undefined) {
      if (!Array.isArray(rawDirs)) return fail('cli.add-dirs', 'Enter one directory per line');
      addDirs = rawDirs.map(value => scalar('cli.add-dirs', value, true));
      if (addDirs.some(dir => dir.includes(','))) return fail('cli.add-dirs', 'A directory cannot contain a comma');
      if (addDirs.length) cli['add-dirs'] = addDirs.join(',');
    }
    field = 'prompt';
    if (typeof fields.prompt !== 'string' || !fields.prompt.trim()) return fail(field, 'Enter a prompt');
    const prompt = fields.prompt.replace(/\r\n?/g, '\n').trim();
    const refusal = scheduleLaunchRefusal({ sandbox: resolveScheduleSandbox(projectPath, getSetting, defaultSandbox), platform, addDirs, projectPaths, home, cwd: projectPath });
    if (refusal) return fail(refusal.problem === 'sandbox needs Linux' ? 'projectPath' : 'cli.add-dirs', refusal.error);
    if (listScheduleFiles([projectPath]).some(schedule => schedule.slug === slug)) return fail('slug', 'A schedule with this slug already exists');
    const lines = ['---', `name: ${name}`, `cron: ${cron}`, `slug: ${slug}`, `enabled: ${fields.enabled !== false}`, `catch-up: ${fields['catch-up'] === true}`];
    if (Object.keys(cli).length) lines.push('cli:', ...Object.entries(cli).map(([key, value]) => `  ${key}: ${value}`));
    const content = lines.join('\n') + '\n---\n\n' + prompt + '\n';
    const parsed = parseFrontmatter(content);
    for (const [key, value] of Object.entries({ name, cron, slug, enabled: String(fields.enabled !== false), 'catch-up': String(fields['catch-up'] === true) })) {
      if (parsed.meta[key] !== value) return fail(key, 'This value cannot round trip through the schedule parser');
    }
    if (parsed.body !== prompt) return fail('prompt', 'This prompt cannot round trip through the schedule parser');
    for (const [key, value] of Object.entries(cli)) {
      if (parsed.meta.cli?.[key] !== value) return fail(`cli.${key}`, 'This value cannot round trip through the schedule parser');
    }
    buildScheduleCommand('schedule-create-validation', { cli: parsed.meta.cli || {} });
    field = 'projectPath';
    const commandsDir = path.join(projectPath, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    if (fs.realpathSync(commandsDir) !== path.join(fs.realpathSync(projectPath), '.claude', 'commands')) return fail(field, 'The commands directory is linked outside the project');
    const filePath = path.join(commandsDir, `schedule-${slug}.md`);
    field = 'slug';
    tmp = path.join(commandsDir, `.schedule-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    try { link(tmp, filePath); }
    catch (error) {
      if (['EPERM', 'ENOTSUP', 'ENOSYS'].includes(error.code)) return fail('projectPath', `This project's filesystem does not support hard links (${error.code}). Choose a project on a filesystem that supports hard links.`);
      throw error;
    }
    try {
      if (stateDir) {
        const entry = readScheduleStateOnly(stateDir).get(scheduleStateKey({ filePath }));
        if (entry) pruneScheduleState(stateDir, entry);
      }
      if (runsDir) require('./schedule-run-results').pruneScheduleRunResults(runsDir, scheduleStateKey({ filePath }), 0);
    } catch (error) {
      console.warn(`[schedule] Created ${filePath}, but could not prune stale records:`, error.code, error.message);
    }
    return { ok: true, filePath };
  } catch (error) {
    return fail(field, error.code === 'EEXIST' ? 'A schedule with this slug already exists' : `${error.code ? error.code + ': ' : ''}${error.message}`);
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

function scheduleFields(file, meta) {
  return {
    name: meta.name || file,
    slug: meta.slug || file.replace(/^schedule-/, '').replace(/\.md$/, ''),
    catchUp: /^(["']?)true\1$/i.test(meta['catch-up'] || ''),
  };
}

function listScheduleFiles(projectPaths, { getSetting = () => null, defaultSandbox = false, platform = process.platform, home = os.homedir() } = {}) {
  const schedules = [];
  for (const projectPath of projectPaths) {
    const commandsDir = path.join(projectPath, '.claude', 'commands');
    let files;
    try { files = fs.readdirSync(commandsDir).filter(isRunnerScheduleFileName); } catch { continue; }
    for (const file of files) {
      const filePath = path.join(commandsDir, file);
      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      const { meta, body } = parseFrontmatter(content);
      const problems = [];
      if (!/^---\n([\s\S]*?)\n---\n?/.test(content)) problems.push(`front matter not read${content.includes('\r\n') ? ': save with LF line endings' : ''}`);
      if (!meta.cron) problems.push('no cron');
      else if (typeof meta.cron !== 'string') problems.push('cron must be a string');
      else if (!cronCanMatch(meta.cron)) problems.push('cron can never match');
      if (!body) problems.push('no prompt');
      try { buildScheduleCommand('schedule-list-validation', { cli: meta.cli || {} }); }
      catch (err) { problems.push(err.message); }
      const addDirs = String((meta.cli || {})['add-dirs'] || '').split(',').map(d => d.trim()).filter(Boolean);
      const refusal = scheduleLaunchRefusal({ sandbox: resolveScheduleSandbox(projectPath, getSetting, defaultSandbox), platform, addDirs, projectPaths, home, cwd: projectPath });
      if (refusal) problems.push(refusal.problem);
      schedules.push({ file, filePath, projectPath, ...scheduleFields(file, meta), cron: typeof meta.cron === 'string' ? meta.cron : '',
        enabled: meta.enabled !== 'false', cli: meta.cli || {}, prompt: body,
        linked: !scheduleFileUnlinked(projectPath, filePath), problems });
    }
  }
  for (const row of schedules) {
    for (const other of schedules) {
      if (other !== row && other.projectPath === row.projectPath && other.slug === row.slug) row.problems.push(`slug shared with ${other.file}`);
    }
  }
  return schedules;
}

/**
 * Scan the registered projects for schedule-*.md files and return parsed
 * schedule objects. Without a registry, nothing is scanned.
 */
function scanSchedules(log, projectPaths = []) {
  const schedules = [];
  try {
    for (const projectPath of projectPaths) {
      const folder = { name: encodeProjectPath(projectPath) };
      const commandsDir = path.join(projectPath, '.claude', 'commands');
      try {
        if (!fs.existsSync(commandsDir)) continue;
        const files = fs.readdirSync(commandsDir).filter(isRunnerScheduleFileName);
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(commandsDir, file), 'utf8');
            const { meta, body } = parseFrontmatter(content);
            if (!meta.cron || !body) continue;
            if (meta.enabled === 'false') continue;
            schedules.push({
              file, filePath: path.join(commandsDir, file),
              projectPath, folder: folder.name,
              ...scheduleFields(file, meta), cron: meta.cron,
              cli: meta.cli || {}, prompt: body,
            });
          } catch (err) {
            if (log) log.warn(`[schedule] Failed to parse ${file}:`, err.message);
          }
        }
      } catch {}
    }
  } catch (err) {
    if (log) log.error('[schedule] Error scanning schedules:', err);
  }
  return schedules;
}

/**
 * Create a pre-seeded JSONL session file with user message and slug for grouping.
 * `dueMs` is set for a catch-up run: the minute it was due, named in the message.
 */
function createScheduleSession(schedule, dueMs) {
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const heading = dueMs == null
    ? 'Scheduled Task: '
    : `Scheduled Task (catch-up: due ${new Date(dueMs).toISOString()}, started ${timestamp}): `;
  const claudeProjectDir = path.join(PROJECTS_DIR, schedule.folder);

  fs.mkdirSync(claudeProjectDir, { recursive: true });
  const jsonlPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);

  const msgId = crypto.randomUUID();
  const lines = [
    JSON.stringify({ type: 'user', parentUuid: null, uuid: msgId, sessionId, cwd: schedule.projectPath, slug: schedule.slug, scheduleSlug: schedule.slug, timestamp, message: { role: 'user', content: heading + schedule.prompt } }),
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  return { sessionId, jsonlPath };
}

// Defense-in-depth: reject control chars in frontmatter values (shell-quoter is the real defense)
function isSafeScalar(s) {
  if (s == null) return true;
  return !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(String(s));
}

function assertSafe(field, value) {
  if (!isSafeScalar(value)) {
    throw new Error(`Schedule field "${field}" contains unsafe characters`);
  }
  return value;
}

// Permission mode used when a schedule's frontmatter doesn't name one. Matches
// SETTING_DEFAULTS.permissionMode in main.js: 'auto' lets Claude classify each
// action, allowing routine work and stopping for risky ones, which is a better
// fit for an unattended headless run than acceptEdits' blanket edit approval.
//
// This is only the FALLBACK. A schedule that sets `cli: permission-mode: <x>`
// keeps <x> verbatim — see resolvePermissionMode.
const DEFAULT_SCHEDULE_PERMISSION_MODE = 'auto';

/**
 * Pick the permission mode for a scheduled run.
 *
 * An explicitly-configured mode always wins, even if it equals the old default.
 * Only an absent key (or a blank value, which `--permission-mode` would reject)
 * falls through to DEFAULT_SCHEDULE_PERMISSION_MODE. Deliberately not written as
 * `cli['permission-mode'] || DEFAULT` so the absent-vs-configured distinction is
 * visible rather than riding on truthiness.
 */
function resolvePermissionMode(cli) {
  const configured = cli['permission-mode'];
  if (configured === undefined || configured === null) return DEFAULT_SCHEDULE_PERMISSION_MODE;
  const trimmed = String(configured).trim();
  return trimmed === '' ? DEFAULT_SCHEDULE_PERMISSION_MODE : trimmed;
}

/**
 * Build the argv for a scheduled claude invocation.
 * Returns `{ claudeArgs: string[] }` — a plain argv array, with zero shell interpretation.
 * The caller is responsible for shell-quoting when constructing a shell command string.
 */
function buildScheduleCommand(sessionId, schedule) {
  const cli = schedule.cli || {};
  const args = [
    '--resume', assertSafe('sessionId', sessionId),
    '-p', 'Run the scheduled task',
    '--permission-mode', assertSafe('permission-mode', resolvePermissionMode(cli)),
  ];

  if (cli.model) args.push('--model', assertSafe('model', cli.model));
  if (cli['max-budget-usd']) {
    const budget = String(cli['max-budget-usd']).trim();
    if (!/^\d+(\.\d+)?$/.test(budget)) {
      throw new Error(`Schedule field "max-budget-usd" must be a number, got: ${cli['max-budget-usd']}`);
    }
    args.push('--max-budget-usd', budget);
  }
  args.push('--allowedTools', assertSafe('allowed-tools', cli['allowed-tools'] || 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch'));
  if (cli['append-system-prompt']) {
    // Allow newlines in prompt text, but not control chars other than \n, \r, \t
    const prompt = String(cli['append-system-prompt']);
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(prompt)) {
      throw new Error('Schedule field "append-system-prompt" contains unsafe characters');
    }
    args.push('--append-system-prompt', prompt);
  }
  if (cli['add-dirs']) {
    for (const dir of String(cli['add-dirs']).split(',').map(d => d.trim()).filter(Boolean)) {
      args.push('--add-dir', assertSafe('add-dirs', dir));
    }
  }

  return { claudeArgs: args };
}

/**
 * Pass over every minute up to now for the catch-up schedules of these projects,
 * so a run that fell due while a project was archived is not replayed.
 * see .ai/contexts/schedule-runner.md ("Archive")
 */
function skipMissedRuns(log, projects, stateDir, lastTickMinute = null) {
  for (const schedule of scanSchedules(log, projects)) skipMissedRunsOf(schedule, stateDir, lastTickMinute);
}

function skipMissedRunsOf(schedule, stateDir, lastTickMinute = null) {
  if (!schedule.catchUp) return;
  if (!stateDir) throw new Error('MissingScheduleStateDir: cannot skip missed schedule runs');
  const now = Date.now();
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const baseline = lastTickMinute === minute && typeof schedule.cron === 'string' && cronMatches(schedule.cron, new Date(minute)) ? minute : minute - MINUTE_MS;
  const state = readScheduleState(stateDir);
  const key = scheduleStateKey(schedule);
  const entry = state.get(key);
  if (entry && entry.handled >= baseline) return;
  claimScheduleMinute(stateDir, key, baseline, { file: schedule.filePath, name: schedule.name });
  if (entry) pruneScheduleState(stateDir, entry);
}

async function setListedScheduleEnabled(filePath, enabled, { scheduleProjects, stateDir, getLastTickMinute = () => null, setEnabled = setScheduleEnabled }) {
  if (typeof filePath !== 'string' || typeof enabled !== 'boolean') return { ok: false, error: 'invalid schedule or enabled value' };
  try {
    const schedule = listScheduleFiles(await scheduleProjects().list()).find(s => s.filePath === filePath);
    if (!schedule) return { ok: false, error: 'schedule is not listed' };
    if (schedule.linked) return { ok: false, error: 'linked file: edit it at its source' };
    if (schedule.problems.some(p => p.startsWith('front matter not read'))) return { ok: false, error: 'front matter not read' };
    if (enabled && !schedule.enabled) skipMissedRunsOf(schedule, stateDir, getLastTickMinute());
    return setEnabled(filePath, enabled, { projectRoot: schedule.projectPath });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Start the cron loop. Checks every 60 seconds; a schedule with `catch-up: true`
 * is also checked at start and on `resume`, and runs once for missed minutes.
 * @param {object} log - Logger
 * @param {function} runCommand - Function to spawn a shell command: runCommand(cmd, cwd, name)
 * @param {object} [opts]
 * @param {EventEmitter} [opts.resumeSource] - Emits `resume` after a system suspend (Electron's powerMonitor)
 * @param {string} [opts.stateDir] - This instance's catch-up record directory; without it, catch-up schedules run on cron only
 * @returns {function} stop - Call to stop the scheduler
 */
function startScheduler(log, runCommand, { resumeSource, stateDir, projects } = {}) {
  let running = true;
  let lastTickMinute = null;
  const runningTasks = new Set();
  // see .ai/contexts/schedule-runner.md ("Isolated instances")
  const catchUpOn = !process.env.SWITCHBOARD_DATA_DIR;
  if (!catchUpOn) log.info('[schedule] catch-up is off: SWITCHBOARD_DATA_DIR isolates this instance, schedules run on cron only');

  function launch(schedule, dueMs) {
    const taskKey = `${schedule.folder}:${schedule.slug}`;
    if (runningTasks.has(taskKey)) {
      log.info(`[schedule] Skipping ${schedule.name} — still running from previous trigger`);
      return;
    }

    if (dueMs == null) {
      log.info(`[schedule] Triggering: ${schedule.name} (${schedule.cron})`);
    } else {
      log.info(`[schedule] Catching up: ${schedule.name} (${schedule.cron}), due ${new Date(dueMs).toISOString()}`);
    }
    try {
      const { sessionId } = createScheduleSession(schedule, dueMs);
      const { claudeArgs } = buildScheduleCommand(sessionId, schedule);

      runningTasks.add(taskKey);
      const launched = runCommand(claudeArgs, schedule.projectPath, schedule.name, () => {
        runningTasks.delete(taskKey);
      }, { filePath: schedule.filePath, slug: schedule.slug, dueMs });
      if (launched?.catch) launched.catch(err => {
        runningTasks.delete(taskKey);
        log.error(`[schedule] Failed to run ${schedule.name}:`, err);
      });
    } catch (err) {
      log.error(`[schedule] Failed to run ${schedule.name}:`, err);
    }
  }

  function checkCatchUp(schedule, state, nowMs) {
    const key = scheduleStateKey(schedule);
    const nowMinute = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
    const info = { file: schedule.filePath, name: schedule.name };
    let entry = state.get(key);
    if (entry && entry.handled > nowMinute) {
      log.warn(`[schedule] ${schedule.name}: recorded minute ${new Date(entry.handled).toISOString()} is ahead of the clock, restarting its record from now`);
      pruneScheduleState(stateDir, entry);
      entry = null;
    }
    if (!entry) {
      const baseline = nowMinute - MINUTE_MS;
      claimScheduleMinute(stateDir, key, baseline, info);
      entry = { handled: baseline, files: [`${key}-${baseline}.json`] };
    }
    const due = latestCronMatch(schedule.cron, Math.max(entry.handled, nowMinute - CATCH_UP_WINDOW_MS), nowMinute);
    if (due === null) return;
    if (!claimScheduleMinute(stateDir, key, due, info)) {
      log.info(`[schedule] Skipping ${schedule.name} — already triggered for that minute`);
      return;
    }
    pruneScheduleState(stateDir, entry);
    launch(schedule, due < nowMinute ? due : null);
  }

  function check(onTick) {
    if (!running) return;
    const now = new Date();
    const selected = projects ? projects() : [];
    if (selected && typeof selected.then === 'function') {
      return selected.then(paths => checkProjects(onTick, paths, now));
    }
    return checkProjects(onTick, selected, now);
  }

  function checkProjects(onTick, paths, now) {
    if (!running) return;
    lastTickMinute = Math.max(lastTickMinute ?? -Infinity, Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
    const schedules = scanSchedules(log, paths);
    let state = null;
    if (catchUpOn && schedules.some(s => s.catchUp)) {
      try {
        state = readScheduleState(stateDir);
      } catch (err) {
        log.warn(`[schedule] Cannot read the catch-up record in ${stateDir}, running on cron only:`, err.message);
      }
    }

    for (const schedule of schedules) {
      if (schedule.catchUp && state) {
        try {
          checkCatchUp(schedule, state, now.getTime());
          continue;
        } catch (err) {
          log.warn(`[schedule] Cannot keep the catch-up record of ${schedule.name}, running on cron only:`, err.message);
        }
      }
      if (onTick && cronMatches(schedule.cron, now)) launch(schedule, null);
    }
  }

  const runCheck = onTick => {
    try {
      const result = check(onTick);
      if (result?.catch) return result.catch(err => log.error('[schedule] Cannot load schedule projects:', err));
    } catch (err) { log.error('[schedule] Cannot load schedule projects:', err); }
  };
  const tick = () => runCheck(true);
  const onResume = () => runCheck(false);

  runCheck(false);
  if (resumeSource) resumeSource.on('resume', onResume);

  const msUntilNextMinute = (60 - new Date().getSeconds()) * 1000;
  const initialTimer = setTimeout(() => {
    const checked = tick();
    const interval = setInterval(tick, 60 * 1000);
    initialTimer._interval = interval;
    return checked;
  }, msUntilNextMinute);

  function stop() {
    running = false;
    clearTimeout(initialTimer);
    if (initialTimer._interval) clearInterval(initialTimer._interval);
  }
  stop.getLastTickMinute = () => lastTickMinute;
  return stop;
}

/**
 * Whether `filePath` is `<projectRoot>/.claude/commands/<name>` with no link
 * below the project root. False on any realpath error; never throws.
 */
function scheduleFileUnlinked(projectRoot, filePath, realpath = fs.realpathSync) {
  try {
    return realpath(filePath) === path.join(realpath(projectRoot), '.claude', 'commands', path.basename(filePath));
  } catch {
    return false;
  }
}

/**
 * Rewrite every front-matter line parseFrontmatter reads as the top-level
 * `enabled` key to `enabled: <value>`, or insert that line first when none is.
 */
function rewriteEnabled(content, value) {
  const enabledLine = 'enabled: ' + value;
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return content;
  let currentKey = null;
  let found = false;
  const lines = match[1].split('\n').map((line) => {
    if (currentKey && line.match(/^\s+/) && line.includes(':')) return line;
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (!kv) return line;
    if (kv[2].trim() === '') {
      currentKey = kv[1].trim();
      return line;
    }
    currentKey = null;
    if (kv[1].trim() !== 'enabled') return line;
    found = true;
    return enabledLine;
  });
  if (!found) lines.unshift(enabledLine);
  return '---\n' + lines.join('\n') + content.slice('---\n'.length + match[1].length);
}

/**
 * Set `enabled` in a schedule file in place, checked with the real parser and
 * written atomically with the original mode. Refuses a file reached through a
 * link below `projectRoot`.
 */
function setScheduleEnabled(filePath, enabled, { projectRoot, rewrite = rewriteEnabled, rename = fs.renameSync } = {}) {
  const value = enabled ? 'true' : 'false';
  if (!scheduleFileUnlinked(projectRoot, filePath)) return { ok: false, error: 'linked file or directory' };
  let tmp = null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const mode = fs.statSync(filePath).mode & 0o7777;
    const next = rewrite(content, value);
    const before = parseFrontmatter(content);
    const after = parseFrontmatter(next);
    if (after.meta.enabled !== value || after.meta.cron !== before.meta.cron || after.body !== before.body) {
      return { ok: false, error: `the front matter could not be rewritten to enabled: ${value}` };
    }
    tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, next, { mode });
    fs.chmodSync(tmp, mode);
    renameWithRetry(tmp, filePath, { rename });
    tmp = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

module.exports = { createScheduleFile, scheduleFields, setListedScheduleEnabled, skipMissedRunsOf, listScheduleFiles, isRunnerScheduleFileName, nextCronMatch, describeCron, scheduleLaunchRefusal, readScheduleStateOnly, latestCronMatch, scheduleStateKey, scheduleFileUnlinked, setScheduleEnabled, parseFrontmatter, cronMatches, scanSchedules, startScheduler, skipMissedRuns, createScheduleSession, buildScheduleCommand, claimScheduleMinute, initialScheduleProjects, refusedScheduleBinds, scheduleBindRefusals, resolveScheduleSandbox, scheduleRegistry };
