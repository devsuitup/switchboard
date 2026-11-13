# Project deletion (#474 A4a–A4d, E)

## Linked worktree folders (E)

Preview accepts optional `worktrees: string[]` alongside the unchanged five
boolean writer options. These are exact paths from the main-owned Git inventory,
not arbitrary filesystem targets. Missing means empty; duplicates and more than
128 selections refuse. Every registered checkout has a row: path, branch,
main/project-directory identity, dirty/untracked status, sessions, jobs and an
availability reason. Status/activity failures are explicit, never rendered as
clean/idle. The main checkout, the selected project directory and its ancestors
are never removable. Remote selection refuses because no authoritative remote
filesystem/removal port exists. Local discovery uses NUL-delimited Git porcelain;
Git versions without that list format leave physical deletion unavailable.

`project-delete-worktrees.js` calls the existing `worktree-delete` readStatus and
removeWorktree functions. Clean removal uses no force; dirty content is hashed
and rechecked. Locked/submodule rows are disabled here and direct users to the
dedicated dialog for its extra confirmations. Directory-link refusal is shared:
remove a node_modules junction with nonrecursive `rmdir` before reopening. E
does not unlink automatically, traverse junctions, delete branches or invoke
cleanupWorktree. Linked histories remain outside the parent's metadata manifest.

The runtime reads all CLI descriptor writers, indexed session evidence, active
tabs, schedules and background job files/list. Descendant cwd counts as worktree
activity. Live or uncertain sessions disable the row; E does not extend A4 stop
authority to a linked project's sessions. Background records remain refused
under #1090 even when done. Local subtree launch holds cover selected directories
and wait for previously admitted descendant launches; archive reservations include
the selected linked identities as well as the parent. External processes and
filesystem writers are not locked by these holds.

Rows and selection enter the planner fingerprint, retained in the single-use
document-bound token. Renderer boxes are individually unchecked on every open
with no rememberKey. A changed selected row fingerprint requires reopening:
a newer hidden detail panel cannot silently authorize newly dirty bytes.
Unselected physical content is kept. Selecting a directory necessarily removes
all its contents, including ignored files and any schedules/memory/work-files
inside it; category `kept` applies to the parent's data, not files inside selected
linked directories.

The dialog keeps the explicit `Kept on disk:` project-folder notice alongside
the selected linked-folder removal warning. Row session fallbacks are computed
before formatting the worktree label, and the unavailable reason uses an
explicit conditional: these are display text, not `SETTING_DEFAULTS` overrides.
The renderer settings-default scanner remains unchanged; the Settings deletion
regression retains its disk-retention, cancellation and in-app-dialog assertions.

Execution drains holds, revalidates, stops/verifies parent targets, preflights all
selected rows, then removes sequentially through the shared path with fresh
per-removal activity/status checks. A failed removal stops the sequence. Only
after removal does it reread writer scope and revalidate parent membership/death,
omitting already-consumed physical selections from this final preview. The
writer's manifest/options remain metadata-only. The operation retains launch
holds until Git settles, even after an early IPC unknown reply.

`worktrees` on operation views records removed/failed/remaining paths. An attempted
disk effect followed by failure remains partial even when the metadata receipt
proves notStarted. The renderer's persistent notice lists these paths and offers
fresh review, never replay. A metadata commit still publishes only its own exact
invalidation targets. Filesystem and SQLite effects are not an atomic transaction.
Physical progress is process-local: recovered writer receipts explicitly set
worktreeHistoryUnknown; a crash before writer submission leaves no disk receipt.
Fresh Git/disk inspection and user consent establish remaining work. Recovery
never repeats disk removal or treats a metadata receipt as proof of disk success.

Plain-Node tests cover the production planner, service, activity reader, subtree
gate and shared removal with controlled Git replies and real disposable files.
The composition witness includes the real writer/SQLite fixture. Separate real
Git worktree tests are retained for CI; the local sandbox refuses their temporary
linked `.git` creation. Native UI, full process restart, live process death and
filesystem races after the shared last scan remain unverified locally.

## Renderer boundary (A4d)

Both the sidebar Delete button and Project Settings use
`confirmAndDeleteProjectFolder`. The preload exposes previewProjectDelete,
token-shaped deleteProject, projectDeleteState and onProjectDeleteRecovery.
The former positional bridge is explicitly removeProjectLegacy; neither UI
entry calls it. R5 is resolved by this simultaneous switch.

R4 / #1090 boundary: stopBackgroundJobs is always the strict boolean false.
No stop-job consent is offered or remembered. Live background plans disable
Confirm and direct the user to stop the job in Agents first. Off win32, a plan
with a local PTY stop also disables Confirm, even if main minted a token;
the strict backend STOP_UNSUPPORTED behavior remains unchanged.

R6: a bounded read-only capabilities preview precedes the dialog. Only session
metadata (initial false) and available project settings (initial true) are
remembered on acceptance. Disabled remembered choices become unchecked without
a write. E adds separately unremembered physical worktree choices above. The literal expandable full plan is
installed only after latest-response/answer matching; failures cannot enable
Confirm. Changed membership requires a new dialog/confirmation.

The host/canonical-path busy Set survives skipped, partial and full sidebar
renders. Settings/sidebar actions share it, and Archive/new/stop controls check
it synchronously. Busy changes repaint immediately and enter sidebarRenderInputs.
The working-set, sidebar-width and Global Settings writers share _persistChain;
deletion drains earlier submissions, rejects stale reads by generation, and
defers already-submitted global patches while writes are blocked. A cancelled
dialog itself writes nothing. `saveGlobalSettings` resolves to `true` after a
write or `'deferred'` when queued; persistence failures reject. Settings applies
a deferred save in the current window and announces that persistence will follow
deletion, while refusing a new Save if the write block is already active.
Global Settings explicitly requests `remove: ['chrome']`; removals travel with
deferred patches and are applied to a fresh global snapshot on replay. A later
patch can set a previously removed key again. If replay rejects, the deferred-save
notice becomes an error explaining that Settings could not be saved, with an
Open Settings action to review the persisted values and save again. Successful
replay adds no notice. Project Settings checks the matched
folder's host/path identity so remote deletion previews block Save as well.

Any NOT_READY reply makes deletion globally unavailable with the retryable
reason "Project deletion is unavailable until recovery of an interrupted deletion
finishes". Only a successful capability probe on the next open can clear it;
older preview replies cannot override a newer NOT_READY. Only announced operation IDs get a
project-specific unresolved state. Unknown outcomes keep Check deletion state;
sealed partial outcomes offer Review remaining deletion, which requests a fresh
plan and consent rather than replaying the old operation.

Recovery announcements carry {operations:[{operationId,host,projectPath}]} and
known operation views carry host/projectPath from the main-owned registry.
Local host is null, remote host is its alias; projectPath is canonical. Authority
remains restricted to the current trusted document. No identity is fabricated
for operations omitted because recovery failed before registry admission.

An accepted operation's committed ACK prunes exact restore targets, destroys
its tabs through destroySession, filters deferred restores/working-set saves,
detaches old Touched list references, and refreshes search, Agent Files, Work
Files and schedules. Historical committed recovery has no fresh epoch proof
for renderer teardown: it refreshes projects without closing potentially
re-added sessions. Restore tombstones record the latest started `loadProjects`
generation at ACK. Only an accepted load started after that generation may clear
them when the project reappears; a pre-ACK load completing late cannot do so.
Main already gates its notification sinks by current epoch.
This conservative boundary avoids extending the authorized backend change.
Failed refresh after acknowledged completion offers reload and blocks another
Delete on that stale view. Completion is never inferred from a transport error.

Plain-Node renderer fixtures exercise the production scripts and extracted app
functions. Native layout/focus, real Electron IPC and process death remain CI
or manual integration checks; the A4d brief prohibits launching them locally.

