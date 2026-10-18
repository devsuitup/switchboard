# Phase 0 CLI capability evidence (#380)

This is an evidence-only harness. It never qualifies production capabilities,
changes Switchboard, or answers CLI dialogs. Explicit consolidation produces
the release ledger without launching a CLI or changing measured values.
The Phase 0 specification is issue #380 §9.0/§9.3, C1–C4 and the owner
amendments (comments 6238870479, 6238870864, 6238542195 and 6241823281);
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
capabilities, capabilityStatus, baselineHead and acceptedSpecBranch:null,
plus execution:{platform,label,backend}. Per-record baselineHead comes from
actual git rev-parse HEAD. harnessRevision hashes the current harness source.
Live runs refuse any dirty/unreadable checkout before running a CLI version
probe. Dry-run is exempt and never counts as live evidence.

capabilities[k] is true exactly when capabilityStatus[k] is PASS. Overall status
is FAIL if any key is FAIL, otherwise UNVERIFIED if any applicable key is not
PASS, otherwise PASS. Windows sandboxChildSendMessage is NOT_APPLICABLE/false.
Other measured PASS keys remain true when a different key fails. Existing
committed ledgers are never relabelled.

| Canary | Capability keys | Measured behavior |
| --- | --- | --- |
| C1 | singleTurnDelivery, literalTranscript, eligibleConfirmation | TAB-expanded pastes of 180, 5000, 32768, 49152 UTF-8 bytes, with quotes/non-ASCII/4-byte emoji/nonce; one complete envelope, exact body and later assistant reaction. The 256-byte boundary-whitespace probe and separate raw-TAB control are informational. isMeta, local-command caveats and tool results do not count as turns. |
| C2 | forkWorktree | Four origins (root/W1 × small/large), sentinel, rename, resume/fork/worktree. Check inherited rows before the own turn, new session/worktree and source-prefix preservation. Two additional --name forks, without/with --worktree, must have their requested agent-name and descriptor name while the origin name stays unchanged and unique among the two sessions alive in that case. |
| C3 | extraPermissionSettings | Explicit Read(settings) allow; overlapping Bash allow/deny plus inherited project/global allow; linked CLI denial, absent denied effect, disjoint allowed effect and remove-deny control. Sandbox repeats permissions and attempts authority writes. |
| C4 | independentSendMessage, sandboxChildSendMessage | Independent pair plus wrong-name control gate independentSendMessage on every execution. Linux repeats with private sandbox publication for sandboxChildSendMessage; Windows marks that key NOT_APPLICABLE. A rename after the child prompt is informational. |

