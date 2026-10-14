# Session index study — reads, writes and display refreshes

Initial inspection: 2026-10-14 at `33e8e10f63be0c1b51062e457000683393469cac`; second review revision verified against `433ba39d68dcf891eca58eae69518d31d2cc2923`, branch `docs/616-index-architecture-adr`. Production source is the merged slices 1–2 baseline. PR #637 is closed, superseded by ADR 0004; its source at `5053d7f` and the supplied review are evidence about that proposal, not code present in this branch. No production code or user database was changed.

## Evidence and limits

- Fresh source inspection below is authoritative for today's paths. `.ai/contexts/session-cache.md` provides orientation, but its historical line counts and comments are not measurements.
- **Measured in the review of PR #637 at `5053d7f`**, with Electron-as-Node on **3 folders × 1,500 sessions**: cold main apply p99 **126 ms**; warm apply p99 **851 ms**, max **1,074 ms**; FTS upserts **5.4–6.1 s** total and individual search-entry deletions **5.5 s** total. These prior review measurements were supplied, not reproduced for this revision. They describe #637, not this checkout or the decided architecture.
- Earlier findings were rechecked against the merged baseline before reuse. In particular, `session_cache` does **not** store transcript bodies: the schema/upsert at `db.js:58`, `db.js:425`, `db.js:568` stores display/index metadata; full search bodies live separately in `search_content` (`db.js:374`). `SELECT *` still carries potentially large continuation indexes.
- The initial study's only experiment used 200 synthetic cache rows, ten repetitions per read, one worker, no FTS load and no running window. It is a native-loading/read-sizing probe, not a latency acceptance test. The second review revision ran no probe, suite, build, install or stress workload. It checked source references, document consistency and a bounded, read-only local transcript sample for record structure, reporting only aggregate counts and key names below.

### CLI title-record structure

On 2026-10-14, enumerate top-level `.jsonl` files in the local `~/.claude/projects/` directories, order by mtime and select at most 20. Read at most the final **512 KiB per file**, discarding a possibly partial first line and the final unsealed line; parse complete records without printing record values, paths, IDs, titles or messages. This bounded inspection read **17 files, 7,404,522 bytes and 3,393 complete records**, with **0 malformed lines**. It found **117 `custom-title` records**, all with string `customTitle`, **0 with a `timestamp` key**. Their key set was exactly `type`, `customTitle`, `sessionId`.

Within each sampled window, **105 title records repeated the preceding title value**; there were **0 changed-value pairs**. The first title in a window has no known predecessor and was not counted as a rename. This verifies the missing timestamp and repeated-value shapes, not the frequency or timing accuracy of actual renames. It is not a full-history survey. The supplied second-review measurement of 400 recent transcripts (8,763 title records, none timestamped; up to 2,795 records for two values in one file) was not reproduced here.

ADR 0004 therefore defines a rename as a change against the preceding title value in the same transcript, not another title record. Local changes use the nearest preceding timestamped record, else the nearest following one, else the tail reader's first observation past its watermark; persist that time/provenance so retries do not redate the event. Remote changes use local observation time because host clocks can drift. Migration records existing title history as a baseline; it never turns initial discovery or identical re-appends into new renames.

## Connections and ownership today

