# Activity Trace

**Debug mode** records a diagnostic trace of the sidebar's activity indicators —
the light-blue working spinner, the blue "response ready" dot, the orange
attention LED, the violet subagent states and the green running dot (see
[Status indicators](notifications.md)).

Those indicators are driven by two processes with two clocks: the main process
parses OSC sequences off the PTY and watches the filesystem, and the renderer
keeps several state stores and paints classes. When an indicator is wrong,
`main.log` cannot say why — most of the OSC handling logs at `debug`, which a
packaged build does not write, and nothing records the renderer side. The trace
records **both processes into one ordered file**, so "what did the CLI put in
the title, and what did the UI do about it" has one answer.

**It is off by default, and costs nothing when off.** Turn it on while
investigating.

## Turning it on

**Global Settings → Diagnostics → Debug Mode.**

### Toggling it at runtime

The switch takes effect as it is flipped: no restart, no session lost. The
symptoms it exists to catch depend on live session state, which a restart would
destroy. The choice is remembered across launches, as `activityTrace` in the
global settings. The Diagnostics section also lists the trace files with their
size and date, and opens or deletes them; the file being written cannot be
deleted.

### From the environment

```bash
SWITCHBOARD_ACTIVITY_TRACE=1 task dev
```

`1`, `true`, `yes` and `on` (any case) mean on; any other non-blank value means
off. When the variable is set, it decides the state the app starts with, and the
stored preference is ignored for that launch; when it is unset or blank, the
stored preference decides. Either way the switch still works once the app runs.
The main process reads the variable once (`activity-trace.js`) and tells the
renderer, through a launch argument and then the `activity-trace-state` event,
so the two halves cannot disagree.

### Main-loop measurements

With tracing on, `main.loop` reports `lagMs` (lateness of the existing
one-second timer, clamped to zero). Each callback rebases the expected tick,
even while tracing is off; enabling tracing preserves that baseline. This
signal adds no timer. It exposes a block across a tick; a stall that ends
before the next tick is not seen. It does not measure a latency percentile.

Measured idle `lagMs` on Windows was 0–20 ms, with rare outliers (one at 73 ms).
Treat this timer noise as context when reading stalls. Sleep/resume probably
appears as one large `lagMs` sample; this has not been verified.

For a fine event-loop delay measurement, start Switchboard with
`SWITCHBOARD_MAIN_LOOP_HISTOGRAM=1` and enable tracing. This switch is read
once at monitor startup; only the exact value `1` arms it. Armed events also
carry `maxMs` and `p99Ms` from a 20 ms histogram, reset after each report.
The histogram records full timer intervals, so its idle floor is at least
20 ms; armed at 20 ms, it measured about 32 ms at idle in Electron. A 32 ms
histogram value alone is not a stall. It adds roughly 50 timer wakeups per
second while tracing is on; use
it for a bounded measurement, then restart without the switch. Disabling
tracing disables the armed histogram immediately.

### Renderer long frames

While tracing is on, `renderer.longframe` records frames lasting at least 50 ms.
It uses `PerformanceObserver` with `long-animation-frame`, falling back to
`longtask` when that entry type is unavailable. `durationMs` is the entry's
duration; `blockingMs` is Chromium's `blockingDuration` for a long animation
frame, or the task duration beyond 50 ms for the fallback (an estimate, not a
frame measurement). No observer is constructed or capability queried while
off. Disabling tracing disconnects it; enabling creates a fresh observer
without buffered entries. There is no timer, polling or work at idle.

### Projects reload causes

`projects.changed` records an actual `projects-changed` emission. Its `cause`
is an array of distinct caller labels: `watcher`, `bg-jobs`, `cli-status`,
`remote`, `archive`, `project-added`, `project-deleted`, `project-remap`,
`worktree-deleted`, `session-exit`, `session-attach`, `entrypoint-backfill`,
`title-backfill`, `sdk-reveal`, `bridge-repair`, `scan`, or `activity`. Structural
changes use a 1.5-second leading/trailing throttle; calls within that window are deduplicated
into the trailing emission's array, in arrival order. The leading cause belongs
to its own emission. The IPC carries the same array. Notification conditions
outside the local transcript watcher are unchanged. A watcher flush changing
only `modified`, `fileMtime`, or `messageCount` coalesces for at least 30 seconds
before an emission with cause `activity`. Repeated activity does not restart
that timer. A structural emission satisfies pending activity and cancels its
timer, so it does not cause a second reload. Both timers are unref'd and cleared
on shutdown.

