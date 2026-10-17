# Phase 0 CLI capability evidence (#380)

This is an evidence-only harness. It never qualifies production capabilities,
publishes runtime resources, changes Switchboard, or answers CLI dialogs.
The Phase 0 specification is issue #380 §9.0/§9.3, C1–C4 and the owner
amendments. The review-fix environment could not retrieve the issue comments;
independent comparison with §5.10 remains a first-live-run prerequisite.

## Artifacts and ledger

- scripts/canary-cli-capabilities.js: standalone harness using clean-env.js read-only.
- test/fixtures/session-capabilities/fake-cli.js: emulated interactive CLI.
- test/fixtures/session-capabilities/isolated-account.js: test-only account and
  ancestor-instruction boundary; never loaded by an operator's harness command.
- test/canary-cli-capabilities.test.js: the only test file to execute.
- test/fixtures/session-capabilities/lint.config.cjs: isolated harness lint rules.
- .work-files/380p0c/ and .work-files/380p0d-*.log: implementation logs and dry-run output.
- windows-bundled/: the operator's first live C1 result, retained unchanged.
- <out>/ledger.json or ledger.dry-run.json: schemaVersion 1, baselineHead,
  measurements with continuing sequence numbers. Existing compatible ledgers
  can be appended using another empty prepared home.
- <out>/0001-C1-<nonce>/evidence.json: hashes, identities, own nonces, row types,
  byte offsets, timestamps, environment KEY NAMES, and process/mount metadata.
  Fixture projects, generated settings, and private CLI config never live here.

Each record retains N1 fields: sequence, canary, status, measuredAt,
cli {version, build, sha256}, harnessRevision, evidencePath, evidenceSha256,
capabilities and acceptedSpecBranch:null. **N1 needs an owner amendment** for
one additional field, execution:{platform,label,backend}; no separate platform,
platformLabel or ptyBackend record keys are added. baselineHead comes from
actual git rev-parse HEAD. harnessRevision hashes the current harness source.
Live runs refuse any dirty/unreadable checkout before running a CLI version
probe. Dry-run is exempt and never counts as live evidence.

| Canary | Capability keys | Measured behavior |
| --- | --- | --- |
| C1 | singleTurnDelivery, literalTranscript, eligibleConfirmation | Four separate bracketed pastes: 180, 5000, 32768, 49152 UTF-8 bytes, LF/TAB/quotes/non-ASCII/nonce; one actual user turn and a later assistant reaction. isMeta, local-command caveats and tool results do not count as turns. Literal storage and optional pasteRef linkage are separate observations. |
| C2 | forkWorktree | Four origins (root/W1 × small/large), sentinel, CLI rename, then resume/fork/worktree. Check final inherited rows BEFORE the own turn, new session/worktree and source-prefix preservation; natural source appends are allowed and before/after hashes retained. |
| C3 | extraPermissionSettings | Explicit Read(settings) allow; overlapping Bash allow/deny plus inherited project/global allow; linked CLI denial, absent denied effect, disjoint allowed effect and remove-deny control. Sandbox repeats permissions and attempts authority writes. |
| C4 | independentSendMessage, sandboxChildSendMessage | Two owned processes, native names, exact SendMessage call and recognized origin receipt. Wrong-name control must contain an observed wrong-name SendMessage and NO origin row with its nonce after the saved byte boundary. Repeat with private sandbox publication. |