C1 eligibleConfirmation requires a transcript assistant row AFTER the submitted
user row. This is stricter than the specification's descriptor/OSC confirmation;
the capability is not inferred from an idle signal alone. Evidence also records
the post-submit descriptor status/timestamp and bounded OSC metadata when observed,
separately from the assistant-row result. OSC payload text is never retained.
C1 delivery/confirmation do not require literal storage. A complete
`<pasted_content id="NNNN">` envelope with a matching closing ID is removed
before the byte-exact UTF-8 comparison; its separator newlines belong to the
envelope. IDs contain 1–64 letters, digits, underscores or hyphens. Only LF
may precede/follow the envelope. Leading LF is recorded as
escaped envelopePrefix (for example, `"\\n\\n"`); an absent envelope records
null. openingTagLineEnding records LF versus CRLF immediately after the opening
tag. Evidence records wrapperPresent, wrapperId, storedBodyBytes and
storedBodySha256. The body is never trimmed or normalized for literal equality.
transformations identifies exact TAB expansion width (`tab-to-4-spaces`, or
the corresponding width from 1–8), LF/CRLF conversion,
trailing whitespace removal/addition and truncation, including combinations.
An unmatched byte change is explicitly unclassified-byte-change. These are
storage findings and keep literal=false. literalAfterKnownTransformations is
true for an exact body or a difference fully explained by classified
transformations; it never changes the literalTranscript capability gate.
No transcript content is copied.
C1 follows comment 6238870479 section 1's refusal branch: the supported delivery
class excludes leading/trailing whitespace. Validation records rejection of the
256-byte probe; its deliberate diagnostic delivery cannot decide the capability
verdict. Its actual literal/confirmation observations remain visible, including
failures. The four supported sizes still gate every C1 key. boundaryChange
records an exact leading/trailing whitespace deletion as side, zero-based UTF-8
offset, removed hex and byte count. emoji records input/stored UTF-8 offsets,
the four-byte encoding and whether it survived. Neither field normalizes storage.
pasteCache holds only byte sizes and SHA-256 hashes (at most 128 regular,
non-linked files, each at most 65536 bytes). linkedPaste requires an actual
row pasteRef or an envelope ID matching a cache basename (ID or ID.txt), plus
byte equality with the payload; matching content alone is not linkage.
Unrecognized cache naming is not guessed. pasteRef is optional
bounded evidence, never a mandatory CLI schema or a gate: missing/unlinked cache
objects cannot veto an exact envelope. A placeholder, absent/malformed envelope
or changed body in the supported payload class records literalTranscript FAIL. Multiple turns or missing
confirmation fail their own measured keys. C1 measures its final transcript after bounded quiescence and graceful
exit, so an assistant row flushed only on exit remains eligible. Evidence keeps
transcriptConfirmedBytes, transcriptFinalBytes and finalRowTypes with offsets,
as well as shutdown timing, stability, gracefulExit and forcedKill observations.
An idle descriptor alone still cannot satisfy assistant confirmation.
C2 ready-time snapshots are timeline observations only. N8 inherited and
post-turn titles have their OWN titleOutcome (PASS/FAIL); N8 never gates
forkWorktree. The fake fork publishes only a snapshot until its first prompt.

### C4 native recipient and specification amendment (§5.5 / C4)

**CONFIRMED live, operator observation supplied in brief-380p0i:** on Linux
CLI 2.1.301, `/rename UI-…` also changed the native messaging name. The origin
contained both `custom-title` and `agent-name` rows with the UI title. The
child's `SendMessage {"to":"project-5f",…}` failed with `success:false` and
`No agent named 'project-5f' is reachable.` Its subsequent ListAgents showed
the origin under the UI title. The origin had no receipt. This is an explicit
failed send to a stale address, not evidence of an unsupported receipt schema.
These live facts were supplied by the operator; this change did not rerun the
real CLI or inspect private transcripts.

The specification needs an owner amendment: remove the §5.5 / C4 assumption
that the native messaging name differs from the UI title. A C4 PASS must
depend on the current recipient, linked native send and receipt, distinct
owned processes, wrong-address control and sandbox isolation; equality of
native name and title is permitted. acceptedSpecBranch remains null.

Immediately before constructing/submitting the child's prompt, after its
launch and any orchestrator rename, the harness rereads the origin transcript
and descriptor. The latest `agent-name` value takes precedence when present;
otherwise it uses the current owned descriptor's `name`. No generated UI title
is substituted for a missing native name. Evidence records displayTitle,
nativeRecipient, addressedRecipient, recipientSource, recipientObservedAt,
agentNameOffset and the measured nativeRecipientDiffersFromDisplayTitle.
nativeRenames separately records each `/rename` observation: native name
before/after, whether it changed, whether it equals the title, and row offset.
An observed equality or inequality is not itself a capability gate.

SendMessage recognizes the live `to` / `message` inputs and the older
`recipient` / `content` shape.
For every nonce-bearing SendMessage call, sendResults includes only linked
tool_result blocks, with tool-use ID, byte offset, success (boolean or null
when unrecognized), isError, UTF-8 byte count, full flattened-text SHA-256 and
an excerpt capped at 200 characters. Unrelated results are excluded. Explicit
unreachable-recipient failure is FAIL; other unrecognized send failures are
UNVERIFIED with their own reason. Successful sending with no
recognized receipt remains separately UNVERIFIED. Failure in the deliberate
wrong-address control is expected, but absence of any nonce in the origin
must still be measured. Raw transcripts are not copied into evidence.

