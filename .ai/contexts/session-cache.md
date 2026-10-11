# Context: session-cache

**Purpose**: index every Claude session JSONL on disk into a queryable SQLite cache so the sidebar renders without re-scanning `~/.claude/projects/` and so search is full-text. Watches the projects directory for changes and refreshes incrementally.

## Key files

| File | LOC | Role |
|---|---|---|
| `db.js` | ~895 | SQLite (better-sqlite3) schema + prepared statements. Owns `session_cache`, `session_meta`, `cache_meta`, `settings`, `search_fts` (FTS5 + trigram tokenizer). |
| `session-cache.js` | ~690 | Indexer + watcher. Reads `~/.claude/projects/<folder>/*.jsonl` (+ subagents subdir), populates rows, emits projects-changed events. |
| `read-session-file.js` | ~420 | Streaming JSONL reader. `readSessionFile()` (full) + `readSessionDisplayHeader()` (256 KB / 500 lines — cheap header for huge files). |
| `encode-project-path.js` | 28 | `/path/to/project` → `-path-to-project` folder name. Mirrors Claude CLI's encoding. |
| `derive-project-path.js` | ~155 | Inverse: read `cwd` field from JSONL, derive original projectPath. **Collapses worktrees back to parent repo** via `resolveWorktreePath`. |

## Public surface

From `db.js`:

- **Sessions**: `getAllCached`, `getCachedByFolder(folder)`, `getCachedByParent(parentSessionId)`, `getCachedSession(sessionId)`, `upsertCachedSessions(rows[])`, `deleteCachedSession`, `deleteCachedFolder`
- **Meta**: `getMeta`, `getAllMeta`, `setName`, `toggleStar`, `setArchived` (session-level user state)
- **Folder meta**: `getFolderMeta`, `setFolderMeta(folder, projectPath, indexMtimeMs)` — tracks index freshness
- **Search**: `searchByType(type, query, limit, titleOnly)`, `upsertSearchEntries`, `deleteSearchType/Session/Folder`
- **Stats**: `getDailyActivity()` — `GROUP BY substr(modified, 1, 10)`, returns `[{date, messageCount, sessionCount}]` (heatmap source)
- **Settings**: `getSetting`, `setSetting`, `deleteSetting`
- **Misc**: `touchCachedModified(sessionId)` — 1-column UPDATE, cheap

From `session-cache.js`:

- `init(ctx)` — wire main process → cache (mainWindow ref for IPC events)
- `refreshFolder(folder, opts)` — opts `{files: Set<string>}` for targeted refresh (watcher payload). Defaults to full folder walk.
- `populateCacheFromFilesystem()` / `populateCacheViaWorker()` — initial scan / re-scan. The worker (`workers/scan-projects.js`) streams one `{type:'folder', result, current, total}` message per on-disk folder (plus a final `{type:'done'}`) instead of buffering the whole tree, so each folder is written to the DB and pushed to the renderer as soon as it's read — a large history no longer leaves the sidebar empty for the entire scan.
- `buildProjectsFromCache(showArchived)` — produces the sidebar payload (sorted, grouped by project, missing flag computed here). It also injects every live plain-terminal PTY from `activeSessions` as a synthetic row, so a terminal sorts among the cached sessions even though it has no JSONL; the row's `summary` is the hard-coded string `Terminal`, which is what the sidebar displays — the renderer's own session object is never the one shown. A panel shell is a plain terminal too and is excluded here by `isPanelShellSession` (`panel-terminal-target.js`); see `.ai/contexts/panel-terminal.md` for the full list of places that have to skip one.
- `notifyRendererProjectsChanged()` — throttled (~1.5s leading-edge) push to renderer
- `sendIndexingProgress()` (internal) — emits the `indexing-progress` IPC event, gated on `coldStart` (captured once at the top of `populateCacheViaWorker()` via `!isInitialScanComplete()`) and throttled to ~4 events/s (the first event and every `done:true` always pass). Feeds the renderer's first-run banner; see `.ai/contexts/ipc-bridge.md`. A `done:true` payload carrying `error` keeps the banner visible with the failure message instead of hiding it.

From `derive-project-path.js`: `deriveProjectPath(folderPath)`, `resolveWorktreePath(cwd)`.

## Invariants

- **`modified` is always ISO8601 string** (`2026-05-22T20:59:33.000Z`). `substr(modified, 1, 10)` is the canonical "day" derivation. Don't switch to epoch ms without migrating.
- **`session_cache.folder` is the encoded form** (`-home-jean-baptiste-workspace`). Use `encodeProjectPath()` to derive it from an absolute path.
- **WAL mode is enabled on SQLite open** — multiple readers OK; serialise writes. Concurrent writers will fail with `SQLITE_BUSY`.
- **`refreshFolder` is idempotent** — calling it twice with the same `opts.files` is safe; the `filePathToDbId` inverted index makes lookups O(1).
- **Header-only refresh** (via `readSessionDisplayHeader`) merges with the cached row to preserve `textContent`, `aiTitle`, etc. Don't overwrite cached fields with `null` from a partial read. For `scheduleSlug`, a visible marker replaces the cached one; a null clears it only when `scheduleSlugComplete` confirms the entire transcript was read within the 256 KB / 500-line bounds with no JSON parse failure. An incomplete negative read preserves the cached marker, including when a later user record may carry it. A failed header read keeps the existing mtime-only fallback.
- **FTS entries follow `{id, type, folder, title, body}`** shape. `type` is one of `'session'`, `'subagent'`, `'memory'`, `'work-file'`. Mixing types within one upsert is fine.
- **`get-projects` never awaits the cold-start scan.** `main.js`'s handler fires `populateCacheViaWorker()` without `await` when the cache is empty, returning whatever's cached right now (still non-empty for project *names* — `buildProjectsFromCache` lists on-disk directories synchronously even with zero indexed sessions). Progressive fill-in relies entirely on `notifyRendererProjectsChanged()` firing per folder. Don't reintroduce the `await` — it's what caused the multi-minute blocking "Loading…" on a large `~/.claude/projects/`.
- **"Cache has rows" does not mean "initial scan finished".** The worker streams one DB write per folder, so killing the app mid-first-scan leaves `session_cache` partially populated. The authoritative signal is the `initial_scan_complete` settings key: written by `session-cache.js` only on the worker's final successful `done` message, backfilled once by migration v8 for pre-marker installs (their populated caches could only come from completed batch-write scans), cleared whenever the schema-reconciliation pass wipes the cache. `get-projects` treats "rows present but marker absent" as an interrupted scan: it resumes the background worker (safe — each folder message is delete-then-insert, so re-scanned folders never duplicate) and must NOT run the synchronous `reconcileCacheFromFilesystem()` sweep, which would re-parse every missing folder on the main thread. While the marker is absent, `buildProjectsFromCache`'s empty-dir fallback also skips `deriveProjectPath()` (per-folder readdir + 256 KB read) in favor of a zero-I/O best-effort decode of the folder name (`decodeProjectFolderBestEffort`), never persisted to `cache_meta`.

## Transcript cwd trust (issue #385)

A transcript's `cwd` is trusted for a filesystem decision only if it encodes back to the name of the folder holding the transcript: `verifiedTranscriptCwd(cwd, folderName)` in `encode-project-path.js` returns the resolved absolute cwd when `encodeProjectPath(path.resolve(cwd)) === folderName`, else `null`. The seed of the schedule registry uses the same function.

The one exception is a recorded remap: `remap-project` (main process, `project-remap.js`) rewrites every transcript's cwd of the folder `enc(oldPath)` to `newPath` but cannot rename the folder, so it first records `folder -> newPath` in the `projectRemaps` setting, which only main writes and which survives a cache rebuild. `verifiedTranscriptCwd` also accepts a cwd equal to the value recorded for that folder, read through `setRemappedProjectReader` (set by `session-cache.js` `init`; the scan worker gets the map in `workerData.remaps`). No check on whether the directory exists: it would be circular.

Why: a sandboxed session can write its own transcript folder `~/.claude/projects/<enc(P)>/` and the subtree of P, so it can forge a JSONL there whose `cwd` is `P/evil` and plant `P/evil/.claude/commands/schedule-x.md`. An unverified cwd became the sidebar project path, the resume/fork spawn directory, the sandbox's `SWITCHBOARD_SANDBOX_PROJECT_FOLDER`, the target of the schedule creator's `mkdir`, and a schedule-registry entry at the next launch, where a per-launch unsandboxed choice runs the planted schedule outside the sandbox. The sandbox cannot write any other encoded folder, so a cwd that encodes to the folder it sits in is one the session could not have chosen freely.

Where it applies:

| Consumer of a transcript cwd | Status |
|---|---|
| `deriveProjectPath` (sidebar project path, `session.projectPath`, `cache_meta`, `getKnownProjectPaths`, and the cold-start scan in `workers/scan-projects.js`) | Verified: a JSONL with no cwd that verifies, in its head or tail window (see "A transcript moved into a worktree folder"), is skipped, then the worktree collapse applies to the verified cwd; no verified JSONL gives `null` |
| `refreshFolder` reuse of a stored `cache_meta.projectPath`; `buildProjectsFromCache` (empty-folder section); `reconcileCacheFromFilesystem` | Verified by `storedProjectPathMatchesFolder` (the verified path, the repository of a worktree folder, or the remap record). A value stored before the upgrade is re-derived: `reconcileCacheFromFilesystem` refreshes a folder whose stored path fails the check even when its mtime is current, and `refreshFolder` rewrites a cached row whose `projectPath` differs from the folder's even when its file is unchanged. A folder with no verifiable transcript has its cached rows deleted |
| `resolveSessionRealCwd` (resume and fork spawn cwd in `open-terminal`, Changes panel, panel terminal, terminal path links, subagent worktree discovery, the sandbox bind folder, which follows the spawn cwd) | Verified against the folder holding the session's JSONL, which main finds on disk; a transcript that does not verify is skipped for the next folder holding the same id; none left means resume starts in the requested project path as for a session without a recorded cwd |
| `create-schedule-session` `mkdir enc(projectPath)` and `open-terminal` registration of `projectPath` | The path comes from the sidebar, so from `deriveProjectPath`; the registration stays a plain launch registration |
| Remote hosts | Not verified: a remote cwd is a path on the host, `deriveProjectPath` takes `{ remote: true }` there, and nothing local is opened from it |
| `resolveSessionRealCwd` for a worktree session | Kept: its JSONL lives in `enc(P/.claude/worktrees/x)` and its cwd encodes to that folder |

A folder that holds transcripts with a cwd but none that verifies is logged once per folder, `[session-cache]` prefix with the folder name and the first rejected cwd (main log; the cold-start worker reports it through its folder message), so a change of the CLI's naming shows up in the log instead of as projects silently missing.

Residuals: `encodeProjectPath` truncates at 200 characters and appends a 32-bit hash, so a path of 200 characters or more can collide (`enc(P/long) === enc(P)`), seed included. The hash is taken over the raw characters of the path, as the CLI does; normalising before hashing would stop matching the CLI's folder names, so it was left alone (the verified cwd is already `path.resolve`d before it is encoded). A transcript written by the CLI whose cwd does not encode to its folder (a symlinked cwd named by its real path, say) no longer gives a project path or a resume directory. A `projectPath` persisted by session restore before the upgrade is not re-verified; the renderer's own strings are out of scope.

## Bounded cwd scan

A transcript's cwd is read from bounded windows of the file (`CWD_SCAN_BYTES`, 256 KB, in `derive-project-path.js`), never from the whole of it. Reading the whole file froze the main process: `refreshFolder()` derives the project path on every watcher flush, so a 338 MB host-session JSONL meant a multi-second `readFileSync` per flush, back to back (witnessed 2026-06-11: main thread pegged ~65% CPU re-reading the same file in a loop, UI freezes). A cwd that appears only between the head and tail windows is not seen.

## A transcript moved into a worktree folder

When a session started at a repository's root enters a worktree (`EnterWorktree`), the CLI moves its transcript from `enc(P)` to `enc(P/.claude/worktrees/x)`; the old folder can disappear with it. The lines written before the move keep `cwd = P`, which does not encode to the new folder; only the lines written after carry the worktree's cwd. Witnessed 2026-10-07 with a 600 KB transcript: the first worktree cwd sat at byte 483 010, past the 256 KB head window, so `deriveProjectPath` returned `null` for the folder, `refreshFolder` dropped it, and the session, whose transcript had also left `enc(P)`, vanished from the sidebar while its PTY kept running.

`extractVerifiedCwdFromJsonl(filePath, folderName, tailBudget)` returns the first cwd of the head window that verifies against the folder. The first rejected cwd ends the scan, as the head-only scan did, unless the folder may be a worktree folder of that cwd or of one of its ancestors (`mayBeWorktreeFolderOf`; a session started in `P/sub` moves the same way); then the rest of the head and, failing that, the file's last 256 KB are searched, last line first. The trust rule is unchanged: whichever line it comes from, a cwd is used only if it encodes to the folder holding the transcript.

- **Long paths.** `encodeProjectPath` truncates a name over 200 characters and appends a hash of the whole path, so the folder of `P/.claude/worktrees/x` does not start with `enc(P)` when either is long. `mayBeWorktreeFolderOf` compares through `encodedFolderMayExtend` (`encode-project-path.js`), which applies the encoder's sanitising and its 200-character cut to `P/<worktree dir>/` and compares that prefix only. It is a gate for reading more of the file, not a trust decision, so a false positive costs one bounded read and nothing else. `storedProjectPathMatchesFolder` keeps its own exact prefix check.
- **Cost.** One derivation (`deriveProjectPath`) gives the tail reads a budget of four windows (1 MiB). A transcript whose tail was skipped for lack of budget, or whose stat, open or read threw (`EBUSY` while the CLI holds it, say), is not memoised, and the derivation reports itself incomplete (`opts.onIncomplete`); so does a failed listing of the folder or of a session subdirectory. The next derivation of the folder starts its walk of the folder's transcripts at the first one skipped for budget (`resumeAt`, per folder, at most 1 024 folders; a transcript that failed is retried but never becomes the starting point, so one that keeps failing cannot hold the walk back), so a valid transcript listed after more unresolved ones than one budget covers is reached even when the memo cannot hold them all. `refreshFolder` then stores the folder's `indexMtimeMs` as 0 instead of its mtime, so `reconcileCacheFromFilesystem` derives it again on its next pass; each pass reads only the transcripts not yet memoised, so the folder resolves, or is marked indexed as unresolved, after a bounded number of passes. Every transcript found unresolved after a complete scan is memoised by path, size and mtime (`unresolvedMemo`, at most 4 096 entries), and is not read again until it changes. A remap rewrites the transcripts it remaps, so it changes their mtime and clears their memo. A file rewritten to the same size with its mtime restored keeps a stale memo; the CLI only appends, so this is not a case it produces. Measured on a folder of 50 rejected 660 KB transcripts: 7.9 ms per flush with the former head-only scan, which read every head on every flush; 0.64 ms per flush averaged over repeated flushes with the memo, the first pass reading the heads as before.
- **Callers.** `deriveProjectPath` (local) and `resolveSessionRealCwd` go through it; the remote path keeps the plain head scan. The Touched panel does not: it resolves a relative touched path against one cwd per transcript, and the worktree cwd of a moved transcript is wrong for the touches made before the move. It keeps the head-only `extractCwdFromJsonl`, so the moved transcript's head cwd, which does not verify, leaves those touches unresolved.
- **Residual.** A transcript whose last line alone exceeds 256 KB (a large tool result) has no complete line in the tail window. While its session runs, the row is kept (next section); after exit, the folder resolves again only once a later line carries the worktree's cwd.

## A running session keeps its row

`dropFolderRows(folder, { search })` (`session-cache.js`) deletes a folder's `session_cache` rows except those of a session with a live, non-plain PTY in `activeSessions` (`exited` false), and deletes the whole folder only when no row is kept. It is the path for every deletion that follows from the disk: a folder that has vanished (`refreshFolder`'s first branch and the watcher's `flushChanges` in `main.js`), a folder that stops resolving to a project, and a cold-scan folder with no verifiable transcript. `refreshFolder` applies the same rule to a single transcript missing from its folder (full walk and targeted). Deliberate deletions (hide or remove a project, drop a remote host) still use `deleteCachedFolder`.

A kept row is recorded with its folder. On PTY exit, `main.js` calls `releaseLiveSession` for both ids after removing them from `activeSessions`; it refreshes that folder again, which drops the row if its transcript is still gone. That call is the exit handler's only database access and is wrapped in a `try`: at quit, `before-quit` kills the PTYs and `will-quit` closes the database, so a late exit event can meet a closed connection. A transcript that leaves a folder while its session runs therefore leaves the session in the sidebar until it reappears elsewhere, where the upsert on the same `sessionId` replaces the row's folder.

## Non-obvious behaviors

- **`resolveWorktreePath` collapses `<repo>/.worktrees/<name>` → `<repo>`** when the parent dir exists. Consequence: many `~/.claude/projects/-home-...workspace-myproject--worktrees-X` folders derive to the same projectPath. Callers must dedupe (see `get-work-files` IPC for the pattern).
- **Two-table sidebar payload**: projects are aggregated, but each session row has its own `subagentType` field. A `null`/empty `subagentType` means it's a parent session; anything else (e.g. `'general-purpose'`, `'researcher'`) marks a subagent.
- **`fs.watch` debouncing**: the watcher batches per-folder events in a `pendingChanges = Map<folder, Set<filename> | true>` for ~200 ms before flushing to `refreshFolder`. A `true` value means "full walk needed" (rare path).
- **The same raw watcher callback also feeds a second, lighter-weight signal that bypasses this debounce entirely** (issue #246 step 4): for a top-level session transcript with no live PTY in `activeSessions`, it sends `session-transcript-activity` straight to the renderer, coalesced to ≤1/s per session by `local-transcript-activity.js`. This exists so a session launched outside Switchboard gets a busy indicator without waiting on the cache refresh — see `.ai/contexts/session-state.md` ("The local-transcript adapter") and `.ai/contexts/ipc-bridge.md`.
- **A session's title comes from its first *real* user turn, and a transcript without one is not indexed.** `classifyUserText()` in `read-session-file.js` sorts each user record into `prompt` / `command` / `skip`. `skip` is local-command bookkeeping (`<bash-input>`, `<bash-stdout>`, `<local-command-caveat>`, `<local-command-stdout>` — the CLI writes a command's own output back as a `user` record too); `command` is a bare slash-command record, recognised by a `<command-name>` tag next to a `<command-message>` or `<command-args>` one — the CLI writes both orders (`<command-name>` first for `/clear`, `<command-message>` first for `/auto-compact` and `/pre-compact`), so neither tag can be required to come first. The `skip` test is anchored to the start of the record: a real prompt that *quotes* `<local-command-stdout>` (a pasted transcript excerpt) is a turn, and skipping it can leave a session with no indexable prompt at all. This matters because **`/clear` opens a NEW jsonl and writes only that bookkeeping into it**; `/model`, by contrast, is written into the transcript that is already open, so it is a summary candidate only when it lands before any real prompt. Taking a `command` record as the summary therefore (a) titled every session started by `/clear` "`/clear clear </com…`" (the raw tags survive `cleanDisplayName`'s tag strip as a truncated fragment) and (b) indexed the bookkeeping-only transcript as a phantom sidebar session that the user never started. A `command` record is now a *fallback* title, used only when the transcript also holds an assistant turn (`/code-review high` → a real headless-command session); with no assistant turn both readers return `null` and nothing is indexed, matching how a brand-new session stays out of the sidebar until its first prompt. Rows written by the pre-fix parser cannot self-heal — the phantom ones sit on a file that never changes again, and the real ones keep the bad title because the header-only refresh path only overwrites a summary it can re-derive — so `db.js` migration **v9** purges rows whose summary starts with `<command-name>`, `<command-message>` or `<local-command-stdout>` — from `session_cache`, the three search tables and `session_metrics` (a phantom's file is never re-read, so its metrics would inflate the heatmap and the totals forever) — plus the `cache_meta` gate of their folders, which makes the next reconcile re-read exactly those files. The whole purge runs in one transaction: it cannot be resumed, since the relaunch that follows an interrupted run is already at db_version 9 and no longer matches the rows it dropped.
- **Stats `firstSessionDate`** is computed from `MIN(modified)`, not `MIN(created)`. Old sessions touched by recent reads keep their original `created` but their `modified` reflects the latest indexing — by design (the heatmap measures activity, not creation).