## Current state: internal main composition (A4c4)

`project-delete-main.js` composes the shipped inventory, planner, stop adapter,
service and IPC registration after background IPC initialization. Main supplies
the writer, active session map, CLI evidence, background stop ports, remote stop
adapter, launch gate and notification sinks. A4d's preload and renderer use the
three callbacks; legacy remove-project, Archive and Stop keep their contracts.

The runtime read adapter reads bounded job files and the read-only CLI agents
list, including records absent from the roster cache. Unreadable, unowned,
unlisted and linked records refuse confirmation. It does not seed schedule
registration, refresh the index, reconcile the roster or call getProjectsSnapshot.
The existing CLI runner accepts an optional maxOutputBytes; deletion uses 8 MiB
across stdout/stderr and terminates only that reader process on overflow. Other
callers retain the unlimited default. Malformed JSON/list entries refuse rather
than being filtered into an apparently complete empty list. Late filesystem
handles are closed even after the inventory deadline. The agents reader runs
with the supplied home directory as cwd. Output accounting adds each chunk's
byte length once. Job discovery resolves the project root once per scan;
ENOENT for a job cwd means it no longer belongs to this project, while other
cwd read errors produce an unreadable candidate for that record.
Background records remain explicitly blocked on #1090, even when a daemon state
says done. Current headless schedules retain the inventory's blocking targets.
Remote ownership/schedule discovery lacks an exhaustive production port and
therefore refuses; passing the strict remote stop adapter supplies no discovery
or whole-tree proof. Codex and unsupported terminal evidence also refuse.

Local PTYs retain their captured object through exitDrain. A fresh CLI ownership
read checks for external writers and validates the PTY start identity; no active
tab can conceal another process. The stop adapter obtains native tree evidence.
Subsequent inventory rereads both stopEvidence and late statusTreeExit on the
pinned PTY, and then checks CLI liveness. Map removal alone never proves death.
Async-local runtime scopes isolate each preview and accepted operation. Preview
completion clears its members/pins; an operation retains its own pins across
revalidation and an early IPC reply, then its captured cleanup clears them on
release, even if a later state read supplies terminal proof. Unresolved operations
retain evidence with their holds. Non-Windows local PTY plans may still mint a
token; the strict stop preflight returns STOP_UNSUPPORTED without stopping or
submitting deletion. Preview platform refusal is deferred to the planner contract.
Runtime liveness and conversation reads outside `withScope` reject with the typed
DISCOVERY_UNAVAILABLE failure; no unscoped member or pin maps are created.

Recovery starts before buildMenu/createWindow without awaiting it. The scheduler
and trigger startup wait for enumeration and acquisition of every recovered hold,
before sequential receipt reconciliation. This milestone has a 120,000 ms bound;
failure or timeout still starts the scheduler and trigger watcher once. A failed
wait logs one line with its error code/message or HOLDS_TIMEOUT and the deadline.
Already installed holds continue to guard their projects. Later recovery retries
install holds missed by a failed enumeration or OPERATION_LIMIT without repeating
automation startup. Cache rebuild, updater setup and activate registration proceed
immediately. Startup checks appQuitting and shutdownPromise, including after
awaiting schedule registration seeding; disposal during shutdown starts nothing.

Schedule IPC registration is unconditional with respect to recovery, while still
checking shutdown: run-schedule-now uses the operation gate, but
create-schedule-session writes directly without admission. A holds milestone does
not protect that second callback, so waiting for full recovery would only disable
schedule IPC on recovery failure. This does not add admission to session creation.
The three deletion callbacks still wait for full recovery. Its ceiling remains 126,090,000 ms:
4,096 sequential receipts at 30 seconds, 65 enumeration pages at 10 seconds,
plus 32 unresolved-operation stalls at 80 seconds. The window remains usable
throughout; a rejected or expired barrier leaves all three callbacks NOT_READY,
retryable:true. A writer bootstrap retries recovery, including one arriving
during an older worker's read. The inner service retains
unresolved work and holds after an outer timeout or disposal. Recovery reads
do not depend on watchers started after the window.

The composition attaches IPC authority only at the first did-finish-load of
each new window. Registration then owns same-URL document rebinding and revocation.
Shutdown removes pending attachment/bootstrap listeners and registration, and
disposes tokens without releasing unresolved operation ownership.

Project/schedule notification sinks receive only committed receipt targets.
Before synchronous delivery, the composition rereads the receipt and checks its
revision and current epoch (a committed operation seals at expectedEpoch + 2).
It drops reopened/superseded epochs and deduplicates operation/epoch/revision
per sink in main-owned notificationState. Recreating the service with that state
cannot replay publication. A full application restart creates new consumers and
recovered committed receipts younger than 24 hours notify again if their epoch is
still current; no durable exactly-once delivery
is claimed. Cross-restart repeats are accepted: the consumers perform idempotent
refreshes. Deduplication is process-local, including across service recreation.
Sinks must remain synchronous at the side-effect boundary.

Plain-Node composition tests use the real worker fixture and SQLite adapter,
fake external process/IPC ports, and disposable paths. Actual Windows tree death,
Electron lifecycle events, remote discovery and renderer consumption remain CI
or later-slice gates.

## Service contract (A4c3)

`createProjectDeleteService` in `project-delete.js` composes the real planner,
inventory, stop adapter, launch gate and writer facade. `project-delete-ipc.js`
registers its three internal callbacks. A4c4 supplies main composition; A4d owns
the preload and renderer action.

Call `initialize()` before admitting previews. Recovery enumerates bounded
writer receipts, including committed lost replies, and reads/fences rather than
replaying completion. Initialization failure leaves the service not ready;
`recover()` reconciles retained ownership before retrying initialization. Main
must call this lifecycle hook on writer bootstrap/replacement and rebind the
current trusted document after recovery. Enumeration caps at 4,096 headers;
the registry retains at most 32 unresolved operations and 128 terminal results
for 24 hours. If recovery cannot acquire a hold or reaches the live cap, it
refuses initialization without registering an unowned operation. Unresolved
holds and identities never expire, including on dispose. Receipt timestamps
remain authoritative across restart. Recovered historical stops and file
manifests are explicitly unknown.

Sealed receipt headers are already terminal proof: recovery reads them without
acquiring either hold or consuming the unresolved-operation cap. A failed read
keeps details unknown and can be retried, but does not fence historical work.
Multiple retained epochs of one project therefore cannot block each other,
regardless of their lexicographic operation-ID order. Only unsealed operations
acquire exclusion.

The service, inventory and planner share optional `now/schedule/cancel` clock ports
allow expiry, deadlines and retention to share one clock. Tokens are 32 random
bytes, five-minute, boot/document-bound, with 32 outstanding globally. Preview
rechecks document authority after discovery/scope reads before minting. Input
options remain the five booleans; E's optional worktrees path array belongs to
preview only and never enters writer options. Other extra fields refuse.
Reply timeout is separate from accepted main-owned work. The operation
ID and registry entry precede the first await, and readState cannot fence work
still admitting or stopping. Reuse/foreign tokens never submit or stop twice.

Execution reserves both launch and archive exclusion synchronously, awaits
both ready promises, revalidates the fingerprint and epoch, then preflights and
stops all targets. Every `effect != 'none'`, including a failed attempted stop,
is preserved in the returned stopped-work list. Before completion it compares
membership rather than the volatile full fingerprint. Only a positively proven
stop can preserve a disappeared tab/job identity. It then rereads the writer
scope, re-inventories and independently verifies death after that await.
Completion is invoked once. Post-stop revalidation without a plan returns
REVALIDATION_UNAVAILABLE with the read error, rather than claiming an ownership
change. Unknown outcomes cause fresh reads/fencing and bounded retained-file
observation; no second completion call occurs even if
the facade could deduplicate it. Both holds survive unavailable read/fence.
After the 60-second completion wait, successful absent/inProgress reads are
polled using the injected scheduler, backing off from 100 ms to 2 seconds.
Advancing nextUnit or lastRevision resets a 60-second stall budget; readRevision
does not. Each read has its own 10-second transport deadline. A transport loss
or exhausted stall budget permits fencing; elapsed completion time alone does
not. Progress can extend reconciliation beyond 60 seconds, while IPC replies
retain their separate short deadline. Reads share the operation's reconciliation.
Release requires known non-submission or terminal/noLateCommit proof, after
reservation readiness. Partial and unknown outcomes publish no final refresh.

