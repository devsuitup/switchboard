# Testing a PR Live

`task test-pr PR=<number>` runs a pull request's code from source, in its own
Electron instance, **next to** the Switchboard you use every day, without
quitting it and without touching its database or triggers.

Use `task test-pr PR=<number> ISOLATED=1` for an instance with synthetic
sessions under a throwaway HOME, suitable for driving with a script.
The default mode keeps your real HOME and transcript history. `ISOLATED` takes
`1` for fixture mode or `0` for the default mode; unset or empty also selects
the default. Other values produce a usage error before any git command.

## From source, not a build

`npx electron . --no-sandbox` runs the checked-out source directly. In both
modes, `task test-pr` first rebuilds `public/codemirror-bundle.js` in the
worktree using esbuild's JavaScript API, resolved from that worktree's
`node_modules`. Build options come from the worktree's `package.json`
`bundle:codemirror` script: entry points, `--bundle`, `--minify`, and
`--outfile=`, `--format=`, `--platform=` values. Unsupported arguments stop
the launch with an error. It rebuilds even when a bundle already exists,
so the file viewers use the PR's current inputs. A failed bundle build stops
the launch and reports the worktree path and build error.

The task does not package the app or rebuild native modules, which other
instances may have loaded (see
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

The default mode handles the first two. Check the other two yourself.
`ISOLATED=1` also isolates sessions and projects, so real schedules are not
discovered.

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

A schedule with `catch-up: true` is no exception, and nothing more: catch-up is
off in an instance with `SWITCHBOARD_DATA_DIR` set, so the test instance runs it
on its cron minute like any other and never catches up a missed run (see
[Automation](automation.md#catching-up-a-missed-run)).

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
2. compares the PR's lock with `origin/main` directly, ignoring only the root
   `version` and `packages[""].version`, and warns on other changes;
3. links the checkout's `node_modules` into the worktree: a junction on
   Windows, a directory symlink on Linux/macOS, without copying dependencies;
4. rebuilds the CodeMirror bundle in the worktree, stopping if the build fails;
5. runs the worktree's local Electron binary with `. --no-sandbox`, with
   `SWITCHBOARD_DATA_DIR` and
   `SWITCHBOARD_TRIGGERS_DIR` set to `~/.switchboard-dev-pr122` and
   `~/.switchboard-dev-pr122/triggers`.

### Isolated, scriptable mode

```bash
task test-pr PR=122 ISOLATED=1
task test-pr PR=122 ISOLATED=1 DEBUG_PORT=9334
task test-pr PR=122 ISOLATED=1 ALLOW_CLAUDE=1
```

This mode creates a fresh temporary directory for every run and sets both
`HOME` and `USERPROFILE` to it. Configuration, Windows AppData, database and
triggers directories also live beneath it. It reuses `e2e/fixtures.js` to
create two projects: a committed fixture git repository and a plain directory,
each with a synthetic transcript. It does not copy your database or history.

Inherited `CLAUDE*`, `GIT_*`, `ANTHROPIC_*` and `AWS_*` variables are removed
case-insensitively in both `ALLOW_CLAUDE` modes, along with `GH_TOKEN`,
`GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`,
`SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `OPENAI_API_KEY`,
`GOOGLE_APPLICATION_CREDENTIALS`, `ORIGINAL_PATH` and `ELECTRON_RUN_AS_NODE`.
Names ending in `_TOKEN`, `_API_KEY`, `_APIKEY`, `_SECRET`, `_SECRET_KEY`,
`_PASSWORD` or `_PAT`, names starting with `GLAB_`, `GITLAB_` or `AZURE_`, and
`DOCKER_AUTH_CONFIG` are also removed case-insensitively. `HTTP_PROXY`,
`HTTPS_PROXY` and `ALL_PROXY` are removed when their values contain credentials
in the form `scheme://user:pass@`; credential-free proxies are preserved.
Git uses an empty
global configuration in the temporary HOME and skips the system config;
fixture commits receive a synthetic identity only during setup.

On Windows, the OpenSSH agent normally listens on
`\\.\pipe\openssh-ssh-agent`, and Pageant can also be available without an
environment variable. Removing `SSH_AUTH_SOCK` and `SSH_AGENT_PID` therefore
likely does not cut off access to these agents. This behavior in isolated mode
is unverified.

A refusing `claude` stub is placed **first on PATH**, with shell, `.cmd` and
PowerShell forms. Opening a synthetic session cannot start the real command
through normal PATH lookup; it prints `claude is disabled in isolated test-pr
mode` and exits. The rest of PATH remains available for git and shells.
This guard belongs to test-pr; it does not change the end-to-end fixtures'
environment handling (issue #438).

Set `ALLOW_CLAUDE=1` with `ISOLATED=1` to omit the stub and use the real
`claude` from the original PATH. The temporary HOME, fixtures and environment
sanitization remain in effect. A logged-out start is guaranteed only on Windows
and Linux: the first launch asks for a login, which is stored in the temporary
HOME and deleted on exit. On macOS, the CLI's OAuth login lives in the Keychain,
independent of HOME, so an existing login can remain available. No credentials
file is copied from your real HOME. The launch banner states
whether the real command is enabled and explains the temporary login when it is.

Managed settings are system-wide: on Windows, the locations are
`C:\Program Files\ClaudeCode\managed-settings.json` and the legacy
`C:\ProgramData\ClaudeCode\managed-settings.json`. Both sit outside `HOME`, so
if either file is present, its settings still apply to the isolated instance. This interaction,
including the logged-out behavior with managed settings present, is unverified.

On Windows, both launch modes treat PATH names case-insensitively and pass a
single `PATH` key to the child. If both `Path` and `PATH` exist, the exact `PATH`
value takes precedence. On POSIX, the original `PATH` supplies command lookup
(with the stub prepended when disabled); `Path` and `path` remain untouched.

Both `ISOLATED` and `ALLOW_CLAUDE` accept only `0`, `1`, empty or unset;
other values fail before any git command. `ALLOW_CLAUDE` defaults to `0`.
`ALLOW_CLAUDE=1` is refused when `ISOLATED` is unset, empty or `0`, because
the default mode already uses the real command.

The launch prints the temporary HOME and `--remote-debugging-port=9223`
(or `DEBUG_PORT`), plus `http://127.0.0.1:<port>/json` for CDP clients. Choose
a free port when running multiple instances. Close the instance before
rerunning the task; its temporary HOME is removed after exit, including a
failed fixture setup or launch. The worktree remains until `test-pr:clean`.
Do not seed this mode from the installed database.

These settings rely on the tested code honouring them; they do not restrict
filesystem permissions or prevent deliberately invoking an absolute executable
path. Read the PR diff before either mode.

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

### The `node_modules` link

The link is fast and keeps the native modules the checkout already built for
Electron. It is valid only if the PR does not change dependencies; otherwise the
task prints:

```
WARNING: package-lock.json differs on this PR - shared node_modules may be invalid.
Stop and install the reviewed dependencies in <worktree> before launching.
```

Then stop it and remove **only the link**: on Linux/macOS,
`rm .worktrees/pr-122-test/node_modules`; on Windows, from cmd.exe,
`rmdir .worktrees\pr-122-test\node_modules` (or `cmd //c rmdir` from Git Bash).
Never use `rm -rf` on a junction: it can traverse the checkout's dependencies.
Run `npm ci` in the worktree after unlinking and run the task again. A private
`node_modules` directory is preserved without creating a nested link.
`npm ci` runs the PR's `postinstall` and
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

For the default mode, run both commands by hand. The isolated mode starts
with a small fixture set and needs no database copy.

### Launching from inside a Claude session

In the default mode, the instance inherits the shell's environment and passes it to the sessions it
starts — only `ELECTRON_*`, `NODE_OPTIONS`, `GOOGLE_API_KEY*`,
`ORIGINAL_XDG_CURRENT_DESKTOP` and `WT_SESSION` are removed. Launched from a
shell inside an existing session, every session it starts carries that
session's `CLAUDE_CODE_*` variables (`CLAUDE_CODE_SSE_PORT`,
`CLAUDE_CODE_CHILD_SESSION`, …). Launch from a plain terminal, or clear them.
`ISOLATED=1` clears these inherited variables automatically.

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

removes the `node_modules` link **before** asking git to remove
`.worktrees/pr-122-test`, then removes `~/.switchboard-dev-pr122`. On Windows,
the script uses non-recursive `rmdir` for the junction; elsewhere it unlinks
the symlink. Link creation uses Node's native junction API, equivalent to
`mklink /J`, so Git Bash cannot turn it into a copy. After deleting a
worktree directory by hand, `git worktree prune` clears its git metadata.

## See also

- [Development](development.md) — running from source next to an installed copy.
- [../.ai/shared-guidelines.md](../.ai/shared-guidelines.md), "Critical
  invariants" — the rules for agents working next to a live instance.
- [Automation](automation.md) — schedules and triggers.