C1 eligibleConfirmation requires a transcript assistant row AFTER the submitted
user row. This is stricter than the specification's descriptor/OSC confirmation;
the capability is not inferred from an idle signal alone. Evidence also records
the post-submit descriptor status/timestamp and bounded OSC metadata when observed,
separately from the assistant-row result. OSC payload text is never retained.
C1 delivery/confirmation do not require literal storage. A complete
`<pasted_content id="NNNN">` envelope with a matching closing ID is removed
before the byte-exact UTF-8 comparison; its separator newlines belong to the
envelope. Evidence records wrapperPresent, wrapperId, storedBodyBytes and
storedBodySha256. The body is never trimmed or normalized for literal equality.
transformations identifies TAB-to-spaces (1–8 spaces), LF/CRLF conversion,
trailing whitespace removal/addition and truncation, including combinations.
An unmatched byte change is explicitly unclassified-byte-change. These are
storage findings and keep literal=false. No transcript content is copied.
pasteCache holds only byte sizes and SHA-256 hashes (at most 128 regular,
non-linked files, each at most 65536 bytes). linkedPaste requires an actual
row pasteRef or an envelope ID matching a cache basename (ID or ID.txt), plus
byte equality with the payload; matching content alone is not linkage.
Unrecognized cache naming is not guessed. pasteRef is optional
bounded evidence, never a mandatory CLI schema. A confirmed placeholder-storage
branch is UNVERIFIED pending its owner amendment; a missing reference object,
corrupted literal, multiple turns or missing confirmation fails its measured
check. C1 measures its final transcript after bounded quiescence and graceful
exit, so an assistant row flushed only on exit remains eligible. Evidence keeps
transcriptConfirmedBytes, transcriptFinalBytes and finalRowTypes with offsets,
as well as shutdown timing, stability, gracefulExit and forcedKill observations.
An idle descriptor alone still cannot satisfy assistant confirmation.
C2 ready-time snapshots are timeline observations only. N8 inherited and
post-turn titles have their OWN titleOutcome (PASS/FAIL); N8 never gates
forkWorktree. The fake fork publishes only a snapshot until its first prompt.

A missing native name, absent SendMessage prerequisite, unsupported receipt,
exit before confirmation, deadline, ABI failure or dialog is UNVERIFIED, with
waitingFor recorded when available. Receipt evidence preserves raw row TYPES
and byte OFFSETS, never unknown content. A SendMessage addressed to another name
is an instruction-following miss, recorded UNVERIFIED. A wrong-control leak or
broken permission property is FAIL. For C3, an absent denied side effect with an
unrecognized linked is_error result is UNVERIFIED, with its flattened text's
SHA-256 and an excerpt capped at 200 characters. This excerpt comes only from
the result of the harness-generated Bash command, never unrelated transcript
rows or arbitrary terminal output. A present denied side effect is FAIL even
if the tool reports a permission denial. An OS error such as
bash: Permission denied is not a CLI permission denial. Tool-result content
blocks and JSON-escaped Windows paths are decoded before comparison.
Every capability boolean is false unless its full canary status is PASS.

## First live run: operator checklist

1. Review the local red/green report, then independently compare the final
   graph against issue #380 §5.10 and the production sandbox wrapper. Resolve
   the execution field's N1 amendment and N8/storage-only branches with the
   owner. No live run is authorized by this report.
2. Use a clean reviewed checkout (commit outside this task). Supply the native
   CLI executable with an absolute --cli path, never a shell alias/.cmd shim.
   Record its version/hash and the actual git HEAD. Avoid live application
   rebuilds, dependency changes and any production HOME.
3. Prepare a disposable login HOME manually, outside repository, evidence and
   every real-home identity's descendants.
   The harness never reads or copies credentials. It refuses the OS account
   home and HOME/USERPROFILE/HOMEDRIVE+HOMEPATH identities, including short-name,
   junction, case and trailing-slash aliases. Its .claude must be a real
   directory and .claude/projects MUST be empty. C3 also needs no existing
   .claude/settings.json. Never pass your actual home to a refusal test.
4. Supply an explicit fixed --runtime-root for every live run; there is NO live
   default. It must be outside repository, evidence, prepared HOME and every
   real-home identity's descendants. The prepared HOME and fixture project are
   checked too, using canonical and device/inode identities through ancestors,
   including junction/short-name/case/trailing-slash aliases. All three locations
   refuse ancestors containing CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md,
   .claude/settings.json or .claude/settings.local.json. In particular, the usual
   Windows %TEMP% under the real user profile is NOT a valid live runtime root.
   Keep that root empty between runs; an exclusive .lock rejects competing
   runs. Do not remove a stale lock without checking its previous processes.
   The fixed fixture is <runtime-root>/project; W1 is <runtime-root>/W1.
