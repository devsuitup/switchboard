# Renderer modal stack and questions

## UI notice history (#1196)

`preload.logUiNotice` sends `ui-notice-log` without waiting for a reply.
`src/main/app/ui-notice-log.js` owns the main-process listener; main only
composes it with electron-log and the current window and disposes it on quit.
Only that window's main frame is accepted. Missing, throwing or rejected APIs
never prevent showing, answering or dismissing UI.

`app-notices.js` reports `show`, `dismiss`, `replace` and `merge`, including the
in-place main-process error group update (IDs and counts only on merge). Each
replacement or merge writes one event, without an additional `show`. `show` records the rendered message,
the notice ID, info/warning/error severity and an explicit source or ID prefix.
Undo notices use info. Legacy restore toasts and updater notices/status use the
same channel. Dismissals carry `user`, `expired`, `cleared`, or `action:<label>`
for an action button. Restore and Restart in transient toasts report a separate
`action` event in the capture handler, before their action runs. The visible
notice stays tracked until hidden or removed, when `dismiss` records its reason.
Restart can return without installing; a subsequent Dismiss or Later therefore
still reports the real dismissal. Restart does not otherwise remove its toast before installation.
Dismiss and Later still report `user`. Main bounds action reasons to 256 characters
and redacts credentials in them. Updater percentage
changes stay visible but are not logged; start, completion and failures are logged,
with severity supplied by the caller. The existing `[restore-bg]` diagnostic remains unchanged.

`observeModalQuestion` in `modal-stack.js` records the title, displayed text and
offered labels at mount, then the actual answer or `cancel`. It is used by
choice-dialog (appConfirm, appChoose, appAlert and direct showChoiceDialog),
session/worktree deletion and the unsaved Save/Discard/Cancel question. Queued
questions log only when mounted. Dynamic checkbox labels and checked states
are recorded on acceptance; opaque preview plans and tokens are not serialized.
Configuration forms and informational modals are not question helpers.

Session labels are marked explicitly; no text search or substring replacement is
allowed. Question callers pass `sessions` and `messageParts` (paragraphs of literal
strings and `{ session, label }` segments), or `titleParts`. Radio options carry
`session`; dynamic checkbox labels use `labelParts(checked)`. The shared
`renderSessionText(element, parts)` helper renders labels as literal text inside
`span[data-log-session="<8-hex id>"]`; invalid/missing IDs use `00000000`.
The displayed label remains unchanged, including short names, commands, URLs,
multiline prompts and labels containing paths. Direct dialogs use the same helper.

`observeModalQuestion` replaces marked labels with their IDs in a detached clone
before reading title, dialog ID, text and choices. Answers use the selected DOM
controls and the same cloning rule, including current checkbox labels/states.
Block separators remain in the clone so adjacent paragraphs never concatenate.
Ordinary prose and project paths outside the marked segments are untouched.

String notices supply `logText`, built by the caller with the session ID instead
of each label, and `logId` if their visible ID includes a label. `showAppNotice`
accepts a `logText(members)` function for merged groups; it is recomputed from
the current members on every event. `showRestoreNotice(id, text, session,
{ logText, logId })` forwards those fields to the transient observer, including
dismissal. Session action descriptions accept `{ log: true }` for the safe form.

`sessions` declares only labels actually rendered, not all rows involved in an
operation. Session-exit derives it from its marked row parts, excluding plain
terminals and untitled conversations while marking panel owners. Multi-part
stop plans contain part IDs rather than row labels; their `sessions` is empty.
Archive confirmations derive their text and identities from `messageParts`.
Archive-folder keeps the shared identity array in sync with its checkbox label:
only the first five displayed running rows when checked, none when unchecked.
Archived-manager failure paragraphs mark each session label, and single-session
restore notices supply the short ID in `logText` for both show and dismissal.
Project action descriptions without a session ID retain their visible wording.
Resume settings mark their title with `renderSessionText`; this configuration
form remains outside question logging.

