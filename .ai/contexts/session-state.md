# Session state — one domain module, one icon slot

Origin: issue #246 (step 3 of the alignment sequence #244 → #245 → #246 → #247).
Full design: the issue body and its 2026-09-11 lifecycle comment. This doc covers
what actually shipped, not the whole plan.

## Migration status

- **Steps 1-3b: done.** `public/session-activity.js` split into a state part
  (itself) and a DOM part (`public/session-activity-dom.js`); `public/session-state.js`
  introduced and wired behind `applyActivityClasses` for local-pty, and behind
  a persistent `remote-ssh` adapter (`public/remote-activity-ui.js`) for
  remote sessions — see "The remote-ssh adapter" below. Step 3b (one
  `.session-icon` slot per sidebar row, replacing `.session-status-dot` for
  session/subagent rows) shipped separately — see "The icon slot (step 3b)"
  below.
- **Steps 4/5: pending.** There is no `local-transcript` adapter (step 4).
  Subagent attribution is not routed through `session-state.js` (`agentsBusy`
  exists in the model but nothing local-pty feeds it yet — sidebar.js's
  `has-busy-agents` row class is still computed by `parentHasActiveSubagent()`,
  independent of the domain module) (step 5).

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
returns `{ classes, slotClasses, glyph, title }` for **one icon slot**. Only
the four rungs that map to an existing row-level CSS class (`needs-attention`,
`response-ready`, `cli-busy`, `has-busy-agents`, in `classes`) carry one; every
rung — including those four — also carries exactly one `slotClasses` entry
(`session-icon--attention`, `session-icon--response-ready`, `session-icon--busy`,
`session-icon--agents-busy`, `session-icon--waiting`, `session-icon--idle`,
`session-icon--stale`, `session-icon--archived`). See "The icon slot (step 3b)"
below for how `classes` and `slotClasses` are used differently.

## The icon slot (step 3b)

One `.session-icon` element per session/subagent row (`public/sidebar.js`'s
`buildSessionItem`/`buildSubagentItem`), replacing `.session-status-dot` for
those two rows — `.remote-host-dot` (the project header's per-host
reachability indicator, a different row entirely) is untouched and still
composes `class="session-status-dot remote-host-dot ..."`; both base CSS
rules (`.session-status-dot`, `.session-icon`) exist side by side in
`style.css` for exactly this reason. `.session-icon`'s box (6px, same as the
old dot) is fixed regardless of rung, so the row never shifts as the glyph
underneath it changes.

`session-activity-dom.js` is the only file that writes the slot:

- `writeIconSlot(el, icon)` clears any previous `session-icon--*` class
  (robust to a rung's `slotClasses` shrinking or changing shape — a plain
  diff of the old vs. new class would also work but this needs no diffing),
  applies `icon.slotClasses`, and sets `el.title`/`el.dataset.glyph` from
  `icon.title`/`icon.glyph`. The `session-icon--*` namespace is deliberately
  distinct from the row-level `classes` (`cli-busy` etc.) both for the eslint
  boundary (see "Enforcement" below) and so a reader never confuses "this
  paints the row" with "this paints the slot".
- `session-activity-dom.js` also references `parentHasActiveSubagent`
  (`sidebar.js`) and `sessionMap` (`app.js`) now, alongside the pre-existing
  `sessionBusyState`/`responseReadySessions`/`attentionSessions`
  (`session-activity.js`). Safe despite loading before all three in
  index.html's script order — every reference is inside a function body,
  resolved at call time after the whole page has loaded, same pattern
  `sidebar.js`'s own header comment documents for its dependencies.
- `snapshotForLocal(sessionId, session)` builds a local-pty snapshot the same
  way `computeBusyReadyClasses` does for busy/responseReady, extended with
  `attention` (`attentionSessions`), `agentsBusy` (`parentHasActiveSubagent()`),
  and `liveness`/`descriptorStatus` from `session.status`/`statusUpdatedAt`
  when present — cli-session-state.js only keeps an entry while the pid is
  alive (`.ai/contexts/cli-session-state.md`), so `session.status` being
  present at all is itself the local liveness signal; `session` is optional
  and falls back to a `sessionMap` lookup for call sites that only have a
  sessionId.
