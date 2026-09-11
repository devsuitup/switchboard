# Session state — one domain module, one icon slot

Origin: issue #246 (step 3 of the alignment sequence #244 → #245 → #246 → #247).
Full design: the issue body and its 2026-09-11 lifecycle comment. This doc covers
what actually shipped, not the whole plan.

## Migration status

- **Steps 1-3: done.** `public/session-activity.js` split into a state part
  (itself) and a DOM part (`public/session-activity-dom.js`); `public/session-state.js`
  introduced and wired behind `applyActivityClasses` for local-pty, and behind
  a persistent `remote-ssh` adapter (`public/remote-activity-ui.js`) for
  remote sessions — see "The remote-ssh adapter" below.
- **Steps 3b/4/5: pending.** The unified icon-slot markup (dot + age + spinner
  in one element) is a separate PR (3b). There is no `local-transcript`
  adapter (step 4). Subagent attribution is not routed through
  `session-state.js` (`agentsBusy` exists in the model but nothing local-pty feeds
  it yet — sidebar.js's `has-busy-agents` is still computed by
  `parentHasActiveSubagent()`, independent of the domain module) (step 5).

### The remote-ssh adapter (step 3)

`public/remote-activity-ui.js` keeps one persistent `createSessionState('remote-ssh')`
per remote session id in `remoteSessionStates` (a `Map`, pruned in
`pruneRemoteActivityTimers()` alongside the decay timers, called after every
`refreshSidebar()`). It is fed by:

- **The watch channel** (`onRemoteActivityEvent`, `main.js`'s `remote-activity`
  IPC): `transcriptTouched` + `busy: true`; the 20s decay timer then applies
  `busy: false, armReady: false` — a remote row must never reach
  `.response-ready`, it has no PTY to confirm a turn actually ended. Tested in
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
`projectRemoteState(sessionId)`, which calls `session-activity-dom.js`'s new
`applyStateClasses(sessionId, snapshot)` — the same two-class output
(`cli-busy`/`response-ready`) `applyActivityClasses` produces for local-pty,
but computed from the adapter's own snapshot instead of the local-pty Maps.

**`setActivity()`/the Maps in `session-activity.js` are still fed for remote
ids in parallel** (`markRemoteBusy`/`decayRemoteBusy` call both). Two readers
were not migrated onto the adapter in this step, so removing the dual-feed
would regress them:
- `sidebar.js`'s `buildSessionItem` reads `sessionBusyState`/
  `responseReadySessions`/`attentionSessions` directly at initial paint.
- `app.js`'s grid-card busy dot (`updateRunningIndicators`'s `gridCards`
  loop) reads `sessionBusyState` directly.

Both are driven by the same `active`/`armReady` inputs as the adapter, so the
two projections never disagree in practice; the dual-feed is a known,
temporary duplication, not a race.

## Shape

Three files, one direction of dependency for data, the reverse for rendering:

```
public/session-state.js          pure domain — no DOM, no IPC, no electron
public/session-activity-dom.js   DOM projection — the only file allowed to
                                  write .cli-busy/.needs-attention/
                                  .response-ready/.has-busy-agents
public/session-activity.js       Maps/Sets + setActivity/purgeActivityFor/
                                  rekeyActivityState/reconcileBusyState —
                                  calls into session-activity-dom.js to render
```

`createSessionState(kind)` returns `{ apply(event), snapshot() }`. `kind` is
`'local-pty' | 'local-transcript' | 'remote-ssh'` (only `'local-pty'` is fed
today). Snapshot fields:

| field | meaning |
|---|---|
| `kind` | which adapter produced this state |
| `liveness` | `'alive' \| 'dead' \| 'unknown'` — is the CLI process running |
| `attached` | Switchboard holds a PTY / ssh attach for it — **separate from liveness** (2026-09-11 lifecycle decision: a row is active because the process is alive, not because a tab is open) |
| `busy` | OSC 0 — generating |
| `waitingForInput` | idle, sitting at the prompt |
| `attention` | OSC 9 — needs the user right now (permission/approval/plan) |
| `responseReady` | subset of `waitingForInput`: idle **and** unseen when it went idle (the legacy "Claude finished, you haven't looked" rung). Not in the issue's original field list — added because the priority order names it as its own rung, distinct from plain `waitingForInput`; see "Design notes" below. |
| `agentsBusy` | subagents running under this session |
| `lastActivityAt` / `lastActivitySource` | last touch, for `local-transcript`/`remote-ssh` (unused by local-pty today) |
| `label` / `labelConfidence` | reserved, unused |
| `attachable` | reserved, unused |
| `archived` / `stale` | reserved, unused |

Invariant enforced by `apply()`: `busy` / `waitingForInput` / `attention` are
mutually exclusive — going busy or attention clears the other two (and
`responseReady`, which only means something under `waitingForInput`).

`renderSessionIcon(snapshot)` resolves the priority order — attention >
responseReady > busy > agentsBusy > waitingForInput > idle+age > stale >
archived — defensively (it does not trust the caller kept exclusivity) and
returns `{ classes, glyph, title }` for **one icon slot**. Only the four
rungs that map to an existing CSS class (`needs-attention`, `response-ready`,
`cli-busy`, `has-busy-agents`) carry a class today; the rest carry a glyph/title
only — the sidebar HTML/CSS shape (replacing the dot/pip with the icon slot)
is a later step, not part of this migration.

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
- Ports (`transcriptTouched`, `descriptorStatus`, `subagentSpawned/Completed`,
  `attachable`, `label`, `archived`, `stale`) are implemented in `apply()` but
  **not fed by any adapter yet** — they exist so steps 3-5 don't need another
  domain-shape change.

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
| `busy` / `attention` (OSC 0 / 9) | yes | never | wired via the watch channel (transcript writes), not OSC — OSC-while-attached is not wired |
| `transcriptTouched(at)` | yes | yes (only signal) | yes — `onRemoteActivityEvent`/`markRemoteBusy` |
| `descriptorStatus(status, at)` / `liveness` | yes | no (no live CLI) | yes (`main.js:539` → `applyRemoteDescriptor`) |
| `attached` | reserved, unused | reserved, unused | yes — `setRemoteAttached`, driven by the per-row `activePtyIds` transition |
| `subagentSpawned` / `subagentCompleted` | yes | no | no today |

An adapter without a PTY must never claim `waitingForInput` or `responseReady`
from a completion signal it cannot verify — that is why the remote-ssh
`busy: false` transition always passes `armReady: false` (see "The remote-ssh
adapter" above), not a tri-state `busy: unknown`.
