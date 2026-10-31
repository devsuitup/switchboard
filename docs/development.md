# Development

## Prerequisites

- **Node.js** 20 or 22 (`engines`: `>=20 <23`), with npm.
- Build tools for the native modules (`better-sqlite3`, `node-pty`):
  - macOS: Xcode Command Line Tools (`xcode-select --install`);
  - Linux: `build-essential` and `python3`;
  - Windows: the Visual Studio C++ build tools.
- [task](https://taskfile.dev), the entry point for the commands below
  (`brew install go-task`, `snap install task --classic`, or see taskfile.dev).
  The npm scripts work without it.

## First run

```bash
task install                 # npm install; postinstall rebuilds the native modules for Electron
npm run bundle:codemirror    # builds public/codemirror-bundle.js (generated, not committed)
npm run bundle:mermaid       # builds the local, lazy diagram bundle (generated, not committed)
task dev                     # runs the checkout in Electron
```

`npm start` bundles CodeMirror and Mermaid and launches in one step. `task dev` and
`npm run electron` do not bundle: after a change to `public/codemirror-setup.js`,
run `npm run bundle:codemirror` again. After a change to `public/mermaid-setup.js`,
run `npm run bundle:mermaid` again.

## Commands

`task` alone lists them.

| Command | What it runs |
|---|---|
| `task install` | `npm install` |
| `task dev` | `npx electron . --no-sandbox` with `SWITCHBOARD_DATA_DIR=~/.switchboard-dev` |
| `task test` | `npm test`: ESLint (`pretest`), then the node:test suite — see below |
| `task lint` | `npx eslint .` |
| `task check:fast` | Lint staged JS and run matching tests; the pre-commit hook runs it |
| `task check` | Full `test` and `lint` gate before opening a PR |
| `task ci` | `npm test`, then `npx eslint .`, in sequence |
| `task coverage` | the suite under c8; text and lcov in `./coverage` |
| `task install:lint` | installs `eslint` and `jsdom` if missing |
| `task build` | `npm run build:linux` — see [Building](#building) |
| `task test-pr PR=<n>` | a PR's code, isolated — see [Testing a PR live](testing-a-pr.md) |
| `task test-pr:clean PR=<n>` | removes that PR's dependency link, worktree and data directory |
| `task e2e` | bundles both viewers, then the Playwright journeys (under `xvfb-run` when there is no display) — see [End-to-end journeys](e2e.md) |
| `task db:reset:dev` | deletes `~/.switchboard-dev/switchboard.db` |
| `task db:reset` | deletes `~/.switchboard/switchboard.db` — the **installed app's** database — without asking |
| `task clean` | deletes `dist/`, both generated viewer bundles and the installed app's database, after typing `YES` |

Other npm scripts: `npm run electron` (`electron .`), `npm run electron-dev`
(the same with `SWITCHBOARD_DATA_DIR=~/.switchboard-dev`), `npm run build:mac`,
`build:mac:arm64`, `build:win`, `build:linux`, `npm run release`,
`npm run generate-icons`, `npm run test:canary` (the CLI capability canary's
tests, `test/canary/`, which `npm test` does not run).

### Tests

`npm test` runs `scripts/run-tests.js` in two stages: every file in `test/`
except `trigger-watcher.test.js`, `trigger-delivery.test.js` and
`trigger-continuation-delivery.test.js`, with at most 4 workers
(`SWITCHBOARD_TEST_CONCURRENCY=N` to change it), then those three alone,
serially, because their timings use real clocks. Renderer files are tested
under jsdom (`test/dom-setup.js`).

The pre-commit hook (husky) runs `task check:fast`, or, without `task`,
`node scripts/check-fast.js`. Both routes lint only staged JS files (`.js`, `.cjs`, `.mjs`) and run
matching tests. `SKIP_TESTS=1` skips tests in either route and keeps lint.
`task check` remains the full lint and test gate before opening a PR.

The fast check ignores deletions, and a staged path missing from the working
tree is skipped by lint. A staged test directly under `test/` selects itself
(nested suites such as `test/canary/` are not selected); other `.js` files select
`test/<basename>.*.test.js` and `test/<basename>-*.test.js`, and `public/` JS
also selects the `dom-<basename>` equivalents. Non-JS files select nothing. Tests
are discovered from the filesystem, deduplicated, sorted and run serially with
the current Node binary and a 120-second cap per process; the trigger files the
full runner isolates run without a per-test timeout, capped at 10 minutes. Lint
and tests read working-tree content, not partially staged blobs. A widely shared
file selects many tests (`public/sidebar.js`: 38 files). An unmatched JS file
still gets linted.
This name-based selection can miss unrelated regressions; the full PR gate and
required CI cover those. See [fast-check context](../.ai/contexts/fast-check.md).

To time the check without changing files or staging anything, run
`node scripts/check-fast.js --files src/main/terminals/pty-ops.js test/pty-ops.test.js` (paths
relative to the repository root).
This overrides only the input list; lint and selected tests still execute.

CI (`.github/workflows/test.yml`) runs ESLint, and the suite under coverage on
Node 20 and 22, on Ubuntu and Windows. On pull requests, lines a change adds or
modifies must be 80 % covered (`diff-cover`), `main.js`, `preload.js`, the MCP
bridge, `claude-auth.js`, `public/app.js`, `public/terminal-manager.js`, the
CodeMirror and Mermaid files, workers, scripts, tests and `e2e/` excepted. The
same workflow runs the [changelog check](changelog.md#the-ci-check) on pull
requests and the [end-to-end journeys](e2e.md).

## Running from source next to an installed copy

An instance run from source is isolated from the installed app by its data
directory: `main.js` sets `SWITCHBOARD_DATA_DIR=~/.switchboard-dev` when the
variable is unset and the app is not packaged, and `task dev` sets it
explicitly. That directory holds its own database and its own Electron
`userData`, so it also has its own single-instance lock: both run side by side.
A second launch with the **same** data directory quits and focuses the first
window.

What the data directory does not isolate:

- **Transcripts.** Both instances read `~/.claude/projects`, list the same
  sessions, and can resume them. Switchboard refuses an automatic resume of a
  session live in another process and asks before a click does one (see
  [Launching sessions](launching-sessions.md#sessions-live-in-another-process)).
  For an instance that cannot see your sessions at all, see
  [Live testing with a throwaway HOME](live-testing.md).
- **Triggers.** `~/.switchboard/triggers` is watched by every instance unless
  `SWITCHBOARD_TRIGGERS_DIR` is set; `task dev` does not set it, `task test-pr`
  does.
- **Schedules.** Every instance scans every project's `schedule-*.md` and fires
  them: an enabled schedule runs once per instance.

A run from source loads `electron-reloader`, which watches the checkout:

- **A change to a module the main process has loaded** — `main.js`, `db.js`,
  any other root `*.js` it requires — **relaunches the whole app**
  (`app.relaunch()` then `app.exit(0)`). Every PTY of that instance dies with
  it: its Claude sessions, terminals and panel shells stop, mid-turn or not.
  Editing the code, a `git checkout`, a `git pull` or a `git stash` in the
  checkout of a running instance all do it.
- **Any other change** — `public/`, or a file the app itself writes, such as one
  saved from the Changes editor — reloads the renderer.

Files under dot-directories (`.work-files/` among them), `node_modules` and
source maps do not trigger it. A packaged build has no reloader.

### Building and replacing while an installed copy runs

- `task build` / `npm run build:linux` runs electron-builder, which by default
  rebuilds the native modules (`better-sqlite3`, `node-pty`) and rewrites their
  `.node` files. A running instance that has those files `dlopen()`-loaded
  crashes at its next native call when they are rewritten in place. Build with
  the rebuild off while an instance runs:
  `npm run bundle:codemirror && npm run bundle:mermaid && npx electron-builder --linux --config.npmRebuild=false`
  (electron-builder then logs `skipped dependencies rebuild`).
- Copying a new AppImage over `~/Applications/Switchboard.AppImage` can end the
  running instance: `appimagelauncherd` watches that directory and re-runs its
  desktop integration on a replaced file. Replace it when you are ready to
  restart.
- New code runs at the next launch only.

## Building

```bash
npm run build:linux   # AppImage, deb and pacman, for the host's architecture
npm run build:mac     # dmg and zip, arm64 and x64
npm run build:win     # NSIS installer, x64 and arm64
```

Each bundles CodeMirror and Mermaid first, then runs electron-builder; output goes to
`dist/`. CI builds Linux x64 and arm64 on separate runners, since one
electron-builder run for several architectures can pack native modules built for
the wrong one.

### Arch and Manjaro

The `deb` and `pacman` targets use the `fpm` binary bundled by electron-builder,
which links against `libcrypt.so.1`. Arch's `libxcrypt` lacks that ABI; install
`libxcrypt-compat` once. The AppImage builds without it.

The pacman package is named **`switchboard-doctly`**, because Arch's `extra`
repository has an unrelated `switchboard` package (elementary OS's settings
application). The app is still called Switchboard; uninstall with
`sudo pacman -R switchboard-doctly`.

### Code signing

- macOS: `package.json` sets `"identity": null` and `"notarize": false`, so the
  build is not signed. It uses a hardened runtime with
  `build/entitlements.mac.plist`, which allows JIT and unsigned executable
  memory for the native modules. `postinstall` ad-hoc signs the `.node` files of
  a local install.
- Windows: `CSC_LINK` and `CSC_KEY_PASSWORD` sign the installer when set.

## Project layout

```
main.js             Electron main process: windows, IPC, PTYs, watchers, schedules
preload.js          The context bridge (window.api)
db.js               SQLite: session cache, metadata, settings, FTS search
session-cache.js    Transcript indexer and ~/.claude/projects watcher
schedule-runner.js  Cron scheduler for schedule-*.md files
trigger-watcher.js  The file-based trigger API
remote-*.js         Remote hosts: inventory, mirror, watch, attach, stop
mcp-bridge.js       The IDE emulation MCP server
window-frame.js     Window options, the application menu, zoom keys
workers/            Worker threads (indexing, the session index writer, search, file lists, task records)
public/             Renderer (HTML, CSS, JS); app.js is the entry point
scripts/            Postinstall, test runner, sandbox wrapper, build helpers
test/               node:test suites
docs/               This documentation
.ai/                Contributor and agent guidelines, per-area context documents
build/              Icons, entitlements, screenshots
.github/workflows/  CI and release builds
```

Contributors, human or agent, start at [.ai/shared-guidelines.md](../.ai/shared-guidelines.md)
(which `CLAUDE.md` includes) and [.ai/contexts/README.md](../.ai/contexts/README.md).