- `paintSessionIcon(el, sessionId, session)` composes the two:
  `writeIconSlot(el, renderSessionIcon(snapshotForLocal(sessionId, session)))`.
  Called from `sidebar.js` at row construction (both `buildSessionItem` and
  `buildSubagentItem`), from `applyActivityClassesToElement` on every local
  busy/ready/attention/subagent transition, and from
  `reflectSubagentRunningState` on the **parent** row (agentsBusy is part of
  the priority ladder the slot resolves, so a subagent spawn/complete must
  repaint the parent's slot, not just its `has-busy-agents` row class).
- `applyStateClasses(sessionId, snapshot)` (the remote-ssh path, called from
  `remote-activity-ui.js`'s `projectRemoteState`) now also calls
  `writeIconSlot` with the same `renderSessionIcon(snapshot)` result it uses
  for the row's `cli-busy`/`response-ready` classes — this is what makes a
  local busy row and a remote busy row render the identical slot markup
  (classes, title, glyph), pinned in `test/dom-sidebar-icon-slot.test.js`.

The `.running` class on `.session-icon` is **not** part of this model — it is
the old dot's orthogonal "a PTY/subagent process is attached" boolean
(`activePtyIds`/`isSubagentActive`), toggled exactly as before by
`app.js`/`sidebar.js`, independent of `renderSessionIcon`'s priority ladder.

### The slot's CSS keys on its own rung class alone (coordinator follow-up, 2026-09-11)

First pass of this step left `style.css` still resolving the slot's visual
with row-class `:not()` chains carried over verbatim from the old
`.session-status-dot` rules (`.session-item.cli-busy:not(.needs-attention)
.session-icon`, `.session-item.has-busy-agents:not(.cli-busy):not(...):not(...)
.session-icon`) — exactly the row-class arbitration this migration exists to
retire, just renamed. `renderSessionIcon()` already picks the single active
rung in JS before `writeIconSlot()` ever touches the DOM, so the CSS never
needs to re-derive it: every rung's visual now keys on its own
`.session-icon--<rung>` class alone, no ancestor `:not()` chain —

```css
.session-icon--busy { background: transparent !important; animation: none !important; ... }
.session-icon--busy::before { content: "\280B"; animation: braille-spin ...; color: #4fc3f7; ... }
.session-icon--agents-busy { background: transparent !important; ... }
.session-icon--agents-busy::before { content: "\283F"; color: #8088ff; ... }
.session-icon--response-ready { background: #4fc3f7 !important; ... }
.session-icon--attention { background: #f0a050 !important; ... }
```

`background` (the only property `.session-icon.running`'s plain green also
sets) carries `!important` on every rung — busy/attention/response-ready/
agentsBusy rows are very often also `.running` (a busy session almost always
has a live PTY), and unlike the old code the rung is now a single class with
no extra row-ancestor classes to lean on for specificity.

**`has-busy-agents` is the one exception, and it stays row-level on purpose**
(point 1 of the original brief: "`.has-busy-agents` stays a row-level class
— a tint — but its glyph rung lives in the slot when nothing higher is
active"). A busy session with live subagents needs the busy spinner tinted
violet instead of its default blue; since `agentsBusy` never wins the JS
priority race while `busy` is active, there is no `session-icon--agents-busy`
class to key on in that case — so the tint is a **plain compound selector**,
row tint class + slot rung class, not a priority tie-break:

```css
.session-item.has-busy-agents .session-icon--busy::before { color: #8088ff; }
```

This is the only place a row-level class still appears next to `.session-icon`
in the slot's own visual rules, and `test/session-icon-slot-css-boundary.test.js`
allows it explicitly (it only forbids `:not(`, not row classes generally) —
the boundary is "no priority re-arbitration in CSS", not "no row class may
ever touch the slot's selector".

`test/session-icon-slot-css-boundary.test.js` source-greps `style.css`
(comments stripped first — a couple of them, including the one you're
reading in source, mention `:not()` in prose and would otherwise
false-positive a naive scan) for any selector mentioning `.session-icon` and
asserts none contains `:not(`; `.session-status-dot`/`.remote-host-dot` (the
project header's per-host reachability dot, a different row, untouched by
this migration) are excluded. Mutation-proven: reintroducing
`.session-item.cli-busy:not(.needs-attention) .session-icon--busy { ... }`
turns it red.

`test/dom-sidebar-icon-slot.test.js` pins the slot markup itself (mutation-
proven: swapping the `busy`/`agentsBusy` entries in `ICON_BY_RUNG` turns three
of its DOM tests red, plus the pure-unit tests in `test/session-state.test.js`).
The five tests named in issue #246's step 3b brief
(`dom-sidebar-local-status`, `dom-sidebar-remote-session`,
`dom-sidebar-remote-freshness`, `sidebar-busy-agents-tint`,
`dom-sidebar-remote-activity-pip`) needed no markup changes beyond
`sidebar-busy-agents-tint.test.js`'s CSS-selector regexes (retargeted first
from `.session-status-dot` to `.session-icon`, then from the row-class
`:not()` chains to the flat `session-icon--<rung>` selectors above) — none of
the others assert on the dot/slot element itself, only on row classes and
`.session-status`.

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