The receipt shape supplied by the operator in brief-380p0j (Linux CLI
2.1.301) is a `user` row containing a `cross-session-message` element,
preceded by two `queue-operation` rows. After one optional leading LF (or CRLF),
the body's first line must equal the nonce exactly. Further report lines are
allowed; empty bodies, text before the nonce and longer first lines are rejected.
The optional prefix `Another Claude session sent a message:` is accepted.
`from-name` must equal the child's current native name. Evidence records
SHA-256 of the complete from address and its scheme, SHA-256 of a recognized
endpoint path, `from-name`, `from-mode`,
receipt byte offset, bodyLineCount (excluding a single framing newline on each
side), bodySha256 (the body after removing those framing newlines), and
queue row types/offsets after the saved boundary. Report text is never evidence.
When structured origin is present, its name and exact body must match the
element's unframed body byte-for-byte; mismatches reject the receipt. Evidence retains origin.kind, fromMode,
verifiedPeerPidMatchesChild and fromSha256, without the source address or body.
unexpectedNonceInOrigin excludes all recognized receipt rows and preceding
enqueue rows whose content exactly equals a recognized receipt's message.
Other nonce-bearing rows remain unexpected. Wrong-recipient and rename controls
exclude nothing and still require complete absence of the nonce.
The owned descriptor's messagingSocketPath identifies the endpoint: absolute
.sock paths use uds:, Windows `\\.\pipe\` paths use pipe: (npipe: is also
recognized in receipts). A recognized endpoint must match the child's exact descriptor endpoint.
Any URI scheme is accepted, including an opaque Windows inbox address, when
the user-row envelope, exact nonce and current child from-name match. Unknown
schemes and addresses are retained only as hashes. The harness neither connects to it nor reads a key file. Only scheme
and path hash survive in messagingEndpoints. Missing descriptor endpoints remain visible as null; an opaque receipt source
is identified by its hash and current child name. Windows behaviour remains unmeasured until the operator runs C4;
fake pipe results prove only the descriptor/receipt reader.
The earlier `teammate-message` recognizer had no supporting live observation
in these briefs and has been removed. Dry-run uses the same receipt reader.

C4 polls the linked send result and origin receipt as the child runs; it
does not wait for the child's final assistant reply or post-submit idle.
Receipt/send observation is bounded to 15 seconds (5 seconds in dry-run).
The wrong-address control requires the observed `success:false` result
with `No agent named '<address>' is reachable`, then watches the origin
for its nonce for up to 15 seconds after the result (150 ms in dry-run).
Its total send/control bound is 30 seconds. Partial reports survive these
timeouts. Both owned processes attempt graceful `/exit` before forced
handle cleanup, including when the child remains busy after SendMessage.

After a linked successful send, C4 waits up to 15 seconds for an idle receipt,
then submits one neutral inbox-reading turn if the owned orchestrator is idle,
even when there are zero rows after the saved boundary. It observes that turn
for up to 60 seconds. Dry-run uses 1 and 5 seconds respectively. Evidence keeps
rowsAtSuccess, rowsBeforeNeutralTurn, neutralTurnSent/At, idleFailure,
rowsAtEnd, receiptFound and finishedAt, alongside all receipt row types/offsets.
No recognized receipt still yields UNVERIFIED.

The supplied Windows bundled evidence `win-bundled-C4-2403aee8` currently
records success:true, neutralTurnSent:true after 15008 ms, and a user row at
328097 after boundary 327597, but nativeReceipt:false. Thus the recorded
neutral turn already fired; it did not establish a recognized receipt. This
differs from the brief's initial no-rows observation. The new zero-row/opaque
scheme fixture proves that path locally; it does not relabel the live result.

The sandbox keeps `--tmpfs /tmp` unchanged. No socket bind or relay is
added. After the send observation and before cleanup, socketDirectory
records whether `/tmp/cc-socks` is visible through the owned child's
`/proc/<writerHostPid>/root`, with observation time/source and any inspection
failure. Unknown visibility stays null. The sandbox report retains linked
send-result text metadata and any failure; a failed sandbox check records
`o1.status: STOP`. A visible directory alone does not prove reachability.
The positive dry-run socket is explicitly emulated; it does not prove a
cross-namespace route. sandbox-socket-unavailable emulates the hidden
directory and failed connection, retaining an O1 STOP without altering
the mount graph. Only an operator live run can establish that outcome.

The C4 fake now changes both descriptor name and agent-name on rename, uses
the current native address for reachability and returns success/failure JSON.
stale-recipient sends to the pre-rename name and receives the real failure
shape; send-failed tests a long failure excerpt. stale-descriptor-name tests
the agent-name fallback, descriptor-only-name tests descriptor-only discovery,
and rename-during-child-launch tests rereading immediately before the prompt.
These scenarios emulate the supplied observation; they do not qualify Linux
native messaging or Windows child environment inspection.

A missing native name, absent SendMessage prerequisite, unsupported receipt,
exit before confirmation, deadline, ABI failure or dialog is UNVERIFIED, with
waitingFor recorded when available. Receipt evidence preserves raw row TYPES
and byte OFFSETS, never unknown content. A SendMessage addressed to another name
is an instruction-following miss, recorded UNVERIFIED. A wrong-control leak or
broken permission property is FAIL. For C3, an absent denied side effect with an
unrecognized linked tool_result is UNVERIFIED, with its flattened text's
SHA-256 and an excerpt capped at 200 characters. This excerpt comes only from
the result of the harness-generated Bash command, never unrelated transcript
rows or arbitrary terminal output. A present denied side effect is FAIL even
if the tool reports a permission denial. An OS error such as
bash: Permission denied is not a CLI permission denial. Tool-result content
blocks and JSON-escaped Windows paths are decoded before comparison.
Each capability boolean follows its own capabilityStatus. C4's independent
pair plus wrong-recipient control can PASS while the sandbox pair fails.
sandboxChildSendMessage is evidence only under O1 and never gates children.
An absent/failing Windows independentSendMessage measurement keeps reporting
children unavailable everywhere under the owner's global rule.

C3 recognizes the CLI's `Permission to use Bash with command <cmd> has been
denied.` result only when `<cmd>` matches the exact harness denied command and
the result's tool_use_id links to that Bash call. That explicit result does
not require an is_error flag. Legacy generic CLI denial shapes require an
is_error result; OS errors and text naming another command do not qualify.

C3 evaluates its permission observations even when submit times out, exits or
opens a dialog. Each attempted case retains settings-read proof, linked denial
hash/excerpt, denied side-effect absence/presence, allowed side effect and
sandbox write observations. The checks carry PASS/FAIL/UNVERIFIED status;
unperformed steps remain UNVERIFIED. A timed-out turn keeps the overall canary
UNVERIFIED and its capability false, even when individual checks passed.
Each process retains lastDescriptor (status, statusUpdatedAt, waitingFor,
observation time). Every submission retains its requested wait budget, byte
boundary, observed bytes, row count and last 16 row types/offsets plus block
types/tool names, with no transcript bodies; OSC observations survive timeout.

Every C3 case requests a nonce-specific final assistant reply after its tools.
The plain and remove-deny prompts explicitly exclude the sandbox-only write
probe, explain that inherited allows are already installed, and distinguish
the control where both commands should run. Completion requires both that
final reply and a fresh owned post-submit idle descriptor. An idle descriptor
alone cannot qualify a stopped tool turn. Missing idle or final reply is kept
as evidence, never converted into a PASS because the files look correct.

## Dedicated OAuth authentication

The first line is trimmed; an empty file, additional lines, a relative path,
missing/non-regular file, or a canonical path inside the repository, evidence,
runtime root or prepared HOME is refused before a CLI starts. One final LF or
CRLF is allowed. The token is never added to the harness parent environment
or its general allowlist: clean-env.js and the allowlist run first, and the
value is added only to each CLI launch environment (including --version).
Git and mount probes receive the ordinary scrubbed environment.

For a sandboxed CLI, bwrap inherits this launch environment. The mount plan
has no --clearenv and never adds a token --setenv argument, file, bind or
shell export command. This uses bubblewrap's inherited environment behavior
([upstream environment options](https://github.com/containers/bubblewrap/blob/main/bwrap.xml)).
Only the key name CLAUDE_CODE_OAUTH_TOKEN may appear in environmentKeys.
Every harness file write and console output is checked for the token and its
JSON-escaped form before writing. A match aborts the write and the run; owned
children are cleaned up, subsequent writes are refused, and no new ledger
entry qualifies the aborted run. This guard covers harness output, not files
written independently by the external CLI.

## First live run: operator checklist

1. Review the local red/green report, then independently compare the final
   graph against issue #380 §5.10 and the production sandbox wrapper. Apply
   the N1 amendment and Q1–Q3 decisions above. No live run is authorized by
   the implementation report.
2. Use a clean reviewed checkout (commit outside this task). Supply the native
   CLI executable with an absolute --cli path, never a shell alias/.cmd shim.
   Record its version/hash and the actual git HEAD. Avoid live application
   rebuilds, dependency changes and any production HOME.
3. Prepare a disposable HOME manually, outside repository, evidence and
   every real-home identity's descendants. Never copy .credentials.json or an
   existing login into it: refresh-token rotation can log the owner out.
   The owner runs `claude setup-token` separately and stores its long-lived
   token as one line in a private file outside the repository, evidence dir,
   runtime root and prepared HOME. Pass its absolute path using the live-only
   `--oauth-token-file` option. Do not put the token value on a command line.
   The harness reads this dedicated token file; it never reads or copies login
   credentials and refuses a prepared .claude/.credentials.json when the option
   is present. It refuses the OS account
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
   project/.claude/worktrees/canary-W1-small,
   project/.claude/worktrees/canary-W1-large,
   project/.claude/worktrees/canary-named (each resolved under the runtime root).
   A fork launched from W1 still creates its worktree under the repository root.
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
   C4 runs the unsandboxed pair and wrong-recipient control on Windows, reading
   messagingSocketPath from owned descriptors. Actual child-env inspection on
   Windows remains UNVERIFIED; it is not an unsandboxed capability gate.
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

### Runs still required to close Phase 0

| Execution | Required new canaries | Notes |
| --- | --- | --- |
| windows-conpty-bundled | C1, C2, C3, C4 | C2 repeats for Q1 --name with/without --worktree. C3/C4 omit --sandbox. |
| windows-conpty-inbox | C1, C2, C3, C4 | No previous C2/C3/C4 record; repeat the full amended cases. Omit --sandbox. |
| linux-unix-pty | C1, C2, C4 | C2 repeats for Q1; C4 uses --sandbox, with independent and sandbox statuses recorded separately. The existing C3 PASS may be retained. |

These are 11 new measurements. Use a new output directory for each invocation;
retain all previous per-run directories. Q3 keeps reporting children unavailable
everywhere until independentSendMessage passes on all three executions. Linux
sandboxChildSendMessage may FAIL without blocking the gate (O1). A malformed
ledger, missing required execution or last FAIL/UNVERIFIED cannot be replaced by
an earlier PASS. Q2 is a production input-validation decision; this harness
continues to generate the CLI-proven double-slash POSIX Read rules.

After review/commit by the publication owner, operator commands are:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'C:/path/to/matching/electron.exe' scripts/canary-cli-capabilities.js --live --canary all --oauth-token-file C:/canary380-secrets/oauth-token.txt --home C:/canary380-bundled-home --runtime-root C:/canary380-bundled-runtime --cli C:/path/to/claude.exe --out docs/evidence/session-capabilities/windows-bundled-amended --platform-label windows-conpty-bundled
& 'C:/path/to/matching/electron.exe' scripts/canary-cli-capabilities.js --live --canary all --oauth-token-file C:/canary380-secrets/oauth-token.txt --home C:/canary380-inbox-home --runtime-root C:/canary380-inbox-runtime --cli C:/path/to/claude.exe --out docs/evidence/session-capabilities/windows-inbox-amended --platform-label windows-conpty-inbox
```

