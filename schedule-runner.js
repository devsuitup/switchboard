// schedule-runner.js — Scan schedule-*.md files, match cron, build commands
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { encodeProjectPath, verifiedTranscriptCwd } = require('./encode-project-path');

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
  const state = new Map();
  for (const name of fs.readdirSync(stateDir)) {
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
    const { getAllFolderMeta } = require('./db');
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
      if (fs.readdirSync(commandsDir).some(f => f.startsWith('schedule-') && f.endsWith('.md'))) {
        found.add(projectPath);
      }
    } catch {}
  }
  return [...found];
}

/**
 * The schedule registry, kept in the `scheduleProjects` setting: the projects
 * Switchboard opened a session in or the user added, seeded once by
 * `seed()` when the setting has never been written.
 */
function scheduleRegistry(getSetting, setSetting, seed = () => []) {
  const read = () => {
    const stored = getSetting('scheduleProjects');
    if (Array.isArray(stored)) return stored;
    const seeded = [...new Set(seed().map(p => path.resolve(p)))];
    setSetting('scheduleProjects', seeded);
    return seeded;
  };
  return {
    list: read,
    add(projectPath) {
      if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) return;
      const p = path.resolve(projectPath);
      const current = read();
      if (!current.includes(p)) setSetting('scheduleProjects', [...current, p]);
    },
    remove(projectPath) {
      const p = path.resolve(projectPath);
      const current = read();
      if (current.includes(p)) setSetting('scheduleProjects', current.filter(x => x !== p));
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
        const files = fs.readdirSync(commandsDir).filter(f => f.startsWith('schedule-') && f.endsWith('.md'));
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(commandsDir, file), 'utf8');
            const { meta, body } = parseFrontmatter(content);
            if (!meta.cron || !body) continue;
            if (meta.enabled === 'false') continue;
            schedules.push({
              file, filePath: path.join(commandsDir, file),
              projectPath, folder: folder.name,
              name: meta.name || file, cron: meta.cron,
              catchUp: /^(["']?)true\1$/i.test(meta['catch-up'] || ''),
              slug: meta.slug || file.replace(/^schedule-/, '').replace(/\.md$/, ''),
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
    JSON.stringify({ type: 'user', parentUuid: null, uuid: msgId, sessionId, cwd: schedule.projectPath, slug: schedule.slug, timestamp, message: { role: 'user', content: heading + schedule.prompt } }),
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
      runCommand(claudeArgs, schedule.projectPath, schedule.name, () => {
        runningTasks.delete(taskKey);
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
    const schedules = scanSchedules(log, projects ? projects() : []);
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

  const tick = () => check(true);
  const onResume = () => check(false);

  check(false);
  if (resumeSource) resumeSource.on('resume', onResume);

  const msUntilNextMinute = (60 - new Date().getSeconds()) * 1000;
  const initialTimer = setTimeout(() => {
    tick();
    const interval = setInterval(tick, 60 * 1000);
    initialTimer._interval = interval;
  }, msUntilNextMinute);

  return function stop() {
    running = false;
    clearTimeout(initialTimer);
    if (initialTimer._interval) clearInterval(initialTimer._interval);
  };
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
function setScheduleEnabled(filePath, enabled, { projectRoot, rewrite = rewriteEnabled } = {}) {
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
    fs.renameSync(tmp, filePath);
    tmp = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

module.exports = { scheduleFileUnlinked, setScheduleEnabled, parseFrontmatter, cronMatches, scanSchedules, startScheduler, createScheduleSession, buildScheduleCommand, claimScheduleMinute, initialScheduleProjects, refusedScheduleBinds, scheduleBindRefusals, resolveScheduleSandbox, scheduleRegistry };
