# Observations from writing the context docs

Captured 2026-05-30 while writing the .ai/contexts/*.md files. None are blockers; they're follow-ups worth picking up when adjacent work happens.

## Architecture

- **`main.js` was 1849 LOC at capture time** (4082 at v0.0.102), vs upstream's ~350. It mixes IPC handlers (the bulk), app-lifecycle wiring, scheduling glue, MCP bridge, native-module instantiation, and updater integration. A modest refactor would split it into:
  - `ipc/sessions.js`, `ipc/projects.js`, `ipc/work-files.js`, `ipc/stats.js`, `ipc/updater.js`
  - `lifecycle.js` (app.on, BrowserWindow, single-instance lock, requestSingleInstanceLock)
  - `mcp-bridge.js` (already partial)
  
  Risk: lots of churn for diff readability. Worth doing once, all at once, **not piecemeal**.

- **No subagent-observability module** — the feature is implemented across `session-cache.js` (indexing), `main.js` (4+ IPCs), `public/sidebar.js` (rendering), `public/jsonl-viewer.js` (transcript). Considered creating a `subagent/` directory but the cross-cuts are real (it's a feature, not a sub-system). The context doc cross-references the pieces.

## IPC surface

- **Inconsistent return shapes**: some IPCs return `{ok: true}`, others return raw values, others return `{error: '...'}` on failure with no `ok` field. No canonical contract. Examples:
  - `delete-work-file` returns `{ok, error}` — well-shaped
  - `read-work-file` returns a raw string OR a sentinel string like `'[binary file]'` — bad
  - `remap-project` returns `{ok: true}` or `{error: '...'}` — well-shaped but no `ok: false` discriminator
  
  Standardising would be a sweep-style PR; touchable by Sonnet in a couple of hours.

- **`updater-event` polymorphism** (`onUpdaterEvent` in `preload.js`): one event channel covers 5+ subtypes. Different from the per-event `onSubagentSpawned/Completed` pattern. Inconsistency tax with no migration cost — fix when next touching the updater.

## session-cache

- **`getCachedByFolder` is `SELECT *`** — convenient for additions but means any new column lands in every consumer's payload silently. Probably fine; just be aware.

- **`refreshFolder(folder, opts)` does NOT take a "force header-only" knob** — it picks header-only vs full read per file based on whether the file was already cached. For most paths this is right, but a manual cache-bust would need a way to force full read.

- **~~No tests for `enumerateSessionFiles` directly~~** — resolved: `test/read-session-file.test.js` now tests it directly ("enumerateSessionFiles discovers top-level sessions plus subagents and ignores junk").

- **FTS `'work-file'` entries include the full file body** for files ≤ 64 KB and non-`.jsonl`. No per-file gzip or content-hash; if a 60 KB markdown changes on every byte, the FTS table churns. Acceptable for personal use; not for large monorepos.

## schedule-runner

- **No DST handling**. 02:30 on spring-forward = silently skipped. 02:30 on fall-back = fires twice. Document fix would be `new Date().getTimezoneOffset()` watch; real fix is non-trivial.

- **Hand-rolled cron parser** has no `@daily`/`@hourly` aliases. Most users won't notice but it's surprising vs other cron implementations.

- **`runningTasks` is a Set per file path** — schedules can't share state. Fine for the current design.

- **No `kill timeout`** on detached child processes. A schedule that runs forever (or hangs on permission prompt despite `acceptEdits`) will silently consume a slot until process death.

## viewer-panel

- **`viewer-panel.js` constructor takes 9+ opts**. Could benefit from a builder or named-option grouping (clipboard, save, delete) but the current shape is workable.

- **No way to switch language mode after `open()`** — `language: 'auto'` infers from file extension at construction, but if you re-`open()` a `.md` file in a panel constructed with `language: 'auto'`, the editor mode may stale-cache.

- **`format` JSON-line joiner uses `\n---\n` as separator** — not valid JSON, intentional. Documented in the context doc, but a reader unfamiliar with the choice may file a bug.

- **No undo across `format` invocations** — CodeMirror's undo stack tracks the format as one large diff. Multiple format clicks accumulate. Acceptable.

## subagent-observability

- **The "Resume in terminal anyway" escape hatch is a footgun by design** — re-resuming a subagent that's done can corrupt context. A confirm dialog would prevent accidental clicks.

- **No persistence of which subagent transcripts the user has "seen"** — every reload shows them as fresh. Could be tracked via `localStorage` for a "new" badge.

- **Watch leak risk on rapid open/close** — `drainViewerWatches` handles the close case, but if the user opens 20 subagent transcripts in quick succession and only the last one is visible, 19 watchers may still tail their files until panel destroy. Worth profiling.

## Tests

- ~~**No `enumerateSessionFiles` unit test**~~ — resolved (see session-cache section).
- **No integration test for the full schedule-fire pathway** — at capture time only `scanSchedules` and `cronMatches` were tested. Since then `startScheduler` is driven with a stub `runCommand` in `test/schedule-catch-up.test.js`, and `main.js`'s `runScheduleCommand` is checked by source-level tests (e.g. `test/run-schedule-now-result.test.js`, `test/schedule-live-resume.test.js`).
- **Worktree node_modules can have missing native modules** (morphdom-umd.js encountered 2026-05-30) — confused a code-reviewer agent into reporting false "pre-existing fails". Could be fixed by `npm install` after worktree creation as a harness step.

## Build pitfalls

- **`npm run build:linux` while Switchboard is running can kill the running instance.** Witnessed 2026-05-31 ~13:49 — the AppImage process stopped logging mid-window during a background `npm run build:linux`, no SIGTERM trace in `~/.config/switchboard/logs/main.log`, just a 9-minute silence then a fresh launch by the user. Confirmed harmless: the file `cp dist/*.AppImage ~/Applications/` AFTER the build completes (the cp itself is safe — the running process is mmap'd from `/tmp/.mount_*`).

  **Suspected mechanism**: electron-builder invokes `@electron/rebuild` for native modules (`better-sqlite3`, `node-pty`). These modules are `dlopen()`-loaded by the running AppImage. If electron-rebuild uses `truncate+write` instead of `atomic rename`, the running process loses access to its `better_sqlite3.node` binding at the next SQLite call → segfault → kernel SIGKILL with no app-level trace. Not confirmed without sudo dmesg access.

  **Mitigations to consider**:
  1. **Skip native rebuild when running locally**: `npm config set npm_config_skip_electron_rebuild true` before build, or use `--config.npmRebuild=false` on electron-builder, or build only the asar (`electron-builder --linux AppImage --dir`).
  2. **Build in a dedicated worktree with its own `node_modules/`**: full isolation, slower (extra `npm install`).
  3. **Document loudly and tell the user before any background build**: lowest tech, highest reliability.

  **The `cp` step itself is safe** — confirmed by replacing the file while the process kept running (mtime 17:36, PID 2620410 still alive). The running AppImage is fully extracted to `/tmp/.mount_*` at launch and does not page back from the on-disk file.

  **Superseded:** a later incident showed the `cp` to `~/Applications/` can terminate the running instance through `appimagelauncherd`; [shared-guidelines.md](../shared-guidelines.md) invariant #2 is the current rule.

## Security

- **`clipboard-write-text` accepts any string from any renderer** — fine given the single-renderer, single-user threat model, but worth a sentence in the security model doc if one exists.
- **`remap-project` validates `newPath` via `lstatSync` (no symlink follow)** — correct since PR #20 fix. Worth a code comment noting why `lstatSync` (not `statSync`).
- ~~**No CSP on the renderer**~~ — resolved: `main.js` sets a `Content-Security-Policy` header on every response in `app.whenReady()` (`default-src 'self'`, `script-src 'self'`).

---

*Use these as ammunition for opportunistic follow-ups, not as a TODO list. Most of them are "nice to have" — feature work should keep taking priority.*
