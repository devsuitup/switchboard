# Session state — one domain module, one icon slot

**Purpose**: `public/session-state.js` owns activity and unread transitions for
local PTY, local transcript and remote adapters. Shared projections select one
activity icon for each conversation head across sidebar, grid and terminal.

## Unchanged sidebar refreshes (#543)

`loadProjects` opts into `refreshSidebar({ skipUnchanged: true })` after committing
the current payload, pending-session reconciliation and activity poll. Explicit
refreshes and `resort: true` still render. Only the sidebar build/morphdom/event
rebinding is skipped; cache updates, notices, diagnostics and timer pruning run.

`renderProjects.unchanged` compares detached JSON fields captured only after
a successful render. The input payload (before preserved-order sorting) is
compared first and returns immediately on a change, before computing activity
overlays. All-project metadata has a separate JSON field. The overlay key
includes filters/search/archived mode, sort order, limits, active/pending sessions,
selection, remote host labels, archive operations, expanded groups and hidden
settings. Open-tab ids and each tab's closed flag are included, so eviction of
a closed tab immediately releases older-session Archive eligibility (#876).
The per-row older-archive keep reason uses the same predicate as the button,
including head/member remote liveness and descriptor fallbacks; row-level
liveness alone does not capture every eligibility change.
The keep-reason in the #543 skip key re-enables the older-archive button when eligibility changes; the open-tab key is a safety net (#893).
Storage is restricted to `expandedSubagents`, `expandedSubagentRest`,
`orphanExpanded:*` and the result of `getExpandedSlugs`.

Per-row overlays contain the projected icon, row booleans, subagent activity/counts,
background labels/badges, descriptor labels, detach availability and lifecycle
label, including exit corrections. Raw snapshots, write watermarks and hint
timestamps are not serialized: they invalidate only when their projection
changes. Payload fields changed in place are still detected, including new fields;
no mutable session references are retained in the key.

A MutationObserver conservatively invalidates the key for sidebar DOM changes,
including expansion controls whose state lives only in the DOM. This preserves
the existing morphdom rules on the next render. A 30-second clock bucket, local
date and each session's age-cutoff membership prevent time-sensitive filters
from freezing. Keys are not compared across an unsuccessful render. Remote
seeding and subagent pruning still run on every actual render; their independent
decay/TTL timers continue between renders. Additional state that affects row
construction must be represented in `sidebarRenderInputs` or invalidate the DOM.

Evidence: `test/dom-sidebar-unchanged-543.test.js` loads the shipped sidebar and
`refreshSidebar` through the standard jsdom helpers and spies on both the render
and morphdom boundaries. Its IPC-reply path also runs the actual staged poll,
busy reconciliation and running-indicator update. The 30-second label ticker
updates descriptor ages, including merged heads, without a sidebar rebuild and
preserves background activity labels. Time labels are written only when their
text changes, so a no-op ticker does not dirty the DOM through the observer
(#871/#876). The suite also exercises Mark as unread, an identical skipped
refresh, and Mark as read through `refreshSidebar({ skipUnchanged: true })`.
The same ticker refreshes remote-host dot titles through `remoteHostState`,
including confirmation ages, retry countdowns and capability details, without
rebuilding the sidebar. An equality guard avoids DOM mutations for unchanged
titles.
The ticker uses `renderProjects.lastProjects`, the exact input retained immediately
after morphdom, including narrowed search sessions and Show archived projects.
If event rebinding or grid refresh then throws, ticks still describe the payload
already in the DOM; the skip key remains invalid until a complete render (#915).
It does not recalculate host live counts from the default project cache.
`folderId(projectPath, remoteAlias)` preserves local ids and encodes the remote
alias/path tuple for remote groups. Headers prepend `ph-` to that id; ticker
lookup, event binding, nested worktrees, archive busy keys and morphdom's group,
header and list keys share this identity. The #543 skip key includes these
alias-aware archive busy keys through `archivingGroupIds`.
Project and item ordering retains the remote alias in `sortedOrder` and uses
`projectStateKey`: local keys remain the exact project path, while remote keys
use `folderId(projectPath, remoteAlias)`. Orphan expansion (`orphanExpanded:`)
and orphan rest expansion (`o:` in `expandedSubagentRest`) use the same key,
including nested worktrees. Existing local persisted expansion survives unchanged;
remote projects start with independent state rather than adopting the shared
path-only state. Schedule groups already use an encoded alias/path/slug tuple;
their identity and migration remain unchanged. Evidence:
`test/dom-sidebar-host-state-915.test.js` and the post-morphdom failure cases in
`test/dom-sidebar-unchanged-543.test.js`.
Grouped grid headings also use `projectStateKey` in `data-project-key`, both
when laying out sidebar rows and when inserting a newly opened card according
to `sortedOrder`. `data-project-path` retains the original path. Same-path hosts
and local projects get separate headings; local keys and ordering remain paths.
Evidence: `test/dom-grid-host-headings-921.test.js` (#921).
Sidebar project names, grouped grid headings (layout and incremental opening),
and grid card project labels share `projectDisplayLabel` from `public/utils.js`.
Remote names prepend `remoteHostLabel(alias) + ': '` to the short path; local
labels keep the short path alone. Tests assert the rendered text, including
configured host labels, alias fallback and unchanged sidebar output (#925).
The skip-key table independently covers background agents, active
children, dormant rows, task counts, detach availability, both archive locks,
age-cutoff membership, the 30-second clock bucket and the local day string;
each added case is checked by dropping its own key term (#871).
`refreshSidebar.counters` tracks completed
renders and skips for the renderer lifetime; when debug tracing is enabled,
`sidebar.refresh` records `skipped`, `renders` and `skips`. Differences between
two counter samples give the skip rate over that interval, even after enabling
tracing at runtime. No trace event is sent while tracing is disabled.
Performance measurements are in the issue #543 report;
jsdom timings do not establish Electron performance on a real session cache.

## Manual unread and older-session Archive (#819)

The native row button toggles **Mark as unread** / **Mark as read** on the
conversation's head. `markUnread` is a reducer event: it sets `responseReady`
and `manualUnread`, without changing liveness or recorded turn evidence.
The head projection includes the local adapter's manual flag even when a
transcript or remote adapter supplies its other facts. Reading clears it;
real busy edges (including busy-to-idle with `armReady: false`), attention and
a new open head clear it through the reducer. Duplicate or late idle signals
preserve manual reminders and observed response-ready closures. Open-head and
attention projections clear only the local adapter's manual reminder, preserving
readiness recorded by the PTY. It uses the existing
Response ready slot, stays in renderer memory, and survives sidebar rebuilds
but not renderer reloads. The button is a normal Tab stop and uses the existing
focus-visible action strip (#574).

**Archive all older sessions** sits beside the keyboard-operable older-list
toggle. The older count includes the conversation rows actually listed inside
slug groups, excluding subagent rows. The batch captures unarchived older rows
and keeps the active session, every tab open here (including a closed tab),
sessions live elsewhere and remote sessions alive on their host. Membership
checks include the head and merged parts. Pinned, PTY-here and dormant rows
are also kept. Single-row Archive retains its existing stop policy.

The `appConfirm` title counts only eligible rows. Its body names eligible,
kept and refused sessions with reasons, caps each list at ten and adds
`+N more`. Local liveness and archive plans are checked before and after the
question and again per row; newly eligible rows require another confirmation.
Preparation never publishes errors. Refusals become notices only after a
confirmed run. With no eligible rows, a click shows one notice without asking;
the archive button is disabled when synchronous row facts leave no candidates.
Rendering does not query liveness elsewhere or background jobs; asynchronous
preflight runs only on click. Confirmed batches report kept rows by name and
reason in one info notice, including rows that become ineligible during the
post-confirmation and per-row rechecks. Successful rows still offer Undo. Filters
that show every item have no older action.

The older batch locks its toggle id, every nested slug group through
`archivingGroupIds`, and every row through `archivingSessionIds`, including
during confirmation and sidebar reconstruction. It shares the archive
confirmation recheck, refusal wording, per-row persistence errors and Undo.
Running or attached sessions are kept by the bulk action. Its preparation
checks rows individually so a refused background job stays unarchived while
other rows can still archive. Folder and
ordinary slug-group preparation retain their existing all-or-nothing preflight.

Evidence: `test/sidebar-features-819.test.js`.

## Persistent row action failures (#566)

Stop/Detach, Delete and Archive use `showSessionActionFailure` in
`public/app-notices.js`. The key includes the operation, host and session id
(folder Archive uses the project path). Errors have `role="alert"`, Dismiss,
the affected session/location, the backend reason and a recovery step. They
schedule no expiry and survive sidebar replacement and pointer leave. Stop's
Retry rechecks only the failed targets against current PTYs, open tabs and
remote liveness before confirming; an empty retry replaces the failure with
"Nothing is running to stop." A local `not running` response counts as stopped.
Cancelling confirmation retains the error; successful actions clear only their
own key. No focus is moved by showing a notice.

Delete refusals for external processes direct the user to the session's own
terminal at its project location. A backend refusal for a session running in
this window names Stop on its sidebar row. A guard's existing recovery is not
followed by a second recovery instruction. Remote Delete never stops a process
before the read-only refusal (#271: remote Delete). Remote rows do not append
the Delete button, and the row context menu offers no Delete. Main retains
`REMOTE_READ_ONLY` as a guard for direct requests. Confirmations remain questions.
Local live-background-job Archive/Delete refusals name **Stop session** on the
sidebar row when `planSessionStop` with `jobStop: true` targets that job. The
refusal reuses its cached job check. If Stop cannot identify that job or would
stop another process instead, recovery points to the Agents view. Detach
confirmations say the job keeps running without directing a stop elsewhere.
After successful Delete, pendingSessions is cleared before reloading so its
temporary row cannot be reinjected. An open tab is destroyed so it cannot remain
selectable after its transcript and sidebar row are removed.
Rejected IPC promises, unavailable operations and absent acknowledgements are
failures; Stop leaves local liveness/view state unchanged on failure. Archive
changes a row only after its persistence IPC succeeds. Folder stop refusals
still prevent all archives; persistence failures retain successful row archives
and keep the folder. Slug batches continue with other rows after a refusal.
An unreachable remote host retains the established archive-without-stop policy,
with one persistent warning per host listing affected sessions and an Unarchive
recovery step. The headline is Archived, but not stopped; Unarchive clears only
its member from that host's notice. A single-row Archive persistence failure
after a successful Stop explicitly says the process stopped but the row is not
archived. Folder partial success uses Archive folder partly done, refers to
schedule-*.md in Agent Files, and names Settings → Archived projects for restoring
the folder. Folder descriptions include the project path once.

Evidence: `test/dom-row-action-errors.test.js`,
`test/confirm-and-stop-session.test.js`,
`test/dom-sidebar-stop-before-archive.test.js`,
`test/dom-project-archive-folder.test.js`.

`markRestoreIndexingDone` keeps `Restore:pending` until its continuation retry
has run. A manual open cancelling that retry, two failed final reloads, or a
thrown retry move the affected members into persistent `Restore:batch` with
the reason and "Open it from the sidebar to retry restoring." Saved entries
remain held. See `test/restore-pending-notice-666.test.js` (#666).

If indexing finishes before an in-flight restore holds its continuation, the
end of `runRestore` still calls `markRestoreIndexingDone`, including when a
manual open has cancelled automatic retry. A thrown retry reports only members
still held and absent from open tabs. When no continuation remains held, the
pending notice clears, including after the final project reload.

## Conversation head turn and the single spinner (#625)

The row's animation is selected from its `headSessionId || sessionId`, with
three transcript states: `open`, `closed`, and `unknown`. `transcript-turn.js`
retains its existing `closed` API for trigger delivery and adds `state`.
An empty or unreadable tail, or one without a main-thread user/assistant record,
is unknown. A timestamped
main-thread prompt or assistant record supplies open evidence; `end_turn` or
plain `stop_sequence` plus a later `turn_duration`, an API error, an interrupted
request, or a local-command/manual-compaction closure supplies closed evidence
only when the queue is idle. Task notifications without an assistant reply do
not reopen a closed turn. Automatic compaction summaries are skipped so the
preceding turn survives; an isolated summary is unknown. Existing queued or
dequeued work prevents closure. The live head-turn canary alarms on the consumed
stop-reason/timestamp/duration pairing; an absent sample is explicitly skipped,
and does not validate the installed CLI.

The existing task-record worker reads a cached 256 KiB transcript tail after a
verified invalidation. Its task snapshot carries independently revisioned
`headTurn` evidence. The renderer applies turn evidence before the background
snapshot, rejects older turn revisions, and repaints on turn-state changes.
Liveness gates animation: a PTY here or a live descriptor is required. A background
descriptor `busy` may supply the busy slot when the head turn is open or unknown,
without writing head-turn state (#785). A closed turn from PTY or transcript
evidence wins over descriptor busy; a closed working turn retains its static
background work.
Job `working`, OSC spinner/progress and transcript touches
remain hints; they cannot open a head turn. An interactive idle descriptor or explicit OSC idle
is prompt evidence. Descriptor idle is ordered against the transcript's last
entry on the CLI host's clock. OSC idle is ordered against the latest changed
transcript evidence's arrival time in the renderer, on this machine's clock;
attached remote sessions therefore tolerate host clock skew. The worker carries
the transcript mtime as well as the last entry timestamp. Only a changed state
or last entry timestamp replaces the observation and records a head-turn touch
in the adapters. Mtime-only writes, including untimestamped bookkeeping and
oversized tails without readable timestamped evidence, retain the prior
observation time and adapter activity source. A newer observation
wins over OSC idle; a newer entry wins over descriptor idle. Busy signals and
transcript touches clear the prompt hint used for an unknown head only when
their time is strictly later than its descriptor-idle and OSC-idle timestamps.
Adapter busy events retain their originating activity time, and
reapplying the same idle descriptor does not restore a consumed hint.
An actual descriptor transition back to idle supplies a new hint, including
when the descriptor has no timestamp.
Untimestamped idle only resolves an otherwise unknown head. The 3 s/20 s adapter clocks retain
hints, but never close or reopen the projected turn.

`headActivitySnapshot` selects the authoritative icon inputs, while
`mergedRowSnapshot` retains the head's busy, prompt and unread states. Attention,
background work and row liveness may aggregate across members; an older
member's open turn cannot animate the head. When the head holds a PTY here,
its gate and observed ends decide the waiting state. When only older parts
hold PTYs here, the row waits after one of those parts' observed ends,
whatever the head's descriptor says; an open head prevents the ring. The head
keeps the spinner, response-ready state and its turn.
`taskRegistry.background` is the source of background work, including non-agent
kinds. For local interactive sessions, those include background Bash commands
paired with their transcript launch and result (#791); remote rows supply
turn state only and do not ingest transcript tasks. A live head outside an open
turn uses the waiting glyph only if its
PTY is elsewhere or Switchboard has observed a turn end since this PTY started.
A PTY-here row at rest otherwise shows the green running dot. Background work
keeps the static full-braille glyph. Attention owns the one slot first,
followed by Response ready.
An unseen confirmed closure keeps both the unread flag and its response-ready
glyph until read or consumed by explicit or descriptor-owned attention.
Maintainer decision (JB, 2026-10-14): retain the **● Response ready** glyph
and its existing priority. It may mask the static background-work glyph until
the row is seen. The slot has five visible states: animated, static, waiting,
attention, and response-ready.
Projection does not mutate stored turn evidence; event handlers replace it.
An unknown
live head cannot animate; its waiting glyph uses the tooltip "Turn state unavailable"
when there is no known background work. A PTY-here unknown head at rest reads
`Idle`. This does not implement #626 title colour
or #627 subagent counts.

An OSC-observed end is the local-pty adapter's `waitingForInput`, set by an
explicit busy-to-idle signal. A transcript-observed end is an `open→closed`
head snapshot observed in this renderer: `headTurns.ended` carries it across
later `closed` revisions, independently of focus and `clearUnread`. A first
`closed` snapshot, descriptor idle (`idleHintAt`, `promptHint`, including the
descriptor branch of `idleNewer`), silence and activity decays are not observed
ends. Rows live elsewhere keep `alive && headTurn !== 'open'`.

| Event | Observed-end effect |
|---|---|
| Head `open` | Clears `ended`; the busy rung wins until the next observed closure. |
| OSC busy / progress / reconciled busy | Clears the OSC end; a transcript end remains until the head opens. |
| Attention | Clears the OSC end and owns the slot while set. |
| Known head becomes `unknown` | `forgetObservedTurnEnd` clears both sources; `closed` without a new `open` does not restore an end. |
| PTY start (`beginPtyOpen`) | Clears both sources, the head's `endArmed` baseline and the adapter's `busy`; only a fresh `open` snapshot can arm a transcript end, while head state, revision and unread evidence remain intact. |
| Remote busy or decay | The remote adapter still updates, but both shadow writes to local-pty state are skipped while an unclosed tab is open here, including before the first PTY poll. |
| Remote attach edge | Repaints the row but forgets nothing; pruning a remote row can reset its adapter's `attached` flag without stopping its PTY. |
| PTY exit | The live-elsewhere rule applies once the PTY is gone; purge drops adapter state. |
| Typing without submitting | Does not write activity state. |

Neither source persists across renderer reload or app restart; a sidebar
rebuild keeps both. A re-key always moves local-pty state and moves the head's
`ended` only with `preserveHead`. A fork or `/clear` keeps an OSC end and drops
a transcript end. Background attach calls `beginPtyOpen` after re-keying,
clearing both ends while retaining head evidence and response-ready state.
Coverage: `test/green-dot-pty-here-714.test.js`.

The CLI also emits job fan kind `shell` (observed live on 2.1.296). The job
normalizer accepts it as the existing canonical `bash` kind; otherwise one
shell entry would invalidate the entire job's background snapshot. The
existing job-state canary covers this consumed alias alongside the offline
registry-to-static-glyph regression.

Both initial sidebar paint and incremental updates use this selection. Agents
view rows use the same turn and registry facts; job state alone supplies only
liveness. Its list repaints on turn changes and task changes while visible.
The legacy adapter snapshots and Map-like views retain their hint state for
other readers; they are not the sidebar's authoritative busy classification.

Local bootstrap reuses #624's positively live-owner transcript reads. Verified
local top-level watch notifications already reach the worker even when a PTY
owns the session. Remote bootstrap and every successful host refresh, including
cycles with no changed folders, read live, unarchived mirrored heads in one
`turnOnly` worker batch, without replaying
remote lifecycle records into #624's registry and without additional SSH calls
or per-row network polling. Cache rows identify their host through
`parseFolderKey(row.folder).alias` and children through `parentSessionId`;
archive state comes from the session-id-keyed `getAllMeta()` Map, read afresh
for each batch (#698). Host filtering compares the parsed alias exactly, so
refreshing `dev` excludes `dev2`. The refresh callback runs after any folder
scan, and the worker's stat cache avoids rereading unchanged transcripts.
Worker snapshots reach the renderer through the existing `task-snapshot` push
even when no project-change notification is needed. Remote head members receive
their own descriptor liveness. A descriptor missing from a successful host snapshot makes liveness
unknown without completing tasks; a failed host snapshot retains the previous
freshness contract. Remote turn precision is limited by mirror refresh: about
15 seconds with the host watch, otherwise the configured pull interval
(default 5 minutes). Worker turn retention is capped at 2048, oldest first.
Grid cards use the same `storedActivitySnapshot` / `mergedRowSnapshot`,
`paintSessionIconFromSnapshot` as the sidebar (#629). Their single
`.grid-card-dot.session-icon` carries the animated head turn, static background
work, attention or response-ready glyph and the same accessible tooltip.
The dot carries `running` from `activePtyIds`, like the sidebar icon.
`updateGridSubagentPills` retains its registry callback name and now paints
both activity and the authoritative agent count. `applyStateClasses` refreshes
matching cards after projecting a row, including when the sidebar row is absent;
`updateRunningIndicators` also calls it on every pass, outside the PTY-set gate.
The member-to-card index selects only matching cards for an individual update.
Card registration, re-key, removal and unwrapping maintain it; merged-row
indexing and sidebar rebuilds refresh membership. The periodic indicator refresh
visits each card once, with one session-map lookup per unmerged card.
Head selection uses the sidebar row or indexed merged row with the union of
rendered, indexed, mapped and opened conversation members. Written output
colours the card title blue under the same unseen/attention rule as the row;
existing terminal visibility and watermark checks consume it.

Footer lifecycle comes from the ranked `lifecycleLabel`: a PTY reads `Open here`
or `Attached here`, with the remote host or local background detail. Without
a PTY, finished jobs outrank live background jobs, live remote/local processes,
dead liveness without a recorded end, recorded exits and dormant restoration,
in that order. Unknown
evidence reads `Liveness unknown`; death without a recorded exit reads
`Not running`. `writeIconSlot` adds the same lifecycle to sidebar and grid
labels, then job or CLI detail, deduplicating whole segments without changing
the glyph. Dormant changes repaint through `syncDormantRow`. The status bar
counts `N open here`; the filter selects the same PTY population. Idle remains
a filled dot; open-here Idle adds a two-pixel satellite below it using shadow
geometry, and Not running scales the dot to a six-by-two-pixel dash without
changing its layout box, at half opacity. Waiting and dormant keep their
separate hollow rings.
Stop visibility and dispatch retain their existing PTY/live-row rule.
The snapshot also sets `has-busy-agents` on the card so the shared CSS rule
tints a busy head violet while agents run. The grid performs no lifecycle
ingestion or fallback expiration.
Coverage: `test/dom-grid-shared-activity-629.test.js` loads shipped app and
renderer functions for all four activity sources and their incremental updates.

A background continuation re-key moves the stored head-turn evidence to the
new UUID, retaining its revision, observation time and unread closure. A newer
destination revision takes precedence. The existing adapter object carries
the ordered descriptor/OSC prompt hints without replaying events or resetting
their clocks. The preserved sidebar row and session map select the new head
before projection, so the sidebar, grid and Agents view keep the same turn
and response-ready priority until fresh evidence or an explicit read arrives.
Ordinary continuations carry that evidence without preserving the source DOM
row. Fork and `/clear` retain fresh head evidence rather than inheriting an
unread closure from the preceding conversation.

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

### Folder Stop all (#843)

Project and nested worktree headers offer **Stop all**. The project action takes
every conversation row from the full cached folder and its nested worktrees,
independently of sidebar filters, and keeps the host alias in its scope. A
worktree's own action affects its folder only. Subagent rows are excluded;
merged parts remain one conversation, planned by `planSessionStop` with
`jobStop: true`. `validateSessionStopPlan` and `executeSessionStopTargets` are
shared with the single-conversation Stop in `app.js`; remote routing, job
preflight, attached-job handling and failure-state preservation stay identical.

One danger question names each candidate conversation and its locations, marks
mid-turn work using the existing row activity projection, and lists each
refused part with its conversation name and reason. A conversation with any
background job is refused as a whole by default, including its foreground
parts. This implements JB's 2026-10-30 decision: explain the refusal but allow
an explicit force. The existing `showChoiceDialog` option radios offer **Stop
all including background jobs** and **Stop the others only**, with the latter
selected and Cancel focused initially. The third outcome is Cancel. This is
the same chooser underlying `appChoose`, with its supported danger and initial
focus settings. With no background jobs, `appConfirm` asks once instead.
Background classification uses planned job targets that are still hosted, before
job preflight validation; ended attached jobs only detach their tabs. Refusal
wording never establishes that a conversation has a background job. In the folder
batch only, an idle part with unknown daemon state and no observed live process
is omitted, so an unreadable unrelated job cannot block a foreground conversation
or flood an idle folder with refusals. The omitted part may be the session's own
job in a state this build cannot read, so when nothing is left to stop the
"Nothing is running" notice counts the unchecked parts and gives the reasons. Unknown attached jobs and processes live
elsewhere retain their planner refusals; forcing never bypasses those checks.

Execution continues after individual failures. One persistent
`showSessionActionFailure('Stop all', project, ...)` notice names all failed
conversations and targets and offers Retry. Retry replans only failed targets
in the current folder, reconfirms once, and retains the existing job-stopped
state when only detaching its tab needs retrying. Empty retries say nothing is
running. Retry preselects the background-inclusive choice when a failed target
still needs its job stopped. Choosing the others when every candidate has a
background job reports how many conversations were kept and that nothing else
was running. One unreachable-host map is shared across all conversations in the
batch, and a fresh Retry gets a fresh map; single-row Stop keeps its own map.
Archived conversation rows remain in the full cached folder scope. No archive
or transcript deletion is performed.

Evidence: `test/dom-project-stop-all-843.test.js`; upstream inspiration:
Ali Basiri's ee656523 `confirmStopWork`.

### Per-conversation lifecycle

Two facts the domain carries separately: **process liveness** (the CLI is
running — local pid, or a remote descriptor with an ALIVE marker, #262) and
**attached view** (Switchboard holds a PTY / an ssh attach for it). A row is
active because the process is alive, not because a tab is open.

| verb | local-pty | remote-ssh |
|---|---|---|
| detach | not offered — closing a session's view is a stop (unchanged) | `stop-session`'s pre-existing behavior: `killPty` → the tmux adapter's `detach()` (`remote-attach.js`) — ends the local ssh client, optionally restores tmux options (solo attach, #256). Offered by the Detach control on an attached remote row, grid card and terminal header (#778), and still reached wherever `activeSessions` cleanup calls `killPty` on a `kind: 'remote-attach'` session without a preceding `remote-stop-session` call, and via `close-terminal`'s ordinary detach (marks `rendererAttached=false`, kills nothing). |
| stop | kill the PTY (`stop-session`, unchanged) | **new**: `remote-stop-session` IPC (`{alias, sessionId}`) — kills the process on the host itself, same control and same confirmation dialog as local. No session locked by name or role. |

**No new dialog component.** `public/stop-session-ui.js`'s async
`planSessionStop(row, { attach, retryTargets, backgroundJobs, jobStop = false })`
collects local PTYs, remote processes and background jobs. The sidebar passes its whole row;
`confirmAndStopSession` resolves the terminal header or grid card's id to the
owning conversation row, including when a stale per-tab entry remains cached.
All three surfaces use the same conversation-wide Stop plan, refusals, job
checks, confirmation and executor (#917). The row is resolved from the member
index, then the tab's own merged row, then any row listing it; only a tab no
indexed row knows falls back to its open entry's session. `resolveSessionStop`
still selects the IPC for each target and remains available to Archive/Delete.
Confirmed-dead remote members are filtered out unless their view is still
active; an unseeded host (`remoteHostAt === null`) is possibly live until a
dead snapshot says otherwise. Remote locations use the saved host label;
IPC retains the alias.
For Stop, an open tab's own session determines its route; a member without a
tab keeps the route derived from its row. Merges never span hosts
(`scopedConversationRows` drops links across project or folder, and a remote
folder key carries the host alias), so the tab-first rule is defensive.
Remote Stop clears the tab's `detachRequested` before invoking the host stop:
an exit arriving during that call reads Stopped even if an earlier Detach
succeeded or returned `not running` without delivering its exit yet. A failed
host stop (unreachable, error, rejection) restores the pending Detach; an
accepted `session not found on that host` keeps it cleared.

`app.js`'s `confirmAndStopSession` asks once with danger styling, the number
of processes, each part's id and location, and the consequence: each stopped
process ends, while the conversation is kept and can be resumed. Only Stop
sets `jobStop:true`: attached and live unattached background parts become job
targets with a validated 8-hex id. Each hosted job passes
`checkBgAgentVerb('stop', jobId)` before the dialog.
After confirmation, `runAttachedJobVerb` marks a local attached entry
`jobEnding = 'stop'` before `bgAgentVerb('stop', jobId)` runs, then
`stopSession` closes its attach client and the roster refreshes. The Agents
view uses the same helper for its attached Stop/Delete verbs.
`applyProcessExit` uses the Stop intent for local attach exits even before the
stop IPC records an exit as requested, so the banner reads Stopped. While the
verb is pending it also preserves the original exit code, signal and intent.
A failed job verb restores the previous mark; if an exit arrived during the
await, it rewrites the recorded exit and appends its corrected banner through
the existing `writeSessionExitBanner` formatter (for example, Exited (code 7)).
The appended banner explicitly says "correction: previous exit status superseded"
so the earlier provisional Stopped line no longer states the final status (#782c).
An open tab stays open on failure and the caller shows its failure notice.
If only closing the client fails after the job stops, the mark stays for its
eventual exit and the tab-only retry (#782).
An attached job reported `known:true, job:null` is only detached after a dialog
line saying it is not running in the daemon and its tab detaches. This path
does not set `jobEnding`, never calls the job verb and records Detached.
Processes outside this window and unreadable background-job ownership are
excluded and explained before confirmation. With no targets, exclusions are
shown as a notice without a confirmation. An invalid job id or an unknown job
check is excluded with its reason, never treated as nothing running.

`planSessionDetach(row, {tabOnly})` collects open background attach tabs and
open remote attach tabs (#778). `detachSession` never confirms, sets
`detachRequested` and calls `stopSession`. Row, card and header have separate
neutral eject buttons, with explicit title and accessible name; visibility
refreshes on sidebar render/running indicators, card activity and header update.
`detachSession` refuses a tab or merged row while any targeted tab has a
`jobVerbPending` action, with an informational notice to wait. Like the Agents
view's in-flight verb guard, this refuses a concurrent verb before sending IPC;
it releases in `finally` on both success and failure. Detach after a failed Stop
therefore remains available and reads Detached (#782b).
Background and remote attaches offer Detach; a plain local PTY does not. Local
and remote Stop retain their previous routes, and no new shortcut is introduced.
Each successfully detached tab shows a 10 s Undo notice (`kind: 'undo'`).
Before detaching, the executor captures that tab's session, job id and attach
cwd; Undo calls `openSession` with those attach options. A remote tab's Undo
reopens the captured row through the ordinary open path, and only when it is
`remoteAttachable`; otherwise the notice is information only, naming the host. Both initial attach
and background handoff retain the actual cwd as `entry.attachCwd`, falling
back to the session project path. A merged-row Detach ignores local parts;
Undo reattaches only its successfully detached tabs.

The stop IPC accepts detach before the local attach client exits. The executor
sets `entry.detachComplete` before the IPC; `applyProcessExit` closes the entry
and resolves it through `entry.completeDetach`. An early Undo waits for this
notification before reopening, so it cannot show the client being detached.
A failed detach retains Retry without offering Undo.

Cancel makes no stop calls. The executor attempts every target, clears PTY
and remote state only after success, and reports all failed parts in one
persistent notice with Retry. A retry builds a fresh plan. Archive and Delete
keep their existing `stopBeforeArchive` behavior. Archive calls the planner
without `jobStop`, preserving its attach detach route and confirmation text
byte for byte. Stop failures and retries retain their Stop notice identity;
Detach failures and retries use Detach.

### Opening a session once

A sidebar Open targets the conversation head. An older dormant member cannot
replace that target (#918); opening clears the row's dormant markers. The existing
reuse of an already open conversation tab and explicit restore/attach targets
is preserved. Coverage: `test/conversation-controls-917.test.js`.

`openSession` keeps the open of each session id in flight in `openingSessions`
(id → `{ promise, byUser }`), set before its first `await` and removed when the
open settles. A second call for the same id while the first is still running
(a double click on a sidebar row, a repeated key, a restore reaching a session
the user just clicked) gets the same promise back instead of starting a second
`open-terminal`, so callers that read the result (`runRestore`) see the real
outcome. Without it, both calls passed the `openSessions.has` check before the
first `await`, and since `open-terminal` awaits the MCP server before it
records the PTY, the second request could start a second `claude --resume` on
the same transcript. The body is `openSessionNow`.

Only an equivalent open is joined. A user open (`automatic: false`) that finds
an automatic one in flight does not take its result: an automatic open of a
session live elsewhere refuses without asking, and the click must still ask.
It sets the click's flags (`continuationRetryCancelled`,
`sessionOpenedOutsideRestore`) at once, waits for the automatic open to
settle, then runs as usual, so it shows the terminal the automatic open made
or asks when that open refused. An automatic open joins any open in flight.

The key is the id the caller passed, which for a click is the id before
continuation resolution, while the restore passes the resolved one. So once
`resolveResumeSession` returns another id, the open waits for any open of
that id in flight and registers itself under it too; a click resolving to a
continuation the restore is opening then shows that terminal instead of
starting a second one.

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

### Archive stops after confirmation; Delete refuses live parts (#271, #565)

Folder, row and slug-group Archive share `confirmSessionArchivePlan`: plan all
parts before a dialog, refuse live/unknown background jobs, and re-plan after
an accepted dialog. Any new target gets another confirmation; the executor
also refuses a local or remote part starting after that recheck. Folder options
name running sessions and places (five targets, then +N more). An idle options
dialog is configuration without Undo; no options means immediate Archive with
Undo. After an actual stop, folder Undo says processes stay stopped, names
archived worktrees and schedules disabled, and invokes the timestamped folder
reverse path before restoring exactly this click's archived session flags.
An older session Undo loses only a re-archived row and retains its other rows.

`public/sidebar.js`'s archive call sites (`.project-archive-btn`,
`.slug-group-archive-btn`, `.session-archive-btn`) used
to call bare `stopSession` gated on `activePtyIds` — a detach for an attached
remote row, and nothing at all for an unattached one, while the archive
proceeded regardless. They now share `stop-session-ui.js`'s `stopBeforeArchive(session)`,
built on `resolveSessionStop` plus `isRemoteSessionAlive(session)` (the
`remote-ssh` adapter's own `remoteSessionStates` snapshot when one exists —
authoritative over a stale `session.remoteDescriptorSeen` right after this app
itself just stopped it — falling back to `remoteDescriptorSeen` otherwise):

For merged remote rows, main also sends `remoteMemberDescriptorSeen`, keyed by
member id. `stopBeforeArchive` uses each member's own flag for the descriptor
fallback, so an unseen representative cannot hide a live, unseeded member
(#556). Confirmed adapter liveness still wins; older payloads without this
map retain their existing fallback. A remote "session not found on that host"
reply still counts as done.

Main also sends `remoteHostAt` per remote session, the host's last successful
sync (null when it has not synced in this run, e.g. after a restart, when rows
come from the on-disk mirror). `stopBeforeArchive` treats a null `remoteHostAt`
as liveness unknown and calls `remoteStopSession` for that member unless the
adapter has confirmed it dead; `remote-stop-session` then refreshes the host
once (at most `REMOTE_STOP_SYNC_TIMEOUT_MS`, 20 s) and answers from the fresh
list. A host that does not answer (timeout, a failure of the ssh command itself (`remote-transport.js` tags only a
timeout, ssh exit 255 and a spawn error or exit -1 with `remoteTransport`; a
truncated inventory, any other non-zero exit and anything thrown by
`syncMirror` mean the host answered and are not tagged, so the archive is
refused with the error and "remove the host in Settings to archive without
checking"), or no
attempt finished after an in-flight refresh was awaited within the same bound;
an in-flight refresh that is the global one is retried with a forced
per-host refresh once it ends, since it skips hosts in backoff; the wait compares `getRemoteHostState(alias).attempts` with a snapshot taken at
the click, so a stale `lastError` never ends it) makes `remote-stop-session`
return `{ok:false, hostUnreachable:true, error}`; Archive is reversible, so
`stopBeforeArchive` turns that into `{ok:true, notStopped:[{alias,error}]}`
(asking the same host only once per row) and the caller archives anyway, then
`announceNotStopped` shows a notice naming the host through
`showAppNotice({ id: 'Archive:<alias>:not-stopped', kind: 'error', members, message })`
in `public/app-notices.js` (#566/S3). Its `Archived, but not stopped` wording
is unchanged. It uses `role="alert"` and remains until Dismiss or
`clearAppNotice`; a new batch merges into that host's notice by member operation id,
updating a repeated member's name and reason. A successful retry removes only its
member, and an empty group disappears, without a console error or
the old 15 s `showRestoreNotice` timeout. The shared brick also provides
15 s info and 10 s Undo notices. Detach Undo is wired in `confirmAndStopSession`;
row and slug-group Archive use the Undo variant through `showSessionArchiveUndo`
(see `docs/product/BUILDING-BLOCKS.md`, B8).
A host that answers but
refuses the stop, or a first sync that fails locally (mirror directory, index
scan; `lastErrorTransport` false), still returns `{ok:false}` and blocks the
archive. A host that
is stopped or no longer configured (`refreshHostNow` reports `reason: 'stopped'`
or `'unknown-host'`) answers "session not found on that host", so the row
archives silently. The Archive button is disabled
and titled "Checking the host before archiving…" while this runs (the folder and group Archive buttons too, kept in `archivingGroupIds` so a re-render re-applies them, plus each row they check; a folder or slug-group Archive asks an unreachable host once (`stopBeforeArchive`'s `unreachable` map, one per action) and marks all its rows busy before the first check; folder Archive is refused up front, with a message on its button, while a row of the folder is still checking, and rechecks after its dialog)
(`archivingSessionIds`, `public/sidebar.js`), and a second click is ignored.

| kind | alive / has PTY | call |
|---|---|---|
| remote | alive | `remoteStopSession(alias, sessionId)` |
| remote | not alive | nothing — `{ok:true}` |
| local | has PTY (`activePtyIds`) | `stopSession(sessionId)` |
| local | no PTY | nothing — `{ok:true}` |

A `{ok:false, error}` return skips that session's archive/delete and surfaces
the failure through `showSessionActionFailure`, a persistent B8 notice naming
the affected session, the reason and how to retry. `confirmAndStopSession`
uses the same notice brick.
For slug-group Archive, `planSessionArchive` checks every local part's
background job before any dialog or effects. A live job, an unknown answer,
or a rejected check refuses the whole action. The plan then reuses
`planSessionStop` for each row. If any plan has targets, one danger
confirmation counts rows and running processes and names all targets without
embedding a second Stop question. Cancel stops and archives nothing. After
confirmation, planning runs again; newly live targets require another
confirmation naming them. No targets means immediate Archive. Execution checks
every part's current liveness and refuses an unconfirmed live part, and
rechecks background-job refusal before each row's stops.
Runtime stop or persistence failures skip that row and report the failure;
other rows can still archive. The folder action retains its options dialog
and its existing all-or-nothing archive after stops.

Every successful row or slug-group Archive offers a ten-second Undo, even
after confirmation. It calls `persistSessionArchive(session, 0)` only for
the captured successful rows, excluding already archived rows and failures;
it never reopens a process. A later successful Archive of any captured row
clears the older Undo notice so it cannot reverse that later action. Stop
results carry `didStop`, including partial failures; only an actual stop adds
the notice's "stay stopped" suffix. Unreachable hosts, absent processes and
detached tabs do not count as stopped. Its `archive-sessions:` notice id is outside `loadProjects`'
`archive-project:` reconciliation, so an older reload cannot clear it and
no load-generation stamp is needed. Busy sets remain held through planning,
confirmation, stopping and persistence, including across sidebar rebuilds.

The project header's confirmation names the host alias(es) it is about to stop, computed
with the same `isRemoteSessionAlive` check.

**Delete never calls `stopBeforeArchive`.** The renderer checks `rowSessionIds`,
including the representative, for a live PTY, non-closed tab or stored alive
snapshot before requesting the preview. It shows a persistent refusal notice
with no dialog or stop: each part with a PTY or open tab here says to stop it
first, while a part alive only by snapshot says to return to its own terminal
and end it there. A mixed refusal names each part with its recovery. The
asynchronous `delete-session-preview` then runs
the full `deleteSessionGuard(id, partIds)`, using the same member snapshot as
target resolution: background jobs, live-elsewhere and unknown-state refusals
also arrive before any dialog. The action retains its own full guard. Remote
deletion remains refused (`REMOTE_READ_ONLY`). The dialog has no promise to
stop anything. Refusal notices leave focus on the opener; dismissing a notice
from its button restores that focus.

**Delete covers every part of a merged conversation.** Preview returns its exact
part ids and confirmation sends those ids back through preload. Deletion takes
one snapshot from `getMergedMemberIds`, checks it against the preview, passes it
explicitly to the main-side liveness guard and refuses if membership changed
while awaiting that guard. Target resolution and disk removal then run without
an intervening await. An unresolved part refuses the whole deletion with a reason.
Members are removed before the representative, with each subagent directory
before its transcript so a failed removal leaves the representative visible.
Cache/search/touched and subagent entries are cleared for every fully removed
part even on failure; the failure names removed and remaining parts and offers
Delete again. Only successful deletion clears the confirmed parts' renderer
pending/open state. The confirmation counts transcript files separately from
subagents, and a refused preview reaches the persistent failure notice before
any dialog opens.

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

When the descriptor is missing and this host has never completed a poll
(`getRemoteSessions(alias).at` is null), the handler first awaits
`refreshHostNow(alias, {force:true})` and reads the descriptor list again
(#556). If a first poll still has not completed (failed, skipped, or already
in flight), it refuses with the host error or "not yet synced with this host";
Archive keeps the row and the attach PTY. If the poll finds the process, the
normal stop and successful-stop PTY cleanup run. Absence after a completed
poll keeps "session not found on that host" counted as done; this path still
does not close the local attach. Tests exercise the shipped handler, real
indexer and sidebar Archive with an injected sync port, without SSH or Electron:
`test/remote-stop-cold-cache.test.js`, `test/dom-remote-merged-archive.test.js`.

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
  `busy: false, armReady: false` — decay never creates a verified closure
  or unread response. Head-turn snapshots can establish these independently. Tested in
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

### Descriptor-owned attention (issue #394)

A CLI that has a blocking dialog open (permission prompt, question,
elicitation) writes `status: "waiting"` to its descriptor — see
cli-session-state.md. OSC 9 does not reach Switchboard from a tmux pane on a
host, so the descriptor is the only signal an unattached remote row has.

`applyRemoteDescriptor` passes `attention: true` on its `descriptorStatus`
event. Only the remote adapter does: local callers send the same event without
it and never get attention from the descriptor reducer. Background projections
separately map a live `waiting` descriptor to attention without applying that
event to the state machine (#785). The reducer's rule:

- `waiting` with `attention: true` and liveness not dead sets attention,
  clears busy / waitingForInput / responseReady like an `attention` event, and
  records that the descriptor owns it.
- Any other status (`busy`, `idle`, `shell`, none), a `liveness: dead` event,
  or an `attention` event releases it — but only when the descriptor owns it. An
  attention raised by an explicit `attention` event is never cleared by a
  descriptor, and that event takes ownership over a descriptor-set one.
- Busy edges and transcript touches never clear it (attention is orthogonal to
  busy and outranks it), so a busy decay cannot erase an open dialog's state.
  The status leaving `waiting` is the one thing that clears it.
- Descriptor absence is a null status on the session object, which releases it;
  an unattached row whose descriptor disappears loses the attention at the next
  refresh. `applyRemoteStopped` also clears it.

Two more releases keep it from freezing:

- The attached true to false handoff releases descriptor-owned attention. The
  reducer keeps following the descriptor while a row is attached, so without
  this a dialog answered in the PTY would repaint a stale orange on detach; the
  next descriptor re-asserts it if the session still waits.
- A host in error keeps its last descriptors (freshness contract), so
  `renderProjects` passes the project's `remoteHostError` and the descriptor
  event then carries `attention: false`, which releases descriptor-owned
  attention for the whole outage. A fresh host passes `attention: true`.
  The indexer notifies the renderer when a host's last error changes (first
  failure, a different error, recovery), not only when files changed, so the
  gate applies without an unrelated render.

The sidebar render replaces row classes from the rebuilt row (morphdom takes the
new element's classes), so `buildSessionItem` reads the unattached remote
adapter's snapshot for attention, busy, response-ready and the icon slot on
every fresh build, through `storedActivitySnapshot`. A sidebar refresh now
preserves those indicators for unattached remote rows as well as local
transcript rows; seeding alone would be wiped at the next render.

Attached rows are untouched: `projectRemoteState` still refuses to paint them,
and the local-pty path owns their attention. The sidebar's status line appends
`waitingFor` while the status is `waiting` (`waiting · permission prompt · 3m
ago`). Latency is the refresh cycle, not the dialog.

### Remote activity hint retention (#284, #625)

The remote adapter retains file-touch hints for 20 seconds, shortened to
3 seconds while an agent hint is present. Each touch re-arms its timer; a
subagent touch can shorten a pending parent timer. Cold-start seeding uses the
same duration. These timers only expire adapter hints. They do not select the
single spinner, infer a prompt from silence, or interrupt a silent tool call.

The head transcript selects animation for both remote and local rows. A newer
idle descriptor or explicit terminal idle hint can neutralise open evidence;
a newer head entry reopens it. Background work is read from taskRegistry,
including non-agent kinds. Spawn/completion bookends therefore cannot make
the head oscillate between animated and static states just through clock decay.

### Row ownership: attached vs unattached (issue #273)

An attached remote row (a tab open on it) is owned by the local-pty path —
OSC hints and attention, exactly like a local session. An unattached remote
row is owned by the remote-ssh adapter for descriptor and watch hints. Both
project the same mirrored head-turn evidence; a confirmed unseen closure can
set Response ready. Only one adapter may paint a row at a time; `attached`
is the arbiter.

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
`sessionBusyState`/`responseReadySessions`. The grid and `buildSessionItem`
read the selected adapter snapshot; the grid no longer relies on this legacy
dual-feed for its activity glyph.

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

**Some readers still use the local-pty views** — see "Row ownership" above:
`buildSubagentItem`'s row classes read
`sessionBusyState`/`responseReadySessions`/`attentionSessions` directly.
`buildSessionItem` uses `storedActivitySnapshot` and `mergedRowSnapshot`
for its activity classes and icon; subagent attribution still supplies its
`has-busy-agents` class. Those
three names are no longer independent `Map`/`Set` instances, though — they are
thin views over `localPtyStates` (`.get`/`.has`/`.set`/`.add`/`.delete`/`.size`),
so a direct write through them (as `reconcileBusyState`'s initial poll, or a
test's precondition setup, legitimately does before any row or `setActivity`
call exists) lands in the same persisted object `snapshotForLocal`/
`paintSessionIcon` read from.

#### Written output and title colour (#626)

The title's blue colour belongs to unseen written head output, independently
of busy, attention, turn closure and background work. The response-ready ●
glyph retains #638's priority and consumption policy; it no longer colours
the title. Attention has visual precedence, and clearing it reveals any
still-unseen blue title.

The domain reducer carries a monotonic written watermark and a seen watermark.
Only a writtenActivity event advances the former; writtenActivitySeen consumes
at most its captured watermark. A delayed clear or render callback cannot
consume a newer write. Session-activity keeps this facet in a separate map so
adapter takeover, descriptor loss, terminal teardown and sidebar rebuilding
cannot reset it. Initial and incremental row projections select #564's head
identity. They never aggregate child transcript text or older members' unread.
Both activity and environment re-keying move the watermark to the new id.
There is no restart persistence.

For every head, including attached PTYs, the existing worker's cached transcript tail carries
a digest of the latest complete main-thread output record: assistant content,
tool results, task notifications or local-command output. The first snapshot
establishes a baseline. A changed digest advances unread; unchanged reads,
watch events, mtime-only updates, descriptors, scans, sidechains, bookkeeping
and background existence do not. Incomplete JSONL records wait for a newline.
The existing bounded tail and mirror-refresh limits still apply. PTY data is
used only to acknowledge rendered output, never to detect written activity:
spinner and timer frames, resize repaints, attach/history replays and input
echo cannot advance the written watermark.

The written-output digest extends the tail backwards to a complete record
boundary only when the bounded tail has no complete output record. Complete large tool results
therefore contribute their content digest, while partial writes, large
metadata and child records retain the usual filtering. This can read more
than 256 KiB for a single oversized record. Turn classification and timestamp
evidence still use only the original bounded tail.
Reads carrying a compaction cursor retain their tail-plus-cursor I/O budget
and defer oversized digests. A later read without that cursor refreshes the
digest even when file metadata has not changed.

Seen means the output was rendered and the page is visible, even without
keyboard focus, at its latest position. A terminal write callback records
the watermark captured for that batch. A digest arriving after the render
also advances the rendered watermark when the terminal is visible at the
bottom, with no queued flush, hidden replay or write callback pending. A
digest arriving during a write waits for its callback. Scroll, focus,
visibility, reveal and grid intersection events recheck those conditions.
A single terminal must be active; a grid card must be at least 99% within the
viewport. Scrolling above the latest output preserves unread. Transcript
reads capture the watermark before IPC; their static main viewer consumes
only that captured watermark after rendering at the bottom of a visible page.
Later digests cannot advance the viewer's watermark without another read.
Empty reads and nested child transcripts cannot consume them.
The existing explicit clear consumes its capture without a visibility
requirement. Single-view and grid selection instead pass watermark zero:
they clear notifications, while output is consumed by the visibility check
after reveal. A newer write after a captured clear stays unseen. Rendering a
grid card only advances the written watermark's seen state; attention and
the response-ready glyph keep their existing focus/clear policy. The terminal
seen check returns before style queries when there is no unseen writing.

Coverage lives in test/session-written-activity.test.js and
test/written-output-validation.test.js, alongside the updated reducer, local
PTY and head-turn attention tests. The existing glyph policy is intentionally
still covered separately.

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

#### A session main drops (issue #375)

Main dropping a local-pty session (`process-exited`, then `activeSessions.delete`)
is the one moment the renderer's running state for it has to end — in the
sidebar row, the status bar and the activity state. The `pty-gone` purge in
`updateRunningIndicators()` only runs when the running-set *signature* changes,
so it could not be the only owner: a `cli-busy-state` or notification that lands
after a poll already removed the id (a CLI stuck in an API retry loop keeps
rewriting its title while it is killed) re-armed `cli-busy` on a row the
signature gate then never revisited, and the status bar's `N running` was only
redrawn by `loadProjects()`.

- `onProcessExited` (`app.js`) removes the id from `activePtyIds`, calls
  `dropLocalPtySession(id, 'process-exited')` for a non-remote row, and runs
  `updateRunningIndicators()` at once instead of waiting for the next poll.
- `dropLocalPtySession` (`session-activity.js`) is the single drop: live
  PTY-source subagents first (`clearActiveSubagentsFor(id, 'local-ipc')`), then
  `purgeActivityFor`. Attach transport exits preserve agents. Since #623,
  `updateRunningIndicators` calls this helper only for previous-to-current
  PTY removals, including hidden rows, rather than every non-running local row.
  Unattached merged members and unrelated transcript rows retain their state.
  Purge deletes only `localPtyStates` and its activity sequence, then projects
  surviving transcript/remote snapshots and source-tracked agents; rekey moves
  agent provenance with PTY state. See subagent-observability.md, "PTY cleanup
  provenance", for the per-agent source contract.
- `updateRunningIndicators()` calls `renderDefaultStatus()` whenever the set
  changed, so the status bar count follows `activePtyIds`.

**Pty generation.** `wireSessionPty` (`main.js`) gives every spawn the next value of
a monotonically increasing counter (`session.generation`). It is returned by all
three `open-terminal` replies and sent as the fifth argument of every
`process-exited` (the fork re-key's second send included). `app.js` records the
generation of the last reply per id (`ptyGenerations`) and `handleProcessExited`
ignores an exit older than it — no drop, no `closed`, no banner. An exit that
lands while `openSession` awaits the reply is buffered (`pendingOpens`);
`settlePtyOpen` then applies it unless the reply's generation is newer, so a
stale exit never touches the new pty and a fast-failing launch still reads
as exited. Chosen over suppressing the event in main because main cannot know
which exit the renderer has already seen when it is delivered.

Remote rows stay with the remote adapter (see "Row ownership"). Not covered: a
busy signal that arrives after `process-exited` — main sends none, the PTY is
gone. The pre-fix sequence is reasoned from the code, not reproduced live;
`test/dropped-session-state.test.js` pins each step.

### The local-transcript adapter (step 4)

**Verified watch notifications (#621).** `createLocalTranscriptTracker` takes
`projectsDir`, `hasPty` and `onActivity`; `record(parts)` returns a promise and
the callback delivers both immediate and trailing activity. A named watch
notification invalidates indexing independently, but cannot itself light a
row. The tracker asynchronously opens only that transcript, keeping its
device/inode/birth-time identity and size/write-mtime watermark. Both handle
and path stats use BigInt identities and nanosecond timestamps (#648): NTFS
file IDs can exceed Number's exact range, and NTFS tunnelling gives a file
recreated under a just-renamed name the old creation time, so birth time
does not tell a replacement apart on Windows. Rounded IDs must not authorize
activity for a different file. On first
sight, a nonempty file whose write mtime is at or after tracker creation
minus `FIRST_WRITE_MTIME_ALLOWANCE_MS` (2 s for clock/filesystem resolution)
supplies activity; older files establish a quiet baseline. The cutoff stays
anchored to tracker creation, so a write first observed later still counts.
Later growth or an advancing write mtime supplies activity after asynchronous
handle/path metadata verification, without reading transcript content.
Access time is ignored. Identity, size and write mtime must match across
the check; if identity stays unchanged and size/mtime only advance, the
tracker keeps its baseline and pending delivery and retries the dirty file.
An advancing write mtime covers same-size rewrites anywhere in the file.
This is write-metadata evidence, not a byte comparison: a metadata-only
operation that advances write mtime can therefore signal activity; a
read-only access-time update cannot.

Truncation, replacement, backwards write mtime, deletion and open/stat failure
invalidate the baseline and pending activity quietly, without a turn or
completion event. Each file's asynchronous verification is serialized and
concurrent notifications request another check, rejecting stale results.
The existing 1 s throttle keys remain a session UUID for a parent and
`sub:<parentSessionId>` for a child. The last verified update in a window is
retained and its file is reverified before trailing delivery; PTY ownership
is checked again then. `dispose()` cancels pending delivery at actual quit.
Distinct-child throttling and cache lifetime remain #622's responsibility;
this is not a new scan worker or a historical transcript scan (#616).
Disposable-file regression tests cover the tracker and the shipped projects
watch callback in `test/local-transcript-activity.test.js` and
`test/main-local-transcript-wiring.test.js`.

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
  The reducer retains `waitingForInput: true` as a legacy hint. The head
  projection requires turn closure or descriptor/OSC prompt evidence to show
  **Waiting for input**; unknown live heads show **Turn state unavailable**.
  Silence neither ends an open turn nor proves an unseen response.
  A fresh sidebar row and later icon repaints read `storedActivitySnapshot`
  (including `localTranscriptStates`) before falling back to `snapshotForLocal`;
  `mergedRowSnapshot` uses that same adapter selection for merged members.
  Re-rendering preserves the adapter's state and its pending decay timer
  while its process has not been observed to end.
- **The session object's own `status`/`statusUpdatedAt`**
  (`seedLocalTranscriptDescriptor`, called by activity/decay handlers and
  `storedActivitySnapshot` on every build or repaint, using the supplied
  session or `sessionMap.get(sessionId)`): `liveness: 'alive'` +
  `descriptorStatus(status, at)`, the same two calls `applyRemoteDescriptor`
  makes for remote-ssh. **This is a deliberate widening of the issue's
  original ports table**, which listed `descriptorStatus`/`liveness` as "no
  (no live CLI)" for `local-transcript` — written before `cli-session-state.js`
  (issue #245) established that a local session without a PTY *in this app*
  can still be a live CLI process elsewhere, discoverable via
  `~/.claude/sessions/<pid>.json` exactly the way `snapshotForLocal` already
  reads it for the local-pty kind. Feeding it here keeps the two kinds'
  snapshots consistent when a row transitions between them. Liveness drives
  `is-alive`, including on the first render before any transcript activity:
  the descriptor's PID is checked by `cli-session-state.js`, so it is a real
  live-process signal, independent of whether the CLI is writing.
  If a previously alive session loses its status or session entry, both local
  adapters reset liveness to unknown, so `is-alive` clears without asserting
  a death. The local-pty fallback is blank; the transcript adapter retains
  no prior activity inference after a loss: its state and both timers clear
  immediately, preserving the #573 base contract. This sacrifices Waiting
  across an actual loss of the source, since unknown cannot prove the
  previous inference still holds. A transient read error while the known
  PID is alive instead retains the descriptor main-side. Decay deletes
  re-created transcript state only when this session previously lost an
  observed live descriptor, projecting the local fallback rather than Waiting.
  The descriptor-loss marker survives decay so late parent/subagent writes
  remain bounded, and clears on a returning descriptor, PTY takeover or prune.
  A session that never had a descriptor stays unknown; its transcript-driven
  activity hint survives refreshes, but unknown liveness cannot animate a head.
  Child-row attribution retains its separate, existing 60s TTL. An active PTY
  keeps ownership.
  `main.js` includes `mergedMemberStatuses` for every local merged member;
  `dedup` refreshes or clears existing members' `sessionMap` statuses on every
  load, including members that once had a standalone row. A never-standalone
  member stays outside that map so restoration can still resolve its project
  path from the representative. `localSessionForStatus` reads its own fresh
  status from the owning row for both paints and transcript events. An index
  rebuilt by each dedup pass maps member IDs to the latest emitted rows in
  O(1), ahead of stale cached rows. If dedup has not run, a rendered owner
  takes precedence; the last matching map row is the fallback. The normal
  merged stop/delete paths use the index rather than scanning sessionMap.
  The representative's status is never borrowed by a hidden member.

- **Head-turn snapshots** come independently from the task-record worker.
  They supply verified closure and unread response evidence to the shared
  projection. Adapter touches and silence remain activity hints.

**Registration waits for `app.js`.** The adapter script loads before `app.js`, and its handler reads `activePtyIds` (declared in `app.js`), so the script does not register the listener itself: `app.js` calls `initLocalTranscriptAdapter()` right after its own state exists, next to the other `window.api.on*` listeners (`test/local-transcript-adapter.test.js` pins the order). A `session-transcript-activity` message sent before that point reaches no listener and is dropped, which loses at most one busy signal: the main-process tracker emits at most once per second per session, delivers a throttled write in a trailing emission (#621), and re-emits on the next transcript write, so a session still writing is marked busy within about a second of `app.js` loading. Before this, such a message threw `activePtyIds is not defined` in the renderer (issue #415). The other `window.api.on*` registrations in scripts loaded before `app.js` read only state owned by those scripts or by earlier ones, so none needed the same change.

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

The domain event `turnEndForgotten` clears `waitingForInput` and, when its
`busy` option is true, the adapter's `busy`; it leaves all other fields alone.
`forgetObservedTurnEnd` applies it only to an existing local-pty entry and
clears `headTurns.ended` without creating adapter state.

| field | meaning |
|---|---|
| `kind` | which adapter produced this state |
| `liveness` | `'alive' \| 'dead' \| 'unknown'` — is the CLI process running |
| `attached` | Switchboard holds a PTY / ssh attach for it — **separate from liveness** (2026-09-11 lifecycle decision: a row is active because the process is alive, not because a tab is open) |
| `busy` | adapter activity hint; projected busy requires a live, open head turn |
| `waitingForInput` | adapter prompt hint and OSC-observed turn end; projected waiting uses head and ordered idle evidence and, for an id with a PTY here, an observed turn end since that PTY started |
| `attention` | OSC 9 — needs the user right now (permission/approval/plan) |
| `responseReady` | subset of `waitingForInput`: idle **and** unseen when it went idle (the legacy "Claude finished, you haven't looked" rung). Not in the issue's original field list — added because the priority order names it as its own rung, distinct from plain `waitingForInput`; see "Design notes" below. |
| `agentsBusy` | subagents running under this session |
| `lastActivityAt` / `lastActivitySource` | last touch — `transcriptTouched`/`descriptorStatus` events carry `at`/`source`; local-pty now feeds `descriptorStatus` too (`snapshotForLocal`'s seed from `session.status`), so this is populated on all three kinds. Not read by `renderSessionIcon` on any kind today. |
| `idleHintAt` / `promptHint` | latest idle descriptor or explicit OSC idle timestamp, and known prompt hint |
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
`responseReady` (consumes the response-ready glyph state, see "Written output and title colour" below), but
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

Waiting uses `content: attr(data-glyph)` in an absolutely positioned `::before`
inside the unchanged 6px slot. Its transparent background and absent box-shadow
use `!important` to beat `.session-icon.running` and the terminal-row halo;
`animation: none` keeps it static. Idle has an empty CSS rule so every slot
class remains declared; `.session-icon--idle.running` adds a small dot below
the green dot to distinguish Open here. Not running (`stale`) is an opaque
grey dash (`scaleY(0.333333)`); archived keeps the dim base dot.
Selectors depend only on `session-icon--<rung>`, with no layout measurement.

| Rung | Slot class | Glyph / look | Produced on |
|---|---|---|---|
| attention | `session-icon--attention` | orange `--state-waiting` blinking LED and halo | sidebar, grid and header |
| responseReady | `session-icon--response-ready` | cyan glowing dot | sidebar, grid and header |
| busy | `session-icon--busy` | blue animated braille spinner, violet with busy subagents | sidebar, grid, header and Agents |
| agentsBusy | `session-icon--agents-busy` | violet static braille cell | sidebar, grid, header and Agents |
| waitingForInput | `session-icon--waiting` | orange `--state-waiting` hollow `○`, no halo or animation | sidebar, grid, header and Agents |
| idle | `session-icon--idle` | no glyph; green with `.running` — a row or grid card whose PTY is here, at rest | sidebar, grid, header and live idle Agents jobs |
| stale | `session-icon--stale` | opaque grey dash | finished background jobs without a live descriptor, across session surfaces |
| archived | `session-icon--archived` | base filled dot at 0.5 opacity | reserved, unused |

The busy braille animation pauses while the window is hidden or unfocused
(#544). `session-activity-dom.js` reuses `document.hasFocus()` and native
window focus/blur, document visibilitychange and window pointerdown,
pointermove and keydown events (capture, passive), synchronously toggling
`busy-spinners-paused` on the document element at startup and on every event.
CSS pauses only `.session-icon--busy::before`, across sidebar, grid, header
and Agents, including icons rendered after the pause. Busy/attention state,
glyphs and labels do not change. The animation resumes as soon as the document
is both visible and focused; see ADR 0002. The regression is
`test/dom-busy-spinner-pause.test.js`.

`--state-waiting` lives in `:root` and reuses the existing attention orange;
the attention slot and summary also reference it. The UI has one shared dark
palette, no light-theme overrides; terminal themes change xterm only. Waiting's
hollow ring differs from idle's filled dot without relying on colour or opacity.
Green retains its existing live-process meaning through `.running`.

Sidebar session and subagent rows receive `data-glyph` from `writeIconSlot`.
The Agents view uses the same slot classes and now includes the domain glyph
in its row markup (`agentRowIcon` / `renderAgentRow`, `public/agents-view.js`).
`agentRowIcon` also adds `.running` when its existing `live` boolean is true.
Finished background sidebar rows without a live descriptor produce stale (Not
running); rows lacking both a finished job state and a live descriptor read
Liveness unknown. Archived remains reserved.
Grid cards use the same slot classes on `.grid-card-dot.session-icon`; their
footer separately describes liveness and attachment (#629).

The terminal header uses `#terminal-header-status.session-icon` and the same
6px slot CSS, with only margin and cursor overrides. `updateTerminalHeader`
forgets old exits when a PTY is present, then calls `paintTerminalHeaderStatus`.
The painter uses `renderSessionIcon`, `writeIconSlot` and `rowLifecycleLabel`
(the ranked `lifecycleLabel`) to write `<activity> · <lifecycle>` in both title
and accessible name, with `role="img"`. It omits the sidebar-only CLI suffix.
Recorded Detached, Stopped and exit details survive in the lifecycle; missing
liveness with no exit reads Liveness unknown, rather than inferring death from
an absent PTY. Stop/Refresh controls and exit banners retain their own roles.

`applyStateClasses` repaints the active header alongside the row, reusing the
merged snapshot and rendered icon. An update from any member of the active
conversation refreshes it; unrelated rows leave it alone. With no sidebar row
(for example a filtered row), an update for the active session still projects
its supplied snapshot. Updates for another member look up `localActivityRow`
and check `rowSessionIds` for the active session, then repaint the header from
the stored merged conversation state.
The hot path performs no DOM query, poll, timer or layout measurement for the
header: a rowless session costs two map lookups, and it returns immediately when
there is no header or the session is unrelated.

`session-activity-dom.js` is the only file that writes the sidebar slot:

- `writeIconSlot(el, icon, title, text)` clears any previous `session-icon--*` class
  (robust to a rung's `slotClasses` shrinking or changing shape — a plain
  diff of the old vs. new class would also work but this needs no diffing),
  applies `icon.slotClasses`, and sets `el.title`/`el.dataset.glyph` from
  `icon.title`/`icon.glyph`. An optional nonempty `title` overrides the tooltip
  only. The accessible label keeps the icon's own title plus optional short
  status `text` when it differs from that title. Sidebar background rows use the tooltip for activity, job state,
  job-update metadata and in-flight kinds; their status text is empty while
  working unless the head needs attention, with concise labels for attention,
  idle, blocked, terminal or unavailable
  states; attention and blocked remain visible even with invalid activity evidence
  (#702; see `bg-agents.md`, "Job activity"). Initial construction,
  `applyStateClasses` and `paintSessionIcon` retain that detail. Other surfaces
  keep the ordinary activity title. The `session-icon--*` namespace is deliberately
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
  `setAttention`/`syncLocalPtyAgentsBusy`). If a previously alive local session
  loses its status and has no active PTY, the cache is replaced by a blank dead
  state, clearing those flags and waiting-for-input.
- `storedActivitySnapshot(sessionId, session)` refreshes the local descriptor
  state, then selects active PTY, unattached remote, local transcript, or local
  fallback, in that order. It also reconciles a cached transcript descriptor.
- `paintSessionIcon(el, sessionId, session)` uses that selection and
  `mergedRowSnapshot`, then writes the resolved icon slot. `buildSessionItem`
  uses the same selection directly for row construction. `buildSubagentItem`
  calls `paintSessionIcon` for the child; `reflectSubagentRunningState` calls
  it on the **parent** row (agentsBusy is part of the priority ladder the slot
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
.session-icon--attention { background: var(--state-waiting) !important; ... }
```

`background` (the only property `.session-icon.running`'s plain green also
sets) carries `!important` on the active rungs — busy/attention/response-ready/
agentsBusy rows are very often also `.running` (a busy session almost always
has a live PTY), and unlike the old code the rung is now a single class with
no extra row-ancestor classes to lean on for specificity. Waiting similarly
overrides the running fill and halo. Idle has no override; stale and reserved
archived only apply opacity and do not need `!important`.

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
| `transcriptTouched(at)` | no adapter touch; independent head-turn reads still apply | yes (activity hint) — `onLocalTranscriptActivity` | yes (activity hint) — `onRemoteActivityEvent`/`markRemoteBusy` |
| `descriptorStatus(status, at)` / `liveness` | yes — `snapshotForLocal`'s seed from `session.status`/`statusUpdatedAt`, same two calls the other kinds make | yes — `seedLocalTranscriptDescriptor`, from `sessionMap`'s `status`/`statusUpdatedAt` (see "The local-transcript adapter" above for why this widens the issue's original "no (no live CLI)") | yes (`seedRemoteActivity` → `applyRemoteDescriptor`, `public/remote-activity-ui.js`) |
| `attached` | reserved, unused | reserved, unused | yes — `setRemoteAttached`, driven by the per-row `activePtyIds` transition; also the row-ownership arbiter since #273 (see "Row ownership" above) |
| `subagentSpawned` / `subagentCompleted` | yes — `syncLocalPtyAgentsBusy`, mirroring `activeSubagentsByParent` (fed by `detectSubagentTransitions()` IPC) rather than a second IPC feed — see "The local-pty adapter" above | yes (issue #247) — `onLocalTranscriptSubagentActivity`, gated on the parent having no PTY | yes (issue #247) — `onRemoteActivityEvent({kind:'subagent'})`, attributed by `subagentParentFromParts()` |

Remote-ssh and local-transcript decay pass `busy: false, armReady: false`.
These are hint transitions; silence supplies neither a closed turn nor unread
response evidence. The separate head-turn snapshot and ordered prompt hints
select Working, Waiting for input, or Turn state unavailable. Loss of a
previously observed live descriptor gates animation and waiting with unknown
liveness, without completing tasks.

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

`buildSessionItem` writes the descriptor waiting reason (when `status` is
`waiting`) plus `formatStatusAge(statusUpdatedAt)`, joined with ` · `, for
rows without a background activity label. This includes local and remote rows
and sessions running elsewhere. Without a reason the line shows the age alone;
without a status it is empty. For a merged row, `localSessionForStatus` selects
the head member's descriptor, including its waiting reason and timestamp,
instead of the root part's descriptor.

`applyStateClasses` writes a background activity label when one exists. Without
that label it refreshes the descriptor line only when
`backgroundActivityIsForeground` holds; other rows retain their rendered line.
`paintSessionIcon` refreshes the icon without writing the status line. All three
paths select the same head descriptor. Their descriptor condition is `!label`
(`!bgActivity` in the initial painter), which also covers remote rows and rows
live elsewhere, rather than only foreground rows. Background labels retain
their own presentation; icon refreshes also exclude subagent rows.

The sidebar activity icon keeps its activity label first; `writeIconSlot`
appends exactly one `CLI status:` suffix with the raw descriptor status and
waiting reason to its tooltip and accessible name when a descriptor is supplied.
Grid icons deliberately keep only the shared activity tooltip and accessible
name, without this sidebar descriptor suffix. The #629 parity tests compare
the shared activity portion and assert the suffix count separately.

## Proven continuation re-key

All renderer identity changes (initial detection, fork, /clear, continuation and
background handoff) enter `rekeySessionTab`. Its `rekeySessionEnvironment` call
moves the file panel, written activity, session metadata, PTY generation/open
state, restore bookkeeping, panel-shell ownership, terminal buffers and grid
card before selecting the new id. Activity keeps the event-specific reset or
preservation policy. The terminal's write buffer is rescheduled under the new
id; hidden replay data and LRU position survive unchanged.

`test/session-rekey-renderer.test.js` loads the shipped event handlers and
renderer modules, exercises all five transitions, and enumerates top-level
terminal/panel containers with an AST. A new Map, Set or array needs an explicit
policy in that inventory; WebGL warmth holds entry objects, and redraw markers
are immutable configuration rather than session keys.

`showTerminalHeader` captures the session id before awaiting settings/profiles.
It checks active ownership after each await and in the error path before writing
the shell label, including the automatic-profile hide operation.

For a proven background move, capture map key/object, effective source id,
target/job, folder and exit drain before invoking metadata or the confirmation
callback. Metadata ACK precedes publication; the independent callback requests
source index persistence even when the target is already live. Callback failures
cannot escape detection or metadata cleanup. Synchronous background adapters use
the same guards as ACK adapters; ordinary synchronous transitions keep their
existing behavior.

After ACK the first failed guard is reported in order: `source-replaced`,
`source-id-changed`, `target-live`, `source-stopped`, `background-proof-changed`,
`background-job-gone`. Metadata remains committed on refusal. A live target
returns false from background detection, allowing fork/clear and known-file
updates; no identity, alias, MCP, activity or PTY transfer occurs. Completed
copies may be reused on a later genuine detection. Pending/copy/refusal reasons
use deduplicated ordinary info logs per tuple, including metadataCopied status;
write/callback failures use error. No Diagnostics toggle is needed.

`session-transitions.js` scans the active transcript with
`scanContinuationIndex` from `session-continuations.js`. Every valid
`continued-in` target is considered, including transcripts already in
`knownJsonlFiles` when the tab opened. A record alone cannot move a tab:
`clearOwner(target, pty.pid, { closestWriter: true })` must return `mine`.
This opt-in check accepts only the descriptor writer closest to the PTY;
nested CLI jobs below that writer cannot take its tab, including when the
PTY pid is itself the CLI writer. On Linux, every
descriptor encountered, including one on the PTY pid, must have a `procStart`
matching field 22 of the live process's `/proc/<pid>/stat`. A missing,
unreadable or mismatched start leaves ownership `pending`. An older Linux CLI
that writes no `procStart` never re-keys (fail-safe). Windows retains
the `win32:anchor` creation-time check. Other `clearOwner`
callers retain their existing policy. A target already held by a live tab is
left alone. The check relies on published descriptors; it cannot identify a
descriptorless CLI among shell ancestors.

Re-keying is supported for native Windows tabs and Linux outside the Linux
sandbox. WSL tabs on Windows are excluded: their descriptors are not in the
Windows descriptor directory.
Sandbox descriptors contain pids from their own namespace, which this host
process cannot reliably match to its PTY. On macOS the CLI publishes no
`win32:anchor` evidence; the opt-in check returns a cached `unsupported`
verdict without running `ps -A` or keeping a recheck timer alive. Neither
case re-keys the tab, so a trigger addressed to the new id can still fail
with `session not found`.

`pending` and `absent` use the existing one-second /clear recheck timer while the target
transcript is less than 60 seconds old. `unknown`, `other`, and errors do not
re-key. Incomplete source indexing uses the same timer until the source is
fully scanned, including old transcripts. Each scan consumes at most 1 MiB
and resumes from its cached offset. A malformed EOF is retried only while
the source is fresh; missing process ancestry is `pending`, never cached
as a definite `other`.

An `other`, stale `absent` (no live descriptor names the target), or `unsupported`
verdict is cached per tab and target transcript until that file's
mtime or the set of descriptor `(sessionId, pid)` pairs changes. The identity
is read once per detection pass from live descriptors; status changes and
process-table refresh notifications do not invalidate it. Identity and
ownership share one full directory snapshot per detection pass, including
descriptors beyond the agents view's 1000-file cap. Only a matching live
descriptor starts a Windows process-table refresh. An `other` result from a
table whose read began before the target descriptor's mtime is `pending`
instead, allowing a later table to prove ownership. No such cache is used
when descriptor identity is unavailable.

A proven continuation uses the same `rekeySession` operation as fork and
/clear: it moves `activeSessions`, records `currentSessionId` resolution,
re-keys MCP and activity, and resets subagent scanning. The existing
`session-forked` renderer handler receives kind `continuation`, moves the
open entry and sidebar mapping to the new id, and schedules working-set
persistence with that id. It keeps the conversation metadata; only /clear
creates a fresh-session placeholder.

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

## Accepted row projections and reloads (#719)

Activity uses one exact row/job selector across sidebar, grid, Agents and local
transcript adapters. Job evidence stays separate by job ID until selection;
independent OSC/transcript/agent facts remain independent. Marker, exact attach,
current-head identity and unique-head selection have that priority; ambiguity or
explicit conflicts yield unavailable. Preserve #714's PTY-here observed-end gate
and #728's blocked waiting evidence, including while attached.

Dedup retains the representative object reference and renderer runtime stores.
Received backend keys plus known handoff keys form the projection inventory:
fresh omission deletes old optional fields, explicit null/false/[] survives and
self-alias inputs are captured before clearing. The member index is rebuilt from
accepted lists; hidden members keep their own existing status-refresh behavior.

Request generations and committed generations are separate. N publishes unless
a newer generation already committed; newer starts/failures cannot starve an
eligible completion. Projects/settings/terminal/poll facts are staged before the
synchronous commit. Obsolete replies never dedup, mutate pending/terminal state,
paint or observe diagnostics. Older admissible commits paint immediately while
the newest pending request retains the Refreshing indicator. A newest failure
does not remove accepted lists. Public callers follow the newest settlement
transitively, even while their older operation remains independently admissible.
Restore planner requests coalesce once per effective accepted generation; failed
generations request none. Detected/forked selection checks current active intent
and resolves merged members to their accepted owner row. Resort intent follows
unsettled callers. Existing sidebar/dialog/settings consumers use this same
following promise and preserve successful action writes on reload failure.