Every session whose label is displayed must be passed in `sessions` (or on notice
members). Without explicit `logText`, if any supplied session lacks a DOM marker,
`sessionNoticeLog` emits only event metadata, a source/ID-derived identity,
`sessions: [<8-hex ids>]` and `unmarked: true`. It omits text, title and choices,
including the selected answer; main preserves those omissions. This fail-closed
event makes missed migrations visible without guessing at labels. An unmarked
caller's original ID is also discarded because it may contain the label.

Main writes single-line JSON with a `[ui-notice]` prefix at info level, independent
of Debug Mode. Each field is cut to its cap plus 128 characters before redaction
through `shared/redact-log-text.js`, then
capped: ID 160, source 80, text 4096, title 256, answer 1024 characters, and at
most 20 choice labels of 256 characters. Paths are preserved; bearer credentials,
credential variable names, authorization and cookie values, JWTs,
provider token prefixes, URL passwords and credential query parameters
are masked. Authorization accepts `:` and `=`, retaining Basic/Bearer/Token
and masking only the following value. Unknown Authorization schemes mask the
whole line value, or the quoted value, including Digest and AWS4 credentials.
Cookie/Set-Cookie scans semicolon-separated assignments and preserves trailing
prose and bare attributes; without an assignment it masks the field value.
Credential suffixes also cover lowercase compounds (`clientsecret`, `apitoken`)
and camel boundaries (`accessToken`, `clientSecret`). Only `pass` requires a
whole key or underscore/hyphen delimiter. `secretKey` and `passwordHash` are masked
conservatively; `bypass` and `compass` remain ordinary keys. AWS
`X-Amz-Signature`/`X-Amz-Credential`, equals/space-separated
`--token`/`--api-key`/`--password`/`--auth-token`, and
passwords in any `scheme://user:password@host` URL are covered. Usernames and
hosts are retained. `sk-` tokens allow up to three hyphenated ASCII alphanumeric
prefix segments, followed by at least 20 ASCII letters/digits/underscores including
a digit, covering proj, ant, svcacct, admin, None and or-v1. Kebab names such as
`sk-learn-experiments-2024` are preserved. Key scans exclude POSIX separators at
their left boundary, but accept backslashes so literal escape sequences do not
hide credentials. Windows credential-like path segments are conservatively masked.
Quoted values, including ones truncated before a closing quote, are masked as
values; subsequent lines stay intact. Key and URL scans guard their left token
boundary to prevent rescanning long suffixes, and cookie/value scans advance
monotonically with sticky expressions. The 100 KiB adversarial tests exercise
long identifiers, scheme-like strings, quotes and header-like prose.
No main.log redaction helper existed at this revision: this shared
helper protects the new channel, and does not claim to sanitize other log writers.

Identical consecutive normalized events are counted as additional occurrences
(`repeated N×`) when the run changes or once per minute, without repeating the
original text. Identity survives window rollover and resets after 60 seconds
without an event. A rate-limited event clears the consecutive identity: its
following copies count toward suppression rather than repeating a different
last emitted line. Event/repeat writes are limited to 20 per second, 60 per minute
and 64 KiB per minute, plus one small suppression-count summary per minute.
A further 256 KiB per hour covers every `[ui-notice]` line, including repeat and
suppression summaries (UTF-8 prefix, payload and newline; electron-log's transport
timestamp/level formatting is additional). Named constants in `ui-notice-log.js`
define all time/write/byte limits. The hour begins at installation and resets
when a write next observes that an hour has elapsed. A 256-byte reserve allows
one `hourly byte limit reached` line when dropping begins and a final dropped-count
summary on disposal; even smaller notices
are then dropped until rollover. Minute flushes stay silent during that period.
The next write after rollover first reports `resumed after hourly byte limit;
dropped N notices`, charging that summary to the new hour. Repeats count as their
number of occurrences, not one summary. Per-minute drops already summarized
before the hourly limit are not counted again in the hourly total. Disposal
flushes pending counts and, if still hour-limited, writes `disposed after hourly
byte limit; dropped N notices` once from the reserve.
These bounds also cover alternating IDs and large payloads. The fixed deadline
is not extended by new events. Its timer is unreferenced, cleared on disposal, and pending counts flush
on graceful quit. Abrupt termination can lose the final partial window.

