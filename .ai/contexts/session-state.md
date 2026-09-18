# Session state — one domain module, one icon slot

Origin: issue #246 (step 3 of the alignment sequence #244 → #245 → #246 → #247).
Full design: the issue body and its 2026-09-11 lifecycle comment. This doc covers
what actually shipped, not the whole plan.

## Migration status

**Complete.** All three kinds (`local-pty`, `remote-ssh`, `local-transcript`)
are persistent-state adapters of the same shape: one `createSessionState(kind)`
per session id, events applied to it, `session-activity-dom.js`'s
`applyStateClasses(sessionId, snapshot)` as the single DOM projection path.
Issue #246 is closed.

- **Steps 1-3b: done.** `public/session-activity.js` split into a state part
  (itself) and a DOM part (`public/session-activity-dom.js`); `public/session-state.js`
  introduced, and a persistent `remote-ssh` adapter (`public/remote-activity-ui.js`)
  shipped for remote sessions — see "The remote-ssh adapter" below. Step 3b (one
  `.session-icon` slot per sidebar row, replacing `.session-status-dot` for
  session/subagent rows) shipped separately — see "The icon slot (step 3b)"
  below.
- **Step 4: done.** The `local-transcript` adapter (`public/local-transcript-adapter.js`)
  gives a session launched outside Switchboard (no PTY in this app) a busy
  signal from transcript growth — see "The local-transcript adapter (step 4)"
  below.