5. In the PREPARED home's .claude.json finish onboarding and explicitly set
   projects[ABSOLUTE_FORWARD_SLASH_FIXTURE_PATH].hasTrustDialogAccepted=true.
   For example, runtime C:/Temp/canary-runtime requires the exact key
   projects["C:/Temp/canary-runtime/project"].hasTrustDialogAccepted=true.
   C2 also needs exact keys for C:/Temp/canary-runtime/W1 and these fork paths:
   project/.claude/worktrees/canary-root-small,
   project/.claude/worktrees/canary-root-large,
   W1/.claude/worktrees/canary-W1-small,
   W1/.claude/worktrees/canary-W1-large (each resolved under the runtime root).
   Ancestor trust is NOT assumed: the harness checks each exact launch path;
   verify the installed CLI uses these exact keys/paths during preparation.
   A trust/onboarding dialog remains UNVERIFIED; it is never auto-accepted.
6. Choose a matching PTY ABI. Either ELECTRON_RUN_AS_NODE=1 with this checkout's
   matching Electron executable, or plain Node with an ALREADY AVAILABLE
   node-ABI node-pty (useful on a VPS). No Electron window is opened. An ABI
   mismatch is UNVERIFIED with instructions; NEVER rebuild shared node_modules.
7. Windows: run bundled and inbox ConPTY separately with
   --platform-label windows-conpty-bundled / windows-conpty-inbox. Wait for
   node-pty's non-zero pid, then match session ID (if requested), spawn-time
   freshness and actual process creation time. Windows creation time is
   (Get-Process -Id PID).StartTime.ToFileTimeUtc(), as an exact decimal string.
   C4 live Windows remains UNVERIFIED; actual child-env inspection on Windows
   is also UNVERIFIED, never inferred from the parent's launch env.
8. Linux: check bwrap --version, namespace/AppArmor access and exact mount
   preflight. Use --sandbox --platform-label linux-unix-pty. Inspect actual
   /proc/OWNED_CHILD_PID/environ key names and namespace/procStart mapping.
   Do not weaken system policy to get a PASS. The shared-session ALIAS threat
   remains explicitly UNVERIFIED: publication-path probes cannot prove it.
9. Review evidence, waitingFor, all process cleaned flags and checks. Delete
   the prepared HOME only after every owned process has exited. Apply the
   owner's conservative AND across required platforms; emulator results do
   not grant capabilities. C3/C4 unavailable proof keeps qualification closed.

The fixed project/private directories and generation publication directories
live only under the exclusive runtime root. They are removed after owned
handles exit; evidence retains identities/hashes and measured metadata only.
The prepared HOME is never auto-deleted. Failed cleanup retains runtime state.

## Commands (operator only for live examples)

Use the preinstalled Node 22; do not install it if missing:

```powershell
$env:TMP = 'C:/Users/Jean-Baptiste/AppData/Local/Temp'
$env:TEMP = $env:TMP
$canaryNode = 'C:/Users/Jean-Baptiste/AppData/Local/Temp/node22/node_modules/node/bin/node.exe'
& $canaryNode --test --test-concurrency=1 test/canary-cli-capabilities.test.js
& $canaryNode node_modules/eslint/bin/eslint.js --no-ignore --config test/fixtures/session-capabilities/lint.config.cjs scripts/canary-cli-capabilities.js test/canary-cli-capabilities.test.js test/fixtures/session-capabilities/fake-cli.js test/fixtures/session-capabilities/lint.config.cjs
& $canaryNode scripts/canary-cli-capabilities.js --dry-run --canary all --home C:/Temp/empty-prepared-home --runtime-root C:/Temp/canary-runtime --out .work-files/canary-dry-local --platform-label fixture-only
$env:ELECTRON_RUN_AS_NODE = '1'
& 'C:/path/to/matching/electron.exe' scripts/canary-cli-capabilities.js --canary all --home C:/Temp/prepared-login-home --runtime-root C:/Temp/canary-runtime --cli C:/path/to/claude.exe --out docs/evidence/session-capabilities/windows-bundled --platform-label windows-conpty-bundled
```

Linux, with an already matching Node-native PTY:

```sh
/path/to/node scripts/canary-cli-capabilities.js --canary all --sandbox --home /tmp/prepared-login-home --runtime-root /tmp/canary-runtime --cli /absolute/native/claude --out docs/evidence/session-capabilities/linux-private --platform-label linux-unix-pty
```

## Sandbox and bounds

