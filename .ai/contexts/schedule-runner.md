# Context: schedule-runner

Main-process modules live in `src/main/schedules/` (ADR 0005, step 8):
`schedule-runner.js`, `schedule-ipc.js` and `run-schedule-now-target.js` are siblings.
Their project and home based schedule paths remain unchanged. The Run now VM
test uses a module-specific loader and checks eager and lazy stub consumption.

**Purpose**: in-process cron that fires user-defined Claude tasks on a schedule. Stores schedules as Markdown files with YAML frontmatter inside each project's `.claude/commands/schedule-*.md`. Spawns `claude --resume <sid> -p "..."` as a detached child process when the cron expression matches.

## Key files

| File | LOC | Role |
|---|---|---|
| `src/main/schedules/schedule-runner.js` | ~670 | The cron loop, cron parser, file scanner, catch-up record, session pre-seeder, command builder. |
| `src/main/schedules/schedule-ipc.js` | ~225 | IPC handlers + the inline `SCHEDULE_CREATOR_TEMPLATE` (an embedded Claude command that teaches Claude how to write schedule files). |
| `src/main/schedules/schedule-run-results.js` | ~130 | Run-result persistence, read-only lookup, pruning and the shared exit classifier. |

## Public surface

From `schedule-runner.js`:

- `startScheduler(log, runCommand, { resumeSource, stateDir, projects })` — start the in-process cron. Called from `main.js` at app boot with `resumeSource: powerMonitor`, whose `resume` event triggers a catch-up check, and `stateDir: <dirname(DB_PATH)>/schedule-state`. Without `stateDir`, reading the record fails and catch-up schedules fall back to plain cron. With `SWITCHBOARD_DATA_DIR` set, catch-up is off altogether (see [Catch-up](#catch-up), "Isolated instances").
- `claimScheduleMinute(stateDir, key, minuteMs, info)` — exclusive-create one record file; `false` when it already exists. Exported for tests.
- `scanSchedules(log, projectPaths)` — scan the given projects for `<project>/.claude/commands/schedule-*.md`, parse frontmatter, return `Schedule[]`. Without `projectPaths` it scans nothing. `startScheduler` passes its `projects()` option, which `main.js` fills from the registry below.
- `scheduleRegistry(getSetting, setSetting, seed)` — the `scheduleProjects` setting: `list()`, `add(path)`, `remove(path)`. `main.js` reaches it through the session index writer (`scheduleProjects()` → `writer.scheduleRegistry(seed)` in `session-index-writer.js`), so its three methods are asynchronous there. `main.js` adds a project when it spawns a Claude session in it and on `add-project`, removes it on `remove-project`. Transcripts never add one: their `cwd`, and a folder name derived from it, are written by whoever ran claude, a sandboxed session included (see [docs/sandbox.md](../../docs/sandbox.md), "Schedules").
- `initialScheduleProjects(listProjectSettingKeys)` — the seed, read once while the setting has never been written. It is the union of the `project:<path>` settings keys whose path is an existing local directory (`main.js` passes `listSettingKeys('project:')`; a key carries no host alias, so a remote project whose path also exists locally registers that local directory — the user's own directory, low harm), and of the `~/.claude/projects` folders whose recorded path, resolved, encodes back to the folder's name, holds a schedule and contains a `.git` entry (directory or file). Its recorded path comes through `verifiedTranscriptCwd`, the same rule as every other transcript cwd (`.ai/contexts/session-cache.md`, "Transcript cwd trust"). The second source exists because v0.0.85 ran schedules from every transcript folder, so dropping it would silently stop the schedules of an upgrading user. The `.git` requirement only keeps out schedule directories that are not repositories: a folder planted before the upgrade (under v0.0.85 a sandboxed session could write both `~/.claude/projects` and its project directory) that holds a `.git` and a schedule is still registered, once, at the first read, and inherits the enclosing project's sandbox setting. Accepted residual (maintainer decision 2026-10-02); after the upgrade `~/.claude/projects` is read-only to sandboxed sessions except their own folder, so nothing new is planted. Any other project is registered at its first launch from the app.
- `refusedScheduleBinds(addDirs, projects, home, baseDir)` / `scheduleBindRefusals` (with the reason) — the `add-dirs` that are at or inside a `.claude` or `.git` (judged as spelled and by real path, anywhere), or under `home` and neither a registered project nor inside one (real paths). `scheduleLaunchRefusal` uses these rules; `main.js` and the listing share that refusal helper.
- `createScheduleSession(schedule, dueMs)` — write a pre-seeded JSONL into `~/.claude/projects/<encoded>/<uuid>.jsonl` with the schedule's prompt as the first user message, prefixed `Scheduled Task: `, or `Scheduled Task (catch-up: due …, started …): ` when `dueMs` is set. Returns `{ sessionId, jsonlPath }`.
- `buildScheduleCommand(sessionId, schedule)` — build the Claude argv, returned as `{ claudeArgs }` and shell-quoted by the caller: `--resume <sid> -p "Run the scheduled task" --permission-mode <mode> --allowedTools <tools>`, plus `--model`, `--max-budget-usd`, `--append-system-prompt` and `--add-dir` from the `cli:` block. The mode defaults to `auto` and the tools to `Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch` when the schedule names none.
- `resolveScheduleSandbox(cwd, getSetting, defaultValue)` — whether a run in `cwd` is sandboxed: the nearest `project:` setting at or above `cwd` that sets `sandbox`, then the global setting, then the default.
- `skipMissedRuns(log, projects, stateDir)` — see the Archive invariant below.
- `parseFrontmatter(content)`, `cronMatches(cronExpr, now)` — utilities, exported for tests.
- `scheduleFileUnlinked(projectRoot, filePath, realpath)` and `setScheduleEnabled(filePath, enabled, { projectRoot, rewrite })` — see [Disabling a schedule file](#disabling-a-schedule-file).

From `schedule-ipc.js`:

- `init(log, runScheduleCommand, isPathAllowed, isProjectArchived)` — wire IPC handlers (`get-schedule-creator-command`, `create-schedule-session`, `run-schedule-now`).
- `ensureScheduleCreatorCommand()` — on app start, write `SCHEDULE_CREATOR_TEMPLATE` to `~/.claude/commands/create-switchboard-schedule.md` if missing.

`main.js`'s shared `runScheduleCommand` returns `{ok:false, error}` when the
project is archived, a sandbox cannot run on this platform, sandbox add-dirs
are refused, or shell spawn fails. Each reason includes a recovery step. It
returns `{ok:true}` only on the child's `spawn` event; synchronous throws and
the pre-spawn `error` event are failures. `run-schedule-now` awaits and checks
that acknowledgement, treating a missing result as failure. Cron uses the same
launcher and retains its logging and completion callback. The safe Claude argv
is quoted for the configured login shell so its profile can initialise PATH.
Sandbox resolution follows global and project settings and never downgrades
silently; schedule add-dirs supply both CLI flags and sandbox binds.

This acknowledgement confirms only shell creation. The shared launcher's `exit`
handler also calls `schedule-ipc.js`'s `reportRunExit(window, result)` for both
manual and cron runs. Any non-zero exit, regardless of elapsed time, sends
`schedule-run-exit` while the window and its web contents exist. Exit 0 is silent;
signal terminations include the signal. The payload carries `name`, `projectPath`,
`sessionId`, `manual`, `code`, `signal` and `failure`. The launcher receives the
plain schedule name and a fifth argument with filePath, slug and dueMs, plus
`manual: true` from Run now; cron defaults to `manual: false`. `failure` is `claude-path` for code 127
or a shell lookup diagnostic naming exactly `claude` (bash/sh command-not-found,
including shell paths such as `/bin/bash`, zsh/fish command-last forms including
`zsh:1:`, quoted or unquoted env missing-executable, Windows spawn ENOENT /
English not recognized and PowerShell command lookup diagnostics).
`sandbox` requires a sandboxed run and either a line beginning `bwrap:` at any
exit code, or a line beginning `claude-sandbox:` at exit code 125, other than
the script's `claude not found in PATH` diagnostic. Wrapper warnings, skipped
binds and debug lines at other exit codes do not establish a sandbox failure;
all other failures receive `exit`, including API overloads inside the sandbox.
Stderr stays in the main log and is not sent to the renderer. Sandbox diagnostics
take precedence over code 127 or another lookup diagnostic; the script's exact
`claude not found in PATH` diagnostic alone receives `claude-path`.
Paths containing `.claude` and missing sandbox
dependencies do not establish a missing Claude command, nor do application
errors such as `Agent 'claude' not found` or `model claude not found`.
Localized cmd.exe lookup errors with exit 1 receive the log hint.

The launcher derives `Manual run <name>` for Run now's log lines, ActivityWatch
name and tracked live schedule name. `public/resume-guard.js` therefore retains
that marker when it names a running schedule in its confirmation. The exit IPC
continues to carry the plain schedule name and the separate `manual` flag.

No existing schedule event could carry asynchronous completion: `run-schedule-now`
is a request/reply that has already acknowledged spawn and is never invoked by
cron. The new event stays in the existing schedule IPC module and is exposed as
`onScheduleRunExit` in preload. `public/memory-workfiles-view.js` subscribes once
at script load, independently of whether the Schedules tab is open, and shows a
persistent B8 error with the schedule name, code (or signal) and recovery hint.
Manual notices use `ScheduleRun:<sessionId>` and say "Manual run of schedule".
Cron notices use `ScheduleRun:<projectPath>:<name>`: each failure replaces the
previous notice for that project and name, with a cumulative failure count since
the renderer loaded and the latest exit/signal and hint. Dismissing a notice or a
successful exit does not reset that count. Both ids differ from the launch-refusal
id `RunSchedule:<filePath>`: a fast exit arriving before the launch reply, or a
later retry, cannot clear an exit failure. No modal or exit-success toast is used.
With no live window the exit is logged and its run result persisted, without
queuing a notice for restart (see "Run results").

Tests: `test/run-schedule-now-result.test.js` loads the
shipped launcher and IPC handler with disposable schedule files and a simulated
child event boundary, without starting Electron or a real Claude process.
`test/dom-schedule-run-exit.test.js` connects the shipped preload subscription
to the renderer in jsdom, including persistent notices, recovery text and the
fast-exit/launch-reply ordering.

## Schedule project registry

`scheduleRegistry` reads `scheduleProjects` on each `list`, `add` and `remove`.
Only an absent or non-array setting invokes the seed; an empty array stays empty.
Path comparisons share `normalizeProjectPath` in `normalize-project-path.js`
with `main.js`'s Archive checks and unarchive catch-up reset: use
`fs.realpathSync.native` when available, replace backslashes with slashes,
then lowercase only on Windows and only when the path did not resolve: a
path that resolves keeps its on-disk spelling, so case-sensitive Windows
directories stay distinct. A missing directory uses its spelled path;
Linux and macOS retain case-sensitive comparisons. On every platform the
registry collapses realpath-equivalent spellings (a symlink and its target).

`add` retains the existing spelling of an equivalent project; `remove` removes
every equivalent spelling. Reads also collapse persisted duplicates and seed
duplicates, keeping the first spelling (the seed still resolves its paths).
The setting is rewritten only when seeded or when duplicates were found.
This repairs registries created before #607 before the scheduler scans them;
preventing new duplicates alone would still allow two runs per tick in those
registries. The surviving spelling keeps its transcript folder and catch-up
key, which both depend on how the scanner spells the path. Removed spellings'
catch-up files are left unused; no catch-up record or transcript is migrated.

`test/schedule-registry-paths.test.js` uses real disposable settings files with
Windows/Linux/macOS platform seams, including missing paths and realpath
aliases. `test/project-settings-archive.test.js` also restores a legacy Hide
entry with different case on native Windows and verifies one scheduled run.

## Schedule file format

```markdown
---
name: My morning audit
cron: 0 9 * * 1-5
enabled: true
slug: morning-audit
catch-up: true
cli:
  permission-mode: acceptEdits
  allowed-tools: Bash,Read,Write
---

<Full self-contained prompt that Claude will execute>
```

`enabled: false` disables without deleting. `catch-up: true` (`true` in any case, optionally quoted; the key spelled exactly so) opts in to [catch-up](#catch-up). `cron` is standard 5-field (minute, hour, day-of-month, month, day-of-week).

## Disabling a schedule file

`setScheduleEnabled` writes `enabled: false` or `enabled: true` into a
schedule file. Its callers: `archive-project` in `main.js` (archiving a folder,
see [session-cache.md](session-cache.md), "Archived projects"), which passes
the group's project path as `projectRoot` and disables only the files of a
fresh scan that the user confirmed; and `reenableScheduleFiles` in
`archived-projects.js` (the re-enable offer), which turns back on only the
offered files that still read `enabled: false`. The folder Archive reverse path
also uses this helper, limited to `disabledByArchive`, so schedules already off
before that Archive stay off. Undo restores the consumed prior offer separately;
deleted files or files whose `enabled` changed are skipped without a failure.

- **No link below the project root.** `scheduleFileUnlinked` holds when
  `realpath(filePath)` is `<realpath(projectRoot)>/.claude/commands/<name>`. A
  symlinked file, `commands` or `.claude` directory fails it: writing through
  it would change a file shared with another project or a dotfiles repository.
  A link above the root (a symlinked home, macOS `/tmp`) passes. It returns
  `false` on any `realpath` error. The archive plan uses the same helper, so a
  schedule offered as disableable is never refused for a link.
- **The parser decides.** The rewrite walks the front matter with
  `parseFrontmatter`'s own state machine and rewrites every line it reads as
  the top-level `enabled` key (an indented line with no open block counts; the
  last duplicate wins), or inserts `enabled: false` first when none is read (a
  line ending in `\r` is not read). The result is checked with
  `parseFrontmatter` before writing: `enabled` must read the requested value, `cron` and the
  body unchanged, or the file is left as is.
- **Atomic.** A temp file in the same directory, with the original mode, then
  `rename`.
- The file lives in the user's repository, so a tracked schedule file shows a
  working-tree diff after an archive.

## Schedule listing backend (#792, slice A1)

`list-schedules` in `main.js`, exposed as `api.listSchedules()` by preload,
calls the Electron-free `buildScheduleList(deps)` in
`src/main/schedules/schedule-list.js`. It awaits the complete local schedule
registry, including archived projects. Main injects the cache reader, schedule
liveness reader, archive and known-project predicates, sandbox settings, state
and transcript directories, and the instance's catch-up flag. The listing
module never derives catch-up policy from the environment.

`listScheduleFiles(projectPaths, deps)` in `schedule-runner.js` reads the same
directory and parser as `scanSchedules`, retaining disabled and malformed
schedules. Both readers and the registry seed share
`isRunnerScheduleFileName` (case-sensitive `schedule-` prefix and `.md` suffix)
and the effective name, slug and catch-up field helper. Only the exact parsed
string `false` disables a schedule; quoted `"false"` remains enabled. Files and
directories linked below the project root are listed as `linked` using the
existing `scheduleFileUnlinked` check.

Problems report unread front matter (with an LF-saving hint for CRLF), missing
cron or prompt, impossible cron fields/calendar combinations, sandbox launch
refusals and every other file sharing an effective slug in the project.
Impossible cron analysis enumerates values through the existing field matcher
and checks possible month lengths including leap February; it does not infer
impossibility from a one-year search. The Electron-free
`scheduleLaunchRefusal` is shared by this reader and `runScheduleCommand`:
off-Linux sandboxes are refused; Linux sandbox add-dirs use
`scheduleBindRefusals` and its existing reasons. Unsandboxed add-dirs are not
judged. The launcher's error and recovery text remain the same.

`nextCronMatch(expr, afterMs, horizonMs)` returns the first epoch minute strictly
after `afterMs`, within 366 days by default. A failing day field skips to the
next local midnight. A failing hour or an hour with no matching minute left
skips to the next local minute zero with
`t + (60 - new Date(t).getMinutes()) * 60000`. This retains the repeated Paris
hour and matches in half-hour zones such as Kolkata. Day-of-month and weekday
keep the runner's AND semantics. `describeCron` recognizes every-minute,
minute-step, daily and weekday presets; other expressions remain raw.

The catch-up state reader `readScheduleStateOnly` never creates a directory or
claims a minute. It treats an absent or future record as the minute before the
current one and searches the runner's seven-day window. A state read error
leaves pending time unknown (`null`). Catch-up disabled in this instance also
returns no pending time. The response carries the single `now` used for all
schedule calculations.

Runs are cache rows with the effective `scheduleSlug` in either the registry
path's encoded folder or its disk-real path's encoded folder, deduplicated by
session id, newest first, at most 20 per schedule. For these rows only, the
listing streams the transcript until its first assistant record; both
`type: assistant` and `type: message, role: assistant` count. A second user
record never proves a reply. Unreadable transcripts give `replied: null`;
readable transcripts without an assistant give `false`. The cache is not
modified. `cliSessionState.isScheduleRunLive(sessionId)` reads the launcher's
in-memory map without probing processes; `running` uses that export for cron
and manual runs. Slice A1 introduced `result: null`; slice D fills it from the
instance's persistent record (see "Run results").

Slice A1 added no renderer consumer, mutation IPC, result persistence or
changelog entry. Regressions: `schedule-next-run.test.js`,
`schedule-file-name.test.js` and `schedule-list.test.js`; they use disposable
files and plain Node boundaries, including the real main IPC registration and
preload exposure, without launching Electron.

## Invariants

### Running schedules in the sidebar (#814)

The cron-local `runningTasks` set remains the overlap guard. Session liveness
comes from the shared launcher's existing `cliSessionState.trackScheduleRun`:
it tracks the child/session pair for both cron and Run now, including manual
runs that never enter the cron set. Start, exit and spawn error notify the
existing status listeners. An old child's exit cannot clear a replacement
binding or emit a duplicate end notification.

The main process's `get-projects` assembly calls `annotateScheduleRuns` after
archive handling, for both default and all-project replies. Local rows carry
`runningScheduleIds` for their representative, head or merged members currently
tracked by the launcher; absent liveness removes that field. Remote rows never
inherit local run identity. No new IPC channel, preload API or worker-persisted
state is added: the existing status listener sends `projects-changed`, which
reloads these annotations, including after a renderer reload.

The sidebar treats these rows as running for filtering, sorting, truncation,
the schedule header dot and promotion out of a collapsed group. A change to
the scoped live schedule set repositions only the affected row or schedule group
within its project. Ordinary reloads retain the saved project order and the
relative order of unrelated items; explicit user actions still request a full
re-sort. Both initial icon painting and subsequent activity
repainting use a clock glyph and “Scheduled run in progress”, including its
accessible label. End returns the row to ordinary ordering and presentation.

See [session-state.md](session-state.md), “Live read-only message views”, for
the bounded transcript refresh and its shutdown behavior. Regressions:
`scheduled-run-liveness-814.test.js`, `dom-scheduled-running-814.test.js` and
`dom-live-transcript-814.test.js`. These exercise plain Node and jsdom boundaries;
they do not launch Electron, Claude or a real schedule.

### Launch invariants

- **Project Archive suspends launches without editing schedule files (#568).**
  `main.js` filters `scheduleProjects().list()` with `isProjectSettingsArchived`
  on every scheduler check, including startup, cron ticks and wake catch-up.
  The stored registry is preserved. The shared launch function checks again,
  and `schedule-ipc.init` receives the same predicate so Run now refuses before
  pre-seeding a transcript. Bare hidden entries suspend local projects and
  their nested worktrees; host-qualified remote entries do not suspend local
  schedules. The predicate resolves existing local roots on disk and normalizes
  separators, so Run now's resolved cwd, directory junctions and native Windows
  worktree paths follow the same suspension; on Windows the comparison uses
  `fs.realpathSync.native` and is case-insensitive. Already running commands
  continue. Unarchive clears the entry and passes over the catch-up record of the
  project's schedules (`skipMissedRuns` in `schedule-runner.js` claims the
  previous minute, or the current due minute if its tick already ran), so a run
  that fell due while archived is not replayed and the
  next due minute runs normally. The reset passes the registry's own spellings
  of the project and its nested worktrees, selected with the same real-path,
  case-insensitive-on-Windows comparison as suspension, because the catch-up key
  hashes the schedule file path as the scheduler scanned it. It registers the project only for a legacy Hide
  entry (no `hiddenProjectKinds` mark) whose folder still exists; an Archive
  leaves the registry untouched, and a Delete is never registered again. Archive folder remains
  a separate operation that can write `enabled: false` and offer re-enabling.

- **Schedules are scanned fresh every check** (`scanSchedules` on every minute boundary, at start and on `resume`). No in-memory cache — adding/editing a `.md` file takes effect within 60 seconds without any restart.
- **One run at a time per schedule** — `runningTasks` Set guards against overlap. If a schedule is still running when the next minute matches, the next tick is skipped with an info log line (no queue, no retry). A catch-up hits the same guard, after its minute is recorded: the skipped minute is consumed, not retried.
- **Trigger alignment**: `setTimeout` to next minute boundary, then `setInterval(tick, 60_000)`. The first call is aligned to the wall-clock minute; subsequent calls drift only by JS event-loop latency.
- **Session pre-seeding is required** — `claude --resume <sid>` won't work without an existing JSONL. `createScheduleSession` writes a minimal valid JSONL containing one user message (the prompt).
- **Headless child process** — spawned through the configured shell profile with `stdio: ['ignore', 'ignore', 'pipe']`, no PTY and no `detached` option. Stderr is captured for logging; stdout is dropped. The read-only message view follows transcript writes through the existing watcher.
- **The permission mode defaults to `auto`** when a schedule's `cli:` block names none (`DEFAULT_SCHEDULE_PERMISSION_MODE`); an explicit `permission-mode`, such as `acceptEdits`, is passed verbatim. A mode that prompts for tool permission would hang the headless `-p` run.

## Non-obvious behaviors

Scheduled runs from before v0.0.90 are listed one per row. They have no `scheduleSlug` and no backfill; their former grouping used only the CLI slug.

- **Sidebar run groups use runner provenance.** `createScheduleSession` seeds `scheduleSlug` alongside the CLI `slug` on its first user record, for regular, catch-up and run-now launches. Full and bounded header readers carry this marker through SQLite and the renderer payload; `public/sidebar.js` groups by `scheduleSlug`, names the header with it, and shows the header even for one visible run. A typed `Scheduled Task:` prompt never establishes provenance, and a changed or absent CLI slug does not change the schedule identity. Ordinary conversations each keep a separate row, even when CLI slugs match. Schedule DOM IDs encode the host alias, project path and raw schedule slug together without losing punctuation. Archived filtering stays upstream, and the grid lists individual sessions.
- **Existing transcripts have no safe schedule backfill.** The runner previously wrote no provenance marker, including before it added the prompt prefix. Those runs remain separate rows even after re-indexing; neither a prompt prefix nor a matching schedule filename proves their origin. Schema reconciliation adds a nullable `scheduleSlug` column without clearing old rows. Previously indexed rows start with a null marker, and a later full read or changed-file header refresh copies a marker if their transcript actually carries one. Deleted schedule files do not remove marked historical groups; renaming a file without a stable frontmatter slug gives future runs a new identity.
- **Legacy expansion migrates once without crossing schedule scopes.** An unscoped `slug-<sanitized slug>` key cannot identify its original project, host or raw punctuation. Inheritance is allowed only when all known projects (including those filtered out of the current render) identify exactly one matching host/project/raw-slug group. Ambiguous keys leave the groups collapsed. `migratedScheduleSlugs` records both visited scoped IDs and consumed legacy keys, so an explicit collapse survives and a schedule discovered later cannot reuse another scope's legacy expansion. Subsequent expand/collapse choices use independent scoped keys; already persisted scoped expansions are retained.
- **A schedule file may be a symlink.** `scanSchedules` lists names and reads through them, so a `schedule-*.md` linked in from a versioned dotfiles repo fires on cron like any other. The two places that *don't* go through that scanner had to be taught the same thing: Agent Files' former listing (`scan-md-files.js` — accepted entries on `dirent.isFile()`, false for a symlink, so a linked-in schedule was invisible in the UI while still firing weekly) and the run-now guard (`run-schedule-now-target.js` — checked the `.claude/commands` shape against the resolved target instead of the listed path). If you add a third reader of these files, resolve the link rather than the dirent.
- **`run-schedule-now` resolves the file and the cwd separately, and they may differ.** `resolveRunNowTarget` takes the schedule's bytes from the link's target and roots the spawn at the project whose `.claude/commands` lists it; each is disk-resolved and allowlisted in its own right, neither is derived from the other. With `projA/.claude/commands/schedule-x.md -> projB/.claude/commands/schedule-x.md` and both projects known, the run executes projB's content with `cwd = projA`. That is the semantic, not an oversight — `test/run-schedule-now-target.test.js` pins it so it is not "corrected" in either direction by accident.
- **Hand-rolled cron parser** in `cronFieldMatches` / `cronMatches`. Supports `*`, comma lists (`1,2,3`), ranges (`1-5`), steps (`*/5`). No support for `@daily`/`@hourly` aliases. No DST awareness — `new Date()` is local-time.
- **No persistence across app close, unless opted in** — the scheduler runs in-process. If Switchboard isn't running at 9am, the 9am schedule doesn't fire, and a suspended machine loses the minutes it sleeps through. `catch-up: true` changes that for one schedule; without it the behaviour is the original one, because some tasks are useless late.
- **The "schedule creator" is itself a Claude command**: when the user clicks the clock icon on a project, Switchboard opens an interactive Claude session pre-injected with `SCHEDULE_CREATOR_TEMPLATE` as its system prompt. Claude then has a conversation with the user about what they want scheduled, and **Claude itself writes the schedule `.md` file** with the Write tool. The runner just consumes whatever files appear.
- **`run-schedule-now`** IPC triggers an immediate manual run via the same `runScheduleCommand` pathway, bypassing the cron match check.

## Opening a running scheduled session (#484)

`main.js`'s shared `runScheduleCommand` registers each spawned child with
`cliSessionState.trackScheduleRun(sessionId, child, cwd, runName)`, using the `--resume`
id from the scheduler's argv. Cron and Run now therefore share the same guard.
The in-memory entry carries `kind: 'schedule'`, the shell child's pid, cwd and
launch time, plus the schedule name (prefixed `Manual run ` for Run now).
It is released on the child's `exit` or `error`; a refused spawn never creates
an entry. No CLI descriptor is written and no polling is added.

The live-elsewhere queries consult these entries independently of CLI files and
the own-process ancestry filter, which otherwise excludes a scheduled child on
Linux. `guardResume` asks with Resume anyway or Cancel on a manual open,
naming the schedule when known and warning that both processes write the transcript.
Automatic reload and working-set restore skip the run without prompting.
After the child exits, normal resume reads the whole scheduled transcript.
There is no daemon job id or PTY to attach to for these headless runs.

`test/schedule-live-resume.test.js` drives the shipped launch function, IPC
handlers, resume guard and renderer open/restore paths with a fake child.
The registry belongs to this app process; after a restart, a surviving run can
only be detected through the CLI's own descriptors, with their existing limits.

## If you change this, also check

- `public/dialogs.js` (`launchScheduleCreator`) — UI entry point for the schedule creator flow
- `public/schedules-view.js` — lists schedules, runs them, toggles enabled and opens their file; `memory-workfiles-view.js` keeps the independent exit-notice subscription
- `file-lists.js` — excludes runner schedule names from project commands before `listed()`, removing them from Agent Files and its FTS input; other scopes are unchanged
- `public/sidebar.js` — `.project-schedule-btn` clock icon wiring per project
- `archived-projects.js` (`archivePlanForGroups`) and `test/schedule-disable.test.js` — if you change `parseFrontmatter`, the rewrite in `setScheduleEnabled` follows the same state machine
- `schedule-ipc.js` `SCHEDULE_CREATOR_TEMPLATE` — if you change the schedule file format, update the template's instructions
- `main.js` (wherever `startScheduler(log, runScheduleCommand, { resumeSource: powerMonitor, stateDir })` is invoked at app boot — checked 2026-09, it moves as main.js grows)
- The `runScheduleCommand` factory in `main.js` — uses `child_process.spawn`, `cleanPtyEnv`, and the global shell profile. Schedules don't get their own shell selector.

## Limitations worth knowing

- No queue → long-running schedules can starve their next cycle (the skip is silent)
- No persistence without `catch-up: true` → app must be running for cron to fire
- Catch-up looks back seven days at most → a monthly task missed by more than a week is not caught up
- No DST handling → 02:30 schedules on DST spring-forward simply don't fire that day
- No sub-minute precision → cron is minute-granular by design
- No cross-machine sync → schedules live in the user's local `.claude/commands/`

## Catch-up

A schedule with `catch-up: true` runs once, late, when at least one
minute its cron matched went by with no check looking at it.

**The record.** `~/.switchboard/schedule-state/<key>-<minuteMs>.json` (the `stateDir` option), where
`<key>` is the first 16 hex characters of the SHA-256 of the listed
`filePath` (the path in `.claude/commands/`, not a symlink's target) and
`<minuteMs>` is the epoch of the latest minute *handled*: run, skipped as still
running, or taken as the baseline at first sight. The content (`file`, `name`)
is for a human reading the directory; only the file name is read back. After a
run the older files of that key are deleted, so there is normally one file per
schedule. Nothing is written for a schedule without `catch-up`.

**The check.** `check(onTick)` runs at start, on `resumeSource`'s `resume`, and
on each tick. For an opted-in schedule it looks for the latest minute the cron
matches in `(max(handled, now − 7 days), now]`, walking back minute by minute
from now (at most 10 080 `cronMatches` calls). None → nothing. One → claim it,
then `launch`; the run is labelled a catch-up only when that minute is earlier
than the current one, so a run in its own minute (a tick, or a start or resume
that lands in it) logs `Triggering:` as before. A schedule without `catch-up`
is only ever run by a tick whose minute matches.

**No double run.** Because a run records its minute and the window starts
after it, a tick landing in the same minute as a start or resume check finds an
empty window. The record is created with `writeFileSync(..., { flag: 'wx' })`:
a second claim of the same minute gets `EEXIST`, logs `already triggered for
that minute` and skips.

**Isolated instances.** `startScheduler` and the listing turn catch-up off when `process.env.SWITCHBOARD_DATA_DIR` is
truthy; an absent or empty value keeps it on. The scheduler logs `catch-up is off` once. `main.js` sets that
variable to `~/.switchboard-dev` for any unpackaged run, so `task dev`,
`task test-pr` and `npm start` all run with catch-up off; only the installed
app (no variable) catches up. With it off, no record is read or written and an
opted-in schedule is matched on ticks like any other, exactly as without the
key.

Both alternatives lose. A record shared across instances lets a test instance
scanning the same `~/.claude/projects` win the claim of an on-time minute or a
startup catch-up and run the task with its own isolated settings (sandbox,
shell profile) while the installed app skips it: a run with the wrong settings,
or no run when `claude` is only on the right profile's PATH. A record per
instance makes every relaunch of a test instance catch up, once per opted-in
schedule, runs the installed app has already made, possibly days of them.

The record directory is passed from `main.js` as
`<dirname(DB_PATH)>/schedule-state`, which for the installed app is
`~/.switchboard/schedule-state`.

**First sight.** No file for the key → write the baseline at the minute before
the current one, and carry on: nothing missed is caught up, but a file first
seen by the tick of its own due minute (saved at 19:59:40 for `0 20 * * *`)
still runs on time. A renamed or moved file is a new key, so it starts from a
baseline; the old key's file stays behind (a few bytes, never read again).

**Clock behind the record.** `handled > now` (the clock set back, or booted fast
and a catch-up taken early, then corrected by NTP) would leave the window empty
until the clock passed `handled` again, and an opted-in schedule never falls
back to `cronMatches`. So the record is dropped with a warning (`ahead of the
clock`) and re-seeded like a first sight.

**Claim before spawn.** The minute is recorded before `runCommand`. A spawn that
fails asynchronously, or a Switchboard exit mid-run, loses that run: it is not
caught up again.

**Failure.** If the directory cannot be read or a record cannot be written, the
schedule falls back to plain cron matching on ticks and a warning is logged.

**Re-enable.** Disabled schedules are dropped by `scanSchedules`. Re-enabling
through the tab, an archive offer or Undo first skips missed minutes through
the shared helper described below. `run-schedule-now` goes through
`schedule-ipc.js` and does not touch the record.

Tests: `test/schedule-catch-up.test.js` (fake `Date`/timers, `HOME` pointed at a
temporary directory).

## Read-only schedule listing (#792, slice A1)

`listScheduleFiles` retains malformed files. A non-string cron is listed with
`cron must be a string` and an empty cron value, so it cannot break another
file's description or next-run analysis. Each file dry-runs
`buildScheduleCommand` with a fixed validation session ID; its error message
becomes a problem without creating a transcript or launching a process.

`buildScheduleList` withholds next-run and catch-up timestamps when file or
launch validation reports a problem. The existing shared-slug diagnostic is
the exception: it does not prevent the runner from launching. A2 shows the
shared-slug diagnostic without calling the schedule unrunnable. Archived projects, disabled schedules and schedules
without a prompt have no catch-up timestamp. A state-read error remains
unknown, rather than an empty catch-up map; an unreadable transcript likewise
keeps `replied: null` rather than claiming no reply.

The `list-schedules` handler snapshots `getKnownProjectPaths()` once per request
and uses the existing exact-root validator against that snapshot. It refreshes
on the next request; it never rescans transcript folders for each registry row.
Launch-site functions and their extraction anchors are unchanged.

Cron descriptions use fixed-interval wording only for steps that divide sixty.
Other steps retain their raw expression (`*/45` fires at :00 and :45).
Numeric clock fields are formatted by value, so `007 09 * * *` says `daily at 9:07`.

Tests: `test/schedule-list.test.js` (real disposable schedule, state and transcript
files, main handler extracted into a VM with filename attribution; counts
PROJECTS_DIR scans), `test/schedule-next-run.test.js` (descriptions and DST).


## Schedules tab (#792, slice A2)

Global Settings → **Schedules tab** persists `global.schedulesTab`, defaulting
to `SETTING_DEFAULTS.schedulesTab` (false). Only renderer surfaces are gated.
The startup settings restore and Settings Save call `_applySchedulesTab`:
hidden/disabled clock tab with tabindex -1 when off, no programmatic route,
and a return to Sessions when the active tab is disabled. Saving applies live,
reloads Agent Files if open, cancels schedule refreshes and refreshes sidebar notices.
`file-lists.js` always supplies project command schedules, marked `schedule`;
Agent Files filters those entries only when the tab is on. Its file search
index keeps them available so switching requires no reindex. With the tab off,
the prior schedule icon, Run now and editor are restored. Archive choices,
Undo, re-enable offers and recovery hints use their pre-A2 names and Agent
Files wording; when on they retain the A2 counts and Schedules links.
No main-side scheduler, IPC, result persistence or re-enable skip is gated.

`public/schedules-view.js` consumes `list-schedules` on open, after Open, after
Run now/toggle while visible, on relevant projects-changed events (900 ms debounce, 3000 ms maximum
wait) and on minute boundaries while visible. The event allowlist is `archive`,
`project-added`, `project-deleted`, `project-remap`, `worktree-deleted`, `watcher`,
`session-exit` and `session-attach`: changes to the registry,
archive state or run history. CLI status changes do not reload the tab; scheduled-run
liveness is read at list time and the minute refresh picks it up. Scan progress (`scan`), activity,
metadata backfills/repair, remote updates and background-job events do not
reload this local tab; its minute refresh still picks up indexed scan results.
Preload forwards the `{ cause }` payload. Mixed-cause payloads refresh if any
cause is allowed. Hiding the tab cancels both
reload timers, invalidates pending requests and clears the requested project
focus. A pending toggle completed while hidden waits for reopening to reload.
The clock tab follows
Agent Files; Work Files is preserved. Search is hidden. Rows show cron, local
next-run and relative time, disabled/archive/validation reasons, shared-slug
diagnostics, catch-up status and the newest 20 runs from the main-side list.
Run now retains `RunSchedule:<filePath>` and the persistent error contract;
exit notices still subscribe once from memory-workfiles-view.js. Every scheduled-run
exit, including success, queues the same visible-tab reload before displaying any
failure notice. Open checks a
nonempty read-memory response before opening memoryPanel. History resolves a
fresh indexed session and goes through openSession, preserving resume guards.

`set-schedule-enabled` requires a boolean and exact equality with a path from
listScheduleFiles over the registry at call time. Linked/unread front matter is
refused. Before enabling a disabled catch-up schedule, skipMissedRunsOf claims
the prior-minute baseline, then setScheduleEnabled atomically rewrites the file.
The scheduler owns an in-memory last evaluated minute, exposed by the returned stop
function's `getLastTickMinute()`. Every check records its minute, after
project selection resolves and before schedules are scanned: cron ticks, startup
and resume catch-up checks use the same scheduler-owned state. A minute is evaluated
once for re-enable purposes, even if the schedule was disabled during that check.
The recorded minute only moves forward, so an older asynchronous project selection resolving after a newer check cannot make re-enabling replay an already evaluated minute.
An already enabled schedule still receives its normal startup catch-up run.
Main passes its getter through the existing enable and
archive deps, and its value to unarchive's skip. The current due minute is
claimed only if it equals the last minute evaluated. Before a fractional
or delayed tick (9:15:00.900 or 9:15:40), enabling in that same minute preserves
the due run; after that tick it is consumed. At 9:15:00.000, the ordering of the
tick and enable still decides: before the tick it may run, after the tick it
must not replay. A previous-minute tick never consumes the new minute.
Unarchive uses the same helper and therefore the same rule. Missing stateDir
refuses a catch-up re-enable with MissingScheduleStateDir. Archive parsing uses
the runner's shared scheduleFields helper.
This ordering also applies in isolated instances. Archive offers and Undo receive
the same stateDir via archiveDeps.reenable and reenableScheduleFiles; the writer
continues to perform file effects outside SQL. Skip failure prevents enabling.

With the tab enabled, Archive choices keep their default and file lists, but display counts and a
Schedules tab reference. Undo uses a count; the re-enable offer adds Show in
Schedules for its project. Failure text continues to name failed schedules.

## Run results

`src/main/schedules/schedule-run-results.js` owns persistent v1 results and the
shared `classifyRunExit({ code, sandbox, stderr })` used by the exit notice.
`runScheduleCommand` captures its start time before refusals or spawning. Its
fifth argument carries `{ manual, filePath, slug, dueMs }`: cron uses the listed
file and due minute (null for a current cron tick), Run now uses the resolved
file with manual true. Archive, platform and add-dir refusals after the seed,
synchronous spawn failure, pre-spawn child error and child exit all write through this
same identity. Write failure warns without changing launch, onDone or notice.
Preparation throws or rejections (including shell resolution, project listing,
trigger-directory creation and live-run tracking) record spawn-error with the
message and rethrow, preserving the existing rejection and callback behavior.
After the child's spawn event, an error is logged but does not publish a result
or call onDone; the actual exit remains authoritative for completion.

Records live under `<dirname(DB_PATH)>/schedule-runs`, isolated per instance.
Both launcher and listing use `scheduleRunsDir(dataDir)` from the results module.
Names are `<scheduleStateKey>-<startedAtMs>-<sessionId>.json`. Payloads are one
JSON line plus LF: `{ v: 1, sessionId, file, name, slug, manual, dueMs,
startedAt, endedAt, outcome, exitCode, signal, failure, error }`. Times are ISO
strings; exitCode is an integer or null; outcome is exited, signal, spawn-error
or refused. Stderr stays only in the log. Failure is exit, claude-path, sandbox
or null. Refusal/spawn error text is the launcher's returned recovery text.
Preparation exceptions retain their original message. Signal outcomes require
a non-empty signal string, refused/spawn-error require string error text, and
exited requires an integer exitCode; inconsistent records are unreadable.

Publication uses a same-directory temp file written with wx, then
renameWithRetry. A per-result wx lock serializes publishers; an existing final
file is kept. This preserves first-completion semantics without exposing a
partial JSON destination or allowing rename to replace a previous result on
Windows. Temp and owned lock files are removed on failure. A process killed
during publication can leave a temp/lock file; readers ignore it. Per-key pruning
removes that key's publication temp/lock files whose mtime is older than ten
minutes, retaining recent artifacts, unrelated names and other keys.
After a write, pruning keeps the 20 newest starts of that key and ignores
unlink errors. `pruneScheduleRunResults(dir, key, 0)` also supports the later
delete slice. Other keys and transcripts are untouched; renamed files can
leave their old key's bounded history behind.

`readScheduleRunResults(dir, sessionIds)` performs one readdir, parses only
requested IDs, validates their record and identity, and never mkdirs. Missing
directory means no results. Broken or unreadable records return
`{ unreadable: true }`; listing handles directory errors with that same marker.
Lookup uses session ID, so cron/Run now paths through aliases still find results.

Running uses the live map. Otherwise the renderer shows Exit 0, Failed: exit
code with the existing PATH/sandbox/log recovery hint, Stopped: signal,
Refused: error, Failed to start: error, or Unknown: result record unreadable.
Without a record it keeps No result recorded and the assistant/seed/started/
unknown transcript hint. It never infers Exit 0. Runs alive when Switchboard
quits, older runs and runs from another instance have no result here. Deletion,
the creation form and creator-template migration remain later slices.
`scheduleRunFailureHint(failure)` is a classic-script global defined in
memory-workfiles-view.js, loaded before schedules-view.js in index.html. Both
exit notices and persistent history use it for the same recovery wording.

Action state is keyed by filePath across renders: a pending launch stays disabled,
success shows the check mark and Launched! for two seconds, and a refusal restores
Run now with the persistent notice. A new launch invalidates the previous success
timer. Pending toggles likewise stay disabled. A render restores each row's open
history and focused control by filePath and control identity. If the control is
disabled, focus moves to its row (`tabIndex=-1`) and the control remains the
pending focus target across renders. Re-enabling restores it while focus stays
on that row; a newer focus choice takes precedence. The on/off toggle uses this
same focus hand-off as soon as its focused button becomes disabled. An unmatched project
focus request is consumed by that render. Guard refusal reasons are visible row text.
Next-run wording uses minutes below an hour, then today's time, tomorrow's time,
a weekday within the following week, or a date for later runs.

History navigation maps the listed run IDs to local indexed project paths, so a
registry alias and its resolved transcript folder expand the same visible group.
Opening a run selects a local indexed row before openSession; remote copies of
the same session ID do not participate in this local Schedules surface.

Open checks read-memory before changing viewers. On a valid read it uses
hideAllViewers before memoryPanel, so a previous Work Files or transcript viewer
does not cover the schedule editor. The existing save and watch contract stays.

History navigation resolves physical run IDs through `rowSessionIds` in local
merged rows. It passes the full row to `openSession`, preserving the existing
continuation and live-elsewhere resume guards.
