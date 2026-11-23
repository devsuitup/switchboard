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

The pages are **General**, **Sessions**, **Keyboard**, **Automation**, **Remote hosts**,
**Integrations**, **Archived** and **Advanced**. Project Settings has **Launch** and
**This project**. Each scope remembers its last page on this computer. A narrow
viewer automatically places the navigation in a horizontal strip above the page.
See [Settings navigation](keyboard-shortcuts.md#settings-navigation) for the keys.

All pages share one Save: switching pages keeps edits, and the footer counts
unsaved changes. Save keeps Settings open and flashes Saved; Cancel discards edits
without asking. Live switches and Unarchive still take effect immediately.

**Filter settings…**, above the navigation, finds text in setting labels and
descriptions across all pages, in both Global and Project Settings. Matching rows
appear under their page titles; pages without matches are dimmed in the navigation.
Matching ignores case and outer spaces. It searches only setting names and
descriptive prose. Control text and values (including option labels, shortcut
bindings and Use global default), ids, version and status messages, ActivityWatch
destination and URL values, SSH host entries and their action buttons, and trace
file paths and entries are excluded. Expanded explanatory disclosures are not
searched either.
There is no fuzzy matching. You can edit and save the matching rows normally.
Press Escape in the field, or clear it, to return to the current page. Selecting a
navigation item while filtering keeps the results visible and chooses the page
to return to. The filter is keyboard reachable and does not count as an edit.

Archived keeps its own **Filter by name, path or host…** field: archives are excluded
from the settings filter. Clear the settings filter to use Archived; its filter
and selected rows are preserved. Project identity and Danger zone actions are
also outside the settings search.

### General

Startup, Shell, Terminal and IDE settings:

| Setting | Key | Default | Effect |
|---|---|---|---|
| Terminal Theme | `terminalTheme` | Switchboard | Terminal colours, applied on save — see [Terminal](terminal.md#theme) |
| Terminal Right-Click | `terminalRightClick` | Context menu (`menu`) | `menu`, `paste`, `default` (Native), `none` — see [Terminal](terminal.md#right-click) |
| Restore Sessions on Startup | `restoreOnStartup` | Ask on startup (`ask`) | `off`, `ask`, `lazy` (Restore on click), `auto`; read at launch — see [Session restore](session-restore.md) |
| Shell Profile | `shellProfile` | Auto (detect) | The shell for sessions and terminals; new sessions only — see [Launching sessions](launching-sessions.md#how-the-command-is-built) |
| IDE Emulation | `mcpEmulation` | off | Switchboard as Claude's IDE; new sessions only — see [IDE emulation](ide-emulation.md) |

#### Updates

| Setting | Key | Default | Effect |
|---|---|---|---|
| Automatic Updates | `autoUpdate` | on | Download updates in the background and install them when Switchboard quits; read at launch |
| Receive beta versions | `receiveBetaVersions` | off | Include GitHub pre-releases in automatic and manual update checks; applied at launch and on Save Settings |
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

Stable is the default channel. Turn on **Receive beta versions** and click
**Save Settings** to include beta releases in future update checks. The same
binary serves both channels; the release's GitHub pre-release status decides
whether it is beta. Turning the switch off never downgrades: an installed beta
stays in place until a newer stable version is available. A beta that was
already downloaded before you turned the switch off still installs at the next
quit. The SQLite cache
only migrates forward.

### Sessions

#### Launch and Claude

These are the defaults for new sessions; the New Session dialog can change them
for one launch — see [Launching sessions](launching-sessions.md).

| Setting | Key | Default | Effect |
|---|---|---|---|
| Permission Mode | `permissionMode` | `auto` until a value is saved | `--permission-mode`; **Default (none)** passes no flag — see [permission modes](launching-sessions.md#permission-modes) |
| Worktree | `worktree` | off | Starts new sessions with `--worktree` — see [Worktree sessions](worktrees.md) |
| Worktree Name | `worktreeName` | empty (`auto`) | The name passed after `--worktree` |
| Browser | `browserMode` | Off (`off`) | **Off** passes no browser flag; **Claude in Chrome** (`claude-in-chrome`) passes `--chrome` |
| Sandbox (Linux only) | `sandbox` | off | Runs `claude` under bubblewrap — see [Sandbox](sandbox.md) |
| Additional Directories | `addDirs` | empty | Comma-separated; one `--add-dir` each |

A saved `chrome` setting is read as the matching Browser choice: `true` selects
**Claude in Chrome**, and `false` selects **Off**.

| Setting | Key | Default | Effect |
|---|---|---|---|
| Pre-launch Command | `preLaunchCmd` | empty | Written in front of the `claude` command, e.g. `aws-vault exec profile --`; restricted to letters, digits, spaces and `- _ . / \ : =` — see [Launching sessions](launching-sessions.md#pre-launch-command) |
| Custom Arguments | `customArgs` | empty | Appended to Claude commands for new sessions, resumes, forks, schedules and remote launches; project overrides apply only to local launches — see [Custom arguments](launching-sessions.md#custom-arguments) |

#### CLI Agents and Codex

The existing CLI switches and Codex sandbox, approval, model and reasoning-effort
controls are grouped here. See [Launching sessions](launching-sessions.md).

**Custom arguments** (`codexCustomArgs`, empty by default) in the Codex section
applies to Codex new sessions, resumes and forks. It is global, like the other
Codex launch controls, and independent of Claude's Custom Arguments.
Both fields reject newlines and control characters. Quote values for the
selected shell; remote Claude launches use only global arguments, passed to the
remote POSIX shell as typed. Windows cmd/PowerShell schedules instead split
literal quoted tokens through the exact Windows launch route; see the linked
quoting rules. Saving an empty Claude project override disables the global
arguments for that project's local launches.

**Show Codex usage** (`showCodexUsage`, off by default) displays Codex rate
limits in the status bar and Stats. When enabled, it reads `CODEX_HOME/auth.json`
(or `~/.codex/auth.json`) and calls `chatgpt.com` with the Codex login token
and, when present, the account id in the `chatgpt-account-id` header.
Unavailable credentials, request failures or unsupported responses hide the
Codex gauges quietly. Saving a changed toggle applies it immediately.

#### Sidebar list

| Setting | Key | Default | Effect |
|---|---|---|---|
| Max Visible Sessions | `visibleSessionCount` | 10 (1–100) | Sessions shown per project before `+ N older` |
| Session Max Age (days) | `sessionMaxAgeDays` | 3 (1–365) | Older sessions go behind `+ N older`; older projects start collapsed |
| Hide SDK-launched Sessions | `hideSdkSessions` | on | Leaves out of the sidebar and grid the sessions a program started: Claude Agent SDK runs and non-interactive `codex exec` runs; scheduled tasks stay — see [Session browser](session-browser.md#sessions-started-by-a-program) |

### Keyboard

Eight rebindable shortcuts, stored as `shortcuts`: Toggle Changes, Show
pending Diff, Toggle Touched, Toggle Shell, Navigate sessions / grid, Previous /
next session, Toggle grid view and Toggle agents view. Each defaults to
Primary+Shift (Ctrl, or Cmd on macOS) with its key — see
[Keyboard shortcuts](keyboard-shortcuts.md) for the keys and
[Rebinding](keyboard-shortcuts.md#rebinding).

### Automation

| Setting | Key | Default | Effect |
|---|---|---|---|
| Schedules tab | `schedulesTab` | off | Moves project schedule files from Agent Files to the Schedules tab on save; while off, the files and Run now stay in Agent Files — see [Automation](automation.md#schedules) |

### Remote hosts

| Setting | Key | Default | Effect |
|---|---|---|---|
| SSH hosts to observe | `remoteHosts` | none | `{alias, label, enabled}` per host — see [Remote hosts](remote-hosts.md) |
| Refresh every | `remoteRefreshMs` | 5 minutes (minimum 1; the field offers up to 1440) | Time between full pulls |

### Integrations

| Setting | Key | Default | Effect |
|---|---|---|---|
| Send session activity to ActivityWatch | `activityReporting` | off | *Live.* Reports session time to a local ActivityWatch — see [ActivityWatch](activitywatch.md) |

The **What is sent** explanation expands when selected.

### Archived

Project and folder archives are grouped by host, with Local first. Each row shows
its name, full path (also in the tooltip), Project or Folder badges (both when
archived both ways), any legacy badge, and the available archive date. Folder
archives also show how many schedules the archive turned off. Worktree entries keep their own rows and paths. Filter by name, path,
host label or alias; Escape clears the filter. Host headers fold with Enter or
Space. Select rows or a host group to unarchive several projects together.

**Unarchive** applies immediately. Project restores offer a ten-second **Undo**;
folder restores keep sessions archived and schedules off, with **Turn back on**
offered at the top of the restored group. Re-archive a folder with **Archive folder**;
in a mixed restore, Undo re-archives sessions and project archives only. A combined row restores its
project archive first, then its folder archive. The row's
**More actions** menu offers **Copy path** and **Delete project…**. Delete opens
the same preview and confirmation as the sidebar, without unarchiving first.
Archived top-level sessions appear below, grouped by project and host, with dates,
message counts and available file sizes. Groups show twelve rows and **Show N more**.
Each row offers **Unarchive**, **Transcript**, and **Show in sidebar** in its menu.
Selection is shared with projects: **Unarchive selected (N)** restores project
entries first, then sessions, with one notice and Undo. The filter and checked
items survive project updates. Sessions of archived projects appear after Unarchive.

### Advanced

| Setting | Key | Default | Effect |
|---|---|---|---|
| Debug Mode | `activityTrace` | off | *Live.* Records the activity trace; lists, opens and deletes trace files — see [Activity trace](activity-trace.md) |

The **What it records** explanation expands when selected.

### Stored without a field

- `sidebarWidth` (default 340): the sidebar's width, set by dragging its edge.
- `hiddenProjects`: projects archived with **Archive Project**, including legacy
  hidden entries, and projects deleted from Switchboard (kept out of the sidebar;
  not listed in **Archived projects**). `hiddenProjectKinds` records which is which.
- `hiddenProjectArchivedAt`: archive timestamps keyed by the exact hidden entry;
  older entries without a timestamp display no date.
- `archivedProjects`, a setting of its own: folders hidden with
  [Archive folder](session-browser.md#archive-a-folder), each with the session
  ids it held and the schedule files it disabled.
- `scheduleReenableOffers`, a setting of its own: for each folder that came
  back, the schedules its archive disabled, until **Turn back on** or
  **Dismiss**.
- `openWorkingSet`: the open sessions, for [session restore](session-restore.md).
- `dangerouslySkipPermissions` (default off): launches with
  `--dangerously-skip-permissions`; no settings field sets it, the dialogs'
  **Dangerous Skip** applies to one launch.
- `remoteTriggers` (default off): lets a trigger reach a session of an enabled
  remote host — see [Automation](automation.md#remote-trigger-targets).
- `lastSeenVersion` (default none): the last version whose **What's new** was
  shown — see [Changelog](changelog.md#whats-new-in-the-app).

## Project Settings

Project Settings override, for one project, the fields on the **Launch** page: Permission Mode, Worktree, Worktree Name, Browser, Sandbox
(Linux only), Additional Directories and Pre-launch Command. Each field has a
**Use global default** box; while it is checked the field shows the global value
and nothing is stored for the project.

The **This project** page shows the project's name, full path, host, folder key
and the number of sessions, including archived ones. Counts are unavailable when
the project is absent from the current project list. Its **Danger zone** holds
**Archive Project** and **Delete Project**; the footer holds only **Cancel** and
**Save Settings**. The first visit opens **Launch**; later visits remember the
last project page.

**Archive Project** removes the project and its nested worktrees from the
sidebar immediately, without asking. A notice offers **Undo** for about 10
seconds; it restores the project and resumes scheduling. Settings, cached sessions and search
entries are kept. Schedules stay on disk with their enabled state unchanged,
but Switchboard suspends their launches until you unarchive the project.
Already running sessions and schedules continue.

In Global Settings → **Archived**, **Unarchive** restores the sidebar
row and resumes scheduling (a run that fell due while archived is not replayed); **Add Project** on the same local folder also
restores it. Previously hidden projects appear here too, with default settings
because the old Hide action already removed their settings. A remote entry
includes its host alias; unarchiving it does not register a local schedule.

**Delete Project** opens the same preview as **Delete** on the project header.
Choose whether to discard session names, pins and app metadata (initially off)
and project settings (initially on when available). Unselected session metadata
is archived. Shared path-only settings cannot be deleted. Only confirmed,
available choices are remembered; Cancel changes nothing.

The preview shows the full host and path, counts, and expandable complete
targets and effects. Project files, transcripts, schedules, memory, `.work-files`
and nested worktrees stay on disk. Kept schedules may reactivate on re-add;
retained transcripts can restore their titles. Background jobs must be stopped
from the Agents view first. Local terminal stopping for deletion requires Windows;
on other platforms stop the terminals first and reopen the preview.

An unresolved deletion offers **Check deletion state**, without replaying it.
A partial result offers **Review remaining deletion** for a fresh preview.
If recovery is unavailable, deletion is unavailable for all projects until it
finishes; reopen Delete or check the announced operation to retry. A completed
deletion whose views failed to refresh offers **Reload window**.

Project Archive stays in effect until restored explicitly. It differs from
[Archive folder](session-browser.md#archive-a-folder), which returns on new
activity and can optionally archive sessions and disable schedule files.

## Environment variables

| Variable | Effect |
|---|---|
| `SWITCHBOARD_DATA_DIR` | Data directory: database, trace files, remote mirrors, and Electron's `userData` (hence its own single-instance lock). Default `~/.switchboard` for an installed build, `~/.switchboard-dev` from source. Set to any value, even `~/.switchboard`, it turns schedule catch-up off — see [Automation](automation.md#catching-up-a-missed-run) |
| `SWITCHBOARD_TRIGGERS_DIR` | Triggers directory, default `~/.switchboard/triggers` whatever the data directory — see [Automation](automation.md#environment-overrides) for the other trigger variables |
| `SWITCHBOARD_ACTIVITY_TRACE`, `SWITCHBOARD_ACTIVITY_TRACE_MAX_MB` | Debug mode at startup, and its disk ceiling — see [Activity trace](activity-trace.md) |
| `SWITCHBOARD_SSH_PATH` | The `ssh` binary of every remote operation: pulls (scp included, through `scp -S`), watch connection, attached terminal, stop, Changes view. An absolute path to an executable — a relative value is ignored, and a Windows `.cmd`/`.bat` cannot be started. Unset, `ssh` from the `PATH`, then the system's — see [Remote hosts](remote-hosts.md#which-ssh-and-scp-run) |
| `SWITCHBOARD_SCP_PATH` | The `scp` binary of the pulls, same rules. Unset, the `scp` beside `SWITCHBOARD_SSH_PATH` when there is one, then `scp` from the `PATH`, then the system's — see [Remote hosts](remote-hosts.md#which-ssh-and-scp-run) |
| `SWITCHBOARD_SANDBOX_DEBUG=1` | Verbose sandbox launch, set through the Pre-launch Command — see [Sandbox](sandbox.md#debugging) |
| `SWITCHBOARD_NO_CONPTY_DLL=1` | Windows: use the system's ConPTY instead of the one bundled with node-pty |
| `SWITCHBOARD_TEST_CONCURRENCY` | Test runner workers — see [Development](development.md) |
