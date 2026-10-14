# Study 6164 — session index reads, writes and display refreshes

Inspected 2026-10-14 at `33e8e10f63be0c1b51062e457000683393469cac`, branch `docs/616-index-architecture-adr`. This is the merged slices 1–2 baseline. PR #637 is a separate, rejected proposal; its source at `5053d7f` and the supplied review are evidence about that proposal, not code present in this branch. No production code or user database was changed.

## Evidence and limits

- Fresh source inspection below is authoritative for today's paths. `.ai/contexts/session-cache.md` provides orientation, but its historical line counts and comments are not measurements.
- `.work-files/brief-637b.md`, B2, reports Electron-as-Node measurements on **3 folders × 1,500 sessions**: cold main apply p99 **126 ms**; warm apply p99 **851 ms**, max **1,074 ms**; FTS upserts **5.4–6.1 s** total and individual search-entry deletions **5.5 s** total. These numbers were supplied, not reproduced here. They describe #637, not this checkout or the proposed architecture.
- `.work-files/study-6163.md` describes an earlier base (`ff2d341`) and a main-applied-effects design. Its findings were rechecked against this checkout before reuse. In particular, `session_cache` does **not** store transcript bodies: the schema/upsert at `db.js:58`, `db.js:425`, `db.js:568` stores display/index metadata; full search bodies live separately in `search_content` (`db.js:374`). `SELECT *` still carries potentially large continuation indexes.
- The only new experiment used 200 synthetic cache rows, ten repetitions per read, one worker, no FTS load and no running window. It is a native-loading/read-sizing probe, not a latency acceptance test. No full suite, build, install, real transcript scan or stress run was performed.

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

Workers are resolved through `path.join(__dirname, 'workers', ...)` (`main.js:218`, `main.js:526`). `package.json` includes `workers/**/*` and `node_modules/**/*` and unpacks `node_modules/better-sqlite3/**`; `scripts/postinstall.js:7` installs Electron-native dependencies, with a rebuild fallback. This supports the design in packaging configuration, but is **not** proof of an installed ASAR build. Existing real-worker tests use Electron Node mode (`test/projects-worker-equivalence.test.js:10`); they were inspected, not run.

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
| Shutdown | WAL truncate checkpoint and close on main, after requesting worker termination without awaiting its completion. | `main.js:3651`; `db.js:930`; `projects-worker-client.js:22` |

DB write implementations: session metadata `db.js:539`; cache transaction `db.js:568`; metric replacement `db.js:586`; entrypoint/title/continuation writes `db.js:610`, `db.js:624`, `db.js:962`; session/folder deletions `db.js:641`, `db.js:646`; folder metadata `db.js:665`; settings and completeness prepared statements/exports `db.js:511`, `db.js:970`. These are synchronous APIs, including apparently tiny writes subject to lock waiting.

### FTS paths and atomicity

`upsertSearchEntries` (`db.js:671`) deletes an existing map/FTS/content row and inserts the replacement, truncating the body to **32,768 UTF-16 code units** (`db.js:366`, `db.js:690`). Session/folder/type deletion is `db.js:698`, `db.js:710`, `db.js:717`; file-list batch deletion/upsert `db.js:732`; rename patch `db.js:743`. Preserve the external-content deletion order while old content still exists. Existing scan cache, metrics and FTS calls are separate transactions/statements, not one atomic folder snapshot.

Callers: refresh new/bridge-derived rows (`session-cache.js:429`, `session-cache.js:453`), full scans (`session-cache.js:897`, `session-cache.js:907`), subset scans (`session-cache.js:937`), worker reconciliation effects (`session-cache.js:107`), all explicit deletion paths in the table, file-list indexing (`main.js:1484`), rename (`main.js:2071`), startup cleanup/migrations/repair. Existing-file header refresh intentionally does **not** update the FTS body or daily metrics (`session-cache.js:284`); eliminating unconditional startup rereads therefore needs an explicit full-content freshness policy, not just another mtime comparison.

## Read and refresh graph

`preload.js:16` exposes `getProjects`; the sole production renderer invoke is `public/app.js:1376`, requesting both default and archived views. `loadProjects` replaces both arrays, deduplicates, fetches global settings and active terminals, polls active sessions and renders (`public/app.js:1369`, `public/app.js:1420`, `public/app.js:1438`). Every entry below reaching `loadProjects` repeats that complete flow. `reloadProjects` adds error retention, not incremental reads (`public/app.js:1444`).