```sh
/path/to/node scripts/canary-cli-capabilities.js --live --canary C1 --oauth-token-file /private/canary380-secrets/oauth-token.txt --home /tmp/canary380-home-c1 --runtime-root /tmp/canary380-runtime-c1 --cli /absolute/native/claude --out docs/evidence/session-capabilities/linux-c1-amended --platform-label linux-unix-pty
/path/to/node scripts/canary-cli-capabilities.js --live --canary C2 --oauth-token-file /private/canary380-secrets/oauth-token.txt --home /tmp/canary380-home-c2 --runtime-root /tmp/canary380-runtime-c2 --cli /absolute/native/claude --out docs/evidence/session-capabilities/linux-c2-named --platform-label linux-unix-pty
/path/to/node scripts/canary-cli-capabilities.js --live --canary C4 --sandbox --oauth-token-file /private/canary380-secrets/oauth-token.txt --home /tmp/canary380-home-c4 --runtime-root /tmp/canary380-runtime-c4 --cli /absolute/native/claude --out docs/evidence/session-capabilities/linux-c4-amended --platform-label linux-unix-pty
```

Every invocation needs its own already prepared isolated HOME with empty
.claude/projects and exact fixture trust keys; never use a production HOME or
remove the old run's history to satisfy this check. The Linux sandbox fork
root/W1 observation in amendment §5.1 is separate from these §4.6 gate reruns;
this harness's C2 remains the unsandboxed worktree/name measurement.

