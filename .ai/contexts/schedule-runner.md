# Context: schedule-runner

## Opt-in background runs (#611)

`run-as-background: true` is opt-in and local only. It is kebab-case like
`catch-up`, and both read through `frontmatterFlag` in `scheduleFields`
(quotes and any case accepted), which cron (`scanSchedules`) and Run now
(`schedule-ipc.js`) share, so the two cannot disagree on a file. The flag is the
only front matter #611 adds: the issue rules out other format changes, so there
is no timeout key; background runs use the internal one-hour
`BACKGROUND_RUN_LIMIT_MS`. Both callers pass `background: { seedPath }`, the
path `createScheduleSession` returned, so the launcher never re-derives it. The
headless argv builder is unchanged. `schedule-background.js` creates a new job
using `claude --bg --name <name> <options> -- <seed message>`: the prompt is the
seed's full first message, `Scheduled Task:` or catch-up heading included, as
the headless run sees it. The delimiter protects that last argument from
variadic add-dir and allowedTools flags. The app's existing `runClaudeCommand`
supplies sanitized child env and shell quoting.

Refusal falls back to headless with the existing fallback notice: a sandbox or
a project `preLaunchCmd` (the predicate is bg-agents' `dispatchRefusal`, looked
up on the resolved cwd like `dispatchSettings`), a WSL shell, and a
`max-budget-usd` cap, which the CLI documents as `--print`-only. A global
`preLaunchCmd` does not refuse: headless schedules never apply one either.
`dispatchArgs` is not reused: it builds dispatch-form fields (agent, newline
add-dirs) and refuses a leading `-`, while the schedule forwards its own
validated headless options.

CLI 2.1.302 measurements in #611 establish that flagless resume continues a
previously created job, while resume with options forks it. They do not establish
resume of a newly pre-seeded transcript with no job directory. We therefore keep
the existing provisional seed, obtain the actual UUID from the launched job's
state (checking its first eight hex characters against stdout), append a
`schedule-provenance` record with that UUID to the actual transcript (the job's
`linkScanPath` when it names that UUID, else beside the seed), then remove the
provisional file. This record carries metadata without a user message,
parentUuid or uuid, so it cannot introduce a second conversation root. The full
and display-header readers accept its scheduleSlug alongside legacy user seeds.
A transfer error does not abandon the live job: it is logged, monitoring
continues, and the result record carries it as `warning`, shown in the
schedule's history.

