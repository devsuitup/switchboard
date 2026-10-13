# 0003 — Deliver triggers under one tab lock and a per-write ownership check

**Status**: Proposed (2026-10-13). Maintainer review precedes implementation.

## Context

This record addresses issue #592, following the narrow #579 fix in PR #594.
Source references describe checkout `dc63eb641ec3e54296cc96d442da28b3e60ed4e6`
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
than measured again in this session (`.ai/contexts/cli-session-state.md:307`,
`.ai/contexts/cli-session-state.md:415`, `.ai/contexts/cli-session-state.md:477`;
issue #592 supplied in the brief).

## Decision

### Delivery invariant and vocabulary

For **each trigger-originated PTY write**, the trigger must hold the exclusive
lock of its pinned tab, still address that tab's pinned live PTY generation,
and pass a fresh ownership decision immediately before writing. Apply this to
command text, its initial Enter and every recovery Enter, for both single
commands and every chain step. Never switch a running delivery to another tab.

- **Requested id R** is immutable and remains the id reported in results.
- **Tab T** is an opaque stable identity attached to the active session object,
  surviving a map re-key. It is not a conversation id, display row or pid.
- **PTY generation G** includes the actual PTY object and available process-start
  identity. Replacing it invalidates an in-flight delivery, even if its numeric
  pid or map key is unchanged. Replacement under the same tab keeps that tab's
  lock, so old and new deliveries cannot overlap.
- **Effective id E** is initially R. It changes only for this chain's authorized
  clear-family transition, described below.
- **Direct key** means the exact requested live map key names T and the known
  `realSessionId`, if present, agrees with R. A re-key mapping or descriptor
  fallback is an **alias key**, even if it names the same T. Direct-key
  precedence applies during initial lookup, not as permission to retarget a
  delivery already pinned to another tab.

Protocol replies, user keyboard input and other non-trigger writes are outside
this invariant. Scope the guarded writer to the trigger pipeline, not the PTY's
global `write` method. Plain terminals and existing attached transports keep
their direct routes and gain tab serialization/generation checks; an unavailable
local ownership source is `unknown`. Do not add descriptor fallback to plain
terminals or remote attachments. Unattached remote socket delivery retains its
existing route and contract (`trigger-watcher.js:1294`,
`trigger-context.js:45`, `trigger-context.js:69`).

### Lookup fallback: one process, one tab

On a local lookup miss, read descriptors for exactly R, independently of UI rows,
and find a unique verified closest writer whose ancestry reaches a unique live
local Claude tab's PTY. Enumerate candidates: do not use the first match from
`findLiveProcess` as uniqueness proof. A verified descriptor in a descendant
`claude -p` or `--bg` process below the tab's writer cannot alias that child
conversation to the parent tab. An explicit background attach under its own
direct key retains its existing route; an unattached background process is not
implicitly attached by fallback.

Require a one-to-one relation between verified writer process generations and
tab generations. Multiple eligible writers or tabs, incomplete ancestry or
missing start identity mean no proven alias. Different ids in one merged row,
shared cwd, `bridgeSessionId`, a continuation record alone, and a pid number alone
are not ownership evidence. Retain existing remote resolution when no local tab
can be established; never type into a local candidate with an uncertain alias.

Aliases are temporary lookup hints. A torn descriptor read may preserve a hint
for bounded rechecking, but cannot authorize a write. Drop hints on a proven
writer change, tab exit, PTY replacement or a new direct-key target. Do not retain
a global historical permission to send R to T after T moves to another id.

### One lock per tab

Keep the existing per-requested-id FIFO if needed for same-id dispatch ordering,
then acquire exactly one tab mutex, keyed by T. Resolve before joining that
mutex, and validate T, G and ownership again after acquisition. A fallback found
late must join the same mutex before any readiness/composer wait or write. If
the candidate changes while queued, refuse and release; do not migrate to another
mutex while holding the first. This avoids a second lock ordering or silent
redirection. Different tabs remain independent.

Hold the tab lock through the complete command or chain, all verification waits,
and result production. Release on every exit. A chain's re-key, own clear, or a
second trigger naming a new descriptor id must not create another lock. Only the
per-id FIFO is entered before the delivery budget; proposed tab-lock acquisition,
fallback resolution and ownership waits consume that command/chain budget. Each
step remains capped by the remaining global budget. Do not add an independent
re-key timeout or restart a budget after ownership changes. See open question 3.

### Ownership outcomes

Classify a fresh observation of T's **closest valid writer** relative to E:

| Outcome | Meaning | Direct key action | Alias key action |
|---|---|---|---|
| `mine` | One verified closest writer for T/G names E. | Deliver once the existing composer/readiness/deadline gates allow. | Deliver under the same gates and T's lock. |
| `other` (definite) | T's verified closest writer names a different id. For an alias candidate, complete identity-checked evidence of an exclusively foreign process tree also rules out that candidate. A foreign descriptor alone does not prove `other` for a direct key. | Refuse immediately; write no further bytes. | Refuse immediately and drop the alias. |
| `unknown` | No decidable writer: absent/torn descriptor, cold/failed/obsolete table, unsupported identity domain, inaccessible namespace, ambiguous candidates or unreadable ancestry. | Deliver under the existing gates; do not wait for or require proven ownership. | Wait/recheck within the existing delivery deadline; deliver only on `mine`, refuse on `other`, expire without another write on continued `unknown`. |

An alias that has not yet identified a tab waits only for lookup evidence, not
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
Validate ancestor identity/creation order and stop at the closest writer. If an
ancestor's descriptor is torn or its role cannot be resolved, return `unknown`
rather than promote a readable nested child. The stale descriptor must not block
selection of another valid writer either.

Immediately before every actual write, reread descriptors and redo this decision,
without a 3 s alias-verdict throttle. Bound and share asynchronous process-table
refreshes; do not synchronously spawn a probe at every keystroke. Where refresh
is needed, await it within the remaining budget and then reread descriptors,
revalidate the pinned binding and apply the table. Missing evidence still uses
the direct/alias distinction above. A synchronous final guard and the underlying
write must have no intervening `await`. A previously sampled `mine`, a descriptor
revision, transcript mtime or status timestamp is not a reusable delivery permit.

This prevents **observable** cross-conversation writes. It cannot atomically bind
the external CLI's conversation to PTY bytes: Windows process snapshots can age
and the CLI can switch between the final observation and consumption. Direct
`unknown` deliberately retains that uncertainty. Do not claim an absolute
cross-process guarantee on platforms where ownership cannot be observed.

### The chain's own `/clear`, `/new` or `/reset`

A clear-family step is checked against the current E exactly like any other
step. Recognize the exact case-sensitive first command token after trimming,
including optional arguments, for all three names. Merely appearing in quoted
prompt text does not qualify. No exception applies before its Enter is written.

After this chain writes both that text and Enter under the guard, grant a
**chain-local reset authorization** for the same T/G. The following steps are
explicitly addressed to that tab's reset successor. They do not require a UI
re-key, a new transcript file, or continued ownership of pre-clear E. This is
the sole exception to the ordinary alias table: an admitted alias chain may
continue on `unknown` after its own reset, just as a direct chain may, on this
same live PTY. Other triggers receive no such authorization.

During reset, use the first verified successor id of the same closest writer
process generation as the new E; readable clear bookkeeping after this Enter
can corroborate it. A new writer process, conflicting transition evidence or
PTY change refuses. If no successor id is observable, retain tab-local reset
mode and normal readiness/verification fallback; never wait just for a re-key.
Once a successor is observed, bind E to it and reject later definite moves to
another conversation. Another guarded clear-family step can authorize the next
reset. A continuation unrequested by the chain never grants reset authorization.

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
No retry, cleanup keystroke or recovery Enter is exempt from the guard. The
existing result contract distinguishes `not sent` from written-but-unconfirmed
delivery (`docs/automation.md:580`; `.ai/contexts/trigger-watcher.md:1548`,
`.ai/contexts/trigger-watcher.md:1570`).

## Test matrix for the implementation step

All 24 cells below are required synthetic `node:test` cases, not tests added or
executed by this ADR. In every cell, assert the PTY byte log **and** result
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

| Platform / key | Plain step | Clear-family step and following step | Step after a continuation |
|---|---|---|---|
| Windows / direct | W+T: matching writer delivers; cold/failed table delivers on `unknown`; verified different tab writer refuses. | W+T: admit reset under the same policy; write successor step on the same T/G even with cold table and no re-key. Warm successor binds E; later definite unrelated move refuses. Parameterize all three commands. | W+T: R=A refuses on proven writer B despite stale direct key. R=B after re-key delivers. Cold ownership stays `unknown` and direct delivers, without claiming conversation proof. |
| Windows / alias | W+T: unique matching closest writer delivers; torn read or cold table waits, then delivers if proof arrives or expires with no write; definite other refuses. | W+T: `mine` admits reset; `unknown` before reset waits. After its own Enter, successor step proceeds on pinned T/G without re-key, including `unknown`; no permission transfers to a separately queued alias trigger. | W+T: R=B fallback delivers before re-key and uses T's lock. R=A historical alias refuses on verified B; unknown waits. A later B to C move blocks the next write for R=B. |
| Linux / direct | L+T: matching writer delivers; null ancestry/start evidence delivers on `unknown`; verified different writer refuses. | L+T: reset admission uses ordinary policy; successor proceeds on pinned T/G without re-key, with all three command names. After known successor E, a definite later move refuses. | L+T: proven B rejects R=A; direct R=B after re-key delivers. Unreadable ancestry allows direct `unknown`; transcript-only A to B is insufficient contrary evidence. |
| Linux / alias | L+T: unique closest match delivers; missing/torn ancestry waits then expires or delivers on recovered proof; definite other refuses. | L+T: prove alias before reset; after guarded Enter, successor follows same writer/T/G even when descriptors become unreadable and map remains A. Before Enter, `unknown` still waits. | L+T: R=B reaches unrekeyed A only with writer proof. R=A re-key alias refuses once writer is B; if proof disappears, wait. Proven later move B to C prevents Enter/recovery for B. |
| Linux sandbox / direct | S+T: namespace-only descriptor yields `unknown`, direct still delivers; unrelated host pid collision cannot cause refusal. Positive host-identity control can refuse a proven different writer. | S+T: `[/clear, reply]`, `[/new, reply]`, `[/reset, reply]` continue on the same T/G with no re-key and no host identity. Keep unknown confirmation explicit. | S+T: R=A cannot be refused on namespace uncertainty alone; R=B direct after an injected re-key delivers. Host-verifiable different writer control refuses R=A. |
| Linux sandbox / alias | S+T: namespace-only ownership cannot admit fallback; wait then no write. Comparable-host control admits a unique `mine`, rejects definite other. | S+T: unknown alias cannot start reset. Admit with host-identity control, then remove visibility: following step continues under its own reset authorization without re-key. | S+T: R=B unrekeyed lookup remains unknown and unwritten with namespace-only data; host-comparable proof permits B. Old R=A alias waits on unknown and refuses on proven B. |
| macOS / direct | M+T: missing comparable anchor remains `unknown`, direct delivers. Injected classifier `other` control refuses; do not infer it from `unsupported`. | M+T: all three reset chains reach the successor step on the same T/G without a re-key; unavailable identity does not create a re-key wait. Submission/readiness failures remain ordinary failures. | M+T: unrekeyed R=A remains direct `unknown` and may deliver; R=B direct after injected re-key delivers. A classifier-proven B refuses R=A. This is the documented observability limit. |
| macOS / alias | M+T: real-source ownership is unknown, so no alias write; expire boundedly. Injected `mine` control delivers; `other` control refuses. | M+T: unknown alias cannot admit reset. Injected `mine` admits it; return to unsupported identity after Enter and verify successor step continues without re-key under the chain-local exception. | M+T: R=B before re-key cannot obtain real-source alias proof; wait/expire. Even a historical re-key alias waits on unknown. Injected B proof delivers R=B, rejects old R=A. |

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
- Replace the PTY object with the same pid, exit it, or change the writer between
  text and Enter and between verification and recovery Enter. No remaining byte
  reaches the invalid binding; partial delivery never reports `not sent`.
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
CI matrix: there is no macOS runner. For **all 24 cells**, real Claude reset,
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
macOS and namespace-only sandbox alias delivery remain unavailable until there
is comparable process identity. No changes are proposed to re-keying, merged
display rows, restoration, protocol replies or unattached socket sending.

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
2. **Keep macOS and namespace-only sandbox aliases unavailable without positive
   process identity?** Recommended: yes. Deliver direct `unknown`, but never infer
   alias ownership from a row, cwd, unsupported anchor or continuation record.
   A platform identity adapter would be a separate, measured follow-up.
3. **Count the new tab-mutex and ownership waits inside `timeout_ms`?**
   Recommended: yes, after reaching the existing per-id FIFO's head. This gives
   the new waits one bounded delivery budget while retaining same-id dispatch
   order. Document this timing choice in the later implementation's automation
   documentation; do not grant a fresh budget after a fallback or reset.

## Verification boundary

This ADR is based on local source inspection and the supplied issue, commit
messages and diff. It adds no implementation or tests. The race scenarios are
source-derived inferences; they were not reproduced against a running app here.
Real macOS ownership, Linux namespace descriptors, Windows cold-table/PID reuse,
and reset/continuation causality were not measured with a live CLI in this step.
No claim is made that the proposed invariant is implemented or that its future
test matrix passes. Maintainer acceptance is the next gate.
