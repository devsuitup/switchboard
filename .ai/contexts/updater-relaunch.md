# Linux update relaunch (#590)

`relaunch.js` exports one async function for callers, including the future async
installer in #475. Call it after successful installation, passing `quit` and an
async `notify(message)` that resolves after the user has seen and acknowledged
the manual restart notice. It submits a transient **user service** with
`systemd-run --user --unit=switchboard-relaunch-<timestamp>-<pid> --collect`.
There is no `--scope`: the user manager starts the service, so it does not inherit
the calling Electron process's NoNewPrivs flag. The manager itself must be
unrestricted; this cannot repair a restricted user manager. The service inherits
the manager's environment, with the caller's display, authority, bus, and isolated
Switchboard data directory forwarded explicitly. Argv is passed without a shell;
literal dollars are doubled to suppress systemd's own environment expansion.
`--service-type=exec` makes target exec failures use the visible fallback as well.
Service submission has a five-second timeout. A missing executable, spawn error,
signal, timeout or nonzero exit uses the same quit-only fallback. Main sends the
existing `updater-event` channel; the renderer shows an error-kind app notice,
which has no expiry, with a Close Switchboard action. Main waits for that action
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
the tests execute its installed source to guard the assumption. A false result
resets its quitAndInstallCalled latch like BaseUpdater.quitAndInstall does.
The helper's quit callback sets updateInstalling and enters the existing shared
shutdown drain. Throws and updater error events reset the failure state.
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
The startup diagnostic reads /proc/self/status on Linux and logs NoNewPrivs as
0, 1 or unknown. Only 1 produces an error-kind app notice, sent on did-finish-load
and again on renderer reload. NoNewPrivs cannot be cleared in the current process.

Qualification here uses injected process, spawn, clock and procfs boundaries on
Windows. It does not prove the NoNewPrivs value of a real Linux service or its
desktop environment. Run the before/after commands in the #590 report on Linux.