Committed results forward exactly the receipt invalidation to `notifyProjects`
and `notifySchedules` once per operation/revision per service lifetime. Both ports
have a 10-second bound. Their arguments are `(invalidation, operationId, change)`;
`change` contains `operationId`, `expectedProjectEpoch`, and `committedRevision`.
The writer forwards the same change identity as the second argument of its
session invalidation callback. Recovery may repeat these invalidations after a
restart: there is no durable notification acknowledgement. Consumers must
deduplicate by operation/revision and reject stale epochs when reusing cached
project state; process-local deduplication cannot promise once across restarts.
Late async callbacks remain responsible for that identity check as well.
Notification/file observation failure preserves a proven
commit with a separate warning. Detailed outcomes are always receipt-derived;
purged receipts stay unknown. `whenIdle()` is an internal drain for tests and
shutdown coordination, not a reason to discard unresolved holds.

Once a terminal/noLateCommit result and its bounded notification/file inspection
have settled, status returns a cloned cached view. Its observations describe the
recorded readRevision, not a new filesystem scan. Receipt eviction or subsequent
file changes do not erase a previously observed commit. Recovery reads with
unavailable details remain retryable as reads. Operation-ID construction errors
after token consumption return a coded failure and never acquire either hold.

The planner liveness port must include `identity` (PID/start/generation or
remote boot/session identity) and the stable `targetId`, with `sessionKey` when
different. Job records carry their exact `sessionIds` and conversation ID;
member/job aliases deduplicate to one target with the explicit job ID or the
job-source target ID. Each target's sessionIds union includes only rows naming
that live target; the conversation list separately retains all members,
including stopped continuations. Scheduled jobs require schedule/claim correlation.
No-tab jobs remain controlled by the landed stop adapter. **#1090 remains a
gate: A4c4 must not enable user-facing background-job deletion until the atomic
worker-incarnation stop gap is resolved or explicitly accepted by JB.**

For A4c4, `readTarget` must not remove a tab from activeSessions before its PTY
exits. Otherwise the adapter retains proven-dead work but fails safely while
waiting for exitDrain. The main composition must preserve captured references
through actual exit housekeeping.

`test/project-delete-ipc.test.js` invokes actual registered callbacks on a fake
ipcMain with real inventory/planner/stop/service, writer facade, full worker
fixture and disposable SQLite. Process/tree and transport edges are injected;
no native death or real Electron event proof is claimed. Node 20 real-store
cases retain the supported fixture guard. The carried #1074 `kept` correction
is already in `session-index-writer.js`: skipped retirements are removed from
rendered unarchived results through `keepArchived`; no duplicate fix is needed.

A4c2a adds opt-in stop evidence to the existing PTY, background job and remote
adapters. `stopPtyWithEvidence` pins the PTY object, PID and generation; Windows
retains the assigned job through termination and a bounded empty-membership
observation. Unsupported platforms refuse before closing. Background IPC init
returns callable `checkStop`/`runStop` ports alongside its existing unsubscribe
and handoff function. Strict checks name the exact job and conversation parts,
use `workerLiveness: 'all'`, check continuations, and read again after stop.
Remote strict mode pins a Linux PID with pidfd, validates boot/start/session
identity before each signal and obtains death from a separate SSH read. Its
proof has `scope: 'process'`; it does not certify descendants or successors.
See [session-state.md](session-state.md), [bg-agents.md](bg-agents.md) and the
Windows helper section of [ipc-bridge.md](ipc-bridge.md) for contracts/limits.

`project-delete-stop.js` now composes those seams through
`createProjectDeleteStop(ports).preflight/stop/verify`. It is composed by the
internal A4c4 main service. A4c3 supplies the token service and callback tests.
No preload, UI or scheduler stop is enabled.
`cliSessionState.getScheduleRunSnapshot` was already exported by A4c1;
headless schedules remain named blocking targets without safe tree control.

### A4c2b stop adapter contract

`preflight({project, targets, conversations, stopBackgroundJobs})` captures a
private batch and returns an opaque, instance-bound handle. `project.projectPath`
must be a non-empty string naming the canonical selected scope; missing, empty,
whitespace-only or non-string paths refuse with STOP_INPUT before reads/effects.
Conversations name `{id, sessionIds}` including
every continuation part. Each target names `{id, kind, conversationId, sessionIds,
identity, sessionKey?, jobId?, scheduleId?, claimId?}`. Kinds are `pty`, `job`,
and `remote`. Identity requires positive PID and OS `procStart`; PTYs also
require generation, remote targets alias/sessionId/bootId. The request and
bindings are copied so caller mutation cannot widen consent. A returned handle
can be stopped once; a failure never authorizes replay.

The composition ports are explicit, authoritative reads:

- `readTarget(target)` returns the same identity/ownership fields plus
  `supported: true`, the actual `session` object where applicable, a remote
  `descriptor`, and `attachments: [{sessionKey, session}]`. Supported means
  the pinned runtime has the landed evidence capability, including a tracked
  Windows job or strict remote host capability; a cached descriptor alone must
  never set it. This reader must detect replacement workers, generations and
  job incarnations, including jobs without tabs. It returns absent when removed.
  After positive proof, attachments still listed must belong to the pinned set;
  detached attachments may disappear. Retained attachment pins still reject a
  replacement session/PTY/PID/start/generation in the active map. A removed job
  or remote binding may coexist with its still-pinned attachment until detach;
  the absent-binding activeSessions check applies only to non-attachment keys.
- `readConversation({id, sessionIds})` returns `{known:true, complete:true,
  owners:[{id, identity, treeState:'live'|'dead'}]}` from exhaustive independent
  process/tree evidence, including background, schedule and non-PTY continuation
  owners. Owner IDs correlate to target IDs. Dead owners stay represented with
  pinned identities; disappearance alone cannot be translated to dead. A
  successor, new owner, unknown tree or changed incarnation refuses.
- `activeSessions` supplies the authoritative tab map. `getScheduleRunSnapshot`
  is the A4c1 read port; `bg` is the landed init result with `checkStop/runStop`;
  `remote` is the strict remote adapter. The optional `stopPtyWithEvidence` port
  defaults to the landed PTY function. `detach(pinnedAttachment)` is only invoked
  after independent death and must close precisely that captured attachment.
- `now/schedule/cancel` bound all adapter reads/effects. The absolute 60 s batch
  deadline starts at preflight; each stop gets at most 15 s within it, including
  death reads and exit housekeeping. Inject the same clock into background and
  remote compositions. Native PTY/helper seams retain their own real deadline
  implementation. An expired asynchronous effect is unknown, never cancelled
  retroactively or replayed; adapter timers are cleared in finally.

The 15 s per-target cap is shared by pre-stop reads, the seam, post-stop reads
and drains. It is not a reserved 15 s remote transport budget. Strict remote
TERM/KILL splitting activates only with more than 12 s left at seam entry;
three seconds or more of preceding reads (or the 60 s batch boundary) can
disable it and leave KILL unreachable. This composed behavior is retained:
giving the seam a new 15 s window would exceed the agreed per-target cap, while
reserving transport time would require a separate read-budget policy. The
operation then refuses or reports an attempted/unknown effect; it never infers
death. The 1,500 ms round-trip witness proves the split when entered with its
full 15 s, not guaranteed KILL reachability after arbitrary adapter reads.