| Owner | Connection / work | Evidence |
| --- | --- | --- |
| Main | `db.js` opens the only writable connection at module load; resolves `SWITCHBOARD_DATA_DIR` or the default data directory; may relocate a legacy database only with no override. Sets WAL, `busy_timeout=5000`, `synchronous=NORMAL`; creates schema, migrates and repairs immediately. | `db.js:10`, `db.js:20`, `db.js:39`, `db.js:100`, `db.js:283`, `db.js:307`, `db.js:939`; imported at `main.js:156` |
| Projects worker | Own readonly, `fileMustExist` connection with 5 s busy timeout. One read transaction copies all cache rows, session metadata, folder metadata and settings. Filesystem reconciliation and project construction then run outside the read transaction with an in-memory adapter that records writes as effects. | `workers/projects-query.js:4`, `workers/projects-query.js:7`, `workers/projects-query.js:10`, `workers/projects-query.js:30`, `workers/projects-query.js:45`, `workers/projects-query.js:73` |
| Projects relay on main | Builds a JSON projection of active sessions, remote roots, background descriptors/jobs; appends `total_changes()` and `data_version` to form a global token; applies effects synchronously through the real DB functions. Thus a readonly worker is still a source of main writes. | `main.js:508`, `main.js:522`, `main.js:528`; `db.js:563`; `session-cache.js:107` |
| Search worker | Separate readonly connection, 5 s busy timeout; FTS SELECT runs independently of indexing. The client can still fall back to synchronous search on main. | `workers/search-query.js:47`, `workers/search-query.js:54`; `main.js:217`, `main.js:234`; `search-worker-client.js` |
| Startup / subset / title workers | Filesystem parsers, no SQLite connection. Their messages are persisted by main. | `session-cache.js:558`, `session-cache.js:1040`, `session-cache.js:1128`; `workers/scan-projects.js`, `workers/scan-session-titles.js` |
| Memory / Work Files workers | Filesystem workers; main reads indexed IDs and applies FTS changes. These share the **same** database as sessions. | `main.js:1439`, `main.js:1451`, `main.js:1484`, `main.js:1503` |
| Schedule discovery | Lazily imports the same `db.js` module on main to read folder metadata; does not create another writer. | `schedule-runner.js:140` |

Workers are resolved through `path.join(__dirname, 'workers', ...)` (`main.js:218`, `main.js:526`). **Native SQLite worker use already ships in packaged builds**: search since **v0.0.44**, Projects since **v0.0.93**. Packaging includes `workers/**/*` and `node_modules/**/*` (`package.json:79`, `package.json:82`) and `asarUnpack` covers `node_modules/better-sqlite3/**` (`package.json:85`); `scripts/postinstall.js:8` installs Electron-native dependencies, with the rebuild fallback at `scripts/postinstall.js:14`. Qualification for the new architecture is specifically **worker writes, migrations/VACUUM and awaited shutdown/restart**, not first proof that readonly native worker loading can be packaged. Existing real-worker tests use Electron Node mode (`test/projects-worker-equivalence.test.js:10`); they were inspected, not run.

## Main-process write inventory

The table covers direct calls and injected dependencies executed on main. A writer migration must include all of them; moving only startup indexing leaves competing writers.