| Full Projects reload trigger | Frequency / bound | Call sites |
| --- | --- | --- |
| Startup | Up to two initial load attempts, then working-set restore; indexing is fire-and-forget on main. | `public/app.js:1974`; `main.js:1279` |
| Index completion with restore work outstanding | Up to two reload attempts; not every completion unconditionally. | `public/app.js:515`, `public/app.js:522`, `public/app.js:2068` |
| Session ID discovery / fork / clear | One reload per corresponding event for an open entry. | `public/app.js:595`, `public/app.js:614`, `public/app.js:624`, `public/app.js:658` |
| Filesystem/index/background changes | Main trailing watcher debounce 500 ms; then Projects signal leading + trailing throttle 1,500 ms; renderer debounce 900 ms. Under sustained accepted signals, nominal reload cadence is about 1.5 s plus worker/IPC time, not one read per file. Trailing watcher debounce can postpone a flush under uninterrupted events. | `main.js:3298`, `main.js:3364`; `session-cache.js:826`, `session-cache.js:833`; `public/app.js:1988` |
| Return to Sessions tab | One catch-up reload when the away flag was set, regardless of number of skipped events. | `public/app.js:1774` |
| Re-sort | One full reload per click. | `public/app.js:867` |
| Add project dialog | Once after successful add. | `public/dialogs.js:746` |
| Settings | Successful unarchive; SDK visibility change; successful project archive/delete. Other settings only rerender. | `public/settings-panel.js:476`, `public/settings-panel.js:691`, `public/settings-panel.js:774` |
| Project archive UI | Missing cached parent, refused stop/archive, completion. Event-driven, can duplicate the later main signal. | `public/sidebar.js:1187`, `public/sidebar.js:1274`, `public/sidebar.js:1296` |
| Project controls | Schedule reenable/dismiss, remote refresh, remap, settings archive, worktree deletion. One per successful action (remote refresh reloads after its attempt). | `public/sidebar.js:1328`, `public/sidebar.js:1333`, `public/sidebar.js:1354`, `public/sidebar.js:1369`, `public/sidebar.js:1406`, `public/sidebar.js:1421` |
| Session/group controls | Group archive, session delete, session archive. One per completion. | `public/sidebar.js:1466`, `public/sidebar.js:1658`, `public/sidebar.js:1687` |

All main Projects signal sources: folder refresh flush (`main.js:3322`); every startup scan folder and completion (`session-cache.js:1149`, `session-cache.js:1176`); repair (`session-cache.js:983`); SDK/title backfills or reveal (`session-cache.js:532`, `session-cache.js:568`, `session-cache.js:584`); remote index callback (`main.js:564`), remote stop (`main.js:1824`); project actions (`main.js:799`, `main.js:820`, `main.js:861`, `main.js:890`, `main.js:980`, `main.js:1073`, archive dependency `main.js:914`); release of live rows (`main.js:2473`), background attach (`main.js:2931`), session transitions (`main.js:3194`), background job roster changes (`main.js:3271`). Archive offer helpers call the injected notifier (`archived-projects.js:297`, `archived-projects.js:308`). These are event-driven; remote index periodically refreshes hosts (`remote-index.js:378`) at a default **300 s**, configurable with a **60 s** minimum (`remote-hosts.js:8`, `remote-hosts.js:54`), plus watch/manual events and failure backoff, not a fixed sidebar poll. Working-set settings writes have their own **500 ms** debounce (`public/app.js:249`).

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
- PR #637 adds a separate indexing queue with a 30 s caller deadline, whole-scan failure after three global conflicts, per-row folder clearing and 50-effect/128 KiB envelopes; `git show 5053d7f:workers/index-sessions.js` was inspected. Its proposed transition retries, FTS append repair and queue changes cannot be treated as already merged. The supplied review's B1/M3 reports changed IPC semantics and 17 CI / 18 local failures; these are inherited reports, not runs executed here.

## Small fresh probe

Command: `$env:ELECTRON_RUN_AS_NODE='1'; & .\node_modules\electron\dist\electron.exe .work-files/probe-6164.cjs` — **exit 0**. Output saved in `.work-files/probe-6164-result.json`; source in `.work-files/probe-6164.cjs`. The probe creates and removes its own fixture DB under this worktree, closes handles before cleanup and never imports the default user DB. Electron Node mode starts no application window. Runtime was Electron **41.0.3**, embedded Node **v24.14.0**, ABI **145**; the embedded runtime is distinct from the package's host Node engine range.

| Operation | Result |
| --- | --- |
| Worker loads native binding, opens WAL and commits two metadata writes | Readback verified; transaction **5.064 ms** |
| `SELECT * FROM session_cache`, 200 rows, ten repetitions | Mean **0.370 ms**, max **1.045 ms**, JSON **113,273 bytes** |
| Six-column display projection, same 200 rows | Mean **0.149 ms**, max **0.188 ms**, JSON **33,583 bytes** |

Timings measure synchronous SQL/materialization only; bytes use JSON as a sizing proxy, not Electron wire bytes. They exclude renderer DOM work, structured-clone time, real continuation histories, FTS, concurrent locks, packaged ASAR resolution and the normal Electron main lifecycle. The projection omits fields a real display requires; it establishes why explicit fields matter, not a final schema or a safe main-thread history limit. No measured p99 claim can be made from ten reads or from this probe about #616 acceptance.

## Conclusions for the ADR

Use one writer connection off main for **all** durable tables, independently scheduled readonly display/search work, persisted per-source signatures and content-completeness state, successful-manifest deletion detection, and committed versioned display deltas. Do not equate SQLite connection separation with notifications or bounded main latency. Keep full snapshots for startup/recovery, avoid rereading the whole history for ordinary changes, and measure delivery/render work as well as SQL in subsequent slices.
