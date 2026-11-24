# Schedules tab

The **Schedules** tab (clock icon, after Agent Files) is where you manage a
project's scheduled tasks: see when each one runs next and how its recent runs
ended, run it now, turn it on or off, edit it, create a new one or delete it.
The schedule file format, cron syntax, catch-up and what a run does are
described in [Automation](automation.md#schedules).

## Turning the tab off

The tab is on by default. For this release it can still be turned off in
**Global Settings → Automation → Schedules → Schedules tab**; the setting will be removed
in a later release. Saving the setting switches surfaces at once, without a
restart. With the tab off, project schedule files appear in
[Agent Files](memory-workfiles.md) instead, with **Run now** and the editor,
and archive messages point there. A project deletion that was still
unresolved and completes later also refreshes the open Agent Files list.

Earlier versions saved the tab as off with every Global Settings Save, so the
first launch of 0.1.0 turns it on once, even if Settings were saved before. If
you turn it off after that, it stays off. Scheduled tasks and their run
records keep running whichever surface is shown.

## What is listed

The tab lists, by project, every `schedule-*.md` file in a registered
project's `.claude/commands/` folder, including disabled schedules and
archived projects. The name match is case-sensitive: `Schedule-X.md` is not a
schedule. Each schedule shows its timing in plain words, its local next-run
time, whether it is on, and up to 20 recent runs.

The list is refreshed when the tab opens, after each action, when projects
change and on every minute boundary while the tab is visible. The tab offers no
search.

## Actions

- **Run now** starts a run at once, whatever its `cron` and `enabled` say. Its
  check mark acknowledges that the shell started, not that the task succeeded;
  a later failure leaves its own notice — see
  [Automation](automation.md#run-now).
- **Turn on** and **Turn off** edit the file's front matter. Turning a
  schedule back on skips the runs missed while it was off.
- **Open** edits the schedule file in the editor.
- **Delete** asks for confirmation, then removes the file and its catch-up and
  run-result records. Past runs stay in Sessions.
- **Show history in Sessions** shows older runs. Runs predating v0.0.90 carry
  no schedule marker and cannot be attributed.

A linked file can be opened and run, but must be turned on or off and deleted
at its source.

## Editing a schedule

**Open** shows the file in the editor described in
[Agent Files](memory-workfiles.md#agent-files). **Save**, or `Ctrl+S` /
`Cmd+S`, writes your edits. If the file changed on disk since you opened it,
the save is refused and your edits stay in the editor: **Reload** discards
them and reads the file again, and **Overwrite** writes them over the newer
file only after you confirm. A file changed on disk while you have unsaved
edits offers **Reload** or **Keep my edits**. A schedule written by hand or in
another editor must keep LF line endings: with CRLF its front matter is not
recognised and the file is skipped — see
[Automation](automation.md#schedules).

## Creating a schedule

**Create schedule** at the top of the tab opens a form: registered project,
name, slug, five-field cron expression and prompt. Enabled defaults to on and
catch-up to off. Optional fields cover permission mode, allowed tools, model,
budget, a one-line appended system prompt and additional directories (one per
line, with no commas). **Default (auto)** uses the runner's auto permission
mode. An invalid field stays in the form with an error. Switchboard writes the
file with LF line endings and keeps existing file names and slugs.

The project header's **Create scheduled task** command, which asks Claude to
write the file, remains available — see
[Automation](automation.md#creating-a-schedule).

## Outcomes

A running task says **Running**. A recorded outcome shows the exit code,
signal, launch refusal or spawn failure, and is kept across restarts. A run
without a record says **No result recorded** with a transcript hint, or
**replied; exit code unknown** when a reply exists: a reply does not prove a
successful exit.

## Errors and special projects

- An invalid file shows its problems.
- A file Switchboard cannot read, for example because of its permissions,
  stays listed with the error; its timing is shown as unknown, and only
  **Delete** and **Retry** are offered until a read succeeds.
- A project whose `.claude/commands` folder cannot be read shows the error and
  **Retry** instead of an empty list.
- If the list cannot be loaded, the tab says so with **Retry**; after a failed
  refresh it keeps the last list and labels it with its time.
- An unknown project's schedules cannot be run or opened.
- An archived project's schedules stay suspended even when on; unarchive the
  project in **Settings → Archived** first. Creating a schedule there is
  refused too.
- With no registered project, add a local project from Sessions first.
- Sandbox restrictions are those of a scheduled run: a sandboxed project needs
  Linux with bubblewrap, so on Windows and macOS its runs are refused — see
  [Sandbox](sandbox.md).

## Keyboard

Every control is reachable with Tab — see
[Keyboard shortcuts](keyboard-shortcuts.md#schedules).