### Turning it off, and on again

Turning the trace off ends the write stream, which flushes what was already
handed to it, and stops every probe at once.

Turning it back on **opens a new file** rather than appending to the closed
one: the name is stamped with the second the observation window opened, and a
file holding two windows would be named after the first only. `seq` does not
restart — it is process-wide, and orders the two windows. An off/on within the
same second resolves to the same name, and resumes that window's latest file.

The byte counter is read back from the file when it is reopened, so the
rotation threshold measures the file, not the window, and a file already at the
cap rotates at once. A path reopened is queued once, not twice, so the
retention count stays right.

### Where the file goes

Next to `switchboard.db`, in the data directory:

| Run | Directory |
|---|---|
| `task dev`, or any run from source | `~/.switchboard-dev/` |
| `task test-pr PR=<n>` | `~/.switchboard-dev-pr<n>/` |
| `SWITCHBOARD_DATA_DIR=…` | that directory |
| Installed app | `~/.switchboard/` |

The name carries the start time: `activity-trace-20260822-141530.jsonl`. The
main log prints the path (`[activity-trace] enabled → …`). Nothing is written
into the repository.

## Reading a line

One JSON object per line. The first six fields are the envelope, always
present, in this order; the rest is the probe's payload.

```json
{"seq":417,"t":38214.912,"wall":"2026-08-22T14:20:09.118Z","src":"main","cat":"osc.title","sid":"6f1c…","cp":"U+25D0 U+0020 U+0043","title":"◐ Claude","busy":true,"idle":false,"rule":"glyph","was":false,"decision":"emit:busy"}
```

| Field | Meaning |
|---|---|
| `seq` | Sequence number. **The only reliable order.** |
| `t` | Milliseconds since the trace opened, on the main process's monotonic clock |
| `wall` | Wall-clock time, to line up with `main.log` and screenshots |
| `src` | `main` or `renderer` |
| `cat` | Probe category (below) |
| `sid` | The session the line is about, or `null` |

**The main process is the only writer.** The renderer sends its probes over a
fire-and-forget IPC (`activity-trace`), and main stamps `seq`, `t` and `wall` on
arrival. A renderer line's time is therefore its arrival in main — sub-millisecond
later in practice; do not read `t` as renderer latency.

A payload field whose name collides with the envelope is stored with a leading
underscore (`_seq`).

A probe that reports an emission carries **`sent`**: every `webContents.send` is
guarded by "the window still exists", and `sent: false` means the state changed
but the renderer was gone — normal during shutdown, a finding at any other time.
Probes that only record an observation (`osc.title`, `osc.progress`,
`pty.exit`, `poll.snapshot`, `subagent.assumed-finished`) carry no `sent`.

## Probe categories

### Main process