Background incarnation protection has a seam limit: readTarget pins and checks
the worker around awaits, but strict checkStop exposes only conversation IDs
and worker liveness. conversationCheck does not return the observed worker
PID/start stamp, and runVerb('stop', id) sends a job-ID-only CLI command. A
respawn between the last adapter read and the verb can therefore target the
replacement. Post-checks can refuse changed identity but cannot undo a signal.
Adding optional PID/start fields solely to this adapter would not close that
race; the daemon verb needs an atomic expected-incarnation contract. Until
then, A4c3/A4c4 must treat this as an unresolved stop-seam limitation, not claim
that the adapter alone guarantees no replacement worker is signalled. See
[bg-agents.md](bg-agents.md), dormant guarded stop ports.

Preflight checks every binding, capability, consent, guarded job ownership,
conversation and schedule before the first stop. Unsupported local platforms
refuse. Live schedule snapshots are blocking named targets; future #611 records
must correlate scheduleName/claimId/jobId/sessionId to a freshly consented job
target. No daemon ID is invented from a current headless run. Schedule reads
repeat before each effect and at final verification.

Stops run sequentially. The first failure returns individual stopped/failed/
skipped entries and prevents all subsequent stops. Each accepted target occurs
exactly once across those lists, with scope:'target', id, kind and effect:
- 'none': the stop port was not invoked (including preflight/skipped targets).
- 'attempted': the port was invoked, but no identity-matching positive proof
  was accepted; timeout or thrown transport errors retain this state.
- 'proven-dead': an identity-matching ended:true proof was accepted. This is
  the seam's death evidence (remote scope remains process); it does not imply
  that independent conversation checks, detach or exit housekeeping succeeded.

Successful stopped entries carry effect:'proven-dead'. A later STOP_IDENTITY,
CONVERSATION_CHANGED, DETACH_FAILED or EXIT_DRAIN_UNKNOWN retains that effect
on the failed target. Failed targets with either attempted or proven-dead have
unknown:true, so legacy consumers cannot read failure as known absence of an
effect. The explicit effect distinguishes proven death from uncertainty.
Batch/conversation/schedule refusals get a separate scope:'batch' entry with
no kind (id is the named headless session where available, otherwise 'batch').
These entries do not stand in for a target: unattempted targets stay skipped;
an affected attempted target also has its own failed entry. A batch entry's
effect:'none' describes no direct stop call, not the effects of earlier targets.
Consumers enumerate target entries by scope, rather than treating every failed
entry as a stop target. The adapter rechecks pinned
objects, PID/start/generation, membership and death around awaits. Missing active
rows are tolerated only after a positive stop proof, with retained bindings and
independent full conversation evidence. Background jobs stop before attachment
detach; remote process proof is followed by independent tree/conversation proof
before closing SSH. Kill ACK, exited, job done, detach, absent descriptor or gate
readiness never suffice. Known exitDrain promises are awaited before completion.
`verify(handle)` repeats identity, schedule and whole-conversation death reads
within the original deadline after a successful batch. This is stop evidence,
not a replacement for the service's post-stop membershipDigest re-inventory or
writer fencing; no writer/deletion port exists here.

For the #1081 natural-exit obligation, the adapter re-reads the pinned PTY's
`statusTreeExit` after a refused stop. A positive empty-job proof can recover a
natural exit only while object/PID/start/generation still match, followed by
independent conversation proof and exitDrain. A replacement generation refuses
even when that late natural proof exists. Main's earlier one-shot read is not
relied upon; main needs no change for this dormant adapter.

Plain-Node tests use production modules and fake external/process ports, plus
the unchanged seam suites. They are not native process-death, daemon or SSH
acceptance. Native Windows evidence and actual callback acceptance remain CI
and A4c3/A4c4 obligations.

An unknown transcript folder with an inaccessible cwd only refuses the selected
project when that cwd is lexically under the project path (including equality).
After EACCES or EPERM the comparison resolves the nearest readable ancestor, walking
past denied or missing parents within the discovery budget. An 8.3, junction or
symlink spelling then identifies the same subtree as the canonical project
even when the final cwd realpath is denied. Foreign cwd exclusion is preserved.
Budget errors still propagate, and a failed ownership lookup does not stop the
scan before later attributable transcripts.

A4b4 already supplies `completeProjectDeletion`, integer writer revision and
project epoch fences, exact groups/members plus jobs/tabs/schedules inventory,
terminal/noLateCommit outcomes and committed invalidation targets. Main, IPC
and the two user entry points still have no new deletion caller. The earlier
substrate sections below describe their historical landing boundary.

`createProjectDeleteInventory` supplies the six planner ports, with an explicit
writer, projects directory, data directory, active-session Map, scheduler
snapshot and authoritative job/liveness readers. It does not populate caches,
seed schedule registration, claim minutes or refresh projects. Missing liveness
or job authority refuses; headless schedule runs remain external uncontrolled
processes. Saved working-set identities are unioned with active tabs; durable
cache ownership preserves remote hosts and uncertain fresh restores refuse.

The ordered worker snapshot pages sessions (including archived cache rows and
continuation links), folders, metadata/provenance, settings and project fences.
All pages and the final revision read must agree. Each SQL page bounds row count
and projected byte size before fetching payloads. Receipt pages also include
retained committed headers, so bootstrap's interrupted-only list is insufficient
by itself. Neither read route increments revision or enters mutation routing.

Discovery bounds aggregate entries/records (20,000 default, 50,000 hard), bytes
(32 MiB default, 64 MiB hard), transcript heads (16 KiB), other files
(8 MiB default, 16 MiB hard), each port
(3 s default) and the whole observation (10 s default, 15 s hard). The clock and
timer ports are injectable. Directory iteration and file reads are asynchronous;
realpaths are memoized within an observation. Attributable unindexed/unmapped
transcripts, missing parts, linked files/directories, mixed ownership and
unreadable schedules remain refusal candidates. Unrelated orphan metadata does
not refuse another project. Empty registered projects without durable settings
ownership refuse only when settings erasure is selected. Remote
ownership and schedules need authoritative bounded readers; unavailable remote
discovery refuses and cached absence never proves completeness. These ports retain
declared host and POSIX identity; they never apply local path normalization.

Disabled and malformed schedule filenames remain visible. Existing matching
schedule-state claims and schedule-runs results are read without pruning or
claiming. `inspectRetainedFiles` returns a bounded size/mtime/path manifest;
it grants no unlink authority. All source, transcript and schedule files remain.
Live PTY objects are projected to cloneable identity/generation/PID fields.
Transcript IDs must agree with the indexed identity or its parent/bridge binding.
Expired open/opendir calls dispose their handles even when the IO resolves late.

After a committed completion/fence unit, failure of the auxiliary `hasHistory`
read keeps the pending-history guard conservatively armed. The written result,
settings ACK and producer fencing survive. Transaction failures still reject.
Plain-Node real-store tests exercise this worker path, restart sealing and lost
committed replies. Actual handler, stop/death, native crash and renderer acceptance
remain A4c2–A4d/CI obligations, not A4c1 claims.

### Review corrections (A4c1fix)

