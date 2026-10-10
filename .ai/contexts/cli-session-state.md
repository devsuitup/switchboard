# Context: cli-session-state

**Purpose**: turn the Claude CLI's own "I just went idle" moment into an
immediate subagent rescan, so a subagent that finished right before its parent's
turn ended is marked complete in seconds instead of waiting for the next
stabilisation tick.

**Files**: `cli-session-state.js`, wired in `main.js` (three call sites, plus
the `session-live-elsewhere` and `sessions-live-elsewhere` IPCs),
`public/resume-guard.js`, `test/cli-session-state.test.js`,
`test/canary-cli-session-state.test.js`,
`test/cli-session-live-elsewhere.test.js`, `test/cli-session-process-table.test.js`,
`test/resume-guard.test.js`,
`test/restore-live-elsewhere.test.js`.

The module has a second, unrelated consumer: the resume guard described under
"Live elsewhere" below.

## Why it exists

`detectSubagentTransitions()` owns the stability clock that decides a subagent
is finished (see [subagent-observability](subagent-observability.md)). Before
PR #153 that function only ran from the debounced `fs.watch(PROJECTS_DIR)`
flush — and a function driven by file changes cannot notice that a file
*stopped* changing. Measured 2026-08-23: a completion emitted 10 min 37 s after
the last write, because the folder had gone silent.

PR #153 fixed the scheduling defect with a self-arming 5 s settle tick plus
renderer-side TTL nets. **That is the fix; this module is not.** What is added
here is a *sooner and more precise trigger* for the same scan: the residual
lateness after #153 is up to one tick (5 s) plus the remainder of the stability
window, and the CLI publishes an idle edge that lands well before the next tick
would. It is an optimisation on top of a working mechanism, and everything it
does is also done, later, by the tick.

## The external file we read

`~/.claude/sessions/<pid>.json`, written by the Claude CLI itself. Observed
shape (CLI 2.1.241, Windows, 2026-08-23):

```json
{"pid":18176,"sessionId":"6577a487-…","cwd":"C:\\Serveur\\switchboard",
 "startedAt":1787520942563,"procStart":"134319945380279381","version":"2.1.241",
 "kind":"interactive","entrypoint":"cli","name":"switchboard-main",
 "status":"busy","statusUpdatedAt":1787527436145,"updatedAt":1787527436145}
```

**This is not a documented interface.** Nothing obliges the CLI to keep it, keep
its field names, or keep its status vocabulary. Every use of it here is
therefore best-effort, and its absence or corruption must be a no-op — see
"Failure is silence" below. `test/canary-cli-session-state.test.js` exists
precisely so a CLI-side change reads as a CLI-side change.

Facts established by measurement, not by documentation:

- `status ∈ {busy, idle, waiting, shell}`.
- It is written **on change, not as a heartbeat** — hence `statusUpdatedAt`, and
  hence the liveness guards below. A killed CLI leaves its last status engraved
  in the file forever.