Project deletion uses `showChoiceDialog` with `onChange`, `planDetails` and
`planUnavailable`. Details are literal text, applied only after request sequence
and current-answer matching. A reason keeps Confirm disabled while preserving
the inspectable plan. Checkbox `disabled/disabledReason` forces remembered true
to unchecked without writing storage; acceptance remembers only enabled choices.
Cancel, close and timeout never persist. Disconnected openers return focus to
the surviving sidebar. Existing callers without these options keep their queue.

`public/modal-stack.js` loads before every renderer consumer. It owns the modal stack and the only modal `keydown` listener, installed on `document` in capture phase. Each modal calls `registerModal({ overlay, cancel, enter, bodyEnter })` after mounting and calls the returned unregister function on every close path. The stack's last registration owns the keys; neither DOM class order nor the current event target chooses another modal.

Registered surfaces are the choice dialog (including `appConfirm` and `appAlert`), New Session, Resume, remote launch, Send a prompt, Add Project, dispatch-agent, schedule creation, the unsaved-edits guard, session/worktree deletion, Touched info, What's new, and fullscreen transcript images. The New session popover is a menu and retains its own arrow-key navigation.

The B6 chooser uses `appChoose({ title, message, options, selectedId, confirmLabel })` from `public/app-dialogs.js`. It shares the question queue, focuses Open initially, and returns `{ choice: id }` on acceptance or `null` on cancellation. The adapter defaults the title to Choose and the action to Open, and splits string messages into lines. Manual continuation opens use it for one part chooser. The resolved choice is remembered per row as a `continuationChoice:<rowKey>` setting, and the row menu's **Choose part to open…** asks again (see [cli-session-state](cli-session-state.md)).

`openChoiceDialog` accepts `options` alongside its existing checkbox `choices`. Each option has `{ id, label, detail?, disabled?, disabledReason? }`; labels, details and reasons are literal text. Options render as native same-name radios inside a labelled radiogroup. Each radio's label supplies its accessible name; a non-empty detail and disabled reason form a separate description linked by `aria-describedby` to a unique id. `selectedId` preselects an enabled option; an absent, missing or disabled selection falls back to the first enabled option. Disabled options show their reason and cannot be accepted. If no option is enabled, Open is disabled and container Enter does nothing. Acceptance reads the currently checked enabled radio, independently of checkbox answers.

Tab treats each named radio group (within the same form) as one stop: its checked enabled visible radio, or its first enabled visible radio when none is checked (last when entering with Shift+Tab). A focused radio omitted from this stop list exits from its group's position in either direction. Unnamed radios remain separate stops. From the chooser's checked radio, Tab reaches Cancel and Shift+Tab returns to the checked radio. Arrow keys keep Chromium's native radio navigation; jsdom tests verify that the router leaves their default behavior available, without simulating Chromium's selection behavior.

Escape cancels only the top modal from anywhere, including the body and a terminal underneath. Tab and Shift+Tab cycle through that modal's enabled, visible controls; hidden controls and descendants of hidden or inert containers are excluded. A modal without controls focuses its overlay. The router stops Enter, Escape and Tab with `stopImmediatePropagation` at document capture: handlers inside the modal and document-bubble handlers do not receive them. Only window-capture listeners see those keys before the router. A focused button activates once, with default activation prevented. Each modal may supply its own Enter action. A default-prevented Enter remains consumed without an action.

