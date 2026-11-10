# Project deletion: read-only planning (#474 A4a)

## Persisted progress substrate (#474 A4b1)

`project-delete-progress.js` is a dormant backend library. Its store schema,
transaction hooks, budgets and worker routing are documented in
[session-index-writer.md](session-index-writer.md#dormant-project-deletion-substrate-474-a4b1).
There is no `completeProjectDeletion` command or production deletion caller.
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
retirement, clear, dismiss, hide and explicit reopen acquire their complete
sorted key set atomically; conflicting workflows refuse with WORKFLOW_BUSY.
Retirement includes a worktree's parent only while that parent has an archive
record that can actually be retired; a retained child without such a record
does not inherit its parent's workflow reservation. The archive-only identity
adapter preserves legacy host-qualified Windows path inputs by projecting
their separators and drive into a rooted host path; the stricter deletion
identity contract is unchanged.
The lease covers refresh/effects, worker requests, async injected callbacks,
catch-up claims, schedule rewrites and completion ACKs.

The library-only `reserveProjectDeletion(projects)` reserves synchronously
before returning `{ready, release}`. `ready` waits for already admitted
workflows; new conflicting workflows refuse immediately. A4b4 must retain the
reservation until deletion ACK or terminal fence/readback after an unknown
outcome. `release` is idempotent after readiness and refuses early release.
There is no deletion caller, IPC or UI in A4b2.

Each admitted workflow reads fresh archive epoch proofs on the writer before
its first mutation. Begin/completion, retirement, Undo, clear/dismiss and hide
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
A failed/unreachable barrier retains the lease and deletion remains held.
Posted commands are never replayed across restart;
a replacement can ACK only after the client has awaited old-worker termination.
Client seals retire only when the facade and all its requests have retired;
the worker then receives an ordered retirement control command.

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

## Evidence boundary

`test/project-delete-plan.test.js` loads the production module with plain
require and uses isolated in-memory read-port implementations. It exercises the
public planning/revalidation API, AC8 host/path isolation, read fences, candidate
refusals, full details, schedule and background inventory, timeout/item limits
and zero effects. No SQLite, live PTY, remote host, IPC, UI or real filesystem
discovery adapter is claimed by this slice. A4b real-store tests must use the
Node-20-compatible conversation-store fixture; this suite opens no store.
