# Linux update relaunch (#590)

`relaunch.js` exports one async function for callers, including the future async
installer in #475. Call it after successful installation, passing `quit` and an
async `notify(message)` that resolves after the user has seen and acknowledged
the manual restart notice. It submits a transient **user service** with
`systemd-run --user --unit=switchboard-relaunch-<timestamp>-<pid> --collect`.
There is no `--scope`: the user manager starts the service, so it does not inherit
the calling Electron process's NoNewPrivs flag. The manager itself must be
unrestricted; this cannot repair a restricted user manager. The service inherits
the manager's environment, with the caller's entire cleaned environment forwarded
explicitly, including HOME, CLAUDE_CONFIG_DIR, SWITCHBOARD_TRIGGERS_DIR, PATH,
SSH_AUTH_SOCK, locale and XDG settings. It reuses `clean-env.js` to exclude Claude
session identities, Electron internals, Node injection options and the existing
child-process exclusions. Additionally, CHROME_CRASHPAD_PIPE_NAME and CHROME_RESTART
belong to the old Chromium process; INVOCATION_ID, JOURNAL_STREAM, SYSTEMD_EXEC_PID,
NOTIFY_SOCKET and WATCHDOG_PID/USEC identify its old service; SWITCHBOARD_RELAUNCH
is reserved for relaunch state. None are forwarded. The caller's object is not mutated.
`ELECTRON_OZONE_PLATFORM_HINT` is the one Electron variable kept: it configures the app
itself, not a child. Names systemd rejects (anything outside `[A-Za-z_][A-Za-z0-9_]*`,
such as bash's exported `BASH_FUNC_x%%`) are skipped and logged, since one of them
would make systemd-run fail and send every update to the manual fallback.
Only names appear in `--setenv=NAME`; values are supplied in systemd-run's own
environment, keeping credentials out of its command line. This name-only syntax
was added in systemd 250: compare the [v249 parser](https://github.com/systemd/systemd/blob/v249/src/run/run.c)
with the [v250 parser](https://github.com/systemd/systemd/blob/v250/src/run/run.c)
and the [v250 manual](https://github.com/systemd/systemd/blob/v250/man/systemd-run.xml).
Older systemd versions use the visible manual-restart fallback; no value-bearing
argv or temporary environment file is used. Argv is passed without a shell;
literal dollars are doubled to suppress systemd's own environment expansion.
`--service-type=exec` makes target exec failures use the visible fallback as well.
`--property=KillMode=process` preserves independently surviving daemon jobs, tmux
servers and detached applications when the main process exits. With this mode,
systemd targets only the main process for both termination and final killing;
SendSIGKILL=no would unnecessarily disable escalation for a stuck main process.
This deliberately accepts the child lifecycle tradeoff described in the
[systemd.kill manual](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).
Service submission has a five-second timeout. On ETIMEDOUT, a bounded two-second
`systemctl --user is-active --quiet <same-unit>` check avoids showing the fallback
if the service is already active. An inactive, missing or unqueryable unit keeps
the fallback. There is a residual race if an activating unit becomes active after
the check; fully cancelling/reconciling a queued job would broaden this helper's
contract. Inspect the unit journal before starting another copy in that case.
A missing executable, other spawn error, signal or nonzero exit also uses the
quit-only fallback. Main sends the
existing `updater-event` channel; the renderer shows an error-kind app notice,
which has no expiry or dismiss button, with a sole Close Switchboard action
(`dismissible: false`, `dismissOnAction: false`). Main waits for that action
from its own renderer or for the window to close before quitting. No native
dialog is used. Acceptance by systemd is not proof of a successful app startup;
inspect the unit's journal if the new app does not appear. These service and
argument semantics follow the [systemd-run manual](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html).

In electron-updater 6.8.9, `BaseUpdater.quitAndInstall(false, false)` ignores the
second argument and substitutes `autoRunAppAfterInstall`. `DebUpdater.doInstall`
runs its package manager synchronously, then calls its Electron adapter's
`app.relaunch()` when isForceRunAfter is true. There is no public post-install
success event. Linux's explicit install therefore calls the installed updater's
`install(false, false)` method and checks its boolean result, then awaits the
helper. This is a deliberately narrow dependency on BaseUpdater's internal API;
package.json pins 6.8.9 exactly (the lock already resolves that version). Tests
execute both the installed BaseUpdater and DebUpdater force-run branch, stubbing
the package-manager boundary and proving false does not call app.relaunch.
A false result
resets its quitAndInstallCalled latch like BaseUpdater.quitAndInstall does.
The helper's quit callback sets updateInstalling and enters the existing shared
shutdown drain. Throws and updater error events reset the failure state.

A native macOS install that arrives after the 30-second release bound can show
the ordinary close wording rather than Restart wording; cancelling that close
clears the install bypass so later Cmd+Q checks edits and sessions again.
autoRunAppAfterInstall is also disabled on Linux. Other platforms retain the
original zero-argument quitAndInstall call.

Install-on-quit retains the autoUpdate setting: BaseUpdater.addQuitHandler uses
`install(true, false)` already. It installs without restarting, as before. No
extra relaunch is added when a user deliberately quits. AppImage's renamed
destination is remembered through appimage-filename-updated; relaunch executes
that AppImage instead of the old mounted executable. AppImage installation
still runs its own exit-after-install integration subprocess, without starting
an interactive instance. Pacman and RPM use the same no-force-run contract.

The new process carries `--switchboard-relaunch`. Only on Linux with that marker
does single-instance-lock acquisition retry every 200 ms for at most ten seconds.
The old instance finishes its normal bounded shutdown while the replacement
waits. Ordinary second launches still quit and focus the existing window.
Once updateInstalling is set, the old instance ignores second-instance events
instead of repeatedly restoring and focusing its window. Exhausting a marked
launch's retry bound logs a warning through the main logger before quitting.
The startup diagnostic reads /proc/self/status on Linux and logs NoNewPrivs as
0, 1 or unknown. Only 1 produces an error-kind app notice, sent on did-finish-load
and again on renderer reload. NoNewPrivs cannot be cleared in the current process.

Qualification here uses injected process, spawn, clock and procfs boundaries on
Windows. It does not prove the NoNewPrivs value of a real Linux service or its
desktop environment. Run the before/after commands in the #590 report on Linux.