Launch: the launcher call has its own 30 s bound (`LAUNCH_TIMEOUT_MS`),
independent of the run limit, and so does the wait for the job's identity. The
job id comes from `parseDispatchOutput` and errors from `stripShellNoise`.
Destructive cleanup needs a job id the launcher printed. When none is printed
the run fails with the cleanup diagnostic `unresolved launch: no job id in the
output of claude --bg; no job was stopped or removed`, logged as a warning. No
job is inferred: a name, cwd and creation-time match does not prove ownership,
since another schedule or the user can start a same-name job in that cwd during
the call (re-review R1 of #1233), and any scan bound can hide a second match.

The launcher acknowledgement does not complete a run. A synthetic lifetime emits
exit only after state monitoring and cleanup; trackScheduleRun stores kind bg and
jobId, so the existing resume guard returns attach even before the descriptor is
published. It has no pid, so the delete guard names none. The in-flight key
stays held until onDone. Catch-up claims and skipMissedRuns remain unchanged.
Agents discovers the daemon's regular job files.

Terminal states, read through `parseJobState`: done/failed with lastTerminalAt
(or updatedAt if absent) strictly after launch end the run as `exited` 0/1;
stale done and firstTerminalAt alone do not count. `stopped` ends it as
`stopped` (fresh timestamp, or none at all) and is removed without a second
stop. state.json missing on two consecutive polls ends it as `job-missing` with
nothing to clean. The limit ends it as `timed-out`. Polling is 500 ms. stop then
rm are bounded CLI calls; rm runs from the home directory (bg-agents rule);
failed stop prevents rm. Own active attach PTYs and other live non-bg
descriptors prevent cleanup and yield "left running, joined". Cleanup errors
are retained in history. The attachment check and daemon stop cannot be atomic.
Every background outcome, launch failures included, goes through
`reportRunExit` with its `outcome`, so the notice says timed out, stopped, lost
its job or failed to start rather than an exit code.

Restart: once identity is known, `{ jobId, actualId, cwd, name, filePath, slug,
manual, dueMs, startedAtMs, deadline, phase }` is written to
`<data>/schedule-state/background/<jobId>.json` (the catch-up reader ignores the
subdirectory). The record moves through three phases and is deleted only at the
end of the last:

- `running`: the job is watched. When it ends, its outcome is saved as
  `result` with the cleanup mode, and the record moves to `cleanup`.
- `cleanup`: stop/rm against the saved job. The attachment check and the
  job's current state.json are read before the stop and read again before the
  rm, after the stop returned (re-review F4 of #1233: a slot whose short id was
  taken by another session during the stop used to be removed). The
  state.json must carry the saved `actualId`: a missing state.json means the
  job is gone (done), another session id is recorded as `unresolved: job … now
  belongs to session …; nothing was stopped or removed` (or `it was stopped but
  nothing was removed` after the stop; done, no rm), and an unreadable state
  defers. Two local reads narrow the window but are not atomic with the
  daemon's verbs: only a conditional daemon operation would close it. A failed or deferred
  attempt keeps the record with `cleanupAttempts`; a process makes at most 3
  attempts, `retryMs` (30 s) apart, and the next start continues. After a
  successful stop the mode becomes `rm`, so a retry does not stop twice. After
  9 attempts in all the run is recorded with `cleanup abandoned after 9
  attempts: …`. A joined user takes the job over and ends the phase. The
  outcome is never recomputed: a resumed `cleanup` record is not watched again.
- `result`: `publishScheduleRunResult` returns `{ ok: true }` only for a
  durable result: this writer's own completed publication, or a valid result
  file already present (first result wins). Anything else returns
  `{ ok: false, error: { path, code, message, at } }`; `writeScheduleRunResult`
  is the boolean form. Publication writes the full record to a unique
  same-directory temp file (`wx`, fsync), then `fs.linkSync(tmp, destination)`,
  which fails with `EEXIST` instead of replacing an existing file (atomic on
  NTFS and POSIX filesystems), then removes the temp file. A destination
  published this way is never partial, so there is no lock and no repair
  (re-review F2 and F4 of #1233: a stealable publication lock and an automatic
  repair that moved an invalid destination aside could delete or replace a
  result another writer had already acknowledged). On `EEXIST` a valid
  destination is acknowledged; an invalid one (external corruption, an older
  version) is never moved, renamed or
  deleted: the writer returns the error `The result file <path> is unreadable;
  remove or fix it` (code `EBADRESULT`). A link that fails with `ENOTSUP`,
  `EISDIR` (libuv's mapping of `ERROR_INVALID_FUNCTION`, FAT/exFAT on
  Windows), `EXDEV`, `EINVAL` or `ENOSYS` means the store has no hard links:
  the writer returns that code with `This drive does not support hard links;
  schedule results cannot be recorded safely here. Move the Switchboard data
  directory to an NTFS or ext4 drive.` and creates no destination. `EPERM`,
  `EACCES` and `EBUSY` are access denials or locks, not a drive limitation
  (sixth re-review F2 of #1233): the message is `Access was denied while
  recording the result (<code>: <original message>). Check the permissions of
  <dir> or whether another program holds it; Switchboard retries.` Both keep
  the original error text in `error.detail`. There is no
  fallback (fifth re-review F1 of #1233: an exclusive-create
  fallback let a second writer acknowledge bytes whose writer then failed its
  fsync and removed them); a background run keeps its record in `result`, so
  nothing is lost once the data directory moves. Any other failure returns the
  error. Failures are kept unresolved by key: the destination once it is
  named; before that, the run identity (`jobId`, `sessionId`, schedule file and
  `startedAtMs`, as given) when the identity itself is rejected; and the
  results directory only when it cannot be created. A successful publication
  clears its own destination and its own run identity; the directory key is
  cleared only by a successful link in that directory (sixth re-review F1 of
  #1233: a failure with no destination used to be keyed by directory, so any
  other run's success erased it while its record stayed pending).
  `latestResultFailure()` returns the most recent unresolved failure with
  `count`, the number still unresolved, or `null`; listeners
  (`onResultFailureChange`) are called on each change. A failure is logged once
  per destination and message. Lock files left by older versions are ignored and pruned like
  stale temp files.
  The main callback returns that result. The record is deleted only on
  `ok`, otherwise kept in `result` for the next start, which publishes it
  without cleaning again; the settled details carry `resultPending` and
  `persistenceError`, the report sent through `reportRunExit` carries
  `persistenceError` (sent even for a code-zero exit), and the warning is
  logged once per job and distinct error. The headless launcher's
  `recordResult` returns the error message and its exit report carries it the
  same way.

The result is published after cleanup settles, so a run whose cleanup is still
pending has no history entry yet. A launch-time failure without a confirmed
session id (identity never appeared) gets its bounded in-process retries but no
record: a record without the full saved identity could not be confirmed at the
next start. A launch interrupted before identity is not recorded either.

Resume is two phases. `discoverBackgroundRuns` reads at most 256 record names,
validates each and calls `claim` for at most 64 valid ones; `resumeBackgroundRuns`
returns the promise of all lifetimes with a `discovered` promise attached.
`startScheduler` returns at once, but holds every automatic check (startup
catch-up, wake-up and minute ticks, for all schedules) until some discovery's
`discovered` settles, never behind the lifetimes (re-review R2 of #1233: the
startup catch-up used to beat the record reads). Checks requested during the
hold are coalesced into one check when it ends, run as a tick if any was a
tick. A tick-only schedule whose minute passed during the hold is skipped;
catch-up schedules catch up. When discovery has not settled after
`DISCOVERY_WAIT_MS` (10 s), the hold is kept, a warning names the unresolved
recovery, and discovery is started again, the wait doubling up to
`DISCOVERY_RETRY_MAX_MS` (5 min) (re-review F1 of #1233: the bound used to
release scheduling before a slow scan had claimed a still-working run, so a
second run launched beside it). All attempts share one claim: a job id claimed
once is refused (`claim` returns `false`) to every later attempt, so a stalled
scan that finally completes never supervises a run twice. Records are known
once any attempt resolves, since every record an attempt read is claimed at
read time. Only a complete scan resolves: a missing records directory
(`ENOENT`) counts as an empty store, and a record removed between the listing
and its read is skipped. Any other error on the directory or on a record read
(`EACCES`, `EIO`, …) rejects `discovered` after the scan has claimed and started
supervising every record it could read; the hold is kept, the error logged,
and the retry timer runs again with the same backoff (re-review F1 of #1233: a
read error used to count as an empty store, release the hold and launch beside
a still-working run). A store that keeps failing keeps automatic launches held;
Run now is not held. A rejection is logged once per distinct message, and a
stall once until it is resolved or turns into a rejection.

Suspension is visible (re-review F1 of #1233: an unreadable store used to stop
every automatic schedule with only log lines). `stop.getHealth()` returns
`{ suspended: false }`, or `{ suspended: true, reason, path, code, message,
since, retryMs }` with `reason` `unreadable` (a rejection; `path` is the
directory or record that failed, filled in by `discoverBackgroundRuns` when the
error has none) or `slow` (the wait expired with no answer). `onHealthChange`
is called on every change and on each rejection; the suspension clears only
when a discovery resolves. Main composes `scheduleHealth()` = scheduler health
plus `resultFailure` (`latestResultFailure()`) plus `revision`, a counter
incremented for every snapshot, passes it to `buildScheduleList` as
`schedulerHealth` (the listing returns it as `health`), serves it on
`get-schedule-health`, and pushes it on `schedule-health` when either part
changes. The renderer applies a snapshot only if its revision is not older
than the one it last applied, so a startup reply or a list reply computed
before a push cannot erase it (fifth re-review F3 of #1233); the tab's banner
and paused rows use the applied health, not the reply's. See
[ipc-bridge.md](ipc-bridge.md), "Schedules", for the channel contract. The renderer (`public/schedules-view.js`) shows an
app-level error notice for each part (ids `ScheduleSuspended`,
`ScheduleResultFailure`), shown whether or not the Schedules tab is enabled
and replaced only when the text changes; the tab also shows a banner with the
same text and states each next run as `Paused: automatic launches are
suspended (next run due …)`. A resume source without `discovered` (test stubs claiming
synchronously) does not gate. Claims are counted per schedule key, so several
resumed runs of one slug hold it until the last ends. Manual runs are not held.

Validation before any claim: `v: 1`, an 8-hex `jobId` matching the file name,
a full UUID `actualId` starting with it, non-empty cwd, name, filePath and slug,
`startedAtMs` after 2024 and at most a day ahead, a deadline after the start
and at most a day after it, a known phase and cleanup mode, and a saved
`result` outside `running`. A record that parses but fails, or does not parse,
is renamed to `<jobId>.json.corrupt-<ms>` so it leaves the batch for good; a
read error leaves it in place and keeps the hold (above). During a resumed watch, a state.json naming
another session ends the run as `job-missing` with nothing to clean, so the
deadline never authorizes a stop of a job whose identity does not match.
A run past its deadline times out at once. A resumed run reports no
ActivityWatch span.

Create disables remote/sandbox selection and the backend refuses sandbox opt-in
creation. Existing saved files still fall back.
Tests: schedule-background (main extraction with the real module and disposable
job files), schedule-background-recovery (launch without id, discovery gate,
cleanup and result phases, record validation), schedule-catch-up, run-schedule-now-result, dom-schedule-create,
schedule-create-file, schedule-run-results and dom-schedule-run-exit; all use
injected CLI boundaries.

Project launch admission is shared with terminal, background and remote launches;
see [project-operation-gate.md](project-operation-gate.md). Scheduler admission
precedes catch-up claims and transcript creation. Run now holds its reservation
until the spawn acknowledgement settles.

Main-process modules live in `src/main/schedules/` (ADR 0005, step 8):
`schedule-runner.js`, `schedule-ipc.js`, `schedule-run-results.js`, `schedule-list.js`,
`schedule-delete-file.js` and `run-schedule-now-target.js` are siblings.
Their project and home based schedule paths remain unchanged. The Run now VM
test uses a module-specific loader and checks eager and lazy stub consumption.

**Purpose**: in-process cron that fires user-defined Claude tasks on a schedule. Stores schedules as Markdown files with YAML frontmatter inside each project's `.claude/commands/schedule-*.md`. Spawns `claude --resume <sid> -p "..."` as a headless child process (no PTY, no `detached` option; see "Launch invariants") when the cron expression matches.

## Test home isolation

The runner captures `os.homedir()` at module load. Tests that can create schedule
transcripts use `test/fixtures/isolated-home.cjs`: construct `isolatedHome(t)`
and call its `install()` before requiring the runner, including indirect imports
through `archived-projects`. Installation sets both `HOME` and `USERPROFILE` and
evicts the runner's require cache so a previous import cannot retain another
home. The after hook checks expected disposable project folders and rejects
only real-home folders belonging to fired projects or the fixtures' temporary
root prefixes. Exact checks include resolved paths and legacy unbounded encoded
names; unrelated CLI folder creation or deletion is allowed. The original
directory is only listed; its files are never read or changed. The hook restores
the environment and cache and removes the disposable home even on failure.
`SWITCHBOARD_TEST_REAL_HOME` points this guard at a fake real home for leak and
concurrent-writer tests. Nothing sets this variable in normal runs.
The prefix rule is strict on purpose: a leftover folder from an older, leaking
run fails every local run until it is moved out of the real projects directory
by hand. The failure names the folder.
Catch-up callbacks only record fired projects; assertions run in the file-level
after hook, outside the scheduler's launch-error catch.

The re-enable and catch-up tests fire the shipped scheduler; the Archive VM
uses the same disposable home. Run now stubs transcript creation and expects
no project folders. The provenance test runs in a separate Electron process
and is excluded from Node-only local verification. The slug-group DOM fixture
and `fixtures/browser-mode.cjs` simulate schedule data without loading a writer.

## Key files

| File | LOC | Role |
|---|---|---|
| `src/main/schedules/schedule-runner.js` | ~900 | The cron loop, cron parser, file scanner and lister, catch-up record, session pre-seeder, command builder, schedule file creation and enable/disable rewrite. |
| `src/main/schedules/schedule-ipc.js` | ~265 | IPC handlers + the inline `SCHEDULE_CREATOR_TEMPLATE` (an embedded Claude command that teaches Claude how to write schedule files). |
| `src/main/schedules/schedule-run-results.js` | ~130 | Run-result persistence, read-only lookup, pruning and the shared exit classifier. |
| `src/main/schedules/schedule-list.js` | ~80 | `buildScheduleList`, the Electron-free backend of `list-schedules`. |
| `src/main/schedules/schedule-delete-file.js` | ~35 | `deleteScheduleFile` / `deleteListedScheduleFile`, behind `delete-schedule-file`. |
| `src/main/schedules/run-schedule-now-target.js` | ~60 | `resolveRunNowTarget`, the Run now file/cwd resolution. |

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
- `skipMissedRuns(log, projects, stateDir, lastTickMinute = null)` — see the Project Archive item under "Launch invariants" below.
- `parseFrontmatter(content)`, `cronMatches(cronExpr, now)` — utilities, exported for tests.
- `scheduleFileUnlinked(projectRoot, filePath, realpath)` and `setScheduleEnabled(filePath, enabled, { projectRoot, rewrite })` — see [Disabling a schedule file](#disabling-a-schedule-file).

From `schedule-ipc.js`:

- `init(log, runScheduleCommand, isPathAllowed, isProjectArchived)` — wire IPC handlers (`get-schedule-creator-command`, `create-schedule-session`, `run-schedule-now`).
- `ensureScheduleCreatorCommand()` — on app start, write `SCHEDULE_CREATOR_TEMPLATE` to `~/.claude/commands/create-switchboard-schedule.md` when missing, or replace it when its bytes match a known shipped template (see "Schedule creation").

`main.js`'s shared `runScheduleCommand` returns `{ok:false, error}` when the
project is archived, a sandbox cannot run on this platform, sandbox add-dirs
are refused, or shell spawn fails. Each reason includes a recovery step. It
returns `{ok:true}` only on the child's `spawn` event; synchronous throws and
the pre-spawn `error` event are failures. `run-schedule-now` awaits and checks
that acknowledgement, treating a missing result as failure. Cron uses the same
launcher and retains its logging and completion callback. The safe Claude argv
is quoted for the configured login shell so its profile can initialise PATH.
Sandbox resolution follows global and project settings and never downgrades
silently; schedule add-dirs supply both CLI flags and sandbox binds. On Windows
a cmd.exe or PowerShell profile is not started at all (see "Windows launches").

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

`run-schedule-now` is a request/reply that has already acknowledged spawn and is
never invoked by cron, so asynchronous completion travels on its own event, sent
from the schedule IPC module and exposed as `onScheduleRunExit` in preload. `public/memory-workfiles-view.js` subscribes once
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
The registry is seeded before any session can run, so a sandboxed one cannot plant into the seed.
Main awaits `scheduleProjects().list()` before starting the scheduler and trigger
watcher, including when the bounded deletion-holds wait fails or times out.
Path comparisons share `normalizeProjectPath` in `src/main/shared/normalize-project-path.js`
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
session id, newest first, at most 20 per schedule, together with the
rows the history import attributed to it (see "Imported history"). For these rows only, the
listing streams the transcript until its first assistant record; both
`type: assistant` and `type: message, role: assistant` count. A second user
record never proves a reply. Unreadable transcripts give `replied: null`;
readable transcripts without an assistant give `false`. The cache is not
modified. `cliSessionState.isScheduleRunLive(sessionId)` reads the launcher's
in-memory map without probing processes; `running` uses that export for cron
and manual runs. `result` comes from the instance's persistent record (see
"Run results"), `null` when none exists.

Regressions: `schedule-next-run.test.js`,
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
  This is the archive/catch-up contract referenced by `skipMissedRuns`.
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
- **Headless child process** — spawned through the configured shell profile (or, on Windows under cmd.exe and PowerShell, as the resolved `claude` itself; see "Windows launches") with `stdio: ['ignore', 'ignore', 'pipe']`, no PTY and no `detached` option. Stderr is captured for logging; stdout is dropped. The read-only message view follows transcript writes through the existing watcher.
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

## Windows launches (#1107)

Custom arguments (#1202) retain this direct resolver even when nonempty.
For Windows cmd/PowerShell schedules, `splitHeadlessCustomArgs` splits whitespace
outside single/double quotes, preserves empty quoted arguments and literal
backslashes, and decodes doubled matching quotes inside quoted text. Unclosed
quotes refuse the launch. Variables, operators and backticks stay literal;
the parser never evaluates shell syntax. The resulting tokens follow generated
argv in `resolveWindowsClaude`. Other profiles append the validated text as
typed to their shell command. `customArgsForLaunch` is imported at module scope
in main; schedule extraction fixtures supply that real helper explicitly.

`runScheduleCommand` plans the child with `headlessClaudeLaunch(shell, argv,
{ env, profileArgs })` (`src/main/terminals/shell-profiles.js`), which returns
`{ program, args, verbatim }` or `{ error }`. Under a bash, zsh, fish, nushell
or WSL profile, and everywhere off Windows, the plan is the shell as before:
`shellArgs(shell, 'claude ' + quoteArgvForShell(shell, argv), profileArgs)`, so
the login profile can initialise `PATH`. Under cmd.exe, Windows PowerShell or
PowerShell 7 on Windows the shell is not started: the plan is
`resolveWindowsClaude(argv, env)` from `claude-binary.js`, the same resolver the
background-agent commands use (see `bg-agents.md`, "Running the CLI") — a native
`claude.exe` runs directly, an npm `claude.cmd` shim is unwrapped to `node
<cli.js>` or its declared native target, an opaque shim goes through
`cmd.exe /d /s /c` with escaped arguments. The npm target comes from one whole
invocation line the resolver understands (`SHIM_INVOCATION` in
`claude-binary.js`; see `bg-agents.md`, "Running the CLI"): optionally npm's
`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% &` trailer (with its
cmd-shim 9.0.2 `set PATHEXT=... &` addition), a stock Node spelling without
options, or none for a `.exe` target, the quoted `%dp0%` (cmd-shim 4.1.0 and
later, npm 7.24 to 11) or `%~dp0` (the cmd-shim template: pnpm, yarn classic,
npm 6) path, `%*`, and nothing else; not the earlier `node.exe` existence probe.
A shim whose line carries anything more (an interpreter option, another command
in the trailer, for instance) is opaque and runs as written through `cmd.exe`.
For native executables and recognised npm targets, argv never crosses a shell,
so multiline and long prompts, quotes, trailing backslashes, `&`, `%PATH%`
and an empty argument reach claude as given. Before this, PowerShell re-serialized
`claude '<token>'...` for the native command and lost quotes and boundaries
(`say "hi" a" b\` arrived as two arguments; an `--add-dir` ending in `\` absorbed
the following option), and cmd.exe received the `/C` string through libuv's own
quoting, which cmd does not parse. The sandbox wrapper (Linux only) replaces the
plan with the shell form, after the platform refusal.

An `{ error }` plan (no `claude` on `PATH` in `cleanPtyEnv`, or a multi-line
argument for an opaque shim) is a `spawn-error` run result and a `{ ok: false,
error }` return with the usual recovery sentence; the completion callback runs and
the shell is not started. The resolver honours `PATHEXT` only, so a `claude.ps1`
alone on `PATH` is "not found": npm always installs the `.cmd` beside it. A
PowerShell profile that adds `claude` to `PATH` is not consulted, as for the
background-agent commands. The planned program and arguments are what the log's
`Running:` line shows.

Qualification: `test/headless-claude-launch.test.js` pins the plan per shell with
injected filesystem probes; `test/schedule-launch-windows.test.js` (Windows only,
the `windows-2022` leg) runs the extracted `runScheduleCommand` with the real
`child_process.spawn` under `powershell.exe`, `pwsh.exe` when installed and
`cmd.exe`, into an argv-recording `claude.exe`, an opaque `claude.cmd` (its Node
spelled as an absolute path, so it runs through `cmd.exe`) and an npm layout
(the stock npm shim with its title trailer, unwrapped) with `claude.ps1` beside it, and compares the argv claude
received, including the quote, backslash, `%PATH%` and empty-argument cases.

## If you change this, also check

- `public/dialogs.js` (`launchScheduleCreator`) — UI entry point for the schedule creator flow
- `public/schedules-view.js` — lists schedules, runs them, toggles enabled and opens their file; `memory-workfiles-view.js` keeps the independent exit-notice subscription
- `file-lists.js` — marks runner schedule names among project commands with `schedule: true` (`isRunnerScheduleFileName`); `memory-workfiles-view.js` hides them from Agent Files only when the Schedules tab is on (see "Schedules tab")
- `public/sidebar.js` — `.project-schedule-btn` clock icon wiring per project
- `archived-projects.js` (`archivePlanForGroups`) and `test/schedule-disable.test.js` — if you change `parseFrontmatter`, the rewrite in `setScheduleEnabled` follows the same state machine
- `schedule-ipc.js` `SCHEDULE_CREATOR_TEMPLATE` — if you change the schedule file format, update the template's instructions
- `main.js` (wherever `startScheduler(log, runScheduleCommand, { resumeSource: powerMonitor, stateDir, projects })` is invoked at app boot, after `scheduleIpc.init`)
- The `runScheduleCommand` factory in `main.js` — uses `child_process.spawn`, `cleanPtyEnv`, and the global shell profile through `headlessClaudeLaunch` (no shell under cmd.exe or PowerShell on Windows). Schedules don't get their own shell selector.

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

### Unreadable definitions (#1237)

A schedule file whose read fails with anything but `ENOENT` stays listed by
`file` and `filePath` with `readError: { code, message }`, a
`could not read the file (<code>)` problem, `name` set to the file name, and `null` for
the metadata only its bytes could give: `slug`, `enabled`, `cron`,
`cronText`, `prompt`, `cli`, `catchUp`, `nextRunMs`, `catchUpDueMs`. Its `runs`
are empty (no slug to match) and it takes no part in the shared-slug check.
`ENOENT` between enumeration and read is a deletion race and the file is
omitted. A commands directory read failure other than `ENOENT` reaches
`buildScheduleList` through the `onScanError(projectPath, error)` option and
becomes the project's `scanError: { code, message }` (otherwise `null`); an
absent directory is an ordinary empty project. Listing still writes nothing.
`setListedScheduleEnabled` refuses a `readError` row; `deleteListedScheduleFile`
keeps its exact-listed-path and link checks, so an unreadable file can be
deleted after the usual confirmation.

Tests: `test/schedule-list.test.js` (real disposable schedule, state and transcript
files, main handler extracted into a VM with filename attribution; counts
PROJECTS_DIR scans; EACCES/ENOENT read and readdir failures injected on
`fs`), `test/schedule-next-run.test.js` (descriptions and DST).


## Schedule creation (#792, slice C)

The optional tab offers Create schedule even when the registry projects have
no schedules. The modal uses `registerModal`, labelled native controls and
`PERMISSION_MODES`; Default is labelled Default (auto) and omits the CLI key.
Project receives focus; Tab is trapped, Escape cancels, textarea Enter stays
native, and only the focused Create button submits from the keyboard. Pending
submission disables controls and blocks cancellation; errors from main are
shown at their named field with `aria-invalid` and focus. Other failures stay
in the form and focus Create for retry. Success closes, refreshes the list
and focuses Create schedule.

`create-schedule-file` calls the Electron-free `createScheduleFile` export in
`schedule-runner.js`. It awaits the registry, canonicalizes spelling with
`normalizeProjectPath`, rejects archived projects and calls the same
`scheduleLaunchRefusal` as the launcher (A1 consolidated the sandbox checks
there). A sandbox platform refusal targets Project because the form has no
sandbox control; refused binds target add-dirs. Non-sandboxed add-dirs are not
judged. Scalars are single-line,
slug is at most 64 lowercase kebab-case characters, cron must be able to match,
budget must be non-negative decimal, and prompt must contain text. Add-dirs
arrive as an array of paths without commas and serialize as a comma list.
Permission mode, allowed tools, model, budget and appended system prompt are
optional. Enabled defaults on; catch-up defaults off. LF serialization must
round trip through `parseFrontmatter` and `buildScheduleCommand` before mkdir.

The target must not share an effective slug with another listed schedule.
After mkdir, the commands directory realpath must equal the real project root
plus `.claude/commands`. A same-directory exclusive temp is linked to the
destination, never renamed: a concurrent winner is preserved. EEXIST is a
slug error; EPERM, ENOTSUP and ENOSYS from link target Project with a plain
filesystem message retaining the error code. Temp files are
unlinked in finally. The new key's stale catch-up and run-result records are
pruned; transcripts are preserved. After publication, cleanup errors are logged
and creation still returns success with the file path, so retry is unnecessary.
Tests preserve a second schedule's correctly shaped state and result files.
Main injects this instance's state paths.

`ensureScheduleCreatorCommand` hashes installed bytes as a Buffer. Missing
commands are exclusively created. lstat leaves symlinks (including dangling
links) and every other non-regular file untouched. Known historical hashes are replaced with
the new template through a same-directory temp and `renameWithRetry`. Current
bytes need no write. Edited, BOM, CRLF or unreadable files remain unchanged;
the decision is logged. The four historical templates live in
`test/fixtures/schedule-creator`, extracted from their original git commits;
`schedule-creator-template.test.js` pins all four hashes and the current template
SHA-256, `eb28b0b4d916fb22e7b1f3a84d2aa2852436c311ebbc873587a332d3da5950d7`.
Future edits append the replaced template's hash to
`SHIPPED_CREATOR_TEMPLATE_SHA256` and update the current pin; the assertion
failure explains both steps. Every Schedules tab mention in the template and
welcome text names Global Settings → Schedules tab, because the setting can
still turn the tab off (#1239).

Coverage: `schedule-create-file.test.js`, `schedule-creator-template.test.js`
and `dom-schedule-create.test.js` load shipped code with require or filename-tagged
VM evaluation; creator tests use disposable homes and stub Electron.

## Schedules tab (#792, slice A2)

Global Settings → **Schedules tab** persists `global.schedulesTab`, defaulting
to `SETTING_DEFAULTS.schedulesTab` (true since #1239). Only renderer surfaces are gated.
The startup settings restore and Settings Save call `_applySchedulesTab`:
hidden/disabled clock tab with tabindex -1 when off, no programmatic route,
and a return to Sessions when the active tab is disabled. `index.html` ships
the tab hidden and `window.schedulesTabEnabled` starts at the default, so
`_applySchedulesTab` writes the tab's hidden, disabled and tabindex on every
call; otherwise the first apply of the default would leave the tab hidden. Only
an effective value change reloads Agent Files if open, cancels schedule
refreshes and refreshes sidebar notices.

Every global Save since #792 has written the checkbox state, so a stored
`false` from before #1239 is not an opt-out. On the first launch of 0.1.0,
`src/main/schedules/schedules-tab-migration.js` runs once in the writer worker
(`migrateSchedulesTabDefault`, started in `main.js` right after
`INSTALL_PREDATES_LAUNCH` is read and before any window exists). Startup waits
for it through `migrateSchedulesTabWithinBound`, at most `STARTUP_WAIT_MS`
(2000 ms): a writer command's 30 s timeout is armed only once the worker
reports it started, and a queued command has no admission deadline, so a
stalled writer could otherwise hold the first window for 30 s or more. Within the bound the first render reads the result. Past it,
main logs a warning, creates the window, and lets the migration finish in the
background; if it then returns `turned-on`, main sends `schedules-tab-migrated`
(preload `onSchedulesTabMigrated`). The renderer registers that listener at the
top of its settings-restore block, before its first `get-setting`, and on the
event re-reads `global` and calls `_applySchedulesTab`, so the tab appears
without a restart. An open global Settings form is reconciled through
`_syncUntouchedGlobalToggle`: the Schedules checkbox takes the re-read value
only if the user has not changed it since the form opened or was last saved
(any `change` event counts, even one back to the initial value), and its
baseline moves with it so it is not reported unsaved; an edited off is kept.
Global Save sends `schedulesTab` only when that checkbox had a `change` event
since the form opened or was last saved (a change back to off counts), so an
untouched Save submitted before the migration commits cannot write the stale
off. When the field was not sent, Save re-reads `global` after the write is
acknowledged and applies the stored effective value to the tab and, unless the
checkbox was edited while the Save was in flight, to the checkbox and its
baseline. Each `change` event stamps the control with a new edit generation;
Save records the generations it submitted, and its acknowledgement clears a
control's edited mark only if no newer change happened meanwhile, so a toggle
flipped again during the Save stays edited and the next Save sends it. Only the
Schedules field depends on this mark; every other global field is always sent. Invokes resolve in order, so a stale first read always
applies before the event's fresh one; an event sent before the page loaded is
lost, but the page's first read then already sees the committed value. A late
`marked` or `none` changes nothing visible and sends nothing. Without the
`schedulesTabDefaultMigrated` marker it deletes a stored `schedulesTab: false`,
so the default applies, and writes the marker in the same `global` write; a
missing `global` gets `{ schedulesTabDefaultMigrated: true }`, so a fresh
profile that turns the tab off later is not migrated at its next launch. A
non-object `global` is left alone. With the marker present it does nothing, and
renderer Saves merge into the stored object inside the writer
(`merge-global-settings`, writer command `mergeGlobal`), so a Save queued while
the migration is pending cannot drop the marker it committed, and a `false`
saved after the update is honoured at the next launch. The working-set persist
writes only `openWorkingSet` through the same merge, so a snapshot it would have
read before the migration cannot bring back the old off. A failed write is logged, leaves
`global` unchanged and does not stop startup; the next launch retries. The
marker is written by main only, never by Settings Save, so a failed migration
followed by a Save of the stale off state is still migrated. The setting and the Agent Files fallback stay for one release; their
removal is deferred (#1239). Startup applies it after restoring sidebar width and shortcuts,
so a tab failure cannot interrupt their restore. Global Save's separate sidebar
refresh runs only when visible count, maximum age or remote hosts changed (an SDK
visibility change still reloads projects).
`file-lists.js` always supplies project command schedules, marked `schedule`;
Agent Files filters those entries only when the tab is on. With the tab off,
only entries marked `schedule` get the schedule icon and Run now, so a
`schedule-*.md` outside a project's `.claude/commands` stays an ordinary file. Its file search
index keeps them available so switching requires no reindex. With the tab off,
the prior schedule icon, Run now and editor are restored. Archive choices,
Undo, re-enable offers and recovery hints use their pre-A2 names and Agent
Files wording; when on they retain the A2 counts and Schedules links.
No main-side scheduler, IPC, result persistence or re-enable skip is gated.

`public/schedules-view.js` consumes `list-schedules` on open, after Open, after
Run now/toggle/Delete while visible, on relevant projects-changed events (900 ms debounce, 3000 ms maximum
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
Agent Files. Search is hidden. Rows show cron, local
next-run and relative time, disabled/archive/validation reasons, shared-slug
diagnostics, catch-up status and the newest 20 runs from the main-side list.
Run now retains `RunSchedule:<filePath>` and the persistent error contract;
exit notices still subscribe once from memory-workfiles-view.js. Every scheduled-run
exit, including success, queues the same visible-tab reload before displaying any
failure notice. Open checks a
nonempty read-memory response before opening memoryPanel.

Load states (#1237): before the first successful listing the tab shows
`Loading schedules…`. A failed load keeps the `listSchedules` notice (its
Retry action opens the tab and retries) and shows a `.schedule-load-error`
alert with a Retry button in the tab: alone on a first load, or above the
last successful rows, labelled with their load time, after a refresh failure.
`retrySchedules` is single-flight: it returns the in-flight load and disables
every Retry button. The request counter still discards older and hidden-tab
responses. Success clears the notice and the local error. With no registry
project the tab says to add a local project from Sessions; with only archived
projects, to unarchive one in Settings → Archived; either message is the
disabled Create button's title and description. `No schedules found. Use
Create schedule to add one.` appears only when a project can take a schedule
and no project has a `scanError`. A `scanError` project keeps its group with
the error, a permission/path hint and Retry. A `readError` row shows
`Schedule unknown`, `Unknown: the file could not be read`, the hint and Retry;
Run now, Turn on/off, Open and Show history in Sessions are disabled, Delete
is not. History resolves a
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

## Delete a schedule (#792, slice B)

The Schedules tab offers Delete beside Open. It awaits a danger `appConfirm`
naming the file and saying past runs stay in Sessions. The action stays disabled
while the question or IPC is pending, including across a refresh; failures keep
a persistent `DeleteSchedule:<filePath>` notice with the file, reason and retry.
Linked files show `linked file: edit it at its source` and cannot be deleted.
Disabled, malformed and unknown-project schedules can still be deleted.

Main registers `delete-schedule-file` and supplies this instance's `schedule-state`
and `scheduleRunsDir(dirname(DB_PATH))`. `deleteListedScheduleFile` refreshes the
registry and requires exact equality with a `listScheduleFiles` path. The separate
`deleteScheduleFile(filePath, { projectRoot, stateDir, runsDir })` export has no IPC,
window or registry dependency, so project-folder deletion (#474) can reuse it.
It rechecks `scheduleFileUnlinked`, removes that key's catch-up claims via
`readScheduleStateOnly`, unlinks the listed path, then calls the existing
`pruneScheduleRunResults(runsDir, key, 0)`. A claim unlink failure other than
ENOENT returns the error with the schedule file and run results still present,
so the row stays available for retry. A schedule-file unlink failure also
returns the error and keeps run results; the removed claims can cost at most
one catch-up. Run-result pruning errors stay ignored. Missing record directories
are not created. Other keys, transcripts and Sessions grouping remain intact. A file
recreated at the same path inherits no retained catch-up or run-result records.
Publication debris follows D's existing ten-minute stale-file policy; a running
child is not stopped by deleting its schedule.

Delete is a native button in the existing `.schedule-actions` keyboard inventory:
Tab reaches it, Enter/Space activates it, and `:has(:focus-visible)` reveals the
action container. If a refresh removes the focused row after deletion, focus
moves to the same control in the next row, otherwise the previous row, otherwise
the list container (`tabIndex=-1`). The shared confirmation focuses Cancel and
owns Escape and the modal Tab loop. Tests: `test/schedule-delete-file.test.js` and
`test/dom-schedules-tab.test.js`; the existing `test/keyboard-focus-css.test.js`
covers the shared action container.

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

Publication is the temp file plus no-overwrite hard link described under
`result` above; a store without hard links records nothing and reports it; an
existing final file is kept, and an invalid one is reported, never
replaced. The temp file is removed on success and on failure. A process killed
during publication can leave a temp file; readers ignore it. Per-key pruning
removes that key's temp files, and lock files left by older versions, whose
mtime is older than ten minutes, retaining recent artifacts, unrelated names
and other keys.
After a write, pruning keeps the 20 newest starts of that key and ignores
unlink errors. `pruneScheduleRunResults(dir, key, 0)` also serves schedule
deletion (see "Delete a schedule"). Other keys and transcripts are untouched; renamed files can
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
quits, older runs and runs from another instance have no result here.
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

Top-level focus (#1238): the controls outside rows carry a `data-schedule-control`
identity too: Create schedule (`schedule-create-btn`), the load-error Retry and
each project's scan-error Retry (`schedule-retry-btn`, told apart by the
enclosing `.schedule-project` path, none for the load error). A render, and a
failed reload's `renderSchedulesLoadError`, read the focused identity first
(`scheduleTopFocus`) and refocus its replacement (`restoreScheduleTopFocus`).
A focused Retry that no longer exists after the render hands focus to Create,
or to the list container when Create is disabled. Retry disables every Retry
button while its load is in flight: a focused top-level Retry first moves
focus to the list container and becomes `schedulesPendingTopFocus`, a focused
row Retry hands focus to its row through `focusScheduleControl`. The pending
target applies only while the container still has focus, so focus moved
elsewhere during the request stays there. A failed reload re-enables the Retry
buttons it keeps and restores both pending targets, the row one through
`restorePendingScheduleFocus` (only while focus is still parked on that row).
When a render keeps the row but not its focused control (a recovered row loses
its Retry), `focusScheduleControl` falls back to the row's first enabled action,
then to Create, then to the list container. Hiding the tab clears the pending target. Nothing here
touches focus outside `#schedules-content`, so the create form keeps its
fields and focus across background refreshes, and closing it focuses the
current Create button.

Sizes (#1238): every button of the tab uses the shared `.settings-action-btn`
class, scoped in `#schedules-content` to a smaller padding, `max-width: 100%`
and wrapping text. `.schedule-actions` wraps, and `#schedules-content` sets
`overflow-wrap: anywhere` so long paths, names and refusals break inside the
sidebar. Keyboard focus keeps the global `button:focus-visible` outline.
`e2e/schedules.spec.js` checks the supported sidebar widths (200, 340 and
600 px) in both themes, at 800x500 and 1400x900, at 100% and 150% zoom, with a
stubbed `list-schedules` fixture, and checks focus across refreshes and the
create form's reach in the small zoomed window; see `docs/e2e.md`.
Next-run wording uses minutes below an hour, then today's time, tomorrow's time,
a weekday within the following week, or a date for later runs.

History navigation maps the listed run IDs to local indexed project paths, so a
registry alias and its resolved transcript folder expand the same visible group.
Opening a run selects a local indexed row before openSession; remote copies of
the same session ID do not participate in this local Schedules surface.

Open checks read-memory before changing viewers. On a valid read it uses
hideAllViewers before memoryPanel, so a previous transcript viewer
does not cover the schedule editor. The existing save and watch contract stays.

History navigation resolves physical run IDs through `rowSessionIds` in local
merged rows. It passes the full row to `openSession`, preserving the existing
continuation and live-elsewhere resume guards.

## Imported history (#1252)

### What each version left on disk

Established from `git show <sha>:schedule-runner.js` (later
`src/main/schedules/schedule-runner.js`), `createScheduleSession` and
`buildScheduleCommand` of each era. Every era launches `claude --resume <id> -p
...` on a transcript Switchboard seeded itself; the CLI appends its own records
to that same `<id>.jsonl`.

| Era | First release | Seed (line 1 of `<projectsDir>/<folder>/<id>.jsonl`) | Imported? |
|---|---|---|---|
| E0 `f1332a9c` | none: replaced by `546586b3` before the v0.0.25 tag | `file-history-snapshot`, then a CLI-like `user` record (`isSidechain: false`, `userType: external`, `version: '1.0.0'`, `gitBranch: 'main'`, `slug`, `todos`, `permissionMode`) whose content is the bare prompt | No: never shipped in a fork release, and its first message is the bare prompt |
| E1 `546586b3` | v0.0.25 | exactly `{ type: 'user', parentUuid: null, uuid, sessionId, cwd, slug, timestamp, message: { role: 'user', content: 'Scheduled Task: ' + prompt } }` | Yes |
| E2 `14957f88` | v0.0.87 | E1, with the catch-up heading `Scheduled Task (catch-up: due <ISO>, started <timestamp>): ` | Yes, `dueMs` kept |
| E3 `d8ee5d1a` | v0.0.90 | E1/E2 plus `scheduleSlug` | Already listed by the marker |
| E4 `a65ad493` | v0.0.104 | E3, plus a result record under `<dataDir>/schedule-runs` | Already listed, with a result |
| E5 `c0a424ab` | 0.1.0 | background runs: the seed moves to a `schedule-provenance` record | Already listed |

E1/E2 headless runs then carry CLI records (`version`, `userType`,
`isSidechain`, `entrypoint: 'sdk-cli'`, `-p` prompt `Run the scheduled task`).
A session started by hand never has Switchboard's seed on line 1: every CLI
`user` record carries `isSidechain`, `userType`, `version`, `entrypoint` and
more (checked read-only against a local CLI transcript: `cwd, entrypoint,
gitBranch, isSidechain, message, origin, parentUuid, permissionMode, promptId,
promptSource, sessionId, timestamp, turnOrigin, turnPosition, type, userType,
uuid, version`), and its first line is usually a metadata record
(`permission-mode`, `custom-title`, `last-prompt`). The local machine had no
scheduled transcript, so the E1/E2 shapes come from the code, not from data.

Other old records give no per-run history: the catch-up state
(`schedule-state/<key>-<minuteMs>.json`, v0.0.87) keeps only the latest handled
minute per schedule, and `[schedule] Triggering:` log lines are unstructured
and rotated. Results exist only from v0.0.104.

**Reliable attribution** (`seedAttribution` in
`src/main/schedules/schedule-history-import.js`): line 1 parses to an object
with exactly E1's eight keys, `type: 'user'`, `parentUuid: null`, UUID `uuid`,
`sessionId` equal to the file name, a nonempty `slug` naming a current schedule
of the project, an ISO `timestamp` that round-trips, `message` with exactly
`role: 'user'` and a string content starting with an E1 or E2 heading (for E2
the `started` time must equal `timestamp` and `due` must not be later), and an
absolute `cwd` that encodes to the transcript's folder (case-insensitive on
Windows) and equals the registry project's path, literally or after `realpath`
on either side. The folder encoding is lossy (`/work/project-a` and
`/work/project/a` share one folder), so the folder check alone would hand one
seed to two projects. A seed already stored for another project is skipped, so
each seed has one owner. Anything else is not imported. E3 and later rows
already have `scheduleSlug` and are skipped.

### What hid runs before the import

The listing (`buildScheduleList`) took index rows with `scheduleSlug` equal to
the schedule's slug, in the registry path's encoded folder and its realpath's,
newest first, capped at 20. So E1/E2 runs were never listed; marked runs were
hidden only past the 20 newest (by design: Show history in Sessions), after a
slug rename or under a project missing from the registry. Marked runs without a
result (E3, or alive at quit, or another instance) were listed with **No result
recorded**; no transcript record can recover their exit code, so the import
leaves them as they are.

### Design

- **Trigger.** `list-schedules` in `main.js` creates the importer once
  (`scheduleHistory()`) and calls `ensureStarted()` before building the list.
  It returns at once; the listing never awaits the import. Startup does not
  start it. It waits (`state: 'waiting'`) until `isInitialScanComplete()`, so
  a half-built index cannot mark an incomplete import as done.
- **Schedules first.** A project's schedules are listed with `onScanError`. A
  commands-folder read error, or a schedule file with `readError`, fails that
  project; an unreadable inventory is never stored as an empty one.
- **Candidates from the index.** Per registry project, `getCachedByFolder` for
  both folders; rows without `scheduleSlug` or `parentSessionId` whose `slug`
  names a current schedule of the project or whose `firstPrompt` starts with
  `Scheduled Task`. Other rows are never opened, so the cost scales with
  candidates, not with the size of the history.
- **Bounded reads.** `readSeedLine` reads 8 KiB, then at most 64 KiB in total,
  and returns line 1 or null. One read at a time, a `pause()` (setImmediate)
  every 32 candidates and after each project.
- **Store.** `<dataDir>/schedule-history/imported.json`, `{ v: 1, projects:
  { <registry path>: { runs: { <sessionId>: { slug, folder, created, dueMs } },
  unattributed } } }`, written atomically (temp + `renameWithRetry`) after each
  project. The in-memory store takes the project only after that write
  succeeds, so a failed publication leaves the project to the retry. Then
  `onProgress` sends `schedule-history-imported` (preload
  `onScheduleHistoryImported`); the tab queues its debounced reload. A project
  present in the store is not read again.
- **Marker.** When every registry project is stored, `writer.mergeGlobal({
  scheduleHistoryImported: true })`. Marker and readable store: nothing runs.
  A missing or unreadable store reruns the import, which is idempotent (same
  attributions, same JSON). Projects added to the registry after the marker
  are not imported.
- **Failure and retry.** A failing project (transcript read error other than
  ENOENT, unreadable schedules, failed store write) does not stop the others.
  The pass ends `failed` with the first error, writes no marker and keeps the
  projects it stored. `onSettled` still reloads the tab so the note shows the
  failure, but `ensureStarted` refuses to retry before `RETRY_MS` (5 min): the
  reload its own notification causes cannot restart the pass. The tab's minute
  refresh retries after that; a new launch retries at its first listing.
- **Listing.** `buildScheduleList({ historyImport })` also takes rows whose
  session ID the store attributes to this schedule, in the same folder and the
  same registry project, adds `imported: true` and `dueMs`, and returns
  `history: { state, unattributed, error? }`, with `unattributed` summed over
  the projects listed now. Results are still read by session ID; none exists
  for these.
- **Renderer.** An imported run without a result says `Result unknown
  (imported)`, with ` — replied` or ` — no reply recorded`. The `schedule-help`
  note is built by `scheduleHistoryNote`: import pending/waiting/running,
  failed (with its error), sessions that look like a run but failed the check
  (`unattributed`), and any listed non-running run without a result. No gap,
  no note.

Regressions: `test/schedule-history-import.test.js` (era fixtures written in
each version's seed shape and indexed through `readSessionDisplayHeader`,
hand-started and forged look-alikes, idempotence, resume after a failed
project, non-blocking listing, index wait, 4 000 rows with 300 candidates, byte
cap, and the review regressions of #1253: a failed store publication, an
unreadable commands folder or schedule file, two projects sharing an encoded
folder, and the failure-reload loop), `test/dom-schedules-tab.test.js` (outcome
text, note only on gaps, reload on progress) and `test/schedule-list.test.js`
(main wiring).
