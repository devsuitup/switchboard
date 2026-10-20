# Context: bg-agents

**Purpose**: The Agents view — a graphical replacement for the `claude agents`
TUI. Lists the daemon's `--bg` sessions and the external interactive ones,
attaches/stops/respawns/deletes/dispatches through the CLI. User doc:
`docs/background-agents.md`.

## Key files

| File | Role |
|---|---|
| `bg-agents-roster.js` | Pure: `parseJobState`, `parseCliList`, `mergeRoster`, `dispatchArgs`, `dispatchRefusal`, `isHostedJob`, `parseDispatchOutput`, `JOB_STATES`, `JOB_ID_RE` |
| `bg-agents.js` | Watchers over `~/.claude/jobs/*/state.json`, descriptor subscription, `reconcile()` through `claude agents --json --all`, `runVerb`, `dispatch`, `liveJobCheck`, `onChange`; `projectRoot`/`worktreeRoot` on every entry, cached |
| `project-root.js` | `resolveProjectRoots(cwd)`: the `.claude/worktrees` pattern, else one `git rev-parse`; never throws |
| `delete-session-guard.js` | `deleteSessionRefusal`: the fail-closed liveness check `delete-session` runs first |
| `bg-agents-ipc.js` | `get-bg-agents`, `check-bg-agent-verb`, `bg-agent-verb`, `dispatch-bg-agent`, the `bg-agents-changed` push |
| `cli-session-state.js` | `onDescriptorsChanged`, `readAllDescriptors`, `kind`/`jobId` on live-elsewhere |
| `bridge-session-id.js` | Shared case-sensitive suffix for job `cse_` and descriptor `session_` bridge ids |
| `pty-ops.js` | `detachPty` |
| `bg-handoff.js` | Eligibility, `/bg` submission, continuation/descriptor proof, bounded exit hold |
| `main.js` | `runClaudeCommand`; the `type: 'attach'` branch of `open-terminal`; detach in `stop-session`; `bgAgents.init` and `bg-agents-ipc` wiring; renderer unsubscribe on window close, `bgAgents.stop()` on app quit |
| `public/agents-view.js` | The view; `agentJobIsLive`; `groupAgentEntries` (Group by); `bgAgentSessionIds` for the sidebar badge |
| `public/resume-guard.js` | A live `kind: 'bg'` descriptor answers `{ attach, cwd }` |
| `public/dialogs.js` | `showDispatchAgentDialog` |
| `public/shortcuts.js` | The rebindable `agentsToggle` (default Primary+Shift+`A`) |

## Invariants

