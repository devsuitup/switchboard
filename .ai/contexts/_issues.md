# Observations from writing the context docs

Captured 2026-05-30 while writing the .ai/contexts/*.md files; pruned 2026-11-24 against main 4d468532 (resolved items removed). None are blockers; they're follow-ups worth picking up when adjacent work happens.

## Architecture

- **`main.js` is still the largest file** (4688 lines at 4d468532). Handlers move out by context under `src/main/` (`app`, `bg-agents`, `browser`, `changes`, `cli`, `files`, `integrations`, `projects`, `remote`, `schedules`, `session-index`, `shared`, `terminals`, `triggers`, `usage`, `viewer`) following [ADR 0005](../../docs/decisions/0005-main-process-context-layout.md); the MCP bridge is `src/main/integrations/mcp/mcp-bridge.js`.

- **No subagent-observability module** — the feature is implemented across `session-cache.js` (indexing), `main.js` (4+ IPCs), `public/sidebar.js` (rendering), `public/jsonl-viewer.js` (transcript). Considered creating a `subagent/` directory but the cross-cuts are real (it's a feature, not a sub-system). The context doc cross-references the pieces.

## IPC surface

- **Inconsistent return shapes**: some IPCs return `{ok: true}`, others return raw values, others return `{error: '...'}` on failure with no `ok` field. No canonical contract. Example: `remap-project` returns `{ok: true}` or `{error: '...'}` — no `ok: false` discriminator. (`read-file-for-panel` now returns `{ ok: false, error: 'binary file', reason: 'binary' }` for binary files.)
  
  Standardising would be a sweep-style PR; touchable by Sonnet in a couple of hours.

- **`updater-event` polymorphism** (`onUpdaterEvent` in `preload.js`): one event channel covers 5+ subtypes. Different from the per-event `onSubagentSpawned/Completed` pattern. Inconsistency tax with no migration cost — fix when next touching the updater.

## session-cache

- **`cacheGetByFolder` (`session-index-store.js`) is `SELECT *`** — convenient for additions but means any new column lands in every consumer's payload silently. Probably fine; just be aware.

- **`refreshFolder(folder, opts)` does NOT take a "force header-only" knob** — it picks header-only vs full read per file based on whether the file was already cached. For most paths this is right, but a manual cache-bust would need a way to force full read.

## schedule-runner

- **No DST handling**. 02:30 on spring-forward = silently skipped. 02:30 on fall-back = fires twice. Document fix would be `new Date().getTimezoneOffset()` watch; real fix is non-trivial.

- **Hand-rolled cron parser** has no `@daily`/`@hourly` aliases. Most users won't notice but it's surprising vs other cron implementations.

- **`runningTasks` is a Set keyed by `<folder>:<slug>`** (`startScheduler`, `src/main/schedules/schedule-runner.js`) — schedules can't share state. Fine for the current design.

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

- **No integration test for the full schedule-fire pathway** — at capture time only `scanSchedules` and `cronMatches` were tested. Since then `startScheduler` is driven with a stub `runCommand` in `test/schedule-catch-up.test.js`, and `main.js`'s `runScheduleCommand` is checked by source-level tests (e.g. `test/run-schedule-now-result.test.js`, `test/schedule-live-resume.test.js`).
- **Worktree node_modules can have missing native modules** (morphdom-umd.js encountered 2026-05-30) — confused a code-reviewer agent into reporting false "pre-existing fails". Harness worktrees now get a `node_modules` junction to the primary checkout ([shared-guidelines.md](../shared-guidelines.md) invariant #3); test in the primary checkout anyway.

## Build pitfalls

- Building or replacing the installed app while it runs: see [shared-guidelines.md](../shared-guidelines.md) invariants #2 and #6, which hold the current rule and its incident history.

## Security

- **`clipboard-write-text` accepts any string from any renderer** — fine given the single-renderer, single-user threat model, but worth a sentence in the security model doc if one exists.
- **`remap-project` validates `newPath` via `lstatSync` (no symlink follow)** — correct since PR #20 fix. Worth a code comment noting why `lstatSync` (not `statSync`).

---

*Use these as ammunition for opportunistic follow-ups, not as a TODO list. Most of them are "nice to have" — feature work should keep taking priority.*
