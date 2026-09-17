# Context: schedule-runner

**Purpose**: in-process cron that fires user-defined Claude tasks on a schedule. Stores schedules as Markdown files with YAML frontmatter inside each project's `.claude/commands/schedule-*.md`. Spawns `claude --resume <sid> -p "..."` as a detached child process when the cron expression matches.

## Key files

| File | LOC | Role |
|---|---|---|
| `schedule-runner.js` | ~310 | The cron loop, cron parser, file scanner, session pre-seeder, command builder. |
| `schedule-ipc.js` | ~220 | IPC handlers + the inline `SCHEDULE_CREATOR_TEMPLATE` (an embedded Claude command that teaches Claude how to write schedule files). |

## Public surface

From `schedule-runner.js`:

- `startScheduler(log, runCommand)` — start the in-process cron. Called from `main.js` at app boot.
- `scanSchedules(log)` — scan all known projects for `<project>/.claude/commands/schedule-*.md`, parse frontmatter, return `Schedule[]`.
- `createScheduleSession(schedule)` — write a pre-seeded JSONL into `~/.claude/projects/<encoded>/<uuid>.jsonl` with the schedule's prompt as the first user message. Returns the session UUID.
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
cli:
  permission-mode: acceptEdits
  allowed-tools: Bash,Read,Write
---

<Full self-contained prompt that Claude will execute>
```

`enabled: false` disables without deleting. `cron` is standard 5-field (minute, hour, day-of-month, month, day-of-week).

## Invariants

- **Schedules are scanned fresh every tick** (`scanSchedules` on every minute boundary). No in-memory cache — adding/editing a `.md` file takes effect within 60 seconds without any restart.
- **One run at a time per schedule** — `runningTasks` Set guards against overlap. If a schedule is still running when the next minute matches, the next tick is **silently skipped** (no queue, no retry).
- **Trigger alignment**: `setTimeout` to next minute boundary, then `setInterval(tick, 60_000)`. The first call is aligned to the wall-clock minute; subsequent calls drift only by JS event-loop latency.
- **Session pre-seeding is required** — `claude --resume <sid>` won't work without an existing JSONL. `createScheduleSession` writes a minimal valid JSONL containing one user message (the prompt).
- **Detached child process** — `stdio: ['ignore', 'ignore', 'pipe']`, no PTY. Stderr is captured for logging; stdout is dropped. No live tail; users see results by opening the resulting session in the sidebar.
- **`permission-mode: acceptEdits` is the typical default** for schedules — without it, the headless `-p` mode would hang on any tool-permission prompt.

## Non-obvious behaviors

- **A schedule file may be a symlink.** `scanSchedules` lists names and reads through them, so a `schedule-*.md` linked in from a versioned dotfiles repo fires on cron like any other. The two places that *don't* go through that scanner had to be taught the same thing: the brain tab's listing (`scan-md-files.js` — accepted entries on `dirent.isFile()`, false for a symlink, so a linked-in schedule was invisible in the UI while still firing weekly) and the run-now guard (`run-schedule-now-target.js` — checked the `.claude/commands` shape against the resolved target instead of the listed path). If you add a third reader of these files, resolve the link rather than the dirent.
- **`run-schedule-now` resolves the file and the cwd separately, and they may differ.** `resolveRunNowTarget` takes the schedule's bytes from the link's target and roots the spawn at the project whose `.claude/commands` lists it; each is disk-resolved and allowlisted in its own right, neither is derived from the other. With `projA/.claude/commands/schedule-x.md -> projB/.claude/commands/schedule-x.md` and both projects known, the run executes projB's content with `cwd = projA`. That is the semantic, not an oversight — `test/run-schedule-now-target.test.js` pins it so it is not "corrected" in either direction by accident.
- **Hand-rolled cron parser** in `cronFieldMatches` / `cronMatches`. Supports `*`, comma lists (`1,2,3`), ranges (`1-5`), steps (`*/5`). No support for `@daily`/`@hourly` aliases. No DST awareness — `new Date()` is local-time.
- **No persistence across app close** — the scheduler runs in-process. If Switchboard isn't running at 9am, the 9am schedule doesn't fire. By design (this is a personal tool, not a daemon).
- **The "schedule creator" is itself a Claude command**: when the user clicks the clock icon on a project, Switchboard opens an interactive Claude session pre-injected with `SCHEDULE_CREATOR_TEMPLATE` as its system prompt. Claude then has a conversation with the user about what they want scheduled, and **Claude itself writes the schedule `.md` file** with the Write tool. The runner just consumes whatever files appear.
- **`run-schedule-now`** IPC triggers an immediate manual run via the same `runScheduleCommand` pathway, bypassing the cron match check.

## If you change this, also check

- `public/dialogs.js` (`launchScheduleCreator`) — UI entry point for the schedule creator flow
- `public/memory-workfiles-view.js` brain tab — lists existing `schedule-*.md` files, surfaces the "run now" play button
- `scan-md-files.js` — what that brain tab list is actually built from (`get-memories` in `main.js`); it decides whether a schedule file is visible at all, and takes the memory allowlist so the list carries nothing the readers behind it would refuse to open
- `public/sidebar.js` — `.project-schedule-btn` clock icon wiring per project
- `schedule-ipc.js` `SCHEDULE_CREATOR_TEMPLATE` — if you change the schedule file format, update the template's instructions
- `main.js:2517` (or wherever `startScheduler(log, runScheduleCommand)` is invoked at app boot — checked 2026-09, it moves as main.js grows)
- The `runScheduleCommand` factory in `main.js` — uses `child_process.spawn`, `cleanPtyEnv`, and the global shell profile. Schedules don't get their own shell selector.

## Limitations worth knowing

- No queue → long-running schedules can starve their next cycle (the skip is silent)
- No persistence → app must be running for cron to fire
- No DST handling → 02:30 schedules on DST spring-forward simply don't fire that day
- No sub-minute precision → cron is minute-granular by design
- No cross-machine sync → schedules live in the user's local `.claude/commands/`