| Reachable owner / trigger | Writes and frequency | Source |
| --- | --- | --- |
| Module startup | DDL, migration version/settings, historical cache invalidations, FTS recreation, old bookkeeping deletion, schema reconciliation and bridge repair. One-time per migration/repair; schema checking on open. Includes historical `VACUUM`, not only small statements. | `db.js:49`, `db.js:100`, `db.js:175`, `db.js:242`, `db.js:283`, `db.js:307`, `db.js:350`, `db.js:376`, `db.js:939` |
| Legacy search cleanup | Delete all FTS rows of type `plan`, once at startup. | `main.js:198` |
| Startup / manual full scan | `writeScannedFolder`: delete cache/metrics/search for a folder (retaining running rows), upsert every parsed session, set transcript custom names, replace daily metrics, rebuild FTS and folder metadata, clear repair settings. Once per delivered folder, on **every launch**, manual rebuild and incomplete-index recovery. No warm signature skip. | `session-cache.js:126`, `session-cache.js:890`, `session-cache.js:1132`, `session-cache.js:1171`; `main.js:1251`, `main.js:1279`, `main.js:3570` |
| Watcher / explicit refresh | Existing files compare ISO `fileMtime` and project path, then header read or mtime touch; new files full-read; changed rows, metrics, names, FTS, missing IDs and folder metadata are persisted. Full folder row SELECT even for a targeted file; ending freshness calculation walks/stats the whole folder. | `session-cache.js:194`, `session-cache.js:228`, `session-cache.js:311`, `session-cache.js:360`, `session-cache.js:445`, `session-cache.js:469`; `folder-index-state.js:4` |
| Deleted / invalid folder | Cache/metric/folder deletion, optional FTS deletion; live rows may be retained. Validation rejection can also call the folder deletion helper even though a folder still exists. Watcher vanished-folder call omits `search:true`. | `session-cache.js:126`, `session-cache.js:199`, `session-cache.js:216`; `main.js:3316` |
| Projects worker reconciliation | Every recorded writer effect is applied without yielding. Includes cache, metrics, name, FTS and folder metadata writes; project building can backfill folder metadata. Reconcile requested at most once per 5 s after accepted completion, driven by queries, not a periodic timer. | `session-cache.js:107`, `session-cache.js:475`, `session-cache.js:740`; `main.js:1282`; `workers/projects-query.js:45` |
| Entry point / custom title backfills | All missing entry points selected on main; synchronous transcript reads and DB updates in 200-row ticks. Title parser is a worker but its result batches are applied on main, guarded by old `fileMtime`. Triggered by `get-projects`, retained once-per-process promises except failed title retries. | `session-cache.js:506`, `session-cache.js:509`, `session-cache.js:541`, `session-cache.js:567`; `db.js:610`, `db.js:624`; `main.js:1280` |
| Remote mirrors / repair | Full folder replacement or subset upsert/delete, names, metrics, FTS and folder metadata. Main also reads existing folder rows to prepare subset worker input. Repair completion changes its settings key. Remote host removal deletes folder/search and repair metadata. | `session-cache.js:927`, `session-cache.js:974`, `session-cache.js:1015`, `session-cache.js:1048`; `main.js:555` |
| Live row release / continuation resolution | Exit releases retained row and synchronously refreshes its folder. On-demand continuation scan yields between chunks but eventually persists its index on main. | `session-cache.js:140`, `session-cache.js:1202`, `session-cache.js:1232`; `main.js:2473` |
| Project archive / unarchive / add / remove | Global hidden/archive settings, schedule registry/archive metadata; unarchive/add/remap call synchronous folder refresh; remove deletes folder/search and project setting. Archive helpers can reconcile/build on main before settings writes. Event-driven per action. | `main.js:790`, `main.js:806`, `main.js:828`, `main.js:870`, `main.js:906`, `main.js:976`; `archived-projects.js:101`, `archived-projects.js:254`, `archived-projects.js:296`, `archived-projects.js:307` |
| Delete worktree / session | Delete related cache/metric/search rows and folder/project/global settings; main scans cached rows for worktree / merged-member decisions. Event-driven per action. | `main.js:1045`, `main.js:1060`, `main.js:1068`, `main.js:2283`; `main.js:3279` |
| Session actions | Star update, name update plus FTS title patch, archived flag. One user operation; name precedence must survive indexing. | `main.js:2060`, `main.js:2066`, `main.js:2301`; `db.js:539`, `db.js:743` |
| Memory / Work Files lists | `applySearchFileBatch` transaction deletes and upserts shared FTS tables in 50-entry / 128 KiB batches with `setImmediate` between batches. Triggered by list requests/invalidation; not a separate database writer. | `main.js:1439`, `main.js:1451`, `main.js:1484`, `main.js:1495`; `db.js:732` |
| Settings / window / diagnostics / reporting | General set/delete IPC; window bounds after 500 ms resize/move debounce and immediately before close; reporting/debug toggles; global settings also contain working-set persistence. | `main.js:408`, `main.js:423`, `main.js:1615`, `main.js:1663`, `main.js:3017`, `main.js:3065`; `public/app.js:249` |
| Injected settings helpers | Schedule project registry bootstrap/add/remove; remap records; changelog last-seen state; archive reappearance and schedule offers. Archive reappearance can write during a supposedly read-only `get-projects` reply assembly. | `schedule-runner.js:218`, `schedule-runner.js:228`, `schedule-runner.js:235`; `project-remap.js:36`; `changelog.js:99`; `archived-projects.js:101`; `main.js:1283` |
| Shutdown | Renderer exit-flush captures working set, activity flush is bounded at 1,500 ms, final bounds save runs on close; WAL truncate checkpoint/close remains on main after unawaited worker termination. The future writer must admit and acknowledge these final writes before rejecting mutations and draining. | `public/app.js:255`; `main.js:3612`, `main.js:3615`, `main.js:424`, `main.js:3651`; `db.js:930`; `projects-worker-client.js:22` |

