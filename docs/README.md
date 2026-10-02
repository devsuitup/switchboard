# Switchboard documentation

Documentation for [devsuitup/switchboard](https://github.com/devsuitup/switchboard),
a fork of [doctly/switchboard](https://github.com/doctly/switchboard). Download
links are in the [README](../README.md#download).

## Using the app

| Page | What it covers |
|---|---|
| [Session browser](session-browser.md) | The sidebar: tabs, projects, session rows, filters, search, pin, archive, stop, delete, missing projects |
| [Launching sessions](launching-sessions.md) | The "+" menu, the New Session and Resume dialogs, permission modes, fork, plain terminals, sessions live in another process |
| [Worktree sessions](worktrees.md) | `claude --worktree` from the New Session dialog: where the worktree lands, how it is shown, resume, cleanup |
| [Sandbox](sandbox.md) | Running `claude` under bubblewrap on Linux: what is isolated, what is not, prerequisites |
| [Terminal](terminal.md) | Terminal header, right-click modes, context menu, clickable paths, drag and drop, pasting, find, the panel shell |
| [Window](window.md) | The strip that replaces the title bar, the ☰ menu, zoom, full screen |
| [Grid overview](grid-overview.md) | All open sessions as live cards, grouped by project or flat |
| [Status indicators](notifications.md) | What each dot and colour in the sidebar means, and the status bar |
| [Subagents](subagents.md) | Subagent rows, their live status, the read-only transcript viewer |
| [Background agents](background-agents.md) | The Agents view: the daemon's `--bg` sessions, attach in a tab, stop, respawn, delete, dispatch |
| [IDE emulation](ide-emulation.md) | Switchboard as Claude's IDE: file opens and diffs in a side panel |
| [Changes view](changes-view.md) | A session's git status and diffs, with an editor for local sessions |
| [Agent Files and Work Files](memory-workfiles.md) | The two file tabs: `CLAUDE.md` and memory files, schedules, `.work-files/` |
| [Stats](activity-stats.md) | Heatmap, totals, per-model tokens, rate limits |
| [Session restore](session-restore.md) | Reopening the open sessions at the next launch |
| [Remote hosts](remote-hosts.md) | Observing, attaching to and stopping sessions on SSH hosts |
| [Automation](automation.md) | Scheduled headless runs, and the trigger API that types into open sessions |
| [ActivityWatch](activitywatch.md) | Opt-in reporting of session time to a local ActivityWatch server |
| [Activity trace](activity-trace.md) | Debug mode: the trace behind the activity indicators |
| [Settings reference](settings.md) | Every setting, its default, its scope, and where it is explained |
| [Keyboard shortcuts](keyboard-shortcuts.md) | Every shortcut, and how to rebind the four that can be |
| [Customizing colors](customizing-colors.md) | Community guide, in French, to editing the CSS inside `app.asar` (written against v0.0.30) |

## Working on the app

| Page | What it covers |
|---|---|
| [Development](development.md) | Prerequisites, `task` commands, running from source next to an installed copy, building, project layout |
| [Testing a PR live](testing-a-pr.md) | `task test-pr`: a PR's code in an isolated instance next to your own, and its pitfalls |
| [Live testing with a throwaway HOME](live-testing.md) | An instance that cannot see your sessions at all, driven by Playwright |
| [Releasing](releasing.md) | Version bump, tag, draft release, publishing |
| [Changelog](changelog.md) | Writing a `CHANGELOG.md` entry, the CI check, the What's new dialog |
| [Decisions](decisions/README.md) | Architecture decision records |

Code-level documentation for contributors and agents lives in
[../.ai/shared-guidelines.md](../.ai/shared-guidelines.md) and
[../.ai/contexts/](../.ai/contexts/README.md).
