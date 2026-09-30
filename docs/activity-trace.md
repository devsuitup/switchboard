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
| `subagent.spawned` | `subagent-spawned` is sent | `agentId`, `kind` (`spawn` / `heartbeat`), `subagentType`, `ageMs`, `sent` |
| `subagent.assumed-finished` | An unknown transcript is recorded as already finished, without any IPC | `agentId`, `ageMs`, `bootstrap`, `recheck` |
| `subagent.rehabilitated` | An assumed-finished subagent grew within its recheck window: the withheld spawn is released | `agentId`, `withheldForMs`, `subagentType`, `sent` |
| `subagent.completed` | `subagent-completed` is sent | `agentId`, `stableForMs`, `reason`, `sent` |
| `session.forked` | A fork re-keys a live session | `newId`, `wasBusy`, `sent` |
| `pty.input` | Every `terminal-input` IPC chunk, before the prompt model sees it | `len` always; `at` and `cp` only when the chunk holds a control character |
| `pty.exit` | The PTY exits | `exitCode`, `alsoUnder`, `wasBusy` |
| `poll.snapshot` | `get-active-sessions` answers | `count`, `entries` |
| `trace.prune-failed` | An old file could not be deleted | `file`, `error`, `retained` |
| `app.quit` | Last line of a clean shutdown | — |

### Renderer

| `cat` | Fires when | Key fields |
|---|---|---|
| `recv.*` | An IPC event arrives (`cli-busy-state`, `terminal-notification`, `session-forked`, `session-detected`, `process-exited`, `subagent-spawned`, `subagent-completed`) | per event |
| `recv.subagent-spawned` | `noteSubagentActivity()` recorded a sighting — the single write path into `activeSubagentsByParent`. `applied` says whether it changed anything. `applied:false` with `reason:"heartbeat-for-untracked-agent"` is a heartbeat dropped before that function (traced from `onSubagentSpawned`, so without `source`) | `agentId`, `applied`, `source` (`local-ipc` / `remote-watch` / `local-transcript`), `bootstrap`, `heartbeat` (both `local-ipc` only), `from` |
| `recv.subagent-completed` | A subagent left `activeSubagentsByParent`; `via` says how: `ipc` (the `subagent-completed` event, `local-ipc` only), `ttl` (the 60 s sweep — the only completion `remote-watch` and `local-transcript` get), or `parent-cleared` (the parent's PTY exited, or its remote session was marked stopped) | `agentId`, `from`, `via` |
| `store.mutate` | A state store changes | `map`, `op`, `from`, `to`, `fn`, `via` |
| `store.skip` | A write was **refused** by a guard | `map`, `reason`, `fn` |
| `store.purge` | State dropped because the PTY is gone | `reason`, `busy`, `ready`, `attention` |
| `store.rekey` | Activity state carried across a fork | `from`, `busy`, `ready`, `attention` |
| `subagents.prune` | The 60 s sweep ran | `parents`, `agents` |
| `class.apply` | `needs-attention` / `cli-busy` / `response-ready` / `has-busy-agents` / `is-alive` written, for every kind of session | `el`, `needs-attention`, `cli-busy`, `response-ready`, `has-busy-agents`, `is-alive`, `kind` |
| `class.toggle` | `has-running-pty` written | `el`, `cls`, `on` |
| `class.subagent` | A subagent's `running` / `has-running-child` / `has-busy-agents` written | `el` ids, `running` |
| `class.render` | A full sidebar render rebuilt an item's classes from the stores | `el`, `cls` |
| `poll.recv` | The poll reply reaches the renderer | `sinceSeq`, `entries` |
| `reconcile.apply` / `reconcile.skip` / `reconcile.noop` | Per session in the poll reply | `backend`, `local`, `reason`, `sinceSeq`, `sessionSeq` |

`store.mutate` carries `fn`, the function that wrote, and for `setActivity`,
`via`, the caller that asked.

## What to look for

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

> **Expect a burst at startup.** The first scan writes one
> `subagent.assumed-finished` line per historical subagent transcript, all with
> `bootstrap:true`; later scans write none. Filter them out when reading a
> startup problem: `jq -c 'select(.bootstrap != true)' $TRACE`.

**Is a subagent's state the truth or an assumption?** A transcript first seen
already stale is recorded as finished without any event;
`subagent.assumed-finished` is the only record of it. With `recheck: true` that
verdict is a guess, and a later `subagent.rehabilitated` retracts it, with
`withheldForMs` saying how long the spawn was held back.

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

# The subagent detector's decisions, without the startup burst
jq -c 'select((.cat | startswith("subagent.")) and .bootstrap != true)' $TRACE

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

Even with the trace on, no probe sits on the terminal render path: `osc.title`
fires only for chunks carrying an OSC introducer, and `pty.input` only for
chunks sent *to* the PTY. This matters because of
[decision 0002](decisions/0002-discrete-steps-sidebar-animations.md): the
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