DB write implementations: session metadata `db.js:539`; cache transaction `db.js:568`; metric replacement `db.js:586`; entrypoint/title/continuation writes `db.js:610`, `db.js:624`, `db.js:962`; session/folder deletions `db.js:641`, `db.js:646`; folder metadata `db.js:665`; settings and completeness prepared statements/exports `db.js:511`, `db.js:970`. These are synchronous APIs, including apparently tiny writes subject to lock waiting.

### Read-then-write command inventory for slices 1a/1b

An async wrapper around each existing SQL call would split these decisions across connections and allow stale reads. Slice **1a** must characterize each sequence and its ordering as one facade command; slice **1b** moves each command's durable reads and writes into one writer transaction against current state. Readonly display workers never supply stale whole-row or whole-`global` replacements to these commands.

| Existing main-side sequence | Single writer command boundary in 1b |
| --- | --- |
| Rename writes the name, reads the cached summary and patches the FTS title (`main.js:2066–2072`, read at `2068`). | One rename command reads the current summary/name and updates metadata plus FTS atomically; slice 2 adds candidate resolution inside that command. |
| Worktree deletion selects all cached rows, deletes matching sessions/search, then reads/edits `global.hiddenProjects`/`hiddenProjectKinds`, clears archive state and deletes folder metadata (`main.js:1045–1068`). | One durable worktree-cleanup command selects the current affected rows and applies related metadata/search/settings cleanup after filesystem removal; no main-side row enumeration or stale `global` overwrite. |
| Archive/unarchive/add/remove handlers read and replace `global.hiddenProjects` (`main.js:793–819`, `835–841`, `874–881`); injected archive helpers also consult `global` visibility (`archived-projects.js:112`) and read/replace archive/offer settings (`archived-projects.js:90–102`, `135–139`, `227–257`, `285–307`). | One command per archive/unarchive/clear/offer operation reads current visibility/archive/offer state and patches only its affected entries/fields. Archive reappearance uses the same writer-owned command path rather than a query-side write. |

Filesystem deletion and schedule enable/disable stay outside SQLite transactions; feed their results back through explicit completion commands, preserving ownership checks and the writer transaction ceiling. The settings mirror serves reads, not whole-setting read/modify/write proposals.

### FTS paths and atomicity

`upsertSearchEntries` (`db.js:671`) deletes an existing map/FTS/content row and inserts the replacement, truncating the body to **32,768 UTF-16 code units** (`db.js:366`, `db.js:690`). Session/folder/type deletion is `db.js:698`, `db.js:710`, `db.js:717`; file-list batch deletion/upsert `db.js:732`; rename patch `db.js:743`. For sessions the parser has an earlier **roughly 8 KB text cap** (`read-session-file.js:309`), appending up to 500 UTF-16 units plus a newline per record (`read-session-file.js:310`); the last append may overshoot 8,000 by up to 500 units. The DB limit is the shared upper ceiling, not the effective session body size. Preserve the external-content deletion order while old content still exists. Existing scan cache, metrics and FTS calls are separate transactions/statements, not one atomic folder snapshot.

Callers: refresh new/bridge-derived rows (`session-cache.js:429`, `session-cache.js:453`), full scans (`session-cache.js:897`, `session-cache.js:907`), subset scans (`session-cache.js:937`), worker reconciliation effects (`session-cache.js:107`), all explicit deletion paths in the table, file-list indexing (`main.js:1484`), rename (`main.js:2071`), startup cleanup/migrations/repair. Existing-file header refresh intentionally does **not** update the FTS body or daily metrics (`session-cache.js:284`); eliminating unconditional startup rereads therefore needs the decided saved-offset tail freshness policy, not repeated full reads or just another mtime comparison.

