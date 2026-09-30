# Testing a PR Live

`task test-pr PR=<number>` runs a pull request's code from source, in its own
Electron instance, **next to** the Switchboard you use every day, without
quitting it and without touching its database or triggers.

For an instance that cannot see your sessions at all, and for anything driven
by a script, see [Live testing with a throwaway HOME](live-testing.md); the
[comparison](live-testing.md#which-one-to-use) says when to use which.

## From source, not a build

`npx electron . --no-sandbox` runs the checked-out source directly. `task
test-pr` never builds: a build rebuilds the checkout's native modules, which
other instances may have loaded (see
[Development](development.md#building-and-replacing-while-an-installed-copy-runs)).

## How two instances coexist

The single-instance lock (`requestSingleInstanceLock`) is keyed on Electron's
`userData` directory. `SWITCHBOARD_DATA_DIR` moves `userData` under the data
directory, so an instance with its own data directory has its own lock and runs
beside the installed app.

## Isolation is cooperation, not a sandbox

The isolation below holds because Switchboard's code honours
`SWITCHBOARD_DATA_DIR` and `SWITCHBOARD_TRIGGERS_DIR`. The PR's code runs as an
ordinary process with your privileges: a malicious PR can ignore those
variables and read or write anything you can, the installed app's
`~/.switchboard/switchboard.db` included. `task test-pr` keeps a well-behaved
PR from colliding with the live instance by accident; it does not make running
unread code safe. Read the diff first.

## The four isolation concerns

`task test-pr` handles the first two. Check the other two yourself.

### 1. Database (`SWITCHBOARD_DATA_DIR`)

Set to `~/.switchboard-dev-pr<N>`: its own SQLite file, its own lock, apart from
the installed app (`~/.switchboard/`), from `task dev` (`~/.switchboard-dev/`)
and from other PRs.

### 2. Triggers (`SWITCHBOARD_TRIGGERS_DIR`)

The trigger watcher's default directory, `~/.switchboard/triggers`, does not move
with `SWITCHBOARD_DATA_DIR`. An instance without its own would race the live
app for every trigger file your automation drops. `task test-pr` sets
`~/.switchboard-dev-pr<N>/triggers`.

### 3. Schedules — check before you launch

Every instance scans `<project>/.claude/commands/schedule-*.md` in every project
it knows and fires the enabled ones, whatever its data directory. An enabled
schedule due while the test instance runs fires twice. Before launching, look
for enabled schedules:

```bash
grep -L 'enabled: false' ~/path/to/projects/*/.claude/commands/schedule-*.md
```

(`enabled: false` is the only value that disables a schedule — see
[Automation](automation.md#schedules).) Disable the ones due during the test, or
accept the duplicate run.

### 4. Sessions — the transcripts are shared

**Both instances read the same `~/.claude/projects`.** The test instance lists
every session, those the installed app is running included, and can resume them.
Two resumes happen without a click:

- **A renderer reload** — from DevTools, `location.reload()`, or the reloader
  when a file of the worktree changes — reopens the session remembered in
  `sessionStorage.activeSessionId`, whatever `restoreOnStartup` says.
- **The working-set restore** at startup, when `restoreOnStartup` is not `off`
  and `openWorkingSet` lists sessions.

Resuming a session another process runs starts a second `claude --resume` on it:
two CLIs write one transcript, and input typed in the test instance lands in
that session. Switchboard skips both automatic resumes for a session live
elsewhere and asks before a click resumes one (see
[Launching sessions](launching-sessions.md#sessions-live-in-another-process)).
That check reads the CLI's undocumented `~/.claude/sessions/<pid>.json`, and the
PR under test may predate or break it. So:

- Open only sessions you started in the test instance, or sessions that run
  nowhere else. When a click asks *Resume it anyway?*, answer Cancel.
- Seed the test database with `restoreOnStartup` off and `openWorkingSet`
  removed (see [Cold start](#cold-start-seed-the-database)).
- Before reloading the test instance, make sure the session it remembers is one
  you created in it.

## Running it

```bash
task test-pr PR=122
```

It:

1. fetches `pull/122/head` from `origin` and creates, or moves, a detached
   worktree at `.worktrees/pr-122-test`;
2. warns if the PR changes `package-lock.json`;
3. symlinks the checkout's `node_modules` into the worktree;
4. runs `npx electron . --no-sandbox` there, with `SWITCHBOARD_DATA_DIR` and
   `SWITCHBOARD_TRIGGERS_DIR` set to `~/.switchboard-dev-pr122` and
   `~/.switchboard-dev-pr122/triggers`.

### The CodeMirror bundle

`public/codemirror-bundle.js` is generated, not committed, so a fresh worktree
has none, and without it the editors — Agent Files, Work Files, the file panel,
the Changes editor — do not load. After the first `task test-pr` has created the
worktree, stop it, build the bundle there, and run the task again (it reuses the
worktree, and the bundle, being gitignored, survives the checkout):

```bash
(cd .worktrees/pr-122-test && npm run bundle:codemirror)
```

Rebuild it whenever the PR changes `public/codemirror-setup.js`.

### The `node_modules` symlink

The symlink is fast and keeps the native modules the checkout already built for
Electron. It is valid only if the PR does not change dependencies; otherwise the
task prints:

```
WARNING: package-lock.json differs on this PR — the node_modules symlink is invalid.
Run 'npm ci' inside .worktrees/pr-122-test before launching.
```

Then stop it, remove the symlink (`rm .worktrees/pr-122-test/node_modules`), run
`npm ci` in the worktree, and run the task again. Its `ln -sfn` then finds a
real directory and only adds a stray `node_modules/node_modules` link inside
it; the fresh install stays in use. `npm ci` runs the PR's `postinstall` and
`prepare` scripts on your machine: read its `package.json` and
`package-lock.json` diff first.

## Pitfalls

### Never pipe the launch command's output

Do not pipe `task test-pr` into anything that can close early (`| head`,
`| grep -m1`, a `tee` in a script that exits). When the reader closes,
`electron-log`'s console transport throws an uncaught `EPIPE` in the main
process: a crash dialog and frozen terminals in the instance under test.
Redirect to a file instead:

```bash
task test-pr PR=122 > pr122.log 2>&1 &
```

### Cold start: seed the database

A new, empty database indexes all of `~/.claude/projects` at first launch. On a
large history (a gigabyte or more) that takes minutes, during which the window
can be reported as not responding; do not kill it. To skip it, copy the installed
app's database (the source is only read):

```bash
mkdir -p ~/.switchboard-dev-pr122
sqlite3 ~/.switchboard/switchboard.db "VACUUM INTO '$HOME/.switchboard-dev-pr122/switchboard.db'"
```

Then, **before the first launch**, remove the copied restore state, which would
otherwise reopen your real sessions in the test instance:

```bash
sqlite3 "$HOME/.switchboard-dev-pr122/switchboard.db" \
  "UPDATE settings SET value = json_set(json_remove(value,'\$.openWorkingSet'),'\$.restoreOnStartup','off') WHERE key='global'"
```

`task test-pr` has no flag for this; run both commands by hand.

### Launching from inside a Claude session

The instance inherits the shell's environment and passes it to the sessions it
starts — only `ELECTRON_*`, `NODE_OPTIONS`, `GOOGLE_API_KEY*`,
`ORIGINAL_XDG_CURRENT_DESKTOP` and `WT_SESSION` are removed. Launched from a
shell inside a Claude Code session, every session it starts carries that
session's `CLAUDE_CODE_*` variables (`CLAUDE_CODE_SSE_PORT`,
`CLAUDE_CODE_CHILD_SESSION`, …). Launch from a plain terminal, or clear them.

### The reloader and this repository

A run from source watches its own checkout — see
[Development](development.md#running-from-source-next-to-an-installed-copy):

- **A change to a main-process module relaunches the whole instance, and every
  session it runs dies.** Re-running `task test-pr` for a new push of the PR
  checks out the new commit in the worktree: if the test instance is still
  running, it relaunches, killing its sessions. Stop the test instance first.
- Any other file change reloads the renderer. Saving a file of the PR's own
  worktree through the Changes editor therefore reloads the page that saved
  it. Test editing against another repository, or against the packaged build.

## Comparing two instances

Both are plain Electron processes, so the usual tools apply, with one trap:

- `top -p <pid>`, `htop` or a system monitor, filtered by process tree;
  `ps --forest -o pid,ppid,cmd -p <pids>` shows the tree.
- On Linux, Electron's renderer and GPU processes are forked from a zygote and
  keep its command line: `ps` shows them all as `--type=zygote`. Tell them apart
  by thread names in `/proc/<pid>/task/*/comm`: a renderer has a `Compositor`
  thread, the GPU process a `VizCompositorTh` thread.

## Measuring CPU and driving the UI

The method behind the figures in
[decision 0002](decisions/0002-discrete-steps-sidebar-animations.md):

1. Measure CPU with **`/proc` stat deltas** over a fixed window, never with
   `ps`/`top` `%CPU`, which averages since the process started.
2. Put the UI in the state to measure over **CDP**
   (`--remote-debugging-port`) instead of producing real sessions in that state.
3. **Check the state again after every window**: sidebar re-renders silently
   undo DOM changes.

### CPU: `/proc` stat deltas

utime + stime are fields 14 and 15 of `/proc/<pid>/stat`, in clock ticks (100 per
second of one core):

```bash
read_ticks() { awk '{print $14+$15}' /proc/$1/stat; }
S=$(read_ticks $PID); sleep 30; E=$(read_ticks $PID)
echo "scale=1; ($E - $S) / 30" | bc   # % of one core over the window
```

Find the renderer and GPU pids with the thread-name test above. The same over
`/proc/<pid>/task/*/stat` splits it by thread: the renderer's main thread
carries JavaScript, style, layout and paint; its `Compositor` thread is the
compositor's impl thread.

### Chrome DevTools Protocol

Append `--remote-debugging-port=9223` to the launch. `http://localhost:9223/json`
lists the targets; the `ws` package in `node_modules` is enough for a short
client that calls `Runtime.evaluate` over a target's WebSocket.

- **The sidebar re-renders within seconds**, because the watcher sees the real
  `~/.claude/projects` and live sessions keep writing: classes added to
  `.session-item` nodes vanish, and a measurement quietly returns to baseline.
  A `<style>` in `<head>` targeting stable ids (`#si-<sessionId>`), a
  `position:fixed` overlay, or a `setInterval` that re-applies the classes
  survives it. A [throwaway HOME](live-testing.md) removes the cause.
- **An id or attribute set in one `Runtime.evaluate` is often gone by the next.**
  Read an element's box and click at those coordinates in the same call, or
  re-read the box just before clicking.
- **Send `mouseMoved` before `mousePressed`.** Controls that appear on hover do
  not react to a press where the pointer never was.
- **Opening a session during a window spoils it**: its `claude --resume` output
  dwarfs the effect measured. Measure again.
- **Every smooth 60 fps animation costs a compositing floor**: the whole window
  is composited on every frame. Measure a baseline without animation first.

## Testing the packaged build

Running from source does not exercise what users install: the packaged build has
no reloader, logs at `info` instead of `debug`, runs from an asar archive, and
carries its own native modules. A release candidate is worth one pass through
the real artifact, attached to the draft release the tag's build creates:

```bash
gh release download v<X.Y.Z> --repo devsuitup/switchboard --pattern '*.AppImage' --dir /tmp/rc
```

Without FUSE an AppImage cannot mount itself (`AppImages require FUSE to run`).
Extract it and run the binary inside:

```bash
cd /tmp/rc && ./Switchboard-<X.Y.Z>.AppImage --appimage-extract
SWITCHBOARD_DATA_DIR=~/.switchboard-dev-rc \
SWITCHBOARD_TRIGGERS_DIR=~/.switchboard-dev-rc/triggers \
  ./squashfs-root/switchboard --no-sandbox --remote-debugging-port=9334
```

Run `squashfs-root/switchboard`, not `squashfs-root/AppRun`: `AppRun` finds its
directory by walking up from itself testing `-e "$path/$1"` — its own first
argument — so any argument that is not a file in the tree leaves `APPDIR` empty
and resolves the executable as `/switchboard`. `AppRun` also honours an
inherited `APPDIR`, so from a shell opened inside a running AppImage it launches
that image's binary; `env -u APPDIR` clears it.

The same rules apply as above: its own data and triggers directories, and no
session resumed that is live elsewhere.

## Cleaning up

```bash
task test-pr:clean PR=122
```

removes `.worktrees/pr-122-test` and `~/.switchboard-dev-pr122`. After deleting a
worktree directory by hand, `git worktree prune` clears its git metadata.

## See also

- [Development](development.md) — running from source next to an installed copy.
- [../.ai/shared-guidelines.md](../.ai/shared-guidelines.md), "Critical
  invariants" — the rules for agents working next to a live instance.
- [Automation](automation.md) — schedules and triggers.