Transcript discovery reads at most the first 16 KiB and parses only complete
records. For a Claude main transcript, UUID filename identity means a file exists
at the mapped path and the bounded prefix does not contradict it. A raw sessionId
UUID scan can also establish identity. Subagents whose sessionId follows a large
message use the matching parent directory and agent filename plus a bounded raw
agentId string scan; contradictory identities still refuse.
When complete records supply no cwd, a bounded raw cwd string scan takes priority
over the indexed projectPath. Only absence of a cwd key in that prefix allows the
row fallback, and its resolved encodeProjectPath must exactly match the folder.
Encoding is not injective, so it cannot override a recorded cwd. An incomplete or
non-string cwd value does not permit the fallback. Main transcripts retain strict
cwd ownership. A subagent in its indexed parent's folder follows that parent's
project ownership regardless of its own cwd; a cwd under the selected project is
also acceptable for a matching subagent layout.
It charges bytes actually read, while preserving full stat size and mtime for
the member manifest.
Recognized child worktree cwds (including .work-files/worktrees) resolve to their
parent for transcript attribution; child cache groups remain separately retained.
Worktree attribution is lexical after bounded, memoized realpath registration;
it does not call the synchronous filesystem worktree resolver.
Schedules and retained evidence still require bounded complete reads.

Orphan session_meta and session_meta_fields IDs are matched to transcript paths
during the bounded owned-folder walk, including subagent layouts. Attributable
orphans refuse because they lack durable ownership; unrelated orphans stay
outside the manifest. This does not grant metadata deletion authority from a
filesystem observation alone. Durable links to absent indexed parts still refuse
the owning project. Unmapped cache
rows refuse only with selected-folder evidence. Unindexed files are attributed
by their bounded first cwd or the selected folder mapping/exact encodeProjectPath
encoding. A foreign cwd in a selected folder remains a refusal candidate. Known
foreign folders are skipped; foreign heads outside selected folders are excluded.
Per-file cwd realpath failures remain candidates and scanning continues through
the folder; deadline and budget errors still propagate immediately.
Settings ownership is required only when settings deletion is selected.

Snapshot reads restart from the first section/page on SNAPSHOT_STALE, at most
three attempts by default (snapshotAttempts injection, hard cap five). The
injected now clock, original deadline, item and byte budgets cover all attempts;
discarded pages still consume budget. A settings page whose first row exceeds
the 1 MiB page bound retries that same cursor with limit=1 and a doubled bound,
up to the lesser of the remaining aggregate budget and the store's 8 MiB hard
cap. The store's conservative JSON byte bound still applies (six times raw
string bytes plus overhead); failed sizing probes fetch no payload. Other errors
never retry. Raw settings use the same JSON-parse-or-string fallback as getSetting.

## Historical landing: persisted progress substrate (#474 A4b1)