Disabled Respawn/Delete titles for an External conversation name its pid and
a real recovery action: Stop on its sidebar row when `conversationOwn` is
true, or end the other process otherwise. The External detail has no working
Stop or Close action. See `test/dom-agents-view.test.js` (#566/S5).

1. Never `--resume` or `--fork-session` a hosted job. Hosting follows
   `isHostedJob` (see "Job states"). `claude attach` is the
   only path to a live job (`guardResume` turns a `bg` verdict into attach
   options; `open-terminal` builds `claude attach`). Nothing ever resumes one.
2. Every call to the CLI goes through the login shell with an argv quoted by
   `quoteArgvForShell` (`runClaudeCommand`, the scheduler's path). Never a
   command string built by hand. The daemon's control socket and
   `control.key` are never touched.
3. Closing an attach tab detaches (`\x1a`, 2 s grace, then kill —
   `detachPty`). `claude stop` is the only stop.
4. Job watchers start with the app to keep the sidebar cache current. They
   notify projects only when the job id to state/name/name-source/conversation projection changes;
   token/detail/tempo/fan updates do not notify projects. Automatic roster
   rebuilds require an `onChange` subscriber, first installed by
   `get-bg-agents`, and stop when the last subscriber leaves. Explicit CLI
   reconciles still return a fresh roster. Closing the view retains its push
   subscription; closing the window releases it. Jobs and the projects listener
   survive macOS window close/activate and are released on app quit.
5. `jobs/` and the `kind: "bg"` descriptor are undocumented. An unreadable
   `state.json` keeps previous lifecycle metadata; a CLI that
   fails leaves a file-only roster with `daemonReachable: false`. Unreadable
   rewrites retain lifecycle metadata but mark task evidence invalid. Canaries:
   `test/canary-bg-agents-files.test.js`, `test/canary-cli-session-state.test.js`.
6. A verb's id is validated against `JOB_ID_RE` before any spawn; a prompt
   starting with `-` is refused by `dispatchArgs`.
7. The attach options are exactly `{ type: 'attach', jobId, cwd }`. Never
   `sandbox`, `preLaunchCmd` or MCP emulation: the attach branch of
   `open-terminal` skips them, and the client only talks to the daemon.
8. Dispatch is refused in a project whose effective settings ask for a
   sandbox or a pre-launch command (`dispatchRefusal`, fed by main's
   `dispatchSettings(cwd)`): the daemon starts the worker, so neither could
   apply, and running it unconfined without a word is the outcome to avoid.
   The dialog re-reads the effective settings on every project change and
   shows the same refusal; remote projects are not offered.
9. `delete-session` asks `deleteSessionRefusal` (`delete-session-guard.js`)
   first, and it fails closed. It refuses a session held by an open
   terminal (by id or `realSessionId`), by a live job (`liveJobCheck`: the
   job files, read directly so it works before the view was ever opened, a
   job's session id taken from `linkScanPath`, else from its `sessionId` or
   `resumeSessionId` field, which a job with no transcript yet carries; the
   roster only supplies a session id a file lacks, or answers when `jobs/`
   does not exist or a listed job's `state.json` is missing), or by another
   process
   (`cliSessionState.liveElsewhereChecked`). It also refuses when it cannot
   tell: an unreadable jobs or descriptor directory, an unreadable state, a
   state outside `JOB_STATES`, or a live job whose state names no session.
   The dispatch dialog likewise keeps Start disabled when the project's
   settings cannot be read. A missing directory means nothing
   is live. Ids are compared lowercased everywhere, since Windows resolves a
   transcript path case-insensitively.
10. `check-bg-agent-verb` and `bg-agent-verb` share the conversation check before `rm` or `respawn`, and
    before `stop` on a finished job. It reads the job file afresh through
    `conversationCheck`; `rm`/`respawn` refuse an unreadable/unknown state or
    an absent conversation identity. Stop goes to the daemon unless the fresh
    check identifies a finished job and its conversation. It checks both the transcript session id and any
    job `bridgeSessionId`, plus the roster's session id, through
    `deleteSessionRefusal` and `liveElsewhereChecked`. The latter includes
    this instance's processes for these verbs: being owned here makes a resume
    a re-attach but does not make a destructive operation safe. Open terminals,
    live jobs, live descriptor pids and unknown liveness all refuse. The
    refusal for a descriptor names its pid. `stop` on a hosted job
    remains the daemon's stop operation, including missing or unknown job files.
    The check and CLI invocation are separate: a process can start after the
    check but before the CLI runs. This reduces stale-roster mistakes; it is
    not an atomic lock on the conversation.

### Agents confirmations and detail buttons (#565)

`runAgentVerb` awaits `checkBgAgentVerb` before either Stop or Delete opens
`appConfirm`. A refusal or rejected check is displayed through
`agentsVerbErrors` in the selected detail; it opens no dialog and sends no
verb. The check-only IPC accepts only `stop`, `rm` and `respawn` with a
`JOB_ID_RE` id, and never calls the CLI or reconciles the roster. Unknown or
hosted Stop still passes the shared check. Execution repeats the check after
confirmation, so a state change while the question is open can still refuse.

Stop's danger confirmation names the job's display name and id and says its
process ends while the conversation is kept. Cancel sends no verb and leaves
an attached tab open. Delete retains its conversation/worktree loss wording.

The detail uses morphdom, retaining verb button nodes across roster polls and
state changes while updating their disabled state. Equal-roster polls also
retain focus; that retention already existed at the PR6 base. A pending job
disables its action buttons before the check and stays held through confirmation
and execution. Repeated Stop/Delete requests for that job are ignored until
refusal, cancellation, error or completion releases it. Evidence:
`test/dom-agents-view.test.js`, `test/bg-agents-ipc.test.js`.

## Sidebar membership (#620)

The sidebar's `bg` membership also arrives through the local descriptor-backed
projects payload (`bgJobId`/`bgSessionId`, #620), independently of opening this
view. The existing roster set remains a fallback and checks every
`mergedMemberIds` entry as well as the representative. A proven background
continuation can therefore badge its conversation row before a new turn is
indexed. See `session-cache.md`, "Local background sidebar rows", for identity
and registry-name precedence. This changes the membership marker, not the
status glyph policy from the indicators audit.

### Job activity (#628)

`initAgentsView` installs the existing `bg-agents-changed` listener and fetches
the roster at renderer bootstrap, even when Agents stays closed. This shares
the jobs/descriptor service already used by #620; it adds no watcher or IPC
channel. Every window load runs `claude agents --json --all` once through
`get-bg-agents` → `reconcile`, including when Agents stays closed. A newer
push or request invalidates an older pending response.
Membership still comes from #620's projects payload, with the roster set as
fallback. Lifecycle/group/header predicates and all verb guards are unchanged.

Background roster entries retain descriptor identity, pid, cwd and agent, but
their `status` is null: neither descriptor nor CLI coarse status is activity
evidence. Normalized `taskEvidence` feeds the existing task registry.
`task-records.js` keeps `IN_FLIGHT_KINDS` for the CLI format canary, including
`artifact_watch`. Runtime validation accepts future nonempty string kinds:
`inFlightKinds` retains every kind with its label and `known` flag; unknown
kinds use `Unknown activity (<kind>)`, keeping at most 40 characters of the
kind followed by an ellipsis when truncated. The sidebar icon tooltip lists
these labels, including `Artifact watch`, while activity still uses the task
registry and the static background glyph. The canary separately rejects an
unknown kind so CLI drift remains visible without making runtime evidence
unavailable (#684).

`inFlight.tasks` remains the registry's numeric `inFlight` count. Optional
`inFlight.queued` and `inFlight.drainableMonitors` become `queued` and
`drainableMonitors`, defaulting to zero when absent or not nonnegative safe
integers. The canary separately flags malformed optional counts. Drainable monitors are
metadata within the reported activity, not an additional count or a reason to
subtract from `tasks`; neither optional count changes registry activity.
`inFlight.tasks` must be a nonnegative safe integer. Wrong required-field
types, empty kind strings and malformed fan evidence still invalidate the snapshot;
terminal jobs alone may omit `inFlight` entirely.

The shared background projection reads #638's head-turn and #626's unseen-output state:
only an open head turn animates; agents, shells, monitors and cron at the prompt
share the static background glyph. Only agent tasks contribute to #627's count.
A blocked job shows the static waiting ring, including with a PTY attached here:
the job state supplies observed waiting evidence without a recorded turn end.
It suppresses head busy, background work and response-ready, while retaining
unseen written output. A genuine OSC 9 attention notification or a live
`waiting` descriptor with `attention: true` still takes priority. Done/stopped/failed
suppress head busy, background work and response-ready as before.
Sessions with a live non-attach PTY here keep the conversation's own activity
only when their matching entry is not a live job. Attaching to a working or
blocked job keeps the job projection, including blocked waiting and labels
without descriptor status or age. Finished entries with `conversationOwn`
also keep the conversation's own activity unless their open tab is an attach
client (`openSessions.get(sessionId).attach`, the renderer marker). When that
foreground projection is used, the sidebar status line takes its text from the current activity icon
(for example, `Working`), without descriptor status or age (#654). A row with
`bgJobId` but no matching roster entry says `Activity unavailable`, including
when its PTY is still open. This applies to initial rendering, incremental head
updates and sidebar rebuilds. Both sidebar paths pass the representative row
to the label function so a merged member cannot lose its row's `bgJobId` when
the roster is absent. A retained attach tab keeps the job projection after
done/stopped/failed: the sidebar says `Idle` for hosted done, otherwise `Job done`, `Job stopped` or `Job failed`.
An unhosted done, stopped or failed row shows the finished/stale glyph
(`Not running`), even if `conversationOwn` is true; an unhosted row of any
other state keeps the idle slot titled `Liveness unknown`, never declared dead; a done row with a live bg descriptor keeps the waiting ring. A resumed
non-attach conversation retains its own activity and glyph. The done/idle
descriptor with a living CLI pid was measured on JB's machine on 2026-10-16
(#682); the regression tests use disposable fixtures.
Sidebar rebuilds compare session membership, state, normalized task evidence
and conversation ownership; tokens, tempo, detail and display-only fan changes
do not rebuild it.

Both local adapters omit background descriptor status so even a newer frozen
idle timestamp cannot close a validated head turn. While a valid job is
`working`, the sidebar status text is empty, including the Working,
Background work running and Waiting for input activity rungs (#702).
`backgroundActivityLabel` is sidebar-only: a working job whose head reports
attention keeps `Needs attention` even with invalid activity evidence, while
Waiting for input alone stays empty when activity evidence is valid.
It retains `Blocked` for a job waiting for user input even when activity
evidence is invalid, `Idle` for hosted done, `Job done`, `Job stopped`,
`Job failed` for finished jobs, and `Activity unavailable` for missing or
invalid activity evidence. A resumed foreground conversation keeps its
existing activity text.
The row's single `.session-icon` owns the full diagnostic tooltip:
activity label, separate job state, valid `updatedAt` in local time as
**job metadata**, and all in-flight kind labels, or the unavailable diagnostic.
Its accessible label is the icon's own short title plus any distinct short status text;
job state, timestamps and in-flight diagnostics stay in `title` only. When
remote attention overrides the icon, its own attention title labels the slot.
The `.session-status` has no separate tooltip. Initial sidebar builds and
`applyStateClasses` refresh the same projection on head pushes and roster
changes. The Agents table keeps its existing state labels, icon tooltip and
`startedAt` age column. No descriptor status age is shown for background activity.

Unknown job formats, invalid normalized evidence, backwards job timestamps,
missing files and corrupt rewrites expose unavailable/degraded job activity.
The last validated registry/head evidence remains usable as fallback. An
unreadable rewrite retains cached identity/lifecycle metadata for the existing
guards but invalidates task evidence until a valid read. A silent job is not
expired by elapsed time: `updatedAt` orders job evidence and has no head-output
freshness meaning. Degradation grants no additional destructive verbs.

Coverage: `test/dom-sidebar-bg-activity-628.test.js`, the #628 roster and real
job-file tests in `test/bg-agents-roster.test.js` and `test/bg-agents.test.js`,
plus the existing Agents DOM and #522 guard/attach suites.

### Background continuations (#639)

Complete typed proof also requests source persistence when a distinct live tab
holds the destination. Metadata is copied after the hosted job enters the cache;
the existing tab and both PTYs stay in place. This metadata-only attempt returns
false so fork and `/clear` detection and known-file bookkeeping can proceed.
Copies and confirmation callbacks are deduplicated per source/target/job tuple.
Ordinary info logs record each pending/refusal reason once per tuple, including
whether metadata was already copied. A real later detection can publish after
the destination exits, reusing its completed copy and rechecking proof.

A complete, unambiguous new `continued-in` record in the interactive conversation
plus a hosted cached job identifies a background continuation; any
descriptor for the target must agree on a single `kind: bg` job. Before
spawning, the tab snapshots continuation ids
and the transcript byte offset. Snapshots before spawn yield between
one-megabyte chunks to keep the event loop available for large resumed
conversations. Only a target absent from that snapshot, in the appended tail,
can authorize the re-key. A partial record already present
at spawn and a rewritten prefix cannot become fresh evidence. The tab must
also have submitted `/bg` itself (`terminal-input.js` tracks the composer),
or have a confirmed button handoff. Ctrl+C and the CLI's cancellation message
revoke the typed command, while an empty confirmation Enter preserves it.
Another process backgrounding the same conversation cannot take over its PTY.
Its worker belongs to the daemon, so the interactive PTY ancestry check cannot
authorize it. `session-transitions.js` checks this
proof before the closest-writer cache and before requiring a target transcript.
The job and descriptor subscriptions in `main.js` reconsider only unresolved
fresh background continuations, without scanning folders or subagents. This
works even when no transcript has changed and Agents has never opened.
Ambiguous links and interactive strangers do not authorize a background re-key.

The original row becomes the background UUID. `sidebar-bg-sessions.js` retains
the original conversation fields, keeps predecessors as merged members, and
suppresses the target's separate row. The existing `bg` marker remains the
membership signal. `parseJobState` reads `name`/`nameSource`; collision names
cannot win through CLI, descriptor or job fallback. The Agents row and detail
prefer the conversation's Switchboard name or original title for a collision
or a proven continuation; independently named jobs retain their name. The
handoff still submits `/bg` only, without `--name` or a suffix.

Before publishing the re-key, `db.rekeySessionMeta` copies name, star and archive
in one transaction, retaining the original metadata for when the job finishes.
Only Switchboard renames are copied as names; transcript titles remain titles.
`session_meta_fields` records a monotonic revision and source per field, so an
existing target retains whichever value was updated later, including explicit
false star/archive values. For names, only user rename revisions participate;
a newer transcript title cannot defeat a genuine rename. Legacy fields have
no revision: a target field wins a tie, and an original name equal to its
cached title is treated as a title. A copied legacy rename gains user source
with revision zero so its provenance survives subsequent continuations.
The projects cache and query worker carry name source and revision into the
sidebar merger. It selects the newest genuine rename from the two ids,
including a cleared name, before falling back to the original transcript
title. Retaining the old metadata cannot mask a newer background-head rename.
The renderer keeps the existing xterm and open-set position, migrates activity,
panel state and toolbar owner, panel-shell ownership and in-flight flags,
last activity, sandbox flag, PTY generations, pending opens and restore entries.
Terminal output buffers and grid handlers follow the new UUID. The stored
head-turn snapshot keeps its revision, observation time and unread marker at
the new UUID; newer destination evidence wins. Ordered prompt hints retain
their original adapter state, and both the session map and preserved row
select the new head before the next sidebar/grid/Agents projection. An in-flight
panel-shell completion reads the migrated owner from its original state object;
its physical `panel:<old>` PTY id stays unchanged until that shell closes.

The background payload crosses `preload.js` and attaches in the preserved
terminal. `open-terminal` replaces only the proven handoff's interactive PTY,
validates the matching job id before doing so, and spawns `claude attach`.
The button confirms/re-keys before releasing a held physical exit. A submitted
`/bg` (with optional arguments) and one fresh continuation retain a just-exited
source for at most 15 seconds, even before the jobs watcher sees the daemon.
The re-key requires both a background target and a hosted cached job.
Job and descriptor notifications reconsider the held source. Partial tails
retry once a second; expiry releases the ordinary exit. An old link without
this tab's command never delays `process-exited`, task owner death or activity end.
`session.forked` activity traces include `kind: background` and `jobId`, including
when Diagnostics is enabled after startup.

Regression evidence: `test/bg-continuation-641b.test.js`, `test/bg-continuation-639.test.js`,
`test/bg-rekey-renderer-639.test.js`, and the handoff, panel, activity,
sidebar and Agents suites. `/clear` and fork keep their existing ownership and
fresh-conversation rules; metadata migration applies only to background.

## Header counters

`#agents-viewer-count` reads `N running · M finished`, plus ` · K external` when
K > 0. `running` and `finished` count background jobs only (`agentJobIsLive`);
`external` counts every interactive row that is not a finished job held by an
interactive session (`jobState` set; that row counts as finished), which is live by definition
(`agentIsLive`) and always listed, whatever the Finished filter says. The segment is
absent at zero, so a roster without external sessions reads as before.

## Job states

`JOB_STATES` is `working`, `blocked`, `done`, `stopped`, `failed`. These are
turn states: `done` means the turn ended, while the daemon may still host the
session between messages. `working` means an active turn; `blocked` means the
job parked itself (for example, a quota pause or awaiting a go-ahead) and projects
waiting in `projectBackgroundActivity`. The sidebar keeps its short `Blocked`
label (#702), and the sidebar, grid and Agents tooltips retain the blocked state.
Leaving `blocked` removes that waiting evidence; the normal head-turn and PTY
rules apply again. `stopped` and `failed` are finished even with a leftover descriptor.

`isHostedJob(job, descriptors)` in `bg-agents-roster.js` is the single hosting
rule: a background job is hosted if working/blocked, or if a live `kind: bg`
descriptor matches its job id. Only a descriptor without a job id may match
its case-insensitive session id; two jobs can share a resumed conversation.
Stopped/failed override that evidence. Descriptors come from `cli-session-state.readAllDescriptors`:
it parses the descriptor and checks `isProcessAlive(pid)`. Dead pids are excluded.
It also reuses `deliveryProcessIdentity` to exclude confirmed stale process
identities, comparing `procStart` and `pidDomain` with the process start evidence.
Windows uses the existing asynchronously refreshed process table and descriptor
mtime ordering. Unknown identity, including missing `procStart`, retains the
pid-only behaviour; old status timestamps do not expire a living pid.
The cached sidebar descriptor projection applies the same identity check.
Turn activity and attention read their specific turn states; hosting consumers
use `isHostedJob`.

Main annotates every roster entry with `hosted`; renderer `agentJobIsLive`
consumes that field for badges, row liveness, ordering, counts, the Finished
filter and verbs. A hosted idle row retains the `done` turn state and shows `Idle`
in the sidebar status and Agents row label (a finished Agents row shows `done`).
It shows the waiting glyph and counts as running. Done without a live descriptor
is finished. Busy/head-turn and blocked waiting still follow turn evidence.
`runVerb`, the fresh conversation check and `liveJobCheck` use the same hosting
rule, including descriptors that changed after the last snapshot.

| Display / verb | Hosted (including idle done) | Finished |
|---|---|---|
| State label after turn ends | Idle | done |
| Attach | allowed | disabled (a finished session resumes like any other) |
| Stop | allowed | disabled |
| Respawn | refused | allowed |
| Delete (`rm`) | refused | allowed |

The UI disables the buttons (`agentVerbAvailability`); `runVerb` refuses
`respawn`/`rm` on a live roster entry with the same rule, so a stale renderer
cannot bypass it. A blocked row draws the static orange waiting ring; only a
genuine attention input overrides it with the blinking attention `!` (#726).
The shipped IPC adds invariant 10's fresh conversation check; the roster
state alone cannot authorize a destructive verb. A finished job that matches
a live interactive descriptor by case-insensitive `sessionId` or by the same
case-sensitive bridge suffix (`cse_` on jobs, `session_` on descriptors) becomes one
interactive row (`state: null`, descriptor status/pid/cwd/start time, job
tokens/model/detail/fan/result retained; the live UUID becomes its `sessionId`). Its `conversationPid` disables
Respawn and Delete and supplies the tooltip's pid. Other interactive sessions
owned by this instance remain excluded as before. The promoted row remains
visible with Finished unchecked, groups as External, and offers Resume and
Transcript, with no Attach or daemon Stop. Detail shows the job id and
`jobState`; the job still counts as finished. When the matching descriptor belongs to this instance, it keeps its
background job row instead of becoming External. `conversationOwn` supplies
the "open in Switchboard" reason; `conversationPid` still disables destructive verbs.
Any descriptor holding a row's session id supplies `conversationPid`, even
when its kind is `bg` and the job file already says finished. Such a row keeps
its job state but cannot offer destructive verbs while that pid is live.

The job watcher starts with the app so the sidebar can read `getCachedJobs`
without opening Agents or scanning job files on project loads. A done job with
a live bg descriptor retains the roster's sidebar bg marker. The local projects
projection also uses `isHostedJob`, preserving descriptor-only rows and proven
continuation heads, merged members and registry renames across working/done
turn transitions. A live bg descriptor also supplies a descriptor-only row when
its job metadata is absent, before the job watcher fills or beyond `MAX_JOBS`.
Hosting and conversation identity use separate facts. The attach fallback
supplies a synthetic descriptor only for working/blocked. Cached jobs in all
five known states can retain an indexed continuation's exact target, scoped by
its cached row or lexical transcript folder and current folder metadata. An
unscoped cached row cannot establish a merge. Every descriptor, cached, indexed
and bridge path keeps the same project, folder and host boundary. A conflicting
descriptor contributes nothing and cannot veto independent proof. An exact local
open attach selects the target as representative/head; attach alone proves
neither scope nor hosting. Delete, Archive, Pin and Rename use this same current
part set, including proved unindexed members. Their filesystem target resolution
and fresh liveness guards remain authoritative.
Sidebar registry names replace launch titles only; a Switchboard rename wins.

`parseDescriptor` retains `bridgeSessionId`. `bridge-session-id.js` strips only
the `cse_` / `session_` prefixes and preserves the opaque suffix's case. The
shared lineage is measured in `.ai/contexts/session-cache.md`, "Open on
claude.ai". Roster merging and the checked process scan both use it; a bridge id
is not a descriptor's UUID. `liveElsewhereChecked(..., { includeOwnProcesses:
true })` explicitly bypasses both the has-PTY shortcut and own-process filtering
for destructive-verb checks. Ordinary resume checks keep excluding own processes.

Roster rebuilds do not query SQLite or stat transcript files. For a job or a
merged row, Transcript calls `runVerb('transcript', id)` through the shipped IPC;
main lazily checks the same cached folder/path as `read-session-jsonl` and returns
the UUID or a clear missing/unindexed-file error without spawning. A retry sees
newly indexed files without rebuilding the roster. External rows with no job id
use the ordinary read-only viewer directly. The ordinary
`read-session-jsonl` handler catches file-read errors if a file disappears
after the roster snapshot. `test/bg-agents-522.test.js` exercises the shipped
IPC and renderer functions against disposable job/descriptor/transcript files.

## Data flow

`jobs/<id>/state.json` (fs.watch, per directory) and `sessions/<pid>.json`
(through `cli-session-state`'s flush) both call `scheduleRebuild()`,
coalesced at `FLUSH_MS` (250 ms). `rebuild()` = `mergeRoster(cli, jobs,
readAllDescriptors())`. Candidates are the union of parsed CLI background jobs, cached jobs and live bg
descriptors with explicit valid job IDs. A readable cached lifecycle wins over
the CLI fallback. Successful `[]` is omission rather than removal. `listed`
records exact CLI inclusion; snapshots also carry `cliAvailable` and
`cliEntryCount`, independently of daemon reachability.
The file supplies normalized task evidence, `detail`, `tokens`, `fan`, `children`,
`result`, `--agent`/`--model`/`--name`; the descriptor supplies identity,
`pid`, `agent` and interactive-only status. `reconcile()` runs on every
`get-bg-agents` (the renderer calls it at bootstrap, on open and every 30 s
while visible) and after every verb and
dispatch. The push `bg-agents-changed` carries `{roster, daemonReachable, cliAvailable, cliEntryCount}`.
Descriptor appearance/disappearance schedules a rebuild through the existing
subscription. Bootstrap installs the IPC push subscriber with Agents closed;
main also subscribes for task records and starts the service at app startup.
The changed `hosted` field makes the snapshot differ and updates badge membership.

### Lifecycle

- `reconcile()` is a no-op until `start()`: it returns the current (empty)
  snapshot without spawning the CLI.
- The first `get-bg-agents` calls `start()`, which arms the jobs-directory
  watcher, one watcher per job directory, and the descriptor subscription.
  Later calls find `started` already true and only reconcile.
- Every `get-bg-agents` also re-subscribes the `bg-agents-changed` push
  (`subscribe()` in `bg-agents-ipc.js`). `stop()` clears the listener set; on
  macOS the app outlives its window, the `closed` handler calls `stop()`, and
  the window created next would otherwise never receive an update.
- A `reconcile()` in flight when `stop()` runs is dropped: `stop()` bumps
  `generation`, and the reconcile compares the value it captured before
  awaiting the CLI and returns without touching the (now reset) state.
- `bgAgents.init()` calls `stop()` first, so a re-init starts clean.

## Non-obvious behaviors

- The view is a sibling of `#jsonl-viewer`, shown by hiding
  `#terminal-area` (as the Stats tab does), so the grid's state survives.
  `hideAllViewers()` calls `hideAgentsView({ restore: false })`, as do the
  Agent Files / Work Files tabs, Settings and the grid; only the toggle
  restores the terminal area.
- The view persists `localStorage.agentsViewActive` (`'1'`/`'0'`).
  `initAgentsView()` reads it into `agentsOpenAtStartup`; `app.js` calls
  `restoreAgentsViewAtStartup()` after the working set is restored, so the
  view is shown once the restored sessions are open.
  `agentsShowFinished` persists under `localStorage.agentsShowFinished`
  (`'0'` hides finished sessions); the grouping under
  `localStorage.agentsGroupBy` (see "Group by").
- `claude --bg` prints its id wrapped in ANSI colour codes (see "Measured
  facts"); `parseDispatchOutput` takes the first standalone eight-hex token,
  which the colour codes do not hide, and `dispatch` reports
  `ok: true, id: null` when there is none — the row then arrives through the
  files.
- `claude agents --json --all` runs through an interactive login shell
  (`runClaudeCommand`), so rc files may print to stdout around the JSON.
  `parseCliList` first tries a strict parse, then the candidate arrays that
  start with `[` at the start of a line and end with `]` at the end of a line
  (at most 32 of each), and returns `null` when none parses. A verb's error
  text goes through `stripShellNoise`, which drops only the leading
  `bash: no job control in this shell` / `cannot set terminal process group`
  lines; the CLI's own stderr is kept verbatim.
- `claude rm` runs from the home directory, never from the job's cwd: that
  directory may be the worktree `rm` deletes, and Windows refuses to remove a
  live process's cwd. `stop` and `respawn` run in the job cwd (respawn's brief
  needs it), falling back to home when it no longer exists.
- An attach tab's `cli-session-state` status comes from the daemon worker's
  descriptor (same `sessionId`), so busy/idle needs no special path.
- When a row is attached here and the user runs Stop or Delete on it, the
  renderer calls the main-side verb first and stops the local attach pty
  (`stopSession`) only after success, marking the open entry with `jobEnding`
  before stopping it. The header and exit banner read Stopped without claiming
  the job keeps running. Detached is reserved for a user Detach of the attach
  client. A refused verb keeps the tab open.
- Narrow widths: a row's grid columns add up to ~670 px of minimum width.
  Without `min-width: 0` on `#main` that minimum became `#main`'s own, so
  with a narrow window or a wide sidebar `#main` ran past the window edge
  and the header's right end (New agent) was clipped by `body`'s
  `overflow: hidden`. `#main` now shrinks to the space left, the list
  scrolls sideways, and the header wraps its controls (`flex-wrap`, New
  agent `flex-shrink: 0`) onto extra rows.
- Dispatch dialog layout: `.dispatch-agent-dialog` scrolls inside the
  window (`max-height: calc(100vh - 32px)`, `overflow-y: auto`). Its direct
  children do not shrink in the flex column: a short window scrolls instead
  of compressing rows until textareas and the mode grid cross separators.
  Rows use a grid with labels aligned at the top; Project, Name, Agent and
  the permission grid fill the same right column. Prompt and Additional
  Directories span the row. Project reuses `.settings-select`, the shared
  Settings select style (#467/#468). All overrides are scoped to this dialog.
- Window controls: the frameless window draws the system buttons over the
  top-right corner, and `#agents-viewer-header` is the top row of `#main`.
  It is in the `window-frameless` header lists of `style.css` (right inset
  `--strip-inset-right`, left inset for a collapsed sidebar), and its labels
  are `no-drag`, so New agent stays clear of the controls and a click on
  "Finished" or "Group" does not start a window drag. A new view that
  reaches the top of `#main` must join those lists; see
  [window-frame.md](window-frame.md).

## Dispatch

`showDispatchAgentDialog` offers Accept Edits, Auto, Plan and Bypass from
`BACKGROUND_PERMISSION_MODES` in `public/dialogs.js`. On opening and on each
project change the project's own permission mode is preselected when it is one
of the four; otherwise Accept Edits is. Bypass carries the `dangerous` style. This four-mode set follows the maintainer's proposed
background choices for #501; it is kept in one constant so it can be revised.
Accept Edits and Auto can still stop for actions requiring approval; offering
them does not guarantee an unattended run finishes. The dialog sends the
selected `permissionMode` and `dangerouslySkipPermissions: false`.

Agent remains an optional text field: no agent-definition catalogue is
exposed by `preload.js`. `getBgAgents` returns daemon jobs and interactive
sessions, while `listSubagents` returns recorded transcripts; neither lists
available definitions. Their names/types cannot safely populate an agent
select. An empty Agent field omits the agent option. A catalogue IPC would
be separate work; the text fallback is allowed by #501.

Additional Directories is a textarea with one path per line. The IPC payload
retains its existing fields and types (`addDirs` is a string).
`splitAddDirs` in `bg-agents-roster.js` trims each line, drops empty lines and
preserves commas inside paths, yielding one directory argument per path.
Existing session settings still use commas; the dialog converts those
inherited settings to lines when a project is selected. Sandbox and pre-launch
refusals, lookup error handling and stale-project lookup guards still apply.

`test/dom-dispatch-dialog.test.js` evaluates the shipped dialog and exercises
its payload through `dispatchArgs`; `test/bg-agents-roster.test.js` checks the
directory argv. `e2e/dispatch-dialog.spec.js` opens the dialog through the
Agents view at 1400×900 and 900×700, checking row containment, separators,
top alignment and matching Project/Name/Agent edges. Its isolated Electron
instance replaces the roster IPC with an empty snapshot before opening the
view, so the journey never invokes the real Claude CLI.

## Group by

The header's `#agents-group-by` select sets `agentsGroupBy` (`none`, `state`,
`project`), persisted under `localStorage.agentsGroupBy`. `readAgentsGroupBy`
wraps the read in try/catch and `normalizeAgentsGroupBy` maps anything else
(unset included) to `state`, the default; an explicitly stored `none` or
`project` is kept. The default is not written back, so it only lands in
storage once the user picks something. The write is wrapped too, so a storage
that throws still lets the choice apply for the session. The `<select>` in
`index.html` marks `state` as `selected` to match before `initAgentsView` runs.

- `groupAgentEntries(entries, mode)` is pure and returns
  `[{ key, label, title, entries }]`, empty groups dropped. It keeps the input
  order inside each group: the renderer passes it the already filtered
  (Finished) and sorted (`sortAgentEntries`) list, so grouping never re-sorts
  rows. `none` returns one unlabelled group; the renderer then skips headers
  entirely, so the flat list is byte-identical to before.
- `AGENT_STATE_META` (key → `{ emoji, label }`) is the single source for the
  state groups' order, their header label and emoji, and the emoji at the
  start of each row's `.agents-row-state` (in every mode). `agentStateMeta`
  (entry → `{ key, emoji, label }`) is the only lookup: interactive entries
  are `external` whatever their state; a background entry whose state is
  `null` or not a key is `unknown`. Hosted `done` uses the `idle` key and
  `💤 Idle` header and row label. Order: Active, Blocked, Idle, Done, Stopped,
  Failed, External, Unknown. "Blocked" matches the row's own state word.
  Emojis are literals from the map, never data, and sit in their own
  `aria-hidden` span (`.agents-group-emoji`, `.agents-state-emoji`) so the
  label and the state text stay plain text. Project headers carry no emoji.
  A new job state needs an entry here, or its rows fall into Unknown.
- Project groups are keyed by `entry.projectRoot || entry.cwd` (see
  "Project and worktree roots"); the string is used as is (a trailing slash
  or a different case makes a different group); neither is the "No project"
  group. The label is the last path segment (`/` and `\` both split, so
  Windows paths work). Labels shared by several roots become
  `last (parent)`; if still shared, the full path. Order: a group holding any
  `agentIsLive` entry first — interactive sessions count as live, the same
  rank `sortAgentEntries` uses — then by label, case-insensitive
  (`localeCompare`, `sensitivity: 'base'`), with "No project" last in its
  rank.
- Header rows are `.agents-group-header` / `.agents-subgroup-header`, not
  `.agents-row`. The viewer's click handler checks `[data-collapse]` before
  `.agents-row`, so a header click toggles the group and never selects a row;
  the selection (`agentsSelectedKey`) is untouched by a regroup or a
  collapse. The header's `title` (full path) and `data-collapse` go through
  `agentsEscapeAttr` and are read back with `dataset`; the label through
  `escapeHtml`.
- Headers are `position: sticky` in the scrolling `#agents-list`, sized
  `1.2em` of the list's 12px (rows are 12px), weight 600, with more padding
  above than below; the count is weight 400, smaller and `--text-muted`.
- Collapsing: every header (State, Project, worktree sub-group) is
  `role="button"`, `tabindex="0"`, `aria-expanded`, with a `▾`/`▸` chevron in
  an `aria-hidden` span; click, Enter or Space (a `keydown` on the viewer)
  calls `toggleAgentsGroup`. A collapsed header keeps its label and total
  count and renders none of its rows; a collapsed project also hides its
  sub-groups; a collapsed sub-group hides only its rows. Keys
  (`agentsCollapseKey`) are scoped by mode and level — `state:<state>`,
  `project:<projectRoot or cwd>` (`project:` for No project),
  `worktree:<projectRoot>|<worktreeRoot>` — so folding Done in State mode
  folds nothing in Project mode. The set (`agentsCollapsedGroups`, a `Set`
  whose insertion order is the age) is kept in memory across roster pushes,
  regroups, mode switches and the Finished filter, and persisted as a JSON
  array under `localStorage.agentsCollapsedGroups` (read and write in
  try/catch). `parseCollapsedGroups` drops invalid JSON, non-arrays and
  non-strings, de-duplicates, and keeps the newest `AGENTS_COLLAPSE_MAX`
  (200); a toggle that adds past the cap evicts the oldest key. Keys of
  groups that no longer exist stay until evicted. The selected row may sit in
  a collapsed group: the selection and the detail pane stay (and its verbs
  keep working); the row is just not drawn. Nothing collapses in None mode.
- Worktree sub-groups: `#agents-group-worktrees` sets `agentsGroupWorktrees`,
  persisted under `localStorage.agentsGroupWorktrees` (`'0'` off; unset or
  anything else on; read and write in try/catch). It is disabled (kept
  visible, greyed through `:has(input:disabled)`) outside Project mode;
  `renderAgentsView` refreshes `disabled` on every render.
  `groupAgentEntries(entries, 'project', { worktrees: true })` adds
  `children` (`[{ key, label, title, entries }]`) to a project group only
  when its entries span more than one worktree (`worktreeRoot || cwd`): a
  project living in one worktree, even a linked one, stays flat — sub-headers
  there would only repeat the project header. "No project" never gets
  children. Sub-group label: `main` when `key === projectRoot`, else the
  worktree directory's last segment, disambiguated like the project labels
  (`main` excluded). Order: live first, then main, then label. The project
  header's count is the project total; each `.agents-subgroup-header` (1em,
  weight 600, muted, indented, not sticky) shows its own count, title via
  `agentsEscapeAttr`; the rows under it get `.agents-row--nested` (indent
  only). The option is ignored in the other modes.

## Project and worktree roots

`project-root.js` (main process) resolves, for one cwd,
`{ projectRoot, worktreeRoot }`: the git project's main working tree and the
top of the worktree the cwd lives in (the cwd may be a subdirectory).
`derive-project-path.js`'s `resolveWorktreePath` was not reused: it is
synchronous, needs the parent to exist, only takes a cwd that is exactly
`<root>/.claude/worktrees/<name>`, and knows nothing about `git worktree add`
directories elsewhere.

1. Pattern (pure, no fs): `<root>/.claude/worktrees/<name>[/…]`, either
   separator → `projectRoot = <root>`, `worktreeRoot =
   <root>/.claude/worktrees/<name>`; the lazy match takes the outermost
   `.claude/worktrees`. Works for a directory that no longer exists (a
   finished job whose worktree was removed). Only `.claude/worktrees` is a
   pattern; `.worktrees` / `.claude-worktrees` go through git when they exist.
2. Otherwise, if the cwd is an existing directory: one
   `git -C <cwd> rev-parse --git-common-dir --show-toplevel` through
   `execFile` (argv array, no shell, `cwd` option, `GIT_TIMEOUT_MS` = 2 s,
   `GIT_*` variables stripped from the env so an inherited `GIT_DIR` — e.g.
   from a git hook — cannot point it at another repo). `worktreeRoot` = the
   top-level; `projectRoot` = the parent of the common dir when it is named
   `.git`, else (bare repo, submodule whose common dir is
   `.git/modules/<sub>`) the top-level.
3. Anything else — missing directory, not a repository, git missing, timeout,
   a throw — gives `{ cwd, cwd }`. It never throws.

`bg-agents.js` attaches both fields to every roster entry (background and
interactive) in `rebuild()`: a cached value, else the pattern result or the
cwd itself, so the roster renders at once. Then `resolveMissingRoots` queues
every cwd not cached nor pending (at most `ROOT_CONCURRENCY` = 4 resolutions
at a time, never awaited by `reconcile`/`get-bg-agents`). A finished
resolution is cached (`rootCache`, a Map per cwd, `ROOT_CACHE_MAX` = 500,
oldest evicted first) and calls `scheduleRebuild()` only when it differs from
the provisional value, so a cwd that resolves to itself costs no change
event. A failure is cached as the cwd, so git is never re-run for a known
cwd until `stop()` (which clears the cache, the queue, and — through
`generation` — drops resolutions still in flight). The resolver is
injectable (`init({ resolveProjectRoots })`) for tests.

Known limits: the cache is never invalidated while the watchers run — a repo
moved or deleted, a directory that becomes a git repo later, or a git call
that timed out once keeps its first answer until the window's `closed`
handler (or a re-init) calls `stop()`. A submodule is grouped as its own
project, not under its superproject. Two different spellings of one path
(symlink, case on Windows) can still make two groups, since the pattern
branch and the fallback keep the cwd's spelling.

## The sidebar

`bgAgentSessionIds` (a `Set` of the `sessionId` of every live background job,
`agentJobIsLive`: working/blocked or done with a matching live bg descriptor) is rebuilt by `applyAgentsSnapshot`,
which refreshes the sidebar when membership or job activity changes.
`sidebar.js` prefixes a `bg` badge ("click to attach") to a session row with
#620's project membership or a matching roster id. Two
consequences:

- The roster set is fetched at renderer bootstrap, then refreshed on open
  and retained through the existing push while Agents is closed. #620's
  projects membership can badge a row before this first fetch completes.
- An unhosted finished job loses its badge at the next snapshot. Clicking its row
  resumes normally: the attach decision is made by `guardResume` from a live
  descriptor, not from the badge.

## External Resume

An interactive row with a session id offers Resume even when the daemon is
unreachable. `runAgentVerb('resume')` opens the indexed row's head with its
parts through `rowHeadSession(row)`, as a sidebar click does, or passes the
roster's id/cwd/name fallback to `openSession` without options. This
keeps continuation resolution and the shared `guardResume` /
`liveElsewhereQuestion` adapter on the normal manual-open path. Cancel opens
nothing; acceptance resumes the head here, even when an older part is live.
An already-open row is shown by `rowOpenId`.
Background jobs keep Attach, and Resume never calls the daemon verb IPC.

## Attach

`guardResume(session, { automatic, allowBgAttach, api, confirm, live })`:

- `automatic` (restore, reload): a session live elsewhere returns `false`,
  except a background job when `allowBgAttach` is true. Working-set restore
  allows this for a resolved continuation or a saved entry with `bg: true`.
- `live.kind === 'bg'` with a `jobId`: `{ attach: jobId, cwd }`. `app.js`
  turns that into `{ type: 'attach', jobId, cwd }` and marks the entry
  `attach`. Without a `jobId` it refuses (`false`) rather than offering to
  resume.
- Any other live-elsewhere session keeps the confirm dialog.

The Agents view's Attach button builds the same options itself
(`attachBgAgent`, skipping the guard; it is only enabled for a live job).
In `open-terminal`, `type: 'attach'` validates `jobId` against `JOB_ID_RE`,
takes `cwd` from the options, runs `claude attach <jobId>` and skips sandbox,
pre-launch command and MCP emulation. The session is flagged `isAttach` with
`attachJobId`, which `isAttachedHere` (passed to `bgAgents.init`) reads to set
`attachedHere` on the roster entry. Ordinary attach tabs are excluded from the
working set (`entry.attach`). An attach tab kept by continuation restore
is saved with `bg: true` while it is open and not closed; closing or
destroying it drops the mark; the mark survives later saves,
so restore reattaches the live job at every restart. After a renderer reload
the tab is reopened through the
reattach branch of `open-terminal`, which returns `attach: !!session.isAttach`;
`openSession` sets `entry.attach` from it, so the flag survives the reload.

The view's HTML puts CLI- and file-sourced values (name, cwd, href, session
id) in attributes through `agentsEscapeAttr`, which also escapes `"` and `'`:
`escapeHtml` does not, and a quote would otherwise let a value add a
`data-verb` that a click runs.

## Send to background

Issue #656 guards the handoff continuation reader with BigInt dev/ino/birthtime and nanosecond mtime before/after each scan, restarts equal-size changes from zero, and resumes only verified growth with a matching head, following the NTFS identity/tunnelling rationale in [session-state.md (#648)](session-state.md), while keeping BigInt entirely inside the reader. If the same file grows during a synchronous chunk, that poll returns no result but retains its scanned cursor and pre-scan snapshot so the next poll can continue incrementally; an identity or non-growth change discards both.

The session header and sidebar context menu call `send-session-to-background`
for one running local Claude tab. Main refuses plain terminals, attach tabs,
remote tabs, sandboxed and pre-launch-command sessions, duplicate handoffs,
unsubmitted composer text, unknown CLI state, open dialogs (`waiting`) and
shell state before writing. Busy is refused ("Claude is working. Send to
background once it is idle.") until a busy `/bg` is measured; the live run
below was idle. Running subagents require an `appConfirm` warning first;
cancel writes nothing. Composer input, busy or a dialog appearing during the
300 ms text-to-Enter gap withholds Enter and names the residue to check. No
recovery Enter is sent.

The written `/bg` is recorded in `session.composerState` through
`noteUserInput` before the write, and the Enter after it, as
`terminal-input.js` does for typed keys. A dangling lone-Esc partial is discarded
before noting the plain `/bg` write, so a previous Esc (including Esc Esc)
cannot consume its slash as Alt+/. Other partial sequences keep their ordinary
parser handling. If that text write throws or returns false, the previous
composer fields are restored on the same object. A withheld Enter leaves the
model non-empty: a trigger queued behind the handoff refuses through its
politeness check, and a retry is refused as unsent text instead of typing
`/bg/bg`. The gap check compares the model's text to `/bg` and its
`lastInputAt` to the value our own write set, so any keystroke in the gap
withholds Enter even when it nets out.

Measured on Windows, CLI 2.1.296, 2026-10-13 (`.work-files/live-m1m2/`): `/bg`,
300 ms, then CR runs `/background` through its completion menu. The original
descriptor becomes `waiting` / `waitingFor: "dialog open"` at +65 ms and is
deleted at +252 ms. A `continued-in` record names a new conversation at about
+0.2 s. Its live `kind: "bg"` descriptor appears at +1.6 s, with `jobId` equal
to the new UUID's first eight hex digits; it has no status for about 0.7 s.
The original PTY exits 0 at about +2 s; no `parkedJobId` or agents list appears.
The daemon job survives that exit.

Proof is a new `continued-in` target in the original transcript plus a live
bg descriptor naming exactly that target and carrying a valid job id.
`scanContinuationIndex` from `session-continuations.js` supplies the parser;
`cliSessionState.readAllDescriptors` supplies live descriptors, including
descriptors without status. A continuation alone, an unrelated job, malformed
job id or ambiguous matching jobs cannot confirm the handoff. Existing
continuations are snapshotted before writing and do not prove this request.
A snapshot that cannot be read whole is retried once, then the action is
refused with zero writes: an empty snapshot would let the live job of an
earlier hand-typed `/bg` prove this one.

The `waiting` / `dialog open` transient measured at +65 ms is part of the
success path. The confirm notice ("Claude asks you to confirm in the
terminal") is shown only when the original descriptor still exists with
`status: "waiting"` for 1 s (`BG_CONFIRM_NOTICE_MS`) without proof. The fresh
descriptor scan used for handoff proof also supplies this signal. The cached
status can retain `waiting` after deletion while the original pid is alive
(`retainAfterMiss`, with liveness probes every 5 s); deletion resets the notice
window even if that cached status remains `waiting` until after proof.

The wait lasts at most two minutes while the original PTY runs, shortened to
15 seconds after an exit is observed. `wireSessionPty` marks the physical exit
and shuts down MCP immediately, but holds ordinary exit notification and map
cleanup until the handoff settles. Success suppresses that notification; failure
releases it and displays an actionable notice. The exiting CLI is not killed
while the handoff is pending. After a proven handoff, if the original PTY has
not exited within the 15 s hold window (`BG_HANDOFF_EXIT_TIMEOUT_MS`), it is
stopped with `killPty`: the conversation already runs in the daemon, and a
lingering CLI would keep the old tab's process alive.
Output subscriptions and descriptor-change waits exist only during handoff;
100 ms bounded waits also cover transcript-only changes, with no new idle poll.

`tab-input-lock.js` shares the existing trigger FIFO by session object. The
action refuses while a trigger holds or queues that tab; triggers admitted
during handoff wait under their existing deadline. This prevents automation
text or Enter from interleaving with `/bg`. Typed terminal answers retain their
ordinary input path. A physically exited handoff record cannot be reattached
as a live PTY; reopening it asks the user to wait and use the sidebar.

The renderer destroys the original entry, replaces any non-attach target,
opens `{ type: 'attach', jobId, cwd }` under the new id, and follows the active
tab without stealing focus from another tab. It drops the old id's local PTY
state (`dropLocalPtySession(oldId, 'backgrounded')`, as `applyProcessExit`
would), so busy and running marks do not stick on a row that is not rendered.
The attach entry is moved back to the original tab's position in
`openSessions`. Known limit: a grid already on screen appends the new card at
the end of its project group; the next grid layout orders it by the sidebar
again. It sets `bgRestore` and uses
the existing `skippedWorkingSetEntries` / `keepAttached` contract to save
`bg: true`; closing the tab drops that entry. Restore intent is established
before awaiting the attach spawn. A failed attach retains that intent alongside
its error tab for the next restart. Merged-row member metadata is not copied
onto the new conversation; a source closed or replaced during IPC reports the
completed move without reopening a tab or changing replacement liveness.
The success notice says the session now runs in the background and closing the tab detaches it. Attach
failure says where to retry from the sidebar. A `/bg` typed by hand is not
followed by this action; quit/update and grid actions remain separate slices.

The IPC handler is the named `handleSendToBackground` in `main.js`, so
`test/bg-handoff-main.test.js` loads it through `loadAppFunctions`.

After a confirmed Send to background handoff, the handler saves the source's
continuations with `sessionCache.resolveSessionContinuations`, using the
`session-continuations` IPC's liveness lookup. It then refreshes the source row
through `writer.refreshFolder` so its `fileMtime` matches the saved index,
then notifies projects with `background-handoff`: one row is shown without
waiting for the watcher's flush. It repeats this sequence once the source PTY's
exit has been handled (`exitDrain`), so a write by the exiting CLI cannot leave
the rows split. A failure logs `[bg-handoff]` and notifies nothing. The IPC
result waits for none of this. A confirmed button handoff and a proven typed `/bg`
share source continuation persistence; later source writes are refreshed
independently of the source's exit. `persistBackgroundHandoff` captures the old
source id, folder and drain, coalesces equal BigInt stamps, reruns changed-stamp
requests, and forces exactly one exit pass. Stat, resolve, refresh and drain
failures produce one warning per failed pass; indexing never authorizes a re-key.

Tests: `test/bg-handoff.test.js`, `test/bg-handoff-main.test.js`,
`test/send-to-background-renderer.test.js`, `test/bg-handoff-trigger.test.js`,
header/control and restore neighbours.

## Detach

`stop-session` on an `isAttach` session calls `detachPty` and returns
`{ ok: true, detached: true }`: write `\x1a` (Ctrl+Z, which makes `claude attach` leave and
leaves the session running), wait `graceMs` (2000), then
`killPty` if the client is still there. If the write fails it kills at once.
A detach already pending (`session.detaching`, `session.stopRequested`) makes
every further Stop a no-op: a second kill of a ConPTY on Windows is a heap
double free (#405). The write goes through `writePty`.
The header's stop button is labelled **Detach** for such a tab
(`terminalStopBtn.title`). The job is stopped only by `claude stop`, from the
Agents view.

An attach-only Stop plan detaches without confirmation and shows a 10 s Undo
notice. The renderer captures the session, `attachJobId` and `attachCwd`
before detaching. Undo waits for the local client's exit if necessary, then
checks `bgAgentLiveJob(sessionId)` before calling
`openSession(session, { type: 'attach', jobId, cwd })` with that snapshot.
A known-ended job shows an error without opening a tab; unknown liveness
still allows attachment. A `not running` detach result skips the exit wait.
Only a valid captured job id offers Undo; other detached tabs show an
informational notice. After Undo, that tab's notice shows Reattaching while
waiting and is replaced by the attachment result.
Initial attach and background handoff both retain the actual attach cwd on
the entry. Failed detaches keep their Retry notice and offer no Undo; a mixed
Stop plan still confirms before ending its local or remote processes.

## Running the CLI

`runClaudeCommand` (`main.js`) runs `claude <argv>` through the login shell
profile so `PATH` matches a terminal; the login shell makes a call slow (a
`claude agents --json --all` took 12 s under bash on Windows), hence
`LIST_TIMEOUT_MS` 20 s and `VERB_TIMEOUT_MS` 60 s. Under cmd.exe or PowerShell
the shell would mangle quotes, `&` and newlines of a prompt, so
`claude-binary.js` finds `claude` on `PATH` and spawns it without a shell: the
`.exe` itself, or, for an npm `claude.cmd` shim (libuv does not resolve
`.cmd`), the `node` + `cli.js` the shim points to, or `cmd.exe /d /s /c` with
escaped arguments as a last resort (a multi-line argument is refused there).
A shim whose target is a `.exe` (the current `bin\claude.exe` shape) runs
that `.exe` directly. Only `PATHEXT` names are tried, since npm also leaves an
extensionless sh shim. `resolveWindowsClaude` returns
`{ program, args, verbatim }` or `{ error }`.
A timeout kills the whole process tree (`taskkill /T` on Windows, the process
group elsewhere), except for `--bg`: it may have started the daemon, so only
the client is killed. The call resolves on `close` so stdout is drained, or
1 s after `exit` when a daemon holding the pipes keeps `close` from firing. `dispatchArgs` puts `--` before the prompt:
`--add-dir` is variadic and would otherwise swallow it. A job's own
`state.json` state wins over the cached CLI list's.

## Known limits

- ADR 0004 slice 2 follow-ups: the pre-spawn continuation snapshot still reads
  the transcript before opening the PTY. It yields between one-megabyte chunks
  but makes large resumes wait for that read. Re-keying still snapshots the
  target synchronously on the main process, and exit-time freshness checking
  drains the source tail synchronously. Move these scans off the main process
  while preserving the pre-spawn freshness boundary and unambiguous identity.
- A `/bg` the tab never saw as text (recalled with the up arrow, or completed
  by the CLI's slash menu from a prefix) does not arm the exit hold: the
  composer only sees keystrokes. If the daemon's job is not cached when the
  CLI exits, the conversation falls back to a separate attach row.
- Archiving or deleting a session that a live daemon job runs is refused by
  `stopBeforeArchive` (IPC `bg-agent-live-job`, the same `liveJobCheck`,
  failing closed) before anything is detached; a folder archive (#482) that
  holds one archives nothing. Stop the job from the Agents view first. With
  Folder Archive checks every local part before its options dialog, even when
  the remembered "Archive the sessions" option is unchecked; a live job or an
  unknown answer refuses the action before configuration. Once allowed, with
  "Archive the sessions" unchecked a folder archive never calls
  `stopBeforeArchive`: it only hides the folder, archives and detaches
  nothing, and the job stays in the Agents view.
  Row and slug-group Archive also run this fail-closed check for every local
  part during `planSessionArchive`, before any confirmation or stop in the
  action. A refused row blocks the whole slug-group action at that stage.
- A live job keeps the sidebar's Fork button: a fork reads the transcript and
  starts a new session, it never resumes the job.
- A global WSL shell profile runs `claude` inside WSL, whose daemon and
  `~/.claude/jobs` can differ from the ones the Windows roster reads.
- `runVerb` re-reads job state and live descriptors, falling back to roster
  identity/state when the file is missing. Without any of that evidence its
  direct guard can still pass `rm`/`respawn` through to the CLI. The shipped
  IPC's fresh conversation check refuses unknown liveness before calling it.
- `MAX_JOBS` (200) limits watched directories by sorted id, not the full
  CLI/cache/descriptor candidate union.
- The jobs-directory watcher's `error` handler only logs; it does not re-arm
  the watcher, so new job directories are noticed by the next reconcile
  instead.
- Window close and app quit kill attach ptys without `\x1a` first (the
  `closed` handler calls `killPty`). The session survives; the client just
  does not leave politely.
- `parseDispatchOutput` was checked against one measured output (see
  "Measured facts"); a CLI that changes that line may make `dispatch` return
  `id: null`, which only costs the row selection.
- Descriptor liveness retains pid-only behaviour when process identity is
  unknown; a reused pid can still show an external session until the existing
  identity check has enough evidence to reject it.
- An interactive descriptor is External unless `ownProcessFilter` claims its pid:
  a PTY pid of this instance, or a descendant of one or of the main process (the
  roster's broad visibility rule; the resume and delete guards use a narrower one,
  see cli-session-state.md). On
  Windows and macOS the parent chain comes from a cached, asynchronous process
  snapshot (`.ai/contexts/cli-session-state.md`, "Own descendants outside
  Linux"), so the first roster after startup can list an own tab as External until
  the snapshot lands and the view rebuilds.
- A login shell whose rc files print to stdout is tolerated by the tolerant
  list parse, as long as the JSON array stays on its own lines; other noise
  (text on the same line as the JSON, a stray line that happens to parse as
  a JSON array before it) is not, and the view then reports the daemon
  unreachable.
- Whether the CLI itself refuses `claude rm` or `claude respawn` on a live job
  is NOT verified. The UI disables both on a live row and `runVerb` refuses
  them when the roster knows the job is live; outside that (see the first
  item) nothing guards it.

## Measured facts (CLI 2.1.285, Linux, 2026-09-30)

- `claude agents --json --all`: ~0.15 s CPU; array of `{id, sessionId, name,
  cwd, kind, startedAt, pid?, state?, status?}`.
- The daemon reports a fourth job state, `blocked`, for a live job waiting on
  input, and (2026-10-01) a fifth, `failed`, for a job that ended in error.
- `claude attach <id>` in a pty: Ctrl+Z detaches, client exits 0, session
  stays `working`.
- `claude logs <id>` prints screen ANSI, unusable without xterm — not used.
- `claude --bg --name plan-check "say hello and stop"` prints
  `backgrounded · <id> · <name>`, then dim hint lines
  `claude agents`, `claude attach <id>`, `claude logs <id>`,
  `claude stop <id>`. The id is 8 hex chars wrapped in ANSI colour codes
  (`ESC[36m` … `ESC[39m`) even when stdout is piped. `parseDispatchOutput`
  returns the id for that text and `null` for a line without an id
  (`test/bg-agents-roster.test.js`).
- In a cwd that is not a trusted workspace the CLI refuses: `Workspace not
  trusted. Run \`claude\` in <dir> once and accept the trust prompt, then
  retry.` A dispatch from a never-trusted project therefore shows that
  message as its error.

## If you change this, also check

- `.ai/contexts/ipc-bridge.md` (the three handlers, the event)
- `.ai/contexts/cli-session-state.md` (the descriptor hooks)
- `docs/background-agents.md`, `docs/keyboard-shortcuts.md`

## Persistent handoff and restore errors (#566)

The session header's background handoff, continuation attachment and startup
restore failures use `public/app-notices.js`, keyed separately as
`Send to background`, `Attach background` and `Restore`. Restore refusals and
missing transcripts use restore groups, with each affected session listed. Later
batches merge by member operation id and update repeated members' text; they retain
earlier failures until those members succeed or the group is dismissed.
Both refused results and rejected IPC promises produce a persistent alert with
Dismiss, session id/name/location, reason and recovery through the sidebar,
Agents view (for a background job) or the session's own terminal. Plain resume
failures point to reopening from the sidebar, without suggesting attachment.
External-process restore refusals
name their pid and actual descriptor cwd, including merged members; they do not promise unavailable Stop/Close
controls. Missing-index notices explain how to check/restore the transcript
and name Reindex all sessions. Display names pass through cleanDisplayName.

An automatic restore or background attachment whose open-terminal IPC rejects
or returns a failure removes the failed terminal entry and returns false. The
restore batch continues. Automatic restore failures and retries of an already
held entry retain that saved slot in skippedWorkingSetEntries for later
persistence and manual retry. A failed manual attachment without a held entry
does not add a session to the saved working set. A successful open consumes the held entry;
closing it afterwards removes it from the next saved working set. A plain manual
resume keeps its existing rejection behaviour.
The handoff caller receives the original attachment error through onOpenError
before cleanup, so its final notice retains the backend reason after the failed
tab is removed.

A confirmed handoff clears the source handoff error while a failed destination
attachment retains its own error. Successful attachments and restores clear
only their matching notices (a member's success retains other members in a
group). Waiting-for-indexing uses a transient status only for entries that will
retry automatically, cleared explicitly when indexing finishes. An indexing hold
requiring the user to choose from the sidebar remains in the persistent failure
group; a mixed batch keeps automatic progress separate. Group updates retain
their stack position and original return focus. A handoff already in progress is also informational. Remote,
sandboxed and plain-terminal refusals explain why background handoff is not
available and offer continued use of the terminal. Informational handoff success
and restore consent keep their existing transient/question behaviour. The
Agents view's own error handling belongs to a later #566 slice.

Evidence: `test/dom-row-action-errors.test.js`,
`test/send-to-background-renderer.test.js`,
`test/restore-live-elsewhere.test.js`, `test/restore-unavailable.test.js`.

## Exact activity selection and diagnostics (#719)

The shared selector returns entry/source/selection/unavailable. It checks the
row's explicit bg job/session pair first, then an exact validated open attach,
then a unique identity job targeting the current head, then that head's unique
roster entry. A missing/conflicting explicit identity never falls through; an
ambiguous head never picks by roster order. Non-head identity is retained for
membership without applying its activity to the head. Genuine resumed foreground
PTYs keep their foreground rule; an attach never takes that branch.

Task evidence stays keyed by job ID through main, task worker, snapshots and
registry queries, with per-job monotonic evidence times across rekeys. Sidebar,
grid, Agents and transcript adapters pass the same accepted row and selection.
Invalid reads retain lifecycle/identity with invalid current evidence; removal
evicts the contribution. No quiet-job TTL exists. Hosting and selected-source
changes repaint while Agents is closed; token/detail/tempo updates do not reload
projects. Omitted jobs retain normal verbs when reachable: hosted jobs offer
Attach/Stop, unhosted terminal jobs offer Respawn/rm subject to conversation PID
and fresh process guards. Unreachable disables daemon verbs, independently of
Transcript availability.

Accepted projects commits and roster changes feed the pure projection observer.
Ordinary main.log receives one `[session-projection] ` JSON record per changed
logical scope/root, with current build/generation/roster provenance and deciding
inputs. CLI omission alone is silent and updates provenance. See
[activity-trace.md](../../docs/activity-trace.md) for bounds and privacy.

## Descriptor scope, terminal job evidence and orphaned members

Descriptor project grouping resolves the repository root, while descriptor
transcript scope encodes its actual cwd, including worktree components. An
orphaned bridge member retains its previous representative membership; a
present representative in another project or folder still cannot absorb it.

The task registry retains terminal timestamps per job, transports them in
snapshots, and carries them across session rekeys. Terminal evidence ends known
tasks at or before its timestamp, including after the roster entry disappears.
The selected job's watermark also excludes older replayed CLI tasks without
ending another job's own contribution.
Known evidence and unenumerated in-flight work remain visible through the
unique-job fallback. Corrupt reads can be repaired at the last valid timestamp;
older valid evidence remains rejected.
