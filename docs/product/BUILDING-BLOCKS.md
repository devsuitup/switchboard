# Building blocks

The bricks Switchboard's screens are made of **as they are at v0.0.94
(f596e28)**: most exist implicitly, as a function or a CSS class family that
several places re-implement. For each brick: its job, anatomy, variants and
states, behaviour, tokens, current uses (`file:line`), the duplicates that
should become it, and a clearly marked **Proposed convergence**.

New UI is composed from these bricks. A new brick needs a reason the existing
ones cannot serve. A brick is proposed as shared only with at least three
real instances or a demonstrated user confusion.

Evidence: read in the code at the cited line unless marked **supposed**. The
app was not run. The patterns these bricks serve are in
[UI-PATTERNS.md](UI-PATTERNS.md); concept names in [GLOSSARY.md](GLOSSARY.md).

| Id | Brick | Exists today as | Status |
|---|---|---|---|
| B1 | State mark | `renderSessionIcon` + `.session-icon` | exists, partial (4 rungs unstyled), 4 duplicates |
| B2 | State label | — | missing (4 vocabularies) |
| B3 | Session row | `buildSessionItem` | exists, 2 near-duplicates |
| B4 | Action button | `.session-*-btn`, `.icon-btn`, `.control-btn`, … | exists in ≥6 styles |
| B5 | Confirmation dialog | `showChoiceDialog` | exists, used once |
| B6 | Chooser dialog | — | missing |
| B7 | Form dialog | `.new-session-overlay` family | exists, no dialog semantics |
| B8 | Notice | `app-notices.js` | exists, shared error/info/Undo notices; restore/update remain separate |
| B9 | Inline error | `.agents-detail-error`, `.dwt-error`, dialog error lines | exists, ad hoc |
| B10 | Section header (foldable) | `.agents-group-header`, `.slug-group-header`, project header | exists, two behaviours |
| B11 | Empty state | `.plans-empty` and others | exists, ad hoc, mixed with errors |
| B12 | Progress indicator | 6+ spinners | exists, many |
| B13 | Toggle button | filter toggles, `setHeaderToggle`, grid toggle | exists, two semantics |
| B14 | Popover menu | `.popover` + `.popover-option` | exists, consistent |
| B15 | Badge | `.bg-badge`, `.remote-badge`, `.terminal-badge`, Changes letter badge, `Sandbox` chip | exists, per use |

---

## B1. State mark

- **Job.** Show one session's state at a glance.
- **Anatomy.** A 6 px slot; one rung per `ICON_BY_RUNG`
  (`public/session-state.js:7-16`); `title` = the rung's title.
- **Variants.** attention (orange LED, `style.css:1318-1328`), response-ready
  (cyan glow, `1297-1316`), busy (blue braille spinner, `1025-1054`),
  agents-busy (violet `⠿`, `1072-1090`), waiting, idle, stale, archived
  (**no CSS**: default dot), plus the `.running` modifier (green: a PTY of
  the row is open here, `sidebar.js:1694`).
- **Merged rows.** The sidebar slot is painted from the OR of the members'
  snapshots (`session-activity-dom.js:27-36, 116-123`).
- **Behaviour.** Not interactive. No text companion on the slot itself.
- **Tokens.** Mostly literals (`#4fc3f7`, `#f0a050`, `#3ecf5a`); only the
  agents-busy glyph and the violet busy spinner use `var(--accent)`
  (`style.css:1080`, `1091`).
- **Used.** Sidebar row (`sidebar.js:1693-1697`), subagent row
  (`sidebar.js:340` `buildSubagentItem`), Agents row (`agents-view.js:224`,
  via `agentRowIcon` `140-149`).
- **Duplicates.** `.grid-card-dot` (`grid-view.js:178-180`, painted at
  `app.js:1197-1201`); terminal header dot (`app.js:1215`); `.slug-group-dot`
  (`sidebar.js:545`, `app.js:1186-1190`); the Agents emoji
  (`agents-view.js:227`).