The graph retains unshare-all/share-net/die-with-parent, private /tmp and /proc,
read-only system paths, writable fixture project and protected project .claude
and git authority, home .claude tmpfs with individual state mounts, private
shell-snapshots/session-env/backups/state, a read-only project index with only
the current transcript folder writable, and per-generation sessions publication.
ONLY the launch settings file is ro-bound at
/run/switchboard/launch-settings.json; private/ is not bound into the sandbox.
/run/switchboard is created with --perms 0555. Both mount-probe namespaces
assert that this parent, the host trigger path and the host private path are
unwritable, while the ordinary project and own publication remain writable.
The sandbox's ~/.claude.json is a PRIVATE COPY of the PREPARED home's config
(or {} only when absent), so onboarding/trust survives without exposing the
source. The config hash is recorded; its contents are never evidence.

The child env retains scrubbed system/locale/terminal paths plus Windows
CLAUDE_CODE_GIT_BASH_PATH, APPDATA, LOCALAPPDATA, ProgramFiles and USERNAME.
HOME/USERPROFILE/XDG/data/triggers point to prepared private locations.
DISABLE_AUTOUPDATER=1; parent messaging/socket/SSE/session markers are removed.

Default work budgets: C1=120000, C2=900000, C3=180000, C4=180000 ms.
Override independently using --c1-timeout-ms ... --c4-timeout-ms, each
100..3600000 ms. C2's 15 minutes cover four origins and four forks. Dry-run
--timeout-ms (100..180000) overrides a selected fixture budget. Each readiness/
submit poll is at most 20 seconds within its remaining canary budget; version
probes at most 2 seconds, git/bwrap/process-start helpers at most 4 seconds.
Cleanup adds at most 9 seconds per confirmed live handle: up to 5 seconds
waiting for 1 second without transcript growth, up to 2 seconds for graceful
exit, then up to 2 seconds for forced handle termination. Dry-run quiescence
uses a 50 ms quiet period within a 500 ms cap. C1 ≤4 handles, C2 ≤8, C3 ≤3,
C4 ≤6 (caps including cleanup: 156/972/207/234 seconds with defaults).

Liveness and termination use OWNED HANDLES even when pid is still zero.
Confirmed sessions first wait for transcript quiescence, then receive `/exit`
and Enter through their owned input. If they do not exit within the bound,
child.kill() terminates the owned handle. Unconfirmed sessions are killed by
handle immediately. Image names and unrelated PIDs are never used.
SIGINT/SIGTERM interrupt bounded work and kill owned handles;
cleanup and ledger write finish before exit, and every handle must be exited
before process.exit. Forced host termination cannot run JavaScript cleanup.

Dry-run uses pipes; the separate fake-PTY tests exercise a delayed pid and
stale-descriptor rejection through the same launch/stop state machine. Windows
fake descriptors carry a per-launch identity token instead of a kernel FILETIME;
real PTY identity, permissions, native messaging, mounts and onboarding remain
unmeasured. The C1 fixture emits the real paste envelope; tab-to-spaces alters
its body, and exit-flush-assistant persists its assistant row only on `/exit`.
Fixture mutations cover corrupt/multiple/missing paste storage,
meta rows, title/source activity, broken forks, permission/OS denials, report
and receipt absence, wrong addresses/control leaks, shared publication,
parent env, exits, hangs and dialogs. Read the tests for exact switch names.

Exit 0: all selected measurements PASS; 1: FAIL or UNVERIFIED; 2: refused or
invalid setup; 130: interrupted after evidence/cleanup. qualifiesProduction
always stays false until a separate reviewed qualification process.

The restricted Windows test environment denied git worktree pointer-file creation
under Temp. Dry-run therefore emulates worktree membership in an explicit
fixture manifest and uses runtime/worktrees/<name> directories. The initial
fixture repository is real; linked worktrees and their inventory are not. Live
C2 continues to use actual git worktree commands and CLI worktree locations.
The test bootstrap supplies a disposable os.userInfo identity and suppresses
instruction-file discovery above the disposable test root, so tests neither
depend on nor inspect host-profile instructions. HOME/USERPROFILE are disposable
and HOMEDRIVE/HOMEPATH are cleared for subprocess tests. Real filesystem identity,
short paths and junctions are exercised within that boundary. Operator runs do
not load this bootstrap: all OS/environment home sources and ancestor guards
remain active, and inaccessible canonical locations are refused.