## Read and refresh graph

`preload.js:16` exposes `getProjects`; the sole production renderer invoke is `public/app.js:1376`, requesting both default and archived views. `loadProjects` replaces both arrays, deduplicates, fetches global settings and active terminals, polls active sessions and renders (`public/app.js:1369`, `public/app.js:1420`, `public/app.js:1438`). Every entry below reaching `loadProjects` repeats that complete flow. `reloadProjects` adds error retention, not incremental reads (`public/app.js:1444`).

| Full Projects reload trigger | Frequency / bound | Call sites |
| --- | --- | --- |
| Startup | Up to two initial load attempts, then working-set restore; indexing is fire-and-forget on main. | `public/app.js:1974`; `main.js:1279` |
| Index completion with restore work outstanding | Up to two reload attempts; not every completion unconditionally. | `public/app.js:515`, `public/app.js:522`, `public/app.js:2068` |
| Session ID discovery / fork / clear | One reload per corresponding event for an open entry. | `public/app.js:595`, `public/app.js:614`, `public/app.js:624`, `public/app.js:658` |
| Filesystem/index/background changes | Main trailing watcher debounce 500 ms; then Projects signal leading + trailing throttle 1,500 ms; renderer debounce 900 ms. Under sustained accepted signals, nominal reload cadence is about 1.5 s plus worker/IPC time, not one read per file. Trailing watcher debounce can postpone a flush under uninterrupted events. | `main.js:3298`, `main.js:3364`; `session-cache.js:826`, `session-cache.js:833`; `public/app.js:2001` |
| Return to Sessions tab | One catch-up reload when the away flag was set, regardless of number of skipped events. | `public/app.js:1774` |
| Re-sort | One full reload per click. | `public/app.js:867` |
| Add project dialog | Once after successful add. | `public/dialogs.js:746` |
| Settings | Successful unarchive; SDK visibility change; successful project archive/delete. Other settings only rerender. | `public/settings-panel.js:476`, `public/settings-panel.js:691`, `public/settings-panel.js:774` |
| Project archive UI | Missing cached parent, refused stop/archive, completion. Event-driven, can duplicate the later main signal. | `public/sidebar.js:1187`, `public/sidebar.js:1274`, `public/sidebar.js:1296` |
| Project controls | Schedule reenable/dismiss, remote refresh, remap, settings archive, worktree deletion. One per successful action (remote refresh reloads after its attempt). | `public/sidebar.js:1328`, `public/sidebar.js:1333`, `public/sidebar.js:1354`, `public/sidebar.js:1369`, `public/sidebar.js:1406`, `public/sidebar.js:1421` |
| Session/group controls | Group archive, session delete, session archive. One per completion. | `public/sidebar.js:1466`, `public/sidebar.js:1658`, `public/sidebar.js:1687` |

All main Projects signal sources: folder refresh flush (`main.js:3322`); every startup scan folder and completion (`session-cache.js:1149`, `session-cache.js:1176`); repair (`session-cache.js:983`); SDK/title backfills or reveal (`session-cache.js:532`, `session-cache.js:568`, `session-cache.js:584`); remote index callback (`main.js:564`), remote stop (`main.js:1824`); project actions (`main.js:799`, `main.js:820`, `main.js:861`, `main.js:890`, `main.js:980`, `main.js:1073`, archive dependency `main.js:914`); release of live rows (`main.js:2473`), background attach (`main.js:2931`), session transitions (`main.js:3194`), background job roster changes (`main.js:3271`). Archive offer helpers call the injected notifier (`archived-projects.js:297`, `archived-projects.js:308`). These are event-driven; remote index periodically refreshes hosts (`remote-index.js:378`) at a default **300 s**, configurable with a **60 s** minimum (`remote-hosts.js:8`, `remote-hosts.js:54`), plus watch/manual events and failure backoff, not a fixed sidebar poll. Working-set settings writes have their own **500 ms** debounce (`public/app.js:249`).

### Display projection and remaining main reads