- **Divergences.** JS glyph `◆` vs CSS `⠿` for agents-busy
  (`session-state.js:11` vs `style.css:1078-1086`).

**Proposed convergence.** CSS for every rung; `--state-*` tokens; the grid
card and terminal header dots rendered by `renderSessionIcon`; a non-colour
cue (shape or B2 text) for every rung that asks for action; static marks
under reduced motion.

## B2. State label (missing)

- **Job.** The same state in words, one vocabulary.
- **Today, four vocabularies.** Rung titles (`session-state.js:8-15`); raw
  CLI status (`sidebar.js:1721-1727`, `agents-view.js:218, 227`); job states
  `AGENT_STATE_META` (`agents-view.js:46-54`); PTY status
  `terminalStatusLabel` / `processExitLabel` (`process-exit.js:18-28`) and
  the grid footer (`app.js:1203`).
- **Anatomy (proposed).** Title-case word from one table owned by the
  glossary, optionally followed by a reason (`· permission prompt`) and an
  age.

**Proposed convergence.** One table; B1's `title` and every visible state
word read from it; raw CLI words move to tooltips/detail.

## B3. Session row

- **Job.** One sidebar entry for a session (or a merged set of transcripts).
- **Anatomy, in order** (`buildSessionItem`, `sidebar.js:1655-1827`): pin
  (`1686-1690`) · B1 (`1693-1697`) · info: badges (B15: remote alias
  `1730-1740`, `bg` `1742-1749`, terminal `1751-1756`) + name, then meta line
  (`time · N msgs`, short id, status, `1710-1728`) · action bar (B4 ×≤8,
  `1760-1818`).
- **Variants.** local, plain terminal (`is-terminal`), remote (alias badge,
  transcript fallback), background (`bg`), subagent (`buildSubagentItem`,
  `sidebar.js:340`), placeholder (no transcript button, `1813`), archived
  (`archived-item`, opacity 0.55), missing project (`.disabled` + reason,
  `1416-1421`), merged (`data-merged-member-ids`, `1663`; no visible mark).
- **States.** active (open tab), `has-running-pty`, `is-alive`,
  `needs-attention`, `response-ready`, `cli-busy`, `has-busy-agents`.
- **Behaviour.** Click (`1431-1439`), dblclick name to rename (`1460-1463`),
  right-click menu (`1444-1448`, B14). The row is not focusable; its action
  buttons are tabbable. The action bar appears on hover or when a button has
  keyboard focus (`:focus-visible`) (`style.css`, `.session-actions:has(:focus-visible)`).
- **Tokens.** `--surface-chrome` for the action-bar fade (`style.css:1171`);
  the rest literal.
- **Duplicates.** Agents row (`renderAgentRow`, `agents-view.js:213-231`)
  and grid card header (`grid-view.js:176-200`) re-implement the
  name/state/project triple.
