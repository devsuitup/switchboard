# Switchboard

A desktop app for Claude Code sessions.

Switchboard lists every Claude Code session on the machine, grouped by project
and searchable by content, and runs them in built-in terminals. It launches,
resumes and forks sessions, shows which ones are busy or waiting for you, and
can observe sessions running on other machines over SSH.

![Switchboard](build/screenshot.png)

This repository is a fork of [doctly/switchboard](https://github.com/doctly/switchboard);
the original app is its author's work. Features move between the two when they
fit. `git log --oneline upstream/main..main` lists what the fork carries.

## Download

**[Latest release](https://github.com/devsuitup/switchboard/releases/latest)**

| Platform | Files |
|---|---|
| macOS | `.dmg` or `.zip`, Apple Silicon (`arm64`) and Intel (`x64`) |
| Windows | `Switchboard-Setup-<version>.exe` (NSIS installer, x64 and arm64) |
| Linux | `.AppImage` (x64, arm64), `.deb` (amd64, arm64), `switchboard-doctly-<version>.pacman` |

The builds are not code-signed. macOS Gatekeeper and Windows SmartScreen warn
on first launch.

Switchboard needs the `claude` CLI on the `PATH` of your login shell, and reads
its sessions from `~/.claude/projects`. Installed builds update themselves; see
[Updates](docs/settings.md#updates).

## Features

| Area | Page |
|---|---|
| Sidebar: projects, sessions, filters, search, pin, archive, delete | [Session browser](docs/session-browser.md) |
| Starting, resuming and forking sessions; the New Session dialog | [Launching sessions](docs/launching-sessions.md) |
| Running several sessions on one repository in git worktrees | [Worktree sessions](docs/worktrees.md) |
| Running `claude` in a bubblewrap sandbox (Linux) | [Sandbox](docs/sandbox.md) |
| The built-in terminal: right-click, clickable paths, paste, find, panel shell | [Terminal](docs/terminal.md) |
| The window strip, the menu, zoom and full screen | [Window](docs/window.md) |
| Every open session as a live card | [Grid overview](docs/grid-overview.md) |
| Busy, waiting and attention indicators; the status bar | [Status indicators](docs/notifications.md) |
| Subagent hierarchy, live status, transcripts | [Subagents](docs/subagents.md) |
| The sessions the claude daemon runs in the background: list, attach, stop, dispatch | [Background agents](docs/background-agents.md) |
| Claude's file opens and proposed edits in a side panel | [IDE emulation](docs/ide-emulation.md) |
| A session's git changes, with an editor | [Changes view](docs/changes-view.md) |
| `CLAUDE.md`, memory files and `.work-files/` | [Agent Files and Work Files](docs/memory-workfiles.md) |
| Activity heatmap, token counts, rate limits | [Stats](docs/activity-stats.md) |
| Reopening the open sessions after a restart | [Session restore](docs/session-restore.md) |
| Sessions on other machines, over SSH | [Remote hosts](docs/remote-hosts.md) |
| Scheduled headless runs and the file-based trigger API | [Automation](docs/automation.md) |
| Reporting session time to ActivityWatch | [ActivityWatch](docs/activitywatch.md) |
| Debug mode and the activity trace | [Activity trace](docs/activity-trace.md) |
| Every setting and its default | [Settings reference](docs/settings.md) |
| Every keyboard shortcut | [Keyboard shortcuts](docs/keyboard-shortcuts.md) |

The full index is [docs/README.md](docs/README.md).

## Development and releases

- [Development](docs/development.md): prerequisites, `task` commands, running
  from source next to an installed copy, building, project layout.
- [Testing a PR live](docs/testing-a-pr.md) and
  [live testing with a throwaway HOME](docs/live-testing.md).
- [Releasing](docs/releasing.md): the version bump, the tag, publishing the
  draft release.
- Contributors and agents working in the code: [.ai/shared-guidelines.md](.ai/shared-guidelines.md)
  (included by `CLAUDE.md`) and [.ai/contexts/](.ai/contexts/README.md).