| `cat` | Fires when | Key fields |
|---|---|---|
| `osc.title` | Every OSC 0 title with a payload | `cp`, `title`, `busy`, `idle`, `rule` (`glyph` / `idle-glyph` / `fallback` / `null`), `was`, `decision` |
| `osc.progress` | Every OSC 9;4 progress level (except `4;0`) | `level`, `payload`, `was`, `decision` |
| `osc.notify` | Every other OSC 9 | `message`, `sent` |
| `busy.emit` | A `cli-busy-state` event leaves main | `busy`, `via` (`osc0` / `osc9.4`), `sent` |
| `subagent.history-summary` | Once per parent's first successful bootstrap scan, including an empty directory | `historyCount`, `newestAgeMs` (null when none), `source`, `confidence` |
| `subagent.bootstrap-candidate` | A recent bootstrap transcript is provisionally recorded as finished with a reversible recheck window, without IPC | `agentId`, `ageMs`, `recheck`, `source`, `confidence` |
| `subagent.spawned` | `subagent-spawned` is sent | `agentId`, `kind` (`spawn` / `heartbeat` / `reannounce`), `subagentType`, `ageMs` (first spawn), `source`, `confidence`, `sent` |
| `subagent.assumed-finished` | A post-bootstrap stale first sighting is provisionally recorded as finished, without IPC | `agentId`, `ageMs`, `bootstrap:false`, `recheck`, `source`, `confidence` |
| `subagent.rehabilitated` | A provisional subagent grew within its recheck window: the withheld spawn is released | `agentId`, `withheldForMs`, `subagentType`, `source`, `confidence`, `sent` |
| `subagent.completed` | Fallback stability sends `subagent-completed`, or an observed open CLI task becomes terminal in a worker snapshot | `agentId`, `reason`, `source`, `confidence`; fallback: `stableForMs`, `sent`; primary: `cause` (`cli-task-terminal` / `owner-death`), `at` |
| `session.forked` | A fork re-keys a live session | `newId`, `wasBusy`, `sent` |
| `pty.input` | Every `terminal-input` IPC chunk, before the prompt model sees it | `len` always; `at` and `cp` only when the chunk holds a control character |
| `pty.exit` | The PTY exits | `exitCode`, `alsoUnder`, `wasBusy` |
| `pty.resize` | Each guarded PTY resize attempt, including retries, ordinary fits and first-open nudges | `phase` (`fit` / `nudge` / `restore`), `cols`, `rows`, `ok` (the operation returned without throwing; not proof the CLI observed it) |
| `poll.snapshot` | `get-active-sessions` answers | `count`, `entries` |
| `trace.prune-failed` | An old file could not be deleted | `file`, `error`, `retained` |
| `main.loop` | Once per second while tracing is on | `lagMs`; `maxMs`, `p99Ms` only with `SWITCHBOARD_MAIN_LOOP_HISTOGRAM=1` at startup |
| `projects.changed` | A throttled projects notification is sent | `cause` (distinct caller labels coalesced across the throttle window) |
| `app.quit` | Last line of a clean shutdown | — |

### Renderer

