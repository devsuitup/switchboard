# 0003 — Deliver triggers under one tab lock and a per-write ownership check

**Status**: Proposed (2026-10-13). Maintainer review precedes implementation.

## Context

This record addresses issue #592, following the narrow #579 fix in PR #594.
Source references were verified at HEAD `713cbda317840ac37ecd10ac5a3bfc9e623558e9`
on `wt/592`. Sections under Decision are requirements for later implementation,
not claims that these requirements already hold.

### How delivery works today

1. The watcher accepts directory `rename` events and scans existing files through
   the same dispatcher (`trigger-watcher.js:1949`, `trigger-watcher.js:1967`,
   `trigger-watcher.js:1996`, `trigger-watcher.js:2016`). After parsing a nonempty
   `sessionId`, processing takes an id queue before further validation
   (`trigger-watcher.js:1157`, `trigger-watcher.js:1165`). The queue waits for all
   currently queued ids that `resolveSessionId` resolves to the same id; it is
   still stored by requested id (`trigger-watcher.js:1925`).
2. Main supplies `sessionTransitions.currentSessionId`, cached CLI status and
   the on-demand live-descriptor reader (`main.js:3466`). The context resolves
   the requested id, looks up `activeSessions`, and creates a local handle that
   forwards writes to that entry's PTY (`trigger-context.js:10`,
   `trigger-context.js:38`, `trigger-context.js:42`). A live direct map key wins
   over historical re-key mappings; mappings to exited targets are dropped
   (`session-transitions.js:48`).
3. A local lookup miss checks the existing remote route, then uses a descriptor
   only to report an unattached background session. It does not find a local tab
   through descriptor ancestry (`trigger-watcher.js:1292`). `findLiveProcess`
   returns the first matching surviving descriptor, rather than an ambiguity
   verdict (`cli-session-state.js:634`, `cli-session-state.js:646`,
   `cli-session-state.js:655`).
4. A single command performs optional idle waiting, composer waiting, liveness
   and CLI readiness/dialog checks, and a deadline check before submission
   (`trigger-watcher.js:1370`, `trigger-watcher.js:1402`,
   `trigger-watcher.js:1422`, `trigger-watcher.js:1429`,
   `trigger-watcher.js:1465`, `trigger-watcher.js:1484`). A chain retains its
   requested id, obtains an entry per step, and performs corresponding checks
   before calling the same submission helper (`trigger-watcher.js:1586`,
   `trigger-watcher.js:1599`, `trigger-watcher.js:1623`,
   `trigger-watcher.js:1651`, `trigger-watcher.js:1660`,
   `trigger-watcher.js:1693`, `trigger-watcher.js:1722`).
5. Submission writes command text, waits between keystrokes, then writes Enter
   (`trigger-watcher.js:276`). For ordinary commands, verification can wait and
   send one recovery Enter after additional composer/dialog guards
   (`trigger-watcher.js:726`, `trigger-watcher.js:778`,
   `trigger-watcher.js:810`). Thus guarding only the first text write leaves two
   later write sites. `/compact` instead waits for compaction evidence before
   reaching recovery logic (`trigger-watcher.js:738`;
   `.ai/contexts/trigger-watcher.md:1473`). The id queue is released in `finally`
   (`trigger-watcher.js:1872`).

The #579 fix requires a continuation record from the source transcript, a target
file not already held by a live tab, and
`clearOwner(targetId, ptyPid, { closestWriter: true }) === 'mine'` before re-keying
(`session-transitions.js:445`, `session-transitions.js:460`,
`session-transitions.js:468`). Re-keying moves the same session object and records
the old-to-new mapping (`session-transitions.js:424`). `getDescriptorIdentity`
captures sorted `(sessionId, pid)` pairs for that transition cache; it is not a
process-generation or delivery proof (`cli-session-state.js:344`). Keep this
transition policy: trigger fallback must not manufacture a UI re-key.

### Gaps and limits measured from source

- **Unrekeyed target.** If B's live writer belongs to a tab still keyed A, the
  local trigger lookup for B cannot reach it; a non-background miss produces
  `session not found` (`trigger-context.js:42`, `trigger-watcher.js:1292`).
- **Different ids, one tab.** Existing re-key aliases that already resolve to
  one id are serialized. An unrekeyed descriptor id is outside that equivalence
  relation. Adding a fallback without changing the lock would allow A and B to
  take different queues for the same tab (`trigger-watcher.js:1927`). This race
  is an inference from the queue algorithm, not a reproduced live incident here.
- **Identity changes during waiting.** The single path retains its initial
  handle; the chain retains its per-step handle. Neither checks conversation
  ownership at the text, Enter or recovery-Enter write sites
  (`trigger-watcher.js:1317`, `trigger-watcher.js:1605`,
  `trigger-watcher.js:277`, `trigger-watcher.js:282`,
  `trigger-watcher.js:810`). Inference: a live PTY can accept `/compact` after
  its CLI has changed conversation during a wait. Liveness does not prevent it.

The existing closest-writer query searches descriptors naming the **requested**
id. No match returns `absent`; macOS returns `unsupported`; a nested descriptor
whose ancestry encounters another descriptor returns `other`
(`cli-session-state.js:718`, `cli-session-state.js:754`). Its `other` is not
necessarily proof that the tab's actual writer has moved away. A new delivery
classifier must inspect the closest writer of the **tab**, rather than reinterpret
every existing `clearOwner` result as a delivery refusal.

