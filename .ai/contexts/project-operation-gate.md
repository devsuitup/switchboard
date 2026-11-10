# Project operation gate (#474 A3)

`src/main/shared/project-operation-gate.js` exports the main-process singleton
`projectOperationGate`, a factory for isolated tests, and `PROJECT_OPERATION_ERROR`.
There is no deletion caller in A3 and no renderer API. This slice takes
`no-changelog` when published.

`tryAdmit(projectPath, alias = null)` synchronously checks and reserves admission.
It returns `null` when held, otherwise an idempotent `{ release() }` reservation.
`tryAdmitAll(projectPaths, alias = null)` reserves every normalized identity
synchronously or refuses the whole set when any key is held. Equivalent keys
are deduplicated and one idempotent release drains all admitted keys.
Launchers keep that reservation across asynchronous preparation and spawn, and
release on success, refusal, rejection or throw. It is a spawn reservation, not
a lifetime lock for an already running session.

`hold(projectPath, alias = null)` synchronously refuses subsequent admissions for
that identity and returns `{ ready, release() }`. The future operation caller
must await `ready` before inspecting/stopping the admitted work, hold through the
whole operation, and release in `finally`. `ready` drains every previously
admitted launch; holding does not cancel those launches. A second simultaneous
hold throws the shared operation error. Releasing a hold is idempotent and allows
admission again. Releasing and reacquiring while launches drain preserves both
drain notifications. Empty entries are removed; there are no timers.

Local keys use the shared realpath normalizer, absolute paths and Windows case
folding. Remote keys use alias plus normalized POSIX path, preserve path case,
and never consult the local filesystem. Keys are exact identities, not directory
prefixes; another host, child worktree or another project is independent. Launch
callers with both project membership and a distinct spawn cwd reserve both keys.
Remote symlink equivalence requires a canonical path from the caller.

Admissions at this base:

- Scheduler tick and catch-up reserve before any catch-up baseline/minute claim
  or transcript creation, retaining admission until the launcher acknowledgement.
- Run now reserves the validated real project before transcript creation and
  awaits the shared launcher before releasing.
- Every non-attach `open-terminal` mode reserves both `projectPath` and the resolved
  spawn cwd before asynchronous continuation snapshots, MCP preparation or schedule
  registration, through PTY registration, and releases both in the same `finally`.
  This includes resume/fork into child worktrees and panel terminals whose cwd
  comes from `panelTarget.cwd`. Plain terminals follow the same rule.
  Existing live reattachment and remote tmux attachment return earlier. Local
  `type: 'attach'` skips admission entirely: attaching to an existing job starts
  no new work, consistently with `attachOnly` background restore.
- Background dispatch reserves its validated cwd through CLI completion and
  roster reconciliation. Restore reserves the main-owned saved working-set
  `projectPath` through classification, respawn and descriptor discovery;
  `attachOnly` is exempt. Parsed job state has no cwd field, so it is not used
  as a guessed identity. A4 must reconcile saved project membership in its preview.
- Agents-view `bg-agent-verb` respawn reserves the matching saved background
  entry's `projectPath` through the respawn acknowledgement and releases in
  `finally`. Saved entries match by `attachJobId`, or by restore's job lookup for
  legacy entries. Jobs outside the saved working set have no saved project key;
  this slice does not infer one from parsed job state. Stop/delete verbs and
  check-only preview do not launch work and retain their existing behavior.
- Remote launch reserves alias plus validated launch cwd through SSH launch,
  attachment and the IPC's registration callback. The shared launch service
  awaits that callback before releasing, so an operation awaiting `ready` sees
  the registered attach PTY rather than an unobserved remote launch.

The local `origin/main` at `97f600cf` includes #1049 trigger transport but not
#1054's launch executor. Versioned open/new/resume/stop requests all refuse as
unimplemented, while legacy command/chain/key delivery addresses existing PTYs.
There is no trigger spawn to gate or bypass in A3 at this base. When an executor
lands, it must reserve this singleton after target resolution and before its
first asynchronous spawn preparation, retaining the reservation through spawn.
The trigger token bucket is a separate rate limit and cannot substitute for this.

Refusals preserve each launch surface's existing result shape. No process is
stopped here. This lock is in-process and ephemeral; external CLIs, other app
instances, remote filesystem aliases and filesystem changes remain outside it.

Tests load the real module, schedule/background/remote services, or the actual
`open-terminal` IPC slice with a filename and real module-relative require.
`test/project-operation-gate.test.js` covers hold/drain/release and identity;
the launch suites exercise their public refusal and asynchronous boundaries.