Durable rows alone do not determine the display. `buildProjectsFromCache` applies SDK hiding using active sessions and `global.openWorkingSet` (`session-cache.js:588`), bridge rollups/parent archive policy, filesystem-derived empty/missing project facts, active plain-terminal rows (`session-cache.js:766`), and local background descriptor/attached-job merge (`session-cache.js:793`, `session-cache.js:803`). Main additionally merges placeholders/archive state and annotates remote descriptors/`remoteAttachable` (`main.js:1283`, `main.js:631`, `main.js:660`). Its archive dependencies also call the builder (`main.js:912`). Reload signals on attach, descriptor statuses, job roster and SDK reveal (`main.js:2931`, `main.js:3194`, `main.js:3271`, `session-cache.js:582`) can change this projection without a DB write.

ADR 0004 therefore assigns the pure durable-plus-live projection to the **readonly display worker**. Slice **3a** compares an initial snapshot and each **in-process durable/live change set** against the current `buildProjectsFromCache` output and its placeholder/archive/remote assembly, including the archive-planner consumer; no transport, epoch or sequence is required for that parity proof. Slices **2 and 3a** retain today's reload publication, including metadata re-key results. Slice **3b** adds ordered live revisions and durable delta transport, using a writer/display `MessageChannel` to avoid carrying each durable payload through main twice. Slice **4** makes the renderer patch projected records and own optimistic overlays. In that final path, live changes reproject affected IDs instead of forcing a DB reload. Bound live replay to 1,024 patches or 8 MiB and replace an overflowing consumer's replay with a full current live-input snapshot plus its subsequent patches, as specified in the ADR.

Every accepted watcher flush invokes `detectSessionTransitions` synchronously on main before refresh (`main.js:3309`). It enumerates transcripts (`session-transitions.js:501`), reads bounded headers with `openSync/readSync` (`session-transitions.js:395`), scans continuation tails (`session-transitions.js:471`) and inspects subagents. Moving SQLite writes alone does not remove this source of input stalls. Slice **2** moves these reads/parsing to bounded parser jobs; main keeps ownership checks and final PTY re-key, rejecting stale session-generation results before any metadata migration.

### Sidebar work that does not invoke get-projects

The central `refreshSidebar` renders current arrays (`public/app.js:810`); it is still a whole-tree render, not a row patch. Direct production call sites, grouped by trigger:

| Trigger | Frequency / references |
| --- | --- |
| Plain terminal exit | Per exit, `public/app.js:721` |
| Archive/star/running/today filters | Per click, `public/app.js:839`, `public/app.js:847`, `public/app.js:855`, `public/app.js:862` |
| Search clear / below threshold | Coalesced to next animation frame, `public/app.js:929`, `public/app.js:951` |
| Search success / error | Per query result; typing debounce 350 ms (`public/app.js:1014`), `public/app.js:995`, `public/app.js:1009` |
| Stop / send to background | Per action, `public/app.js:1095`, `public/app.js:1150` |
| New local / remote session | Immediate optimistic row, `public/app.js:1494`, `public/app.js:1554` |
| New schedule / plain terminal dialog | Immediate optimistic row, `public/dialogs.js:64`, `public/dialogs.js:210` |
| Settings without SDK visibility change | Per save, `public/settings-panel.js:693` |
| Star | Per click, `public/sidebar.js:1548` |
| Background roster changes | Only changed live session ID set, `public/agents-view.js:195` |
| Completion of full load | Every full load, `public/app.js:1439` |

Additional in-place updates do not call the central renderer: active-state poll every **3 s** with running sessions / **30 s** idle (`public/app.js:1190`, `public/app.js:1200`), time labels every **30 s** (`public/app.js:1329`), busy title events (`public/app.js:802`), subagent spawn/completion (`public/sidebar.js:338`, `public/sidebar.js:356`), task snapshots/rekeys (`public/task-registry.js:376`), transcript activity (`public/local-transcript-adapter.js:173`) and remote activity (`public/remote-activity-ui.js:222`). These channels should remain separate from durable-index deltas.

## Incrementality and conflict facts