Windows ancestry uses an asynchronous process table with a 3 s cache, creation
times and `win32:anchor` FILETIME comparison (`cli-session-state.js:22`,
`cli-session-state.js:115`, `cli-session-state.js:152`,
`cli-session-state.js:208`). The closest-writer walk checks Linux process start
identity and Windows creation order, with uncertain ancestry returning `pending`
(`cli-session-state.js:737`). A table started before a descriptor's modification
cannot establish its negative verdict (`cli-session-state.js:727`). macOS is
explicitly unsupported by the closest-writer query (`cli-session-state.js:722`).
The project's Linux sandbox pid and macOS limitations are documented, rather
than measured again in this session (`docs/sandbox.md:412`,
`.ai/contexts/cli-session-state.md:415`, `.ai/contexts/cli-session-state.md:477`;
issue #592 supplied in the brief).

## Decision

### Delivery invariant and vocabulary

For **each trigger-originated PTY write**, the trigger must hold the exclusive
lock of its pinned tab, still address that tab's pinned live PTY generation,
and, for eligible local Claude tabs only, pass a fresh ownership decision
immediately before writing. Apply the binding/lock guard to
command text, its initial Enter and every recovery Enter, for both single
commands and every chain step. Never switch a running delivery to another tab.

- **Requested id R** is immutable and remains the id reported in results.
- **Tab T** is an opaque stable identity attached to the active session object,
  surviving a map re-key. It is not a conversation id, display row or pid.
- **PTY generation G** is the pinned `session.generation` together with its PTY
  object and available process-start identity. Main assigns the generation in
  `wireSessionPty` (`main.js:2353`); local spawn constructs a new session object
  then wires it (`main.js:2911`, `main.js:2929`, `main.js:2939`), and exit removes
  its keys (`main.js:2469`). A close-and-reopen creates a new T/G and a different
  lock, even if R or the numeric pid is reused. The old delivery must fail its
  per-write binding guard; it cannot rely on the new tab's lock. A map re-key of
  the same session preserves T/G (`session-transitions.js:424`).
- **Effective id E** is initially the normalized R, except for the conditional
  direct/historical-route initialization in open question 4. It subsequently changes
  only for this chain's authorized clear-family transition, described below.
- **Direct key** means the normalized requested live map key names T. A re-key
  mapping is a **historical alias**; a descriptor fallback is a **descriptor
  alias**. Both are alias keys, subject to the question-4 historical-route
  exception only if the maintainer selects option A. Direct-key precedence
  applies at initial lookup, not as permission to retarget a pinned delivery.
  No extra `realSessionId` agreement condition is needed: current re-keying sets
  it together with the new map key (`session-transitions.js:427`,
  `session-transitions.js:433`).
- **Id normalization** lowercases conversation ids without trimming or changing
  non-letter bytes. Preserve the original R verbatim for results. Direct-map
  keys, historical mappings, local FIFO keys, descriptor lookup and E/writer
  comparisons must all use this normalization; do not turn case-only matches
  into descriptor aliases. This aligns local map resolution with descriptor
  readers: today's map lookup is exact (`trigger-context.js:43`), while
  descriptor comparisons lowercase (`cli-session-state.js:614`,
  `cli-session-state.js:657`, `cli-session-state.js:720`). If normalization
  reveals more than one distinct live tab for a key, refuse as ambiguous; never
  pick the first. Preserve the existing remote lookup contract.

Protocol replies, user keyboard input and other non-trigger writes are outside
this invariant. Scope the guarded writer to the trigger pipeline, not the PTY's
global `write` method. **Ownership eligibility** is exactly
`!session.isPlainTerminal && session.host == null && !session.isAttach`.
These flags exist on local sessions (`main.js:2918`, `main.js:2919`,
`main.js:2927`); remote attachments set a host (`main.js:2550`). Plain terminals,
background attach tabs and remote attach tabs gain serialization and per-write
T/G/liveness checks only; do not run the ownership classifier for them, even
when a nested CLI descriptor names a different id. Preserve their existing
composer/readiness/result gates. Do not add descriptor fallback to these tabs.
Today's public contract includes plain terminals (`docs/automation.md:196`).
The POSIX/fish shims block `claude` with a hint and return 1
(`plain-terminal-shell.js:10`, `plain-terminal-shell.js:14`); no shim runs in
PowerShell/cmd (`.ai/contexts/plain-terminal.md:52`). The synthetic nested-CLI scenario remains
required, for a bypassed shim or an unshimmed shell. Unattached remote socket
delivery retains its
existing route and contract (`trigger-watcher.js:1294`,
`trigger-context.js:45`, `trigger-context.js:69`).

### Lookup fallback: one process, one tab

On a direct/historical local lookup miss, **try the existing remote route first**,
including its existing failure/ambiguity result; a remote snapshot terminates
lookup and must not fall through to a local candidate. This preserves current
precedence (`trigger-watcher.js:1294`, `trigger-watcher.js:1298`). Only if remote
lookup has no snapshot, read descriptors for normalized R, independently of UI
rows, and find a unique verified closest interactive writer whose ancestry
reaches a unique live ownership-eligible local Claude tab's PTY. Enumerate
candidates: do not use the first match from
`findLiveProcess` as uniqueness proof. A verified descriptor in a descendant
`claude -p` or `--bg` process below the tab's writer cannot alias that child
conversation to the parent tab. An explicit background attach under its own
direct key retains its existing route; an unattached background process is not
implicitly attached by fallback.

Require a one-to-one relation between verified writer process generations and
tab generations. Multiple eligible writers or tabs, incomplete ancestry or
missing start identity mean no proven alias. Different ids in one merged row,
shared cwd, `bridgeSessionId`, a continuation record alone, and a pid number alone
are not ownership evidence. Never type into a local candidate with an uncertain
alias. Use the tab-writer filtering in Ownership outcomes, including `kind`.

Fallback has the following stopping rules, **before** waiting for ownership:

1. A recognized unattached background job immediately returns
   `background session, not attached here`, with its job id; do not spend the
   delivery deadline trying to attach it. That result exists today
   (`trigger-watcher.js:1305`).
2. Skip descriptor fallback in identity domains that cannot compare process
   identities: current macOS (`cli-session-state.js:722`) and namespace-only
   sandbox descriptors without a host-comparable identity
   (`docs/sandbox.md:412`). Return `session not found` without
   an ownership wait; this is a lookup miss, not a pinned historical alias.
3. On a supported domain, wait only if a descriptor naming R or a previously
   read hint names a live process plausibly under an eligible local PTY, with
   verification temporarily unavailable (e.g. a cold table or torn read).
   "Plausibly under an eligible local PTY" means: the hinted PID is alive and,
   from whatever ancestry is readable, is not demonstrably outside every
   eligible local PTY's process tree. A cold table justifies waiting for at
   most one shared process-table refresh; then the fallback decides with what
   it has, and if no candidate is verified it returns the existing fast
   `session not found` error. A torn read is rechecked once within the same
   bound. A
   descriptor proven external, nested non-interactive, stale or multiply owned
   is not a candidate hint. If none remains, return `session not found` now,
   the existing miss result (`trigger-watcher.js:1312`). A hint may consume only
   the remaining delivery budget; loss/disproof of the hint ends lookup now.
4. Once a unique T is pinned, do not retarget it. A historical alias already
   identifies T, so its `unknown` follows the alias ownership table rather than
   the descriptor-miss fast-failure rule (subject to question 4).

Descriptor aliases are temporary lookup hints. A torn descriptor read may
preserve a hint for bounded rechecking, but cannot authorize a write. Drop
descriptor hints on a proven
writer change, tab exit, generation invalidation or a new direct-key target.
Historical mappings remain lookup routes, not reusable per-write permissions;
question 4 decides their initial E and admission policy.

### One lock per tab

Keep the per-requested-id FIFO **mandatory** for normalized same-id ordering,
then acquire exactly one tab mutex, keyed by T. Resolve before joining that
mutex, freeze E at initial pinning under the selected question-4 policy, and
validate T, G and ownership again after acquisition. A fallback found
late must join the same mutex before any readiness/composer wait or write. If
the candidate changes while queued, refuse and release; do not migrate to another
mutex while holding the first. This avoids a second lock ordering or silent
redirection. Different tabs remain independent.

Hold the tab lock through the complete command or chain, all verification waits,
and result production. Release on every exit. A chain's re-key, own clear, or a
second trigger naming a new descriptor id must not create another lock. Only the
per-id FIFO is entered before the delivery budget; proposed tab-lock acquisition,
fallback resolution and ownership waits consume that command/chain budget. Each
step remains capped by the remaining global budget. This is deliberately
asymmetric: a same-id trigger can wait outside `timeout_ms` in that FIFO, while
a distinct descriptor alias for the same T waits inside the budget for the tab
mutex and may expire. Historical ids that already resolve to the same key still
join the existing FIFO equivalence group (`trigger-watcher.js:1927`); normalize
that relation too. Do not add an independent
re-key timeout or restart a budget after ownership changes. See open question 3.

### Ownership outcomes

For ownership-eligible tabs, classify a fresh observation of T's **closest valid
interactive writer** relative to E. Historical alias admission/initial E is
conditional on question 4; the table is unconditional for descriptor aliases
and applies to historical aliases after their option-specific admission:

| Outcome | Meaning | Direct key action | Alias key action |
|---|---|---|---|
| `mine` | One verified closest writer for T/G names E. | Deliver once the existing composer/readiness/deadline gates allow. | Deliver under the same gates and T's lock. |
| `other` (definite) | T's verified closest writer names a different id. For an alias candidate, complete identity-checked evidence of an exclusively foreign process tree also rules out that candidate. A foreign descriptor alone does not prove `other` for a direct key. | Refuse immediately; write no further bytes. | Refuse immediately and drop the alias. |
| `unknown` | No decidable writer: absent/torn descriptor, cold/failed/obsolete table, unsupported identity domain, inaccessible namespace, ambiguous candidates or unreadable ancestry. | Deliver under the existing gates; do not wait for or require proven ownership. | Before text, wait/recheck only as allowed by Lookup fallback, then deliver on `mine`, refuse on `other`, or expire unwritten. At initial/recovery Enter, stop immediately without another write or refresh wait. Authorized reset is excepted; option-A historical routes use the direct action. |

A descriptor alias that has not yet identified a tab waits only when the Lookup
fallback stopping rules permit it, for lookup evidence, not
under a guessed tab lock. Once T is pinned, ownership waiting holds T's lock.
The table describes the ownership gate; it does not bypass composer, dialog,
readiness, liveness or deadline checks. In particular, direct `unknown` must keep
cold Windows, namespace-isolated Linux and macOS direct delivery usable.

Normalize `pending`, `absent`, `unsupported` and exceptions to `unknown` when
they represent missing evidence. Do **not** normalize existing closest-writer
`other` blindly: a nested child being rejected or a reused-pid descriptor being
discarded is not proof of a different conversation on T. Determine the tab's
writer after filtering. A descriptor for E elsewhere does not overrule a verified
matching writer of T, nor turn missing information about T into a definite refusal.

Discard descriptors with a demonstrated process-start mismatch before selecting
writers, on Windows as well as Linux. Unreadable/uncomparable identity remains
uncertain; never accept it as `mine` or use it as definite contrary evidence.
Require descriptor `kind === "interactive"` (the current parser exposes `kind`,
`cli-session-state.js:316`; descriptor examples use `interactive`,
`.ai/contexts/cli-session-state.md:44`). **UNVERIFIED:** what `kind` a nested
`claude -p` writes is not established; `.ai/contexts/cli-session-state.md:441`
lists only `bg` and `interactive`. The implementation must not rely on the
`kind` filter until a canary test (spawn `claude -p` under a tab's PTY and read
its descriptor) or a live check records the value. If `-p` writes
`interactive`, the filter alone is insufficient and `mine`/`other` must also
require the writer to be T's closest interactive CLI by ancestry: the
descriptor's PID must be the shallowest interactive-descriptor process between
the PTY root and any other descriptor-bearing process below it; a deeper
interactive descriptor never overrides it, and two at equal depth yield
`unknown`. Non-interactive descriptors, including
headless/background writers with non-interactive `kind`, never establish `mine`
or definite `other` for T. Validate ancestor identity/creation order and select the closest verified interactive
writer by ancestry depth from the PTY, not by descriptor enumeration order. If
no interactive writer is readable, return `unknown`, including when only a
nested non-interactive CLI is readable and the tab's own descriptor is missing.
A torn ancestor descriptor or unresolved role also yields `unknown`, rather than
promoting a readable nested child. Discarding a demonstrated stale descriptor
must not block a separate valid writer. If two interactive candidates have no
unique closest ancestor, return `unknown` and never authorize an alias.

Immediately before every actual write, reread descriptors and redo this decision,
without a 3 s alias-verdict throttle. Bound and share asynchronous process-table
refreshes; do not synchronously spawn a probe at every keystroke. **Direct keys
never await a refresh** at admission, text, Enter or recovery Enter: start/share
one in the background, use currently usable evidence, and classify missing or
expired evidence as `unknown`. An alias may await a refresh only before command
text, inside the remaining budget, then reread and revalidate T/G. **Initial
Enter and recovery-Enter guards are synchronous for every key**: `unknown` on
an ordinary alias stops further writes without waiting or replaying text; an
authorized reset uses its explicit exception. Pre-text alias `unknown` may
wait/recheck while a permitted candidate remains. Do not extend the existing
text-to-Enter delay to await the process table: its current default is 50 ms
(`trigger-watcher.js:70`, `trigger-watcher.js:276`), whereas the Windows probe
can run to its 5 s timeout and caches for 3 s (`cli-session-state.js:20`,
`cli-session-state.js:22`, `cli-session-state.js:123`). A synchronous final guard
and the underlying write must have no intervening `await`. A previously sampled
`mine`, a descriptor revision, transcript mtime or status timestamp is not a reusable delivery permit.

This prevents **observable** cross-conversation writes. It cannot atomically bind
the external CLI's conversation to PTY bytes: Windows process snapshots can age
and the CLI can switch between the final observation and consumption. Direct
`unknown` deliberately retains that uncertainty. Do not claim an absolute
cross-process guarantee on platforms where ownership cannot be observed.

### The chain's own `/clear`, `/new` or `/reset`

A clear-family step is checked against the current E exactly like any other
step. Reuse `CLEAR_COMMANDS` (`session-transitions.js:39`) through a shared
recognizer, not a second list: membership of the exact case-sensitive first
whitespace-delimited token after trimming, including optional arguments. Current
transition detection uses that set on classified command text
(`session-transitions.js:398`, `session-transitions.js:401`). This is the proposed
trigger authorization grammar; actual CLI case sensitivity is unverified here.
Quoted prompt text and uppercase variants do not authorize reset. No exception
applies before its Enter is written. For tabs excluded from ownership checking,
the existing binding/readiness gates suffice, with no descriptor wait.

After this chain writes both that text and Enter under the guard, grant a
**chain-local reset authorization** for the same T/G. The following steps are
explicitly addressed to that tab's reset successor. They do not require a UI
re-key, a new transcript file, or continued ownership of pre-clear E. This is
the chain-local exception to the ownership-gated alias table (option-A
historical routes already use the direct policy): an admitted alias chain may
continue on `unknown` after its own reset, just as a direct chain may, on this
same live PTY. Other triggers receive no such authorization.

On reset Enter, remember the pre-reset E and any verified interactive writer
process generation. A later observation still naming pre-reset E is **neither
bound nor refused**: descriptor lag does not end reset mode or delay following
steps solely for identity. Bind the new E only on the first verified successor
id **different from pre-reset E**, from that same writer generation if one was
known. If none was known at Enter, first verified writer identity anchors reset
mode, still requiring a different id to bind E. Readable clear bookkeeping after
this Enter can corroborate the successor. A proven change from an anchored
writer process generation, conflicting transition evidence or
PTY change refuses. If no successor id is observable, retain tab-local reset
mode and normal readiness/verification fallback; never wait just for a re-key.
Once a successor is observed, bind E to it and reject later definite moves to
another conversation. Another guarded clear-family step can authorize the next
reset. A continuation unrequested by the chain never grants reset authorization.
Outside this chain-local reset mode, a binding admitted before an external
conversation change never follows that change, under either question-4 option.

Other conversation-switching commands, including `/resume X`, are **not** reset
authorizations. A chain `[/resume X, prompt]` keeps E at the pre-resume id and
refuses its next write when an eligible tab's writer is verified as X; direct
`unknown` retains its documented uncertainty. Current chains forward each
command without an ownership gate (`trigger-watcher.js:1599`,
`trigger-watcher.js:1722`), so this is an explicit contract change for later
implementation/docs. Extending authorization to resume is outside this ADR.

This authorizes following the tab through the chain's reset, not proof that a
particular observed id change was caused by that Enter. Where descriptors and
transcripts are unavailable, causal attribution is unverified. See question 1.

All composer and busy reads remain tied to T. Status/transcript reads use the
effective writer/identity rather than a re-resolution of R. After reset, discard
pre-reset status/turn/compaction cursors as evidence for the successor. Prefer
the observed successor's status and transcript; when none can be selected,
use the existing unavailable-descriptor fallback, not an invented idle or
confirmation. A dialog already observed remains a hold. Never confirm `/compact`
without its readable manual boundary evidence, even in reset mode. Once reset
completion is observed, suppress a recovery Enter for the completed clear step;
it must not enter the successor merely to reconfirm the previous command.
If ordinary submission verification cannot finish, the chain can still stop;
the requirement is absence of a mandatory **re-key** wait, not guaranteed success.

### Refusal and partial delivery

An expected ownership refusal is an ordinary result, never `internal: true`.
If no bytes reached the target, return `ok: false`, `submitted: "no"`,
`error: "not sent"` and an explanatory `reason`. After any bytes, do not return
`not sent`. Stop the chain and record which step's text/Enter reached the PTY;
use `step not confirmed` for an interrupted submission and `chain timeout` for
an exhausted later-step wait, with the reason naming ownership when applicable.
Preserve the earlier steps and their submission evidence.

Keep `written` meaning a fully written text-plus-Enter pair, rather than redefine
it to mean any byte. A text-only partial write needs an explicit partial-write
reason; `submitted: "no"` alone must not be read as safe to resend that text.
If text reached the PTY but its Enter is refused, that text may remain in the
new conversation's input box. The trigger performs **no cleanup**; report the
partial text and reason so the caller cannot assume resending is safe.
No retry, cleanup keystroke or recovery Enter is exempt from the guard. The
existing result contract distinguishes `not sent` from written-but-unconfirmed
delivery (`docs/automation.md:580`; `.ai/contexts/trigger-watcher.md:1548`,
`.ai/contexts/trigger-watcher.md:1570`).

## Test matrix for the implementation step

The 24 platform/key cells and nine scenario rows below are required synthetic
`node:test` cases, with both question-4 options exercised until one is selected,
not tests added or executed by this ADR. In every cell, assert the PTY byte log **and** result
classification, with ready/free/alive fixtures unless the row specifies a hold.
Run each write-time identity change at text, initial Enter, and ordinary-command
recovery Enter. `/compact` has no recovery Enter in the current helper
(`trigger-watcher.js:738`).

Fixture seams:

- **W:** `cliSessionState.init({ platform: 'win32', dir, isProcessAlive,
  readProcessTable, now })`; do not inject `readParentPid`, which would disable
  the Windows table (`cli-session-state.js:266`). Supply `(pid, ppid, created)`
  rows and `win32:anchor`/string `procStart` descriptors in a disposable directory.
  Defer/reject the table promise for cold/failed reads; advance `now` past its
  TTL, or change creation times, for stale/reused pids.
- **L:** inject `platform: 'linux'`, `readParentPid`, `readProcStart`,
  `isProcessAlive` and disposable descriptor files. Supply a parent walk to the
  fake PTY or another root. These are existing seams
  (`cli-session-state.js:266`, `test/cli-session-state.test.js:544`).
- **S:** L, but descriptor pids are namespace-local; host ancestry/start readers
  return null or a mismatching unrelated host identity. This produces `unknown`
  and must never manufacture a host-parent alias. Add a positive control using
  explicitly comparable host identities; namespace mapping itself is not proposed.
- **M:** `platform: 'darwin'`, `readProcessTable` with `lstart`-style creation times,
  and descriptors without a comparable Windows anchor. Expect `unknown` for
  actual ownership support. A separate classifier seam can inject `mine`/definite
  `other` to test policy independently of this unsupported identity source.
- **T:** exercise the real context/watcher over fake `activeSessions`, a logging
  PTY, injected `isPtyAlive` and status; use disposable JSONLs for source
  `continued-in`, clear bookkeeping and turn completion. Existing examples are
  `test/trigger-clear-chain.test.js:35`, `test/trigger-clear-chain.test.js:87`,
  `test/trigger-clear-chain.test.js:100`. A future tab-oriented ownership/status
  dependency is a proposed seam, not an API that exists today. For reset tests,
  deliberately leave the map keyed A and make re-key detection unavailable.

In continuation cells, a proven change A to B is external to the chain unless
an own reset was explicitly authorized. Test R=A (old target) and R=B (current
target), before and after the map re-key. Unchanged writer identity after a
metadata-only continuation record follows the ordinary policy, not that record.

Unless a cell explicitly names a historical route, the alias rows exercise
descriptor aliases. Historical routes must additionally exercise their
question-4 admission policy, including option-A direct-unknown availability.
Movement/refusal cells start after E has been pinned; option A must not silently
reinitialize E during a later wait. `unknown` waits in alias rows mean before
text only; an ordinary alias's Enter guard stops immediately on `unknown`.

| Platform / key | Plain step | Clear-family step and following step | Step after a continuation |
|---|---|---|---|
| Windows / direct | W+T: matching writer delivers; cold/failed table delivers on `unknown`; verified different tab writer refuses. | W+T: admit reset under the same policy; write successor step on the same T/G even with cold table and no re-key. Warm successor binds E; later definite unrelated move refuses. Parameterize all three commands. | W+T: A pinned E=A refuses if writer moves to B during delivery despite a stale direct key; a change predating admission uses question 4. R=B after re-key delivers. Cold ownership stays `unknown` and direct delivers, without claiming conversation proof. |
| Windows / alias | W+T: unique matching closest writer delivers; torn read or cold table waits, then delivers if proof arrives or expires with no write; definite other refuses. | W+T: `mine` admits reset; `unknown` before reset waits. After its own Enter, successor step proceeds on pinned T/G without re-key, including `unknown`; no permission transfers to a separately queued alias trigger. | W+T: R=B fallback delivers before re-key and uses T's lock. A new R=A historical trigger uses question 4; a pinned E=A delivery refuses on verified B, with unknown handled at the next write boundary. A later B to C move blocks the next write for R=B. |
| Linux / direct | L+T: matching writer delivers; null ancestry/start evidence delivers on `unknown`; verified different writer refuses. | L+T: reset admission uses ordinary policy; successor proceeds on pinned T/G without re-key, with all three command names. After known successor E, a definite later move refuses. | L+T: proven movement to B during delivery rejects pinned E=A; direct R=B after re-key delivers. Unreadable ancestry allows direct `unknown`; transcript-only A to B is insufficient contrary evidence. |
| Linux / alias | L+T: unique closest match delivers; missing/torn ancestry waits then expires or delivers on recovered proof; definite other refuses. | L+T: prove alias before reset; after guarded Enter, successor follows same writer/T/G even when descriptors become unreadable and map remains A. Before reset text, `unknown` still waits; initial reset Enter on `unknown` stops without granting reset authorization. | L+T: R=B reaches unrekeyed A only with writer proof. A new R=A re-key alias uses question 4; an already pinned E=A refuses once writer is B (pre-text unknown may wait). Proven later move B to C prevents Enter/recovery for B. |
| Linux sandbox / direct | S+T: namespace-only descriptor yields `unknown`, direct still delivers; unrelated host pid collision cannot cause refusal. Positive host-identity control can refuse a proven different writer. | S+T: `[/clear, reply]`, `[/new, reply]`, `[/reset, reply]` continue on the same T/G with no re-key and no host identity. Keep unknown confirmation explicit. | S+T: R=A cannot be refused on namespace uncertainty alone; R=B direct after an injected re-key delivers. Host-verifiable different writer control refuses R=A. |
| Linux sandbox / alias | S+T: namespace-only ownership cannot admit descriptor fallback; fail lookup immediately with no write. Historical aliases use question 4. Comparable-host control admits a unique `mine`, rejects definite other. | S+T: unknown alias cannot start reset. Admit with host-identity control, then remove visibility: following step continues under its own reset authorization without re-key. | S+T: R=B unrekeyed lookup fails immediately and stays unwritten with namespace-only data; host-comparable proof permits B. New historical R=A uses question 4; an already pinned E=A cannot follow proven B. |
| macOS / direct | M+T: missing comparable anchor remains `unknown`, direct delivers. Injected classifier `other` control refuses; do not infer it from `unsupported`. | M+T: all three reset chains reach the successor step on the same T/G without a re-key; unavailable identity does not create a re-key wait. Submission/readiness failures remain ordinary failures. | M+T: unrekeyed R=A remains direct `unknown` and may deliver; R=B direct after injected re-key delivers. A classifier-proven B refuses R=A. This is the documented observability limit. |
| macOS / alias | M+T: real-source descriptor fallback fails lookup immediately; a historical alias uses question 4. Injected `mine` control delivers; `other` control refuses. | M+T: unknown alias cannot admit reset. Injected `mine` admits it; return to unsupported identity after Enter and verify successor step continues without re-key under the chain-local exception. | M+T: R=B before re-key cannot obtain real-source descriptor proof; fail lookup immediately. A new historical R=A uses question 4. Injected B proof delivers R=B and blocks an already pinned E=A. |

Additional required scenario rows (apply W/L/S/M where meaningful):

| Scenario | Required byte/result assertions |
|---|---|
| Plain terminal P running Claude X | Bypass the POSIX shim in the fixture or use an unshimmed shell; X differs from P. Direct delivery preserves text+Enter and normal result gates, with no ownership call/probe/wait. T/G guards and tab mutex still apply. |
| Local Claude tab with missing own descriptor and nested non-interactive writer | A nested `kind != interactive` writer naming X never becomes T's writer: direct R=A is `unknown` and delivers; descriptor fallback for X fails lookup with no bytes. Repeat with torn ancestor data, and with a valid interactive ancestor as control. |
| User `/clear`, then a new trigger to the old id A | Establish writer C before trigger admission, first with map still A, then after historical re-key A→C. Option A binds initial E=C and delivers; a historical route with no evidence delivers as direct `unknown`. Option B keeps E=A and refuses on proven C; before re-key direct `unknown` delivers, after re-key historical `unknown` waits only before text then expires unwritten. A reopened live direct A wins under both. Assert R=A in results. |
| Cold table at admission, warm before text (writer already C, map still A, direct R=A) | Windows: first table read is cold, then warms before the text with C verified. Option A leaves E unbound at admission, binds E=C at the first decidable observation and delivers; if the table never warms before the text, it delivers as a direct key on `unknown`. Option B pins E=A, so the warmed definite `other` refuses with zero bytes. Assert both outcomes and R=A in results. |
| Descriptor lags this chain's guarded clear Enter | Keep descriptor naming pre-reset A across completion/status polls and the successor step. It neither binds E=A as successor nor causes refusal or a mandatory identity wait. First verified C different from A binds E=C; later proven D refuses. Test all three reset commands and unavailable descriptors, with no UI re-key. |
| Windows direct table expires between text and Enter | Start/share a deferred refresh at expiry, keep it unresolved beyond the 50 ms default Enter gap. Direct `unknown` still writes Enter at the configured gap (allow timer tolerance); assert no added process-refresh delay and no dependency on its 5 s completion. Repeat at text and recovery Enter; ordinary alias unknown at either Enter stops with explicit partial-write accounting. |
| Unknown id with no viable fallback | macOS and namespace-only sandbox return `session not found` with zero bytes and zero ownership wait, even if a descriptor names R. Supported-domain no-hint or proven external candidates also fail now. An unattached bg job immediately keeps its specific error/job id, including with a cold table; a supported cold candidate with a plausible hint waits for at most one shared process-table refresh, then the fallback decides with what it has; no candidate verified returns the existing fast `session not found` error. |
| Explicit continuation during step i's turn-end wait | Step i's text+Enter is logged. Change verified writer E→B before its turn-end wait completes, optionally re-key the map; step i+1 writes no bytes and the result preserves step i, identifies ownership refusal rather than `not sent`. If ordinary recovery Enter is attempted during the wait, guard it too. Run direct/alias and both question-4 initializations; a metadata-only record has no effect. |
| Local bg attach and remote attach tabs | Existing direct/historical route writes under one T lock with T/G/liveness and ordinary gates; no local ownership classifier or descriptor fallback runs. A remote snapshot on local miss wins over a local descriptor candidate, including a remote error; unattached socket delivery keeps its separate contract. |
| Close and reopen R during a wait | Close T/G, remove its keys and create T2/G2, optionally reusing the numeric pid. The old delivery fails its write guard and cannot migrate; the new trigger has T2's distinct lock and may proceed. No old bytes reach T2; text-only old submission is reported as partial. |

Cross-cutting assertions apply to every platform fixture:

- A direct and alias trigger reaching T never interleave, including when the
  alias appears during the first trigger's composer/idle wait. Chains keep the
  lock across a continuation re-key and their own reset. Different tabs still
  progress independently; refusal and exceptions release both queue layers.
- Two eligible tabs/writers, multiple continuations in one merged row, and shared
  cwd never select a first arbitrary alias. Reopening R in a new direct tab while
  an ordinary delivery waits refuses that pinned delivery rather than moving it;
  an authorized reset chain stays on its pinned tab.
- Nested `-p`/`--bg` descriptors cannot establish `mine` for a child id or
  `other` for the parent's id. Torn ancestor descriptors are unknown. Linux
  start mismatch and Windows FILETIME mismatch filter stale descriptors before
  either positive or negative decisions; include a stale file and a valid writer
  together. Windows child-before-parent creation order must not prove an alias.
- Close and reopen R with a new session object/generation and the same pid,
  exit it, or change the writer between text and Enter and between verification
  and recovery Enter. No remaining byte reaches the invalid binding; partial delivery never reports `not sent`.
- An own reset in one chain grants no other trigger permission. A never-entered
  reset, prose quoting `/clear`, an external continuation and a new writer process
  cannot activate the exception. Status and transcript reads follow the admitted
  binding even when R is reopened elsewhere; old compaction evidence never
  confirms a successor's compact.

### What CI can and cannot prove

Every synthetic cell can run in CI with injected platform/process/descriptor/
transcript seams. The test matrix currently runs Node 20/22 on Ubuntu and
Windows; E2E runs on Ubuntu (`.github/workflows/test.yml:49`,
`.github/workflows/test.yml:95`). It also installs bubblewrap and enables real
sandbox tests on Linux (`.github/workflows/test.yml:118`). Therefore real
namespace fixtures need not be declared impossible in CI. They can verify host
versus namespace pids, but do not substitute for a Claude conversation change.

For **all six macOS cells**, real `ps`/CLI/PTY validation is not covered by this
CI test matrix: there is no macOS test job (`.github/workflows/test.yml:101`,
`.github/workflows/test.yml:102`); the packaging workflow does have a macOS
runner (`.github/workflows/build.yml:18`). For **all 24 cells**, real Claude reset,
continuation and keystroke consumption are not established by synthetic tests;
the cited workflow provisions no authenticated Claude scenario for this matrix.
Those require isolated live validation with the CLI, or a later explicitly
provisioned integration job. Native Windows/Linux process probes can test OS
mechanics on their existing runners, not the causality of CLI identity changes.
Do not read a skipped CLI canary as delivery evidence
(`.ai/contexts/cli-session-state.md:546`).

## Consequences and rejected alternatives

The delivery target becomes a pinned tab plus a writer observation, so context
lookups, locking and every trigger write must share that binding. This costs
descriptor reads per write, bounded ownership waits for aliases, and careful
partial-write accounting. It preserves direct-key availability under unknown
ownership, at the stated cost of incomplete cross-conversation protection there.
macOS and namespace-only sandbox descriptor-alias delivery remain unavailable
until there is comparable process identity (historical routes depend on
question 4). No
changes are proposed to UI re-key detection, merged display rows, restoration,
protocol replies or unattached socket sending. This does not preserve every
existing trigger-routing promise: question 4 decides the old-id contract.

At implementation, update `.ai/contexts/trigger-watcher.md` and
`docs/automation.md` for pinned T/G, per-write scope, mandatory FIFO and its
unequal same-id/descriptor-alias budget, case normalization, remote precedence,
fallback fast failures, text-only residue, and `/resume X` chains stopping on a
verified identity change. Today's chain loop submits commands without that gate
(`trigger-watcher.js:1599`, `trigger-watcher.js:1722`). Add the behavior-change
entry to `CHANGELOG.md` then. These current-behavior docs remain unchanged in
this docs-only revision, before a maintainer choice or runtime implementation.

Question-4 option A must document historical ids as tab addresses at admission,
with E frozen through subsequent waits and writes. Option B must remove the
unconditional promise that an old id keeps reaching the same terminal
(`.ai/contexts/trigger-watcher.md:64`, `.ai/contexts/trigger-watcher.md:70`) and
explain refusal after a known user reset, including its pre-re-key interval.
Current re-keying after detected `/clear` requires `clearOwner(...) === 'mine'`
(`session-transitions.js:565`, `session-transitions.js:566`,
`session-transitions.js:587`), then current id resolution forwards the old id
(`session-transitions.js:53`, `session-transitions.js:59`,
`trigger-context.js:43`). The call at `session-transitions.js:566` passes no
`closestWriter` argument (the continuation policy above is separate).

The five supplied #587 commit messages are evidence of design revisions, not
independent proof of each review's exact chronology or runtime failure. In
chronological order:

| #587 commit | Attempt and failure to avoid |
|---|---|
| `92548b3` | Re-key from a continuation record **or** descriptor ownership and add a parent-PTY fallback. A record does not identify its writer; merging conversations cannot establish a per-process tab. Keep #594's record **and** closest-writer proof for UI re-keying; implement delivery fallback separately. |
| `796fd0a` | Keep aliases through torn reads and recheck ownership at most every 3 s. Keeping a hint is acceptable, but reusing that verdict for a write leaves a changed conversation reachable. Per-write observation is mandatory. |
| `805aa63` | Drop aliases on a readable different descriptor and add a per-tab mutex after the per-id FIFO. Arbitrary descendants can be nested CLIs, so a different descriptor is not necessarily T's writer. A mutex also protects nothing on a late delivery path that never takes it. Use closest-writer selection and one guarded write boundary. |
| `025810d` | Require a tab lock and unthrottled proven ownership. Requiring `mine` for direct keys loses cold Windows and sandbox delivery; the later `74e9721` message explicitly records this regression. Preserve the three-outcome policy. |
| `74e9721` | Restore direct-key delivery unless definitely other, but wait for the chain's own `/clear` re-key. That wait cannot complete on platforms lacking comparable ownership and omits `/new`/`/reset` in the supplied final diff. Authorize the chain's reset locally on the same T/G instead. |

The supplied final patch confirms the `/clear`-only re-key wait and an explicit
Linux-only stale-process filter in its direct-key branch
(`.work-files/pr587.diff:1990`, `.work-files/pr587.diff:1999`,
`.work-files/pr587.diff:362`). It is abandoned input, not current behavior.
Do not transplant it. Also reject locking by requested id alone, sticky alias
permission after a known move, changing the global PTY writer to guard protocol
replies, and treating `getDescriptorIdentity` as a process-generation check.

## Open questions for the maintainer

1. **Accept tab-local reset authorization where successor identity is unknown?**
   Recommended: yes, for the same chain after its own guarded clear-family Enter,
   on the same tab, PTY and observed writer generation; no global alias permission.
   It is necessary to preserve reset chains without re-key support. It authorizes
   the reset successor without claiming causal proof when all identity evidence
   is unavailable. Keep the limitation explicit and bind E once observable.
2. **Keep macOS and namespace-only sandbox descriptor aliases unavailable without
   positive process identity?** Recommended: yes. Fail descriptor fallback fast
   there; deliver direct `unknown`, but never infer descriptor-alias ownership
   from a row, cwd, unsupported anchor or continuation record. Historical
   mappings use question 4 independently. A platform identity adapter would be
   a separate, measured follow-up.
3. **Count the new tab-mutex and ownership waits inside `timeout_ms`?**
   Recommended: yes, after reaching the existing per-id FIFO's head. This gives
   the new waits one bounded delivery budget while retaining same-id dispatch
   order. The FIFO is mandatory: same-id queue time is outside the budget,
   but a distinct descriptor alias waits for T inside it and can expire first.
   Document this timing choice in the later implementation's automation
   documentation; do not grant a fresh budget after a fallback or reset.

4. **What does a new trigger to an old id mean after a user `/clear`?**
   No decision is made in this revision. Today the old id still reaches the
   same terminal after the map re-key (`session-transitions.js:53`,
   `session-transitions.js:59`, `trigger-context.js:43`; the published promise
   is `.ai/contexts/trigger-watcher.md:64`). Consider writer A→C before this
   trigger is admitted, with map still A or with historical mapping A→C:

   - **Option A — preserve tab addressing at admission.** For a direct or
     historical route, initialize E once from T's verified interactive writer
     at initial pinning, or otherwise from the normalized resolved live map key.
     An `unknown` writer at admission leaves E unbound until the first
     decidable observation before the text; if none arrives before the text,
     deliver as a direct key on `unknown` per the direct-key rules. (Freezing E
     to the map key on a cold Windows table would bind A while the writer is
     already C, then refuse once the table warms, where a warm table delivers
     with E=C.) Under A, a `/compact` sent to the old id after an unrekeyed
     continuation lands in the new conversation.
     A historical route uses the direct-key `unknown` policy from admission
     onward; a descriptor alias still requires positive `mine`. Thus a new
     trigger R=A after user clear reaches C even before UI re-key if C is
     observable; after re-key, unavailable identity also preserves delivery.
     Freeze a bound E before joining the tab mutex/readiness/turn waits. Never
     rebind E after a subsequent move, except this chain's own reset. The live
     direct A, if reopened elsewhere, still wins. This option necessarily
     generalizes to other pre-admission conversation changes reachable by the
     same direct/historical route: no reset-cause discriminator is proposed.
   - **Option B — address the requested conversation.** Initialize E to R for
     direct and both alias types. A verified writer C refuses immediately,
     both before and after re-key. Unavailable evidence keeps direct-key
     availability before re-key, but a historical alias waits only before text
     within the deadline and cannot write without `mine`. An admitted chain's
     own reset remains the sole permission to bind its successor. This is a
     change to the published old-id routing contract, not merely protection
     against a conversation change while a trigger waited.

   **Recommendation: option B**, because the requested conversation remains
   the address unless the caller explicitly authorizes a reset in its chain.
   Its availability limits and required automation-doc migration must be
   accepted by the maintainer; the recommendation is not an implementation
   choice. Both options prohibit following a proven later move during a
   delivery and retain the direct-unknown observability limitation.

   **Sections affected by the answer:** Delivery invariant and vocabulary
   (initial E and key semantics), Lookup fallback (historical versus descriptor
   admission), Ownership outcomes (historical action column), One lock per tab
   (freeze E before waits), Test matrix (all historical-alias cases and the
   user-clear row), and Consequences (old-id promise/doc migration). The chain's
   own reset and Refusal rules remain the same under both. Until selection,
   interpret every historical alias through these conditional rules, never
   infer option B from the ordinary descriptor-alias table.

## Verification boundary

This ADR is based on local source inspection and the supplied issue, commit
messages and diff. It adds no implementation or tests. The race scenarios are
source-derived inferences; they were not reproduced against a running app here.
Real macOS ownership, Linux namespace descriptors, Windows cold-table/PID reuse,
and reset/continuation causality were not measured with a live CLI in this step.
No claim is made that the proposed invariant is implemented or that its future
test matrix passes. Maintainer acceptance is the next gate.