### Consolidation and validation (no CLI execution)

After the live records are reviewed, include every historical and new run
directory explicitly (PowerShell example):

```powershell
$canaryNode = 'C:/Users/Jean-Baptiste/AppData/Local/Temp/node22/node_modules/node/bin/node.exe'
$canaryRunDirs = Get-ChildItem docs/evidence/session-capabilities -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'ledger.json') } | ForEach-Object { $_.FullName }
& $canaryNode scripts/canary-cli-capabilities.js --consolidate @canaryRunDirs --out resources/session-capabilities.json
& $canaryNode -e "console.log(require('./scripts/canary-cli-capabilities').readCapabilities('resources/session-capabilities.json'))"
```

The root baselineHead is the local origin/main revision at consolidation time;
refresh that ref before the publication step. Each run's baselineHead remains on
its records. Consolidation copies statuses and booleans verbatim, adds missing
record baselineHead and legacy capabilityStatus[k]=record.status, and only
renumbers sequence by measuredAt (ties by evidencePath). It never derives a
boolean. Malformed legacy status/boolean combinations are refused, not repaired.
Dry-run ledgers and evidence never qualify or enter the release ledger.

readCapabilities validates exact record/key shapes, triples, statuses/booleans,
UTC timestamps, SHA fields, evidence paths/hashes and non-dry-run evidence. It
selects the last record per canary/execution by sequence and applies FAIL before
UNVERIFIED before PASS across bundled, inbox and Linux, independently of the
running platform/backend/version. Missing executions are UNVERIFIED. The result
includes selectedSequences and ledgerSha256. The sandbox key uses Linux only and
is diagnostic; production child admission must use independentSendMessage.
This exported reader is exercised by this task's tests; production admission is
outside this evidence-harness task. The evidence commit, including the consolidated
ledger and all referenced files, must precede production implementation.