`project-delete-progress.js` is a dormant backend library. Its store schema,
transaction hooks, budgets and worker routing are documented in
[session-index-writer.md](session-index-writer.md#dormant-project-deletion-substrate-474-a4b1).
At the A4b1 landing there was no `completeProjectDeletion` command or production deletion caller.
The existing planner and its fingerprint semantics are unchanged.

`operationId(project, expectedEpoch, uuid?)` binds a canonical `[alias,path]`
hash, epoch and UUID. Receipt eviction cannot make that ID valid at a newer
epoch. `createProjectDeleteProgress(store)` exposes trusted `admit`, `stage`,
`apply`, `readScope`, `read`, `fence`, `recover` and `purge` seams. A substrate
manifest supplies the bound ID/project, expectedProjectEpoch, integer
expectedRevision, membershipDigest, writerMembershipDigest, five boolean
options and ordered `{category,target}` units. The substrate validates its
shape and freezes its hash; full manifest inventory/ownership validation
belongs to A4b3 before any real deletion effect is supplied. It does not make
arbitrary callbacks safe. Effects are synchronous database work only.

`readProjectDeletionScope({project})` returns
`{writerRevision,projectEpoch,writerMembershipDigest,scope}` on the worker.
The digest conservatively includes all cached ownership rows and folder
mappings, plus selected metadata/provenance and settings-key names. It can
refuse after unrelated durable changes; it cannot certify complete runtime
membership or settings ownership. A4b3 will build the authoritative durable
projection and share the planner's pure identity helpers.
Malformed cached project paths never match a project; their raw ownership rows
remain in the digest so corruption cannot silently remove ownership evidence.

`getProjectDeletionState({operationId,project})` reports actual staged unit
results as completed/kept/failed/pending lists, plus total/staged/unstaged
counts. Before staging finishes, unstaged targets are deliberately unknown
to the receipt. A committed prefix stays `inProgress` until sealed; a fence
or restart seals it `partial` without undoing that prefix. Readback includes
current projectHidden/settingsPresent/metadata with `readRevision`; these
are separate from recorded effects and `lastRevision`.

`fenceProjectDeletion({operationId,project,expectedProjectEpoch})` closes an
owned operation or records a positive sealed `notStarted` tombstone only at
the encoded unchanged epoch. An observation of absence has no such meaning.
After expiry/removal, status is `unknown` when the epoch has advanced, and
noLateCommit remains provable for that old ID. Foreign IDs refuse; old
fences preserve newer ownership. The persisted epoch/seal guard rejects a
later attempt to run an old unit.

An unsealed owner excludes a second operation on the same project. Admission
refuses `DELETION_BUSY` without writes. Fencing a never-admitted foreign ID
returns a nonterminal observation with reason `project-owned-by-another-operation`
and `ownerOperationId`, preserving the current epoch, revision and owner.
Only the owning operation's fence seals that owner. The persisted epoch
high-water mark proves that an older ID cannot commit, even after a later
re-add/unhide clears `blocked`. The `blocked` flag gates archive workflows.

Automatic retention performs at most one purge transaction per call, deleting
at most 16 units. The first purge transaction marks the sealed header as
`purging`, making the receipt unavailable before any unit results disappear.
Readback retains the sealed/epoch proof of no late commit during and after
purging. A large receipt can temporarily leave more than 128 terminal headers;
later calls or explicit maintenance finish trimming it.

A4b4 obligation: an unrelated writer commit between chunks currently causes
`apply` to throw `WRITER_STALE`, leaving the operation `inProgress`. Admission
of another deletion of the same project also refuses `DELETION_BUSY` until
fence/recover frees the owner. Completion
must either tolerate unrelated revision bumps using the membership digest or
deterministically seal the committed prefix as partial.

Archive workflow exclusion and epoch-aware existing producers remain A4b2;
actual metadata/settings effects and manifest validation remain A4b3; the
complete bounded command and queued-producer fencing remain A4b4. Main
recovery holds, stop evidence and filesystem inspection remain A4c. This
slice makes no AC2/AC3/AC10 or complete AC9 claim and needs `no-changelog`.

## Read-only planner

`src/main/projects/project-delete-plan.js` exports
`createProjectDeletePlanner(deps)`. It has no production caller yet. A4b owns
writer completion; A4c owns admission, tokens, IPC, actual process stops and
composition of the ports below; A4d owns both UI entry points. Existing Delete
and Archive behavior is unchanged by this library.

`preview({projectPath, folderKey?, options})` returns
`{ok:true, plan}` or `{ok:false, code, error}`. The five options are required
booleans: `sessions`, `settings`, `schedules`, `transcripts`,
`stopBackgroundJobs`. Unknown request/option fields and true physical choices
are rejected. There is no worktree consent input in A4.

An ok response means the inventory could be assembled. A plan with any
`refusals` is **not confirmable**. Consumers must inspect this list, rather
than treating ok as permission to stop, write or hide anything.

`revalidate(plan)` returns `{same, plan}`; unavailable discovery returns
`{same:false, plan:null}`. It resolves the bound host/path against a new known
snapshot even for a remote project with no backing cache groups. It does not
silently recover a remote failure by selecting local. A changed writer revision
alone does not change the fingerprint. A refusal always makes same false.

## Injected read ports

Every port must be read-only and asynchronous. No port may call the current
`getProjectsSnapshot` from main.js, `groupDiskIds` from archived-projects.js,
writer refresh/backfill/reconciliation, or a retirement/apply-and-persist path:
those can write during preview. The existing schedule list is insufficient
because it silently skips unreadable matching files. A4c must supply a bounded
reader retaining those candidates. Neither Electron nor SQLite is imported by
this module.

The planner passes `{signal, limit, deadline}` to all ports. Ownership also
receives `snapshot`. Ports must honor the deadline/AbortSignal, bound IO,
record sizes and total bytes before allocating replies, and use a worker or
bounded asynchronous IO for discovery/hashing. They must not recursively scan
the filesystem synchronously on main. The planner limits total inventory items
to 20,000 (configurable downwards or up to a hard ceiling of 50,000), and total
wall time to 10 seconds (configurable up to 15 seconds). A timed-out port cannot
advance to later ports. Abort does not make a port with side effects safe.

1. `waitForIndex(budget)` waits for already-running normal indexing. It must
   never start a refresh or change persisted state. An unavailable/unfinished
   scan fails closed within the deadline.
2. `readSnapshot(budget)` performs a writer-ordered consistent read and returns
   `{revision, complete, initialScanComplete, declaredHosts, projects}`.
   `revision` is a nonempty opaque string; `declaredHosts` contains alias
   strings. Each known project is `{alias, projectPath, folderKeys,
   cacheFolderKeys?}`. Include hidden/archived/registered projects and known
   runtime projects, not just visible sidebar rows. `folderKeys` are verified
   lookup mappings; optional `cacheFolderKeys` enumerates known backing groups
   that must be rediscovered (an empty registered project need not have any).
3. `discoverOwnership(project, budgetAndSnapshot)` returns
   `{complete, groups, members, candidates}`. Include all verified backing
   groups, archived rows, every continuation and subagent, filesystem candidates
   missing from the index, and separately known child worktrees. `complete:true`
   certifies exhaustive discovery, not merely that a cache query succeeded.
4. `discoverSchedules(project, budget)` returns
   `{complete, schedules, candidates}`. Inventory exact identities and paths,
   including disabled, invalid, unreadable, disappeared and linked matches.
   Never silently skip failed directory reads; use complete:false or candidates.
5. `readRuntimeState(project, budget)` returns
   `{complete, tabs, jobs, candidates}`. Cover active, dormant, saved and pending
   restored tabs, transcriptless terminals, daemon jobs, scheduler claims/runs,
   remote liveness and external process evidence, including jobs without tabs.
   Correlate background/schedule identity rather than assuming no tab means dead.
6. `readRevision(budget)` is another writer-ordered fence returning the current
   revision string. A change since readSnapshot refuses the entire preview.

All arrays, including candidates and empty arrays, are explicit. A rejected
port produces DISCOVERY_UNAVAILABLE unless it supplies a specific error code;
incomplete, stale, over-budget and timed-out snapshots cannot yield a plan.
Snapshots/results are cloned so sorting and augmentation do not mutate ports.
There are no write, stop, token, gate-hold or persistence dependencies.
The input is cloned before validation, so accessors cannot replace validated
values. An uncloneable request is INVALID_REQUEST, including function-valued
fields and Symbol options; a native DOMException code is never its reply code.
Each planning call memoizes local realpath by distinct resolved path;
ownership and cwd checks reuse that memo. Inventory processing yields via
setImmediate after at most 32 rows or 8 milliseconds of work and checks the
deadline before each row and after yielding. One synchronous filesystem call
cannot be interrupted; adapters must still bound individual calls and record
sizes. Sort keys are computed once per row and compared by code units.

## Ownership and evidence records

Every scoped row carries an explicit `alias:null|string` and `projectPath`.
Do not omit the host and infer local. Local paths use normalize-project-path
and Windows case folding; remote paths use POSIX normalization with case kept,
without local realpath. Both are absolute. FolderKey is a lookup hint, never
authority: its known mapping, parsed alias and requested path must all agree.
Absent folderKey selects only a known local identity. Undeclared, conflicting
or missing remote mappings refuse.

Groups carry `folderKey`, `runtime:'claude'|'codex'`, `verified:true` and optional
`parentProjectPath`. Parent membership must be verified independently. The
existing `.claude/worktrees/<name>` nesting is also recognized; other worktree
layouts need their explicit parent. Children are returned with effect kept;
prefix siblings and other hosts are not members. Selected groups have effect
selected. Duplicate/unverified/host-conflicting groups refuse.

Members carry `id`, `conversationId`, `partId`, `subagentId:null|string`,
`folderKey`, `cwd`, `runtime`, `verified`, `indexed`, `present`, and `liveness`.
Include additional exact transcript/session IDs, parent IDs, archived state,
sessionFile and ownership/file identity evidence when applicable; raw record
fields survive in the plan and fingerprint. Members must match their verified
backing group's runtime, exact project/cwd and host. Missing/unindexed/linked
or unsupported members refuse; they are not silently dropped from a count.
Any raw member, tab or job claiming a selected folder but failing exact
host/path ownership produces MEMBER_OWNERSHIP instead of silently disappearing.

Tabs and jobs carry unique `id`, `runtime` (also terminal for tabs), `verified`,
`liveness`, and any `name`, `conversationId`, `jobId`, `scheduleId`, `background`
and restore-kind details. Stop evidence is
`{state:'stopped'|'running'|'unknown', source, targetId?, ...identityEvidence}`.
Sources are pty, descriptor, remote, job or external. The adapter must prove
ownership and reliable liveness with PID/start/generation/remote evidence; a
bare request to kill is not stopped evidence. Include that evidence in the
record so replacement changes its fingerprint. Unsupported runtime evidence,
including Codex without a reliable descriptor, stays unknown. Running external
processes refuse. Live controlled targets are listed in stops with exact
evidence. Background jobs without fresh stopBackgroundJobs consent are named,
marked excluded and cause a refusal. No actual stop occurs here.
The background classification also includes running members/tabs with
background:true, jobId or scheduleId. Duplicate tab/job IDs cause
MEMBER_OWNERSHIP, as duplicate member IDs do.

Schedules carry unique `id` and `path`, `verified`, `readable`, `enabled`, optional
`linked`, and `problems`. Keep schedule/run identities and ownership/file
evidence in these records. Unreadable or unverified schedules refuse even though
A4 keeps their bytes. Invalid schedules stay inspectable with warnings.
Candidates carry a path/id and reason; every candidate causes an explicit
refusal. Ports can restrict candidates to the requested scope, but unknown
ownership must not become a silent omission.

## Plan and downstream obligations

The frozen DeletePlan fields are project, groups, members, tabs, stops,
schedules, categories, counts, warnings, refusals, membershipDigest,
fingerprint, revision. All detail is retained beyond ten entries.
ProjectIdentity is `{key, entry, alias, projectPath}`. The key binds canonical
host/path; entry follows existing local or alias-qualified hidden-entry spelling.

membershipDigest binds identity and ownership only, independently of revision.
Its project is canonical alias/projectPath, without the display entry spelling.
For each group/member/tab/job/schedule it includes alias and canonical
projectPath, plus these fields when present: id, folderKey, runtime,
conversationId, partId, subagentId, parentSessionId, sessionId, jobId, scheduleId,
sessionFile, path (including schedule id/path), effect and kind, and canonical
cwd/parentProjectPath. These are the complete field allowlist. It excludes
liveness, stop evidence/targets, names, verification flags and volatile file
evidence such as size/mtime, including nested file evidence. A4c can therefore
compare membership after stopping processes without interpreting an expected
liveness change as new membership.

Nullable cwd/parentProjectPath fields stay null in the membership projection.
A malformed row path produces a GROUP_OWNERSHIP refusal for a group or a
MEMBER_OWNERSHIP refusal for a member, tab, job or schedule. The full plan
remains inspectable with that refusal; a row path cannot turn the selected
project's valid identity into a whole-preview IDENTITY_UNAVAILABLE failure.
A retained conversation member still requires cwd to match its project;
nullable dormant-tab cwd does not supply conversation ownership evidence.

Fingerprint binds membershipDigest, the full scoped raw group/member/tab/job/
schedule records (including liveness and file evidence), the five options,
exact stop identities/evidence, categories and warning/refusal state. Stopping
changes fingerprint while preserving membershipDigest. Inventory and object
key ordering are canonicalized; identity projections are sorted independently
of volatile raw fields. revision is only the writer fence and is excluded from
both hashes. It cannot stand in for membership or process evidence.

Shared path-only settings keys are unavailable when another known host has the
same path spelling after separator/trailing normalization. Selecting their
erasure produces a refusal. When multiple known rows share one canonical
identity, canonical row sorting selects the display entry deterministically,
and every selected spelling participates in the shared-settings check.
Otherwise sessions means discard versus archive,
and settings means delete versus keep. Physical files, memory, .work-files,
worktrees, project directory and branches stay kept. Retained transcripts can
restore transcript titles; retained schedules can reactivate on re-add. All
server files stay kept remotely.

A4c must revalidate under its project operation gate after acceptance, reject
any changed/refused plan, independently verify actual process exits and writer
outcomes, and never enlarge consent. This read-only planner does not lock
external writers or prevent filesystem/process races. The later service owns
final process/schedule correlation, snapshots at admission and recovery.

## Archive workflow exclusion (A4b2)

`project-archive-workflow.js` maintains a WeakMap per writer client. All
`withCache` facades share canonical host/path keys. Archive, Undo, offer,
retirement, clear, dismiss, hide and explicit reopen register their complete
sorted key set atomically. Ordinary workflows share each identity; only a held
deletion reservation refuses new workflows with WORKFLOW_BUSY. Each key tracks
all admitted leases, and a reservation waits for every one of them. Concurrent
archive completion still checks the begin record before committing its result.
Retirement includes a worktree's parent only while that parent has an archive
record that can actually be retired; a retained child without such a record
does not inherit its parent's workflow reservation. The archive-only identity
adapter preserves legacy host-qualified Windows path inputs by projecting
their separators and drive into a rooted host path; the stricter deletion
identity contract is unchanged. List reads skip invalid archive identities,
including an unvalidated relative remote cwd, while preserving those projects
in the computed list. Mutation and deletion identities remain strict.
The lease covers refresh/effects, worker requests, async injected callbacks,
catch-up claims, schedule rewrites and completion ACKs.

The library-only `reserveProjectDeletion(projects)` reserves synchronously
before returning `{ready, release}`. `ready` waits for already admitted
workflows; new conflicting workflows refuse immediately. A4b4 must retain the
reservation until deletion ACK or terminal fence/readback after an unknown
outcome. `release` is idempotent after readiness and refuses early release.
There is no deletion caller, IPC or UI in A4b2.

Each admitted mutation workflow reads fresh archive epoch proofs on the writer
before its first mutation. List reads tolerate blocked identities; only entries
actually selected for retirement undergo the mutation guard. When the reader's
cheap `hasFences` query finds no durable fence, a list skips the epoch round trip.
Any retirement then uses the epoch-zero guard at writer admission, which still
rejects a fence created after the cheap read. Once any durable fence exists,
lists acquire fresh proofs including blocked identities. Begin/completion,
retirement, Undo, clear/dismiss and hide
check those proofs against durable project_delete_fences. Pending/deleted
identities and supplied proofs omitting an affected identity refuse, including
at epoch zero. Only fresh explicit add/unhide may reopen: they advance
the epoch and clear blocked without resetting any receipt or scope. They
refuse while an unfinished deletion owns the identity. Legacy unfenced
epoch-zero calls retain their results; old epoch proofs cannot survive re-add.

Private workflow IDs tag every client request including cache effects.
Timeout or unknown transport outcome seals the lease, suppresses callbacks
that have not started, and waits for a worker cancellation barrier. The
client removes unsent requests before submitting that barrier. The worker
seals the ID at a service boundary, removes queued/deferred commands, and
checks the seal at dispatch and transaction admission. Barrier ACK follows
the last executing transaction. This cancels future work; already committed
chunks are retained. Cancelled commands with committed prefixes still publish current settings
on their error reply, preserving the acknowledged mirror after partial work.
A failed/unreachable barrier retains the lease and deletion remains held until
the client confirms termination of the worker that received that workflow's
requests. The facade then releases the sealed lease; a replacement has no
in-flight requests for it. Termination failure never releases that lease.
Posted commands are never replayed across restart;
a replacement can ACK only after the client has awaited old-worker termination.
Client seals retire only when the facade and all its requests have retired;
the worker then receives an ordered retirement control command. Failed active
requests and circuit-stop queues also run retirement cleanup after removal,
including their client seal and worker-termination bookkeeping.

Receipt retention uses a separate bounded store transaction without advancing
_writer_revision: sealed-receipt maintenance changes neither project data nor
membership. This preserves the next owned admission/apply chunk's exact
revision. Each turn deletes at most sixteen unit rows, keeps phase=purging
unavailable from its first turn, and drains an existing purge before selecting
another receipt. Durable epoch high-water marks are retained.

The race suite loads the facade directly and the unwrapped production worker
in a VM with a real conversation-store fixture and Node 20 skip guard. It
asserts disposable schedule/claim bytes, sibling sharing, async callbacks,
epoch ABA refusal and queue cancellation. A4b4 still owes the real completion
integration witness for AC10; no metadata-deletion completion is claimed here.

## A4b3 dormant metadata engine

`project-delete-identity.js` supplies the planner's unchanged canonical path,
stable serialization, identity projection and membership hash. The planner now
returns jobs, which were already included in its digests. Nullable paths,
sorting and per-preview normalization memoization retain their previous meaning.

`project-delete-writer.js` exports `readDurableScope`,
`validateDeletionManifest`, `buildDeletionUnits`, `applyDeletionUnit` and
`buildFinalizationUnits`. No completion command, deletion IPC or UI calls them.
The validator binds the operation ID, integer revision, epoch, durable digest,
five explicit boolean options and identical inventory/member/group copies.
It recomputes membership, checks persisted row/folder ownership and refuses
foreign, duplicate, missing or unproven targets. Session IDs have no host column;
conflicting durable links refuse rather than granting ID-wide authority.
Validation indexes durable ownership once by session ID and folder, and indexes
folder metadata and manifest groups before checking members. Each durable row's
owner key is cached; group, member, runtime and owner path checks share one
normalization memo for the validator, including operation binding, scope reading
and membership hashing. Each scope read also memoizes owner identities by raw
host/path, including failed identities as nonmatches; standalone reads start
fresh, and no memo survives a validation call or spans transactions. Validation therefore avoids
per-member and per-linked-ID scans of the complete ownership inventory.
Metadata-only history requires a parent, merged-part, continuation or bridge link
from an owned persisted row and no foreign reference. Unowned orphan metadata
stays outside the manifest. Linked historical
metadata and provenance participate in the durable scope digest as well.

Settings erasure independently requires durable row/folder ownership evidence.
A path-only key alone cannot establish that evidence. Shared host/path owners,
missing ownership and ambiguous key spellings refuse before all effects.
Remote POSIX settings keys retain case even when the writer runs on Windows;
local Windows normalization cannot authorize erasing another remote spelling.
This proves only the available persisted inventory: A4c must independently
validate runtime-only ownership under its admission hold.

Each session unit archives the exact retained ID or erases both metadata tables,
then invalidates only that ID's cache, metrics, session FTS/map/content, temporary
search staging and continuation choice. Archive retains name/star provenance.
Only exclusively owned folder markers are removed; no folder-wide cache/search
delete is used. Memory and work-file search entries remain. Unit effects execute
synchronously inside A4b1 progress transactions: effect, ledger and the single
writer revision commit or roll back together. No #380 request journal is purged.

Finalization is prepared separately, outside normal deletion units, for A4b4's
atomic final group. It merges current global visibility and working-set fields,
preserves unscoped legacy marks, directly subtracts archive/offer keys matching
the selected canonical identity, and subtracts only the selected local stored
schedule registration.
Remote finalization never removes local registration; absent registries are
never seeded. Restore pruning requires a manifest-proven selected member/tab ID
and a string project path matching the admitted identity's path, including
transcriptless dormant tabs. The working-set producer persists no host field;
the admitted restore targets supply the owner rather than saved-tab host hints.
Restore pruning assumes session IDs are globally unique across local and remote hosts, since the working-set producer writes no remoteAlias.
The returned invalidation targets do not touch mainTouchedCache or renderer
maps/pending saves. A4d must also serialize the whole-global working-set producer.
The finalization helper itself supplies neither cancellation nor admission;
A4b4 owns revision/epoch/ownership revalidation before every chunk and the final
atomic group. Raw producers starting after deletion are also A4b4's boundary.

Step-0 corrections: project lists omit reserved identities from leases/proofs
and retirement, while unrelated identities continue. Writer retirement drops
currently blocked entries before guarding the remainder, but supplied stale
epochs still refuse. A readonly hasFences failure falls back to the writer
epoch request. New archive/Undo/offer mutations still refuse reservations.

Real-store tests cover the settings/session matrix, exact parts/subagents,
historical/orphan sentinels, shared-key refusal, rollback, temporary publication,
and retained disposable transcripts reindexed by the production cache/effects
facade after reopen. These are AC2/AC3 engine witnesses; the A4b4 integration
below exercises the complete command. A4c/d own stop/IPC/renderer behavior. Node 20 skips real
stores when the native ABI and node:sqlite fallback are unavailable.

## Complete command and recovery integration (A4b4)

`writer.completeProjectDeletion(manifest)` is an internal backend command. Main,
IPC and both user entry points still use their previous contracts. The facade
reserves archive exclusion synchronously, shares it across `withCache` facades,
awaits existing workflows and forwards once. Backend fencing also waits for an
existing reservation's readiness. An unresolved operation pins even an externally
reserved hold: release refuses until positive terminal or no-late-commit evidence.
Different operation IDs cannot share that hold; the second command refuses before
submission, preventing either ACK from stranding the other's exclusion.
Timeouts, failed sealing and unavailable transport retain exclusion. Reads of
absent/inProgress state do not release it. Fresh committed readback supplies exact
session/restore/folder invalidations; exceptions and late transport ACKs alone do
not publish them. No filesystem callback belongs to this command.

The dedicated worker iterator validates the manifest, admits its epoch/header,
stages frozen units in batches of at most sixteen, applies exact session/folder
and optional settings units, then applies one final logical group. Hide, direct
archive/offer subtraction, local registration subtraction, saved working-set
pruning and the sealed receipt commit together. Tiny manifests (at most two units
and 16,000 manifest bytes) can admit and complete in one transaction. Larger
operations expose committed prefixes and never claim atomicity across chunks.
Each chunk verifies its exact previous revision, owned unsealed epoch and current
row/link/folder ownership inside its transaction. Conflict or effect failure seals
fresh partial state; failure to seal remains unresolved for fence/bootstrap.
The failed unit and pending units stay distinguishable. Bootstrap seals unfinished
operations before ready and returns their identities; it never resumes them.

The receipt's manifestHash contains a request hash and a full ordered-unit hash.
This permits identical duplicate commands to return recorded status even when
staging was interrupted, without reconstructing targets from changed ownership.
Changed input under the same ID refuses. Expired receipts remain unknown and
epoch-bearing IDs cannot re-enter after receipt eviction. Readback reports both
the exact committed revision and fresh observation revision; selected metadata is
read by receipt IDs after its cache rows disappear.

The producer fence is a no-op without a deletion operation or a blocked fence.
One existence query, using the blocked-fence index, returns an empty binding;
an unblocked Add project/reopen row alone never enables it. Normal messages do
not scan cached rows, folder metadata or deletion operations, resolve paths,
or maintain the deletion-only ownership index. Before a completion or explicit
fence starts, queued messages receive epoch bindings so already staged search
cannot publish through the new deletion epoch.

With deletion history, worker messages bind cache, session FTS and metadata
targets when received. A connection-local, indexed reverse-link table is built
lazily at the first deletion-related binding; its initial SQL population reads
cached ownership. Temporary triggers then maintain exact row/link changes
while deletion history exists. If a forced pre-admission binding never starts a
deletion, a changed store revision rebuilds that index before its next use.
The same reset applies if receipt purge and reopen remove all deletion history
and protection subsequently returns. Nested session units of a folder deletion
retain their enclosing folder binding as well as any session binding.
Each producer looks up only its target IDs, folders and matching deletion units;
it never materializes all cached rows, folder metadata or operation headers.
The owner-row statement is cached with the deletion statements, prepared lazily
after the temporary reverse-link table exists. A known session owner or supplied
project path does not load sibling cache rows from its folder. Folder commands
and sessions lacking both proofs retain the complete folder fallback, including
mixed-folder ambiguity checks. Folder metadata and deletion history still
participate in the same identity resolution.
The binding survives every requeued unit and is rechecked before each effect,
including staged FTS publication. Ownership comes from supplied row paths,
durable rows/links/folder mappings and deletion-unit history. Multiple owners
bind together unless a candidate has a deletion operation or blocked fence.
That ambiguity refuses only its target. An unresolvable supplied path proves no
owner for that target. Other targets in the batch still run; the final error ACK
publishes committed settings. A target unowned when bound retains that uncertainty
and cannot adopt later evidence to bypass a deletion epoch.
Old producers cannot publish after admission; new selected producers stay
blocked through committed deletion until explicit fresh re-add. A sealed partial
allows newly bound reindexing and a newly validated cleanup operation, while old
deletion IDs remain sealed. After detailed history is purged, an unowned session
producer is conservatively refused while a blocked fence or operation remains; proven unrelated owners
remain usable. Whole-global renderer saves remain A4d's producer boundary.

Stage/apply errors whose code starts with `SQLITE_BUSY` propagate to the worker's
existing 20/50/100 ms transaction retry loop. They never seal a partial receipt
merely because a retryable lock was encountered; other errors retain sealing.

Budgets retain the shipped indivisible-unit exception. Ledger/revision space is
reserved by progress staging/apply, but an oversized final global/archive/registry
setting and its atomic logical group can exceed row/byte/time targets. Real-store
tests record SQL measurements, including a 180,000-character retained global
payload; this is not proof of a strict bounded transaction. No wall-clock deadline
assertions are used for deletion execution.

Held/blocked archive retirements are excluded from both persistence and the
rendered unarchived result, including when unrelated retirement exhausts its stale
retry budget, while unrelated successful retirements continue. Native worker
integration additions stay in the existing Electron-spawning suites and must be
run in CI. Local witnesses load the full shipped worker with a VM filename and a
real SQLite shim store; a second readonly connection inspects intermediate commits.
Node 20 uses the fixture's supported guard. #380 journal tables and their revision
contract are unchanged. Main sender/admission/stop and renderer recovery acceptance
remain A4c/d.

## Evidence boundary

`test/project-delete-plan.test.js` loads the production module with plain
require and uses isolated in-memory read-port implementations. It exercises the
public planning/revalidation API, AC8 host/path isolation, read fences, candidate
refusals, full details, schedule and background inventory, timeout/item limits
and zero effects. No SQLite, live PTY, remote host, IPC, UI or real filesystem
discovery adapter is claimed by this slice. A4b real-store tests must use the
Node-20-compatible conversation-store fixture; this suite opens no store.
