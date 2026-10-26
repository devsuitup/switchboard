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

The parent conversation shows `1 subagent running` or `N subagents running`
beneath its title in the sidebar and beneath its header in the
[grid](grid-overview.md). The line stays visible with the child list collapsed
or expanded, and counts distinct active agent tasks even when their transcripts
are not listed. It replaces the green dots on child rows and collapsed carets.
No line appears when the count is zero or unknown. Remote sessions never show
a count: their mirrored transcripts supply turn state only.

The session's own status icon distinguishes turn activity from background
work:

| Icon | Meaning |
|---|---|
| Light-blue braille spinner | The session is working, with no subagents known to be running |
| The same spinner, violet | The session is working, with subagents running |
| Static violet ⠿ | The session is at its prompt, with background work running |

The violet spinner says the session is busy while subagents run. It does not say
the session is waiting for them: the CLI reports one busy state on its terminal
title and never signals "waiting for background agents", so the two cannot be
told apart. A background command alone keeps the working spinner light blue.
The session's higher-priority states — needs attention, response
ready — replace the icon (see [Status indicators](notifications.md)). The three
shapes show whether the subagent list is expanded or not.

The count comes from agent task lifecycle records in the local conversation's
transcript. Shells, monitors and scheduled work can affect the status icon,
but never increase the subagent count. A silent agent stays counted until its
task ends. Activity inferred from child transcript growth or remote watches
can affect the status icon, but cannot supply a trustworthy count.
