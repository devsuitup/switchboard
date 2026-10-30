# Context: ipc-bridge

**Purpose**: The trust boundary between the Electron main process (Node, full filesystem) and the renderer (Chromium, sandboxed). The renderer can only call what `preload.js` exposes via `contextBridge`; everything else is denied.

This file is the **canonical inventory** of the IPC surface. When you add a new IPC, you change three places — main handler, preload bridge, renderer caller — and every IPC name should appear here.

## Main-process error backstop (#896)

`src/main/app/main-error-handlers.js` installs `uncaughtException` and `unhandledRejection`
listeners in `main.js` before `app.whenReady()`. Both write `[main:<origin>]`
and the full stack to `electron-log`; non-Error rejection reasons use a safe
text representation. A throwing logger is contained, independently of notices.

Policy: keep running after logging, with no automatic quit. The exception
listener suppresses Electron's default exception dialog; a B8 error notice
replaces it. This is a reporting backstop, not recovery of the operation that
threw. Individual throw sites and worker-thread error handling are unchanged.

| Event | Payload | Bridge / consumer |
|---|---|---|
| `main-process-error` | `{id, kind: 'error', message, count}` | `api.onMainProcessError(callback)` in preload; `public/app-notices.js` groups errors into one persistent, dismissible B8 notice with an **Open log** action. |
| `open-main-log` | No arguments | `api.openMainLog()` returns `{ok, error?}`. Main chooses `log.transports.file.getFile().path`, requires an absolute, non-sensitive path (including the existing on-disk path guard), and opens it via `shell.openPath`. Renderer arguments cannot choose another file. OS opener errors are shown in one replaceable error notice; opening the log leaves the error group visible. |

Before the renderer finishes loading, or if its window/webContents is gone or
sending throws, notices are queued by normalized-message id (up to 100 distinct messages;
overflow drops the oldest queued notice, never its log). `did-finish-load`
flushes the queue, including on window recreation/reload. Failed sends stay
queued for the next flush or recurrence. Only a new main-frame document
navigation resets readiness; subframe loads and same-document navigations do
not. `render-process-gone` resets readiness until the next `did-finish-load`.

Whitespace-normalized messages, including across the two origins, have a stable
SHA-256 id derived before display truncation. Every event is logged and updates
the occurrence count immediately; there is no 60-second suppression. The
100 most recently encountered distinct ids retain counts (evicted counts start
again if encountered later). Repeated queued errors retain their latest count.
Display summaries are limited to 500 characters plus the origin label;
non-Error inspection disables custom inspectors/getters and limits depth,
array lengths and individual strings. Error stacks in the log are unchanged.

The renderer uses B8 `members` to retain at most five distinct summaries inside
one `main-process-errors` notice, replacing repeated ids and showing counts.
Flush uses the same grouping, so 100 queued errors cannot create 100 alerts.
Earlier details remain in the log, subject to electron-log's rotation policy.
There are no backstop timers. Listeners can be disposed independently in plain
Node tests.