| `cat` | Fires when | Key fields |
|---|---|---|
| `renderer.longframe` | An observed frame/task lasts at least 50 ms, while tracing is on | `durationMs`, `blockingMs` |
| `recv.*` | An IPC event arrives (`cli-busy-state`, `terminal-notification`, `session-forked`, `session-detected`, `process-exited`, `subagent-spawned`, `subagent-completed`) | per event |
| `recv.subagent-spawned` | `noteSubagentActivity()` recorded a sighting — the single write path into `activeSubagentsByParent`. `applied` says whether it changed anything. `applied:false` with `reason:"heartbeat-for-untracked-agent"` is a heartbeat dropped before that function (traced from `onSubagentSpawned`, so without `source`) | `agentId`, `applied`, `source` (`local-ipc` / `attached-ipc` / `remote-watch` / `local-transcript`), `bootstrap`, `heartbeat` (both IPC sources only), `from` |
| `recv.subagent-completed` | A source contribution was released from `activeSubagentsByParent`; `op:'set'` means another contribution keeps the agent tracked, and `op:'delete'` means its last contribution was removed. `via` says how: `ipc` (the `subagent-completed` event releases both `local-ipc` and `attached-ipc`), `ttl` (the 60 s sweep — the only completion `remote-watch` and `local-transcript` get), or `parent-cleared` (source-scoped PTY cleanup, or all-source cleanup on confirmed remote stop). Parent cleanup emits these releases, not a `store.mutate` with `op:'delete-parent'` | `agentId`, `source`, `op`, `from`, `to`, `via` |
| `store.mutate` | A state store changes | `map`, `op`, `from`, `to`, `fn`, `via` |
| `store.skip` | A write was **refused** by a guard | `map`, `reason`, `fn` |
| `store.purge` | State dropped because the PTY is gone | `reason`, `busy`, `ready`, `attention` |
| `store.rekey` | Activity state carried across a fork | `from`, `busy`, `ready`, `attention` |
| `subagents.prune` | The 60 s sweep ran | `parents`, `agents` |
| `class.apply` | `needs-attention` / `cli-busy` / `response-ready` / `has-busy-agents` / `is-alive` written, for every kind of session | `el`, `needs-attention`, `cli-busy`, `response-ready`, `has-busy-agents`, `is-alive`, `kind` |
| `class.toggle` | `has-running-pty` written | `el`, `cls`, `on` |
| `class.subagent` | A subagent activity refresh updated the parent's running count, `has-busy-agents` and status icon; child and caret liveness classes are no longer written | `agentId`, `childEl`, `caretEl`, `parentEl`, `running` (registry activity), `has-busy-agents`, `fn` |
| `class.render` | A full sidebar render rebuilt an item's classes from the stores | `el`, `cls` |
| `render.stats` | Once per second per session that saw terminal activity, while the trace is on: the terminal render path's counters for that second | `ms` (the window's real length), `chunks`, `chars` (PTY data events received and their length), `hiddenChunks` (of those, received while the session's terminal is not displayed in single view: accumulated, never parsed; grid sessions never count as hidden), `writes`, `writeChars` (calls to `terminal.write`, from the 30 fps flush or a reveal replay, and what they carried), `maxBatchChunks`, `maxBatchChars` (the largest single write), `atlasChanges`, `atlasCanvases` (glyph atlas rebuilds and added atlas pages, each of which repaints every visible row) |
| `refresh.request` | Refresh is requested for an open terminal, before any hidden-terminal reveal | `hidden` (zero container height at request time) |
| `refresh.fit` | A local or solo Refresh has fitted xterm, before updating the recorded PTY size and sending refresh IPC | `cols`, `rows` (actual xterm size), `prevPty` (last sent size before fitting, or `null`), `proposed` (content-box-clamped fit proposal, or `null` when FitAddon fallback was used), `clientW` (container width in CSS pixels) |
| `reveal.timing` | A hidden terminal is revealed in single view (`showSession`), once its animation frame has run: where the reveal spent its time | `suspendMs` (the warm-cap check that disposes the least recently shown addon), `replayMs` (the hidden-buffer replay), `restoreMs`, `visibleMs` (adding `.visible`), `focusMs` (focus and scheduling the frame), `rafWaitMs` (from scheduling to the frame callback running: a stall in between shows here), `fitMs` (`safeFit`), `webglMs` (creating the WebGL context, 0 when kept alive), `repaintMs` (`forceRepaint` and scroll), `totalMs`, `webglCreated` (the reveal frame created a context), `webglDisposed` (addons the cap disposed on this reveal), and, when the browser reports one overlapping the reveal (its start to the end of its frame), the longest `long-animation-frame` entry (`longtask` where that type is missing): `longType`, `longMs`, `longStartMs` (from the start of the reveal) and `longScript` (invoker, function and URL of its longest script, `long-animation-frame` only). Durations are `performance.now()` differences in ms, rounded to 0.1. With such an observer the line is written 200 ms after the frame, to let the entry arrive |
| `poll.recv` | The poll reply reaches the renderer | `sinceSeq`, `entries` |
| `reconcile.apply` / `reconcile.skip` / `reconcile.noop` | Per session in the poll reply | `backend`, `local`, `reason`, `sinceSeq`, `sessionSeq` |

`store.mutate` carries `fn`, the function that wrote, and for `setActivity`,
`via`, the caller that asked.

## What to look for

**Does revealing a tab stall the renderer?** One `reveal.timing` line per reveal. The step with the large value is the cost: `replayMs` is the buffered output parsed, `webglMs` a context created, `fitMs` / `repaintMs` the layout and repaint, `rafWaitMs` time the frame waited behind other work. `webglCreated:false` with a long `fitMs` or `repaintMs` points away from context creation:

```bash
jq -c 'select(.cat=="reveal.timing") | {sid, totalMs, replayMs, webglMs, fitMs, repaintMs, rafWaitMs, webglCreated}' $TRACE
```

**Is a terminal burning CPU legitimately?** The volume is one line per active session per second, hidden sessions and sessions without a terminal entry included. A window that straddles a temp-to-real id rekey reports under both ids. `render.stats` has no line for a
second in which the session saw nothing. Writes per second is `writes * 1000 /
ms`; it cannot exceed about 30 for a displayed session, and `writeChars /
writes` is the batch size. A high `atlasChanges` in the same seconds as the CPU
means repaints from the glyph atlas, not parsing:

```bash
jq -c 'select(.cat=="render.stats") | {sid, w: (.writes*1000/.ms), batch: (.writeChars/(.writes|if .==0 then 1 else . end)), atlasChanges, atlasCanvases}' $TRACE
```

**Does the CLI's title still match the busy test?** The spinner glyphs are the
CLI's private business and can change with a release. After a CLI upgrade:

```bash
# Leading code points, and what the detector made of them
jq -r 'select(.cat=="osc.title") | "\(.cp | split(" ")[0])\t\(.rule)\t\(.decision)"' $TRACE | sort | uniq -c

# Where busy transitions came from — `osc0` must appear
jq -r 'select(.cat=="busy.emit" and .busy==true) | .via' $TRACE | sort | uniq -c
```

Spinner frames reading `rule:"fallback"` are glyphs the range table in
`classify-title-activity.js` does not list yet: still detected, worth adding.
`ignored:no-match` on a title that visibly carries a spinner means the fallback
itself no longer matches. No `osc0` in the second count means the title channel
is dead and the indicator rides on the progress reports alone. See
[`.ai/contexts/ipc-bridge.md`](../.ai/contexts/ipc-bridge.md), "The OSC 0 title
is the primary busy channel". Quote a time window, not a file total: the file
grows for as long as the trace is on.

**Was an event suppressed, or never sent?** `osc.title` records the verdict
(`emit:*` or `suppressed:*`), `busy.emit` the send. `emit:busy` without a
`busy.emit` right after it is a bug in the emitting branch;
`suppressed:already-busy` is the rule working.

**History is summarized, not completed live.** The first successful directory
scan emits one `subagent.history-summary` for the parent. `historyCount` counts
unregistered transcripts at least 60 seconds old; `newestAgeMs` is the smallest
age among them, or null for zero history. Recent files instead produce separate
`subagent.bootstrap-candidate` events and retain their recheck window. Static
history produces no spawn or completion IPC. Subsequent scans do not repeat the
summary, and files held by the CLI task registry are excluded regardless of age.

**Is a subagent's state explicit or inferred?** File-based events carry
`source:"transcript-mtime"` and `confidence:"inferred"` (the history summary uses
`confidence:"historical"`). A post-bootstrap stale sighting is an
`subagent.assumed-finished`, and a recent bootstrap candidate has its own category.
With `recheck:true` either verdict remains reversible: `subagent.rehabilitated`
retracts it and reports `withheldForMs`. A fallback `subagent.completed` with
`reason:"mtime-stable"` is still a silence assumption.

A registry open-to-terminal transition produces `subagent.completed` with
`source:"cli-task"` and the registry's `at` timestamp. Recorded terminal evidence
(correlated results/notifications or job state) uses `confidence:"explicit"` and
`reason:"cli-task-terminal"`, `cause:"cli-task-terminal"`. When the snapshot's
`ownerDiedAt` changes, tasks closed by that owner death instead use
`confidence:"inferred"`, `reason:"owner-death"` and `cause:"owner-death"`:
the parent exited, but no task completion was recorded. A later recorded
completion after restart stays explicit even though the earlier `ownerDiedAt`
remains in the snapshot. The probe observes the worker snapshot, not a
`subagent-completed` IPC; the renderer receives `task-snapshot`. Initial replay of
terminal history and duplicate terminal snapshots do not emit a live completion. Explicitly
open tasks never complete from silence. Only transitions observed while tracing
is enabled are recorded; enabling Diagnostics does not rescan history or replay
missed events. A directory absent at bootstrap produces no summary until it exists.

**Did the UI receive it and act?** Follow `seq`: `busy.emit` →
`recv.cli-busy-state` → `store.mutate` → `class.apply`. Where the chain stops
names the process at fault. `store.skip` and `reconcile.skip` name the guard
that dropped the value.

### Useful filters

```bash
TRACE=~/.switchboard-dev/activity-trace-*.jsonl

# Which code points does the CLI send, and what did the detector decide?
jq -r 'select(.cat=="osc.title") | "\(.cp)\t\(.rule)\t\(.decision)"' $TRACE | sort | uniq -c

# Everything about one session, in order
jq -c 'select(.sid=="6f1c…")' $TRACE

# Every state write refused, and by which guard
jq -c 'select(.cat=="store.skip" or .cat=="reconcile.skip")' $TRACE

# Subagent decisions excluding historical summaries
jq -c 'select((.cat | startswith("subagent.")) and .cat != "subagent.history-summary")' $TRACE

# Explicit registry completion only
jq -c 'select(.cat=="subagent.completed" and .confidence=="explicit")' $TRACE

# Events produced but never delivered (renderer gone)
jq -c 'select(.sent == false)' $TRACE

# Subagent events the renderer received and dropped
jq -c 'select(.cat=="recv.subagent-spawned" and .applied==false)' $TRACE

# Emission and reception, side by side
jq -c 'select(.cat=="busy.emit" or .cat=="recv.cli-busy-state")' $TRACE
```

## What `pty.input` records

`pty.input` records every chunk's length, and code points **only from the
chunk's first control character** (C0 or DEL) onwards, with `at` giving its
offset. A chunk of printable text has no control character, so it contributes a
length and no `cp` field at all.

That rule keeps the probe from being a keylogger. xterm.js sends about one chunk
per keystroke, and a typed chunk's code points *are* the text; a trace left on
for an evening would otherwise hold everything typed into every session. The
chunks the probe is for — those that push the prompt model's quiet clock while
leaving `pending` at 0 (see [Automation](automation.md#politeness-switchboard-never-types-over-you))
— are escape sequences and control characters, which is what is kept.

Ten code points are kept from the control character (a cursor-position report,
`ESC [ 24 ; 80 R`, is eight). So a chunk whose sequence is followed by text — a
bracketed paste, `ESC [ 200 ~` then the pasted content — can carry a few
characters of that text. That is the bound of the guarantee: no chunk of plain
text is ever rendered, and no rendering starts before a control character.

## Disk use

At most 4 rotating segments of 16 MB each: a 64 MB ceiling by default, so the
trace can stay on overnight. At the cap the oldest segment is deleted.

```bash
# 256 MB ceiling instead of 64
SWITCHBOARD_ACTIVITY_TRACE=1 SWITCHBOARD_ACTIVITY_TRACE_MAX_MB=256 task dev
```

If the deletion fails — a `tail` or an editor holding the file open, typically —
the file stays queued and is retried at the next rotation, and a
`trace.prune-failed` line records it: the ceiling can be exceeded for a while,
never silently. A file that is simply gone (deleted from the Diagnostics panel
or by hand) is dropped from the queue.

Writes go through an append-only stream and are never read back. The stream
buffers, so a slow disk delays the trace without blocking the main thread; the
last few lines can be lost on a hard crash. A clean quit flushes and closes the
file (`app.quit` is its last line).

## Cost when off

Nothing is built, sent or written.

- **Main process**: every probe is `if (TRACE.on) trace(...)` — one property
  load, and the payload is never evaluated. `TRACE` is an object rather than a
  boolean so that the runtime switch reaches every probe. The `activity-trace`
  IPC handler is registered at all times, so arming the trace needs no new
  listener; the renderer does not send to it while the trace is off, and
  `trace()` drops anything that arrives.
- **Renderer**: `preload.js` exposes the startup state as
  `window.api.activityTraceEnabled`; `public/activity-trace.js` keeps
  `window.ATRACE` in step with main. Probes are `if (window.ATRACE) window.atrace(...)`.
- `trace()` also returns on its first line when off.

`test/activity-trace.test.js` and `test/activity-trace-renderer.test.js` check
that a disabled trace never advances its sequence, never opens a file and never
reads a payload property. `test/activity-trace-probe-guards.test.js` scans
`main.js`: every call to `trace`, `codePoints`, `controlOffset`, `busyDecision`
or `progressDecision` must sit under `if (TRACE.on)`, and the probe categories
are listed so a probe deleted in a refactor fails the suite. The one exemption
is the OSC 0 `log.debug` line, guarded by `if (LOG_DEBUG_ON)` instead and pinned
by `test/osc-debug-log-guards.test.js`: a packaged build logs at `info`, so it
is inert there.

Even with the trace on, no per-chunk line is written for the terminal render
path: `osc.title` fires only for chunks carrying an OSC introducer, and
`pty.input` only for chunks sent *to* the PTY. The render path is observed by
`render.stats`, which counts in memory and sends one line per session per
second. Off, each of its sites in `public/terminal-manager.js` is one
`window.ATRACE` read: no counter object, no timer and no clock read per write.
`reveal.timing` follows the same rule: a reveal reads `window.ATRACE` once, and the
clock only when it is on.
On, a write costs an integer increment; the one timer is armed by the first
event of a window and is not re-armed when nothing happens. This matters because
of [decision 0002](decisions/0002-discrete-steps-sidebar-animations.md): the
indicators are built not to burn CPU at idle.

## Implementation notes

### A segment is pruned only once its stream has closed

`fs.createWriteStream` opens its file asynchronously, and with `flags: 'a'` the
open creates the file if it is missing. A rotation retires a stream whose open
may not have happened yet; unlinking that file first would let the late open
recreate it, outside the queue and never pruned again.

`pruneSegments()` therefore stops at the first old file whose stream has not
emitted `close` (the `unsettled` map in `activity-trace.js`, a count per path,
since a same-second reopen can reuse a path before its previous stream closed).
Every retired stream prunes again on its own `close`. The late-open order occurs
on the Windows CI runners; the test "a retired segment whose open lands late is
not recreated behind the prune" holds one open back to reproduce it on any
platform. A test counting retries of a locked file rotates again after the first
attempt, since the first attempt waits for that file's own `close`.

A stream whose `close` never fires (see the fallback below) keeps its file, and
every file queued after it, on disk until the process exits.

### Testing the async prune path

`rotate()` opens the new file synchronously and runs the retired stream's
cleanup on that stream's `close` event — not on `.end()`'s callback, which fires
on `finish`, before the descriptor is released. `close()` and
`setEnabled(false, …)` wait for their own stream's `close` **and** for every
rotation close still in flight (`pendingRotationCloses`), so a directory can be
removed right after they return, on Windows too.

The tests intercept the `.once('close', …)` registration the code makes
(`interceptOnceClose`), hold it, assert the callback under test has not resolved,
release it, and assert that it has. Code that waited on `finish` instead would
never register, and the callback would resolve at once. The tests that wait for
an asynchronous outcome poll for it (`waitUntil`, capped at 10 s) rather than
sleeping a fixed time, and the prune-failure test waits for its warning to be on
disk before calling `close()`.

**The wait is bounded.** A `close` may never come — an antivirus or backup lock
on Windows can hold a handle indefinitely. `close()` and `setEnabled(false, …)`
call `done()` anyway after `closeTimeoutMs` (default 5 s, overridable for tests),
with a `process.emitWarning` of code `SWITCHBOARD_TRACE_CLOSE_TIMEOUT`. The
Diagnostics toggle's handler (`set-activity-trace-enabled` in `main.js`) adds its
own 8 s bound around the call. Both functions are tested separately: they build
the same guard independently.

During the window between that fallback and the real `close`, `currentFile()`
still reports the old path although the trace is off, so the panel's delete
button keeps refusing a file that may still be open. The fallback's timer is
`unref()`'d: in a bare Node process with nothing else alive, the process can exit
before it fires, which the Electron main process never does.

## Related

- [Status indicators](notifications.md) — what each indicator means
- [`.ai/contexts/ipc-bridge.md`](../.ai/contexts/ipc-bridge.md) — busy-state reconciliation
- [`.ai/contexts/subagent-observability.md`](../.ai/contexts/subagent-observability.md) — subagent spawn and completion detection

## Conversation projection records (#719)

Ordinary main.log includes info-level lines prefixed [session-projection], even
in packaged builds with Diagnostics off. One newline-free JSON object records
each accepted logical conversation change, combining background/merge membership,
representative/head, selected activity source and visibility facets. Omission or
metadata-time changes alone are silent; current deciding inputs still refresh.
These records complement the optional OSC/paint trace above.

Correlate schema:1, main timestamp, cause, opaque host/project scope and graph
root with projects generation/build and roster revision. Inputs describe exact
CLI inclusion/availability, cached-job evidence, accepted descriptors, attach and
current proof/filter reasons. Removed rows use current producer exclusions when
known; an unknown disappearance explicitly labels priorInputs as prior. Archived
rows retained in the all view log visibility loss. Splits log every affected root.

Full member sets are compared before emission truncates each list to 128 entries
with original counts and truncation flags. Records above the transport budget
compact while retaining identifiers, facets, counts and reasons; the final line
stays below 64 KiB. The main-window/frame bridge validates allowlisted typed fields
and rejects controls and untrusted extra fields. Records contain no raw project
paths, names, prompts, transcript/CLI text, secrets or serialized liveVersion.