Choice questions keep the existing rules: Enter on a checkbox does nothing, and Enter on the container accepts an ordinary question. A dangerous question requires a focused button; container, body, or outside Enter cannot accept it. New Session retains #586: the selected permission mode receives initial focus, Enter on a mode or checkbox starts, Cancel cancels, and Enter in a text input does not start. Its body Enter also starts when it is the top modal. Resume opens with its selected permission mode focused, and Enter on that mode resumes with the selection. Resume, Add Project and dispatch retain their body Enter actions through the same router's explicit `bodyEnter` option. Enter in Add Project's path submits; remote launch initially focuses its path, where Enter validates and starts; Send a prompt uses Ctrl/Cmd+Enter. Other text-field keys retain their normal browser behavior inside the top modal. Keys outside the top modal have propagation blocked, but only Enter, Escape, Tab and matching configurable or fixed app shortcuts have their defaults prevented. Other keys keep their native defaults, including Electron menu accelerators for DevTools, Undo and Select All.

`hasOpenModal()` suppresses `app.js`'s `handleGlobalShortcut` and the xterm custom key handler before tool/session-navigation/search/fullscreen/newline shortcuts, including direct handler calls when focus drifts underneath a modal. Registration records the current opener and moves focus into the dialog (with `tabIndex=-1`) when it is outside the overlay. Dialogs register before focusing their initial control. A document-capture `focusin` listener returns outside focus to the top modal’s last focused connected control, or its dialog when that control is gone. Fullscreen transitions and single-view `showSession` skip terminal focus while a modal is open. Document-capture listeners cancel terminal-textarea `paste`, `beforeinput` and `input` events, including non-cancelable input propagation, while leaving modal fields editable. The xterm `onData` route stays active: terminal protocol replies such as DA, cursor-position reports, DECRQM and OSC colour replies must reach the PTY even for background terminals and panel shells while a modal is open. Unregistering returns focus to the remaining top modal, or restores the last modal’s connected opener. A missing opener, body opener or disabled opener falls back to the active session’s terminal. Unregister is idempotent, so restoration happens once. Dialogs with their own explicit restoration register with `restoreFocus: false`: choice questions, the unsaved guard, New Session, Touched info and fullscreen screenshots retain their existing opener and fallback behavior without a second restoration from the stack. Closing the last modal enables keyboard paths again.

Checkbox choices may supply `label(checked)`, and `danger` may be a function
of the current checkbox answers. Both are evaluated after remembered values
are restored and on each checkbox change. The resolved danger state also
governs container Enter. Folder Archive uses these to name stopped sessions
and require a focused button when the checked sessions include live targets.

`showChoiceDialog` optionally accepts `onChange(answers)`, a read-only async plan
hook. It runs when the dialog actually opens, after remembered checkbox values
and the initial radio selection are restored, and on each checkbox/radio change.
The argument is a frozen snapshot of checkbox booleans and, for radio dialogs,
`choice: selectedId` when an enabled option is selected. The hook must only
compute a preview, with no destructive effects. Its resolved value is an opaque
plan (for example `{ token, details }`); primary acceptance returns
`{ ...answers, plan }`. Choice ids must not use the reserved `plan` or `choice`
keys. Project deletion uses this hook for its matching preview token and full details.
When the hook is set, a reserved checkbox id rejects the opening promise before
mounting or registering a modal. Dynamic labels and danger are also evaluated
before mounting, so an initialization failure leaves no visible or registered
modal; only the first plan refresh waits until registration is complete.

Each request immediately discards the previous plan and disables Confirm,
including synthetic click and container Enter acceptance. Only the newest
request whose snapshot still matches the live answers can install its plan.
Returning to earlier answers still requires a new response. Acceptance rechecks
the snapshot, so changing a control programmatically without its `change` event
cannot accept a mismatched plan; dispatch `change` to refresh it. Cancellation,
replacement and other closure paths make late responses inert. Requests are
ignored rather than aborted, so the hook owns any external request cleanup.
The dialog bounds each preview wait to 15 seconds unless `planWaitManaged: true`
delegates the deadline to the hook. Project deletion uses that option because
its hook already has a 21-second watchdog around the 20-second main request.
A timeout leaves Confirm
disabled with an inline recovery message; a later response from that request
cannot install a plan. Changing an answer requests a fresh preview with a new
deadline. The deadline timer is cleared on settlement, choice changes and every
close path. This bounds the dialog wait, not the lifetime of the external work.
While the current request is outstanding, a literal `role=status` message says
“Preparing preview…” and the dialog has `aria-busy=true`. Settlement hides the
status and clears the busy state; obsolete responses cannot clear a newer wait.