- **`main.js`'s `ctx.db` is a hand-built allow-list, not a spread of `db.js`.** `main.js` (~line 323) passes `sessionCache.init({ ..., db: { deleteCachedFolder, getCachedByFolder, upsertCachedSessions, ... } })` as an explicit object literal — it does **not** do `db: require('./db')`. If you add a new function to `db.js` and call it from `session-cache.js` via `ctx.db.<name>`, but forget to add it to both this literal *and* the `require('./db')` destructure at the top of `main.js`, `ctx.db.<name>` is `undefined`. The resulting `TypeError` is thrown inside `populateCacheViaWorker`'s `worker.on('message')` handler, which has no `try/catch` — it lands on stderr (not `electron-log`) and silently aborts the cold-start indexing write loop. Symptom: the log shows `Indexing N projects…` but never `Indexed N sessions across …`, and the affected table stays empty. Guarded by `test/main-ctx-db-wiring.test.js` (static source-grep asserting the allow-list ⊇ every `ctx.db.*` dereference in `session-cache.js`) — run it whenever you touch this boundary, but also update the allow-list by hand since the test only catches *missing* entries, not the intent.

- **`search` IPC is routed through a dedicated worker thread, with a bounded query.** Historically `ipcMain.handle('search', ...)` ran the `better-sqlite3` FTS5 `MATCH` query synchronously on the Electron main process — a long pasted string (e.g. a GitLab MR URL) became a ~58-trigram phrase intersect that pinned the main thread for up to ~60 s and froze the whole app (witnessed 2026-06-22). Two guards now exist: (1) `searchByType()` in `db.js` truncates the query to `FTS_QUERY_MAX_CHARS` (48) before building the MATCH expression; (2) the `search` IPC goes through `searchViaWorker` (`search-worker-client.js` + `workers/search-query.js`) so even a slow query can't block IPC dispatch. The client falls back to the synchronous main-thread `searchByType` only when the worker isn't ready (first-launch race, or circuit-breaker open after repeated worker failures) — the length cap makes that fallback safe. Protocol logic (correlation IDs, drain, backoff, restart storm guard) is unit-tested in `test/search-worker-protocol.test.js`; the cap in `test/db-search-query-bound.test.js`.

