# Session state — one domain module, one icon slot

Origin: issue #246 (step 3 of the alignment sequence #244 → #245 → #246 → #247).
Full design: the issue body and its 2026-09-11 lifecycle comment. This doc covers
what actually shipped, not the whole plan.

## Migration status

- **Steps 1-2: done.** `public/session-activity.js` split into a state part
  (itself) and a DOM part (`public/session-activity-dom.js`); `public/session-state.js`
  introduced and wired behind `applyActivityClasses` for **local-pty only**.
- **Steps 3-5: pending.** `remote-activity-ui.js`/`remote-activity.js` still write
  `sessionBusyState` directly instead of going through a `remote-ssh` adapter; there
  is no `local-transcript` adapter; subagent attribution is not routed through
  `session-state.js` (`agentsBusy` exists in the model but nothing local-pty feeds
  it yet — sidebar.js's `has-busy-agents` is still computed by
  `parentHasActiveSubagent()`, independent of the domain module).

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

- `eslint.config.js`: a `no-restricted-syntax` rule forbids
  `classList.add/remove/toggle('cli-busy' | 'needs-attention' | 'response-ready' | 'has-busy-agents', …)`
  in every `public/**/*.js` file except `session-activity-dom.js` (tests are a
  separate glob, exempt by construction). All prior direct writers
  (`app.js`, `sidebar.js`, `session-activity.js` itself) were moved onto the
  DOM file's `setNeedsAttention`/`setResponseReady`/`setCliBusy`/`setHasBusyAgents`
  helpers so the rule starts at zero violations.
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
| `busy` / `attention` (OSC 0 / 9) | yes | never | only while attached |
| `transcriptTouched(at)` | yes | yes (only signal) | yes (watch channel) |
| `descriptorStatus(status, at)` | yes | no (no live CLI) | yes (`main.js:539`) |
| `subagentSpawned` / `subagentCompleted` | yes | no | no today |

An adapter without a PTY must never claim `waitingForInput` or `responseReady`
— it has no way to tell "thinking" from "done, unseen". It should only feed
`busy: unknown` (not modeled as a tri-state yet — reserved for step 3/4) plus
`lastActivityAt`.