A synchronous throw or rejected refresh shows its message as literal inline
`role=alert` text, leaves Confirm disabled and keeps Cancel available. Changing
an answer clears the error and retries. The inline Retry preview button also
requests a fresh plan for the current answers, without closing the dialog or
persisting choices. It hides while pending and after success; Enter on the
focused retry button activates it. It reuses `new-session-cancel-btn` so its
appearance follows the existing secondary dialog buttons. During initial planning, focus falls
back to visible Cancel when Confirm would otherwise receive focus. All-disabled
radio options stay unconfirmable even after a plan resolves. Secondary actions
and `closeWith` retain their explicit independent result contracts; the hook
gates primary acceptance only. Without `onChange`, result shapes, remembered
answers, focus, dynamic labels/danger, queueing and cancellation are unchanged.

## Question queue and the unsaved guard

`fallbackFocus: () => element` opts into focus recovery when `returnFocus` is
gone. Project deletion uses the sidebar container. Other choice-dialog callers
keep their existing focus behavior without this option.

`showChoiceDialog({ replace: true })` is the one way to jump the queue: it cancels the open choice dialog (resolving it as Cancel) and enqueues its question at the front (`enqueueModalQuestion(open, { front: true })`). `closeWith`, a promise, closes the dialog with the value it resolves to; both paths close through the same function that unregisters from the modal stack. The window-close question (#478, [window-frame](window-frame.md), "Closing the window") uses both.

Use async `appConfirm({ title, message, confirmLabel, danger })` and `appAlert({ title, message })` from `public/app-dialogs.js`. They adapt `showChoiceDialog`, which shares `enqueueModalQuestion` with session/worktree deletion and the Save/Discard/Cancel guard. Busy questions stay pending rather than resolving as Cancel. Regular questions use FIFO order; only one queued question is mounted at a time. A question may sit on top of a configuration modal.

The quit/close/reload guard ACKs immediately, then enqueues an idle question rather than waiting on an idle snapshot and opening separately. Idle questions yield to regular questions and wait only for the question queue to settle. Configuration and informational modals do not delay the guard: it registers last and opens on top of them. A zero-delay task checks question idleness after the current promise reactions, allowing the next regular question to enter the queue first. The continuation chooser is one regular question; the unsaved guard waits until it closes. Buffers are recollected when the guard actually opens. The guard holds the question queue during saving; an alert requested meanwhile opens after the guard closes. Save failures stay inline. Save receives initial focus, Enter really saves, Escape cancels, and Tab/Shift+Tab are handled by the shared router. Disabled controls cannot act during an in-flight save. The beforeunload veto and main-process protocol are unchanged.

Every decision caller awaits its answer before performing its side effect. Changes and Touched discard paths remain async. `returnToPanelList()` returns a boolean for an immediate transition or a promise while a discard decision is pending; the diff's Escape listener consumes only a return that already succeeded. Destructive confirmations and the live-elsewhere warning focus Cancel; the continuation chooser focuses Open, and lookup-failure or unknown-target questions focus Open as it was. `liveElsewhereQuestion` supplies the whole Resume anyway question to `appConfirm`, including for scheduled tasks, naming the schedule when known. A background session without a job id is refused with an error notice; `guardResume` defaults `notify` to `showAppNotice` in the renderer and requires an injected adapter elsewhere.

Native `confirm`, `alert`, and `prompt` (bare or on `window`, `globalThis`, or `self`) remain forbidden by ESLint throughout `public/**`. The property rule matches named objects and cannot express nested `document.defaultView`; that spelling is not covered. Main-process Electron dialogs remain outside this renderer rule.