- Sampling 295 times at 2 s over 10 min with 2–3 subagents writing, `status`
  stayed `busy` throughout, with no false dip. The parent is `busy` while any
  delegated agent runs (`delegatedActive` in the CLI's own status computation).
- **`waiting` (read from the CLI bundle, 2.1.286; still not observed live)**:
  the status computation returns `waiting` whenever a blocking dialog is open,
  ahead of `busy`; the prompt at rest is `idle`, never `waiting`. A
  `waitingFor` string is written beside it (`permission prompt`,
  `input needed`, `dialog open`, `goal proposal`, `worker request`,
  `sandbox request`), and `statusUpdatedAt` is rewritten on each status write.
  No permission dialog occurred during the 295-sample measurement above, so no
  live descriptor was captured during a dialog. A remote row lights the
  attention state from it (see session-state.md, "Descriptor-owned attention");
  the remote index keeps `waitingFor` only as a trimmed string of at most 64
  characters without control characters, and drops anything else.

The `busy` glyph in the terminal title was considered instead and rejected: it
conflates idle, waiting and shell. The state file distinguishes them, which is
why it is preferred here.

## The one invariant

**The idle signal is a trigger, never a verdict.** It calls
`detectSubagentTransitions()` earlier; it never marks anything complete and
never emits `subagent-completed`. The stability clock inside that function
remains the sole judge of what has finished. Grepping `cli-session-state.js`
for any `subagent-` channel must return nothing — if it ever does, the change
has crossed the line this module was built to respect.

The reason is the falsified converse: parent-idle does **not** imply
no-subagent-running in general (the title glyph proved that), and even a correct
idle would say nothing about *which* child finished. Only mtime stability
carries that.

## Guards

**Process liveness.** Because `status` is written on change, a stale file can
say `busy` — or `idle` — indefinitely. Before any rescan the pid is probed with
`process.kill(pid, 0)` (`EPERM` counts as alive).

**PID reuse.** The file is named by pid alone, so a second CLI can inherit the
name. `procStart` is recorded per file; when it changes, the entry is reset as a
new process and the status change that came with it is *not* read as a
transition. This is the guard that actually matters — the liveness probe is a
cheap sanity check for a file mutated by anything other than a live CLI.

**First sighting never triggers.** A status is only a transition against a
previously recorded one for the same `procStart`. At attach time the directory
is seeded once so the first real transition after startup still fires — but the
seed is skipped entirely when the directory holds more than `MAX_SEEDED_FILES`
(200) state files, to bound startup cost. Past that threshold every session
loses its first transition, not merely the ones over the cap, and the settle
tick is the only net left. Benign by construction: the cost is a late rescan,
never a wrong verdict.

**Per-session throttle.** At most one rescan per second per session.

## Matching a state file to a Switchboard session

By `sessionId` only, against `session.realSessionId || <map key>` over
`activeSessions`, skipping `exited`, `isPlainTerminal`, and sessions with no
`projectFolder`. `realSessionId` is what makes forked and resumed sessions work:
after a fork the CLI writes the new id while `activeSessions` is still keyed by
the old one, and it is also the id the subagent directory is named after, so it
is the id the rescan must be given.

The file's `cwd` is deliberately **not** used as a fallback: several sessions
can share a working directory, so it cannot disambiguate.

**When matching fails, nothing happens** (one debug log line). That covers a CLI
the user started outside Switchboard, and the window between a fork being
written by the CLI and being detected by `detectSessionTransitions`. The settle
tick covers the session either way.

## Cost at idle

Zero polling. One `fs.watch` on a directory that holds a handful of tiny files,
with a 150 ms debounce; events only occur when a CLI changes state. No timer is
armed while the module is idle. This is the constraint from
[ADR 0002](../../docs/decisions/0002-discrete-steps-sidebar-animations.md) —
steady-state cost is the thing the repo has repeatedly paid to remove.

If `~/.claude/sessions/` does not exist there is **no** retry timer and no
fallback poll: `ensureWatching()` is simply called again the next time a Claude
PTY is spawned, plus once 15 s after such a spawn while still unattached. That
covers the machine where the directory only appears with the first CLI run.

## Failure is silence

Missing directory, unreadable file, truncated JSON caught mid-write, missing
fields, unknown status: every one of these results in doing nothing, never in a
throw. The CLI does not write this file atomically. Degrading to "the tick
handles it" is always an acceptable outcome, which is what makes depending on an
undocumented file defensible at all.

## Surfacing status on the session object (issue #245)

`getStatus(sessionId)` is a pure `Map` lookup over the `{status,
statusUpdatedAt}` pairs `seed()`/`handleFile()` already parse for every state
file they see — it adds no disk read, no watcher, and never calls `onIdle`, so
it does not touch the one invariant above. `main.js`'s `annotateRemoteAttachable`
calls it for every session without a `remoteAlias`, writing the result to the
same `session.status` / `session.statusUpdatedAt` pair a remote session gets
from its host's mirrored descriptor — one field pair, one renderer code path
(`public/sidebar.js`), for both a local and a remote session. The renderer
(`public/sidebar.js`, the state+age line built from `session.status` /
`session.statusUpdatedAt`) treats both sources identically and renders
regardless of `session.remoteAlias` — see also `.ai/contexts/session-cache.md`
("Remote hosts — freshness contract") for the remote half of that contract.

The backing `statusBySession` map (kept alongside `known`, filename-keyed)
holds an entry **only while `isProcessAlive(state.pid)` is true** — a
descriptor a crashed or killed CLI left behind (the CLI only deletes its file
on a clean exit) must not surface as a permanently "live" status on a closed
session. Both `seed()` and `handleFile()` apply this gate before writing to
`statusBySession`; `handleFile()` also deletes the entry outright once the
liveness check fails, same as it does when the file itself disappears.

**That gate only runs on a file event — a CLI killed without a clean exit
writes no such event, so its last status stayed cached forever until this app
restarted (F2, audit-fable-2026-09-11).** `getStatus(sessionId)` now keeps the
`pid` alongside the cached `{status, statusUpdatedAt}` and re-probes
`isProcessAlive(pid)` itself, lazily, throttled to once per
`GET_STATUS_PROBE_THROTTLE_MS` (5 s) per sessionId (`now()` is injected so
tests use a fake clock instead of real delays) — a dead pid deletes the entry
and the call returns `undefined`, same as a file event would have done. This
still never touches disk and never arms `onIdle` — "the one invariant" above
is unchanged, it is a read-path liveness check, not a new trigger.

## Live elsewhere (issue #331)

A resume spawns `claude --resume <id>`. When another process is already running
that session — a second Switchboard instance reading the same
`~/.claude/projects`, or a CLI in a terminal — that makes two CLIs on one
session, both writing its transcript, and input meant for this instance lands
in a session the user is driving elsewhere.

Session ids are matched lowercased, `getStatus` included, and `liveElsewhereMany` answers under the
ids it was asked. `liveElsewhereChecked` returns `{known, live}` or `{known:
false, reason}` when the directory or a descriptor cannot be read (a missing
directory is known-empty); `delete-session` uses it to fail closed.
The Agents verb IPC uses the same checked helper with
`{includeOwnProcesses: true}`: it skips neither an existing PTY nor a process
this instance started. These exclusions are appropriate for a resume, but a
job's conversation cannot be respawned/deleted while any process holds it.
The default checked-helper behavior for the sidebar remains unchanged.

**The check** is main-side, on demand, over IPC `session-live-elsewhere`:
`liveElsewhere(sessionId, sessionHasPty, ptyPids)` returns `{pid, cwd,
startedAt}` or `null`. A working-set restore asks for its whole batch at once
over `sessions-live-elsewhere`: `liveElsewhereMany(ids, sessionHasPty,
ptyPids)` reads the directory once and returns `{[id]: {pid, cwd, startedAt}}`
for the ids that are live, looking up at most `MAX_LIVE_QUERY_IDS` (200) ids;
ids past the cap are not looked up and resume as before the guard.

- A session this instance holds a PTY for (`sessionHasPty`, which matches
  `realSessionId` too) is never live elsewhere: opening it is a re-attach, the
  case a renderer reload relies on.
- A CLI under the PTY registered for **that conversation** is never live elsewhere
  either, even while `sessionHasPty` misses it: the checks call `ptyPids(id)` (main
  passes `makePtyPids(activeSessions)`, which returns only the PTYs whose
  `realSessionId || key` is that id) and exclude a descriptor that is one of those
  pids or whose parent chain reaches one. A CLI started by hand in a panel shell or
  a plain-terminal tab, a scheduled child, and any other descendant of this main
  process are **not** excluded: nothing can re-attach to them under that
  conversation id, so they stay live. The chain is read from `/proc/<pid>/stat` on
  Linux and from a process snapshot elsewhere (next section). A PTY still keyed by a
  pending id (a fork before `realSessionId` is known) is therefore reported live
  elsewhere for that short window, on every platform: the guard fails closed.
- `liveElsewhereChecked` answers a tracked scheduled run exactly like
  `liveElsewhere` (`kind: 'schedule'`, known), so the delete guard refuses it. Its
  4th argument `{ includeOwnProcesses }` bypasses the `hasPty` short-circuit and the
  exclusion.
- Otherwise `findLiveProcess(sessionId)` reads `~/.claude/sessions/*.json`
  afresh — it does not use the watcher's maps, so it answers before the watcher
  attaches and past the `MAX_SEEDED_FILES` seed cap — and returns the first file
  whose `sessionId` matches, whose `pid` is alive (`process.kill(pid, 0)`), and
  whose `procStart` matches the process that owns that pid now.
- **`procStart` is the creation time of the process that wrote the file**, and
  a mismatch with the process that owns the pid now means the pid was reused and
  the file is stale. Both forms were checked against real descriptors (CLI
  2.1.278 on Windows, CLI 2.1.284 on Linux):
  - Linux: field 22 of `/proc/<pid>/stat` (clock ticks since boot), read
    synchronously as before.
  - Windows: a **FILETIME** (100 ns ticks since 1601-01-01 UTC) of the process
    creation. Measured 2026-09-29 on two live descriptors (`procStart`
    134350561856777853 and 134351483470939507): each equals, digit for digit,
    `(Get-Process -Id <pid>).StartTime.ToFileTimeUtc()`. It runs 2-5 s before
    the descriptor's `startedAt` (the CLI starts, then writes).
  - `pidDomain: "win32:anchor"`, present on those Windows descriptors, means
    `pid` is the pid of the process that owns the descriptor and the one
    `procStart` describes: on both, the process at that pid was `claude`, its
    creation time equalled `procStart`, and its parent was another process
    (the shell), so it is not a launcher pid. Any other `win32:*` domain, or a
    `procStart` that is not 17-19 digits there, is not compared.
- **Windows has no cheap way to read another process's creation time from
  Node**, so `scanLiveProcesses` is async and makes one probe per scan batch,
  never per descriptor: it collects the candidates first (session id asked for,
  pid alive, not this instance's own), then asks `readProcStartMany(pids)`
  once for all of them. The default probe on Windows is one
  `powershell.exe -NoProfile` running `Get-Process -Id <pids>`, bounded by
  `PROBE_TIMEOUT_MS` (5 s) and, on Windows only, `MAX_PROBE_PIDS` (64 pids per
  batch; candidates beyond that are not probed and stay live). Linux reads
  `/proc` per candidate, spawns nothing, and compares every candidate. About
  0.7 s measured on a cold call, paid only when at least one candidate carries
  a comparable `procStart`. The timeout is 5 s because the case that matters is
  the post-login restore, where a cold PowerShell runs under login load; a
  timeout fails closed (the sessions stay live, not resumed), so a longer bound
  costs only a later answer in that rare case. A cold PowerShell on a
  windows-2022 CI runner has run past 5 s, so the test that probes a real
  process passes its own 30 s bound instead. A cold PowerShell that takes more
  than 5 s after login silently skips the reused-pid check for that restore:
  `scanLiveProcesses` swallows the rejection without a log line, and a session
  whose descriptor pid was reused reads as live elsewhere and is not resumed.
  How often a workstation hits this has not been measured. Descriptors are read in name
  order, so when two files name one session the first wins, the same on every
  platform. The IPC
  handlers are `ipcMain.handle`, so they simply return the promise.
- **Undecidable stays live.** A probe that fails, times out, does not report a
  pid (process gone, access denied), a missing `procStart`, an unrecognised
  `pidDomain` or format, and every platform without a probe (macOS) all read as
  "live": the automatic resume is skipped, never made. Only a decided mismatch
  clears the file.
  On Windows only `pidDomain === "win32:anchor"` with a string `procStart` of
  17-19 digits is compared (a JSON number past 2^53 has already lost digits; a
  descriptor without `pidDomain` is not known to carry a FILETIME). The probe
  keeps the lines PowerShell printed when it exits non-zero (a candidate that died
  after the liveness check makes it exit 1) and rejects only on timeout or a
  spawn error. **Not closed:** a pid reused by an elevated or system process
  yields no `StartTime` (measured: pid 4 prints no line), so it stays live.
- `status` is not required: any live process holding the session counts.

**The decision** is in `public/resume-guard.js` (`guardResume`), called by
`openSession` before `open-terminal`:

Scheduled children this instance starts are registered by `trackScheduleRun`
until `exit` or `error`. The single and batch resume queries return their
`kind: 'schedule'` entry even without a CLI descriptor, before excluding this
instance's child processes. A manual open shows a wait dialog and is always
refused, regardless of the dialog's answer; automatic opens are skipped.
See [schedule-runner.md](schedule-runner.md#opening-a-running-scheduled-session-484).

| Resume | Live elsewhere | Result |
|---|---|---|
| automatic — the reload path (`sessionStorage.activeSessionId`) and `runRestore` | yes | not opened, no prompt; from `runRestore`, a one-line notice |
| asked for by the user (sidebar click, resume dialog, transcript viewer) | yes, scheduled run | wait dialog; always refused, even if accepted |
| asked for by the user (sidebar click, resume dialog, transcript viewer) | yes, other live session | `confirm()`; cancel aborts, OK spawns the second CLI |
| any | no | spawns as before |

Plain terminals are never checked.

**An IPC failure fails open.** A rejected `session-live-elsewhere` or
`sessions-live-elsewhere` call is read as "not live", so the automatic resume
proceeds exactly as it did before the guard existed, in line with "Failure is
silence" above.

**A skipped entry is kept, not forgotten.** `persistWorkingSet()` rebuilds the
saved set from `openSessions`, which a skipped session is not in. `runRestore`
therefore records each skipped entry in `skippedWorkingSetEntries` with its
index in the saved set, and `persistWorkingSet()` splices those back in at that
index (clamped, `active: false`), so the next restart tries it again. The entry
leaves that map once `openSession` opens the session — after that it is an open
session like any other, and closing it drops it from the set. The skip is
reported by `showLiveElsewhereNotice` as one line in the restore toast style
(`Not reopened: <name> is live in pid N`, or a count and the pids), dismissible
and removed after 15 s.

**The batch is read once, before the first spawn, on purpose.** A CLI started
elsewhere on one of the batch's sessions during the restore stagger (500 ms per
session) is not seen; that session is resumed as before the guard. A re-check
before each automatic open was weighed and not added: a fresh scan per open is
a PowerShell probe on Windows (about 0.7 s, more than the stagger it would sit
in), and skipping the probe would bring back the reused-pid false positive this
section closes; the window is the few seconds of a restore, the miss costs one
second CLI on a session another process started at that moment, exactly what a
manual open of a non-scheduled session does after its confirm.

The sidebar has no dedicated marker for such a session. Once the watcher has
seen its state file, `getStatus()` gives it the same state+age line as any live
session (see the section above).

## Own descendants outside Linux (issue #521)

Without `/proc`, only the PTY pids themselves used to be recognised, so on
Windows the CLI of a Switchboard tab (measured: `Switchboard.exe` -> `bash.exe`
(the PTY pid) -> `bash` -> `sh` -> `claude.exe`, three levels under the PTY
pid) read as another process: an External row in the Agents view and a
live-elsewhere verdict. The parent chain now comes from one process snapshot.

Two rules share that snapshot and must not be confused:

- **Roster visibility** (`ownProcessFilter`, the External label): broad. A pid is
  own when its chain reaches this main process or any PTY pid of this instance
  (conversation tabs, panel shells, plain terminals).
- **Safety guards** (`liveElsewhere*`, the delete guard, the continuation lookup):
  narrow, as described under "Live elsewhere". Only a descriptor under the PTY of
  the asked conversation is own, and on Windows that must be proven by identity
  (below).

- **Reader.** `probeProcessTable(platform)` runs one process, bounded by
  `PROBE_TIMEOUT_MS` (5 s): on Windows `powershell.exe -NoProfile` over
  `Get-CimInstance Win32_Process` printing `<pid> <ppid>` lines (about 0.7-1.4 s
  cold, 340 processes, measured 2026-10-10) with the process's `CreationDate` as a
  FILETIME (within 5 ticks of `Get-Process`'s `StartTime.ToFileTimeUtc()`, the descriptor's
  value: CIM keeps microseconds; measured 2026-10-10); on macOS `/bin/ps -A -o pid=,ppid=,lstart=` (seconds
  resolution, same parser, not exercised on a Mac); nothing on Linux, which keeps reading
  `/proc`. `wmic` is not a fallback: recent Windows 11 no longer ships it (absent
  on the measured machine). Tests inject `readProcessTable`.
- **Never synchronous.** The snapshot is always asynchronous. A chain walk is
  synchronous and reads only the cached snapshot (`defaultReadParentPid`); with no
  snapshot yet, or a failed one, it behaves as before (PTY pids only). An injected
  `readParentPid` disables the snapshot entirely.
- **Cache.** `PROCESS_TABLE_TTL_MS` (3 s). Concurrent callers share the one in-flight
  read; a failed or empty read is cached for the same window as "unknown", so a
  broken PowerShell is not respawned per check. `init()` drops the cache.
- **Async paths** (`liveElsewhere`, `liveElsewhereChecked`, `liveElsewhereMany`):
  `scanLiveProcessesChecked` awaits the snapshot once, and only when a live
  descriptor of an asked session belongs to a conversation that has a PTY
  (`exclude.needsProcessTable`), then applies the filter. Nothing is spawned
  otherwise.
- **Identity, for the guards.** Pid numbers are not identities. A guard treats a
  descriptor as own only when: the table holds its pid with a creation time within
  `PROC_START_TOLERANCE` (100 ticks, 10 us) of the descriptor's `procStart` (`pidDomain: "win32:anchor"` FILETIME); every link up
  to the conversation's PTY pid has known creation times; and no child is older than
  its parent (a reused pid number is always newer than the children it orphaned).
  An unknown time, a missing row, a descriptor without a comparable `procStart` or a
  failed snapshot all keep the writer **visible** (live). On macOS the descriptor's
  `procStart` is not comparable to `lstart`, so the guards never take the narrow own
  path there; on Linux `/proc` is read live and the existing `procStart` check applies.
  The roster applies only the child-not-older-than-parent test, and only when both
  times are known.
- **Sync path** (`ownProcessFilter`, used by the Agents view's `rebuild()`): building
  the filter starts a snapshot when the cache is stale, without waiting for it, and
  calls the descriptor listeners when it lands (the notification comes from the shared
  refresh itself, so a snapshot started by an async check notifies too); the view's
  `rebuild({onlyIfChanged})` then drops the row. The first roster after startup can therefore show an own
  session as External for the length of one snapshot. A CLI started inside the
  3 s window is not in the cached snapshot and stays External until the next
  roster rebuild after the window (the view's 30 s re-read at the latest).
- A chain stops as own at the first ancestor that is a PTY pid (and, for the roster,
  the main process). Windows reports a parent pid that can name a dead process whose
  pid was reused; the creation-order test above rejects that chain.

## Descriptor hooks for the agents view

The Agents view (`.ai/contexts/bg-agents.md`) reads the same
`~/.claude/sessions/<pid>.json` files through three additions:

- `onDescriptorsChanged(listener)` fires once per flushed batch of descriptor
  changes and returns an unsubscribe function. A throwing listener is logged
  and does not stop the others.
- `readAllDescriptors()` returns the parsed descriptors whose pid is alive,
  capped at `MAX_DESCRIPTOR_SCAN` files; `kind` (`'bg'` or `'interactive'`) and
  `jobId` are part of the parsed shape.
- The results of `liveElsewhere` / `liveElsewhereMany` carry `kind` and
  `jobId`, so `guardResume` can answer a `kind: 'bg'` session with an attach
  instead of a resume confirmation.

## Owner of a /clear transcript

`/clear` does not continue the open transcript: the CLI opens a **new jsonl
under a new session id** in the same project folder, and writes into it only
the bookkeeping of the command (a `<local-command-caveat>` record, then the
`<command-name>/clear</command-name>` record). Nothing in that file names the
session it replaced — no `forkedFrom`, and the `sessionId` on every record is
the new one. `detectSessionTransitions()` (`session-transitions.js`) used to
match new files by those two fields only, so after a `/clear` the open
terminal stayed on the old row and the new conversation, once its first prompt
made it indexable, showed up as a second, unattached row.

The state file is what links the two: the CLI rewrites
`~/.claude/sessions/<pid>.json` with the new `sessionId` on `/clear` (checked
2026-10-05 on CLI 2.1.28x: live state files whose `sessionId` names a
transcript that starts with the `/clear` record). `clearOwner(newId, ptyPid)`
finds the live pid whose state file names `newId` and walks its parent chain
(`/proc/<pid>/stat`) up to the PTY's pid. Verdicts:

- `mine` — the CLI runs under this PTY: re-key, exactly like a fork
  (`session-forked` to the renderer).
- `other` — another process (a CLI started outside Switchboard, another tab in
  the same folder): not this session's file.
- `pending` — no live state file names `newId` yet (the jsonl can land before
  the state file is rewritten): the file stays out of `knownJsonlFiles`, and
  `scheduleRecheck` runs the folder's detection again a second later, while
  the file is less than 60 s old. Nothing else would: the state file is not in
  the watched folder, and the transcript gets no other write before the first
  prompt. A new file whose first records are not written yet is rechecked the
  same way.
- `unknown` — the pid is found but its parent cannot be read. Never matched,
  not even when this is the only Claude PTY in the folder: a `claude` run
  outside the app in the same folder would be taken over. The file is recorded
  and not rechecked.

On Windows and macOS there is no `/proc`; `clearOwner` uses the process table
of "Own descendants outside Linux" instead and gives the same answer as
`conversationOwns`: `mine` only when the descriptor's pid is the writer the
table names (`pidDomain: 'win32:anchor'`, `procStart`) and its chain reaches
the PTY's pid with creation times that only go back in time. A pid the table
does not list yet is `pending` (the table refreshes in the background, and the
recheck asks again). The CLI on macOS writes no anchor, so there a `/clear` is
`other` and never followed: the new conversation is listed apart, as before;
the follow-up for #518 may re-key it from the descriptor's `sessionId`.

Re-keying keeps `oldId → newId` (`currentSessionId`), so a trigger chain that
sent `/clear` reaches the same terminal on its next step (see
trigger-watcher.md, "Re-keyed sessions"). On each re-key every older id that
pointed at `oldId` is moved to `newId`, so any id the session ever had resolves
in one lookup, however many times it was cleared. An id that a live session
holds itself is never redirected: reopening the cleared conversation starts a
terminal under the old id, and from then on that id is its own (the alias is
dropped). An alias whose target is gone or exited is dropped too.

**A file with no turn yet.** The CLI writes a `/clear` transcript in several
appends: a mode record and a `file-history-snapshot` can land, and be read,
before the `/clear` record. A new file whose first real turn
(`readNewSessionSignals().hasTurn`) is not written yet stays out of
`knownJsonlFiles`, whatever its other signals, until it shows one or is an
hour old (the same limit as a file with no parseable record). While it is
under 60 s old, `scheduleRecheck` runs the folder again a second later. The
session's own transcript is never held this way. A held file is read again
only when its size or mtime changes (the signals are cached by path), and the
"NO MATCH" line of a session awaiting a fork is logged once per file.

**Snapshot-only fork file.** A session started with `--fork-session` waits
for its fork's transcript, which holds only snapshots until the first prompt.
Such a file is taken as the fork only when `clearOwner` (it answers for any
session id, not only a `/clear`) says the CLI under this PTY writes it. A
`pending` owner is rechecked like a `/clear`; `other` or `unknown` leave the
file eligible, and its first turn decides through `forkedFrom` or
`parentSessionId`, as for any fork. Before, any snapshot-only file in the
folder was taken, including another session's `/clear` or new session.

`readNewSessionSignals()` recognises the file by its first user record that is
not local-command bookkeeping, through `classifyUserText()` — the caveat record
comes first and must be skipped, not taken as the file's first turn. The
command may be `/clear`, or its aliases `/reset` and `/new` (CLI 2.1.296:
`name:"clear"`, `aliases:["reset","new"]`), with or without a name argument.
The owner and match lines are logged when they change, not on every recheck.
`/clear` writes no `continued-in` record (checked on CLI 2.1.296: the only
writer is the background-session handoff; none of 41 local `/clear`
transcripts is the target of one), so #518's continuation restore does not
redirect a click on the cleared conversation to the new one.

`session-forked` carries the kind of re-key, `'clear'` or `'fork'`. The
renderer re-keys as for a fork, and for a `/clear` whose old id was not a
pending (transcript-less) row it replaces the open entry's session with a new
one for the new id, built as `launchNewSession` builds one (titled "New
session", not starred, no title, bridge or dates of the old conversation): the
`/clear` transcript is not indexed until its first prompt (see
session-cache.md), so without it the open terminal would have no row at all
until then. That row is marked `cleared`, and is not re-added to the default
list when the backend filtered its folder out as archived. Like any local
pending row, it is saved in the working set as a fresh entry
(docs/session-restore.md, "A session with no transcript yet"). The old
conversation stays in the list as an ordinary, resumable session — it is a
real transcript on disk.

## Canary tests

`test/canary-*.test.js` is a convention this module introduces. A canary
asserts nothing about our code: it pins an assumption we make about something we
do not own, and **skips itself wherever that thing is absent** so CI and
machines without the dependency stay green. Its failure message must name the
pinned assumption and the observed version of the external thing, so the next
reader knows immediately to look outward rather than hunt a bug in Switchboard.

Add one whenever you build on an undocumented external artefact; do not add one
for an assumption a normal unit test can pin.

## Conversation continuations

CLI 2.1.289 and 2.1.295 append `{type:"continued-in", sessionId:<old>,
continuedInSessionId:<new>, timestamp:...}` to the old transcript. These records
can be mid-file and repeated; the new transcript has no back-link. This is an
observed interface, pinned by an always-running synthetic fixture in
`test/session-continuation-index.test.js`. That fixture proves parser agreement,
not CLI drift; the test suite does not sample real conversation transcripts.

`session-continuations` IPC calls `sessionCache.resolveSessionContinuations`.
It traverses indexed links in record order, deduplicates terminal ids and bounds
traversal to 32 edges / 128 node visits. Cycles, missing continuation rows/files
and malformed continuation records return `unresolved`. Unrelated JSON parse
failures and incomplete tails do not block resume. File scanning yields between
chunks and has no total byte cap; chunk size only controls pacing.

`resolveResumeSession` is shared by restore and sidebar clicks. An automatic
restore selects exactly one terminal id. Several ids, unresolved graphs and
failed lookups hold the saved entry and join the non-blocking restore notice,
which names the original entry. A disk-present, unindexed continuation says
it is waiting for indexing; held entries retry once when indexing finishes,
even when the ordinary planner already settled. Ambiguous graphs ask for a
sidebar choice. No continuation confirmation runs during automatic restore. Manual
opens list each candidate's id and last activity before asking whether to open
it. Declining all candidates offers an explicit original-session choice; an
unresolved graph or failed lookup offers the same choice with a warning.
Cancellation keeps the held entry. Remote sessions retain their attach behavior.

`restoreStartupSessions` shares a map of lookup promises between the remembered
active-session open and working-set restore. Each original id is resolved once
during that startup pass; the map is discarded afterward so subsequent manual
opens and indexing retries re-check the transcript.

The remembered active-session `openSession` must be awaited before working-set
restore starts. Continuation and live-elsewhere checks are asynchronous: before
they finish, no terminal entry has been inserted into `openSessions`. Starting
`restoreWorkingSet` concurrently can see the same session as unopened and launch
a second PTY / duplicate `claude --resume`. Awaiting that first open also lets the
working-set pass reuse its completed continuation lookup. The remembered open
retains the existing renderer-reload behaviour: opening outside restore cancels
the working-set planner, so it neither prompts nor resumes the other saved entries.
The separate continuation-retry cancellation flag is set only by non-automatic
opens; the automatic remembered open does not cancel a held indexing retry.

For uncached local targets, continuation IPC uses `liveElsewhereChecked` before
declaring the transcript missing. `known:false` keeps the graph unresolved when
descriptors cannot be read. A live target remains
a candidate before its first transcript record is written. An indexed sibling
therefore cannot silently win over a live new continuation.

After resolution, `runRestore` checks the final id's liveness; a background
continuation requests the guard's existing `{attach}` verdict. Other live kinds
retain their refusal/confirmation rules. Saved entries are rekeyed before
opening; background continuation attachments retain the resolved entry in the
working set. Ordinary attach tabs remain excluded. Part A, live descriptor
rekeying while the original PTY runs, remains out of scope pending #477.
