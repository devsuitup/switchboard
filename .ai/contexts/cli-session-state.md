# Context: cli-session-state

**Purpose**: turn the Claude CLI's own "I just went idle" moment into an
immediate subagent rescan, so a subagent that finished right before its parent's
turn ended is marked complete in seconds instead of waiting for the next
stabilisation tick.

**Files**: `cli-session-state.js`, wired in `main.js` (three call sites, plus
the `session-live-elsewhere` and `sessions-live-elsewhere` IPCs),
`public/resume-guard.js`, `test/cli-session-state.test.js`,
`test/canary-cli-session-state.test.js`,
`test/cli-session-live-elsewhere.test.js`, `test/resume-guard.test.js`,
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
- **Unverified reservation**: no permission dialog occurred during that
  measurement, so the `waiting` branch was never observed empirically. We treat
  `waiting` as "not idle" on the strength of the name alone. If that reading is
  wrong, the only consequence is a missed early rescan — the tick still fires.

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
- A CLI this instance spawned is never live elsewhere either, even while its
  PTY is still keyed by the pending id and `sessionHasPty` misses it: a pid that
  is one of the PTY processes (`ptyPids`), or whose parent chain reaches this
  main process, is excluded. The chain is read from `/proc/<pid>/stat` on Linux;
  elsewhere only the PTY pids themselves are recognised.
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
  process passes its own 30 s bound instead. Descriptors are read in name
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

| Resume | Live elsewhere | Result |
|---|---|---|
| automatic — the reload path (`sessionStorage.activeSessionId`) and `runRestore` | yes | not opened, no prompt; from `runRestore`, a one-line notice |
| asked for by the user (sidebar click, resume dialog, transcript viewer) | yes | `confirm()`; cancel aborts, OK spawns the second CLI |
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
manual open does after its confirm.

The sidebar has no dedicated marker for such a session. Once the watcher has
seen its state file, `getStatus()` gives it the same state+age line as any live
session (see the section above).

## Canary tests

`test/canary-*.test.js` is a convention this module introduces. A canary
asserts nothing about our code: it pins an assumption we make about something we
do not own, and **skips itself wherever that thing is absent** so CI and
machines without the dependency stay green. Its failure message must name the
pinned assumption and the observed version of the external thing, so the next
reader knows immediately to look outward rather than hunt a bug in Switchboard.

Add one whenever you build on an undocumented external artefact; do not add one
for an assumption a normal unit test can pin.
