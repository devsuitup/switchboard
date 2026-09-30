# Subagents

A subagent is a child Claude that a session starts with its `Agent` tool. It
has its own transcript, runs to completion, and cannot be resumed. Switchboard
indexes subagent transcripts and shows them under the session that started
them.

## In the sidebar

A session with subagents has a **▶ N subagents** caret; the choice to expand it
is remembered per session. Under it, each subagent row shows:

- a pill with the subagent's type (`sub` when the type is unknown), and a left
  border in the type's colour (`explore` green, `plan` indigo, `implement`
  orange, `review` light blue, `test` red, any other type grey — the type name
  is compared case-insensitively);
- its status icon ([below](#live-status));
- its description, or its summary;
- its message count.

The first 10 subagents of a session are listed, then `+ N more`.

A subagent follows its parent's archive state without being archived itself:
while the parent is archived its subagents are hidden with it, **Show archived
sessions** shows them nested under the archived parent, and unarchiving the
parent brings them back.

Subagents whose parent session cannot be found — its transcript was deleted,
say — are listed in an **Orphan subagents** group at the bottom of the project,
collapsed by default. A subagent of an archived parent is never an orphan.

Subagent rows have no pin, rename, stop, fork, archive or delete buttons.
Deleting a session deletes its subagent transcripts with it — see
[Session browser](session-browser.md#delete).

## Search

The Sessions tab's [search](session-browser.md#search) covers subagent
transcripts. A session whose only match is in one of its subagents is listed,
with that subagent.

## Transcript viewer

Clicking a subagent row opens its transcript, read-only, in the transcript
viewer: messages, tool calls and results. It does not run `claude --resume`. A
**Resume in terminal anyway** button at the top resumes it for the rare case
where that is wanted.

## Live status

The session's own status icon has three shapes for "something is running",
distinguished by movement and hue:

| Icon | Meaning |
|---|---|
| Light-blue braille spinner | The session is working; no subagent runs under it |
| The same spinner, violet | The session is working, and at least one subagent runs under it |
| Static violet ⠿ | The session is at its prompt; subagents still run under it |

The violet spinner says the session is busy while agents run. It does not say
the session is waiting for them: the CLI reports one busy state on its terminal
title and never signals "waiting for background agents", so the two cannot be
told apart. The session's higher-priority states — needs attention, response
ready — replace the icon (see [Status indicators](notifications.md)). The three
shapes show whether the subagent list is expanded or not.

Subagent activity is detected from the subagent transcripts on disk — for local
sessions, for sessions started outside Switchboard, and for sessions on remote
hosts. A subagent whose transcript stops growing is marked finished after a
stability window; one that grows again is shown running again.

The [grid](grid-overview.md) shows running subagents as coloured pills on the
parent's card.
