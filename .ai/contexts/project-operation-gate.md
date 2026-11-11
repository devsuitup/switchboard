# Project operation gate (#474 A3)

`src/main/shared/project-operation-gate.js` exports the main-process singleton
`projectOperationGate`, a factory for isolated tests, and `PROJECT_OPERATION_ERROR`.
The dormant A4c3 deletion service now calls the factory; main still has no
deletion caller and there is no renderer API. This slice takes
`no-changelog` when published.

`tryAdmit(projectPath, alias = null)` synchronously checks and reserves admission.
It returns `null` when held, otherwise an idempotent `{ release() }` reservation.
`tryAdmitAll(projectPaths, alias = null)` reserves every normalized identity
synchronously or refuses the whole set when any key is held. Equivalent keys
are deduplicated and one idempotent release drains all admitted keys.
Admission ignores `null`, `undefined` and empty-string entries before deriving
keys. A list with no real project returns a no-op reservation. In particular,
a panel terminal with no `projectPath` reserves only its resolved cwd, without
inheriting the app's cwd or a remote `/` fallback. Real entries in a mixed list
still participate in atomic admission and hold draining.
Launchers keep that reservation across asynchronous preparation and spawn, and
release on success, refusal, rejection or throw. It is a spawn reservation, not
a lifetime lock for an already running session.

`hold(projectPath, alias = null)` synchronously refuses subsequent admissions for
that identity and returns `{ ready, release() }`. The future operation caller
must await `ready` before inspecting/stopping the admitted work, hold through the
whole operation, and release only after known non-submission or terminal /
noLateCommit evidence. The IPC reply timeout does not release the hold. A4c3
also reserves the separate archive workflow gate and awaits both readiness
promises before revalidation, stopping or fencing. Unknown outcomes remain
main-owned through navigation, disposal and worker replacement. `ready` drains every previously
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

After #1054, versioned trigger open/new and closed-session resume use the same
`open-terminal` admission for project membership and resolved spawn cwd. The
per-session `acquireOpen` lock precedes permit consumption and target validation;
the project reservation follows target resolution, immediately before its inner
`try`, and spans asynchronous spawn preparation through PTY registration. Its
inner `finally` releases admission before the outer `finally` releases the open
lock. A held project returns `ok:false` with `PROJECT_OPERATION_ERROR` as both
error and trigger reason. The renderer removes failed placeholders without
writing the working set, replies with a null generation, and the broker retires
the consumed permit. The action publishes `outcome: 'refused'`, preserving
`created:false`/`resumed:false`, and refunds a new-session rate reservation.
No session or name is saved. A later renderer interruption still follows the
broker's conservative uncertainty rules. Existing-session trigger reattachment
and legacy command/chain/key delivery start no process and bypass admission;
stop remains unimplemented. The trigger token bucket is a separate rate limit.

Refusals preserve each launch surface's existing result shape. No process is
stopped here. This lock is in-process and ephemeral; external CLIs, other app
instances, remote filesystem aliases and filesystem changes remain outside it.

Tests load the real module, schedule/background/remote services, or the actual
`open-terminal` IPC slice with a filename and real module-relative require.
`test/project-operation-gate.test.js` covers hold/drain/release and identity;
the launch suites exercise their public refusal and asynchronous boundaries.