- **Rendering.** Rebuilt whole on every `projects-changed` (#543, open), SVG
  buttons via `innerHTML` per row (`sidebar.js:1764-1806`).

**Proposed convergence.** One row built from a cloned `<template>`;
focusable with roving `tabindex`, Enter opens; a merged-row mark (member
count) in the meta line; Agents rows and grid headers reuse its
name/state/project part.

## B4. Action button

- **Job.** Trigger one verb on one object.
- **Variants in use.**
  | Style | Where | Notes |
  |---|---|---|
  | row action icon (`.session-stop-btn`, `-archive-`, `-fork-`, `-jsonl-`, `-bridge-`, `-delete-`, `-launch-config-`, `-send-`) | `sidebar.js:1764-1806`, CSS `style.css:1181-1290` | `title` only, no `aria-label`; destructive ones red on hover |
  | `.icon-btn` | tool bar (`header-controls.js:45`), file panel, choice-dialog close; shares CSS with the filter toggles (`style.css:2132-2160`) | |
  | `.control-btn` / `.fp-toolbar-btn` | Agents verbs (`agents-view.js:320`), file panel | text, `transition: all` (`style.css:2189-2215`) |
  | `.new-session-start-btn` / `.new-session-cancel-btn` | dialogs, choice dialog | primary / secondary |
  | `.delete-worktree-confirm-btn` | delete dialogs, choice dialog `danger` | danger |
  | header buttons (no class) | `index.html:111-112` | `aria-label` set |
  | `.grid-card-stop-btn` | `grid-view.js:190-199` | 10 px square |
  | `.restore-toast-btn` | toasts (`app.js:421-422, 466`) | no CSS rule of its own |
- **Availability.** Hidden in hover bars and headers; disabled in the Agents
  panel and tool bar, with or without a reason (UI-PATTERNS §2.4).
- **Failure feedback.** Row Stop/Detach, Delete and Archive use persistent B8
  notices through `showSessionActionFailure`; pointer leave and sidebar refresh
  retain the error. `flashButtonText` remains available for other callers.

**Proposed convergence.** One button brick, variants `icon`, `text`,
`primary`, `danger`, `toggle` (B13); every icon button has `aria-label`; a
disabled one has `title` = why + what to do; failure goes to B9/B8, not into
the button.

## B5. Confirmation dialog

- **Job.** Ask before an action that cannot be undone (or has a cost).
- **Exists.** `showChoiceDialog` (`choice-dialog.js:15-135`).
- **Anatomy.** Header (title + `×` close, `37-47`); body: message lines
  (`49-56`), optional checkboxes with remembered values (`57-71`); actions:
  Cancel + verb-labelled confirm (`73-83`).
- **Variants.** `danger` (red confirm, `81`); `initialFocus` confirm|cancel.
- **Behaviour.** `role="dialog"`, `aria-modal`, `aria-labelledby` (`32-34`);
  Tab trapped (`111-117`); Escape cancels, Enter accepts (`106-123`);
  overlay click cancels (`129`); focus returned (`93`); one at a time (`25`).
- **Used.** Folder Archive only (`sidebar.js:1190`).
- **Duplicates.** 17 `window.confirm` calls (UI-PATTERNS §4);
  `showDeleteSessionDialog` (`sidebar.js:1881-1945`) and
  `showDeleteWorktreeDialog` (`1949-2017`), which add a live status/preview
  area B5 does not have.
- **Borrowed classes.** `whats-new-header`, `whats-new-body`,
  `new-session-actions`, `new-session-*-btn`, `delete-worktree-confirm-btn`
  (`choice-dialog.js:38, 50, 74, 77, 81`).

**Proposed convergence.** Add an optional async status area (the two delete
dialogs' preview) and default focus on Cancel for `danger`; migrate the
destructive `confirm` calls and the two delete dialogs onto it; give it its
own class names.

## B6. Chooser dialog (missing)

- **Job.** Pick one of N (continuation candidates; live-elsewhere
  resolution).
- **Today.** A loop of `confirm` calls (`resume-guard.js:67-72`), raw UUIDs.
- **Anatomy (proposed).** B5 shell; a list of candidates (title, last
  activity, where it runs), one preselected, Cancel + `Open`.

## B7. Form dialog

- **Job.** Collect parameters for a launch or an edit.
- **Exists.** `.new-session-overlay` + `.new-session-dialog`
  (`dialogs.js:180, 334, 425, 555, 717`) and `.add-project-overlay`
  (`dialogs.js:624`, `file-panel.js:642`).
- **Anatomy.** `h3` title, fields, error line (`dialogs.js:647-665`,
  `803-875`), actions row (`new-session-actions`).
- **Behaviour.** Escape via a document `keydown` listener (`dialogs.js:314,
  415, 546, 614, 684, 892`); overlay click closes; **no** `role="dialog"`,
  initial focus, focus trap or return focus.
- **Divergences.** The Send prompt dialog says `Close` (`dialogs.js:573`);
  others `Cancel`. Additional Directories is comma-separated in three
  dialogs and one-per-line in New agent (CONCEPT-MAP m4).

**Proposed convergence.** B5's shell (semantics, focus, Escape, return
focus) with a form body.

## B8. Notice

- **Job.** Tell the user something happened that is not tied to a control.
- **Exists.** `public/app-notices.js`, loaded before `sidebar.js`.
  `showAppNotice({ id, kind, message, actionLabel, onAction, dismissOnAction, members, mergeMembers })` adds a notice;
  `clearAppNotice(id)` removes it and cancels its timeout. Reusing an id
  updates only that notice in its existing stack position, retains its original
  return focus and cancels its previous timeout.
- **Anatomy.** Plain-text message, optional text action button, and `Dismiss`.
  A fixed `#app-notices` container stacks notices at the bottom right with
  wrapping text and scrolls when they exceed the available height.
  It is an empty, persistent `aria-live="polite"` region in `index.html`.
  Caller ids are stored in `data-notice-id`, without assigning a DOM id.
- **Variants.** `kind: 'error'` has `role="alert"` and remains until dismissed,
  acted on or cleared. `kind: 'info'` (the default) has `role="status"` and
  expires after 15 s. `kind: 'undo'` has `role="status"` and expires after
  10 s; the caller supplies `actionLabel: 'Undo'`, `onAction` and a message
  explaining what happened, so the button is not the only cue.
- **Behaviour.** Buttons are native keyboard-reachable buttons with the
  shared focus ring; showing a notice does not move focus. An action normally
  removes its notice and invokes its callback once. With `dismissOnAction: false`,
  a Retry retains the error through a cancelled confirmation; the successful
  operation clears it. The caller owns asynchronous
  action results and can report a failure with a new error notice.
  Info and Undo timeouts pause while hovered or focused and resume with the
  remaining time after both leave. Pointer presses preserve existing focus;
  removing a focused notice returns focus to the previously focused control
  if it is still connected.
- **Used.** `announceNotStopped` in `public/sidebar.js` reports an archived
  remote session that could not be stopped as a persistent error (#604/#566).
- **Action failures (#566).** `showSessionActionFailure(operation, session,
  error, recovery, onRetry, { headline, kind })` includes the object/location, reason and available
  next step. `sessionActionNoticeId` keys Stop/Detach, Delete, Archive, folder
  Archive, background handoff/attachment and Restore independently. A successful
  retry clears only that operation's notice. External-session recovery names
  its own terminal/location, without an unsupported Stop/Close instruction.
- **Partial results and groups.** Archived, but not stopped groups affected
  sessions once per host. Restore refusals and missing transcripts group once
  per restore group. Group callers provide `members: [{ id, text }]`,
  `mergeMembers: true` and a `message` function of the current members. Later
  batches merge by member id, updating repeated members. Clearing a member's
  operation id removes its direct notice and its membership in every group,
  retaining other members and removing empty groups. Folder partial success says Archive folder partly done
  and names Agent Files for schedule-*.md. Waiting for indexing and a handoff
  in progress use informational status, without a failure headline; only
  automatic indexing retries enter the pending group, which indexing completion
  clears. Holds requiring a sidebar choice remain persistent errors.
- **Remaining separate.** `.restore-toast` retains restore consent, cold-cache
  indexing progress and informational handoff success; `#update-toast` is unchanged.
  Agents/settings failures and remaining information dialogs are later slices.
  Archive and Detach Undo wiring
  belongs to their own slices; S3 provides the shared variant.

## B9. Inline error

- **Job.** A failure next to the thing that failed, kept until the next
  attempt.
- **Exists.** `.agents-detail-error` (`agents-view.js:349`); `.dwt-error`
  (`sidebar.js:1985, 1999`); dialog error lines (`dialogs.js:647-665,
  803-875`).
- **Duplicate to absorb.** `.plans-empty` used for errors
  (`jsonl-viewer.js:758, 846`).

## B10. Section header (foldable)

- **Job.** Title a group and fold it.
- **Model.** `.agents-group-header` / `.agents-subgroup-header`
  (`agents-view.js:266-271`): chevron, optional emoji, label, count;
  `role="button"`, `tabindex="0"`, `aria-expanded`; Enter/Space (`570-576`);
  collapse persisted.
- **Duplicates.** Sidebar `.slug-group-header` (`sidebar.js:525-545`,
  click only, `1382-1386`); project and worktree headers (click only,
  `1311-1314`, `1353-1356`), with their own action buttons.

**Proposed convergence.** Sidebar headers adopt the Agents header's
semantics; their action buttons become B4.

## B11. Empty state

- **Job.** Say why a list is empty and what to do next.
- **Instances.** `index.html:54`; `index.html:46`; `agents-view.js:376,
  382`; `stats-view.js:32`; `jsonl-viewer.js:789, 879`;
  `memory-workfiles-view.js:41, 235`; `activity-trace-panel.js:153`;
  `file-panel.js:1505`; `touched-files-view.js:387`.
- **Divergences.** Shared `.plans-empty` class across unrelated views and for
  errors; the Agents one ignores the Finished filter (`agents-view.js:374-376`).

**Proposed convergence.** One brick with `reason` (nothing yet / hidden by a
filter, with a "show" action) and `next action`; errors use B9.

## B12. Progress indicator

- **Instances.** Braille busy spinner (`style.css:1032-1054`), `spin-dot`
  (`504`), `stats-spin` (`2629`), `usage-spin` (`2731`), `spin-schedule`
  (`3388`), `loading-pulse` (`346-352`), text `Checking … …`
  (`sidebar.js:1901, 1967`), `Updating… N%` (`app.js:1966`).

**Proposed convergence.** One spinner animating `transform` only, paused
under `prefers-reduced-motion`; text progress where a percentage exists.

## B13. Toggle button

- **Instances.** Filter toggles (`index.html:25-28`) with `.active` only
  (`app.js:822-838`); tool toggles via `setHeaderToggle`
  (`header-controls.js:62-67`, `.active` + `aria-pressed`); grid
  `Group by project` (`index.html:120`, `aria-pressed`); search `Tt`
  (`index.html:37`).

**Proposed convergence.** Every toggle sets `aria-pressed` through one
helper (`setHeaderToggle` already does it).

## B14. Popover menu

- **Instances.** `.popover` + `.popover-option` (`style.css:4522-4560`):
  session context menu (`sidebar.js:1620-1644`, `role="menu"`/`menuitem`,
  Escape, outside click, edge clamping), terminal context menu, new-session
  popover. Consistent; disabled items carry a reason (`sidebar.js:1631`).
- **Gap.** No arrow-key navigation between items (supposed: no key handler
  other than Escape in `sidebar.js:1616-1618`).

## B15. Badge

- **Instances.** `.remote-badge` (alias text, `sidebar.js:1730-1740`),
  `.bg-badge` (`bg`, `1742-1749`), `.terminal-badge` (icon, `1751-1756`),
  Changes state letter (`.ai/contexts/changes-view.md:859`), `Sandbox` chip
  (`index.html:113`), Diff `data-badge="pending"` (`tool-bar.js:77`).
- **Note.** The Changes letter badge is the model: a letter that carries the
  meaning without colour, with the full name in the tooltip.

**Proposed convergence.** The liveness/location axis (here, background,
remote, elsewhere) and the merged-row member count use B15, not state colour.

---

## Missing bricks, in order of user impact

1. **B2 state label** — one vocabulary for the state the four surfaces show.
2. **B6 chooser** — replaces the continuation `confirm` loop.
3. **A Detach control** — a B4 variant (neutral, eject icon, no confirm)
   distinct from Stop; today Detach borrows Stop's red square
   (`index.html:112`, `app.js:1457`).