- Persisted file signature today is `session_cache.fileMtime` (ISO string), **not size**. Display `modified` deliberately differs; do not use it as a signature (`session-cache.js:298`, `session-cache.js:305`). `cache_meta.indexMtimeMs` is a maximum of directory and transcript mtimes, requiring full enumeration/stat (`folder-index-state.js:4`). A maximum alone misses deletions, same/older-time replacement and some nested changes; successful complete directory manifests are required for deletion detection.
- Refresh already skips equal mtimes/project paths and has file-path-to-logical-ID mapping, legacy/subagent enumeration, bridge resolution and live retention (`session-cache.js:228`, `session-cache.js:311`, `session-cache.js:380`, `session-cache.js:407`). Preserve those semantics, including trustworthy cwd/remap checks; do not assume filename equals logical ID or that one logical row has only one source.
- Global version includes unrelated settings/window writes and all live descriptors (`main.js:522`, `db.js:565`). Existing Projects relay retries three times and can publish a stale view without effects; caller deadline is **30 s**, reconcile hard ceiling **5 minutes** (`projects-worker-client.js:4`, `projects-worker-client.js:6`, `projects-worker-client.js:51`, `projects-worker-client.js:98`).
- Existing `custom-title` handling retains the latest `customTitle` (`read-session-file.js:272`); the sampled records have **no timestamp**. `session_meta.name` has no ownership/time classification (`db.js:539`). The decision adds changed-value candidates, timing provenance and generation/byte/change-offset watermarks, preserving old names until validated; repeated values advance parsing progress without advancing rename time. First discovery establishes a baseline, including unknown legacy times, rather than a rename. Proven continuation re-key currently moves live identity (`session-transitions.js:443`, `session-transitions.js:489`); #639 adds one idempotent writer transaction to transfer durable name candidates/star/archive. Slice 2 publishes through current reloads; 3b supplies the atomic old-removal/new-upsert envelope. Unread/response-ready has no DB field: it stays in renderer memory and follows `rekeyActivityState` (`public/session-activity.js:147`, `public/session-activity.js:173`), never `migrateUserMetadata`. The durable transfer does not apply to fork or `/clear`.
- The proposed UUID ledger is scoped to **bridge groups with more than one member**, not ordinary sessions. Single-source tails need offsets and aggregate buckets only; membership promotion builds per-source UUID facts before publishing union metrics, and demotion retires the ledger. At a provisional 128–256 bytes per retained source/UUID fact, 100,000 facts imply about 12–24 MiB of logical payload before SQLite page/index/WAL overhead. These are sizing assumptions to measure, not measured database size.
- Future cache columns must not reuse the existing `mustReindex` clear at `db.js:307`, `db.js:349`; readable defaults plus **needs validation** preserve existing rows during background repair.
- PR #637 adds a separate indexing queue with a 30 s caller deadline, whole-scan failure after three global conflicts, per-row folder clearing and 50-effect/128 KiB envelopes; `git show 5053d7f:workers/index-sessions.js` was inspected. Its proposed transition retries, FTS append repair and queue changes cannot be treated as already merged. The supplied review's B1/M3 reports changed IPC semantics and 17 CI / 18 local failures; these are inherited reports, not runs executed here.

## Small isolated probe from the initial study

The initial run exited **0** under Electron **41.0.3**, embedded Node **v24.14.0**, ABI **145**. The embedded runtime is distinct from the package's host Node engine range. It created and removed its own 200-row fixture database, closed handles before cleanup and did not import the default user database. Electron Node mode started no application window. These are inherited study results; **the review revision did not rerun this probe**. The complete script is included below so the evidence does not depend on ignored scratch artifacts.

| Operation | Result |
| --- | --- |
| Worker loads native binding, opens WAL and commits two metadata writes | Readback verified; transaction **5.064 ms** |
| `SELECT * FROM session_cache`, 200 rows, ten repetitions | Mean **0.370 ms**, max **1.045 ms**, JSON **113,273 bytes** |
| Six-column display projection, same 200 rows | Mean **0.149 ms**, max **0.188 ms**, JSON **33,583 bytes** |

