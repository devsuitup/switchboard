# Testing a PR Live

`task test-pr PR=<number>` launches a PR's code from source, in its own isolated
Electron instance, running **alongside** the AppImage you use daily — no need to
quit it, and no risk to its database, automation triggers, or open sessions.

## Why from source, not a build

`task build` (`npm run build:linux`) rebuilds native modules
(`better-sqlite3`, `node-pty`) by default. Those `.node` files are `dlopen()`-loaded
by the running AppImage; a rebuild that replaces them mid-run can kill the live
process (see [../.ai/shared-guidelines.md §2](../.ai/shared-guidelines.md)). There
is no reason to build at all for testing a PR — `npx electron . --no-sandbox` runs
the checked-out source directly, so `task test-pr` never touches the build pipeline.

## How the single-instance lock is avoided

Switchboard's single-instance lock (`requestSingleInstanceLock`) is keyed on
Electron's `userData` path, not on "is another Switchboard running" in the
abstract. Two processes with **different** `userData` dirs coexist fine. Launching
from source with `SWITCHBOARD_DATA_DIR` set gives the dev instance its own
`userData` — that's the whole mechanism, and it's why `task dev` already works
next to the AppImage (`main.js` even defaults unpackaged runs to
`~/.switchboard-dev` when the var isn't set).

## Isolation is cooperation, not a sandbox

Everything below (DB, triggers, schedules) is **app-level cooperation**: the
isolation holds because Switchboard's own code chooses to honour
`SWITCHBOARD_DATA_DIR` and `SWITCHBOARD_TRIGGERS_DIR`. The PR's code runs via
`npx electron .` as a plain process with your full user privileges — a malicious
PR can simply ignore those variables and read or write anything you can,
including the real `~/.switchboard/switchboard.db` the AppImage is using.
`task test-pr` protects a well-behaved PR from *accidentally* colliding with
the live instance; it does not make running unread code safe. Read the diff
before you launch it.

## The four isolation concerns

`task test-pr` handles the first two automatically. The third and fourth need you
to check manually, before launching and while using the test instance.

### 1. Database (`SWITCHBOARD_DATA_DIR`)

Set to `~/.switchboard-dev-pr<N>`. The AppImage keeps using
`~/.switchboard/switchboard.db`; the test instance gets its own SQLite file. This
is the same mechanism as `task dev`, just with a PR-specific path so you can run
several PR tests without them colliding with each other or with your normal dev
instance.

### 2. Triggers (`SWITCHBOARD_TRIGGERS_DIR`)

The trigger watcher's default directory is the **fixed path**
`~/.switchboard/triggers` — it does not move with `SWITCHBOARD_DATA_DIR`. An
un-isolated dev instance would watch the *same* directory as the live AppImage,
racing it to pick up and delete trigger files dropped by the user's own
automation. `task test-pr` sets `SWITCHBOARD_TRIGGERS_DIR` alongside
`SWITCHBOARD_DATA_DIR` (`~/.switchboard-dev-pr<N>/triggers`) so the test instance
never sees the live triggers directory at all.

### 3. Schedules — check before you launch

The schedule runner starts unconditionally on every Switchboard launch and scans
`<project>/.claude/commands/schedule-*.md` **in every project it knows about** —
this is not scoped by `SWITCHBOARD_DATA_DIR`. If you have any schedule enabled,
launching a second instance fires it a **second time** the moment the cron next
matches (e.g. duplicate headless Claude runs, duplicate side effects). Before
running `task test-pr`, check across your projects:

```bash
grep -l 'enabled: true' */.claude/commands/schedule-*.md 2>/dev/null
```

If anything is enabled and due to fire during your test window, either disable it
first (`enabled: false`) or accept the duplicate run.

### 4. Sessions — never resume a session that's live elsewhere

**Both instances read the same `~/.claude/projects/*.jsonl` transcripts from
disk** — `SWITCHBOARD_DATA_DIR` isolates the SQLite index, not the session files
themselves. Clicking a session in the test instance that is **currently open and
live in the AppImage spawns a second `claude --resume` of that same session
id, duplicating it** (witnessed: a live orchestrator session was duplicated this
way, then killed, when someone clicked into it from the test instance). **Only
interact with terminal sessions you started fresh in the test instance, or with
sessions that are dead/closed everywhere else.**

## Running it

```bash
task test-pr PR=122
```

This:

1. `git fetch origin pull/122/head` and creates (or refreshes) a detached worktree
   at `.worktrees/pr-122-test`.
2. Symlinks `node_modules` from the repo root into the worktree.
3. Launches `npx electron . --no-sandbox` from the worktree with
   `SWITCHBOARD_DATA_DIR` and `SWITCHBOARD_TRIGGERS_DIR` both set to
   `~/.switchboard-dev-pr122[/triggers]`.

### The `node_modules` symlink caveat

Symlinking is fast and guarantees the native modules stay the same
electron-ABI build already used by your primary checkout (no rebuild, so no risk
to the running AppImage — see above). **This is only valid if the PR doesn't
touch dependencies.** The task warns you automatically:

```
WARNING: package-lock.json differs on this PR — the node_modules symlink is invalid.
Run 'npm ci' inside .worktrees/pr-122-test before launching.
```

If you see that warning, `Ctrl-C` out, `cd .worktrees/pr-122-test && npm ci`, then
re-run `task test-pr PR=122` (it will reuse the worktree and just symlink over
your fresh `npm ci` install — remove the symlinked `node_modules` first if `npm
ci` refuses to run into an existing symlink).

Be aware that `npm ci` in the worktree executes the contributor's arbitrary
`postinstall`/`prepare` scripts on your machine — only run it after reading the
PR's `package.json` and `package-lock.json` diff.

### If the PR touches CodeMirror

`public/codemirror-bundle.js` is committed, so most PRs don't need a rebuild. If
the PR changes `codemirror-setup.js` (or anything the bundle is built from), run
`npm run bundle:codemirror` inside the worktree before launching, otherwise the
test instance runs against a stale bundle.

## Pitfalls witnessed live

These were all hit during real sessions of running this exact procedure. None of
them are hypothetical.

### Never pipe the launch command's output

Don't pipe `task test-pr`'s output into anything that can close its end early
(`| head`, `| grep -m1`, a `tee` inside a script that exits, etc.). When the
reader closes, `electron-log`'s console transport throws an **uncaught EPIPE in
the Electron main process** — not a harmless broken-pipe warning: it surfaces as
a crash dialog and frozen terminals in the instance you were testing. Redirect to
a file instead if you need to capture output:

```bash
task test-pr PR=122 > pr122.log 2>&1 &
```

### Cold start on a fresh dev DB can take minutes — seed it instead

First launch indexes all of `~/.claude/projects` from scratch into the new,
empty SQLite file. On a large history (1GB+) this can take several minutes, and
the window may report "not responding" while it works — that's expected, **don't
force-quit**.

To skip re-indexing, seed the test DB from the AppImage's own DB instead of
starting blank (the source stays open read-only, `VACUUM INTO` never writes to it):

```bash
sqlite3 ~/.switchboard/switchboard.db "VACUUM INTO '$HOME/.switchboard-dev-pr122/switchboard.db'"
```

Then **purge the working-set restore settings before first launch** — the seeded
row carries the live app's `openWorkingSet`/`restoreOnStartup` state, which would
resurrect your real, currently-open sessions as duplicates inside the test
instance otherwise:

```bash
sqlite3 "$HOME/.switchboard-dev-pr122/switchboard.db" \
  "UPDATE settings SET value = json_set(json_remove(value,'\$.openWorkingSet'),'\$.restoreOnStartup',json('false')) WHERE key='global'"
```

This isn't wired into `task test-pr` as a flag (yet) — run both statements by
hand, in that order, before your first `task test-pr PR=<n>` for that PR.

### Transcripts are off if launched from inside a Claude session

If you run `task test-pr` from a shell inside an active Claude Code session, the
launched Electron instance inherits `CLAUDE_CODE_CHILD_SESSION` from the
environment — any Claude session you start *inside* the test instance will have
transcript-saving disabled. Launch from a plain terminal instead if you need a
transcript of the test session itself.

### Never resume a session that's live in the other instance

Covered above under [isolation concern 4](#4-sessions--never-resume-a-session-thats-live-elsewhere)
— repeating here because it's the highest-impact pitfall of the four: **clicking
a session in the test instance that's currently open in the AppImage (or vice
versa) spawns a duplicate `claude --resume` of it**, and the duplicate then
competes with the real one for the same session id.

## Comparing the two instances

Both processes are plain Electron apps, so standard OS tools work — but Chromium
subprocesses complicate naming:

- **Per-process CPU/memory**: `top -p <pid>` or a system monitor (GNOME System
  Monitor, `htop`) filtered by the parent PID tree. `ps --forest -o pid,ppid,cmd -p
  $(pgrep -f electron)` shows the tree.
- **The zygote mislabeling pitfall**: on Linux, Electron's renderer and GPU
  processes are forked from a "zygote" process and **keep the zygote's `cmdline`**
  (`ps` shows every forked child as `... --type=zygote`, even though it's actually
  running as a renderer or GPU process by then). Don't trust `ps aux | grep
  zygote` to tell you which is which. Instead, inspect the thread names under
  `/proc/<pid>/task/*/comm` — a real renderer process has a `Compositor` thread,
  the GPU process has `VizCompositorTh`. Use that to distinguish AppImage
  subprocesses from test-instance subprocesses when both are running.

## Measuring CPU and driving the UI

How the perf numbers in
[decisions/0002](decisions/0002-discrete-steps-sidebar-animations.md) were
produced, against an isolated instance launched per this doc. The short
version:

1. Measure CPU with **`/proc` stat deltas** over a fixed window — never
   `ps`/`top` `%CPU` (averaged since process start, useless for before/after).
2. Simulate UI states over **CDP** (`--remote-debugging-port`) instead of
   trying to produce real sessions in the right state.
3. **Re-verify the simulated state after every measurement window** — sidebar
   re-renders silently wipe DOM marks (details below).

### CPU: /proc stat deltas

Sample utime+stime (fields 14+15 of `/proc/<pid>/stat`, 100 ticks =
1 core·second) around a sleep:

```bash
read_ticks() { awk '{print $14+$15}' /proc/$1/stat; }
S=$(read_ticks $PID); sleep 30; E=$(read_ticks $PID)
echo "scale=1; ($E - $S) / 30" | bc   # % of one core over the window
```

Identify the renderer and GPU PIDs via the thread-name trick above. For a
per-thread breakdown, do the same over `/proc/<pid>/task/*/stat`: the
renderer main thread carries JS + style + layout + paint; the `Compositor`
thread is the cc impl thread.

### Driving the UI: Chrome DevTools Protocol

Launch the isolated instance with `--remote-debugging-port=9223` appended.
`http://localhost:9223/json` lists targets; the `ws` package already in
`node_modules` is enough for a ~30-line evaluator calling `Runtime.evaluate`
over the target's websocket. From there, mark sidebar items with state
classes or inject `<style>` variants for A/B comparisons.

### Pitfalls (all hit live, 2026-08-19)

- **Sidebar re-renders wipe DOM edits within seconds.** The watcher sees the
  real `~/.claude/projects` (data-dir isolation does not isolate it), so live
  sessions elsewhere keep triggering re-renders, and classes added to
  `.session-item` nodes silently vanish — the measurement window quietly
  degrades to baseline. Verify the marked state after every window. Wipe-proof
  alternatives: a `<style>` in `<head>` targeting stable per-item ids
  (`#si-<sessionId>`), a `position:fixed` overlay for visual demos, or a
  `setInterval` re-applying real state classes when the shipped selectors
  themselves are under test.
- **A user interacting with the instance mid-window invalidates it.** Opening
  a session spawns a real `claude --resume` whose output dwarfs the effect
  being measured. Re-measure; don't average over the contamination.
- **Every smooth 60fps animation pays a compositing floor** (~27% of a GPU
  core on the reference machine — full-window composite per frame). Establish
  a no-animation baseline first, or every comparison is against a moving
  floor.

### Saving a file inside this repository reloads the renderer

`main.js` loads `electron-reloader` with `watchRenderer: true` when it can be
required, which is whenever the app runs from source. An instance launched from
this checkout therefore reloads its renderer whenever a file in the checkout
changes — including a file **the app itself just wrote** through the Changes
panel's editor.

That makes the app's own repository the one working tree you cannot use to test
editing: the save succeeds, and the panel it should have left open is rebuilt
from scratch a moment later. `performance.now()` in the renderer tells the two
apart — a value far below the instance's real age means the page reloaded.

Test editing against **another** repository, or against the packaged build
below, which does not carry the reloader.

### Marking a DOM node from one CDP call and clicking it in the next does not work

The sidebar re-renders often enough that an `id` or `data-` attribute set in one
`Runtime.evaluate` is usually gone by the next call. Read the element's
bounding box and dispatch the click at those coordinates in the same session,
or re-read the box immediately before clicking.

Dispatch `mouseMoved` to the point before `mousePressed`. Controls that appear
on hover do not react to a press that arrives without the pointer ever having
been there.

## Testing the packaged build

Testing from source does not exercise what users install: the packaged build has
no `electron-reloader`, logs at `info` rather than `debug`, runs from an asar
archive, and carries its own rebuilt native modules. A release candidate is
worth one pass through the real artifact.

The artifacts are attached to the draft release the tag's build produces:

```bash
gh release download v<X.Y.Z> --pattern '*.AppImage' --dir /tmp/rc
```

**This machine has no FUSE**, so an AppImage cannot mount itself and exits with
`AppImages require FUSE to run`. Extract it and run the binary inside:

```bash
cd /tmp/rc && ./Switchboard-<X.Y.Z>.AppImage --appimage-extract
SWITCHBOARD_DATA_DIR=~/.switchboard-dev-rc \
SWITCHBOARD_TRIGGERS_DIR=~/.switchboard-dev-rc/triggers \
  ./squashfs-root/switchboard --no-sandbox --remote-debugging-port=9334
```

`squashfs-root/AppRun` does not work outside the mounted image — it resolves the
executable against `APPDIR`. Run `squashfs-root/switchboard` directly.

The same isolation rules apply as everywhere else on this page: a separate data
directory, a separate triggers directory, and no session resumed that is live in
another instance.

## Cleaning up

```bash
task test-pr:clean PR=122
```

Removes the `.worktrees/pr-122-test` worktree and `~/.switchboard-dev-pr122`
(database + triggers dir). Run this once you're done testing — leftover worktrees
and data dirs accumulate otherwise. If you deleted a `.worktrees/pr-N-test`
directory by hand instead, run `git worktree prune` to clear the orphaned git
metadata it leaves behind.

## See also

- [../.ai/shared-guidelines.md §1–2](../.ai/shared-guidelines.md) — the invariants
  this task is built to satisfy (single-instance lock, build-while-running risk).
- [automation.md](automation.md) — schedules and triggers in detail.