- **Step 5: done** (issue #247). A subagent transcript write for a **remote**
  or **local-transcript** parent (no PTY in this app) is attributed to that
  parent and applied through its own adapter's `subagentSpawned`/
  `subagentCompleted` — see `.ai/contexts/subagent-observability.md`
  ("Attribution across sources") for the full wiring. A **local-pty** parent
  is untouched: it keeps going through the IPC path
  (`session-transitions.js:detectSubagentTransitions()`), never double-fed —
  `sidebar.js`'s `reflectSubagentRunningState()` mirrors
  `activeSubagentsByParent`'s live count into the local-pty adapter's own
  state (`syncLocalPtyAgentsBusy`, see "The local-pty adapter" below) instead
  of a second IPC feed. `sidebar.js`'s `parentHasActiveSubagent()` still
  consults `activeSubagentsByParent` plus the remote-ssh and local-transcript
  adapters' own snapshots (`remoteSessionStates` / `localTranscriptStates`)
  for the row-level `has-busy-agents` class — see "migration status" note
  under "The local-pty adapter" for why that reader is not migrated onto the
  adapter's own `agentsBusy` field.
- **Lifecycle decisions (2026-09-11): done.** The two verbs — detach and
  stop — are both real now; see "The two lifecycle verbs: detach and stop"
  below.
- **The local-pty adapter: done** (this pass, closing #246). See "The
  local-pty adapter" below.

## The two lifecycle verbs: detach and stop

Two facts the domain carries separately: **process liveness** (the CLI is
running — local pid, or a remote descriptor with an ALIVE marker, #262) and
**attached view** (Switchboard holds a PTY / an ssh attach for it). A row is
active because the process is alive, not because a tab is open.

| verb | local-pty | remote-ssh |
|---|---|---|
| detach | not offered — closing a session's view is a stop (unchanged) | `stop-session`'s pre-existing behavior: `killPty` → the tmux adapter's `detach()` (`remote-attach.js`) — ends the local ssh client, optionally restores tmux options (solo attach, #256). Still reachable today wherever `activeSessions` cleanup calls `killPty` on a `kind: 'remote-attach'` session without a preceding `remote-stop-session` call, and via `close-terminal`'s ordinary detach (marks `rendererAttached=false`, kills nothing). |
| stop | kill the PTY (`stop-session`, unchanged) | **new**: `remote-stop-session` IPC (`{alias, sessionId}`) — kills the process on the host itself, same control and same confirmation dialog as local. No session locked by name or role. |

**No new dialog component.** `public/stop-session-ui.js`'s `resolveSessionStop(session)`
is the only thing that differs between a local and a remote stop: which IPC
to call, and the `confirm()` text (the host alias is named for a remote
session). `app.js`'s `confirmAndStopSession` is still the single call site of
the dialog and the single stop control (the sidebar row's `.session-stop-btn`,
the terminal header's stop button, and the grid card's stop button all funnel
through it) — it now asks `resolveSessionStop` which IPC to call instead of
always calling `stopSession`.

### Reopening a plain terminal

A session's `type` is what tells `open-terminal` which of its two branches to
take: `isPlainTerminal = sessionOptions?.type === 'terminal'` picks a login
shell, anything else runs `claude --resume <sessionId>`. The type lives on the
session object in the renderer, and every path that reopens one has to carry it
across the IPC boundary — `resolveDefaultSessionOptions` (`public/dialogs.js`)
resolves *Claude launch* options (permission mode, worktree, chrome, sandbox,
preLaunchCmd, addDirs, MCP emulation) and deliberately says nothing about the
session type, because it is also what a Claude resume uses.

`openSession` therefore chooses the options in one chain, in this order:

1. `customOptions`, when the caller supplied them. Only the
   resume-with-config dialog does, and the sidebar never renders its button on
   a terminal row (`session.type !== 'terminal'` gates the whole action group),
   so an explicit choice always wins and never has to be reconciled with the
   type.
2. `{type: 'terminal'}` for a session whose own `type` is `'terminal'`. A shell
   has no permission mode, worktree or MCP emulation to resolve, so the
   defaults call is skipped entirely.
3. `resolveDefaultSessionOptions()` otherwise.

Without step 2, a terminal that is no longer in `openSessions` — its shell
exited and the entry was destroyed, or the renderer reloaded — reopens as a
Claude resume against an id minted by `launchTerminalSession` for a shell,
which has no transcript. `activeSessions` hides it whenever the PTY is still
live, because `open-terminal`'s reattach branch runs first; the failure needs
the PTY to be gone as well.

**An exited terminal reopens under its own id.** Both branches of the
`openSessions` check now converge on the same reopen: a closed entry is
destroyed and the function falls through, exactly as it already did for a
Claude session. Minting a fresh id instead (`launchTerminalSession`) left the
row the user clicked behind, pointing at an id nothing could open correctly,
while the new shell arrived on a row they had not asked for. `main.js` needs
nothing for this: its plain-terminal branch ignores `isNew` and spawns a shell
either way, and the resume-cwd lookup is already guarded on
`sessionOptions?.type !== 'terminal'`.

### Archive/delete are stop-then-archive/delete (issue #271)

`public/sidebar.js`'s four archive/delete call sites (`.project-archive-btn`,
`.slug-group-archive-btn`, `.session-delete-btn`, `.session-archive-btn`) used
to call bare `stopSession` gated on `activePtyIds` — a detach for an attached
remote row, and nothing at all for an unattached one, while the archive/delete
proceeded regardless. They now share `stop-session-ui.js`'s `stopBeforeArchive(session)`,
built on `resolveSessionStop` plus `isRemoteSessionAlive(session)` (the
`remote-ssh` adapter's own `remoteSessionStates` snapshot when one exists —
authoritative over a stale `session.remoteDescriptorSeen` right after this app
itself just stopped it — falling back to `remoteDescriptorSeen` otherwise):

| kind | alive / has PTY | call |
|---|---|---|
| remote | alive | `remoteStopSession(alias, sessionId)` |
| remote | not alive | nothing — `{ok:true}` |
| local | has PTY (`activePtyIds`) | `stopSession(sessionId)` |
| local | no PTY | nothing — `{ok:true}` |

A `{ok:false, error}` return skips that session's archive/delete and surfaces
the failure on its own button — `sidebar.js`'s `surfaceStopFailure(btn, message)`,
the same flash-and-title-with-restore convention `confirmAndStopSession` uses.
For the two group archives (project header, slug group), one session's
refusal only skips that session; the loop continues to the rest. The project
header's confirmation names the host alias(es) it is about to stop, computed
with the same `isRemoteSessionAlive` check.

**Delete never calls `stopBeforeArchive` for a remote session.** `delete-session`
is refused server-side for remote regardless (`REMOTE_READ_ONLY`, main.js) —
stopping the process first would strand a killed remote session behind a
delete that never happens, so the delete site checks
`resolveSessionStop(session).remote` itself and skips the stop entirely for
that kind, local sessions unaffected.

**The remote stop, main-side (`remote-stop.js`).** `createRemoteStopAdapter().stop(alias, descriptor)`
builds one non-interactive ssh command (same `buildRemoteCommandArgs` transport
as `remote-attach.js`'s probe/restore calls) that: (1) reuses
`remote-attach.js`'s `buildProcCmdlineCheck`/pid-reuse guard verbatim — a
recycled pid is refused with the exact wording the attach path uses, not a
forked copy; (2) when the descriptor's `tmux` field parses, discovers the
socket from `/proc/<pid>/environ` (identical to the attach probe) and kills at
the **narrowest matching scope, never the session**: `tmux kill-pane -t
<target>` when the target names a pane, `tmux kill-window -t <target>` when it
names only a window. `kill-session` is never emitted — the VPS harness runs
several CLIs as windows/panes of one shared tmux session, and a session-wide
kill would take every sibling down with the one being stopped; a tmux exit
code of 0 only means tmux accepted the request, so this is confirmed with the
same `/proc/<pid>` poll as step (3) below before the tmux success marker is
reported — a survivor falls through to (3) instead; (3) otherwise, or if the
tmux kill fails (or its target survives the poll), falls back to `kill -TERM
<pid>`, polls `/proc/<pid>` for up to ~3s (six 0.5s ticks), then `kill -KILL`
once if it is still there. Returns `{ok, method}` where `method` is
`'tmux-pane' | 'tmux-window' | 'pid-term' | 'pid-kill'`, or `{ok:false, error}`.
`targetHasPane()` reads the pane/window distinction off the target string
itself (a "." after the session prefix means a pane component follows,
matching the grammar `TMUX_FIELD_RE` already validates) — no new parsing of
the descriptor is added. The pane-vs-window suffix convention itself comes
from the CLI's own descriptor writer on the VPS side, not measured against
that writer's source from here; the `/proc/<pid>` death poll after the tmux
kill (above) is what bounds the blast radius if that assumption is ever
wrong — a wrongly-classified target still ends up TERM'd/KILL'd by pid once
the poll finds it still alive, instead of the stop silently reporting
success on a process the tmux call never actually touched.

**On a successful stop, `main.js`'s `remote-stop-session` handler**: drops the
descriptor from `remote-index.js`'s in-memory list (`dropRemoteSession(alias,
sessionId)`) and calls `notifyRendererProjectsChanged()` directly — a forced
`refreshHostNow` alone does not reliably `notify()` (only a folder-level jsonl
change does), so the row would otherwise wait for the next real host cycle
to reflect the kill; `refreshHostNow(alias, {force:true})` still runs
afterward, fire-and-forget, as the authoritative reconciliation once the host's
own next descriptor list confirms the process is gone. If this app held a
local ssh attach for the now-dead session (`session.kind === 'remote-attach'`),
`killPty` closes it too — the remote process is already gone, so there is
nothing left to detach *from*, but the local ssh client would otherwise linger
until it notices the far end closed on its own.

**The renderer side, immediately.** On a successful remote stop,
`public/remote-activity-ui.js`'s `applyRemoteStopped(sessionId)` applies
`liveness:'dead'`, `attached:false`, and — beyond what the issue text names,
needed so the adapter's own snapshot does not keep claiming a dead process is
still doing something — clears `busy`/`attention`/`agentsBusy` too, cancels
both of the adapter's own decay timers (activity and subagent-attribution),
and calls `purgeActivityFor(sessionId, 'remote-stop')` to drop the
parallel-fed `sessionBusyState`/`responseReadySessions`/`attentionSessions`
Map entries (see "migration status" above — two readers still consume those
Maps directly). This repaints the row's icon slot before the next
`get-projects` round-trip lands.

### The remote-ssh adapter (step 3)

`public/remote-activity-ui.js` keeps one persistent `createSessionState('remote-ssh')`
per remote session id in `remoteSessionStates` (a `Map`, pruned in
`pruneRemoteActivityTimers()` alongside the decay timers, called after every
`refreshSidebar()`). It is fed by:

- **The watch channel** (`onRemoteActivityEvent`, `main.js`'s `remote-activity`
  IPC): `transcriptTouched` + `busy: true`; the 20s decay timer then applies
  `busy: false, armReady: false` — a remote row must never reach
  `.response-ready`, it has no PTY to confirm a turn actually ended. Tested in
  `test/remote-session-adapter.test.js` and mutation-proven (see below).
- **The descriptor** (`applyRemoteDescriptor`, called from `seedRemoteActivity`
  at every render for every remote session): `descriptorStatus(status, at)`
  from `session.status`/`session.statusUpdatedAt`, and `liveness: 'alive'`
  when `session.remoteDescriptorSeen` is true. `main.js`'s
  `annotateRemoteAttachable` sets `remoteDescriptorSeen = !!descriptor` — the
  descriptor list (`remoteIndexer.getRemoteSessions`) is already ALIVE-marker
  filtered (#262), so a match means a live process. Absence is left
  `'unknown'`, never asserted `'dead'` — a poll miss or host backoff is not
  proof the process exited.
- **Attach/detach of the remote tab** (`setRemoteAttached(sessionId, attached)`,
  called from `app.js`'s `updateRunningIndicators` for rows carrying
  `dataset.remoteAlias`): there is no dedicated open/close IPC event for a
  remote attach, so this reuses the same per-row `activePtyIds` transition
  `has-running-pty` already reads.

**The adapter never writes DOM itself.** Every event ends in
`projectRemoteState(sessionId)`, which calls `session-activity-dom.js`'s
`applyStateClasses(sessionId, snapshot)` — the same single projection path
`setActivity`/`clearUnread`/`setAttention` use for local-pty (via
`projectLocalPtyState`, see "The local-pty adapter" below), just fed from the
remote-ssh adapter's own snapshot instead.

### A parent's busy decay shortens while a subagent is running (issue #284)

A Task-tool invocation typically appends to the parent's own top-level
transcript (recording the tool_use/tool_result around the spawn) at almost
the same moment it appends to the subagent's own file. On the remote-ssh
adapter this used to mean a plain `busy` edge could win the icon rung over
`agentsBusy` for its full 20s decay, even though the top-level agent was
really just idle waiting on the subagent — visibly different from a local-pty
row, which reflects the OSC-driven busy edge instantly and clears it just as
fast.

**First attempt (reverted in review): a 3s coincidence window keyed off the
`agentsBusy` false→true edge.** Two adversarial-review findings killed it.
First, a genuinely busy parent that spawns a subagent lost `busy` outright:
every touch inside the post-spawn window was swallowed and never re-applied,
so a parent writing every ~1s could sit at `agentsBusy` even while it was
still producing output itself. Second, the edge only fires once — a second
subagent spawned while the first was still running had no edge to key off,
`remoteSubagentSpawnAt` stayed stale, and its coincident parent-file touch
armed the full 20s `busy` decay again: the original bug, for the ordinary
sequential-agents case.

**Current design: no window, no edge — the decay *length* itself depends on
`agentsBusy`.** `remoteBusyDecayMs(sessionId)` (`public/remote-activity-ui.js`)
returns `SUBAGENT_PARENT_DECAY_MS` (3000ms) when `agentsBusy` is true,
`PIP_DECAY_MS` (20000ms) otherwise; `onRemoteActivityEvent`'s plain-touch
branch arms the decay with whichever value applies at that instant. Every
`busy` touch still applies `busy:true` unconditionally — nothing is ever
swallowed or synchronously cleared. `markRemoteSubagentBusy` runs on **every**
subagent touch, not only the first: if a busy decay is currently pending with
more than `SUBAGENT_PARENT_DECAY_MS` left, it reschedules that pending timer
down to 3s from now (`remoteActivityDecayRemaining`, tracked as `fireAt` on
`remoteActivityDecayTimers`'s entries) — it never touches `busy` itself,
only how soon its decay fires. The outcome: a parent genuinely still writing
while a subagent runs re-touches at the ~1s IPC throttle, always inside the
3s window, so `busy` never lapses — it keeps the same violet-tinted spinner a
local row would show in the same situation
(`.has-busy-agents .session-icon--busy::before`). A parent that only
bookends the spawn (one touch at spawn, one at completion) has its single
post-spawn touch decay in 3s instead of 20s, landing on `agentsBusy` — the
same rung as the local row — within a few seconds instead of up to 20. A
parent with **no** subagent keeps the full 20s decay unchanged (a long silent
tool call must not read as idle). `PRIORITY` in `session-state.js` is
unchanged — this only changes which decay duration a renderer-side timer
picks, never the priority ladder.

**`seedRemoteActivity` (cold-start / rebuild paint) is migrated too, not just
the live-touch path.** Its own arm used to stay `PIP_DECAY_MS`-based
regardless of `agentsBusy`, computing `remaining = remoteActiveAt +
PIP_DECAY_MS - now`. `renderProjects()` calls `seedRemoteActivity` on every
full sidebar rebuild, and a rebuild is itself commonly provoked by the
subagent's own writes — so a parent whose short decay had *already* fired
got put back on the animated busy rung for up to 20s at the very next
rebuild (measured: touch t=0, spawn t=1000 reschedules the decay to fire at
t=4000, busy correctly false at t=4000, then a rebuild at t=5000 re-armed
busy for another ~15s). Fixed by using `remoteBusyDecayMs(sessionId)` in that
same arithmetic (`remaining = remoteActiveAt + remoteBusyDecayMs(sessionId) -
now`) — with `agentsBusy` true the seed window is 3s from `remoteActiveAt`
instead of 20s, so a seed older than that does nothing, exactly mirroring
what the live-touch path already does. A seed with `agentsBusy` false is
byte-identical to before (`remoteBusyDecayMs` returns `PIP_DECAY_MS`), which
is why `test/dom-sidebar-remote-activity-pip.test.js` (no subagent in any of
its fixtures) needed no changes.

**Accepted trade-off, not a bug: with a subagent running, a genuinely busy
parent can visibly flap between the `busy` and `agentsBusy` rungs.** If the
parent's own transcript stays silent for more than `SUBAGENT_PARENT_DECAY_MS`
(3s) — a long tool call — its `busy` decays to `agentsBusy` until the next
write brings it back to `busy`. Both rungs are violet-tinted
(`.has-busy-agents .session-icon--busy::before` / `.session-icon--agents-busy::before`),
so the visible change is animation only (spinner vs. static diamond), not a
color or row-class change. This is deliberate: the alternative — decaying at
the full `PIP_DECAY_MS` (20s) whenever `agentsBusy` is true — is exactly
issue #284's original symptom, a parent idling on `busy` long after it
stopped producing output. **The local-pty row has no equivalent gap**: its
busy signal is the OSC title stream, edge-triggered on the CLI's own
idle/busy transitions rather than decayed from silence, so it never flaps
while genuinely idle-but-subagent-running. This asymmetry between local and
remote is a known, accepted consequence of the remote-ssh adapter having no
edge-triggered signal to key off — only transcript touches — not an
oversight to fix later.

### Row ownership: attached vs unattached (issue #273)

An attached remote row (a tab open on it) is owned by the local-pty path —
OSC busy/idle/attention/response-ready, exactly like a local session.  An
unattached remote row is owned by the remote-ssh adapter — busy from the
watch channel and seed, decayed, never response-ready (no PTY to confirm a
turn ended). Only one side may write a given row at a time; `attached`
(above) is the arbiter, not a cosmetic fact.

Concretely, in `public/remote-activity-ui.js`: `markRemoteBusy`/
`decayRemoteBusy` (fed by remote-watch, remote-seed and the decay timer) are
a no-op while `remoteState(id).snapshot().attached` is true, and
`projectRemoteState` refuses to paint the row at all while attached — both
guards exist because two independent things write the row: the shared
`sessionBusyState`/`responseReadySessions` Maps (`setActivity`, called from
inside `markRemoteBusy`/`decayRemoteBusy`) and the adapter's own private
`createSessionState('remote-ssh')` snapshot (painted by `applyRemoteDescriptor`
on every render, regardless of what wrote busy last). Without both guards a
descriptor-only render (no new remote event at all) can still repaint a
stale, adapter-held `busy` value over whatever the local-pty path just wrote,
which is what produced issue #273's ~53-cycle response-ready flap on an
attached, otherwise-idle row.

`setRemoteAttached(id, false)` — the true→false handoff (tab closed or the
local ssh attach's own `pty.exit`) — clears busy at once instead of waiting
out whatever decay was in flight (previously up to 20s), and records a
per-session floor (`remoteSeedFloors`) so a
`seedRemoteActivity` call carrying the *same*, now-stale `remoteActiveAt`
(the process died; nothing refreshes it) cannot re-arm busy immediately
after the handoff. A genuinely newer `remoteActiveAt` — real activity that
resumes after detach — still arms busy normally.

Mutation-proven: stripping the three `attached`/`snapshot.attached` guards in
`markRemoteBusy`/`decayRemoteBusy`/`projectRemoteState` turns the response-
ready-flap replay in `test/remote-row-ownership.test.js` red; disabling the
`setRemoteAttached` handoff block turns the pty.exit/20s-tail replay in the
same file red.

**`setActivity()` is still called for remote ids in parallel**
(`markRemoteBusy`/`decayRemoteBusy` call both, when not attached) — see "The
local-pty adapter" below for what `setActivity` now writes underneath
`sessionBusyState`/`responseReadySessions`. Two readers were not migrated
onto a persistent adapter snapshot in this step, so removing the dual-feed
would regress them:
- `sidebar.js`'s `buildSessionItem` reads `sessionBusyState`/
  `responseReadySessions`/`attentionSessions` directly at initial paint.
- `app.js`'s grid-card busy dot (`updateRunningIndicators`'s `gridCards`
  loop) reads `sessionBusyState` directly.

Both are driven by the same `active`/`armReady` inputs as the adapter, so the
two projections never disagree in practice; the dual-feed is a known,
temporary duplication, not a race.

### The local-pty adapter

`public/session-activity.js` keeps one persistent `createSessionState('local-pty')`
per session id, in `localPtyStates` — same shape as `remoteSessionStates` /
`localTranscriptStates` above. `setActivity`/`clearUnread`/`setAttention`/
`syncLocalPtyAgentsBusy`/`rekeyActivityState`/`purgeActivityFor` all apply
events to it (`localPtyState(sessionId)`, auto-vivifying); every path ends in
`projectLocalPtyState(sessionId)` → `applyStateClasses()`, the same projection
the other two adapters use. The busy/waitingForInput/attention/responseReady
exclusivity invariant that `setActivity`'s bookkeeping used to encode by hand
(deleting from three independent collections in the right order) now lives
only in `session-state.js`'s `apply()` — `test/local-pty-adapter.test.js`
pins that forcing busy and response-ready (or attention and response-ready)
together is no longer reachable through the public API, only through
`session-state.js`'s own domain tests directly.

Inputs:

- **`busy` (OSC 0 / OSC 9;4)** — `setActivity(sessionId, active, via, opts)`,
  called from `app.js`'s `onCliBusyState` and `onTerminalNotification`
  ("waiting for your input"), and from `reconcileBusyState` (the
  `get-active-sessions` poll). `opts.armReady` and the "was this session
  focused" check are adapter-level judgments the pure domain cannot make on
  its own (it has no notion of `activeSessionId` or "was busy a moment ago");
  `setActivity` computes them and passes the result in as the `busy` event's
  `armReady`, the same contract the remote-ssh/local-transcript adapters
  already use for their own reasons.
- **`attention` (OSC 9, not a busy/idle notification)** — `setAttention(sessionId, on, via)`,
  called from `app.js`'s `onTerminalNotification` (set) and `clearNotifications`
  (clear). An `attention` event still clears `busy`/`waitingForInput`/`responseReady`
  (`clearExclusive()`, `session-state.js`) — clearing attention does not
  restore whatever was cleared. But the reverse no longer holds (**revised
  2026-09-13**): a `busy` event never clears `attention` — an OSC-0 busy
  title and an OSC-9 permission prompt are independent IPC streams, and a
  busy edge arriving mid-prompt must not silently dismiss it. `attention` is
  cleared only by an explicit `attention: false`. See the exclusivity
  invariant below "Shape" for the full statement.
- **`subagentSpawned`/`subagentCompleted`** — not a second IPC feed. `sidebar.js`'s
  `activeSubagentsByParent` (precise spawn/complete events plus a 60s TTL for
  a parent that stops emitting) stays the ground truth for the row-level
  `has-busy-agents` class and the per-agent `.running` toggle; `syncLocalPtyAgentsBusy(sessionId, active)`
  mirrors its live count into the adapter's own `agentsBusy` field from
  `sidebar.js`'s `reflectSubagentRunningState()` — the one repaint point every
  `activeSubagentsByParent` mutation (spawn, complete, the pty-gone bulk
  clear, and the TTL prune) already funnels through — so `snapshot()` is
  complete for a local row without a second, independently-decayed source of
  truth for the same fact.
- **`liveness`/`descriptorStatus`** — seeded on every icon paint from the
  session object's `status`/`statusUpdatedAt` (`snapshotForLocal`,
  `session-activity-dom.js`), the same two calls `applyRemoteDescriptor`/
  `seedLocalTranscriptDescriptor` make for the other two kinds.

**Two readers still bypass the adapter's snapshot on purpose** — see "Row
ownership" above for why removing them isn't free in this pass:
`sidebar.js`'s `buildSessionItem`/`buildSubagentItem` (initial paint of
`cli-busy`/`response-ready`/`needs-attention`/`has-busy-agents`) and `app.js`'s
grid-card busy dot read `sessionBusyState`/`responseReadySessions`/
`attentionSessions` directly rather than `localPtyState(id).snapshot()`. Those
three names are no longer independent `Map`/`Set` instances, though — they are
thin views over `localPtyStates` (`.get`/`.has`/`.set`/`.add`/`.delete`/`.size`),
so a direct write through them (as `reconcileBusyState`'s initial poll, or a
test's precondition setup, legitimately does before any row or `setActivity`
call exists) lands in the same persisted object `snapshotForLocal`/
`paintSessionIcon` read from.

#### Decided: attention supersedes and consumes the unseen-response state

**Behavior change, not a regression to fix.** Before this migration,
`responseReadySessions` and `attentionSessions` were two independent `Set`s: a
row could carry both `response-ready` and `needs-attention` at once (CSS gave
`needs-attention` visual precedence over `response-ready`), and clearing
attention left `responseReadySessions` untouched — the row fell back to
showing `response-ready`, "Claude finished, you haven't looked", because that
fact had never actually been erased underneath the attention overlay.

Concretely, the old sequence: session goes idle unseen (`response-ready`
armed) → an OSC 9 notification fires (`needs-attention`, drawn on top) → the
user handles it and attention clears → the row reverts to `response-ready`,
because the unseen-response fact was still sitting in the Set the whole time.

Now the two facts live as fields on one persisted object
(`localPtyState(id)`), and `session-state.js`'s `apply()` treats `attention`,
`busy` and `waitingForInput` (which `responseReady` is a subset of) as
mutually exclusive: setting `attention: true` calls `clearExclusive()`, which
zeroes `responseReady` along with `busy`/`waitingForInput`, not just the
rung the icon happens to render. Clearing attention afterwards does not
restore it — the row lands on plain idle, not back on `response-ready`. Same
sequence today: idle unseen → attention fires (response-ready fact erased,
not just outshone) → attention clears → idle, unread marker gone.

This is a deliberate consequence of unifying local-pty into the same domain
model the remote-ssh/local-transcript adapters already used (`test/session-state.test.js`'s
pre-existing "exclusivity: attention while busy..." pins the same
`clearExclusive()` behavior for those kinds) — not something to special-case
back for local-pty. Read "attention" as *consuming* whatever unseen-response
state it interrupts, the same way going busy again already consumed it before
this change. `test/local-pty-adapter.test.js`'s "attention after
response-ready, then clearing attention does not restore response-ready" pins
this exact scenario so a future reader finds it intentional, not a bug to fix.

One remaining consequence flagged, not fixed: `.has()` on
`attentionSessions`/`responseReadySessions` (the legacy views above) now means
"that facet is currently true", not "was ever added and not yet removed" — no
shipped behavior currently depends on reading a stale `responseReady`/`busy`
value after an attention transition, but a future feature reintroducing that
combination would need its own domain field, not a Set-level workaround.

#### Decided: a local row idling while active (or with `armReady:false`) now shows "Waiting for input", not "Idle"

**Behavior change, kept deliberately.** Before this migration,
`snapshotForLocal`'s predecessor (`computeBusyReadyClasses` combined with the
throwaway per-render reconstruction) only ever applied a `busy` event to its
scratch domain object when the session was busy, or idle-and-unseen
(`responseReady`) — a session that went idle while **focused**, or via a
`setActivity(id, false, via, { armReady: false })` call, got no event applied
at all, so `waitingForInput` stayed at its default `false` and
`renderSessionIcon` fell through every named rung to the `idle` fallback:
empty glyph, title "Idle".

Now `setActivity` always applies a real `busy: false` event to the
**persisted** local-pty state on every idle transition, focused or not,
`armReady` true or false — `session-state.js`'s `apply()` unconditionally sets
`waitingForInput = true` on that branch regardless of `armReady` (`armReady`
only gates `responseReady`). So a focused session idling, or any session
idling via an `armReady:false` source, now resolves to the `waitingForInput`
rung: `session-icon--waiting`, title "Waiting for input" — where main showed
nothing (`idle`, title "Idle").

**Kept, not reverted**, because it converges local-pty with the other two
kinds: `remote-ssh` and `local-transcript` already report `waitingForInput`
(never `idle`) the instant they go quiet with `armReady:false` — a CLI
sitting at its prompt genuinely *is* waiting for input, whether or not
Switchboard currently has a tab open on it, and whether or not the last idle
edge happened to arm the unseen-response marker. The `idle` rung still exists
in `renderSessionIcon`'s priority ladder (a session `apply()` has literally
never touched resolves there, e.g. a brand-new `localPtyState()` before any
event lands), it is simply no longer reachable for a local session that has
gone through at least one busy→idle cycle.

`test/local-pty-adapter.test.js`'s "a local row going idle while active shows
'Waiting for input', not 'Idle'" and "...idle NOT active still arms
response-ready (unchanged)" pin both branches of the decision — the icon
slot's `session-icon--waiting`/`session-icon--response-ready` class and
title, side by side, so a future reader finds the split intentional.

### The local-transcript adapter (step 4)

`public/local-transcript-adapter.js` keeps one persistent
`createSessionState('local-transcript')` per session id, in
`localTranscriptStates` — same shape as `remoteSessionStates` above, pruned
by `pruneLocalTranscriptTimers()` (called from `refreshSidebar()` alongside
`pruneRemoteActivityTimers()`). Unlike the remote-ssh adapter it has no
watch-channel descriptor list to poll; its only inputs are:

- **`session-transcript-activity`** (`window.api.onSessionTranscriptActivity`,
  main.js's raw watcher callback — see "The `~/.claude/projects` watcher…"
  in `.ai/contexts/session-cache.md` and the channel doc in
  `.ai/contexts/ipc-bridge.md`): `transcriptTouched` + `busy: true`, then a
  20s decay timer (the same constant as the remote-ssh adapter,
  `PIP_DECAY_MS`/`LOCAL_TRANSCRIPT_DECAY_MS`, duplicated rather than shared
  across the two files — no common module currently holds cross-adapter
  constants) applies `busy: false, armReady: false` — never
  `responseReady`, exactly like the remote-ssh decay, because this adapter
  has no PTY to confirm a turn actually ended either.
- **The session object's own `status`/`statusUpdatedAt`**
  (`seedLocalTranscriptDescriptor`, called from inside the activity handler,
  reading `sessionMap.get(sessionId)`): `liveness: 'alive'` +
  `descriptorStatus(status, at)`, the same two calls `applyRemoteDescriptor`
  makes for remote-ssh. **This is a deliberate widening of the issue's
  original ports table**, which listed `descriptorStatus`/`liveness` as "no
  (no live CLI)" for `local-transcript` — written before `cli-session-state.js`
  (issue #245) established that a local session without a PTY *in this app*
  can still be a live CLI process elsewhere, discoverable via
  `~/.claude/sessions/<pid>.json` exactly the way `snapshotForLocal` already
  reads it for the local-pty kind. Feeding it here keeps the two kinds'
  snapshots consistent when a row transitions between them; neither field is
  consumed by `renderSessionIcon`'s priority ladder yet (see "Ports table"
  below), so this has no visible effect today beyond that consistency.
- **Nothing else.** No `attention`, no `waitingForInput` claimed from a
  completion signal — see the ports-table note below the table.

**The main-process half has its own two guards, in `local-transcript-activity.js`
(a pure factory, `createLocalTranscriptTracker`, unit-tested without Electron —
same pattern as `remote-activity.js`).** `sessionIdFromWatchParts(parts)`
only resolves a session id for a top-level transcript — exactly
`<folder>/<sessionId>.jsonl`, two path segments; a subagent leg
(`<parent>/subagents/agent-X.jsonl`, or the legacy `<parent>/agent-X.jsonl`)
has three-plus and is out of scope here (step 5, a separate issue). The
injected `hasPty(sessionId)` (main.js wires in `sessionHasPty`, which walks
`activeSessions` the same way `cli-session-state.js`'s `findSession` does —
skip `exited`, match `session.realSessionId || key`) skips a session the OSC
path already owns, mirroring the renderer-side guard below one layer down.

**Guarded against a PTY takeover in both directions**:
`onLocalTranscriptActivity` checks `activePtyIds.has(sessionId)` and refuses
to even allocate state for a session already carrying a PTY in this app (the
OSC path owns it — see `session-activity.js`'s `setActivity`, fed by
`main.js`'s OSC 0/9 parsing via `onCliBusyState`/`onTerminalNotification`, not
this adapter). Going the other way,
`app.js`'s `updateRunningIndicators()` calls `localTranscriptPtyTakeover(id)`
for a non-remote row the instant it transitions into `activePtyIds` (the user
opened it), which clears the pending decay timer and deletes the row's
adapter state — a stale decay firing later must not repaint a row the
local-pty path now owns. `updateRunningIndicators()` also force-repaints that
row via `paintSessionIcon()` in the same pass, so the icon slot doesn't wait
for the next OSC event to reflect the handoff.

Same non-writer discipline as remote-ssh: every path ends in
`projectLocalTranscriptState(sessionId)` → `applyStateClasses()`.

## Shape

Three files, one direction of dependency for data, the reverse for rendering:

```
public/session-state.js          pure domain — no DOM, no IPC, no electron
public/session-activity-dom.js   DOM projection — the only file allowed to
                                  write .cli-busy/.needs-attention/
                                  .response-ready/.has-busy-agents
public/session-activity.js       the local-pty adapter — one persistent
                                  createSessionState('local-pty') per session
                                  id (localPtyStates) + setActivity/clearUnread/
                                  setAttention/purgeActivityFor/
                                  rekeyActivityState/reconcileBusyState —
                                  calls into session-activity-dom.js to render
```

`createSessionState(kind)` returns `{ apply(event), snapshot() }`. `kind` is
`'local-pty' | 'local-transcript' | 'remote-ssh'` — all three are fed by a
persistent per-session-id adapter (`localPtyStates` / `localTranscriptStates` /
`remoteSessionStates`). Snapshot fields:

| field | meaning |
|---|---|
| `kind` | which adapter produced this state |
| `liveness` | `'alive' \| 'dead' \| 'unknown'` — is the CLI process running |
| `attached` | Switchboard holds a PTY / ssh attach for it — **separate from liveness** (2026-09-11 lifecycle decision: a row is active because the process is alive, not because a tab is open) |
| `busy` | OSC 0 — generating |
| `waitingForInput` | idle, sitting at the prompt |
| `attention` | OSC 9 — needs the user right now (permission/approval/plan) |
| `responseReady` | subset of `waitingForInput`: idle **and** unseen when it went idle (the legacy "Claude finished, you haven't looked" rung). Not in the issue's original field list — added because the priority order names it as its own rung, distinct from plain `waitingForInput`; see "Design notes" below. |
| `agentsBusy` | subagents running under this session |
| `lastActivityAt` / `lastActivitySource` | last touch — `transcriptTouched`/`descriptorStatus` events carry `at`/`source`; local-pty now feeds `descriptorStatus` too (`snapshotForLocal`'s seed from `session.status`), so this is populated on all three kinds. Not read by `renderSessionIcon` on any kind today. |
| `label` / `labelConfidence` | reserved, unused |
| `attachable` | reserved, unused |
| `archived` / `stale` | reserved, unused |

Invariant enforced by `apply()` (**revised 2026-09-13, adversarial review of
PR #282**): `busy` and `waitingForInput` (and `responseReady`, which only
means something under `waitingForInput`) are mutually exclusive — going busy
clears the other two. `attention` is **orthogonal to busy**: an `attention`
event still clears `busy`/`waitingForInput`/`responseReady` (unchanged), but
a `busy` event — either direction — never clears `attention`. `attention` is
exclusive with `responseReady` only, one-directionally: setting it clears
`responseReady` (consumes the unseen-response fact, see "Decided" below), but
clearing `attention` does not resurrect anything. Rationale: an OSC-0 busy
title and an OSC-9 permission prompt are two independent IPC streams: a busy
edge arriving while attention is pending must not silently dismiss the
prompt's indicator. `attention` is cleared only by an explicit
`attention: false` (`clearNotifications`) — never as a side effect of a busy
edge. `test/session-state.test.js`'s "exclusivity: going busy again clears
waitingForInput/responseReady but NOT attention" and
`test/local-pty-adapter.test.js`'s "a busy edge after attention does NOT
clear attention" pin this at the domain and adapter levels respectively.

`renderSessionIcon(snapshot)` resolves the priority order — attention >
responseReady > busy > agentsBusy > waitingForInput > idle+age > stale >
archived — defensively (it does not trust the caller kept exclusivity) and
returns `{ classes, slotClasses, glyph, title }` for **one icon slot**: only
the single winning rung's `classes`/`slotClasses`/`glyph`/`title` come back,
never a union across rungs. Every rung carries exactly one `slotClasses` entry
(`session-icon--attention`, `session-icon--response-ready`, `session-icon--busy`,
`session-icon--agents-busy`, `session-icon--waiting`, `session-icon--idle`,
`session-icon--stale`, `session-icon--archived`), the only thing `writeIconSlot`
reads — see "The icon slot (step 3b)" below. **`classes` is no longer read by
`applyStateClasses` for the row-level classes** (revised 2026-09-13, PR #282
review): `needs-attention`/`response-ready`/`cli-busy` are read straight off
`snapshot.attention`/`.responseReady`/`.busy` instead, because those three can
now coexist with `busy` (attention) in a way the single-winning-rung `classes`
array cannot represent — deriving row classes from the priority winner alone
was silently dropping `cli-busy` whenever `attention` also won the rung.
`classes` remains on the return value (pinned by `test/session-state.test.js`'s
priority-order tests) but has no other production reader today.

## The icon slot (step 3b)

One `.session-icon` element per session/subagent row (`public/sidebar.js`'s
`buildSessionItem`/`buildSubagentItem`), replacing `.session-status-dot` for
those two rows — `.remote-host-dot` (the project header's per-host
reachability indicator, a different row entirely) is untouched and still
composes `class="session-status-dot remote-host-dot ..."`; both base CSS
rules (`.session-status-dot`, `.session-icon`) exist side by side in
`style.css` for exactly this reason. `.session-icon`'s box (6px, same as the
old dot) is fixed regardless of rung, so the row never shifts as the glyph
underneath it changes.

`session-activity-dom.js` is the only file that writes the slot:

- `writeIconSlot(el, icon)` clears any previous `session-icon--*` class
  (robust to a rung's `slotClasses` shrinking or changing shape — a plain
  diff of the old vs. new class would also work but this needs no diffing),
  applies `icon.slotClasses`, and sets `el.title`/`el.dataset.glyph` from
  `icon.title`/`icon.glyph`. The `session-icon--*` namespace is deliberately
  distinct from the row-level `classes` (`cli-busy` etc.) both for the eslint
  boundary (see "Enforcement" below) and so a reader never confuses "this
  paints the row" with "this paints the slot".
- `session-activity-dom.js` also references `localPtyState` and `sessionMap`
  (`app.js`) now, alongside the pre-existing `sessionBusyState`/
  `responseReadySessions`/`attentionSessions` view objects (`session-activity.js`).
  Safe despite loading before `session-activity.js` in index.html's script
  order — every reference is inside a function body, resolved at call time
  after the whole page has loaded, same pattern `sidebar.js`'s own header
  comment documents for its dependencies.
- `snapshotForLocal(sessionId, session)` is a thin wrapper over the local-pty
  adapter's own persisted state (`localPtyState(sessionId).snapshot()`) — see
  "The local-pty adapter" above. It seeds `liveness`/`descriptorStatus` from
  `session.status`/`statusUpdatedAt` on every call, idempotently — cli-session-state.js
  only keeps an entry while the pid is alive (`.ai/contexts/cli-session-state.md`),
  so `session.status` being present at all is itself the local liveness
  signal; `session` is optional and falls back to a `sessionMap` lookup for
  call sites that only have a sessionId. `busy`/`attention`/`responseReady`/
  `agentsBusy` are already on the persisted state (fed by `setActivity`/
  `setAttention`/`syncLocalPtyAgentsBusy`), not recomputed here.
- `paintSessionIcon(el, sessionId, session)` composes the two:
  `writeIconSlot(el, renderSessionIcon(snapshotForLocal(sessionId, session)))`.
  Called from `sidebar.js` at row construction (both `buildSessionItem` and
  `buildSubagentItem`) and from `reflectSubagentRunningState` on the
  **parent** row (agentsBusy is part of the priority ladder the slot
  resolves, so a subagent spawn/complete must repaint the parent's slot, not
  just its `has-busy-agents` row class).
- `applyStateClasses(sessionId, snapshot)` — the single projection path all
  three kinds' transitions go through (`projectLocalPtyState`/
  `projectRemoteState`/`projectLocalTranscriptState`) — calls `writeIconSlot`
  with the same `renderSessionIcon(snapshot)` result it uses for the row's
  `needs-attention`/`cli-busy`/`response-ready` classes. This is what makes a
  local busy row and a remote busy row render the identical slot markup
  (classes, title, glyph), pinned in `test/dom-sidebar-icon-slot.test.js`.

The `.running` class on `.session-icon` is **not** part of this model — it is
the old dot's orthogonal "a PTY/subagent process is attached" boolean
(`activePtyIds`/`isSubagentActive`), toggled exactly as before by
`app.js`/`sidebar.js`, independent of `renderSessionIcon`'s priority ladder.

### The slot's CSS keys on its own rung class alone (coordinator follow-up, 2026-09-11)

First pass of this step left `style.css` still resolving the slot's visual
with row-class `:not()` chains carried over verbatim from the old
`.session-status-dot` rules (`.session-item.cli-busy:not(.needs-attention)
.session-icon`, `.session-item.has-busy-agents:not(.cli-busy):not(...):not(...)
.session-icon`) — exactly the row-class arbitration this migration exists to
retire, just renamed. `renderSessionIcon()` already picks the single active
rung in JS before `writeIconSlot()` ever touches the DOM, so the CSS never
needs to re-derive it: every rung's visual now keys on its own
`.session-icon--<rung>` class alone, no ancestor `:not()` chain —

```css
.session-icon--busy { background: transparent !important; animation: none !important; ... }
.session-icon--busy::before { content: "\280B"; animation: braille-spin ...; color: #4fc3f7; ... }
.session-icon--agents-busy { background: transparent !important; ... }
.session-icon--agents-busy::before { content: "\283F"; color: #8088ff; ... }
.session-icon--response-ready { background: #4fc3f7 !important; ... }
.session-icon--attention { background: #f0a050 !important; ... }
```

`background` (the only property `.session-icon.running`'s plain green also
sets) carries `!important` on every rung — busy/attention/response-ready/
agentsBusy rows are very often also `.running` (a busy session almost always
has a live PTY), and unlike the old code the rung is now a single class with
no extra row-ancestor classes to lean on for specificity.

**`has-busy-agents` is the one exception, and it stays row-level on purpose**
(point 1 of the original brief: "`.has-busy-agents` stays a row-level class
— a tint — but its glyph rung lives in the slot when nothing higher is
active"). A busy session with live subagents needs the busy spinner tinted
violet instead of its default blue; since `agentsBusy` never wins the JS
priority race while `busy` is active, there is no `session-icon--agents-busy`
class to key on in that case — so the tint is a **plain compound selector**,
row tint class + slot rung class, not a priority tie-break:

```css
.session-item.has-busy-agents .session-icon--busy::before { color: #8088ff; }
```

This is the only place a row-level class still appears next to `.session-icon`
in the slot's own visual rules, and `test/session-icon-slot-css-boundary.test.js`
allows it explicitly (it only forbids `:not(`, not row classes generally) —
the boundary is "no priority re-arbitration in CSS", not "no row class may
ever touch the slot's selector".

`test/session-icon-slot-css-boundary.test.js` source-greps `style.css`
(comments stripped first — a couple of them, including the one you're
reading in source, mention `:not()` in prose and would otherwise
false-positive a naive scan) for any selector mentioning `.session-icon` and
asserts none contains `:not(`; `.session-status-dot`/`.remote-host-dot` (the
project header's per-host reachability dot, a different row, untouched by
this migration) are excluded. Mutation-proven: reintroducing
`.session-item.cli-busy:not(.needs-attention) .session-icon--busy { ... }`
turns it red.

`test/dom-sidebar-icon-slot.test.js` pins the slot markup itself (mutation-
proven: swapping the `busy`/`agentsBusy` entries in `ICON_BY_RUNG` turns three
of its DOM tests red, plus the pure-unit tests in `test/session-state.test.js`).
The five tests named in issue #246's step 3b brief
(`dom-sidebar-local-status`, `dom-sidebar-remote-session`,
`dom-sidebar-remote-freshness`, `sidebar-busy-agents-tint`,
`dom-sidebar-remote-activity-pip`) needed no markup changes beyond
`sidebar-busy-agents-tint.test.js`'s CSS-selector regexes (retargeted first
from `.session-status-dot` to `.session-icon`, then from the row-class
`:not()` chains to the flat `session-icon--<rung>` selectors above) — none of
the others assert on the dot/slot element itself, only on row classes and
`.session-status`.

## Design notes (deviations from the issue's literal text)

- **`responseReady` added to the snapshot.** The issue's field list didn't
  include it, but the priority order names "response-ready" as a rung distinct
  from `waitingForInput` — impossible to reproduce with one boolean. Modeled
  as `waitingForInput`'s narrower subset (idle + not yet seen when it went
  idle), set via `apply({ type: 'busy', active: false, armReady })` — direct
  translation of the pre-existing `setActivity(id, active, via, { armReady })`
  contract in `session-activity.js`.
- **"Seen" (today's `activeSessionId` focus check) stays a caller decision,
  not a domain fact.** `attached` (introduced 2026-09-11) means "Switchboard
  holds a PTY for it", true for every open tab, not just the focused one — it
  cannot stand in for "the user is looking at this row right now". The
  `armReady` flag on the `busy` event carries that judgment in from the
  adapter, same as before the split.
- Ports (`attachable`, `label`, `archived`, `stale`) are implemented in
  `apply()` but **not fed by any adapter yet** — they exist so a future step
  doesn't need another domain-shape change. `transcriptTouched`,
  `descriptorStatus` and `subagentSpawned`/`subagentCompleted` are all wired
  now (see the ports table below) — this bullet used to list them too, before
  the local-pty adapter closed the last gap.

## Enforcement

- `eslint.config.js`: `no-restricted-syntax` selectors, in every `public/**/*.js`
  file except `session-activity-dom.js` (tests are a separate glob, exempt by
  construction), forbid the four class names (`cli-busy`, `needs-attention`,
  `response-ready`, `has-busy-agents`) in: `classList.add/remove/toggle/replace`
  (string or template literal), `className` / `innerHTML` / `outerHTML`
  assignments, `setAttribute(...)` and `insertAdjacentHTML(...)`; any computed
  `classList[method](...)` call is refused outright because it hides the name.
  Verified 2026-09-11 with a probe file: six bypass shapes red, an unrelated
  class name green, 0 errors on the real renderer. Not caught, by nature: a
  class name held in a variable or built by concatenation — a review item, not
  a lint item. All prior direct writers (`app.js`, `sidebar.js`,
  `session-activity.js` itself) were moved onto the DOM file's
  `setNeedsAttention`/`setResponseReady`/`setCliBusy`/`setHasBusyAgents`
  helpers so the rules start at zero violations.
- `session-activity-dom.js` resolves a busy + response-ready tie as busy
  (`main` resolved it as response-ready). The tie is unreachable: `setActivity`
  and `rekeyActivityState` keep the two sets exclusive before projection. Noted
  so a future invariant break is read as such, not as a projection bug.
- `test/session-state-boundary.test.js`: source-grep (no `require()`, same
  shape as `test/main-ctx-db-wiring.test.js`) asserting `session-state.js`
  never references `document`, `window`, `require('electron')` or `ipcRenderer`.
- `test/session-state.test.js`: apply-sequence, exclusivity, priority order
  (mutated once during development — reordering `PRIORITY` to put `agentsBusy`
  first turned the three top-rung priority tests red; reverted), and
  `renderSessionIcon` per rung.

## Ports table (target shape, not all wired yet)

| event | local-pty | local-transcript | remote-ssh |
|---|---|---|---|
| `busy` / `attention` (OSC 0 / 9) | yes — `setActivity`/`setAttention` | never | wired via the watch channel (transcript writes), not OSC — OSC-while-attached is not wired |
| `transcriptTouched(at)` | no — local-pty's busy signal is the OSC title, not a transcript write; a real PTY makes this port redundant for it | yes (only signal) — `onLocalTranscriptActivity` | yes — `onRemoteActivityEvent`/`markRemoteBusy` |
| `descriptorStatus(status, at)` / `liveness` | yes — `snapshotForLocal`'s seed from `session.status`/`statusUpdatedAt`, same two calls the other kinds make | yes — `seedLocalTranscriptDescriptor`, from `sessionMap`'s `status`/`statusUpdatedAt` (see "The local-transcript adapter" above for why this widens the issue's original "no (no live CLI)") | yes (`main.js:539` → `applyRemoteDescriptor`) |
| `attached` | reserved, unused | reserved, unused | yes — `setRemoteAttached`, driven by the per-row `activePtyIds` transition; also the row-ownership arbiter since #273 (see "Row ownership" above) |
| `subagentSpawned` / `subagentCompleted` | yes — `syncLocalPtyAgentsBusy`, mirroring `activeSubagentsByParent` (fed by `detectSubagentTransitions()` IPC) rather than a second IPC feed — see "The local-pty adapter" above | yes (issue #247) — `onLocalTranscriptSubagentActivity`, gated on the parent having no PTY | yes (issue #247) — `onRemoteActivityEvent({kind:'subagent'})`, attributed by `subagentParentFromParts()` |

An adapter without a PTY must never claim `waitingForInput` or `responseReady`
from a completion signal it cannot verify — that is why the remote-ssh and
local-transcript `busy: false` transitions always pass `armReady: false` (see
"The remote-ssh adapter" and "The local-transcript adapter" above), not a
tri-state `busy: unknown`.

## Placeholder rows (issue #278)

A remote-ssh row synthesized from a live descriptor with no transcript yet
(`main.js`'s `mergePlaceholderSessions`, `remote-index.js`'s
`getPlaceholderSessions` — see `.ai/contexts/session-cache.md`, "Remote hosts
— descriptor-only sessions") carries `placeholder: true` alongside the exact
same `remoteAlias`/`status`/`statusUpdatedAt` fields a real remote session
does. It goes through `annotateRemoteAttachable()` unchanged, so it gets
`remoteAttachable`/`remoteActiveAt` from the same descriptor and its lifecycle
is the ordinary remote-ssh one described above — nothing here adds a third
liveness/attach state. The only thing this row's absent transcript changes is
in the renderer: `sidebar.js` does not render the `.session-jsonl-btn` for a
`placeholder` row, since there is nothing to view.

## Surfacing status on the session object (`.session-meta` layout, issue #286)

`buildSessionItem`'s `.session-meta` row used to append `statusEl` only when
`session.status` was truthy, and the row was laid out with
`justify-content: space-between` — with two children (time, short id) that
pins the short id to the far right, with three (status appended) it lands in
the middle, so the short id visibly jumped depending on whether that session
happened to have a live process. `statusEl` is now always created (empty
`textContent` when there is no status), keeping the DOM order
(`session-time`, `session-short-id`, `session-status`) and child count
constant; the CSS dropped `space-between` for a plain `gap`, with
`margin-left: auto` on `.session-status` alone so it — not the short id —
is the element whose position depends on how much room is left.

## Known limits

- **The remote-stop pid-reuse guard is weak.** `remote-stop.js`'s
  `buildRefusalGuard` (and `remote-attach.js`'s probe it reuses verbatim)
  decides "is this still the claude CLI" with `grep -qi claude` against
  `/proc/<pid>/cmdline` — a process a user happens to launch with "claude"
  anywhere in its argv (not the CLI itself) passes the same guard and can be
  killed. Deferred, not implemented: hardening candidates are the `comm`
  field from `/proc/<pid>/stat` (the kernel-recorded executable basename,
  harder to spoof by argv alone) and the process start time (`/proc/<pid>/stat`
  field 22, jiffies since boot) compared against the descriptor's own
  recorded start time — a pid recycled fast enough to still say "claude" in
  argv is caught by a start-time mismatch even when the cmdline check is not.