Known gap (#896): an error before any window has ever loaded stays queued only;
there is no native startup notification or forced window creation. Diagnostics
lists activity traces, not the main log; **Open log** on the error notice is the
main-log entry point.

## Key files

| File | LOC | Role |
|---|---|---|
| `preload.js` | ~270 | The `contextBridge.exposeInMainWorld('api', {...})` block. Every renderer-facing function. |
| `main.js` | ~4100 | The `ipcMain.handle('<name>', ...)` and `ipcMain.on('<name>', ...)` handlers, scattered throughout. |
| `schedule-ipc.js` | ~220 | **Also registers IPC handlers** (`get-schedule-creator-command`, `create-schedule-session`, `run-schedule-now`) — `init()` is called from `main.js`, but a `main.js`-only search for `ipcMain.handle` misses these three. Audit both files. |
| `bg-agents-ipc.js` | ~130 | **Also registers IPC handlers** (`get-bg-agents`, `check-bg-agent-verb`, `bg-agent-verb`, `dispatch-bg-agent`, `bg-agent-live-job`, `restore-background-job`) and sends `bg-agents-changed` — `init()` is called from `main.js`, so a `main.js`-only search for `ipcMain.handle` misses these six. Audit both files. |
| `unsaved-guard.js` | ~440 | **Also registers IPC handlers** for the exit flow (`exit-attempt-snapshot`, `exit-background`, `exit-background-cancel`, `unsaved-check-phase`, `unsaved-pong`, `unsaved-dialog`, `unsaved-ready`, `unsaved-check-ack`, `unsaved-check-result`, `unsaved-check-reason-done`) through the `ipcMain` it is handed by `createUnsavedGuard`. See window-frame.md. |

## Public surface (IPC inventory)

### Sessions (request/response)

The exit flow exposes `exit-background(checkId, detail, ids)` as
`exitBackground`, `exit-background-cancel(checkId, detail)` as
`exitBackgroundCancel`, and `exit-background-progress(attempt, event)` as
`onExitBackgroundProgress`. Main validates sender, check, attempt/version and
session eligibility. Cancel retains sender, check and current uncommitted user
attempt ownership checks but accepts earlier versions after an upgrade. The
batch never grants consent or stops processes.
`onExitAttemptInvalidated(attempt, outcome)` forwards optional `{ reask: true }`
or `{ external: true }` so the renderer can preserve marks during renewed
consent and avoid recovery during a system exit. See window-frame.md.

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `get-projects` | `(showArchived)` | `Project[]` | Sidebar payload. Reads from cache. |
| `get-active-sessions` | — | `{sessionId, busy}[]` | Currently open PTY sessions plus each one's live `_cliBusy` flag — see "Busy-state reconciliation" below. |
| `get-active-terminals` | — | `Terminal[]` | Active PTY identifiers |
| `open-terminal` | `(id, projectPath, isNew, sessionOptions)` | `{ok, error?, mcpState, mcpError?}` | Spawn or attach a PTY. |
| `send-session-to-background` | `(id)` | `{ok, oldSessionId?, sessionId?, jobId?, cwd?, respawned?, attached?, code?, error?}` | One local handoff, fresh continuation plus live bg descriptor proof; holds the original PTY exit. A session whose conversation is already held by its own stopped background job is not sent through `/bg`: it gets `/exit`, then that job is respawned (`respawned: true`; `bg-handoff.js`'s `respawnRoute`, #785). `bg-handoff-notice(id, message)` pushes the terminal confirmation notice. See bg-agents.md. |
| `session-live-elsewhere` | `(id)` | `{pid, cwd, startedAt} \| null` | Whether another process (another Switchboard, a CLI in a terminal) is running session `id`: a live pid in `~/.claude/sessions/` and no PTY for it in this instance. Called by `openSession` before a resume; see `.ai/contexts/cli-session-state.md` ("Live elsewhere"). |
| `sessions-live-elsewhere` | `(ids)` | `{[id]: {pid, cwd, startedAt}}` | The same check for a working-set restore batch, answered from one scan of `~/.claude/sessions/`; ids that are not live are absent, and at most 200 ids are looked up. Called once by `runRestore`; see `.ai/contexts/cli-session-state.md` ("Live elsewhere"). |
| `stop-session` | `(id)` | `{ok}` | Kill the PTY for `id`. Local only — a remote-attach session's PTY is the local ssh attach client, so this only detaches it; see `remote-stop-session` for the real remote "stop". |
| `remote-stop-session` | `({alias, sessionId})` | `{ok, method?, error?}` | The "stop" verb for a remote-ssh session (`.ai/contexts/session-state.md`, "Lifecycle decisions") — kills the process on the host at the narrowest matching tmux scope when the descriptor names a target (`kill-pane` when it names a pane, `kill-window` when it names only a window — never `kill-session`, siblings share the tmux session), confirms death with a `/proc` poll, and falls back to `kill -TERM` then `kill -KILL` if the tmux kill didn't stick or no tmux target was named; refuses with the pid-reuse message when the pid now belongs to a non-claude process. `method` is `'tmux-pane' \| 'tmux-window' \| 'pid-term' \| 'pid-kill'`. On success also drops the host's in-memory descriptor, forces a host refresh, and detaches the local attach PTY if one was open. Handler in `main.js`, adapter in `remote-stop.js` (reuses `remote-attach.js`'s pid-reuse probe, not a fork). |
| `set-star` | `(id, starred)` | `{ok}` | Set the desired pin state on every conversation part. |
| `rename-session` | `(id, name)` | `{ok}` | Set customTitle. |
| `archive-session` | `(id, archived)` | `{ok}` | Move to archive. |
| `delete-session-preview` | `(id)` | `{ok, error?, partIds?, parts?, transcripts?, subagents?}` | Awaits the full `deleteSessionGuard(id, partIds)` before resolving files. Refusals reach the renderer notice before any confirmation. |
| `delete-session` | `(id, partIds)` | `{ok, error?, removedPartIds?}` | Rechecks membership and the full guard against the confirmed parts before removal. Never stops a process. |
| `read-session-jsonl` | `(sessionId)` | `Entry[]` | Full transcript. |
| `read-subagent-jsonl` | `(parentSessionId, agentId)` | `Entry[]` | Subagent transcript. |
| `list-subagents` | `(parentSessionId)` | `Subagent[]` | All children of a parent. |
| `start-subagent-watch` | `(parentSessionId, agentId)` | `watchId` | Begin tailing. |
| `stop-subagent-watch` | `(watchId)` | `{ok}` | Tear down watch. |

### Projects + worktrees

| IPC | Args | Notes |
|---|---|---|
| `browse-folder` | — | Native folder picker |
| `add-project` | `(projectPath)` | Register a project (creates folder index) |
| `archive-project-settings` | `(projectPath, folderKey)` | Archive the project reversibly; preserve settings/cache/registration, suspend schedules through hidden-state filtering. Returns `{ ok: true, entry }`, where `entry` is the exact stored bare path or `alias::path` for `unarchiveProject(entry)`. Bridge: `archiveProjectSettings`. |
| `unarchive-project` | `(entry)` | Refuse entries marked `delete` before effects with `{ error, code: 'DELETED' }`; missing entries return `{ error, code: 'NOT_ARCHIVED' }`. Remove an archived or legacy hidden entry, refresh its folder and restore legacy local schedule registration. Bridge: `unarchiveProject`. |
| `archive-project` | `(groups, opts)` | Archive folder groups and confirmed schedules; success includes `archivedAt` for the reverse path. Bridge: `archiveProject`. |
| `undo-archive-project` | `(groups, archivedAt)` | Refuse invalid groups or a stale timestamp before any effects; remove those folder archives, restore consumed offers and re-enable exactly their `disabledByArchive` files. Bridge: `undoArchiveProject`; folder Archive Undo passes the original groups and returned timestamp before restoring session archive flags. |
| `remove-project` | `(projectPath, folderKey)` | Destructive Delete Project: drop settings, cache/search and schedule registration; no disk deletion. Bridge: `deleteProject`. |
| `remap-project` | `(oldPath, newPath)` | **Atomic JSONL `cwd` rewrite**, refuses if active sessions exist. See PR #20. |
| `check-remap-project` | `(oldPath)` | Read-only `{ ok, error? }`; bridge `checkRemapProject`. Runs `remapProjectRefusal`, also used by the action: any non-exited, non-panel PTY with the same encoded folder refuses. The renderer checks before the folder picker and confirmation, and shows a notice on refusal or check failure. |
| `delete-worktree` | `(worktreePath, shown)` | `shown: { fingerprint, confirmLocked, confirmSubmodules }` from the successful preview. Rechecks path guards and Git state through `worktree-delete.js`; no force for clean status without submodules or a lock, one force for matching dirty status or explicitly confirmed submodules, two only for an explicitly confirmed matching lock. Submodule consent is required even with lock consent. Changed state / Git refusal returns `{ ok: false, refresh: true, status, error }`; renderer shows a persistent notice and asks again. Cleanup happens only after successful removal. Removal has a 120 s timeout; preview calls retain 15 s. |
| `check-delete-worktree` | `(worktreePath)` | Read-only `{ ok, error? }`; bridge `checkDeleteWorktree`. Shares `checkDeleteWorktree` with Delete and status: string input, recognized layout and disk-resolved known parent. The renderer awaits it before the dialog or status request; refusal or failure shows a notice. No git command or cleanup runs in the check. |
| `worktree-status` | `(worktreePath)` | `{ ok, path, homeDir, branch, dirty, total, ignoredCount, submodules, locked, lockReason, fingerprint, sessions }`. Line-delimited `worktree list --porcelain` works on Git 2.24 and recent Git; C-quoted paths decode octal UTF-8 and escaped characters. NUL-delimited status explicitly uses `--untracked-files=all --ignore-submodules=none`; a separate `--ignored --untracked-files=normal` status counts collapsed ignored directories. Sessions include non-exited local PTYs and live sidebar descriptors whose cwd is in the worktree; remote records are excluded. |

The sidebar deletion dialog displays the full path (`~` for home, absolute on
hover), branch, running session ids/cwds and ignored-entry warning. Confirmation
stays disabled until a successful preview; locks and submodules each require a
separate checkbox. Preview and removal failures use the persistent session-action notice.
Remote nested headers share the renderer path, so Delete refuses before any
local IPC and directs the user to git on the host. Project-folder Delete (#474)
still never offers deletion of the project's own directory. Agents Delete uses
`claude rm` without force; it does not call the worktree IPC or escalate refusals.

The SHA-256 fingerprint includes worktree metadata, a streamed hash of full index stage records,
dirty/untracked paths, both rename paths, file modes and streamed SHA-256 file
contents. Streaming bounds memory and detects same-size edits with restored
timestamps; symlinks hash their link targets and absent files have a missing
marker. Initialised dirty submodules recurse through the same status/index/content snapshot,
up to 16 levels. Index gitlinks identify submodules, including clean ones, so
the user can explicitly consent to the force Git requires. Gitlinks without a
`.git` entry are marked uninitialised and never run Git in the child directory,
where it would otherwise discover the parent repository. Untracked embedded
repositories or other unexpected dirty directories refuse with instructions to
review or move them, rather than recursively reading arbitrary directory trees.
Ignored paths/counts are compared, but ignored contents are intentionally not
hashed or expanded into status rows. Index stage output streams directly into SHA-256 with
bounded record parsing, bypassing the 16 MiB buffer used for other Git calls.
The whole snapshot, including nested submodules and index data, has a 512 MiB
hash budget; an over-budget refusal names the biggest files encountered.
Preview refuses above 100,000 dirty records and translates maxBuffer/timeout
errors into actionable refusals. An interrupted removal preserves killed/signal
metadata and warns that the folder may be partly deleted, without rereading a
potentially missing folder or claiming Git refused it.
If an ordinary Git removal failure is followed by a failed fresh preview,
the response preserves Git's original error and warns that registration may
already be gone and the folder partly deleted.

Directory scans use a root lstat and Dirents without traversing directory links,
once before the snapshot and exactly once again immediately before removal.
Nested submodule snapshots do not repeat the tree scan. Up to 32 directory reads
run in each batch, with a shared 200,000-directory cap and five-second budget
per scan; exceeding either refuses with an actionable message. The root and link
targets use the same native resolver (`fs.promises.realpath`). Windows refuses
every directory link, including inside-pointing junctions and directory symlinks;
POSIX permits inside-pointing links and refuses outside or unresolved targets.
These rules include ignored directories. A directory whose realpath is its own
absolute path is walked as an ordinary directory, including reparse placeholders;
the message names up to ten plus the total and instructs removal of the link
first (`rmdir <path>` for Windows junctions, never recursive deletion; POSIX
`rm <link>` without `-r`). File hashing resolves on disk with `resolveOnDisk`,
checks realpath containment and reads that returned path; file symlinks hash
only their link text after checking the resolved parent. This is a
fresh comparison before removal, not an atomic filesystem lock: edits after the
final scan remain possible, including newly created or retargeted directory links.
Every index gitlink is checked even when absent from dirty status: a nonempty
uninitialised submodule refuses preview/deletion before force can hide its files.

### Tabs (Memory / .work-files / Stats)

| IPC | Returns |
|---|---|
| `get-memories` | `{global, projects}` |
| `read-memory` / `save-memory` | content / `{ok}` |
| `get-work-files` | `{projects: WorkFilesProject[]}` — **dedupes by projectPath** since PR #15. Walks `<projectPath>/.work-files/` recursively, capped at 200 files per project. |
| `read-work-file` / `delete-work-file` | content (with `.work-files/` path guard) / `{ok}` |
| `get-stats-from-db` | `buildStatsFromDb()`: `{dailyActivity, dailyModelTokens, modelUsage, totalMessages, totalSessions, totalToolCalls, totalTokens, firstSessionDate, lastComputedDate}` from `session_metrics` — heatmap source since PR #7 |
| `refresh-stats` | `{stats, usage}` — combined; calls `buildStatsFromDb` (using `getDailyMetrics`) + `fetchAndTransformUsage` |
| `get-usage` | rate-limits payload from Claude `/usage` |

### Search

| IPC | Args | Returns |
|---|---|---|
| `search` | `(type, query, titleOnly)` | FTS5 result rows. `type ∈ {session, subagent, memory, work-file, null}` |
| `rebuild-cache` | — | Force a full re-index (heavy) |

### Settings

| IPC | Notes |
|---|---|
| `get-setting` / `set-setting` / `delete-setting` | Generic key/value over `settings` table |
| `get-settings-by-prefix` | `(prefix)` accepts only the non-empty string `continuationChoice:` and returns an object of matching keys and values; other prefixes throw before reading settings. Bridge: `getSettingsByPrefix`. Used to load continuation choices before restore and reload. |
| `get-effective-settings` | `(projectPath)` — resolves global + project overrides |
| `get-shell-profiles` | Configured shell list |
| `get-schedule-creator-command` / `create-schedule-session` / `run-schedule-now` | Schedule integration |

**One table of defaults.** `SETTING_DEFAULTS` lives in `public/setting-defaults.js`,
a dual-mode file: `main.js` requires it, `index.html` loads it as a classic
script, so both processes resolve a missing key to the same value.
`get-effective-settings` returns project value → global value → that table, and
`settings-panel.js`'s `fieldValue()` resolves in the same order — the panel
therefore displays what a session will get. No renderer file carries a default
of its own; `test/setting-defaults.test.js` fails if one appears.

An explicitly saved `null` (permission mode "Default", which omits
`--permission-mode`) is a value, not an absence: the merge overrides on
`!== undefined` only, so it is never promoted to the table's `'auto'`.

`receiveBetaVersions` is global-only in the panel and defaults to false in
the shared table. `set-setting('global', ...)` re-reads the saved row and
applies its channel to `autoUpdater.allowPrerelease` immediately. Startup
applies it before scheduling update checks and logs `stable` or `beta`.
Automatic downloads remain controlled separately by `autoUpdate`; manual
checks use the same channel. No downgrade is enabled because the SQLite cache
only migrates forward. Release promotion changes GitHub's pre-release flag
without changing the version or binary, so the installed version alone cannot
reliably identify a beta for the optional About indicator.

### File panel (IDE mode)

| IPC | Args |
|---|---|
| `read-file-for-panel` / `save-file-for-panel` | Arbitrary file IO inside the user's projects |
| `resolve-terminal-paths` | `(sessionId, texts[])` — may the panel open these paths? One call carries every unknown candidate on a hovered line, at most 64. Relative text resolves against the session's own cwd, main-side. Returns one `{ok: true, path}` or `{ok: false, reason}` per input; reads bytes, returns none. Backs the terminal link provider — see `.ai/contexts/terminal-path-links.md` |
| `watch-file` / `unwatch-file` | fs.watch wrapper, emits `file-changed` event. The registry is keyed by resolved path and is released either one path at a time by `unwatch-file`, or wholesale by `closeAllFileWatchers()` in the window-`closed` handler, alongside `changesWatchers.closeAll()` and the subagent watches. A closing window sends no `unwatch-file`, so that teardown is what bounds these descriptors to the window's lifetime; it swallows a `close()` that throws, since a handle whose file is already gone must not strand the rest of the teardown. |

### Changes panel (issue #251)

A git-status view in the same right-hand file panel, for local and remote
sessions alike; a local session's changed file is editable in place. Full
design (parser, runner, quoting, cwd resolution, refresh triggers, editing):
`.ai/contexts/changes-view.md`. User-facing: `docs/changes-view.md`.

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `git-changes-status` | `(sessionId)` | `{ok, kind, branch, files, totals, untrackedCollapsed} \| {ok:false, reason?, error}` | `git status --porcelain=v2 --branch -uall` + `git diff --numstat` + `git diff --cached --numstat`, merged by `git-changes.js`'s `mergeChanges()`. A `-uall` run too large for the transport falls back to git's default untracked mode and reports `untrackedCollapsed: true`. `kind` is `'local'` or `'remote'` — the renderer decides from it whether the panel is editable. A cwd with no work tree comes back `reason: 'not-a-repo'` — the panel's plain-language "not a git repository" line; every other failure carries a bounded message and no reason, including a repository git refuses to open. Telling the two apart is `git rev-parse --is-inside-work-tree` plus a filesystem walk, never a message match — see `.ai/contexts/changes-view.md` ("Not a repository"). |
| `git-changes-diff` | `(sessionId, filePath, staged, untracked)` | `{ok, content, truncated, added, deleted} \| {ok:false, error}` | `git diff [--cached] -- <filePath>`, or `git diff --no-index -- /dev/null <filePath>` when `untracked`; capped at 512 KB. `added`/`deleted` are filled for an untracked file only — see `.ai/contexts/changes-view.md` ("Untracked files"). |
| `git-changes-file` | `(sessionId, filePath, {staged})` | `{ok, original, current, version, binary, truncated} \| {ok:false, error, reason}` | The content pair behind the editable diff: `git cat-file blob :<path>` (or `HEAD:<path>` when `staged`) and the working-tree file, both LF-normalised and strictly UTF-8. `version` is an opaque token the renderer hands back on save. Local sessions only. `reason` is one of `invalid-path`, `repo`, `missing`, `outside`, `symlink`, `hardlink`, `git-dir`, `sensitive`, `not-a-file`, `binary`, `too-large`, `encoding`, `mixed-eol`, `git`, `remote`. |
| `git-changes-save` | `(sessionId, filePath, content, version)` | `{ok:true, version} \| {ok:false, error, reason}` | Writes the working-tree file the guard resolved, re-applying its line endings, and returns the token for the next save. Refused with `reason:'stale'` when the file changed since `version` was issued, and with `invalid-version` when no token is passed. Local sessions only; never creates a file. |
| `git-changes-watch` / `git-changes-unwatch` | `(sessionId, filePath)` | `{ok:true} \| {ok:false, error, reason}` | `fs.watch` on the path the same guard resolves, through `git-changes-watch.js`'s registry, keyed by session + repo-relative path. Emits `git-changes-file-changed(sessionId, filePath)` (debounced 300 ms) — the repo-relative path, never the resolved one. A `rename` event re-arms the watch, since an atomic replacement otherwise silences it. |

`filePath` is repo-relative in all four. No absolute path crosses this
boundary in either direction: the session's cwd is re-resolved main-side on
every call, and the absolute path built from it is used and discarded there.

### Background agents (see `.ai/contexts/bg-agents.md`)

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `get-bg-agents` | — | `{roster, daemonReachable}` | Arms the watchers on first call, re-subscribes the `bg-agents-changed` push on every call, then reconciles through `claude agents --json --all`. Handler in `bg-agents-ipc.js`. |
| `check-bg-agent-verb` | `(verb, id)` | `{ok, error?}` | Check only: `stop` \| `respawn` \| `rm`, id validated against `JOB_ID_RE`. Shares the execution guard; no CLI call or roster reconcile. Stop passes through unknown or hosted state. Bridge: `checkBgAgentVerb`; renderer Stop/Delete await it before confirmation and display refusals in the detail. Execution checks afresh after confirmation. |
| `bg-agent-verb` | `(verb, id)` | `{ok, error?}` | `stop` \| `respawn` \| `rm`; id validated against `JOB_ID_RE`; `respawn`/`rm` refused on a live (`working`/`blocked`) job. |
| `dispatch-bg-agent` | `(fields)` | `{ok, id?, error?}` | `claude --bg …` in `fields.cwd`. |
| `bg-agent-live-job` | `(sessionId)` | `{known, job} \| {known:false, reason}` | `liveJobCheck`; `stopBeforeArchive` refuses on a live job or an unknown answer. |
| `restore-background-job` | `(sessionId, {attachOnly?}?)` | `{action:'attach', sessionId, jobId} \| {action:'respawned-not-attached', jobId} \| {action:'refuse', reason, jobId?, recovery?, missing?}` | Scoped to saved `bg: true` working-set members; S1a classification, checked respawn for proven-dead workers, then a live bg descriptor within 15 s. Unknown refuses; stopped offers explicit Respawn. `missing: true` releases the saved background entry for a later ordinary guarded resume. `attachOnly` never respawns. Bridge: `restoreBackgroundJob`. |

`open-terminal` accepts `sessionOptions = {type: 'attach', jobId, cwd}` and runs `claude attach <jobId>`; `stop-session` on such a session detaches (`{ok, detached: true}`).

### Touched files (issue #309)

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `session-touched-files` | `(sessionId)` | `{ok, files, unresolved, omitted, coverage} \| {ok:false, reason?, error}` | The files the session's file tools touched, from its transcript and its subagents'. `files` rows are `{path, state, openable, tools, count, sources}` with `state` one of `present`, `gone`, `unreadable`, `refused`, `not-file`; `unresolved` rows carry the raw text and a reason, never a `path`. `reason` may be `no-transcript`; local and mirrored remote sessions are accepted and a `sub:` id is refused. Remote disk failures keep rows `unknown`, not `gone`. Full design: `.ai/contexts/touched-files.md`. |

This is the one handler whose *output* is a list of absolute paths taken from
attacker-influenced data. Listing is not opening: the renderer opens a row
through `read-file-for-panel` and its guards, never through this IPC. A remote
row supplies `{editor: true, sessionId}`; main resolves the remote Changes
target and uses `readRemoteTouchedFile`, with a 2 MiB byte cap, binary and
strict UTF-8 guards, canonical credential/metadata checks and read-only output.
An unknown remote target never falls back to local disk IO.

### Misc

| IPC | Notes |
|---|---|
| `open-external` | Opens https:// URLs in OS browser |
| `clipboard-write-text` | Main-process clipboard write (Wayland fix, PR #18) |
| `get-app-version` | From package.json |
| `whats-new-startup` / `whats-new-dismissed` | The What's new dialog: the `CHANGELOG.md` sections to show on startup (or `null`), and recording the running version as `lastSeenVersion` when it closes. Help → What's new sends `show-whats-new` with the running version's section. See `docs/changelog.md` |
| `updater-check` / `updater-download` / `updater-install` | electron-updater |
| `read-clipboard` / `clipboard-has-image` | Main-process clipboard reads (text; whether an image is on it) |
| `toggle-full-screen` / `popup-app-menu` | The frameless window's strip and ☰ menu — see window-frame.md |
| `get-indexing-state` | `{finished}` — whether the first index pass is done; `indexing-finished` pushes the same news. See session-cache.md |
| `get-task-snapshots` | The task registry's snapshots for live sessions; pushes follow on `task-snapshot` / `task-rekey`. See session-state.md |
| `get-activity-trace-state` | Debug-mode state for Settings → Diagnostics; `activity-trace-state` pushes changes. See `docs/activity-trace.md` |
| `get-activity-reporting-state` / `set-activity-reporting-enabled` | ActivityWatch reporting — see activitywatch.md |
| `get-project-archive-plan` / `reenable-project-schedules` / `dismiss-schedule-reenable-offer` | Archive project planning and the schedule re-enable offer — see session-cache.md |
| `remote-hosts-apply` / `remote-hosts-refresh` / `remote-host-refresh` / `remote-host-enrol-check` / `remote-launch-session` / `remote-send-prompt` | Remote hosts — see session-cache.md and `docs/remote-hosts.md` |

### Send (fire-and-forget, renderer → main)

| IPC | Notes |
|---|---|
| `terminal-input` | Forward keypress to PTY |
| `terminal-resize` | Resize PTY columns/rows |
| `close-terminal` | Renderer signals tab closed |
| `mcp-diff-response` | Diff accept/reject from MCP IDE mode |
| `activity-trace` | Renderer probe → the trace file. Registered **only** when `SWITCHBOARD_ACTIVITY_TRACE` is set (see below) |
| `activity-focus` / `activity-titles` | Focused session and running-session titles for ActivityWatch — see activitywatch.md |
| `updater-close` | The updater window closed |
| `exit-background-cancel` / `unsaved-check-phase` / `unsaved-pong` / `unsaved-dialog` / `unsaved-ready` / `unsaved-check-ack` / `unsaved-check-result` / `unsaved-check-reason-done` | The exit flow's unsaved-edits handshake, handled in `unsaved-guard.js` — see window-frame.md |

### Events (main → renderer)

`terminal-data`, `session-detected`, `process-exited`, `remote-resize-allowed`, `terminal-notification`, `cli-busy-state`, `session-forked`, `subagent-spawned`, `subagent-completed`, `subagent-watch-event`, `projects-changed`, `status-update`, `indexing-progress`, `file-changed`, `mcp-open-diff`, `mcp-open-file`, `mcp-close-all-diffs`, `mcp-close-tab`, `updater-event`, `show-whats-new`, `session-transcript-activity`, `bg-agents-changed`, `bg-handoff-notice`, `git-changes-file-changed`, `remote-activity`, `activity-trace-state`, `indexing-finished`, `task-snapshot`, `task-rekey`, `mcp-status`, `full-screen-changed`, `exit-background-progress`, `exit-attempt-invalidated`, `exit-flush`, `unsaved-check`, `unsaved-check-reason`, `unsaved-ping`

`remote-resize-allowed(sessionId)` is emitted once when a live remote attach
promotes from shared to solo. `preload.onRemoteResizeAllowed` forwards the id
to the renderer, which enables solo sizing and schedules a fitted resize.
Initial solo attaches and failed promotions emit no event; there is no reverse
notification. See `.ai/contexts/terminal-refresh.md`.

`session-transcript-activity` and `remote-activity` (see
`.ai/contexts/session-cache.md`, "Remote hosts — busy spinner")
each carry one of two payload shapes on the same channel — a subagent write is
never a second event (issue #247): `{ sessionId, at }` for a top-level
transcript, or `{ parentSessionId, agentId, at, kind: 'subagent' }` (plus
`alias` for `remote-activity`) when the write is a subagent leg attributed to
its parent. See `.ai/contexts/subagent-observability.md` ("Attribution across
sources") for the attribution and `.ai/contexts/session-state.md` for how each
adapter applies it.

- **`indexing-progress`**: `{coldStart, current, total, sessionsSoFar, done, error?}`. Fired only from `populateCacheViaWorker()` when the `initial_scan_complete` marker was absent at call time (a genuine first launch, a post-migration reset, or the resume of an interrupted first scan) — never on a routine warm-start rebuild. Throttled to ~4 events/s; the first event and the final `done:true` always pass. `done:true` with `error` means the scan failed and the renderer shows the failure in the banner instead of hiding it. Drives the renderer's dismissible first-run banner (`public/app.js`'s `updateIndexingBanner`); see `.ai/contexts/session-cache.md`.
- **`session-transcript-activity`**: `{sessionId, at}`. Fired from inside the raw `fs.watch(PROJECTS_DIR, ...)` callback in `startProjectsWatcher()` — deliberately **not** routed through the debounced `flushChanges()` / `notifyRendererProjectsChanged()` path that also lives there, so it reaches the renderer well before the 500ms debounce plus the cache refresh it triggers. Only fires for a top-level session transcript (`<folder>/<sessionId>.jsonl`, two path segments — a subagent leg is out of scope, see `.ai/contexts/session-state.md` ports table) whose sessionId has no live PTY in `activeSessions` (`sessionHasPty()`, main.js — the OSC busy/attention path already owns a PTY-backed row). Coalesced to at most one emission per second per session by `local-transcript-activity.js`'s `createLocalTranscriptTracker()`. Feeds `public/local-transcript-adapter.js` (`window.api.onSessionTranscriptActivity`) — the `local-transcript` adapter in `.ai/contexts/session-state.md`.

## Invariants

- **No `nodeIntegration` in renderer**. The renderer can only call what's in `window.api`. `contextIsolation: true` is mandatory in BrowserWindow options.
- **Every IPC must validate its arguments** at the main-side handler. The renderer is trusted-ish (single user, single window) but a compromised renderer should not be able to escape the user's working directories.
- **Path-touching IPCs (`read-work-file`, `delete-work-file`, `read-memory`, `run-schedule-now`, `delete-worktree`, etc.) MUST guard their paths, and the guard must resolve on disk, not just `path.resolve()`**. `path.resolve()` normalises `..` but does not follow symlinks — a path can look contained by every string check and still open a file somewhere else through a symlinked directory. The shared primitive is `resolveOnDisk()` in `resolve-path-on-disk.js` (realpath, or `null` when nothing exists there yet); it is called *inside* the guards, not duplicated at each call site:
  - `isSensitivePath` / `resolveAllowedMemoryPath` (+ its boolean form `isAllowedMemoryPath`) / `isKnownProjectRoot` (`ipc-path-validator.js`) — denylist, allowlist, and exact-match-against-known-projects, used by the memory, file-panel and worktree handlers. `resolveAllowedMemoryPath` returns the resolved path, not a boolean, and callers that go on to read/write MUST use that returned value for the operation — a caller that re-resolves its own literal path afterwards reopens a TOCTOU (checked path and used path can diverge if a symlinked ancestor is swapped in between). See `resolve-path-on-disk.js` for the documented gap when the target does not exist yet.
  - `resolveDeletionTargets` (`delete-session-target.js`) — session deletion, the first handler to need this and the source the primitive was extracted from.
  - `resolveRunNowTarget` (`run-schedule-now-target.js`) — `run-schedule-now`'s shape + allowlist check, run before any read or spawn. Four duties, and which path each one answers for matters: the **directory shape** (`.claude/commands` parents) is checked on the *requested* path, because what makes a file a schedule is the directory that lists it, and a versioned configuration is linked in there from a repo elsewhere on disk; the **filename** is checked on the requested path *and again on the disk-resolved target*, so the listing directory decides where a schedule may be linked from but never what it may point at; `isSensitivePath` refuses a resolved target in a credential location; and `isAllowedMemoryPath` runs on the disk-resolved file **and** on the disk-resolved project root the run is spawned in, which with a linked-in schedule is not derivable from the file. Dropping any one of the four is caught by `test/run-schedule-now-target.test.js`.
  Work-files still use the narrower `.includes('/.work-files/')` substring check — same weakness against a symlinked ancestor, not yet migrated (see "IPC path-guard inventory" below). A handler that reads *content* back to the renderer (file panel, memory) and a handler that only decides *whether to run a command* (`run-schedule-now`) both need a guard, and neither one is safe with `path.resolve()` alone.
- **Trust boundary is the contextBridge call**. Anything passed across must survive structured-clone serialization. No functions, no DOM nodes, no class instances — only plain JSON.
- **Async handlers return promises**. Renderer uses `await window.api.foo(...)`. Throws cross the boundary as rejected promises; return `{ok, error}` if you want graceful failure handling on the renderer side.
- **Never call a method on `session.pty` directly.** Go through `pty-ops.js` (`resizePty` / `killPty` / `writePty`, or the generic `withPty`). See "PTY operations race the exit" below.

### IPC path-guard inventory

Every handler that takes a renderer-supplied path or derives a spawn location from one, and what guards it as of this pass:

| IPC | Guard | Kind |
|---|---|---|
| `read-memory` / `save-memory` | `resolveAllowedMemoryPath` (read/write the returned path, not the caller's own re-resolved one) | disk-resolved allowlist |
| `get-memories` (the list, and the FTS bodies it indexes) | `acceptMdFile` (`scan-md-files.js`) applies `isSensitivePath` itself and the `isAllowedMemoryPath` predicate `get-memories` passes in; `scanMdFiles` is the directory-wide form of it, and the project-root `CLAUDE.md`/`GEMINI.md`/`agents.md` go through it by name | disk-resolved denylist + allowlist — a listed file is read twice more downstream, once by `read-memory` behind `resolveAllowedMemoryPath` and once by the FTS indexer behind nothing at all, so the guard belongs on the list. The denylist is not the caller's to choose: containment in an allowed project root says nothing about a cloned repo's own `.ssh`/`.env` |
| `open-main-log` | Main chooses electron-log's path; requires a string absolute path and `!isSensitivePath` before `shell.openPath`. | no renderer-supplied path; disk-resolved denylist |
| `open-path` / `read-file-for-panel` / `save-file-for-panel` / `watch-file` | Local: `isSensitivePath`. Remote panel reads resolve the session target and guard the literal and canonical host path. Saves refuse a resolved remote target and any path already opened through the remote panel route, even without renderer options. | disk-resolved denylist + main-side remote write refusal |
| `resolve-terminal-paths` | `resolveTerminalPaths` / `resolveTerminalPathTarget` (`terminal-path-target.js`, async, 8 checks in flight): the session cwd for a relative path, existence, then `isSensitivePath` on the resolved path, then regular-file-ness, `PANEL_FILE_MAX_BYTES` and a NUL-byte sniff | disk-resolved denylist, strictly narrower than `read-file-for-panel` — its whole input is untrusted terminal output, and its answer decides whether a path is even offered as a link. Existence is tested before the denylist because most candidates on a line of prose are not files; a path that exists still passes the denylist before anything else is decided. A remote session is refused outright, and so is one whose working directory cannot be resolved — otherwise an unresolvable remote would fall back to stat-ing the local disk. A panel shell (`panelFor`) resolves through its owning session |
| `check-delete-worktree` / `delete-worktree` / `worktree-status` | Shared `checkDeleteWorktree`: `WORKTREE_PATH_RE` (shape) + `isKnownProjectRoot` (disk-resolved exact match) | shape + disk-resolved allowlist |
| `delete-session-preview` / `delete-session` | `deleteSessionGuard` then `resolveRowDeletionTargets` (`delete-session-target.js`) | full live/background/unknown-state guard + disk-resolved containment |
| `run-schedule-now` | `resolveRunNowTarget` (`run-schedule-now-target.js`), which composes directory shape (requested path) + filename shape (requested **and** resolved) + `isSensitivePath` + `isAllowedMemoryPath` on both the resolved file and the resolved project root | disk-resolved allowlist + denylist — **the only handler in the app that both reads a file and spawns a process from a renderer-supplied path; the file's content becomes a prompt sent to the model, so the resolved target is constrained, not just its location** |
| `read-work-file` / `delete-work-file` | `.includes('/.work-files/')` substring | ad hoc string, **not disk-resolved** — a symlinked ancestor defeats it the same way it defeated `isSensitivePath`/`isAllowedMemoryPath` before they were fixed here. Not migrated in this pass; same fix shape (`resolveOnDisk` + a `.work-files` component check instead of a substring test) would close it |
| `read-activity-trace-file` / `delete-activity-trace-file` | `resolveTraceFilePath` (`activity-trace.js`) | ad hoc string (directory + basename pattern), **not disk-resolved** — narrower surface (one generated file family) lowers the stakes, not migrated |
| `add-project` / `remap-project` | none on the probe (`fs.statSync`/`fs.existsSync`/`fs.lstatSync`); the actual write is confined through `encodeProjectPath` | existence/type oracle only — inherent to the feature (both accept an arbitrary disk location by design), not cheaply fixable without breaking it |
| `open-terminal` (`preLaunchCmd`) | `validatePreLaunchCmd` (`pre-launch-cmd-guard.js`) | not a path guard — a character allowlist on a raw-shell-by-design string (the documented prefix's character set plus its analogues: `env VAR=val`, `doas`, an absolute binary path); a denylist here proved incomplete (process substitution `<(...)`/`>(...)` needed none of the blocked characters), so this is closed by construction instead of by enumeration. Known cost: bare `$VAR` expansion and quoted arguments, both previously accepted, are now refused. The real-bash test of the documented shape spawns `bash -l -c` without `-i`: it asserts that the validated prefix runs as an ordinary command line, which does not depend on interactive mode, and `-i` with no TTY is what prints "cannot set terminal process group" (job control) next to the intermittent status 2147483652; the intermittent status is handled in `test/spawn-retry.js` (#342) |
| `read-session-jsonl` / `read-subagent-jsonl` / `start-subagent-watch` / `create-schedule-session` | none directly — path is derived from a SQLite key or built via `encodeProjectPath`, not taken verbatim from the renderer | out of scope for a path guard; flag if a renderer-controlled string is ever found reaching the derivation unencoded |
| `git-changes-file` / `git-changes-watch` / `git-changes-unwatch` | `isSafeRevPathOperand` + `resolveTargetInsideRepo` (`git-changes-file.js`): the repo root and git directories come from `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir`, a symlink at the target is refused before anything follows it, and **every remaining check runs on the disk-resolved path** — containment in the root, no `.git` segment, nothing inside a git directory, `isSensitivePath`, regular file | shape + disk-resolved containment + denylist — the operand is `<rev>:<path>`, a *revision*, not a pathspec: `--literal-pathspecs` does not reach it and `--` cannot separate it, so it carries its own guard. See `.ai/contexts/changes-view.md` ("Editing a changed file") |
| `git-changes-save` | `isSafeRepoRelativePath` + the same `resolveTargetInsideRepo`, plus a version token that must still match the bytes on disk; the write runs on the path the guard returned, never on a re-derived one | shape + disk-resolved containment + denylist — **the only write handler in the app whose entire input is a relative path from the renderer**, so containment is the guard, not an afterthought; `save-file-for-panel` next to it has none (it takes an absolute path and checks only `isSensitivePath`) and is not the precedent to copy here |
| `session-touched-files` | Remote: validated alias and mirror folder, POSIX absolute paths without control characters or `..`, canonical credential/metadata guards on the host, one 64 KiB/20 s disk batch. Local: `isValidChangesSessionId` (no subagent shape), a plain-folder-name check on the cached folder, `resolveTouchedPath` (absolute, no UNC / `\?\` / device form, no control character; relative only against a `verifiedTranscriptCwd`), `isSensitivePathAsync` on every resolved path before its `stat` | shape + disk-resolved denylist — **stat-only**: a path that fails the denylist is listed `refused` and never stat-ed; nothing is read. The click goes to `read-file-for-panel` |
| `git-changes-diff` | `isSafeGitPath`, or `isSafeNoIndexPath` + containment when `untracked` (`git-changes-runner.js`) | a git pathspec relative to an arbitrary (possibly remote) cwd; see `.ai/contexts/changes-view.md` ("Quoting rule") for why this is a denylist, not an allowlist. The untracked variant is a real filesystem operand of `git diff --no-index`, which has no repository-boundary check of its own: on top of the syntactic guard it is resolved with `realpath`/`stat` against the resolved cwd (local) or checked against `git ls-files --others` (remote), git receives the guard's operand rather than the caller's, and the returned diff must name that same path in its `diff --git` line — see "Untracked files" in the same doc |

### Sensitive-path candidates

`isSensitivePath` and `isSensitivePathAsync` (`ipc-path-validator.js`) share one candidate builder, `sensitiveCandidates` / `sensitiveCandidatesAsync` (`resolve-path-on-disk.js`), and test the denylist against every spelling it returns:

- the literal path, and the same path with a Windows `\\?\` / `\\.\` prefix removed (`\\?\UNC\host\share` becomes `\\host\share`);
- the JS realpath **and** the native realpath. They diverge on Windows: the JS walker keeps 8.3 short names (`SSH~1` for `.ssh`) and throws `EISDIR` on a `\\?\` path through a junction, while `fs.realpath.native` expands the short name and resolves the junction. Either one alone misses a spelling the other catches, so both are tried and every result is matched;
- on win32, the same path with trailing dots and spaces removed from each segment (`.ssh.\id_rsa`, `.netrc `): Win32 normalisation drops them, so `shell.openPath` reaches the real file while the literal string matches nothing. Not applied to `\\?\` paths, which Win32 does not normalise (the `\\.\` device prefix is normalised, so those are trimmed);
- when nothing exists at the path yet (a file about to be saved), the first existing ancestor — found with one `lstat` per level going up, then resolved the two ways — with the missing tail re-attached, otherwise `SSH~1\new-key` would pass because there is nothing to resolve.

Fail closed: if **either** realpath fails for a reason other than `ENOENT`/`ENOTDIR` (`EACCES`, `EPERM`, `ELOOP`, ...), or an ancestor cannot be `lstat`ed, the path is treated as sensitive even when the other realpath succeeded: the one that failed may have been the one that sees the credential location. `resolveOnDisk` / `resolveOnDiskAsync` are unchanged and stay on the JS realpath (the allowlist and containment checks compare against it). The tests are in `test/sensitive-path-windows.test.js`; the 8.3 cases skip, with a stated reason, on a volume that generates no short names.

### Non-obvious behaviors

- **`preload.js` is the *single* surface the renderer sees**. If you add `ipcMain.handle('xyz', ...)` but forget to add `xyz: () => ipcRenderer.invoke('xyz')` in preload, the renderer can't call it. Symptom: `window.api.xyz is not a function`.
- **Webcontents `send` events vs `invoke`**: `invoke`/`handle` is request-response (returns a promise). `send`/`on` is fire-and-forget (no return). Pick based on whether the caller needs the result.
- **`webUtils.getPathForFile(file)`** is the only way to get the absolute path of a drag-and-dropped file in Electron 28+. Exposed at `window.api.getPathForFile`.
- **Updater events use a single `onUpdaterEvent(type, data)` callback** for all 5+ event types — different from the per-event onSubagentSpawned/Completed pattern. Inconsistency tax.

### PTY operations race the exit

`terminal-resize` accepts `(sessionId, cols, rows, refresh)`. The preload
`resizeTerminal` takes `{refresh: true}` as its optional fourth argument and
sends the boolean in a single message. The main resize handler owns the nudge
and final-size restoration; see [terminal-refresh](terminal-refresh.md).

`session.exited` is set from `ptyProcess.onExit`, which fires on a later tick
than the child's actual death. So `if (!session.exited) session.pty.resize(...)`
is a check-then-act: node-pty can still throw `Cannot resize a pty that has
already exited` between the test and the call. In a `ipcMain.on` handler that
throw is fire-and-forget — nothing awaits it, so it surfaces as an uncaught
exception in the main process and Electron pops the "A JavaScript error occurred
in the main process" dialog at the user.

The path that produced it: the user closes a session → the PTY exits → the
renderer re-lays out the remaining terminals and emits one `terminal-resize` per
tile, including for the session that just went away.

`pty-ops.js` is the single place a session PTY is touched. It keeps the liveness
check as a cheap fast path but wraps the call, the way `trigger-watcher.js`
already reasoned about its writes ("an exit between the liveness probe and the
write is bounded by the try/catch on the write"). Callers get a boolean instead
of an exception; the first-resize nudge uses it to skip its follow-up when the
PTY is already gone.

`spawnPty` registers `guardPtyInputErrors` immediately on both spawn paths for
every PTY (sessions, shells, SSH attach clients). Asynchronous Windows
`_agent.inSocket` errors are logged at warn, falling back to debug, and absorbed;
absent internals and failing access or logging never throw (#517).
`test/pty-input-errors-conpty.test.js` checks the real node-pty input socket in
a Windows child process, including immediate listener registration and EPIPE.

A kill is once-only. With `useConptyDll`, node-pty's `kill` ends in
`ConptyClosePseudoConsole(hpc)`, and the native handle is only dropped when the
shell's exit thread runs; a second kill before that finds the handle still
registered and closes an already-freed pseudo console, a heap corruption
(0xc0000374) that kills the whole main process with no JS error. So `killPty`
closes a given pty once (a `WeakSet` of killed ptys), and `resizePty` /
`writePty` return false on a killed pty. `test/pty-ops-conpty-kill.test.js`
proves it against the real node-pty in a child process (Windows only): with the
guard removed the child dies with 3221226356.

node-pty 1.2.0-beta.15 (#409) adds a mutex around the handle table
(microsoft/node-pty#922). In 1.1.0 the shell's exit thread erases the pty's
entry, and frees it, without a lock, while the main thread may be inside
`PtyKill` or `PtyResize` holding a pointer to that entry, or walking the table
while the erase shifts it. The beta takes `g_ptyHandlesMutex` on both sides.
It does not make a second kill safe: `PtyKill` still leaves the handle
registered with its `hpc`, and `WindowsTerminal.kill` has no once-only guard.
Measured 2026-10-03 with the child above against the beta: two raw
`term.kill()` still exit 3221226356, two `killPty` exit 0. The guard stays.

The race itself was measured with a scratch stress script, not kept in the
suite (each run takes about a minute, and a pass proves nothing). One child
process per run, so a crash is an exit status: 20 iterations, each starting 4
`cmd.exe /c exit` ptys plus one long-lived pty, then 300 ms of resize calls
straight into the binding while the short shells exit, and in kill mode one
agent-level kill per short pty at a random moment in the first 150 ms.
Results, 2026-10-03, `useConptyDll`, plain node 24:

| Mode | 1.1.0 | 1.2.0-beta.15 |
| --- | --- | --- |
| kill | 5 of 8 runs died, 0xc0000005 | 0 of 8 died |
| resize | 0 of 3 died | 0 of 3 died |

One beta kill run completed its 20 iterations and then never exited (killed
after 600 s); not explained. The crash is not deterministic: it needs the exit
thread's erase to land inside the few instructions between the main thread's
lookup and its last use of the entry, and reading or writing freed memory only
crashes when the allocator has already reused or unmapped it. A kill holds
the pointer across `ClosePseudoConsole`, which can wait for OpenConsole, and then
writes to the entry; a resize holds it for one `ResizePseudoConsole` call.

### Cursor-position queries

The beta's bundled OpenConsole asks the terminal where its cursor is: a plain
DSR (`CSI 6n`). 1.1.0 sent none in the same runs. Measured 2026-10-03 on an
isolated pty under Electron 41 with `useConptyDll` (`cmd.exe`, then a raw-mode
node reader as the shell):

- With no resize, no query in 10 s.
- A resize within about the first 3 s of the pty brings one query about 3.3 to
  4 s after spawn. Unanswered, it is repeated about every 520 ms and dropped
  after 3 (`cmd.exe`) or 4 (node) queries. Answered, it is sent once. A resize
  at 4 s or later brought none, and a second resize no second series.
- OpenConsole keeps waiting after the last repeat: the first CPR that arrives
  later, even seconds later, is consumed. Every other CPR it receives, a reply
  it is not waiting for, is passed to the shell's application as typed input,
  verbatim (`ESC [ 24 ; 1 R` read by the child's stdin). 1.1.0 passes such a
  reply through the same way.

A visible session answers at once: xterm.js replies with a plain CPR
(`CSI row;col R`), which `composer-state.js` does not treat as a report (see
`.ai/contexts/trigger-watcher.md`, CPR), so the answer pushes the quiet clock
once.

A hidden single-view session cannot answer: its output goes to the hidden
accumulator, not to xterm. A session with no renderer attached cannot either.
Both replay paths drop DSR `CSI 6n`, private DECXCPR `CSI ?6n` and primary
device-attributes queries `CSI c` / `CSI 0c` instead of keeping them. They
share the matcher in `public/terminal-replay-queries.js`; see
[terminal-refresh.md](terminal-refresh.md), "Stale queries in hidden replay":

- `appendToHiddenAccumulator` / `replayHiddenBuffer` (`public/terminal-manager.js`)
  remove these queries from what they keep, including a query split across chunks
  and one left in the live write buffer when the session was hidden.
- `appendToOutputBuffer` (`output-buffer.js`), main's reattach buffer, removes them
  on the way in, a query split across several chunks included (the last
  four code units of the buffer are checked, across entries). That buffer also
  holds the queries a visible renderer already answered.

The filter is not specific to Windows or to OpenConsole: it runs on every
platform and removes these queries in a session's replay output, including one an
application asked itself (a shell's line editor measuring the cursor, for
example). Such an application gets its answer while its session is visible; a
query it sent while the session was hidden or detached goes unanswered, where
it used to be answered late, at reveal or reattach, with a stale position.

The removal is a single pass. Removing a query can join the bytes around it
into a new one (`ESC [ ESC [6n 6n` becomes `ESC [6n`); that one is kept, so
such input is replayed with one query. The earlier version repeated the pass
until no query was left: it removed bytes that are not a query (xterm.js shows
the trailing `6n` of that input as text) and was quadratic, and on a crafted
64 KB chunk the main-side version, which recursed, overflowed the stack.

Kept, each query would be answered by xterm.js at reveal or reattach: one reply
consumed by an OpenConsole still waiting, every other one typed into Claude or
the shell. Answering once at reveal instead was rejected: the reply would give
the cursor of a replay that happened after the output OpenConsole had already
moved on from, and nothing tells the renderer whether OpenConsole is still
waiting or a reply was already sent. Left unanswered, OpenConsole keeps its own
idea of the cursor, as it did on 1.1.0 where it never asked; the next query it
sends while the session is visible is answered live. Other terminal queries
in a replay (`CSI > c`, `CSI 10c`, `CSI > q`, OSC colour queries) and responses
(`CSI ?1;2c`, `CSI ?73;3R`) are not filtered.

Swallowed errors are not silent: `setPtyOpLogger(log)` in `main.js` routes them
to `log.debug` as `[pty] <op> skipped session=<id> reason=<message>`. Debug level
is deliberate — the file transport is at `info` in packaged builds, so a resize
storm against a dying PTY costs nothing in production, and the line is there in
dev when someone next has to diagnose this.

Not covered by `pty-ops.js`, on purpose: `trigger-watcher.js` writes (already
bounded by their callers' try/catch, plus a `process.kill(pid, 0)` liveness
probe) and the `clear` shim write in `open-terminal`, which happens before a
session object exists.

### Busy-state reconciliation

`cli-busy-state` is emitted **strictly on transitions** (`main.js` OSC 0 / OSC 9;4 handlers only send when `session._cliBusy` flips). A renderer that misses one — reload, mis-keyed id, a `session-forked` re-key — stays wrong forever, because no further event is coming. That is why `get-active-sessions` carries `busy`: `pollActiveSessions()` (3s while any PTY runs, 30s otherwise) hands the snapshot to `reconcileBusyState()` in `public/session-activity.js`, which realigns `sessionBusyState` and the sidebar classes.

> `session-detected` (tempId → realId) has a preload bridge and an `app.js` listener but **no emitter in main today** — `session-transitions.js` only sends `session-forked`. The `rekeyActivityState` call in `onSessionDetected` is therefore unreachable; it is kept so the handler stays correct if the channel comes back, not because it runs.

Three things make that safe:

- **The response-ready lock only blocks idle.** `setActivity(id, true)` always writes, and drops the session from `responseReadySessions` — a session that resumed generating has no unread answer left to announce. `setActivity(id, false)` on a response-ready session is still ignored, so an unread marker survives duplicate idle signals. Before that split, a session that finished a turn off-screen and restarted without a click (cron, trigger-watcher, resume) had *every* subsequent busy event swallowed.
- **`cli-busy` and `response-ready` are mutually exclusive.** `applyStateClasses()` (`public/session-activity-dom.js`) is the only writer of either class, and the exclusivity itself is the domain's own invariant (`public/session-state.js`'s `apply()`) — see `.ai/contexts/session-state.md` ("The local-pty adapter"). The state, not the cascade, is what decides.
- **A poll reply cannot overwrite a fresher event.** `setActivity` bumps a monotonic counter per session; the poll snapshots it via `currentActivitySeq()` *before* the IPC round-trip and `reconcileBusyState` skips any session that moved in between.

### The OSC 0 title is the primary busy channel

Two channels can raise `session._cliBusy`, and they are not interchangeable:

- **The OSC 0 title.** The CLI always sets it, so this is the channel that has
  to work. Classification lives in `classify-title-activity.js`.
- **OSC 9;4 progress.** Only emitted when the CLI's `terminalProgressBarEnabled`
  setting is on. It stays wired as a second opinion; it must never be the only
  one, because a user preference can switch it off and nothing would report it.

`classifyTitleActivity(title, { allowFallback })` looks at the first code point:

| First code point | Verdict | Rule name |
|---|---|---|
| `✳` U+2733 | idle | `idle-glyph` |
| U+2800–U+28FF (braille frames) | busy | `glyph` |
| U+25D0–U+25D3 (`◐◑◒◓`) | busy | `glyph` |
| any other non-ASCII, followed by a space and a non-empty title | busy | `fallback` |
| ASCII, or a bare non-ASCII word | no decision | `null` |

**The glyph list is coupling to a third party's private rendering choice, and it
has already broken once.** Until 2026-08-22 the busy test accepted braille only.
The CLI had moved to half-circle frames, so the title could *clear* the busy
state (`✳` still matched) but never *set* it, and the spinner survived only
because OSC 9;4 happened to be on. The activity trace
`~/.switchboard/activity-trace-20260822-181759.jsonl` is the evidence. Counted
over a fixed window — its first ten minutes, `wall` from `16:18:00Z` to
`16:28:00Z`, because the file keeps growing for as long as the variable stays
set and bare totals would not reproduce — it holds 628 `osc.title` entries: 312
starting U+25D0, 311 U+25D1, 3 `✳`, 2 bare `claude`, and no braille at all. 625
of them were logged `decision: "ignored:no-match"`. Both `busy.emit` lines with
`busy: true` in that window carry `via: "osc9.4"`. Not one busy transition came
from the title.

That is why the closed list has a net under it. The `fallback` rule assumes any
single non-ASCII code point used as a title prefix is a status indicator, which
is what a prefix in that position is for. Weighing the false positives:

- A word starting with an accent or a CJK character (`Éditeur de texte`) does not
  match — the rule needs the first code point to stand alone before a space.
- An emoji-prefixed title from a shell prompt or a task runner *would* match. The
  cost is bounded but real: only a `✳` title clears `_cliBusy`, so a wrong busy
  sticks until the CLI next reports idle — the next turn, for a Claude session.
  `main.js` passes `allowFallback: !session.isPlainTerminal`, so the generic rule
  never fires on a plain terminal in the first place.
- The alternative — a closed list with no net — fails silently and stays broken
  for as long as nobody notices the spinner missing. A stuck spinner is visible;
  a spinner that never lights is not.

**What that guard does not cover.** `allowFallback` gates the `fallback` rule
only; the `glyph` branch runs for every session. A plain terminal whose title
starts with a code point from the ranges above — braille, or one of `◐◑◒◓` — is
marked busy like any other, and since a plain terminal never emits `✳` nothing
on the title path clears it: the state survives until the PTY exits, at which
point `updateRunningIndicators()` in `public/app.js` drops `cli-busy` along with
`has-running-pty`. That is a decision, not an oversight — the ranges are narrow,
the *title* has to carry the glyph (a spinner printed to stdout is not a title),
and the braille half of the exposure predates this change. It is not free
either: U+25D0–U+25D3 is `circleHalves` from the `cli-spinners` package, which
other tools draw from, so widening the ranges widened this too.
`test/classify-title-activity.test.js` pins the behaviour, so whoever tightens
it later knows they are reversing a decision rather than fixing an omission.

To recheck after a CLI upgrade, run a session under `SWITCHBOARD_ACTIVITY_TRACE=1`
(see `docs/activity-trace.md`) and count where busy comes from:

```bash
grep '"cat":"osc.title"' ~/.switchboard/activity-trace-*.jsonl \
  | sed 's/.*"cp":"\([^ ]*\).*/\1/' | sort | uniq -c   # leading code points
grep '"cat":"busy.emit"' ~/.switchboard/activity-trace-*.jsonl \
  | grep '"busy":true' | sed 's/.*"via":"\([^"]*\)".*/\1/' | sort | uniq -c
```

Healthy output has busy emissions attributed to `osc0`, and the `rule` field on
`osc.title` lines reading `glyph` rather than `fallback`. `rule: "fallback"` on
every spinner frame means the CLI changed its glyphs again and the range table
should be extended; `ignored:no-match` on titles that clearly carry a prefix
means the fallback itself has regressed.

**The title says busy; it never says why.** While the CLI waits on background
agents it keeps animating the same spinner and never writes a `✳` title. Same
trace, session `6577a487`: busy at `16:18:51Z` via `osc9.4`, then ◐/◑ frames and
not one idle title for the rest of the ten-minute window — nine minutes in which
"generating" and "waiting for my agents" are the same signal. It does draw the
distinction in its own status line ("✻ Waiting for 1 background agent to
finish") and has a tri-state channel for it (OSC 21337, idle/busy/waiting), but
that channel is disabled in the shipped binary, so nothing reaches us. Switchboard therefore
does not claim the distinction: the sidebar tints the busy spinner violet when
subagents are live, which asserts only that both things are true at once — see
`docs/subagents.md`, "Live status".

### Activity trace: render-path counters

`render.stats` (renderer, `public/terminal-manager.js`) answers "is this
terminal's CPU legitimate": writes, batch size and glyph-atlas rebuilds per
session per second. It aggregates instead of tracing each write, because a
per-chunk line would itself be the load at 30 writes a second. The counters sit
in `renderStats`, created on the first event while `window.ATRACE` is true;
one `setTimeout` per window, armed by that first event, emits and clears them,
and drops them if the trace was switched off meanwhile. Nothing is armed while
the trace is off or the session is silent. `maxBatch*` is per write, not per
second; `atlasChanges` / `atlasCanvases` are the events that make
`loadTerminalWebgl` repaint every visible row. Test:
`test/terminal-render-stats.test.js`. It reports; it does not change the flush
cap or the WebGL policy.

### Activity trace: why the main process is the only writer

`activity-trace.js` + `public/activity-trace.js` + `public/activity-trace-panel.js`,
off by default. `SWITCHBOARD_ACTIVITY_TRACE` sets the state at startup; Settings
→ Diagnostics switches it at runtime and stores the choice. User-facing docs:
[docs/activity-trace.md](../../docs/activity-trace.md).

The indicators above are produced by two processes with two clocks, and the
bugs in them are **ordering** bugs — a front that was emitted but not received,
a poll reply that overwrote a fresher event, a fork that re-keyed halfway. Two
log files cannot be interleaved after the fact with any confidence, so the
trace has a single writer: the renderer sends probes fire-and-forget over
`activity-trace`, and main stamps the sequence number and both timestamps on
arrival. Renderer entries therefore carry their *arrival* time in main, which
is the correct trade — `seq` is the ordering, `t` is only for eyeballing gaps.

Why not `log.debug`: `main.js` sets the file transport to `info` when packaged,
so the existing OSC 0 debug lines never reach disk in a build the user runs —
which is exactly why the question "what code point does the CLI put in the
title" was unanswerable from a production log and had to be settled by reading
the CLI binary. The trace has its own file and its own level, so it is readable
from a packaged build, and it records the renderer half that `log` never saw.

Two constraints shaped the API:

- **The off path must allocate nothing.** The module exports its state as an
  object, `{ on }`, so probes are `if (TRACE.on) trace(...)` /
  `if (window.ATRACE) window.atrace(...)` — one property load, and the payload
  literal is never evaluated when the trace is off. An object rather than a
  boolean because the state is now switchable at runtime: a destructured
  `const { enabled: TRACE }` would freeze the flag at require time and pin
  every probe to the launch environment. The renderer probes go through
  `window.*` rather than bare globals so `session-activity.js` and
  `sidebar.js` stay loadable in the jsdom tests, which evaluate them without
  the trace file. This is the same discipline as
  [ADR 0002](../../docs/decisions/0002-discrete-steps-sidebar-animations.md):
  nothing that runs per render may do work.
- **The switch must not need a restart.** Restarting to arm a diagnostic
  destroys the state it was meant to observe, so `set-activity-trace-enabled`
  flips the module state, opens or flushes-and-closes the file, persists the
  choice into the `global` settings row, and pushes the new state to the
  renderer on `activity-trace-state`. The `activity-trace` handler is
  therefore registered unconditionally — a listener added on demand would not
  exist in the window that was created while the trace was off — and `trace()`
  drops the line itself while off.
- **The flag is parsed once.** `activity-trace.js` resolves
  `SWITCHBOARD_ACTIVITY_TRACE`; the preload is sandboxed and cannot require it,
  so main passes `--switchboard-activity-trace` via `additionalArguments` and
  the preload only checks `process.argv` for the *startup* value. Re-parsing
  the env var in the preload would let the two halves disagree silently — a
  trace file with no `src:"renderer"` lines and no error. The env var stays the
  startup path (it wins over the stored preference when set, in either
  direction) and nothing else reads it. Likewise the output directory is
  `path.dirname(DB_PATH)`, never a second derivation of the env var (`db.js`
  documents that anti-pattern where it exports `DB_PATH`).
- **The control channels are path-narrow.** `list-activity-trace-files`,
  `read-activity-trace-file` and `delete-activity-trace-file` accept only paths
  whose directory is the trace directory and whose basename matches the segment
  name pattern — an allowlist of exactly one directory, tighter than
  `isSensitivePath`, because the legitimate surface here is a single generated
  file family. Both the check (`resolveTraceFilePath`) and the capped read
  (`readTraceTail`) live in `activity-trace.js` rather than inline in the
  handler, for the same reason `fts-match.js` and `terminal-input.js` do:
  a handler body cannot be unit-tested without booting Electron, and these two
  carry the parts worth testing — a non-string path must answer `null` rather
  than throw (a rejected invoke leaves the button dead with no message), and a
  file that shrinks between the `stat` and the `read` must not come back as
  megabytes of NUL presented as trace content. Deleting the segment currently
  being written is refused rather than attempted; `currentFile` follows the
  stream, so switching debug mode off releases it immediately.
- **The probes must stay one line each.** The interesting sites live in files
  that other branches touch (`session-transitions.js`, `public/sidebar.js`),
  so every probe is a single inserted statement and all the logic —
  formatting, code-point rendering, the decision helpers that mirror the OSC
  branches — lives in the trace module where it is unit-tested.

Subagent probes follow the detector's own vocabulary rather than the IPC's: a
transcript first seen already stale produces `subagent.assumed-finished` and no
event at all, and if that assumption is later retracted inside the recheck
window the withheld spawn shows up as `subagent.rehabilitated`. Both are silent
in every other channel — see `.ai/contexts/subagent-observability.md` for the
mechanism they instrument. On the renderer side `recv.subagent-spawned` carries
`applied`, because a heartbeat for an agent the sidebar is not tracking is
dropped on purpose and that non-effect is the diagnostic.

`busyDecision` / `progressDecision` duplicate the conditions in `main.js` on
purpose: the trace also records the emissions themselves, so a divergence
between the predicted verdict and the `busy.emit` that follows shows up in the
file instead of being invisible.

`setActivity(sessionId, active, via)` — the third argument is trace-only
attribution (which caller asked for the write) and is inert when the trace is
off.

## Clean child environment

`scrubSessionEnv()` (`clean-env.js`) removes inherited Claude session markers from `process.env` in `main.js` before the reloader, updater and services start. This also covers children with no explicit `env`: SSH/scp and any ProxyCommand they launch, Git hooks, shell discovery and electron-updater's installer/elevation/relaunch paths. It changes only session markers; Electron's own process still needs its runtime variables. The standalone `scripts/postinstall.js` applies the same scrub before its build-tool shells, and `scripts/test-pr.js` scrubs a copy of its launch environment.

`cleanEnv()` calls the same helper on a copy to build `cleanPtyEnv`, the base for local Claude PTYs (new, resume, fork, sandbox, background attach), plain terminals, panel shells, scheduled runs and background CLI commands (dispatch, respawn and management). It additionally drops Electron internals (`ELECTRON_*`, `NODE_OPTIONS`, `GOOGLE_API_KEY*`, `ORIGINAL_XDG_CURRENT_DESKTOP`, `WT_SESSION`). When none of `LC_ALL`, `LC_CTYPE` or `LANG` is nonempty, it sets `LC_CTYPE=UTF-8` on macOS or `C.UTF-8` on Linux; Windows receives no default. An explicit locale, including `C`, wins.

The remote attach PTY and the systemd relaunch use `cleanEnv(env, { locale: false })`: SSH must not forward a synthesized macOS locale to Linux through `SendEnv LC_*`, and relaunch must not persist that default in the next application's environment. SSH/scp transports inherit `process.env`, which receives no synthesized locale. Git changes builds its own environment with `LC_ALL=C`, unchanged. Shell startup for plain terminals remains owned by `plainTerminalLaunch()`; the default locale is already present in its input environment.

The deny rule is exact membership in `SESSION_MARKERS`, compared case-insensitively to cover Windows environment aliases. There is no `CLAUDE_*` or `CLAUDE_CODE_*` prefix deny rule and no configuration allowlist: every name outside that set survives the session scrub. `cleanEnv()` does not mutate its input; the startup scrub deliberately removes only the inherited markers from the app's own environment.

| Stripped | Why |
|---|---|
| `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` | say "running inside a Claude Code session" and how it was started |
| `CLAUDE_CODE_SSE_PORT` | the parent's IDE link; Switchboard sets its own after cleaning when IDE Emulation is on |
| `CLAUDE_CODE_CHILD_SESSION` | makes the CLI save no transcript |
| `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` | identify the parent session |
| `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` | the parent's messaging channel |
| `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_SESSION_ATTENDED` | the parent's bridge session and attended state |
| `CLAUDE_CODE_EXECPATH` | the parent CLI's own executable path |
| `CLAUDE_JOB_DIR`, `AI_AGENT`, `CLAUDE_EFFORT` | the CLI derives the session's short id from `CLAUDE_JOB_DIR`; `AI_AGENT` marks a process as run by an agent; the CLI writes `CLAUDE_EFFORT` for hooks/Bash and never reads it |
| `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_REMOTE_SESSION_ID` | the launching cloud session's runtime context and transcript identity |
| `CLAUDE_ENV_FILE`, `CLAUDE_PROJECT_DIR` | the launching session's persisted shell environment and hook project context |
| `TRACEPARENT`, `TRACESTATE` | the launching session's trace context; with tracing enabled, the CLI sets `TRACEPARENT` on Bash children and a child Claude session would attach its telemetry spans to that trace |

Kept: `CLAUDE_CONFIG_DIR`, `ANTHROPIC_*` authentication/base URLs, `CLAUDE_CODE_USE_*`, `DISABLE_*`, proxy variables, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_EFFORT_LEVEL` (the documented user setting, distinct from `CLAUDE_EFFORT`), `CLAUDE_CODE_TASK_LIST_ID` (an explicitly shared task list) and every other non-denied configuration variable. The [official CLI environment reference](https://code.claude.com/docs/en/env-vars), checked for #670, documents the bridge/cloud IDs, child marker, job directory, PID and persisted environment file; private markers are also retained in the explicit deny set from the observed incident.

`GIT_EDITOR=true`, set by the CLI on its Bash children, is deliberately not scrubbed because a user may set it (#673).

What Switchboard sets *after* cleaning stays: the plain terminal's `CLAUDECODE=1` (`open-terminal`, `isPlainTerminal` branch, present since the project's first commit, not tied to the `claude` shim) and `CLAUDE_CODE_SSE_PORT` of a session with IDE Emulation. A new marker the CLI starts setting is added to `SESSION_MARKERS`; `test/clean-pty-env.test.js` lists them one by one.

`test/child-session-env.test.js` sets markers in real `process.env`, evaluates the shipped main-process startup and launch handlers with the process/PTY boundary intercepted, and inspects each resulting child environment. A real Node child verifies implicit inheritance without launching Electron, Claude or an installer. The script launchers are exercised without starting their external tools. This tests the spawn boundary; it does not qualify CLI metadata writes or remote host startup files. A user shell profile that explicitly exports session markers again after startup is outside this inherited-environment fix.

## If you change this, also check

- **Three places per new IPC**: handler in `main.js`, bridge entry in `preload.js`, caller in `public/*.js` (and maybe `eslint.config.js` if you expose a new global).
- `eslint.config.js` `rendererCrossFileGlobals` — renderer functions exposed across `<script>` tags must be declared
- Any new event needs both an `ipcRenderer.on` in preload and an `mainWindow.webContents.send` in main
- If you change argument shapes, the renderer callers break silently (no type check) — search for callers before changing signatures

## How to add a new IPC

1. `main.js`: `ipcMain.handle('my-thing', (_event, arg1, arg2) => { /* validate, do, return */ })` — place near related handlers, not at random.
2. `preload.js`: `myThing: (arg1, arg2) => ipcRenderer.invoke('my-thing', arg1, arg2)` — add to the alphabetical-ish block.
3. Renderer: `const result = await window.api.myThing(...)`
4. Test: prefer a unit test for the main-side logic (extract to a pure function the handler calls); jsdom integration tests for renderer side.
5. Document here.

### Conversation continuations (#518B)

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `session-continuations` | `(sessionId)` | `{candidates:[{sessionId,modified}],unresolved,continued}` | Bounded traversal of the transcript continuation index; exposed as `api.getSessionContinuations`. Restore and manual resume share the renderer resolver. See cli-session-state.md, Conversation continuations. |

## Projects conflicts and projection diagnostics (#719)

On terminal PROJECTS_SNAPSHOT_CONFLICT, get-projects schedules the existing
throttled projects-changed notification with cause conflict, then returns only
{projectsError:{code:'PROJECTS_SNAPSHOT_CONFLICT',message:'Projects changed while loading; reload to retry.'}}.
Preload recognizes that exact envelope and reconstructs a coded Error. Ordinary
errors still reject; boolean arrays and the paired defaultProjects/allProjects
reply retain their successful shapes, with compact provenance on the paired
reply. Rejected worker results never reach placeholder/archive/attach assembly.

session-projection-changed is a narrow preload send. Main requires its own
window's webContents and main frame, validates allowlisted typed fields and logs
newline-free JSON as data at info level. It carries opaque scope/root identity,
accepted build/generation/roster revisions and deciding inputs. It accepts no
raw prompts, names, CLI strings, paths, sockets, keys or liveVersion. Lists are
capped at 128 with complete counts/truncation flags; oversized legitimate records
compact before transport and remain below 64 KiB after main's timestamp. Invalid
records or transport failures cannot break publication.