Use the preinstalled Node 22; do not install it if missing:

```powershell
$env:TMP = 'C:/Users/Jean-Baptiste/AppData/Local/Temp'
$env:TEMP = $env:TMP
$canaryNode = 'C:/Users/Jean-Baptiste/AppData/Local/Temp/node22/node_modules/node/bin/node.exe'
& $canaryNode --test-concurrency=1 --test-timeout=120000 test/canary-cli-capabilities.test.js
& $canaryNode node_modules/eslint/bin/eslint.js --no-ignore --config test/fixtures/session-capabilities/lint.config.cjs scripts/canary-cli-capabilities.js test/canary-cli-capabilities.test.js test/fixtures/session-capabilities/fake-cli.js test/fixtures/session-capabilities/isolated-account.js
& $canaryNode scripts/canary-cli-capabilities.js --dry-run --canary all --home C:/Temp/empty-prepared-home --runtime-root C:/Temp/canary-runtime --out .work-files/canary-dry-local --platform-label fixture-only
$env:ELECTRON_RUN_AS_NODE = '1'
& 'C:/path/to/matching/electron.exe' scripts/canary-cli-capabilities.js --canary all --oauth-token-file C:/canary380-secrets/oauth-token.txt --home C:/Temp/prepared-home --runtime-root C:/Temp/canary-runtime --cli C:/path/to/claude.exe --out docs/evidence/session-capabilities/windows-bundled --platform-label windows-conpty-bundled
```