- **A manual `/compact` leaves a second transcript ("mirror") for the same session; it is merged on `bridgeSessionId`, not on file order, and NEITHER file is discarded (issue #197).** The CLI writes a `{"type":"bridge-session","bridgeSessionId":"cse_..."}` bookkeeping record into a transcript once bridging is established; both the pre-compaction file and the mirror it continues into carry the SAME `bridgeSessionId`. Measured on a real pair (16 MB parent + 3.1 MB mirror, same folder): **neither size nor first-event date tells them apart** — the mirror is *smaller* (it starts fresh at the compaction point) and *looks newer* (its first event is the compaction timestamp, later than the parent's). The parent's very last line is a `{"type":"continued-in","continuedInSessionId":"<mirror>"}` marker, after which the parent file goes quiet; the mirror keeps receiving new lines afterward — **the CLI keeps writing to the mirror, not the parent, once compaction happens.** `continued-in` is NOT a safe merge signal by itself: the same parent file carried a *second* `continued-in` record earlier, pointing at a transcript with a completely different `bridgeSessionId` (a genuinely independent session) — only a `bridgeSessionId` match is trustworthy.
  - **First cut of this fix kept the earliest file and dropped the mirror outright — wrong, caught in review before merge.** Given the CLI keeps writing to the mirror, discarding it forever would make every post-compaction message invisible to the cache: a session that compacts and keeps working loses all *later* activity, which is a worse failure mode than the double-count it replaces (double-count is a visible cost anomaly; silent loss of live activity is not visible at all, and this machine compacts routinely — nominal case, not an edge case). The design below is a real union instead.
  - **Copied tails often retain timestamps, but time order does not establish identity.** An independent member can have thousands of its own messages before another member's `modified`. Complete conversation UUID coverage permits an exact union: exclude the UUIDs already present in preceding members. Timestamp cutoffs remain a compatibility fallback for legacy transcripts, with the limitations below.
  - **Detection is full-read-only.** `readSessionFile()` extracts `bridgeSessionId` from the first `bridge-session` record it sees; `readSessionDisplayHeader()` (the incremental/header-only refresh path, capped at 256 KB / 500 lines) never attempts it, because the record is not reliably near the head of the file — on the real mirror fixture it sat at byte ~3.08 MB of a 3.08 MB file, past the cap. A `readSessionFile()` full read still happens once per file, the first time it's seen (the "NEW file" branch of `refreshFolder`), so the value is captured and then persisted in `session_cache.bridgeSessionId`, carried forward unchanged by every later header-only merge.
  - **Members with a contribution keep their own `session_cache` rows.** `mergeBridgeGroups` groups top-level rows by `bridgeSessionId` and orders them by `created`, then `sessionId`. With complete UUID coverage, each contribution excludes preceding UUIDs, even when its own messages have older timestamps. A continuation attaches to the predecessor with the most shared UUIDs, breaking ties by the latest shared position in its message sequence and then predecessor `modified`; a merged predecessor resolves to its visible root. If that predecessor has later activity, or there is no shared UUID, the contribution remains independent. Pure duplicates contribute no row.
  - **Cached merge labels do not prove that a group is still correctly derived.** Top-level changes, new members and deletions in a cached bridge folder queue a file-subset worker scan including all its cached bridge members and the changed files. The worker re-evaluates their current full histories, removes gone predecessors before merging, and rewrites contributions, metrics and search entries together through the existing scan-result path. This also restores shared UUIDs when an independent member is promoted after the earlier owner disappears. Concurrent watcher requests for the same folder are combined into subsequent batches; an unchanged group is stat-only and does not run another worker.
  - **`mergedIntoSessionId` rows are excluded from sidebar/session-count listings, but their contributions count in message/token aggregates.** `buildProjectsFromCache` rolls the contributions and activity onto their visible root; `getTotalCounts().totalSessions` excludes merged rows. Complete UUID coverage makes the contributions disjoint by message identity, not by timestamp: their date ranges can overlap. A plain `SUM` of `session_metrics` therefore remains correct. The older `getDailyActivity().sessionCount` still counts physical merged rows, its pre-existing disclosed approximation.
  - **Residual gaps, named rather than hidden**: (1) the transcript viewer (`read-session-jsonl`) still resolves a sessionId to exactly one physical file, so opening the *merged* (winner) session shows only its own pre-compaction content — post-compaction content is visible only by separately finding the mirror's own row/search hit, not through a stitched view. (2) FTS search body for the winner is built from its own `textContent` only (pre-compaction text); the mirror keeps its own, separate search entry (its post-compaction `textContent`), so post-compaction text is findable but surfaces as a second, unlabelled-in-the-sidebar search hit rather than under the visible session's own entry. Both are scoped follow-ups, not silently-accepted data loss — nothing here drops tokens, messages, or the ability to eventually find the content, only the "one unified view" polish.
  - **Winner tie-break is `created`, then `sessionId` string order, and can be picked "wrong" in a narrow case**: if a session is short enough that the mirror's recopied context window covers its *entire* history, the mirror's own unfiltered `created` can tie the true parent's. The sessionId string tie-break is then arbitrary. This does not affect correctness of totals (the group still partitions all activity with no double-count either way) — only which of the two sessionIds ends up as the visible "primary" one. Not fixed here; flagged for whoever hits it.
  - **Open question #1 (absence)**: a transcript with no `bridgeSessionId` is never grouped with anything — `mergeBridgeGroups` only builds a group when the field is a non-empty string, so old-format transcripts and any layout that never emits the field simply keep their own row, exactly like today.
  - **Open question #2 (which file keeps being written)**: established by measurement above — the mirror, not the parent. That is exactly why the mirror is never discarded: dropping it would silently erase every message written after the compaction, for as long as the session keeps being used. The union design keeps both files' rows, forever, each independently refreshed.
  - **Open question #3 (existing databases)**: repaired on the next index pass, not left alone. `bridgeSessionId` and `mergedIntoSessionId` are added purely via the schema-reconciliation block (not a numbered migration — deliberately, to avoid coupling `migrations.length` to unrelated migration-ordering tests; see `db-schema-reconcile.test.js`'s "foreign higher-version" precedent for why reconciliation is the version-independent mechanism). Their absence sets `mustReindex = true`, which wipes `session_cache` + `cache_meta` + the `initial_scan_complete` marker, forcing every folder through the now-merging indexer on the next scan — the same repair path already used when `fileMtime` (v7) or the fork subagent columns (v4) were introduced.
  - **"Open on claude.ai" (issue #213).** `buildProjectsFromCache` passes `bridgeSessionId` to the renderer (`null` when absent). `bridgeSessionUrl()` in `public/bridge-url.js` turns it into `https://claude.ai/code/session_<suffix>`: the transcript record carries `cse_<suffix>`, the CLI descriptor and the web URL carry `session_<suffix>`, and the suffix is the same (measured on local transcripts that mention both forms). Any other shape, or an id with a character outside `[A-Za-z0-9]`, gives no URL and the row shows no button. The button (`.session-bridge-btn` in `buildSessionItem`) opens the URL through `window.api.openExternal`, whose main-side handler already refuses anything but `http(s)`.

- **Working-set restore retries until indexing is done, not once.** `populateCacheViaWorker` streams `sessionMap` one folder at a time on a cold start, so a saved working-set id can be missing for many ticks before it's genuinely indexed. `createRestorePlanner()` (`public/restore-plan.js`) is ticked from every `projects-changed` handler and from `updateIndexingBanner` on `payload.done`; it keeps returning `'wait'` until every saved id is indexed or indexing is over (then the rest is presumed deleted), restoring incrementally in `auto` mode and asking once (`askOnce: true`) in `ask` mode instead of re-prompting per tick. The end of indexing reaches the renderer on its own `indexing-finished` channel, sent at the end of **every** `populateCacheViaWorker` run, warm start included: `indexing-progress` is first-run only, so a warm start never told the planner that indexing was over and a saved session missing from the index left the "Finishing indexing" toast up for good. When the planner gives up (indexing over, or the tick cap) it returns the saved entries it never found as `unavailable`, and `tickRestorePlanner` names them in a "Not restored" notice. The end is also pullable (`get-indexing-state`, read once when the planner starts) because the startup scan can finish before the renderer listens, and `markRestoreIndexingDone` reloads the projects before the final tick because the last folders may not have reached `sessionMap` yet. See `test/session-restore-cold-cache.test.js`, `test/restore-unavailable.test.js`. A persist during that window keeps the entries not resolved yet (`pendingRestoreEntries`: the planner's pending ones, the ones awaiting the restore toast, and `restoreInFlight`, those handed to `runRestore` while their live-elsewhere check and open are awaited, even across two overlapping restores), otherwise any click or close would erase them from `openWorkingSet` before they are reached; see `test/restore-pending-persist.test.js`. A saved entry marked `fresh` (a local session with no transcript yet, see docs/session-restore.md) counts as indexed for the planner, and `runRestore` starts a new session in its project for it; see `test/clear-pending-persist.test.js`.

- **Neither the working-set restore nor the reload path resumes a session that is live in another process.** `runRestore` and the post-`loadProjects` re-open of `sessionStorage.activeSessionId` call `openSession(..., { automatic: true })`, which skips the session without a prompt when `guardResume` reports it live elsewhere; the skipped entry is not activated, stays in the persisted working set at its saved position, and is reported by a one-line notice. See `.ai/contexts/cli-session-state.md` ("Live elsewhere").

- **`session_cache.scheduleSlug` holds nullable schedule provenance.** The runner writes the schedule identity on its pre-seeded user record. Schema reconciliation adds this column without a reindex or cache wipe; runs indexed before the marker stay null unless their transcript supplies it on a later read. A prompt prefix or matching CLI slug does not establish provenance. See `.ai/contexts/schedule-runner.md` for grouping and historical-run limits.
- **SDK-launched sessions are hidden from the project list, not from the index.** Programs driving Claude through the Agent SDK (the brain-runner's `claude -p` episodes, a Python review tool spawning one session per file batch, strap's developers) write ordinary top-level transcripts in the project's folder: `isSidechain: false`, no `subagents/` directory, and no record pointing back at the session that started them. They cannot be nested under a parent the way Task subagents are; the only reliable marker is the `entrypoint` field the CLI stamps on every record (`cli` when typed in a terminal, `sdk-cli` / `sdk-py` / `sdk-ts` for the SDK; measured 2026-10-07: ~4 500 SDK transcripts against ~540 interactive ones on one machine). Rows stay in `session_cache`, `session_metrics` and FTS, so the heatmap and token totals still count that activity.
  - **What `session_cache.entrypoint` holds.** The first `type: 'user'` record's `entrypoint`, or `cli` as soon as any user record says `cli` (an SDK session someone resumed and typed into is theirs again — 5 strap developer transcripts measured). `''` when the first user record carries none: a scheduled run is pre-seeded by `createScheduleSession` without one, then resumed by `claude --resume -p` whose records say `sdk-cli`, and must stay visible. A non-string value counts as none. `NULL` means not read yet.
  - **The column is added without a cache wipe.** Unlike the other reconciliation columns it does not set `mustReindex`: `db.js` runs before `requestSingleInstanceLock` in `main.js`, so a refused second launch would empty the running instance's cache, and a scan failing after the wipe would leave the app empty. Existing rows keep `NULL`, which `buildProjectsFromCache` treats as visible, and `backfillEntrypoints()` (started from `get-projects`, once per process, 200 rows per `setImmediate` tick) fills them with `readSessionEntrypoint`.
  - **`readSessionEntrypoint` avoids reading interactive transcripts.** It reads 256 KB chunks until the first user turn (an SDK prompt is first written as a `queue-operation` line that can exceed 256 KB on its own: 190 of ~4 500 SDK transcripts measured); a non-SDK one is returned as is (so a session pre-seeded without an entrypoint and later typed into stores `''` here but `cli` from `readSessionFile`; both are visible, only `sdk-*` matters), and only an `sdk-*` one is scanned further for a `cli` user turn, in full up to 2 MB, and beyond that only its first and last 256 KB on the live path (`refreshFolder` runs it at every watcher flush, and the turn just typed is at the end; a full read of a 14 MB transcript costs ~250 ms of main thread), but in full from `backfillEntrypoints`, which runs once per row (sizes measured over 4 495 SDK transcripts: p50 44 KB, p99 711 KB, max 13 MB). `refreshFolder` calls it on the header-only branch for a cached `sdk-*` row, because a turn typed in a terminal lands at the end of the file, beyond the header.
  - **What stays listed.** `hiddenSdkSessionIds` hides `sdk-*` rows while the global `hideSdkSessions` setting (default on) is set, except a session open in a terminal (`activeSessions`, not exited) or in the saved working set (`global.openWorkingSet`), so neither disappears from under the user nor fails to restore, and except a parent whose compaction mirror (`mergedIntoSessionId`) is not SDK. Subagent rows of a hidden session are dropped too (they would otherwise land in "Orphan subagents"), and a project left with only hidden rows gets no empty header from the on-disk folder pass. Because `activeSessions` is read when the list is built, opening an SDK session afterwards (a resume from search, a trigger, a remote attach) calls `revealIfSdkSession`, which sends `projects-changed` so the renderer reloads the list with it. The saved-working-set exemption only holds while the entry stays in `openWorkingSet`: `persistWorkingSet` (`public/app.js`) re-adds the entries the restore has not resolved yet (`restorePlanner.pending()`, and `restoreAwaitingConsent` while the restore toast is unanswered), so a persist in the middle of a cold restore does not drop a saved SDK session that is not indexed yet.

## Bridge history divergence

Issue #524: a shared `bridgeSessionId` is not proof that all messages before a
previous member's `modified` are copies. An older member can keep receiving
messages after a newer member stops; the timestamp cutoff then discarded every
message of the newer member, omitting its row on full scans and deleting an
already-cached row on incremental scans.

`readSessionFile` returns transient conversation UUIDs, coverage and message
payload signatures. Complete UUID coverage deduplicates title selection, search
body, counts and daily metrics against the preceding UUID union without changing
original timestamps or file mtime. An own assistant reply retains an inherited
prompt as its display title while excluding that prompt from counts and search.
The arrays are removed before worker `postMessage` and database upserts.

Ordinary watcher flushes retain the incremental strategy: unchanged files are
skipped, changed cached files use the bounded display header and the existing
shared continuation-index budget. Neither refresh nor warm reconciliation queues
a full scan of unchanged bridge members. Both functions return synchronously;
folder freshness is stamped before they return. Counts, FTS bodies and bridge
labels stay cached until members are fully read anyway, just as other live
transcripts do. Full scans and new-member merges attach continuations to the
UUID-sharing predecessor's visible root rather than the earliest unrelated member.

New-member discovery retains the round-one main-thread merge. A new bridged file
can cause its predecessors to be read in full to compare UUIDs; this is a rare
compaction/discovery event, but a 200+ MB predecessor can still block the interface
and increase main-thread memory. Moving this one-off discovery merge to a worker
is follow-up work, not part of ordinary flushes. Deleting a predecessor similarly
re-reads surviving members once, restoring UUIDs and metrics removed by the old
winner, including an independent promoted member. Remote deletion-only subsets
perform this restoration in their existing worker; ordinary subsets no longer
expand to all cached bridged files.

Legacy transcripts with no known UUID evidence retain the timestamp fallback
when it contributes messages. When the fallback is empty, or any UUID evidence is
available but a predecessor lacks complete coverage, full histories are compared
using known UUIDs and role/message payload signatures. Distinct known UUIDs
always remain distinct even when their text is identical. Signatures compare
payloads only when at least one side lacks a UUID. Copied payloads are
excluded from a recovered row's title candidates, body, counts and metrics, while
its distinct messages survive. Equal UUID-less payloads cannot distinguish an
independent repeated turn from a copy; timestamp fallback on wholly UUID-less
histories can also omit distinct older turns. This is a disclosed legacy
limitation, not an exact identity guarantee. An unreadable predecessor does not
establish overlap; a readable member with its own contribution stays independent.

At database open, `bridge_uuid_index_version = 1` records a one-time transaction
that removes only bridged top-level cache rows, their metrics and their FTS
entries, and clears the affected folder gates. Subagents, unrelated rows,
settings and user names/stars/archive state remain. Errors roll back the entire
transaction, emit a warning and allow `db.js` to load; the version stays unset
and the next database open retries. Successful subsequent opens are no-ops.

The repair transaction also saves exactly the affected folder keys in
`bridge_uuid_reindex_folders`. At cache initialization, one worker scans only
those local folders. Pending folders are excluded from synchronous reconciliation and watcher refresh
until their worker write, so a flush during repair cannot recreate invalidated
rows through a main-thread full read;
`get-projects` cannot turn an emptied warm cache into a global population scan
while local repair is pending. A successful folder write clears its pending key;
the worker's completion also releases local gates on failure, allowing watcher
refresh and stat-gated reconciliation to recover without restarting the app or
retrying the repair worker. Interrupted cold-start population keeps its existing route.

Repaired remote folder gates remain absent until the remote indexer's existing
full-folder worker scans the mirror, even if SSH reports no changed files. That
write clears the remote pending key. Dropping a cached remote folder clears its
key, and `get-projects` removes pending keys of aliases no longer declared, even
without folder metadata. Remote pending keys never block local cache/search
population. Merely listing on-disk projects never stamps
remote `cache_meta`. Worker full-folder replacement and subset deletions honour
`keepIfRunning`, preserving active PTY rows, metrics and search until release.

Payload signatures are lazy, non-enumerable transient evidence: fully identified
UUID histories retain no transcript lines and build no signatures. Their getter
is created outside the reader's scope and re-reads the file only if a mixed-coverage
comparison needs signatures. Incomplete UUID histories keep the already-read lines
for that lazy fallback. Evidence is deleted before persistence or worker messages.

## Remote SSH hosts (issue #201)

A declared SSH host's `~/.claude/projects` is mirrored into
`<dataDir>/remote/<alias>/projects/` and indexed as a **second projects root**.
Observation only: a remote session is read, searched and counted, never resumed
or deleted from here.

- **The local path is unchanged when no host is declared.** `remote-index.js`
  `start()` returns false before touching anything if `enabledHosts()` is empty:
  no `setInterval`, no ssh, no mirror directory. `session-cache.js`'s
  `remoteRoots` map stays empty, so `resolveFolderDir()` is `path.join(PROJECTS_DIR, folder)`
  and `buildProjectsFromCache`'s root list has exactly one entry — the same
  `readdirSync` it always did. Proven by `test/remote-index.test.js` (a transport
  and a `sync` that throw on any call) and `test/remote-indexing-e2e.test.js`.

- **Folder keys are `<alias>::<folder>`.** `encodeProjectPath` emits only
  `[a-zA-Z0-9-]` (`encode-project-path.js:5`), so `::` cannot occur in a local
  key and a remote key can never collide with one. `parseFolderKey`
  (`remote-hosts.js`) refuses a prefix that is not a valid alias, so a local
  folder whose name happens to contain `::` still reads as local. Local rows keep
  their current unprefixed form — nothing migrates.

- **The primary key is NOT namespaced, and that risk is accepted here in
  writing.** `session_meta.sessionId` and `session_cache.sessionId` stay global
  PKs (`db.js:51`, `db.js:60`). Two hosts whose CLIs generate the same session id
  would overwrite each other's star, title and archive state, and one host's row
  would shadow the other's in the sidebar. The ids are CLI-generated UUIDv4 and no
  collision exists in the measured data (255 transcripts on the probed host, 2026-09-07).
  Migrating the PK to `(host, sessionId)` touches every table, every IPC payload
  and every renderer id — it is not worth doing before a second host exists.
  **If you ever see two sessions fighting over a star or a title, this is why.**

- **The mirror is pulled on a timer, floored at 60 s, as the reconciliation
  path — it never goes away.** `fs.watch` cannot cross SSH
  (inotify/FSEvents/ReadDirectoryChangesW are kernel-local), and the local
  watcher at `main.js` `startProjectsWatcher()` is deliberately not pointed at the
  mirror — it would fire on our own `scp` writes, not on remote activity.
  Issue #240 adds a push channel alongside it (below) so a live host is not
  stale for up to 5 minutes; the pull remains the ground truth and the only
  path for a host with no push channel (see below).

### Remote hosts — ssh and scp binaries (issue #359)

`remote-ssh-binary.js` is the one place that decides which `ssh` and `scp` run;
the order is user-facing and stated in `docs/remote-hosts.md` ("Which ssh and
scp run"). What the code relies on:

- **One value for every consumer.** The attach PTY is spawned with the home
  directory as cwd (`main.js` `spawnPty`), the `child_process` sites with the
  app's cwd. A relative value, or a bare name looked up late, could name two
  binaries; the resolver therefore returns an absolute path whenever it finds
  one (the PATH is searched by the resolver itself, relative PATH entries
  skipped) and ignores a relative `SWITCHBOARD_SSH_PATH`/`SWITCHBOARD_SCP_PATH`
  with a warning. The bare name is returned only when nothing was found.
- **scp is given its ssh.** `scp` starts its own ssh from a path compiled into
  it, not from `SWITCHBOARD_SSH_PATH`; `fetchOne` passes `-S <resolved ssh>` so
  the copy uses the same client as everything else.
- **Searched once per process, re-checked with one probe.** A search probes
  the disk (PATH entries, then the system candidates); on Windows a UNC entry
  can stall the main thread, and `fetchFiles` copies files in the hundreds. The
  result is memoised in the module. A path the search found is probed again on
  each call, one `stat` of a known file, so an `ssh` removed or upgraded away
  is searched for again instead of failing with `ENOENT` until a restart. A
  configured value and the bare-name fallback are not re-checked: the first
  would re-resolve to itself, and the second would redo the whole search on
  every spawn. `resetResolvedBinaries()` exists for tests, and
  `createBinaryResolver({ env, platform, isExecutable, log })` gives a
  resolver with no process state. `main.js` hands it the app log with
  `setResolverLog`.
- **No shell.** Every spawn is shell-less. On Windows Node refuses a `.cmd` or
  `.bat` without a shell (`EINVAL`), so such a value is kept, and a warning
  says to name an `.exe` instead.

`test/remote-ssh-spawn-sites.test.js` holds the guarantee that nothing bypasses
the resolver. It parses every main-process module (root `*.js` and `workers/`)
with espree and eslint-scope and follows the values that reach a spawn:

- **Spawners.** A call is a spawn site when its callee evaluates to a
  `child_process` or `node-pty` function, however it was reached: a
  destructuring rename, a member of the `require` result, an alias of the
  module, an `opts.spawn || …` default. Spawners injected purely through
  options (`spawnPtyFn`) are listed by hand.
- **Programs.** Each site's program argument is followed through constants,
  destructuring, defaults, `path.join`'s last segment, and a local wrapper's
  callers (`run` in `remote-transport.js`). The verdicts are: a resolver call,
  another literal (`git`, `powershell.exe`, `process.execPath`), an ssh/scp
  literal (a bypass), or unresolved. Module names are matched with or without
  the `node:` prefix.
- **Failures.** A bypass fails the test, and so does an unresolved site outside
  `UNRESOLVED_ALLOWED`, where each entry names its enclosing function and why its
  program is not ssh. A second test fails on a spawning call — a
  `child_process`/`node-pty` function, or a wrapper in `SPAWN_WRAPPERS` such as
  `runToExit` — that passes an ssh/scp name as its first argument, in any
  module; it covers the callers of exported wrappers. Each failure message says
  what to change.
- **Enumeration.** The resolver-backed sites are compared to an explicit table,
  so a new one is noticed. The scanner is itself tested on fixtures that
  reproduce each known evasion.

### Remote hosts — watch channel (issue #240)

`remote-watch.js` keeps one long-lived `ssh -tt … inotifywait` child per
declared alias and calls `remoteIndexer.refreshHostNow(alias)` (the periodic
cycle's per-host entry point) on a coalesced "this host changed" signal —
never on every line, and never in place of the periodic pull. Full rationale,
the exact remote command, and the mutation proofs are in
`.work-files/switchboard/remote-watch-report.md`.

- **One `ssh` inventory, then only the deltas.** `remote-transport.js` runs
  `find .claude/projects -type f -name '*.jsonl' -printf '%T@	%s	%P
'` over
  a single ssh call and compares `(size, mtimeMs)` against
  `<dataDir>/remote/<alias>/inventory.json`. `rsync` is not used because it is
  absent on this Windows machine (measured); `ssh2` is not used because it would
  drag an optional native addon into the `electron-builder` pipeline. First pull
  moves the whole tree (249 MB on the probed host) as one `scp` per file at
  concurrency 4 — slow once, near-free afterwards.

- **Every child process is bounded and reaped.** Each `ssh`/`scp` gets a timeout
  that `SIGKILL`s it, every child is registered in a live set, and
  `remoteIndexer.stop()` (wired to `before-quit`) kills whatever is left. On
  Windows a child outlives the death of its launcher — on 2026-09-06 an unbounded
  load left 24 orphans at 100% CPU on this machine.
  **That kill timer must never be `unref()`'d.** It was, in the first cut: a
  process whose only pending handle is an unref'd timer exits before it fires,
  so the child is never killed and the promise never settles. This is invisible
  from inside `node:test` (the runner holds the loop open) and surfaced only on
  CI, as five `cancelledByParent` tests alongside `# fail 0`. Pinned from
  outside by `test/remote-transport-eventloop.test.js`, which runs the case in a
  child node process with nothing else pending. The repeating *interval* in
  `remote-index.js` is unref'd on purpose — a poll must not hold the app open —
  but a one-shot safety timeout never is.

- **A failing host degrades quietly and leaves the mirror alone.**
  `syncMirror` throws before mutating anything if the inventory call fails; a
  partial fetch skips the deletion pass *and* keeps the vanished files in the
  manifest, so the deletion is still owed on the next healthy run rather than
  silently forgotten. `remote-index.js` catches per host, so one dead host does
  not stop its peers or the local scan.

- **A host that keeps failing backs off per host, exponentially, capped at
  30 min — it is never disabled (issue #215).** Field incident 2026-09-07/08:
  a `transport disposed` cause (fixed separately) reran the plain fixed-cadence
  loop every 300.0 s for ~19 h (226 identical `refresh failed` warnings) because
  nothing slowed a permanently broken host down. `refreshNow()` now tracks
  `{ failures, lastError, nextAttemptAt }` per alias; on failure the delay is
  `min(intervalMs * 2^(failures-1), 30 min)` — base equals the host's own
  configured cadence, so an isolated blip costs nothing extra, and the 30 min
  ceiling was chosen so an operator never has to restart the app to get a
  recovered host picked back up. A host past `nextAttemptAt` is skipped for
  that cycle only: no ssh call, no log line, and its peers still run on
  schedule — the loop `continue`s per host, it never returns early. One
  success resets `failures`/`nextAttemptAt` to nominal immediately (issue
  requirement: fast recovery, not a cool-down after the outage ends).
  **Decision: slow down, never disable.** Disabling would need to flip the
  same `enabled` flag the Settings UI owns, which is out of this issue's scope
  and would turn a transient network problem into a silent, permanent loss of
  mirroring that nothing in the sidebar currently surfaces — the capped
  exponential delay already bounds the cost of a dead host to one attempt per
  30 min, which is cheap enough to just keep trying. Logging is throttled to
  the first failure and each change of tier (`onHostFailure` in
  `remote-index.js`), not every attempt, so the same field incident would have
  produced roughly 5 lines instead of 226. Per-host state is readable via
  `getRemoteHostState(alias)` (mirrors `getRemoteSessions(alias)`); the sidebar
  reads its `nextAttemptAt` for the host dot's error tooltip (below). Proven in
  `test/remote-index.test.js` with an injected `now()` clock — no real timers,
  no `setTimeout` waits.

- **A manual refresh means "I know the host is back": it ignores the backoff
  instead of waiting it out (issue #252).** Field incident 2026-09-10 17:41: a
  single transient ssh timeout put a host in backoff, and because
  `refreshHostNow`/`refreshNow` honoured `nextAttemptAt` unconditionally, the
  sidebar refresh button and a per-host reconnect action were both powerless
  for the whole ≥300 s window even though the tmux sessions were alive.
  `refreshHostNow(alias, { force: true })` and `refreshNow({ force: true })`
  now reset `failures`/`nextAttemptAt` to nominal (`lastError` is left alone —
  it only clears on an actual success, or gets overwritten by a fresh failure)
  and run the transport immediately regardless of `nextAttemptAt`. The
  automatic callers — the periodic timer's `refreshNow()` and the watch
  channel's `onRemoteWatchEvent` → `refreshHostNow(alias)` in `main.js` — call
  both functions with no options, so `force` defaults to `false` and the
  backoff keeps applying exactly as before. IPC `remote-hosts-refresh` (all
  enabled hosts) and `remote-host-refresh` (one alias, `main.js`) both force;
  after the refresh, both also restart that alias's watch channel
  (`remoteWatcher.stop` then the same `start(alias, onRemoteWatchEvent,
  onRemoteWatchActivity)` `syncRemoteWatchers()` uses, factored into
  `startWatcherForHost`/`restartWatcherForAlias` so the callback wiring is
  never duplicated) — this also clears a channel stuck on the
  `SWITCHBOARD-NO-INOTIFYWAIT` marker, since `remoteWatcher.start()` resets
  `unwatchable`. Proven in `test/remote-index.test.js`: `force` bypassing the
  backoff and clearing it on success, and the automatic (non-forced) path
  still honouring it, both on an injected clock.

- **The mirror is indexed off the main thread.** `workers/scan-projects.js` takes
  `folderPrefix` and a `folders` subset in `workerData`, and
  `sessionCache.scanFoldersViaWorker` writes each folder result through the same
  delete-then-insert path as the cold-start scan. Parsing 249 MB on the main
  thread would freeze the UI; `refreshFolder` is deliberately not the remote path.

- **Every child's handlers are bound to that child, not to the alias state**
  (audit finding F1, 2026-09-11). `restartWatcherForAlias`'s synchronous
  `stop()` then `start()` — and `syncRemoteWatchers` doing the same on a host
  toggle — kills child A and immediately spawns child B into the same state;
  A's `'close'` (and any late stdout `'data'`) arrives afterwards, on ssh's own
  schedule, not kill()'s. `close`/`data` handlers close over the specific
  `child` they were attached to and check `s.child === child` before touching
  state, so a superseded child's late events are dropped instead of nulling
  B out from under `stop()`/`stopAll()` and spawning an unkillable third
  child. Proven in `test/remote-watch.test.js` with a fake child whose `kill()`
  does not itself emit `'close'` (a real ssh process doesn't either) — a test
  drives the late close explicitly via `child.emitClose()`, after the
  replacement child already exists.

- **The ssh child gets a connect timeout and keepalive, and a quick failure is
  logged with its stderr tail** (audit finding F4). `buildSshArgs` adds `-o
  ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=3` (before
  the alias, after `-tt`/`BatchMode`) so a half-open TCP session (laptop sleep,
  NAT) is detected and reaped instead of leaving `isRunning()` reporting a
  channel that receives nothing, forever. The last ≤200 bytes of stderr are
  kept per child and logged once per backoff-tier change on a quick failure
  (`< HEALTHY_MS`), same throttle as `onHostFailure` above — never on every
  attempt, never for a healthy long run that just happened to exit.

- **A pending coalesce cooldown cannot fire after `stop()`** (audit finding
  F11, minor). `killChild` only ever cleared `restartTimer`; a coalesce
  cooldown timer (and its `pending` flag) from `emitCoalesced` is now also
  cleared and reset inside `stop()`, so a queued trailing event from before
  the stop can never reach `s.onEvent` afterwards.

### Remote hosts — busy spinner (issue #242, moved onto the remote-ssh adapter in #246 step 3)

**Moved.** The mechanics below (decay timer, `armReady: false`, the F7 purge skip) are
unchanged, but the entry point is now `public/remote-activity-ui.js`'s persistent
`remote-ssh` `createSessionState()` adapter, not a bare `setActivity()` call — see
`.ai/contexts/session-state.md` ("The remote-ssh adapter") for the full wiring
(watch channel, descriptor, attach/detach) and why `setActivity()`/the Maps are
still fed in parallel.

Remote transcript-write activity feeds the adapter, which in turn still feeds the same
`setActivity(sessionId, active, via)` dispatcher in `session-activity.js` that local PTY
output uses (kept for two readers not yet migrated — sidebar's initial paint and the grid
busy dot) — `remote-activity-ui.js` calls `setActivity(sessionId, true, 'remote-watch')` on
each `remote-activity` IPC event and arms a 20 s decay timer (one per session, reset on each
event) that calls `setActivity(sessionId, false, 'remote-decay', { armReady: false })` when
it fires, and `seedRemoteActivity(session)` (called from `renderProjects`, before any row is
built) applies the same call from `session.remoteActiveAt` on first paint so a row rendered
inside the decay window starts busy without waiting for the next event; the visual is the
shared `.cli-busy` braille spinner, not a separate indicator — the DOM write itself now goes
through `session-activity-dom.js`'s `applyStateClasses(sessionId, snapshot)`, projecting the
adapter's own snapshot rather than being computed inline.

The decay call passes `armReady: false`,
not the bare two-argument form local PTY callers use. 20 s of transcript silence means
"stopped writing", not "the response is ready" — a remote adapter has no PTY to ask
whether a turn actually ended, so a long tool call or a parent delegating to subagents
(its own transcript silent while children write theirs) would otherwise light every
unviewed remote row as `.response-ready` on a plain inference. `armReady: false` clears
`.cli-busy` and `sessionBusyState` through the normal path but skips adding the session to
`responseReadySessions`, so a remote row falls idle without ever claiming "Claude finished,
you haven't looked." Separately, `app.js`'s `updateRunningIndicators` PTY-set purge skips
rows carrying `dataset.remoteAlias` (F7) — a remote row's busy state is owned by this decay
timer, not by local PTY presence, so it must not be cleared just because some unrelated
local PTY started or stopped. That same per-row loop is also where `updateRunningIndicators`
feeds the adapter's `attached` port (`setRemoteAttached(id, running)`).

### Remote hosts file-level rescan (issue #216, first half)

**The unit of rescan used to be the folder, not the file.** `syncMirror`
already tracks per-file size/mtime to decide what to `scp` (`remote-mirror.js`),
but `remote-index.js`'s `refreshHost()` reduced that down to a `Set` of folder
names via `topFolderOf()` before handing it to `scanFoldersViaWorker`, and
`workers/scan-projects.js`'s `readFolderFromFilesystem` then re-read and
re-parsed EVERY `.jsonl` in that folder — measured 08/09/2026: a folder with
108 MB across 144 files got fully re-read because one line was appended to
one of them. This is fixed additively; the local path (cold-start scan,
`populateCacheViaWorker`, and the fs.watch-driven `refreshFolder`) is
untouched.

- **`syncMirror` now also returns `changedFilesByFolder`** (`Map<folder,
  Set<relPathWithinFolder>>`), built from the exact same `fetched` list and
  deletion-reconciliation loop that already built `changedFolders` — same
  data, not collapsed.
- **`refreshHost()` builds `fileSubsets`** (`Map<folder, Set<relFile>>`) from
  it, but ONLY for a folder already present in `listIndexedFolderKeys()`. A
  folder scanned for the first time (present on the mirror but not yet
  indexed — the "mirror on disk but absent from the cache" case just above)
  always gets the full walk: there is no baseline to restrict against.
- **`scanFoldersViaWorker({..., fileSubsets})` is purely additive.** Omitting
  `fileSubsets` reproduces the prior behavior byte-for-byte (proven by
  `test/scan-projects-worker.test.js`, unmodified, and by
  `test/remote-indexing-e2e.test.js`, unmodified). When given, it splits
  `folders` into `fullFolders` (scanned exactly as before) and `targets`
  (`{folder, files, existingRows}`, `existingRows` pulled from
  `getCachedByFolder` before the worker is spawned — the worker itself has no
  DB access). `workers/scan-projects.js`'s new
  `readFolderFileSubsetFromFilesystem` reads only the named files and returns
  `{ ..., partial: true, toDelete }`.
- **The `mergeBridgeGroups` pitfall — this is the one that would regress
  silently (PR #198 duplicate-sidebar-entry class of bug).** A file-subset
  scan's `freshRows` contains only the changed file(s), so without more,
  `mergeBridgeGroups([], freshRows, reread)` would see a bridge group of one
  and never mark a changed compaction mirror as merged into its still-cached
  parent. Fixed by threading real `existingRows` (the folder's cached rows,
  fetched by `scanFoldersViaWorker` before spawning the worker) into
  `mergeBridgeGroups` on the partial path instead of `[]` — exactly the
  parameter the function already exists to take (`refreshFolder`'s local
  targeted-refresh path does the same with `cachedSessions`). The full-folder
  path (`readFolderFromFilesystem`) still calls `mergeBridgeGroups([], ...)`
  unchanged, because a full read already has every group member in
  `freshRows`.
- **`writeScannedFolderPartial` (session-cache.js), not `writeScannedFolder`,
  handles a `partial: true` result.** `writeScannedFolder`'s
  delete-then-insert-the-whole-folder would wipe every other cached session
  in that folder that the restricted scan never touched. The partial path
  upserts only the returned `sessions` and deletes only the returned
  `toDelete` ids (files gone from the mirror, or a merge member whose
  re-derivation found nothing surviving the cutoff).
- Proven by `test/remote-scan-file-granularity.test.js`, each property pinned
  by an injected-then-reverted mutation: forcing `fullFolders` to ignore
  `fileSubsets` reddens the single-file property; defaulting `subsets` when
  `fileSubsets` is absent reddens the full-folder-by-default property;
  dropping `existingRows` back to `[]` on the partial path reddens only the
  merge-equivalence property.
- **Out of scope, deliberately**: incremental parsing by byte offset within a
  changed file (issue #216's second half) — a changed file discovered this
  way is still read in full by `readSessionFile`.
- **What the second half needs (measured at v0.0.86, not built).** A resume
  has to restore the whole per-file accumulator, and the cached row holds only
  part of it: `commandSummary`, `assistantSeen`, `sidechainSeen`, the first
  timestamp's fallback and the per-day metric buckets built with the file-mtime
  fallback date are not persisted. It therefore needs (1) a per-file state
  record in the cache (byte offset of the last complete newline, a hash of the
  first KB(s) of the consumed prefix, the accumulator above), with a schema
  migration; (2) that state handed to the worker next to `existingRows`; (3) a
  full re-read when the prefix hash differs or the size shrank (the
  missing-project remap rewrites `.jsonl` atomically) and for any row touched by
  `mergeBridgeGroups` (its counts are post-cutoff, so they cannot be resumed);
  (4) pinning `readSessionFile` for local indexing first, since the same
  function backs it. `test/remote-scan-file-granularity.test.js` pins the file
  granularity, including a file that vanished from the mirror.

### Remote hosts — incremental fetch (issue #257)

**The fetch itself is now incremental for a growing transcript; the parse
downstream of it is not (still issue #216's second half, unchanged).**
Measured 2026-09-11 (v0.0.76, main.log): 65 poll cycles in 19 min, one live
session's transcript re-`scp`'d whole in 52 of them — the dominant ssh
traffic of the app, since a session that keeps writing never stops being "the
one changed file" for `syncMirror`.

- **Decision, per file, in `remote-mirror.js`'s `syncMirror`.** For a `rel`
  already in the manifest (`previous[rel]` exists) whose remote `size` grew
  and whose remote `mtimeMs` did not go backward (`meta.mtimeMs >=
  prev.mtimeMs`), and whose **on-disk mirrored file still has exactly
  `prev.size` bytes** (`fs.statSync(localPath).size === prev.size` — the
  cheap proxy for "the manifest's record of this file is still true"),
  `syncMirror` fetches only `[prev.size, meta.size)` and appends it, instead
  of re-pulling the whole file. `.meta.json` sidecars are excluded outright
  (small, never worth the extra round-trip logic).
- **Invalidation rule — full fetch, never a range, when any of these hold:**
  remote size shrank (`meta.size < prev.size` — rotation or truncation);
  remote size is unchanged but `mtimeMs` differs (a same-size rewrite, not an
  append — nothing to safely append to); `prev` doesn't exist yet (first
  pull for this file); the rel is a `.meta.json` sidecar; or the local
  mirrored file's on-disk size doesn't match `prev.size` (someone or
  something touched the mirror out of band since the manifest was written —
  a crash mid-write, a manual edit). **Mtime alone is not trusted as proof of
  an untouched prefix** — a rewrite that happens to grow the file could carry
  any mtime, and `find -printf %T@`'s resolution/clock skew across hosts is
  not something this code verifies further; the *size* check against the
  actual on-disk file is what protects the prefix, mtime only screens out the
  going-backward case cheaply before bothering to `stat()`.
- **The range fetch itself lives in `remote-transport.js`.**
  `createSshTransport().fetchIncremental(alias, requests, destRoot)` takes
  `requests: [{ rel, offset }]` and, per file, runs a single `ssh` command —
  `` tail -c +${offset + 1} '.claude/projects/<rel>' `` (1-indexed: byte
  `offset+1` is the first new byte) — capturing stdout as a raw `Buffer`
  (`run(..., { binary: true })`), never through the utf8 string path the
  inventory/list command uses, so a byte range that happens to split
  multi-byte content is preserved exactly. The result is written
  copy-then-append-then-rename: `fs.copyFileSync(dest, dest+'.part')`,
  `fs.appendFileSync` the new bytes, `fs.renameSync` over `dest` — the
  previous mirror is only ever replaced by that final atomic rename, so any
  failure before it (ssh exit code, timeout, a size cap on the range output,
  a disk error mid-append) leaves `dest` byte-identical to before the call
  and removes the `.part`. A transport with no `fetchIncremental` (an older
  fake in a test) gets the same files routed through `fetchFiles` instead —
  additive, matching the `fileSubsets` precedent above.
- **Cycle bytes are now the transfer size, not the remote file size** — an
  incremental candidate counts against `MAX_CYCLE_BYTES` as `meta.size -
  offset`, not `meta.size`. Counting the full remote size would silently
  undo the point of this feature: a 60 MB transcript that only grew by 4 KB
  would otherwise still eat 60 MB of a cycle's 256 MB budget.
- **`cycleFull` is no longer a single sticky flag (issue #257).** The old
  loop set one `cycleFull` boolean the first time a file didn't fit either
  the file-count or the byte ceiling, and every file listed after it in host
  `find` order was deferred too — even a much smaller file that would still
  fit the remaining budget. `syncMirror` now (a) sorts every candidate
  ascending by transfer size, transcripts before `.meta.json` sidecars (same
  priority the sidecar fix already established), and (b) checks each file
  independently against the remaining count/byte budget with no flag
  latching a permanent "no more this cycle" state — a file that doesn't fit
  is deferred on its own, the next (larger-or-equal, after sorting) file is
  still evaluated on its own merits. Proven by
  `test/remote-mirror.test.js`'s "a single large straggler never defers a
  smaller file that still fits the cycle budget" (five 60 MB files plus one
  10 MB file, budget 256 MB — the 10 MB file is always fetched, regardless of
  where it sits in host order).
- **A skip/defer that recurs every cycle logs once per doubling of its streak,
  not once per cycle.** Same motivation as `onHostFailure`'s throttling in
  `remote-index.js` (issue #215) — a transcript permanently over
  `MAX_FILE_BYTES`, or a file that keeps losing the cycle-budget race, would
  otherwise produce one warning per poll forever. `bumpStreak(manifestPath,
  rel)` in `remote-mirror.js` keeps an **in-memory-only** `Map<manifestPath,
  Map<rel, count>>` (module-level; same durability tradeoff as
  `remote-index.js`'s `hostBackoff` — lost on restart, which just logs once
  again, cheap) and logs on count 1, 2, 4, 8, 16, ... A file that stops being
  skipped/deferred has its streak dropped (`pruneStreaks`), so a later
  recurrence logs fresh rather than resuming at its old tier.
- **Mutation-proven**: setting the incremental branch's `offset` to `0`
  instead of `localSize` (i.e. breaking the range start so it always starts
  from byte 0) reddens `test/remote-mirror.test.js`'s "a transcript that only
  grew is fetched incrementally: only the new bytes are requested" — the
  fake transport's recorded `bytesRequested` no longer matches the actual
  growth (measured 4168 vs the expected 4096 for a 4 KB append with the
  mutation live).
- **Still out of scope**: parsing only the appended bytes. The mirrored file
  on disk is now correct (fetched incrementally, but byte-identical to a
  full fetch), and an incrementally-updated file still reaches
  `scanFoldersViaWorker`/`readSessionFile` through the exact same
  `fetched` → `changedFolders`/`changedFilesByFolder` → `fileSubsets` path a
  fully-fetched file does (`syncMirror`'s return shape is unchanged by fetch
  mode) — so the file-level rescan from issue #216 already re-reads only
  this file, but still reads *all* of it, not just the new lines. Parse cost
  is therefore unchanged by this issue; issue #216's second half remains the
  place to fix that.
- **Gap closed by issue #278 (below)**: a remote session with a live
  descriptor (`~/.claude/sessions/<pid>.json`) but no `.jsonl` written yet (a
  session that was launched but has not been prompted) used to be invisible —
  `LIST_COMMAND`'s `find .claude/projects` only ever sees files that exist.
  Observed 2026-09-11; not addressed by issue #257 itself, since fixed by a
  placeholder session synthesized from the descriptor alone.

### Remote hosts — descriptor-only sessions (issue #278)

A CLI launched in tmux on the host writes its descriptor
(`~/.claude/sessions/<pid>.json`) immediately; the transcript
(`~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`) only appears after the
first prompt. Measured 2026-09-12 on host `planificator`: launched 00:47,
invisible in the sidebar (and unstoppable) until a first prompt at 00:50
created the `.jsonl`; a manual host refresh did not help.

- **`descriptorOnly` is computed in `remote-transport.js`'s `listFiles()`**,
  against the SAME ssh call's own inventory — no second round trip.
  `transcriptSessionIds(files)` collects every inventory rel's basename (minus
  `.jsonl`); a session whose `sessionId` is not among them gets
  `descriptorOnly: true` on the object `parseSessions()` already produced.
  Dead descriptors (`ALIVE:0`) are dropped exactly as before — that filter
  runs first, inside `parseSessions()`, unchanged.
- **The placeholder itself is synthesized in `remote-index.js`**, lazily, from
  whatever the last successful cycle stored — never persisted, never mirrored.
  `getPlaceholderSessions(alias)` filters `descriptorOnly` sessions that also
  carry a `cwd` (nothing to group under, otherwise) and builds a session-shaped
  object via `buildPlaceholderSession()`: `sessionId` is the descriptor's own
  id (parseSessions already requires one; a `pid:<n>` fallback exists only for
  a descriptor shape this build has never produced — that path cannot
  smoothly replace itself once a transcript appears, since the real row's id
  would then differ from the placeholder's `pid:<n>`),
  `folder` is `encodeProjectPath(cwd)` (the same derivation a real session's
  folder gets), `remoteDescriptorSeen: true`, `status`/`statusUpdatedAt` from
  the descriptor, `placeholder: true`, and `summary` set to the cwd's
  basename. `getAllPlaceholderSessions()` aggregates across every alias
  `remoteSessions` currently knows about.
- **`main.js`'s `mergePlaceholderSessions(projects)` folds these into the
  `get-projects` payload**, BEFORE `annotateRemoteAttachable()` runs — so a
  placeholder gets the exact same `status`/`remoteAttachable`/`remoteActiveAt`
  annotation a real remote session does, off the same descriptor. For each
  placeholder it finds the project group matching `remoteAlias` +
  `projectPath` and appends the session (skipping it if a real session with
  the same id already won the race), or creates a new project group when the
  host has no other indexed session under that cwd yet.
- **Replacement is "same id, same row", not a swap main.js orchestrates.**
  Once the transcript is scanned, the very next `listFiles()` cycle sees the
  matching inventory entry and reports `descriptorOnly: false`, so
  `getPlaceholderSessions()` simply stops offering that session — and the real
  row (now present via `buildProjectsFromCache()`, same `sessionId`) is what
  the sidebar's key-by-`sessionId` render already treats as the same row. No
  code anywhere diffs "was this a placeholder a moment ago" — there is nothing
  to reconcile because only one of the two sources is ever offering that id at
  a time.
- **`open-terminal`'s remote-attach lookup had to change to reach this row at
  all.** It used to derive the alias solely from `getCachedFolder(sessionId)`
  (a `session_cache` row) — a placeholder has none, by design (nothing is
  mirrored or indexed for it), so that lookup silently found nothing and fell
  through to the local-spawn path instead of attaching. It now falls back to
  `remoteIndexer.findSessionAlias(sessionId)` — a plain in-memory scan of the
  last known descriptors — whenever `getCachedFolder` returns nothing at all
  (a folder that IS cached but local is left alone: `alias` stays `null`,
  exactly as before).
- **Stop, delete-guard and the DOM row needed no such fix.** `remote-stop-session`
  and the sidebar's `resolveSessionStop`/`stopBeforeArchive` already take
  `alias`/`sessionId` straight from the session object the renderer holds, never
  from a DB lookup — a placeholder's `remoteAlias` is set directly by
  `mergePlaceholderSessions`, so stop works unmodified. `read-session-jsonl`
  (transcript viewer), `list-subagents` and the subagent-meta paths all key off
  `getCachedFolder`/`getCachedSession`/`getCachedByParent`, which return
  nothing for an unindexed id and already degrade to an error object rather
  than throwing — a placeholder is skipped there, not crashed, with no code
  change needed. The one renderer-side change is `sidebar.js`'s
  `buildSessionItem`: the `.session-jsonl-btn` ("View messages") is not
  rendered for a `session.placeholder` row, since there is nothing to view yet.

- **A remote project is never "missing".** `buildProjectsFromCache` sets
  `missing: false` for any aliased row. Probing the local filesystem for
  `/srv/supervision` would flag every remote project missing and offer it to the
  missing-project remap UI, which rewrites transcripts for a path this machine
  never owned. Sidebar grouping is keyed on `alias + projectPath`, not
  `projectPath` alone, so two hosts holding the same absolute path stay two groups.

- **Switchboard never stores, reads or displays an SSH credential.** A host row
  is an alias and a label. Resolution (user, port, key, agent, proxy) stays in the
  user's `~/.ssh/config`, which is already on the sensitive-path denylist
  (`ipc-path-validator.js:38`, `main.js:732`) and stays there. The alias is passed
  as its own argv element, never concatenated into a shell string; a remote
  relative path is validated by `isSafeRelPath` before it is joined onto a local
  directory or handed to `scp` (OpenSSH 9 runs scp over SFTP, where quoting would
  become part of the name — the validation is the guard, not quoting).

- **Session descriptors ride the SAME ssh call as the inventory (issue #211)
  — never a second connection.** The CLI writes one descriptor file per live
  session to `~/.claude/sessions/<pid>.json` on the remote host, alongside
  unrelated `*.key` secret files (mode 600) in the same directory.
  `remote-transport.js`'s `LIST_COMMAND` (`remote-transport.js:25-29`) is a
  single shell command: the existing `find .claude/projects`
  inventory, then a `printf` of a marker line, then a bounded pull of
  `.claude/sessions`. `listFiles(alias)` still spawns exactly one `ssh` — the
  test "listFiles spawns one bounded ssh…" in `test/remote-transport.test.js`
  asserts both `find .claude/projects` and `find .claude/sessions` appear
  inside that single command string.
  - **The two halves fail independently, in opposite directions — neither
    direction should be mistaken for the other.** The inventory `find` is
    followed by `|| exit $?`: if it fails (missing `.claude/projects`, an
    unmounted home, a permission change, a BusyBox `find` with no `-printf`),
    the whole command aborts immediately with that `find`'s own exit status —
    `listFiles` still throws and `syncMirror` still refuses to touch the local
    mirror, exactly as before issue #211 introduced the sessions pull. The
    sessions half's own failure (a missing or unreadable `.claude/sessions`)
    is independently swallowed (`2>/dev/null`, and the final pipeline's exit
    status is the trailing `while` loop's, not `find`'s) and degrades to zero
    descriptors without affecting the inventory half. Before this fix, the `;`
    between the two stages let the sessions half's `while` loop mask a failed
    inventory `find` — an unreachable/misconfigured host's inventory failure
    was silently read as "nothing remote exists", which `syncMirror` then
    read as license to delete every locally mirrored file for that host.
  - **The marker (`SESSIONS_MARKER = '\u0001SWITCHBOARD-SESSIONS\u0001'`)
    cannot collide with real descriptor content, by construction.** It is
    wrapped in a raw SOH control byte (0x01) on each side — written in source
    with an explicit `\u0001` escape, not a raw byte, so the constant stays
    legible in a diff — sent to the shell as `\001` inside a `printf` format
    string. Valid JSON text can never contain a raw, unescaped control byte —
    the JSON spec requires control characters inside a string to be escaped
    (per RFC 8259 section 7) rather than appear as a raw byte — so no
    legitimate descriptor line can ever contain the two raw 0x01 bytes that
    frame the marker. `splitListOutput(stdout)` (`remote-transport.js`) only
    accepts a marker occurrence preceded by a newline (or at byte offset 0 —
    the legitimate case when the inventory `find` found zero files) and
    followed by a newline, consuming that trailing newline into the boundary;
    a marker substring that doesn't sit on its own line, or an absent marker
    (an unexpected truncation), both degrade to treating the whole stdout as
    the inventory block and return `sessionsBlock: ''` rather than throwing —
    `parseInventory` keeps working exactly as before on the degraded input.
  - **The command assumes a POSIX-sh-compatible remote login shell.** `;`,
    `||`, pipes, `2>/dev/null` and `while … do … done` are `sh`/`bash`/`dash`/
    `ksh` syntax, not portable to `fish` (different loop syntax, no `do`/`done`)
    or `csh`/`tcsh` (different control-flow syntax entirely) — a host whose
    login shell is one of those would get a syntax error from `ssh`, whereas
    the pre-#211 command (a single `find` invocation with no shell operators
    at all) was portable to any shell. No such host is declared today; this is
    a known, undemonstrated limitation, not something this change attempts to
    fix.
  - **`-name '[0-9]*.json'` is the only thing standing between this feature and
    reading a `.key` secret file** — it structurally cannot match any `*.key`
    filename regardless of the digit-prefix part, because the extension itself
    is wrong. This is a property of the glob, not an added exclude-filter.
    Pinned by two tests in `test/remote-transport.test.js`: an exact-string pin
    of `LIST_COMMAND` (so widening the glob, or swapping the `find`+`head -c`
    pipeline for a bare `cat *`, changes the string and fails immediately), and
    a belt-and-suspenders `!LIST_COMMAND.includes('.key')` check that survives
    unrelated wording changes.
  - **Byte and count caps are enforced remotely, in the shell command itself**
    (defense in depth, not just in JS): `head -c 8192 "$f"` bounds each
    descriptor, `head -n 200` bounds the count. Worst case the sessions payload
    adds ≈ 200 × 8193 ≈ 1.64 MiB to a cycle, comfortably under the existing
    8 MiB `MAX_LIST_BYTES` combined-output cap on its own — so this addition
    cannot by itself push a cycle over that cap. A projects inventory already
    near 8 MiB could still combine with this to overflow, but that is the
    pre-existing risk of an oversized inventory, not a new failure mode.
    `LC_ALL=C sort` orders the descriptor files deterministically (byte order,
    not locale-dependent) — cosmetic, but keeps test/log output stable.
  - **A missing or unreadable `~/.claude/sessions` degrades to zero
    descriptors instead of failing the whole cycle.** The sessions half is a
    pipeline ending in `while IFS= read -r f; do …; done`, whose exit status is
    the *loop's* status (0, even on empty input) — not the `find`'s. `find`'s
    own stderr is swallowed by `2>/dev/null`, so a missing directory produces
    empty stdout and exit 0. The two `find` stages are joined by `;`, not
    `&&`, and deliberately carry no `set -e`/`pipefail` — a failure in the
    sessions half must never fail the inventory half it rides alongside.
  - **`parseSessions(block)` preserves every field verbatim** — the schema
    belongs to the CLI, not to Switchboard — validating only `pid` (positive
    integer) and `sessionId` (non-empty string) before accepting a line.
    Malformed lines (a `head -c`-truncated descriptor produces incomplete
    JSON) are dropped with a **fixed, generic warning string only** — never the
    raw line, the parsed object, or any field value — because descriptor
    content must never be logged. `listFiles`'s return contract changed from a
    plain array to `{ files, sessions }`; every stub of `transport.listFiles`
    across `remote-mirror.test.js`, `remote-index.test.js` and
    `remote-indexing-e2e.test.js` was updated to match in the same change.
  - **A descriptor's pid is checked for liveness on the host itself (F9,
    audit-fable-2026-09-11)** — until this fix `parseSessions` kept every
    descriptor unconditionally, so a killed remote CLI's file (deleted only on
    a clean exit, same as the local one — see `.ai/contexts/cli-session-state.md`)
    surfaced as permanently live, and `sidebar.js`'s host-dot `liveCount`
    counted it. `LIST_COMMAND`'s per-file loop now emits one more line after
    each descriptor: `printf '\002ALIVE:%s\n' "$( [ -d "/proc/$pid" ] && echo
    1 || echo 0 )"`, `$pid` taken from the filename via `basename "$f" .json`
    — no second ssh round trip. `parseSessions` matches that exact
    `ALIVE:0`/`ALIVE:1` line immediately following a descriptor,
    consumes it either way (so it can never itself be mis-parsed as a bogus
    descriptor), drops the descriptor on `ALIVE:0`, and counts the drops in
    its returned `dropped` field; `listFiles` logs `dropped N dead session
    descriptor(s)` when non-zero. **Backward compatible by construction, not
    by a version check**: a descriptor with no marker line following it (an
    older host script, or simply the last line of the block) is kept exactly
    as before — the absence of the marker is the compatibility signal, there
    is no protocol version field.
  - **`remote-index.js` keeps the latest descriptors per alias, keyed and
    pruned exactly like folder keys.** `createRemoteIndexer()`'s private
    `remoteSessions` map is set from `result.sessions` inside `refreshHost()`
    and read back through `getRemoteSessions(alias)` (defaults to `[]` for an
    alias never refreshed). `pruneUnknownAliases()` deletes its entries for any
    alias no longer declared, the same pass that prunes folder keys, so the map
    cannot grow unboundedly across host-list edits. Attach now exists off this
    data (issue #221, below); capacity tiers and a liveness badge in the UI
    (#218, #212) still don't.
    **Corrected 2026-09-10 (issue #252): only a SUCCESSFUL cycle replaces this
    map.** `refreshHost()`'s failure path used to also do `remoteSessions.set(alias,
    [])`, so one transient ssh timeout wiped every live descriptor and
    `annotateRemoteAttachable` (`main.js`) then found none — every remote
    session read as non-attachable for the whole backoff window even though
    the tmux sessions were alive (field incident 2026-09-10 17:41). The wipe is
    removed from both `refreshNow()`'s and `refreshHostNow()`'s catch blocks;
    `getRemoteSessions(alias)` on a failed cycle now returns the previous
    `sessions` list unchanged, the previous `at`, and the fresh `error` from
    `hostBackoff` — the host dot already renders `error` as "unreachable", so
    the UI signal is unchanged, only the underlying data survives. Attach
    itself is the honest failure mode for a genuinely dead host: it tries the
    stale descriptor and the ssh call inside it fails. A host that is
    disabled or removed is still pruned by `pruneUnknownAliases()`, unaffected
    by this change. Proven by `test/remote-index.test.js` ("getRemoteSessions
    keeps the last known descriptors, not wiped, after a cycle where sync()
    throws").
  - **Remote hosts — meta.json sidecars (issue #244).** A subagent's agent
    type lives in a sidecar `agent-<id>.meta.json` next to its transcript,
    read by `readSubagentMeta()` (`read-session-file.js`). `LIST_COMMAND`'s
    projects `find` matches `*.jsonl` **or** `*.meta.json`, and
    `isSafeMirrorRelPath` (`remote-hosts.js`) — not `isSafeRelPath` — gates
    both in `parseInventory` and in `remote-mirror.js`'s inventory filter and
    fetch queue, so the sidecar rides the same `scp` path as its transcript
    and lands in the same mirrored directory (no path-layout code needed:
    `fetchOne` already preserves the full relative path). `isSafeRelPath`
    itself is untouched on purpose — `remote-watch.js` still imports it
    directly, so a `.meta.json` write on the host is never classified as
    project activity; the sidecar only ever arrives on the next inventory
    refresh. Inside `syncMirror`, transcripts are sorted ahead of sidecars
    before the per-cycle budget (`MAX_CYCLE_FILES`/`MAX_CYCLE_BYTES`, #238) is
    applied, so a flood of tiny sidecars can never push a transcript out of a
    full cycle. A sidecar that arrives (or leaves) on its own — the transcript
    itself unchanged — is reported to the indexer under its **transcript's**
    rel path, not its own, because `readSubagentMeta()` in the transcript's
    row is what actually needs re-deriving.

### Remote hosts — capability tiers (issue #218, first and second slice)

`remote-host-profile.js` is a pure function: `computeHostProfile({ at, error, descriptors })` returns
`{ tier, tiers, missing }`, the highest of `observe < liveness < inject < attach < launch` that is
available plus, for every tier above it, the reason it is not. The indexer's `getRemoteHostProfile(alias)`
feeds it the last cycle's own data (`at`, `error`, live descriptors) and the probe result (`tools`), and the profile
also returns `blocked` (why nothing could be read, or null) and the normalised `tools`.

- `none`: never synced, or the last cycle failed. A failed `find ~/.claude/projects` fails the whole
  cycle, so an unreadable projects directory and an unreachable host are not told apart; the ssh error is the reason.
- `liveness`: at least one live descriptor. `inject`: a live descriptor with a `messagingSocketPath` that is a POSIX
  absolute path. `attach`: a live descriptor naming a tmux pane with a valid pid (the adapter's own test).
  The tiers are independent requirements: the reported tier is the highest available one, not the highest contiguous one.
- `launch`: available under the same rule as attach (probe `tmux: true`, or a live descriptor naming a tmux pane, and not `tmux: false`), and unlike the other tiers it is not withdrawn by a failed last refresh (launch runs its own ssh, as Send does); its reason otherwise starts with "needs tmux on the host". See "Remote hosts — launching a session".
- A tier that needs a live session reads as missing on an idle host; that is "nothing to read it from", not "unsupported".
- `annotateRemoteAttachable` (main.js) puts the profile on the project (`remoteHostProfile`). After 3 consecutive failed
  cycles (`attachBlockReason`), it sets `remoteAttachable: false` plus `remoteAttachBlocked` (the last error) on the
  session: a single transient poll failure blocks nothing, and the descriptors of the last good cycle are kept.
  Stop is never blocked, it runs its own ssh. The renderer only shows the strings: the host dot's tooltip (which states
  the last error from the first failure), the row and badge titles.
- The new-session button was already disabled for every remote host; it is unchanged.
- The new-session button was already disabled for every remote host; its title now carries the launch tier's reason.
- Not done: the launch tier itself (issue #222), multiplexers other than tmux (`parseTmuxField` is the only recogniser).

#### The probe and the gates (second slice)

- `PROBE_COMMAND` (remote-transport.js) is its own ssh command, pinned exactly in `test/remote-transport-probe.test.js`;
  `LIST_COMMAND` is not widened. It prints `tmux=0|1` and `inotifywait=0|1`; `parseProbe` accepts exactly those two
  lines and `probeTools` throws on a timeout (15 s), a cap overrun (1 KiB), a non-zero exit or any other output. It goes
  through the same `run()`, so the same ssh binary, `BatchMode` and `ConnectTimeout` apply and no new spawn site exists.
- The indexer probes at the end of `refreshHost`, after a successful sync only, at most every `PROBE_INTERVAL_MS` (6 h);
  a failed probe is retried after `PROBE_RETRY_MS` (30 min), keeps the previous answer, and never fails the cycle. A
  forced reconnect re-arms it without forgetting the answer. A removed alias drops its answer. A transport without
  `probeTools` is skipped.
- `tools.<name>` is `true`, `false` or `null` (unknown). Only `false` withholds anything. `tmux === false` makes the attach tier
  unavailable even when a descriptor names a pane, because the attach adapter runs a bare `tmux` over the same
  non-interactive ssh, so a failing `command -v tmux` there is a failing attach. `tmux === true` makes attach available on
  an idle host. Liveness is unchanged: it needs a descriptor, which the probe cannot tell.
- `attachBlockReason(profile, failures)` returns the observe reason from the third failure on (the fallback for a host
  whose ssh keeps failing, which wins), else the tmux reason when tmux is known missing, else null. The session carries it in
  `remoteAttachBlocked`; the renderer already opens the transcript and puts it in the row and badge titles.
- `sendBlockReason(profile)` is the inject tier's reason on a host that was read (`blocked` null), else null: a failing host
  does not disable Send, which runs its own ssh. The tier is host-level, "some live session reports a socket", so a
  session without its own socket on a host where another one has one is still offered Send and fails at the click.
  `session.remoteSendBlocked` disables the button with the reason in its title.
- Stop has no gate (`test/annotate-remote-tier-gates.test.js` and `test/dom-sidebar-remote-tier-gates.test.js` pin it).

## Remote hosts — launching a session (issues #218, #222)

`remote-launch.js` builds the one ssh command and orchestrates launch then attach; the renderer side is `showRemoteLaunchDialog` (dialogs.js) and `launchRemoteSession` (app.js), the IPC is `remote-launch-session`.

- **The command is `sh -c '<script>'`** (`shellSingleQuote`, as `remote-send.js`), so a fish or csh login shell never parses it. The script checks `[ -d "$cwd" ]`, `command -v tmux`, `command -v claude` with exit codes 9, 10, 11 (each mapped to its own message), then `exec tmux new-session -d -P -F '#{session_name}:#{window_id}.#{pane_id} #{pane_pid}' -s switchboard-<uuid8> -c "$cwd" 'claude --session-id <uuid> [flags]'`. The exact string is pinned in `test/remote-launch.test.js`.
- **Validation, not escaping, is the guard.** The cwd must match `CWD_RE` (absolute; letters, digits, space, `. _ + @ : , = / -`; no `..` segment; at most 4096 bytes). That set has no quote, `$`, backtick, backslash, newline or leading `-`, so the single-quoting is a second layer, not the only one. The uuid is matched by regex, the tmux name derives from it, the permission mode is checked against an allow-list. The same checks run in the renderer (UX), in `handleLaunchRequest` and in the adapter.
- **Why attach straight to the created pane.** `-P -F` prints the pane's `session:@window.%pane` and `pane_pid`. `handleLaunchRequest` hands `{ pid, tmux, sessionId, cwd }` to the existing `remoteAttachAdapter.attach`, which discovers the socket from `/proc/<pid>/environ` and runs the same pid-reuse guard (the pane's command line contains `claude`). No wait for the descriptor to show up in the next refresh; `refreshHostNow` is fired afterwards so the row's real descriptor replaces the pending one.
- **The id is generated locally** (`crypto.randomUUID` in the renderer, validated again in main) and passed as `--session-id`, so the pending sidebar row and the later descriptor share one id.
- **Stop is unchanged.** The pane target we created has a pane component, so `buildStopCommand` emits `kill-pane` (pinned for this exact target shape in `remote-launch.test.js`); never `kill-session`. Killing the only pane of the only window ends the tmux session as a side effect of tmux itself.
- **A failed attach after a successful launch** leaves the tmux session running on the host; the error names it, and it appears in the sidebar at the next refresh.
- Not verified here: a real host (the tests use a fake runner, plus a real `sh` with stubbed `tmux`/`claude`), tmux older than the `-P -F` form, and a `claude` that exits at once (the pane then closes and attach fails with the probe error).

## Remote hosts — enrolment (issue #222)

`remote-enrol.js` builds the checklist and guards the request; the command and its parser are in `remote-transport.js` (`ENROL_COMMAND`, `parseEnrol`, `checkHost`); the IPC is `remote-host-enrol-check`, the UI is `public/remote-enrol-panel.js` driven from the host rows of `settings-panel.js`.

- **It reports state, it acquires nothing.** The sensitive-path denylist refuses `.claude/.credentials.json` on purpose (#208), so no check opens, copies, hashes or tests that file, and none reads `ANTHROPIC_*`, a keychain or a token. Pinned by a negative match on `ENROL_COMMAND` in `test/remote-transport-enrol.test.js`.
- **The logged-in signal is the CLI's own exit status.** `claude auth status` (verified locally, CLI 2.1.288, read-only) exits 0 when logged in and 1 when not, and prints JSON or text that includes the email and organisation. The command runs it with stdout and stderr thrown away (`>/dev/null 2>&1 </dev/null`), so the account details never cross ssh; only `auth=1|0|unknown` comes back. Any other exit status, a host whose `claude auth --help` has no `status` line (an older CLI, where `auth` would be read as a prompt), a missing `claude` or a missing `~/.claude` give `auth=unknown`, never "logged out". With no `~/.claude` the command is not run at all, because on a fresh account the CLI creates its config files on first use and the check must not change the host.
- **`ENROL_COMMAND` extends `PROBE_COMMAND` by concatenation**; the probe's own string and parser stay pinned and unchanged, as does `LIST_COMMAND`. Fixed string, no interpolation: the alias is the ssh operand, validated by `isValidAlias` and required to be in the saved `remoteHosts` before any ssh runs.
- **Strict parse.** `parseEnrol` takes the lines `tmux`, `inotifywait`, `claude`, `claude_version` (only when `claude=1`), `claude_dir`, `auth` in that order and nothing else, or returns null. The version is the one free-text field: it is kept only when it matches `CLAUDE_VERSION_RE`, else shown as unreadable. Output cap 2 KiB, timeout 30 s (`enrolTimeoutMs`), the same `run()` and ssh options.
- **Outcomes of `checkHost`**: ssh exit 255, a spawn failure or a timeout is `reachable: false`; any other failure is `reachable: true` with no facts (a Windows host lands here), and every other item is then `unknown`, not `missing`. Detail text from stderr is one line, control characters stripped, 200 characters.
- **The hand-off commands** are constants in `remote-enrol.js`: the install one-liner and `sudo apt install tmux` are assumptions about the host, offered as text to copy and never run by Switchboard. Each carries `where` (`host` or `workstation`) so the UI says where to run it. tmux is `optional`: its absence is observe-only, not an error.
- **The UI builds its DOM with `textContent` only**; the copy button goes through `window.api.writeClipboard` (main process, as the Wayland fix). The check applies to hosts in the saved settings; an unsaved row answers "save the settings first". One check per alias at a time (`running` set in `remote-enrol.js`).
- **A non-POSIX login shell** (fish, csh) fails the command like a Windows host does, so the "no facts" detail names both causes. The command is not wrapped in `sh -c`: the `PROBE_COMMAND` prefix pin must hold.
- Not verified: whether `claude auth status` refreshes or rewrites an expired token, or makes network calls, on the host (Switchboard only sees the exit status, but the command is not known to be free of side effects on the host); a real host (tests use a fake spawn and a real `sh` with a stubbed `claude`), `claude auth login` on a machine with no browser, and whether `claude auth status` in a non-interactive ssh sees a login provided only by an environment variable set in an interactive profile (it would read "not logged in").

## Remote hosts — sending a prompt (issue #219)

The trigger entry point also uses the one `remoteSendAdapter` instance when
`remoteTriggers` is enabled. Its global default is in `SETTING_DEFAULTS`; the
context getter checks it without requiring a restart. Send and triggers share
the 30-second dedupe and a bucket per alias/session id: 30 tokens, refill 0.5/s,
reserved before running the command, refunded on definite failures, retained
on ambiguous writes. Failure codes distinguish pre-write refusals from
`timeout`/`exit` with `maybeWritten: true`; success remains exactly `{ ok: true }`.
`findSessionAliases(id, isEnabled)` returns all enabled matching hosts without
changing the older singular lookup. See `trigger-watcher.md`, "Remote socket
targets", for trigger guards and the two-pull rule.

`remote-send.js` writes one prompt to a live, unattached remote session through
the CLI's own messaging socket. Send only: nothing is read back, the state comes
from the descriptor the refresh cycle already pulls.

- **Protocol** (measured in the issue, CLI 2.1.263): NDJSON over a unix socket,
  one line `{"type":"user","message":{"role":"user","content":...},"msgV":1,"session_id":...}`
  terminated by `
`, capped at 1 MiB, first line within 30 s. The connection is
  one-way; the server never answers on it. No auth line on POSIX (the peer is
  identified by `SO_PEERCRED`); on Windows the token lives in a `.key` file that
  the descriptor fetch and the denylist exclude on purpose, so a `\.\pipe\`
  path is refused, not worked around.
- **`session_id` is in the line** so a descriptor that outlived its process, whose
  pid was reused, never has its prompt accepted by another session.
- **The text is stdin only.** `defaultRunRemoteCommand` takes an `input` option:
  stdin becomes a pipe, `-n` (which points ssh's stdin at the null device) is
  dropped, the line is written and stdin closed. Same spawn site as every other
  remote ssh, so `remote-ssh-spawn-sites.test.js` is unchanged. The remote
  command holds fixed text, the integer pid and the single-quoted path.
  The script is passed as `sh -c '<script>'` (one single-quoted word), so the
  login shell of the host never parses it; `$(...)` and `if ...; then` fail under
  fish. The tmux probe and stop commands in `remote-attach.js` / `remote-stop.js`
  are still raw strings and share that problem; not changed here.
- **The path is main-side only.** `messagingSocketPath` stays in the descriptor
  `parseSessions` keeps; the renderer sends `{alias, sessionId, text}` and
  `handleSendRequest` looks the descriptor up. `validateSocketPath` is stricter
  than `isSafeSocketPath` (which also guards tmux sockets): `^/[A-Za-z0-9._/-]+\.sock$`,
  no `..`, at most 107 bytes (`sockaddr_un`). `buildSendCommand` throws on a path
  it would refuse.
- **nc variants**: the command probes `ncat --help` for `--send-only` and
  `nc -h` for an OpenBSD usage line carrying `N` and `U`; a BusyBox or
  netcat-traditional `nc` is never run with flags it would reject, the command
  exits 127 instead. **Exit codes** of the remote command: 7 the pid is no longer a `claude`
  process, 8 the socket is gone, 127 no `ncat`/`nc`. Anything else is a failure
  carrying ssh's stderr. A timeout (nc did not exit after the line was written)
  is a failure saying nothing confirms the write, never a success.
- **30 s dedupe** is client-side and per host, session and text, on an injectable
  clock. The key is reserved before the ssh spawns, so two concurrent sends of the
  same text go once; a definite failure releases it, a timeout keeps it (the line
  may already be on the socket). The server also has a
  30-token bucket refilling at 0.5/s; nothing here retries.
- **Entry point**: the `session-send-btn` on remote rows (CSS-gated like Stop:
  shown for `.is-alive` and not `.has-running-pty`), and `showSendPromptDialog`
  in `public/dialogs.js`. An attached session is refused main-side as well.
- Not done, on purpose: replies and idle notification (they need an inbox of our
  own and a published key), Windows hosts, trigger files targeting remote ids,
  and the attention state.
- Tests: `remote-send.test.js` (the line, the path, the command run through a real
  `sh` with a fake `nc`, exit codes, byte cap, dedupe, IPC contract),
  `remote-run-input.test.js`, `dom-sidebar-remote-send.test.js`,
  `dom-send-prompt-dialog.test.js`.

## Remote hosts — tmux attach (issue #221)

Screen refresh (#446) uses a fitted-size nudge only for solo attachments.
Shared attachments skip automatic return refresh and explicitly repaint the
local buffer without resizing their ssh PTY. All geometry resizes retain
the solo-client rule below; see
[terminal-refresh](terminal-refresh.md) for restoration and measurement limits.

`open-terminal` no longer refuses every remote session outright. When
`isRemoteFolder(cachedFolder)` is true, it now looks up that session's own
descriptor via `remoteIndexer.getRemoteSessions(alias)` and asks
`remote-attach.js`'s adapter whether it can attach. Only if the descriptor
carries no usable multiplexer field does it still return `REMOTE_READ_ONLY`.
Launching a new remote session (#222) and injection over the messaging socket
(#219) are untouched — this is attach-to-an-already-running-CLI only.

- **The adapter is indexed on the descriptor's own field, never on host
  detection.** `remote-attach.js`'s `createTmuxAttachAdapter().supports(descriptor)`
  and `.attach(alias, descriptor)` both key off `descriptor.tmux` — a host
  whose CLI never writes that field (no multiplexer, or a different one) is
  refused before any ssh call, not probed. **The word "tmux" is confined to
  this one file by construction** — `main.js` never inspects `descriptor.tmux`
  itself, it only calls `supports()`/`attach()`. A second adapter for a
  different multiplexer would slot in beside this one without `main.js`
  changing at all.

- **Sizing rule, measured on tmux 3.6 against a window never pinned to a
  size (`window-size latest`):** `cols = window_width`, `rows = window_height
  + status_lines`, where `status_lines` is 1 when the `status` option is
  `on`, 0 when `off`, and the rendered count otherwise (tmux allows a
  multi-line status bar). Attaching at the bare height instead measurably
  leaves the window one row short **after the client detaches**, not just
  while attached — a client that sized itself to the true height (200x51 on
  a 200x50 usable pane) left the window at 200x50 once it left; the naive
  200x50 client left it at 200x49. `parseProbeOutput()` in `remote-attach.js`
  applies the correction; `test/remote-attach.test.js` proves it by mutation
  (dropping `+ statusLines` reddens 3 of 11 tests).
  - `attach -f ignore-size` was tried and rejected: measured to resize the
    window anyway.
  - `resize-window` was tried and rejected: it sets `window-size manual` on
    the window, silently, on a session this app does not own.

- **The probe and the attach are two separate ssh calls, deliberately not
  combined with the mirror's own inventory ssh.** The probe
  (`buildProbeCommand`) runs `tmux -L <socket> display-message -p -t <target>
  '#{window_width}x#{window_height}'`, then a `PROBE_SEP` control-byte separator, then `tmux
  -L <socket> show-options -A -t <socket> status` — one non-interactive ssh
  round trip, parsed by `parseProbeOutput`. The attach itself
  (`buildAttachCommand`) is `tmux -L <socket> attach -t <target>`, run over a
  **second**, interactive `ssh -tt <alias> …` that becomes the actual PTY —
  it cannot be the same call as the probe because the probe must complete and
  return a size before the interactive PTY is even spawned.

- **The `tmux` field's own shape is treated as the socket name too.** The CLI
  writes e.g. `"main:@0.%0"` — a `session:window.pane` target string. This
  adapter reads the part before `:` (`"main"`) as both the tmux socket
  (`-L main`) and the session to query status on, on the assumption the CLI
  always names its socket after its session. **This is an assumption, not
  something measured against the CLI's own socket-naming code** — if a
  future CLI version uses a socket name that differs from the session name,
  `show-options -A -t <socket>` would query the wrong (or a nonexistent)
  session and this adapter would need a real socket field instead of
  deriving one.

- **`TMUX_FIELD_RE` is the injection guard, not shell quoting.** Same posture
  as `remote-hosts.js`'s `isSafeRelPath`: the descriptor field is matched
  against `^([A-Za-z0-9._-]{1,64}):(@?\d{1,10}(?:\.%?\d{1,10})?)$` before it
  ever reaches a command string, so a field forged to include a semicolon or
  backtick is refused outright (`parseTmuxField` returns `null`) rather than
  escaped. Descriptor content besides `pid`/`sessionId` is otherwise
  untyped — see "Session descriptors ride the same ssh call…" above.

- **Detach sends Ctrl-B d before ending the local ssh client — it does not
  just kill the connection.** `ptyProcess.kill()` on the returned wrapper
  writes `DETACH_KEYS` (`\x02d`, tmux's default prefix + detach) to the
  attach PTY, waits `DETACH_GRACE_MS` (150 ms) for tmux to process it, then
  kills the local `ssh -tt` client. Killing immediately, without the
  keystroke, races tmux's own cleanup and risks the same window-corruption
  failure mode the sizing rule fixes on the other end. No new IPC or
  `main.js` call site was added for this — `stop-session` already calls
  `killPty(session, sessionId)` → `session.pty.kill()` through the existing
  `pty-ops.js` seam, so the clean detach is just what that seam now reaches.

- **`main.js`'s onData/onExit wiring (OSC parsing, busy detection, output
  buffering, `activeSessions` cleanup) is shared between local spawn and
  remote attach.** Extracted into `wireSessionPty(session, sessionId,
  ptyProcess)`, called once from the local-spawn tail and once from the new
  remote-attach branch — the same code path, not a parallel copy that can
  drift. A remote session's `ptyProcess` (from `remote-attach.js`) exposes
  the same `write/resize/kill/onData/onExit/pid` shape node-pty does, so
  `pty-ops.js` (`writePty`/`resizePty`/`killPty`) and this wiring need no
  remote-awareness of their own — the existing `terminal-resize` IPC reaches
  a remote session's PTY through the exact same `resizePty(session, cols,
  rows, sessionId)` call as a local one.

- **Solo vs shared (issue #221 follow-up): resize follows the local window
  only when no other tmux client is already attached.** The probe
  (`buildProbeCommand`) now appends a third `PROBE_SEP`-delimited segment,
  `tmux -S "$sock" list-clients -t <target> | wc -l` — still the one
  non-interactive ssh round trip, no second connection. `attach(alias,
  descriptor, localSize)` takes the caller's locally-measured `{cols, rows}`
  (`main.js`'s `open-terminal` handler passes the same `normalizePtySize
  (initialSize)` result a local spawn uses) and treats the session as
  **solo** when there are no real clients after classification *and* a valid
  `localSize` was supplied. Solo: the PTY opens at `localSize`, and the
  returned `ptyProcess.resize(cols, rows)` forwards to the underlying ssh
  PTY — a live terminal like any local one. Not solo (one or more other
  clients attached, or the client count could not be parsed — fail closed
  the same as "attached"): the PTY opens at the sizing-rule's remote
  `cols/rows` as before, and `resize()` stays a no-op while shared, logging which of the
  two reasons applied. Rewrapping a screen someone else is actively looking
  at is the failure this refuses; an unparseable count is treated the same
  as "someone's there" rather than guessed.

- **Mode re-evaluation and stale clients, issue #452.** On v0.0.88, the
  maintainer measured three restart-time attaches at 316x94 with one other
  client each (2026-10-03, 22:06:38–22:06:41). Each socket later had only the
  current instance's client, but the attach-time shared decision kept resize
  disabled permanently. The host's measured sshd settings are
  ClientAliveInterval 60 and ClientAliveCountMax 3: an abruptly cut connection
  can remain listed for approximately three minutes.
  - Every solo and shared attach uses exec env
    SWITCHBOARD_ATTACH=<profile>:<instance>:<attach> tmux -S ... with the
    existing option segments. The profile id is 24 random bytes encoded as
    base64url, persisted in app.getPath('userData')/remote-attach-profile-id.
    With SWITCHBOARD_DATA_DIR, this is <data-dir>/electron/remote-attach-profile-id;
    otherwise it is under Electron's installed-app userData directory. The
    file is created exclusively with wx on first use; an existing valid file
    is read without rewriting it, including when another creator wins the race.
    A corrupt or unreadable file, or failed creation, is logged and produces a
    random in-memory identity for this run only. The untrusted file is never
    overwritten. The instance id is generated once when the main process loads
    the adapter module, and the attach id is generated for each attach. All
    tag components must match [A-Za-z0-9_-] and have 1–128 characters; persisted
    profile ids have 22–128 characters. Invalid identities return ok:false from
    attach before any remote command. Using the env executable avoids
    login-shell-specific variable assignments and shell-pid assumptions.
  - When the discovery count is nonzero or unknown, one additional bounded
    command lists client_pid and client_tty and reads each client's tag from
    /proc/<client_pid>/environ. A quoted sh -c isolates its POSIX control flow
    from the login shell. The command emits at most 201 records, reads at most
    64 KiB plus one overflow byte per environment, and has a 5 s timeout and
    128 KiB output cap. More than 200 clients, incomplete records, invalid pids,
    failed commands and unreadable environments fail closed. Oversized
    environments supply no trusted tag.
  - **Classification:**

    | Client evidence | Action |
    | --- | --- |
    | No tag, malformed tag or unreadable environment | Real client; shared |
    | Tag from another profile, including a live dev/test-pr instance on this machine | Real client; shared; never detach |
    | This profile and another instance, with validated /dev/pts/N tty | Detach that client by tty; solo immediately if no real clients remain and a valid local size is known |
    | This profile and this instance, another attach id | Real client; shared; never detach |
    | Invalid tty or unsuccessful detach | Remain shared |

    The single-instance lock is keyed on userData, not the machine. It proves
    that another instance of this profile is dead; idle time is not the proof.
    Installed, dev and test-pr instances can run beside each other with distinct
    data directories. Hostnames neither establish ownership nor distinguish
    computers. Untagged clients, other profiles and unreadable environments
    are never detached. No client_activity threshold
    is used. The three-second attach-time retry and session-option markers
    are removed; no marker cleanup is needed.
  - A shared attach polls list-clients every SHARED_MODE_POLL_INTERVAL_MS
    (3 s after the preceding evaluation finishes), using the same bounded
    environment discovery. It promotes only when the single listed client has
    this exact profile, instance and attach id. The poll never detaches clients.
    Recursive timeouts avoid overlapping requests; timers are unref'd and
    cancelled on detach/exit, and start only once a valid local size is known.
    ptyProcess.reevaluateMode() shares the in-flight operation and remains
    exposed for a future control, without adding a control here.
  - Promotion applies session-scoped status off, mouse on and window-size
    latest, enrolls the existing full restore once, and sends the latest valid
    local size once. Subsequent resizes are forwarded. A confirmed solo attach
    never silently downgrades. Titles keep the #290 rule. Failed polls and
    option applications retry conservatively. Detach remembers a potentially
    partial option application and waits for it before restoring.
  - Polling avoids session-wide hooks that could conflict with host hooks or
    survive connection loss. A failed list-clients exits before producing a
    usable empty list. Tests exercise the production adapter with fake SSH/PTY
    ports and injected clocks; a real host and the SSH/tmux chain have not been
    exercised here.

- **Promotion sizing notification, issue #452 after #453.** The attach handle's
  onResizeAllowed subscriber runs once after a live shared-to-solo promotion,
  retaining the promotion log. registerRemoteAttachSession updates the current
  session's remoteResizeAllowed flag and sends remote-resize-allowed(sessionId)
  through preload.onRemoteResizeAllowed; exited or replaced sessions are
  ignored. The renderer enables solo sizing and schedules its existing
  debounced fit to send one current fitted size, even if unchanged. Later
  resizes, return refresh and the solo PTY nudge are enabled. Unknown or closed
  entries ignore the notification. No promotion means no event, and solo never
  silently downgrades. See .ai/contexts/terminal-refresh.md for coalescing and
  hidden-entry behavior.

- **Solo attach parity, issue #253.** A solo attach now makes the remote
  tmux session look and behave like a local terminal instead of a plain
  multiplexer view: `buildAttachCommand(socket, target, { solo, pre })`
  prefixes the attach with three session-scoped (never `-g`, never `-w`)
  `tmux ... \; ...` sets — `status off`, `mouse on`, `window-size latest` —
  when `solo` is true, and emits the unchanged pre-#253 command when it
  isn't (shared attach never touches another client's view — qualified by
  issue #290 below: title forwarding is the one exception). The probe
  (`buildProbeCommand`) now also reads `mouse` and `window-size` alongside
  `status`, and `parseProbeOutput` returns their raw pre-attach values as
  `pre: { status, mouse, windowSize }` (`null` when an option is absent
  from the probe output) in addition to the existing `cols`/`rows`.
  `tmux show-options -A` marks an option inherited from a higher scope
  with a trailing `*` on the option name (e.g. `status* on`, measured on
  tmux 3.6) — `pre.<opt>` is `null` for both "absent" and "inherited
  (starred)", since both mean no session override exists and restore
  must `set -u`; it is non-null only for an actual session-scoped
  override (unstarred), restored via `set -t`. The star never affects
  the sizing rule — a starred `status* off`/`on`/`<n>` sizes
  `statusLines` exactly like its unstarred form. On
  detach, when the attach was solo, the adapter fires a best-effort,
  fire-and-forget `buildRestoreCommand(socket, target, pre)` ssh call that
  sets each option back to its probed value (`set -t <target> <name>
  <value>`) or, when the probed value was `null`, unsets the session
  override (`set -u -t <target> <name>`) so the host's own global option
  applies again. The restore call's failure is only logged — it never
  throws out of `detach()` and never blocks the local ssh client from being
  killed. No shared-attach restore is ever sent for these three options,
  because a shared attach never applied them in the first place — issue
  #290 below adds a restore that shared detach DOES send, but only for the
  two title options a shared attach does touch.

- **Title forwarding, issue #290.** An attached remote row went mute
  overnight (v0.0.79 field trace, `.work-files/switchboard/trace-2026-09-13-
  nuit.md`): two VPS sessions attached 9+ hours, transcripts still being
  written, zero busy signal on either row. Cause: since #273, an attached
  row is driven only by the OSC title sequences the CLI writes to its own
  terminal — and inside tmux those sequences update the *pane* title, which
  tmux forwards to the outer terminal (what an ssh client actually sees)
  only when the session option `set-titles` is on, formatted by
  `set-titles-string`. Measured on the target host: tmux 3.6, `set-titles`
  off, `set-titles-string` at its built-in default,
  `` #S:#I:#W - "#T" #{session_alerts} `` — which additionally wraps the pane
  title in surrounding text, defeating `classifyTitleActivity`'s reliance on
  the *first code point* of the title even if forwarding were on. Fix:
  `buildAttachCommand` now always prefixes the attach with `set -t <target>
  set-titles on \; set -t <target> set-titles-string '#T'` — `#T` alone,
  no wrapper — **in both solo and shared mode**, unlike `status`/`mouse`/
  `window-size`.
  - **This is a deliberate, session-wide side effect on another human's
    terminal — not a no-op for a shared attach.** `set-titles` and
    `set-titles-string` are *session* options: turning them on changes what
    every client currently attached to that session sees as its own outer
    terminal's title (each ssh/tmux client renders the forwarded pane title
    into its own window/tab title — session-wide because the option lives on
    the session, client-local only in *where* each client happens to render
    it), unlike a purely local rendering choice. This is unlike `status`/
    `mouse`/`window-size`, which change the shared *screen or input* another
    human is looking at or typing into — the harm case #253 refuses. A title
    change is comparatively minor (a tab/window title, not the pane content
    or input behavior) and is reverted on detach (below), so the decision
    made here is: **forward titles in shared mode anyway** — a permanently
    mute attached row is the worse defect (the #290 field trace may well have
    been a shared attach), and the side effect is both small and temporary.
    State this plainly rather than claiming no visible effect.
  - **`#T` must be quoted.** The attach command executes over `ssh -tt
    <alias> <command>` with the whole `buildAttachCommand(...)` return value
    passed as a single argv element — ssh joins it back into one string and
    hands it to the remote's login shell (`$SHELL -c command`), it is never
    exec'd directly. In POSIX shell, an unquoted `#` at the start of a word
    starts a comment that swallows the rest of the line — `set-titles-string
    #T` would silently delete `\; attach -t <target>` and every attach would
    hang with no pty ever spawned. Wrapping it as `'#T'` keeps the `#`
    inside a quoted context, where the comment rule never applies, and tmux
    still receives the literal two-character format string `#T` (single
    quotes are removed by the shell before tmux ever sees the argument).
  - **The probe reads back both options the same way as `status`/`mouse`/
    `window-size`.** `buildProbeCommand` appends two more `show-options -A`
    segments (`set-titles`, `set-titles-string`) ahead of the existing
    `list-clients`/cmdline-check tail, and `parseProbeOutput` adds
    `pre.setTitles`/`pre.setTitlesString` to its return value, following the
    same starred/inherited-is-null rule as the other three options.
    `parseDiscoveryProbeOutput`'s slice widened from `parts.slice(1, 5)` to
    `parts.slice(1, 7)` to carry the two extra fields through to
    `parseProbeOutput`; `clientCount`/`cmdlineHasClaude` shifted two
    positions later (now `parts[7]`/`parts[8]`) — this is regenerated and
    consumed by the same call, never persisted, so there is no wire-format
    compatibility concern across a version boundary the way there would be
    for a value the CLI itself writes to disk.
  - **`set-titles-string` is a string option, not a bare word like the
    other three — a dedicated parser and a dedicated restore quoting path
    exist because of it.** `tmux show-options -A` prints a string-valued
    option in tmux's own escaped form whenever it contains characters that
    need it — quoting with `'` or `"` and backslash-escaping — which `bare
    \S+` parsing (used for `status`/`mouse`/`window-size`) cannot capture at
    all once the value contains a space. `parseTitleStringToken` matches to
    the end of the segment, then **unescapes it into the real value** (the
    quote marks and backslashes are tmux's printing artifact, not part of
    the option's actual content); starred (inherited) still reads as `null`,
    same rule as the other three.
    - **Corrected 2026-09-14 — the first version of this fix was wrong,
      caught by live measurement on tmux 3.6 (a throwaway server).** It kept
      the raw printed token untouched and restored it as `set -t <target>
      set-titles-string '<raw token with tmux's own quoting still in it>'`,
      reasoning that tmux's own command-line parser would undo tmux's own
      quoting the way it does for a `.tmux.conf` line. Measured instead:
      `tmux set -t t set-titles-string '"#S:#I:#W - \"#T\" #{session_alerts}"'`
      stores the value **literally**, quote marks, backslashes and all —
      `show-options` then prints it back double-escaped
      (`` "\"#S:#I:#W - \\"#T\\" #{session_alerts}\"" ``). **An argv value
      tmux receives on its own command line is never re-parsed through
      tmux's config-file/command-prompt quoting** — only the text `tmux
      show-options` *prints* goes through that quoting, to make it
      re-typeable at the `:` prompt or in a `.tmux.conf` line, not to be
      re-quoted proof against a shell-passed argv. The fix is to do the
      unescaping ourselves: `parseTitleStringToken` reverses tmux's printed
      form back to the real value, and `buildRestoreCommand` sends that real
      value back with **shell single-quoting only** (`'<value>'`, any
      embedded `'` escaped as `'\''`), which tmux then stores literally —
      confirmed on the host (`set -t t set-titles-string '#T'` then
      `show-options` prints `"#T"`; `set -u` brings back the inherited
      default).
    - **The unescaping rule, reverse-engineered from a 23-case table
      measured live on tmux 3.6, 2026-09-14** (`SET_TITLES_STRING_CASES` in
      `test/remote-attach.test.js`, one input value per row, mapped to
      exactly what `show-options` printed for it — 20 rows from the first
      measurement pass, 3 more added later: empty string, and a value that
      is itself entirely wrapped in `'...'` or `"..."`): if the token starts
      and ends with the same quote character (`'` or `"`, length ≥ 2), strip
      that outer pair; then scan left to right unescaping `\n`→LF, `\t`→TAB,
      and `\<any other char>`→that char (drop the backslash). This one rule
      reproduces every measured case without needing to model *why* tmux
      picked a given wrapper quote or which characters it decided to escape
      (space/`;`/`$`-before-a-name-char/quotes/non-ASCII trigger quoting;
      `~`/bare backslash/bare LF/TAB do not; the wrapper quote is whichever
      of `'`/`"` avoids escaping an embedded quote of that kind, defaulting
      to `"` when both or neither are present) — the strip-then-unescape
      algorithm is symmetric to whichever choice tmux made, which is also
      why the 3 later rows needed no rule change: a value that already
      looks quoted on the outside is still just one more case of "matching
      outer pair, strip it." Proven in `test/remote-attach.test.js`,
      table-driven over the 23 measured pairs: `parseProbeOutput` on tmux's
      printed form recovers the original input; `buildRestoreCommand`'s
      `set-titles-string` segment is exactly `set -t <target>
      set-titles-string ` + `shellSingleQuote(input)`; and, independent of
      the production encoder, the segment is structurally checked to start
      and end with `'` and to carry no bare (unescaped) `'` once every
      `'\''` escape is removed.
  - **Restore now runs on every detach, shared included — solo restores all
    five options, shared restores only the two title options, subject to the
    live-client-count gate below.** Earlier this fix gated the whole restore
    on `solo`, matching `status`/`mouse`/`window-size` — but since the `set`
    for titles now also fires in shared mode, that left a **baseline
    ratchet**: after one shared attach the session stayed at `set-titles on`
    / `set-titles-string '#T'` forever, and every later probe would read
    that back as the pre-existing baseline to restore *to*, permanently
    losing whatever the session had before its first shared attach.
    `buildRestoreCommand(socket, target, pre, { includeBase, includeTitles })`
    takes two independent flags (each defaults `true`) instead of one
    `titlesOnly` switch — three of the four combinations are real:
    both true (today's solo full restore), titles-only (today's shared
    restore), and base-only (new, see below); all-false returns `null`
    (nothing to send) rather than an empty `tmux -S '<socket>' ` command.
    `detach()` always calls it, computing `includeBase: solo` (unchanged --
    still exactly the pre-#290 solo rule) and `includeTitles` from the
    live-client-count probe immediately below.
  - **Multi-client race, follow-up fix.** Two Switchboard clients attached to
    the same remote tmux session (two machines, or two windows) raced each
    other's title restore: client A detaching restored `set-titles`/
    `set-titles-string` to A's own probed pre-attach baseline, turning
    forwarding off (or back to A's idea of "before") **while client B was
    still attached and relying on it** — B's row would go mute mid-session
    with no detach of its own. Symmetrically, if B detached afterwards, B's
    own restore (based on B's probed baseline, captured while A's forwarding
    was already on) could re-apply `on`/`'#T'` *after* A had genuinely
    restored the pristine original, leaving the session's title-forwarding
    state permanently wrong relative to what it was before either client
    ever attached. Fix, bounded to the title options only: `detach()` runs
    one more small, non-interactive probe — `buildClientCountProbeCommand
    (socket, target)` (`tmux -S '<socket>' list-clients -t <target>
    2>/dev/null | wc -l`, the same `list-clients` query and
    `parseClientCount()` the attach-time probe already uses, just against
    the socket/target this call already has rather than rediscovering
    them) — and sets `includeTitles: count <= 1`.
    - **Ordering, corrected 2026-09-14 — the probe must run BEFORE
      `raw.kill()`, not after.** The first cut killed the local ssh client
      first and only then ran the client-count probe, reasoning that "our
      own about-to-close client may still show up in the count" as a
      possibility to tolerate with `<=` instead of `<`. That reasoning was
      backwards: on a fast network the local ssh process is very likely
      already gone (or its tmux client already dropped) by the time the
      probe's own ssh round trip lands, so with exactly one real peer still
      attached the probe would read back `1`, `1 <= 1` would restore, and
      forwarding would be switched off under that peer — **the exact
      failure this fix exists to prevent, masked in easy conditions and
      live in exactly the conditions (slower networks, slower tmux) where
      it would matter most.** `restoreOnDetach()` now runs the client-count
      probe **first**, while our own client is unconditionally still
      attached, and only calls `raw.kill()` afterward (still guarded by its
      own try/catch, same as before). With that ordering, "our own client
      counts as one of the attached clients" is not a possibility to
      tolerate — it is guaranteed, every time, by construction: `count <=
      1` now means "nobody but us," not "maybe just us, maybe we already
      left." `count >= 2` means at least one other real client was attached
      at the moment we checked; the title restore is skipped and logged at
      debug (`log.debug`, falling back to `log.info` if the injected `log`
      carries no `debug()`), never at warn — this is an expected, routine
      outcome, not a failure.
    - **Accepted trade-off: detach now waits for this probe, bounded by
      `DETACH_CLIENT_COUNT_TIMEOUT_MS` (5 s, shorter than the 15 s attach
      probe because the user is watching the tab close), before the local
      ssh client is killed.** `ptyProcess.kill()` no longer ends the local client
      synchronously; it starts `restoreOnDetach()`, which is awaited by
      nothing (still fire-and-forget from the caller's perspective) but now
      performs the probe, then the kill, then the restore call, in that
      order. The alternative — kill first, then require the live count to
      read exactly `0` (proof our own client is provably gone) before
      trusting a "last one out" restore — was rejected: it does not avoid a
      wait, it relocates and lengthens it (now needing the *post-kill*
      count to visibly drop, which depends on tmux noticing the disconnect
      *after* the ssh teardown completes, on top of the same probe round
      trip), and it adds a genuinely new failure mode (poll until `0`, or
      guess a single retry, either more code or a coin flip) for no
      correctness gain over probing first. Probing first costs one ssh
      round trip of added latency before the local terminal visibly closes
      — the same order of magnitude as the attach-time probe already
      accepted, and worst-case bounded by a 5 s kill timer; a probe that
      times out falls back to restoring.
    - **`status`/`mouse`/`window-size` are untouched by this fix** —
      `includeBase` stays exactly `solo`, per the instruction that started
      this fix: those three already had their own correct-by-construction
      rule (a shared attach never sets them, so a shared detach has nothing
      to put back), and reopening that rule was out of scope. **If the
      client-count probe itself fails or returns something
      `parseClientCount` can't parse, `includeTitles` falls back to
      `true`** — restoring is the pre-existing (safe-by-comparison)
      behavior, and a probe failure is not treated as evidence that someone
      else is still attached.
    - **What this coordinates, and what it deliberately does not.** This
      makes "the last client out restores the title options" hold in the
      common case (a probe running right before the restore catches almost
      every real multi-client overlap). It does **not** make the two
      options fully consistent across an overlapping multi-client episode
      in every case — **no cross-instance state exists**: two Switchboard
      processes (or two hand-run `ssh`/`tmux attach` sessions) never
      coordinate with each other directly, only through what the live
      `list-clients` count happens to read at the moment of each one's own
      detach, which is inherently racy between concurrent detaches. The
      accepted residual gap: a **solo** attach that happens *after* a
      multi-client episode probes whatever `set-titles`/`set-titles-string`
      were left at (typically `on`/`'#T'`, since some client's shared
      attach turned them on and no detach happened to be the qualifying
      "last one out") as *its own* pre-attach baseline, and will faithfully
      restore back to that value on its own later detach — carrying forward
      a value that was arguably never the session's true original. This
      residual is bounded to the two title options (never `status`/`mouse`/
      `window-size`) and is accepted rather than solved here: solving it
      fully would need either a shared external ledger of "what was here
      before anyone touched it" or a lock across attach attempts, both out
      of scope for a fix whose brief was "bounded and simple." Proven in
      `test/remote-attach.test.js`: detach-time count 0 or 1 still restores
      the titles (solo case, all five options); count 2 restores only
      `status`/`mouse`/`window-size` (solo) and skips the title segment,
      logging why; the same count-2 case on a **shared** attach sends no
      restore call at all (`buildRestoreCommand` returns `null` — nothing
      was ever eligible); a failing client-count probe falls back to
      restoring the titles. Every one of those cases also asserts the
      ordering directly — a fake `runRemoteCommand` snapshots the local
      pty's `killedCount()` at the moment the client-count probe runs and
      the test checks it is still `0` there, then `1` once the whole detach
      has settled.

- **This is the first thing to populate the session-handle seam from issue
  #220** (see `.ai/contexts/trigger-watcher.md`, "Session handle"): a
  remote-attach entry sets `host: alias`, `kind: 'remote-attach'`, and
  `handle: attachResult.ptyProcess` — the same wrapper object also stored as
  `session.pty`. That works without a second object because the wrapper
  already exposes `write`/`isAlive` alongside the pty-duck-type methods
  (`resize`/`kill`/`onData`/`onExit`/`pid`) `pty-ops.js` and `wireSessionPty`
  need; `getPtyForSession` takes it as `session.handle` given, unmodified,
  exactly the branch #220 left unexercised. Proven in
  `test/remote-attach.test.js` ("pilots the fake remote pty through write()
  and kill()") with a bare fake pty, no real node-pty involved.

- **Corrected 2026-09-08 (issue #221) — the socket is discovered from the
  process's own `TMUX` environment variable, not derived from the
  descriptor's `tmux` field.** The assumption logged above ("the CLI always
  names its socket after its session") was wrong: the descriptor's
  `session:window.pane` string is a **target**, never a socket name, and the
  real sockets on the host (`/tmp/tmux-0/orchestration`,
  `/tmp/tmux-0/orchestration-harness`) don't match the session name at all —
  the first click on a remote session failed with `error connecting to
  /tmp/tmux-0/main`. `buildProbeCommand(pid, target)` now reads
  `/proc/<pid>/environ` on the remote host (`tr '\0' '\n'`, since the file is
  NUL-separated), extracts `TMUX=<socket>,<server-pid>,<index>`, and takes the
  part before the first comma — all inside the **same** non-interactive ssh
  call the size probe already made (the OpenSSH client on Windows has no
  `ControlMaster`, so a second call is a second full connection, not a free
  one). The discovered socket rides back to the caller as a prefix segment on
  the probe's stdout (`parseDiscoveryProbeOutput`) so the later interactive
  `attach -S <socket>` uses the same value, quoted, never re-derived. A pid
  with no readable `TMUX` (dead process, unreadable `/proc`) degrades to a
  refusal naming the reason — never a guessed socket. `descriptor.pid` was
  already validated as a positive integer upstream (`parseSessions`, above);
  `isValidPid`/`isSafeSocketPath` in `remote-attach.js` re-check it anyway
  because this file builds shell command strings from it.
- **`supports()` grew a `pid` requirement in the same change** — a
  descriptor with a `tmux` field but no usable `pid` can never discover a
  socket, so routing it to an attach attempt (`main.js`'s
  `annotateRemoteAttachable`) would only ever produce an error terminal. Every
  descriptor `parseSessions` accepts already carries a valid `pid`, so this is
  a no-op on real data; it only changes routing for a hand-built or malformed
  descriptor.

- **Pid-reuse guard (F6, audit-fable-2026-09-11).** Descriptors now survive a
  failed refresh cycle for up to the backoff window (#255, above) — long
  enough for the CLI to die and the OS to hand its pid to an unrelated
  process on the same host. Before this fix, `buildProbeCommand` read
  *whatever* process now holds that pid's `TMUX` environment variable and, if
  it was solo, reconfigured and attached to whatever tmux session that
  process happened to be in — no check that it was still the session the
  descriptor named. `buildProbeCommand` now appends one more
  `PROBE_SEP`-delimited segment: `tr '\0' ' ' < /proc/<pid>/cmdline | grep -qi
  claude && echo 1 || echo 0` (`buildProcCmdlineCheck`), read back by
  `parseDiscoveryProbeOutput` as `cmdlineHasClaude` (`true`/`false`, or `null`
  for a probe predating this segment). `attach()` runs this check only when
  `descriptor.procStart != null`; on a `false` result it returns `{ ok:
  false, error: 'pid <n> no longer belongs to this session (process start
  differs)' }` before any `spawnPty` call — no attach, no `set`. A descriptor
  with no `procStart` keeps today's unverified behavior.
  **Not what the finding asked for, and why:** the audit wanted
  `descriptor.procStart` compared against `/proc/<pid>/stat`'s starttime
  (field 22, clock ticks since boot). The one measured `procStart` sample
  this repo has (`.ai/contexts/cli-session-state.md`) is
  `"134319945380279381"`, captured on a **Windows** CLI — 18 digits, the
  right order of magnitude for a Windows `FILETIME` (100 ns since 1601), not
  for Linux clock ticks since boot (which would need centuries of uptime to
  reach 18 digits at 100 Hz). Whether the CLI's own remote/Linux code path
  produces something on the *same* scale as `/proc/<pid>/stat` field 22 is
  unverified — ssh access to a real host to check was out of scope for this
  fix (`no ssh to any host` was a hard constraint). Comparing two values on
  possibly-incompatible scales risks shipping a check that either always
  refuses (units never line up) or silently never refuses (units happen to
  overlap by coincidence) — worse than the cmdline check in both directions.
  The `cmdline`-contains-`claude` check is strictly weaker than an exact
  start-time match (it would not catch a *second* claude CLI reusing the
  pid), but it does catch the audited scenario — pid reused by an unrelated
  process in another tmux server — without depending on that unverified
  format match. `descriptor.procStart != null` is still the gate, matching
  the interface the finding asked for.

- **`ConnectTimeout=5` on the probe and restore-on-detach ssh calls (F10,
  audit-fable-2026-09-11).** `defaultRunRemoteCommand`'s ssh spawn had a kill
  timer (`DEFAULT_PROBE_TIMEOUT_MS`, 15 s) but no `ConnectTimeout` — a
  half-open connection (portable asleep, NAT gone stale) took the full 15 s
  to fail instead of failing fast at the TCP handshake. `buildRemoteCommandArgs
  (alias, command)` now builds the argv (`-o BatchMode=yes -o
  ConnectTimeout=5 -n <alias> <command>`), exported so the argv shape is
  tested directly without spawning ssh. **Known, accepted gap: if the app
  crashes mid-session, `before-quit`'s `detach()` never runs, so a solo
  attach's restore-on-detach ssh call (`status off`/`mouse on`/…) never
  fires** — the remote tmux session is left with the solo-attach options set
  until something else attaches and detaches cleanly. `ConnectTimeout` bounds
  how long a *reachable-but-slow* restore takes; it does nothing for a
  restore that never gets scheduled at all.

### `stop()` cancels, `dispose()` ends -- they are not the same thing

`createSshTransport().dispose()` is **terminal**: it sets a flag every later
`run()` checks, so once disposed the transport answers
`ssh inventory failed (exit -1): transport disposed` forever. It exists for
application shutdown.

The indexer's `stop()` must therefore **not** call it. `stop()` cancels what is
in flight (`cancelInFlight()`) and clears the timer; `dispose()` on the indexer
is the shutdown path and is the only caller of the transport's `dispose()`.

Why this is not a detail: `restart()` is `stop()` then `start()`, and
`restart()` is exactly what the `remote-hosts-apply` IPC calls when a host is
saved in Settings. With `stop()` disposing, declaring a host at runtime killed
the transport in the same breath, and the feature could only ever have worked
for a host already declared at launch -- that is, never on first use. Measured
in the field on 2026-09-07 (v0.0.68): the mirror directory was created and
stayed empty, one warn line in `main.log` and no user-visible error.

The tests that hold this: "restart() after adding a host keeps the transport
usable" and "dispose() is terminal", in `test/remote-index.test.js`.

## Archived projects (issue #473)

**Archive folder** on a project header hides the folder, and its nested
worktree folders, until a session it did not hold at archive time appears in
it. The state is the `archivedProjects` settings row:
`{ [entry]: { archivedAt, knownSessionIds } }`.

- **Entry.** `archivedEntry(alias, projectPath)` in `archived-projects.js`:
  `path.resolve(projectPath)` for a local group,
  `<alias>::<posix-normalised path without trailing slash>` for a remote one.
  A bare entry matches the local group only, unlike a bare `hiddenProjects`
  entry, which matches every host.
- **Rule.** `applyArchivedProjects(projects, archived, showArchived)` is pure
  and runs in `get-projects` (through `applyAndPersistArchived`) on the output
  of `mergePlaceholderSessions(buildProjectsFromCache(showArchived))`:
  1. a group whose entry is stored comes back when it holds a session with no
     `parentSessionId`, not archived, and not in `knownSessionIds`; its entry
     is cleared;
  2. a visible worktree group (`worktreeParentPath`, same alias) clears its
     parent's entry, so the parent header comes back to hold it. A cleared
     parent does not clear its children;
  3. a group whose entry remains is dropped unless `showArchived`, so Show
     archived and search (which renders from `cachedAllProjects`) still see it.
  The setting is written back only when an entry was cleared.
- **Main-process side.** `archiveProjectFolders`, `reenableOfferedSchedules`
  and `dismissReenableOffer` in `archived-projects.js` hold the logic of the
  `archive-project`, `reenable-project-schedules` and
  `dismiss-schedule-reenable-offer` handlers, with every effect injected
  (`archiveDeps()` in `main.js`); they are synchronous, so no read-modify-write
  of a setting has an `await` in it.
- **Snapshot.** `archiveProjectFolders` computes `knownSessionIds` per group,
  after `refreshFolder` of every folder of the group (the `row.folder` of its
  cached rows with the same alias and entry, plus its encoded folder, kept when
  the directory exists): the top-level ids of the group in
  `mergePlaceholderSessions(buildProjectsFromCache(true))` (archived rows, plain
  terminals, remote placeholders), the `activeSessions` keys of the group and
  their `realSessionId`, and the `*.jsonl` basenames on disk. A running
  session belongs to the group when `archivedEntry(session.host, projectPath)`
  equals the group's entry: a local entry is an absolute path and a remote one
  starts with `<alias>::`, and an alias holds no `:`, so the entry comparison
  already separates hosts.
- **Order.** The snapshot is taken and the entries written before any schedule
  is disabled, so a failure while taking it disables nothing; each disabled
  file is then added to its entry and the entries written again. If that second
  write fails, the error response carries `disabled` and the renderer's alert
  names the schedules that were turned off.
- **Refusal while indexing.** `get-project-archive-plan` and `archive-project`
  refuse while `!isInitialScanComplete()`: a snapshot taken from a partial cache
  would miss sessions and the folder would reappear on its own.
- **Schedules.** `archivePlanForGroups` lists the enabled schedules of the
  local groups in the schedule registry; `archive-project` re-scans and disables
  only the ones the renderer confirmed — see
  [schedule-runner.md](schedule-runner.md) ("Disabling a schedule file").
- **Clearing by hand.** `add-project` and `delete-worktree` call
  `clearArchivedEntry`.
- **Re-enable offers.** An entry records `disabledSchedules`, the files the
  archive actually disabled. When an entry leaves `archivedProjects` (a
  reappearance in `get-projects`, or `clearArchivedEntry`), a non-empty list
  moves to the `scheduleReenableOffers` setting, `{ [entry]: { disabledSchedules,
  archivedAt, failed? } }`, in the same synchronous step. `get-projects` marks
  each listed project holding an offer with `reenableOffer: { names, failed? }`,
  names read from the files still present. The sidebar shows it as an inline
  notice in the group (`buildReenableNotice`); **Turn back on** calls
  `reenable-project-schedules`, which turns back on the files still reading
  `enabled: false` and keeps only the failures in the offer, so the notice
  stays and reports them; **Dismiss** calls `dismiss-schedule-reenable-offer`.
  Archiving the folder again deletes its offer and carries the offered files
  that still read `enabled: false` into the new entry's `disabledSchedules`,
  so they are offered again on the next reappearance. A group holding an offer
  is never auto-collapsed, so the notice stays in view.
- **Differences from `hiddenProjects`.** `archive-project` deletes no setting,
  cache row, search row or schedule registration, and a new session brings the
  folder back; Hide Project does both and never comes back on its own.
- **Renderer.** `archiveProjectFolder` (`public/sidebar.js`) reads the groups
  and sessions from `cachedAllProjects`, never from the rendered list, which is
  a search projection during a search; with no matching cached group it only
  reloads. The stop is all-or-nothing: every session is stopped first, and one
  refusal leaves everything unarchived. The dialog is `showChoiceDialog`
  (`public/choice-dialog.js`).
- **Worktree nesting.** `renderProjects` nests a worktree group only under a
  listed group of the same alias and repository path
  (`public/worktree-nesting.js`, a classic `<script>` in the renderer that
  `archived-projects.js` also `require()`s, so both sides follow the same
  regex). A worktree whose repository is hidden on its host (`hiddenProjects`,
  bare or `<alias>::` entry, matched exactly as `isProjectHidden` does) carries
  `hiddenRepository`, set in `applyAndPersistArchived`, and is drawn nowhere:
  `isProjectHidden` hides exact paths only, so hiding a repository has to hide
  its worktree groups this way. The rule is `isHiddenRepositoryWorktree`
  (`public/worktree-nesting.js`); `loadProjects` (`public/app.js`) applies it
  too to the group it builds for a pending session, reading
  `global.hiddenProjects` only when that session is in a worktree. Any other
  worktree whose repository is not listed is drawn at top level.
- **Cold scan.** A folder not yet in `cache_meta` during the initial scan shows
  empty under its decoded path, which does not match its entry; it hides again
  once indexed. Matching on the folder key instead would break the remote and
  merged-folder cases.

## If you change this, also check

- `archived-projects.test.js` — covers the archived-folder rule, the snapshot sources, the worktree step, the archive plan and the re-enable offers
- `dom-project-archive-folder.test.js` — covers the **Archive folder** flow and the alias-aware worktree nesting
- `dom-choice-dialog.test.js` — covers `showChoiceDialog`
- `archive-project-wiring.test.js` — covers the `main.js`, `preload.js` and `dialogs.js` wiring of archived folders
- `archive-project-assembly.test.js` — covers `archiveProjectFolders`, `reenableOfferedSchedules` and `dismissReenableOffer` with their effects injected
- `app-pending-hidden-repository.test.js` — covers the pending-session group of a hidden repository's worktree
- `remote-hosts.test.js` — covers folder-key parsing, alias validation and the `isSafeRelPath` guard
- `remote-mirror.test.js` — covers the inventory diff, the no-op second pull, deletions, and both failure modes, against a fake transport
- `remote-transport.test.js` — covers the ssh/scp argv, inventory parsing, the timeout kill and `dispose()`, with `spawn` injected; also covers `LIST_COMMAND`'s exact text (issue #211's `.key`-exclusion and single-ssh-call pins), `splitListOutput()` and `parseSessions()`; and (issue #278) `listFiles()` marking a live descriptor `descriptorOnly` against the same call's own inventory, keeping a descriptor-only entry while still dropping a dead (`ALIVE:0`) one
- `remote-transport-shell.test.js` — runs `LIST_COMMAND` through a real `sh -c`, not a fake stdout fixture: a missing `.claude/projects` must exit non-zero, a missing `.claude/sessions` must still exit 0 with the marker present, a `.key` file, a directory and a symlink named like a descriptor must all be excluded from what reaches stdout (counted by ALIVE markers, so the check does not depend on whether the valid descriptor's pid is alive), and (F9) the ALIVE marker follows the presence of the pid's directory — decided on every host by pointing the command's `/proc/$pid` check at a directory the test creates, and against the real `/proc` on Linux only, with the test runner's own pid as the live one
- `remote-index.test.js` — covers "no host declared: no timer, no ssh call", the 60 s floor, per-host failure isolation and alias pruning, and that `getRemoteSessions()` is cleared (not left stale) after a cycle whose `sync()` throws; and (issue #278) `getPlaceholderSessions()`/`getAllPlaceholderSessions()` synthesizing and then dropping a placeholder once its transcript is indexed, and `findSessionAlias()`
- `remote-indexing-e2e.test.js` — covers the `<alias>::` prefix reaching session rows, the search entries, the metrics and the sidebar
- `merge-placeholder-sessions.test.js` — covers `main.js`'s `mergePlaceholderSessions()` (issue #278): appending to an existing project group, creating a new one, and never duplicating a session id a real row already won
- `dom-sidebar-remote-session.test.js` — covers the remote badge and the read-only click routing
- `dom-sidebar-remote-placeholder.test.js` — covers the placeholder row (issue #278): renders `.is-alive`, a stop control and status/age, has no transcript affordance, and an attachable placeholder opens a terminal rather than the transcript viewer
- `derive-project-path.test.js` — covers the worktree-collapse + cwd extraction paths
- `db-daily-activity.test.js` — covers heatmap aggregation
- `read-session-file.test.js` — covers header parsing
- `read-session-file-slash-command.test.js` — covers the `/clear` bookkeeping transcript and slash-command titles
- `db-purge-command-summaries.test.js` — covers migration v9's surgical purge
- `main-ctx-db-wiring.test.js` — covers the `ctx.db` allow-list ⊇ session-cache.js usage invariant above
- `read-session-file-bridge-session.test.js` — covers `bridgeSessionId`/cutoff extraction and `mergeBridgeGroups()`'s grouping/re-derivation/re-parenting rules
- `bridge-divergent-history.test.js` — covers divergent UUID/legacy histories across full, incremental and worker indexing.
- `bridge-history-refresh.test.js` — covers three-member continuation ownership, header-only synchronous flushes, one-time repaired-folder worker indexing, incremental recovery after write failure, remote repair pruning, running-row retention, promotion/deletion, lazy mixed UUID payload exclusion, complete-UUID signature re-reads and the dormant remote repair race.
- `db-bridge-uuid-repair.test.js` — covers one-time UUID invalidation of cache/metrics/FTS/folder gates, preservation of user state and subagents, persisted repaired-folder keys, no-op reopen, rollback and retry in separate top-level tests with independent timeouts.
- `db-bridge-session-migration.test.js` — covers the schema-reconciliation path that adds `bridgeSessionId`/`mergedIntoSessionId`, forces a re-index, and `getTotalCounts()`'s exclusion
- `session-cache-bridge-dedup.test.js` — covers the compaction-mirror union merge through `refreshFolder()`, `readFolderFromFilesystem()` and `buildProjectsFromCache()`'s rollup, using the real fixture's shape
- `db-session-metrics.test.js` — covers the `getTotalCounts` pure-JS mirror's `mergedIntoSessionId` exclusion (kept in sync with the real SQL by the SQL-level test above)
- IPC consumers of cached payloads: `get-projects`, `get-active-sessions`, `search`, `get-stats-from-db`, `get-work-files`, `list-subagents`, `read-session-jsonl`
- Renderer: `public/sidebar.js` (consumes `buildProjectsFromCache` output), `public/stats-view.js` (consumes `getDailyActivity`)
- If you add a new `session_cache` column, update the SELECT in `getCachedByFolder` — it's `SELECT *` so additions land automatically, but the renderer needs to know about them.

## Schema reference

```
session_cache(sessionId PK, folder, projectPath, summary, firstPrompt,
              created, modified, messageCount, slug, aiTitle,
              parentSessionId, agentId, subagentType, description,
              fileMtime, bridgeSessionId, mergedIntoSessionId, entrypoint, scheduleSlug)
session_meta(sessionId PK, customTitle, starred, archived)
cache_meta(folder PK, projectPath, indexMtimeMs)
search_fts USING fts5(id, type, folder, title, body, tokenize='trigram')
search_map(id PK, type, folder)   -- backref for FTS delete
settings(key PK, value JSON)
```

## Continuation index (#518B)

`session_cache.continuationIndex` is nullable JSON with `format:3`, `ids`,
`bytes`, `complete`, `mtime` and `unresolved`. Schema reconciliation adds the
column without wiping old rows. Full transcript scans collect links while
already parsing the file, including worker scans. Missing or older-format
indexes are rebuilt lazily, including format-2 indexes that marked a mere
`continued-in` mention in an unrelated malformed or oversized record unresolved.

Header-only refresh skips subagent continuation indexes and shares a 1 MiB
synchronous continuation budget across all changed parent files in that refresh.
Other files retain their stale index until a later refresh or resume lookup.
Existing display-header and SDK-entrypoint reads keep their own budgets.

`resolveSessionContinuations` verifies format, size and mtime before trusting
an index. A complete fresh index requires only stat. A legacy, incomplete or
stale index is read in 1 MiB chunks, yielding with `setImmediate` between chunks,
with no total scan cap. Tests can inject smaller `chunkBytes`. Persistence uses
`setCachedContinuationIndex`, which updates only that column, preserving display
fields written by a concurrent refresh; it does not upsert an old row snapshot.

When a target has no cache row, resolution lazily inventories transcript filenames
recursively under the source session's projects root (or that host's mirror root).
This asynchronous directory inventory is shared within one resolution and reads
no transcript contents. A file found anywhere in that root remains unresolved
until indexed; resolution does not index it on demand. Directory read failures
or symbolic links that may hide files also keep absence unconfirmed.
For a local target without a cache row, the IPC also supplies the existing
CLI `liveElsewhereChecked` lookup. A live descriptor keeps the target as a terminal
candidate even before its first transcript record exists; `known:false`, including
an unreadable descriptor directory, keeps resolution unresolved. A confirmed
`known:true, live:null` result permits the disk inventory to check absence.
Remote mirror targets never query local CLI descriptors.
Only a target absent from the cache, liveness lookup and inventory is marked missing.
The graph drops that target if its parent has another existing continuation.
If every child is confirmed missing, that parent remains unresolved, including
inside a longer chain: silently resuming a discontinued branch is unsafe, and
manual opening already offers an explicit original-id choice. Cached rows with
missing or unreadable transcripts retain the existing unresolved behaviour.

Full-scan and chunk indexes both carry `version:3`, `size`, `sealedIds`, a bounded base64
`pending` line, and the last 64 indexed bytes as hexadecimal `tail`. The tail is
verified before reusing a cursor after growth; mismatch, shrink or a same-size
mtime change starts at byte zero. This is a local tail check, not a proof that
an arbitrary rewrite preserved the entire prefix. Full reads retain the same
cursor witness and tail state, so the first scan after an append reads only
the appended bytes and the bounded witness. Unterminated valid records remain
tentative until sealed by a newline; partial tails are reprocessed on append.

Lines are retained up to 1 MiB. Oversized records are ignored by both continuation
indexers; chunk scans carry `skipLine` until the newline, including across appends.
Actual CLI continuation records are small bookkeeping records. Malformed lines
only hold resolution when they match `"type"\s*:\s*"continued-in"`; an unrelated
mention of the word does not. Valid continuation records with invalid targets
also remain unresolved. Partial tails remain buffered for a
later append; tail errors are recomputed rather than carried forward forever.
No transcript content is sent through the IPC, only candidate ids and activity
times.

A disk-present target without a cache row returns `waitingForIndex` with the
unresolved graph. Automatic restore uses this to show a waiting notice instead
of a continuation-choice notice. `markRestoreIndexingDone` reloads projects and
retries held continuation entries, including after the ordinary restore planner
has settled. If completion arrived during an in-flight resolution before it could
be held, that restore pass notices completion and performs the same retry when
it returns. Passes starting after completion do not schedule another retry.
It invalidates their startup lookup promises before resolving again,
persists the resolved id and active state, and consumes each retry once. A failed
project reload leaves retries available for the next completion event. A manual
open cancels automatic retry through `continuationRetryCancelled`; a remembered
automatic open does not. The separate `sessionOpenedOutsideRestore` guard keeps
its original behaviour: any open outside working-set restore cancels the planner,
including the automatic remembered open on a renderer reload. Entries still
ambiguous after indexing retain the sidebar-choice notice. Entries still unindexed
after the retry name that state and offer a manual sidebar retry.
