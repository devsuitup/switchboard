# Settings Reference

Switchboard has **Global Settings** (the gear in the sidebar's tab row) and
**Project Settings** (the gear on a project header). Settings are stored in
Switchboard's SQLite database (`switchboard.db` in the data directory), in the
`settings` table: key `global`, and `project:<path>` per project.

A value is resolved in this order: the project's value if it overrides one, the
global value if one was ever saved, the built-in default otherwise
(`public/setting-defaults.js`). Most settings apply on **Save Settings**; two
switches, marked *live* below, apply the moment they are flipped.

## Global Settings

### Claude CLI Options

These are the defaults for new sessions; the New Session dialog can change them
for one launch — see [Launching sessions](launching-sessions.md).

| Setting | Key | Default | Effect |
|---|---|---|---|
| Permission Mode | `permissionMode` | `auto` until a value is saved | `--permission-mode`; **Default (none)** passes no flag — see [permission modes](launching-sessions.md#permission-modes) |
| Worktree | `worktree` | off | Starts new sessions with `--worktree` — see [Worktree sessions](worktrees.md) |
| Worktree Name | `worktreeName` | empty (`auto`) | The name passed after `--worktree` |
| Chrome | `chrome` | off | `--chrome` |
| Sandbox (Linux only) | `sandbox` | off | Runs `claude` under bubblewrap — see [Sandbox](sandbox.md) |
| Additional Directories | `addDirs` | empty | Comma-separated; one `--add-dir` each |

### Session Launch

| Setting | Key | Default | Effect |
|---|---|---|---|
| Pre-launch Command | `preLaunchCmd` | empty | Written in front of the `claude` command, e.g. `aws-vault exec profile --`; restricted to letters, digits, spaces and `- _ . / \ : =` — see [Launching sessions](launching-sessions.md#pre-launch-command) |

### Application

| Setting | Key | Default | Effect |
|---|---|---|---|
| Terminal Theme | `terminalTheme` | Switchboard | Terminal colours, applied on save — see [Terminal](terminal.md#theme) |
| Terminal Right-Click | `terminalRightClick` | Context menu (`menu`) | `menu`, `paste`, `default` (Native), `none` — see [Terminal](terminal.md#right-click) |
| Restore Sessions on Startup | `restoreOnStartup` | Ask on startup (`ask`) | `off`, `ask`, `auto`; read at launch — see [Session restore](session-restore.md) |
| Shell Profile | `shellProfile` | Auto (detect) | The shell for sessions and terminals; new sessions only — see [Launching sessions](launching-sessions.md#how-the-command-is-built) |
| Max Visible Sessions | `visibleSessionCount` | 10 (1–100) | Sessions shown per project before `+ N older` |
| Session Max Age (days) | `sessionMaxAgeDays` | 3 (1–365) | Older sessions go behind `+ N older`; older projects start collapsed |
| IDE Emulation | `mcpEmulation` | off | Switchboard as Claude's IDE; new sessions only — see [IDE emulation](ide-emulation.md) |

### Keyboard Shortcuts

Four rebindable shortcuts, stored as `shortcuts` — see
[Keyboard shortcuts](keyboard-shortcuts.md#rebinding).

### Updates

| Setting | Key | Default | Effect |
|---|---|---|---|
| Automatic Updates | `autoUpdate` | on | Download updates in the background and install them when Switchboard quits; read at launch |
| Version | — | — | The installed version and the update status |
| Check for Updates | — | — | Checks GitHub Releases now |

An installed build with **Automatic Updates** on checks GitHub Releases 5
seconds after launch and every 4 hours. A downloaded update brings a bar,
*Update ready — restart to apply*, with **Restart** and **Later**; **Later**
hides it for that version, and the update installs at the next quit.

With **Automatic Updates** off, Switchboard never fetches or replaces its own
binary on its own: nothing is checked until you press **Check for Updates**,
which then downloads the update found, and it installs when you choose to
restart. This keeps a locally built or patched build in place; with it on, the
next release of the same or a higher version replaces it at quit.

Builds run from source never check.

### Remote Hosts

| Setting | Key | Default | Effect |
|---|---|---|---|
| SSH hosts to observe | `remoteHosts` | none | `{alias, label, enabled}` per host — see [Remote hosts](remote-hosts.md) |
| Refresh every | `remoteRefreshMs` | 5 minutes (minimum 1) | Time between full pulls |

### Activity Reporting

| Setting | Key | Default | Effect |
|---|---|---|---|
| Send session activity to ActivityWatch | `activityReporting` | off | *Live.* Reports session time to a local ActivityWatch — see [ActivityWatch](activitywatch.md) |

### Diagnostics

| Setting | Key | Default | Effect |
|---|---|---|---|
| Debug Mode | `activityTrace` | off | *Live.* Records the activity trace; lists, opens and deletes trace files — see [Activity trace](activity-trace.md) |

### Stored without a field

- `sidebarWidth` (default 340): the sidebar's width, set by dragging its edge.
- `hiddenProjects`: projects hidden with **Hide Project**.
- `openWorkingSet`: the open sessions, for [session restore](session-restore.md).
- `dangerouslySkipPermissions` (default off): launches with
  `--dangerously-skip-permissions`; no settings field sets it, the dialogs'
  **Dangerous Skip** applies to one launch.

## Project Settings

Project Settings override, for one project, the fields of **Claude CLI Options**
and **Session Launch**: Permission Mode, Worktree, Worktree Name, Chrome, Sandbox
(Linux only), Additional Directories and Pre-launch Command. Each field has a
**Use global default** box; while it is checked the field shows the global value
and nothing is stored for the project.

**Hide Project** removes the project from the sidebar after a confirmation. No
file is deleted; **Add Project** on the same folder shows it again.

## Environment variables

| Variable | Effect |
|---|---|
| `SWITCHBOARD_DATA_DIR` | Data directory: database, trace files, remote mirrors, and Electron's `userData` (hence its own single-instance lock). Default `~/.switchboard` for an installed build, `~/.switchboard-dev` from source |
| `SWITCHBOARD_TRIGGERS_DIR` | Triggers directory, default `~/.switchboard/triggers` whatever the data directory — see [Automation](automation.md#environment-overrides) for the other trigger variables |
| `SWITCHBOARD_ACTIVITY_TRACE`, `SWITCHBOARD_ACTIVITY_TRACE_MAX_MB` | Debug mode at startup, and its disk ceiling — see [Activity trace](activity-trace.md) |
| `SWITCHBOARD_SSH_PATH` | The `ssh` binary of the terminal attached to a remote tmux session, and of nothing else — see [Remote hosts](remote-hosts.md#declaring-a-host) |
| `SWITCHBOARD_SANDBOX_DEBUG=1` | Verbose sandbox launch, set through the Pre-launch Command — see [Sandbox](sandbox.md#debugging) |
| `SWITCHBOARD_NO_CONPTY_DLL=1` | Windows: use the system's ConPTY instead of the one bundled with node-pty |
| `SWITCHBOARD_TEST_CONCURRENCY` | Test runner workers — see [Development](development.md) |