Linux, with an already matching Node-native PTY:

```sh
/path/to/node scripts/canary-cli-capabilities.js --canary all --sandbox --oauth-token-file /private/canary380-secrets/oauth-token.txt --home /tmp/prepared-home --runtime-root /tmp/canary-runtime --cli /absolute/native/claude --out docs/evidence/session-capabilities/linux-private --platform-label linux-unix-pty
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

Default work budgets: C1=120000, C2=900000, C3=300000, C4=900000 ms.
Override independently using --c1-timeout-ms ... --c4-timeout-ms, each
100..3600000 ms. C2's 15 minutes cover the four legacy origins/forks and two named fork pairs. Dry-run
--timeout-ms (100..180000) overrides a selected fixture budget. Each readiness/
submit poll is at most 20 seconds, except C2 ordinary turns and each C3 permission
turn allow up to 90 seconds, always within the remaining canary budget. C2
retains the owned PID/start/session checks and post-submit idle timestamp; a
busy fork with copied history cannot confirm early. Named-fork origins wait for
the requested agent-name and matching owned idle descriptor after their rename.
The settled name and observation time are captured immediately before fork
launch. Uniqueness counts only the live origin/fork identities in that case.
C3's five minutes cover
the plain deny case, remove-deny control and sandbox case, with more margin
than the former three-minute cap and generic 20-second submit wait. A larger
budget alone cannot supply a missing final reply. Version
probes at most 2 seconds, git/bwrap/process-start helpers at most 4 seconds in live mode. Fake metadata/Git helpers use 10 seconds; consolidation also bounds its origin/main lookup to 10 seconds.
Cleanup adds at most 9 seconds per confirmed live handle: up to 5 seconds
waiting for 1 second without transcript growth, up to 2 seconds for graceful
exit, then up to 2 seconds for forced handle termination. Dry-run quiescence
uses a 10 ms quiet period within a 500 ms cap and the dry-run 10 ms poll interval
for cleanup, including graceful exit. C1 ≤6 handles, C2 ≤12, C3 ≤3,
C4 ≤8 (caps including cleanup: 174/1008/327/972 seconds with defaults).

C4 allows 90 seconds for each child's report turn, including ToolSearch and
the linked SendMessage result (dry-run: 10 seconds). A successful send starts a
separate 15-second idle inbox observation (dry-run: 1 second). If no strict
receipt appears and the owned orchestrator is idle, the harness submits one
neutral inbox-reading turn, with no nonce or claimed sender/endpoint, bounded
to 60 seconds (dry-run: 5 seconds). All waits share the canary's 15-minute cap.
Wrong-recipient/rename controls retain their absence window and never prompt
the origin to manufacture receipt evidence. Send success alone cannot qualify
messaging. Sender, endpoint, row type, body, recipient and boundary predicates
are unchanged. Unknown shapes remain UNVERIFIED. Reports retain the observation
stages, submission error, last 16 child row types/offsets and tool names, and all
origin row types/offsets after the original pre-send boundary, including timeout.

Liveness and termination use OWNED HANDLES even when pid is still zero.
Confirmed sessions and C4 children first wait for transcript quiescence, then receive `/exit`
and Enter through their owned input. If they do not exit within the bound,
child.kill() terminates the owned handle. Unconfirmed sessions are killed by
handle immediately. Image names and unrelated PIDs are never used.
SIGINT/SIGTERM interrupt bounded work and kill owned handles;
cleanup and ledger write finish before exit, and every handle must be exited
before process.exit. Forced host termination cannot run JavaScript cleanup.

The fake runner gives Git fixture preparation a separate 60-second bound, recorded
as fixturePreparation (budgetMs/elapsedMs), before starting the requested canary
work budget. This avoids charging cold Git setup to short negative-control turns.
The test bootstrap can inject a bounded preparation delay and the fake CLI can
delay SendMessage to prove these boundaries. Positive C3/C1 configuration cases
use adequate explicit budgets; the blocked-CLI negative control keeps 2 seconds.
The test parent awaits subprocesses asynchronously and bounds each invocation
to 110 seconds. Run the test file once per verification, without overlapping
runners. Invoke the file directly on Node 22, without --test, so
--test-timeout=120000 applies to each test rather than the entire file's worker.
Tests remain serial; --test-concurrency=1 is retained even though Node ignores
that switch without --test. A test exceeding two minutes is a defect;
retain its timeout evidence and investigate before starting another run.
None of these emulator
allowances changes the live limits, receipt predicates or capability decisions.

Dry-run transcript discovery remembers only the path for each session, and
rediscovers it if it disappears; every observation still reads and parses the
current file. Dry-run descriptor discovery tries the owned PID filename first,
then falls back to the other candidates. Every candidate retains the same
pre-spawn hash, session ID, creation-time and process-identity checks. Live
discovery and timing are unchanged. This avoids repeatedly scanning historical
sessions while a bounded C4 observation budget is running.
Before spawning a fake CLI, descriptor snapshots read the same bounded files
and compute the same hashes in asynchronous batches of eight. This keeps the
event loop available and avoids repeated serial metadata reads. The fake CLI
indexes descriptor locations by session ID, so SendMessage reads the addressed
peer's current descriptor instead of parsing every historical peer. Its session
ID and current native-name reachability checks remain the same. Dry-run Git
initialization uses a minimal template with an explicit main-branch HEAD;
the repository and commits remain real. This works with Git 2.24 and avoids
copying unused hook templates and spawning a separate symbolic-ref command.
Live preparation keeps its existing command sequence.

The parent-env and wrong-control-hidden-leak regressions retain their disposable
HOME and evidence directories, printed in the test diagnostics. They seed 256
stale descriptors and inject a bounded 12 ms read cost for those stale files in
the test bootstrap. This reproduces polling starvation without changing CLI
receipts or classification. The all-canary continuation regression also retains
its evidence and requires completion within 30 seconds, below the unchanged
110-second subprocess guard.

Dry-run uses pipes; the separate fake-PTY tests exercise a delayed pid and
stale-descriptor rejection through the same launch/stop state machine. Windows
fake descriptors carry a per-launch identity token instead of a kernel FILETIME;
real PTY identity, permissions, native messaging, mounts and onboarding remain
unmeasured. The C1 fixture emits the real paste envelope and expands raw TABs;
exit-flush-assistant persists its assistant row only on `/exit`.
The fixture's C1 envelope begins with two LFs and repeats its hexadecimal ID
in the closing tag. Its unreferenced cache names contain 16 hexadecimal
characters. The payload builder expands TABs before padding to exact target
sizes, so the large cached bodies have 5000/32768/49152 bytes. The separate
raw-TAB control records the CLI's expansion without changing the capability
verdict. Quotes, LF and non-ASCII remain byte-exact in this fake scenario.
Fixture mutations cover corrupt/multiple/missing paste storage,
meta rows, title/source activity, broken forks, permission/OS denials, report
and receipt absence, wrong addresses/control leaks, shared publication,
parent env, exits, hangs and dialogs. Read the tests for exact switch names.
C3 emits the real command-bearing denial and `(Bash completed with no output)`
for the allowed command, inside a turn whose user prompt uses the paste
envelope. tool-stop stops after that result with a busy descriptor;
tool-stop-idle and tool-stop-waiting expose the same missing final reply with
idle/waiting descriptors. missing-allowed-tool stops after the denial.
denial-no-error-flag and wrong-command-denial exercise result recognition.
unlinked-denial changes the result's tool_use_id; premature-final ends the
turn before the allowed tool. Both remain UNVERIFIED. tool-stop-side-effect
records a FAIL for the forbidden file while the incomplete turn remains
UNVERIFIED. The remove-deny control's success receipt is not denial evidence.
These are emulator regressions, not new live CLI evidence. The existing
windows-bundled-c3-1ed941e evidence is preserved unchanged for comparison.

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
