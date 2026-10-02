# Context: schedule-runner

**Purpose**: in-process cron that fires user-defined Claude tasks on a schedule. Stores schedules as Markdown files with YAML frontmatter inside each project's `.claude/commands/schedule-*.md`. Spawns `claude --resume <sid> -p "..."` as a detached child process when the cron expression matches.

## Key files

| File | LOC | Role |
|---|---|---|
| `schedule-runner.js` | ~490 | The cron loop, cron parser, file scanner, catch-up record, session pre-seeder, command builder. |
| `schedule-ipc.js` | ~225 | IPC handlers + the inline `SCHEDULE_CREATOR_TEMPLATE` (an embedded Claude command that teaches Claude how to write schedule files). |

## Public surface

From `schedule-runner.js`:

- `startScheduler(log, runCommand, { resumeSource, stateDir })` — start the in-process cron. Called from `main.js` at app boot with `resumeSource: powerMonitor`, whose `resume` event triggers a catch-up check, and `stateDir: <dirname(DB_PATH)>/schedule-state`. Without `stateDir`, reading the record fails and catch-up schedules fall back to plain cron. With `SWITCHBOARD_DATA_DIR` set, catch-up is off altogether (see [Catch-up](#catch-up), "Isolated instances").
- `claimScheduleMinute(stateDir, key, minuteMs, info)` — exclusive-create one record file; `false` when it already exists. Exported for tests.
- `scanSchedules(log, projectPaths)` — scan the given projects for `<project>/.claude/commands/schedule-*.md`, parse frontmatter, return `Schedule[]`. Without `projectPaths` it scans nothing. `startScheduler` passes its `projects()` option, which `main.js` fills from the registry below.
- `scheduleRegistry(getSetting, setSetting)` — the `scheduleProjects` setting: `list()`, `add(path)`, `remove(path)`. `main.js` adds a project when it spawns a Claude session in it and on `add-project`, removes it on `remove-project`. Transcripts never add one: their `cwd`, and a folder name derived from it, are written by whoever ran claude, a sandboxed session included (see [docs/sandbox.md](../../docs/sandbox.md), "Schedules").
- `initialScheduleProjects(listProjectSettingKeys)` — the seed, read once while the setting has never been written. It is the union of the `project:<path>` settings keys whose path is an existing local directory (`main.js` passes `db.listSettingKeys('project:')`; a key of a remote project names a path that does not exist here and is skipped), and of the `~/.claude/projects` folders whose recorded path encodes back to the folder's name, holds a schedule and contains a `.git` entry (directory or file). The second source exists because v0.0.85 ran schedules from every transcript folder, so dropping it would silently stop the schedules of an upgrading user; the `.git` requirement and the schedule requirement keep a planted folder from being registered and inheriting the enclosing project's sandbox setting. Any other project is registered at its first launch from the app.
- `refusedScheduleBinds(addDirs, projects, home, baseDir)` / `scheduleBindRefusals` (with the reason, used by `main.js`) — the `add-dirs` that are at or inside a `.claude` or `.git` (judged as spelled and by real path, anywhere), or under `home` and neither a registered project nor inside one (real paths). `main.js` skips a sandboxed run when it is not empty.
- `createScheduleSession(schedule, dueMs)` — write a pre-seeded JSONL into `~/.claude/projects/<encoded>/<uuid>.jsonl` with the schedule's prompt as the first user message, prefixed `Scheduled Task (catch-up: due …, started …): ` when `dueMs` is set. Returns the session UUID.
- `buildScheduleCommand(sessionId, schedule)` — assemble the shell command (`claude --resume "<sid>" -p "..." --permission-mode acceptEdits --allowedTools "..."`).
- `parseFrontmatter(content)`, `cronMatches(cronExpr, now)` — utilities, exported for tests.

From `schedule-ipc.js`:

- `init(log, runScheduleCommand)` — wire IPC handlers (`get-schedule-creator-command`, `create-schedule-session`, `run-schedule-now`).
- `ensureScheduleCreatorCommand()` — on app start, write `SCHEDULE_CREATOR_TEMPLATE` to `~/.claude/commands/create-switchboard-schedule.md` if missing.

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

## Invariants

- **Schedules are scanned fresh every check** (`scanSchedules` on every minute boundary, at start and on `resume`). No in-memory cache — adding/editing a `.md` file takes effect within 60 seconds without any restart.
- **One run at a time per schedule** — `runningTasks` Set guards against overlap. If a schedule is still running when the next minute matches, the next tick is skipped with an info log line (no queue, no retry). A catch-up hits the same guard, after its minute is recorded: the skipped minute is consumed, not retried.
- **Trigger alignment**: `setTimeout` to next minute boundary, then `setInterval(tick, 60_000)`. The first call is aligned to the wall-clock minute; subsequent calls drift only by JS event-loop latency.
- **Session pre-seeding is required** — `claude --resume <sid>` won't work without an existing JSONL. `createScheduleSession` writes a minimal valid JSONL containing one user message (the prompt).
- **Detached child process** — `stdio: ['ignore', 'ignore', 'pipe']`, no PTY. Stderr is captured for logging; stdout is dropped. No live tail; users see results by opening the resulting session in the sidebar.
- **`permission-mode: acceptEdits` is the typical default** for schedules — without it, the headless `-p` mode would hang on any tool-permission prompt.

## Non-obvious behaviors

- **A schedule file may be a symlink.** `scanSchedules` lists names and reads through them, so a `schedule-*.md` linked in from a versioned dotfiles repo fires on cron like any other. The two places that *don't* go through that scanner had to be taught the same thing: the brain tab's listing (`scan-md-files.js` — accepted entries on `dirent.isFile()`, false for a symlink, so a linked-in schedule was invisible in the UI while still firing weekly) and the run-now guard (`run-schedule-now-target.js` — checked the `.claude/commands` shape against the resolved target instead of the listed path). If you add a third reader of these files, resolve the link rather than the dirent.
- **`run-schedule-now` resolves the file and the cwd separately, and they may differ.** `resolveRunNowTarget` takes the schedule's bytes from the link's target and roots the spawn at the project whose `.claude/commands` lists it; each is disk-resolved and allowlisted in its own right, neither is derived from the other. With `projA/.claude/commands/schedule-x.md -> projB/.claude/commands/schedule-x.md` and both projects known, the run executes projB's content with `cwd = projA`. That is the semantic, not an oversight — `test/run-schedule-now-target.test.js` pins it so it is not "corrected" in either direction by accident.
- **Hand-rolled cron parser** in `cronFieldMatches` / `cronMatches`. Supports `*`, comma lists (`1,2,3`), ranges (`1-5`), steps (`*/5`). No support for `@daily`/`@hourly` aliases. No DST awareness — `new Date()` is local-time.
- **No persistence across app close, unless opted in** — the scheduler runs in-process. If Switchboard isn't running at 9am, the 9am schedule doesn't fire, and a suspended machine loses the minutes it sleeps through. `catch-up: true` changes that for one schedule; without it the behaviour is the original one, because some tasks are useless late.
- **The "schedule creator" is itself a Claude command**: when the user clicks the clock icon on a project, Switchboard opens an interactive Claude session pre-injected with `SCHEDULE_CREATOR_TEMPLATE` as its system prompt. Claude then has a conversation with the user about what they want scheduled, and **Claude itself writes the schedule `.md` file** with the Write tool. The runner just consumes whatever files appear.
- **`run-schedule-now`** IPC triggers an immediate manual run via the same `runScheduleCommand` pathway, bypassing the cron match check.

## If you change this, also check

- `public/dialogs.js` (`launchScheduleCreator`) — UI entry point for the schedule creator flow
- `public/memory-workfiles-view.js` brain tab — lists existing `schedule-*.md` files, surfaces the "run now" play button
- `scan-md-files.js` — what that brain tab list is actually built from (`get-memories` in `main.js`); it decides whether a schedule file is visible at all, and takes the memory allowlist so the list carries nothing the readers behind it would refuse to open
- `public/sidebar.js` — `.project-schedule-btn` clock icon wiring per project
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

**Isolated instances.** `startScheduler` turns catch-up off when `process.env.SWITCHBOARD_DATA_DIR` is
set, whatever its value, and logs `catch-up is off` once. `main.js` sets that
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

**Not covered.** A disabled schedule is dropped by `scanSchedules` before the
check, so re-enabling one catches up a run missed while disabled (within seven
days). `run-schedule-now` goes through `schedule-ipc.js` and does not touch the
record.

Tests: `test/schedule-catch-up.test.js` (fake `Date`/timers, `HOME` pointed at a
temporary directory).