Timings measure synchronous SQL/materialization only; bytes use JSON as a sizing proxy, not Electron wire bytes. They exclude renderer DOM work, structured-clone time, real continuation histories, FTS, concurrent locks, packaged ASAR resolution and the normal Electron main lifecycle. The projection omits fields a real display requires; it establishes why explicit fields matter, not a final schema or a safe main-thread history limit. No measured p99 claim can be made from ten reads or from this probe about #616 acceptance.

### Inline reproduction script

Save this as `probe-session-index.cjs` at the checkout root, beside `db.js`, for reproduction. The only changes from the original probe are its scratch names, the relative import for this location and printing the result to stdout instead of a scratch JSON file. Run it with:

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& .\node_modules\electron\dist\electron.exe .\probe-session-index.cjs
```

```javascript
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
if (!isMainThread) {
  const Database = require('better-sqlite3');
  const db = new Database(workerData.dbPath);
  db.pragma('busy_timeout = 100');
  const start = performance.now();
  db.transaction(() => {
    db.prepare('UPDATE session_cache SET summary = ? WHERE sessionId = ?').run('worker write verified', 'fixture-0');
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('probe', 'true');
  }).immediate();
  const writeMs = performance.now() - start;
  const sample = sql => {
    const stmt = db.prepare(sql);
    let rows, maxMs = 0, totalMs = 0;
    for (let n = 0; n < 10; n++) {
      const t = performance.now(); rows = stmt.all();
      const elapsed = performance.now() - t; totalMs += elapsed; maxMs = Math.max(maxMs, elapsed);
    }
    return { rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)), meanMs: totalMs / 10, maxMs };
  };
  const result = { node: process.version, electron: process.versions.electron, abi: process.versions.modules,
    journalMode: db.pragma('journal_mode', { simple: true }), writeMs,
    allColumns: sample('SELECT * FROM session_cache'),
    displayProjection: sample('SELECT sessionId, folder, projectPath, summary, modified, parentSessionId FROM session_cache'),
    nativeWorkerWriteVerified: db.prepare('SELECT summary FROM session_cache WHERE sessionId = ?').get('fixture-0').summary === 'worker write verified' };
  db.close(); parentPort.postMessage(result);
} else {
  const dir = fs.mkdtempSync(path.join(__dirname, 'probe-session-index-'));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  const cacheDb = require('./db');
  const rows = Array.from({ length: 200 }, (_, i) => ({ sessionId: 'fixture-' + i, folder: 'fixture',
    projectPath: 'C:/fixture', summary: 'Synthetic session ' + i, firstPrompt: 'Synthetic fixture',
    created: '2026-10-14T00:00:00.000Z', modified: '2026-10-14T00:00:00.000Z',
    fileMtime: '2026-10-14T00:00:00.000Z', messageCount: 2,
    continuationIndex: JSON.stringify({ offset: 1024, sourceId: 'fixture-' + i, entries: [] }) }));
  cacheDb.upsertCachedSessions(rows);
  const dbPath = cacheDb.DB_PATH; cacheDb.closeDb();
  const worker = new Worker(__filename, { workerData: { dbPath } });
  const timer = setTimeout(() => { worker.terminate(); process.exitCode = 1; }, 15000);
  worker.once('message', result => console.log(JSON.stringify(result, null, 2)));
  worker.once('error', error => { console.error(error); process.exitCode = 1; });
  worker.once('exit', code => {
    clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (code) process.exitCode = 1;
  });
}
```

## Conclusions for the ADR

Use one writer connection off main for **all** durable tables, independently scheduled readonly display/search work, persisted per-source signatures/saved-offset tail progress, UUID-deduped multi-member bridge metrics, successful-manifest deletion detection, latest-wins names based on value changes with recorded timing provenance, and committed deltas projected with live inputs in the readonly display worker. Do not equate SQLite connection separation with notifications or bounded main latency. Keep full snapshots for startup/recovery, avoid rereading the whole history for ordinary changes, and measure delivery/render work as well as SQL in subsequent slices.
