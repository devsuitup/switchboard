# Context: plain-terminal

**Purpose**: a plain terminal (sidebar "+" → Terminal, and the panel shell of
[panel-terminal](panel-terminal.md)) is the user's own shell, with one
addition: a `claude` function that prints *"To start a Claude session, use the
+ button in the sidebar."* and returns 1, so that typing `claude` there does not
start a session Switchboard does not track.

The shim must be defined without being typed into the shell. A line written
into the PTY is echoed after the prompt until something clears it, and the
interactive shell records it in its history like any command the user typed.

## Key files

| File | Role |
|---|---|
| `plain-terminal-shell.js` | `plainTerminalLaunch()`: args, env and the fallback line per shell. `ensureInitFiles()`: writes the generated startup files. The files' content. |
| `main.js` (`open-terminal`, `isPlainTerminal` branch) | Builds the base env, asks `plainTerminalLaunch()`, spawns what it returns, types `launch.typed` 300 ms after the spawn when it is not null. |
| `shell-profiles.js` | `shellArgs()`: the args every other spawn uses (`-l -i` for bash, zsh and fish). |
| `test/plain-terminal-shell.test.js` | Args and env per shell, the generated files run by real bash and zsh, the `main.js` wiring. |

## Where the generated files live

`<data dir>/shell-init/` — the directory of `switchboard.db`, so
`SWITCHBOARD_DATA_DIR` isolates it with everything else. `ensureInitFiles()`
writes them on the first plain terminal of a process, so a new version's
content replaces the old one at the next launch. Each later plain terminal only
checks that the files still exist, and writes them again if any is missing: a
deleted `--rcfile` would otherwise start bash silently with none of the user's
startup files and a bare `PATH`, and zsh with none of theirs. Nothing under
`$HOME` is written or changed. When the write fails, bash and zsh get the typed
fallback below and a warning is logged.

```
shell-init/
  bashrc
  zsh/.zshenv  zsh/.zprofile  zsh/.zshrc  zsh/.zlogin
```

`zsh/` can also hold a `.zcompdump` that zsh writes itself: Ubuntu's
`/etc/zsh/zshrc` runs `compinit` while `ZDOTDIR` still points at the generated
directory, and `compinit` keeps its dump in `$ZDOTDIR`. The `compinit` of the
next plain zsh terminal reuses it; `ensureInitFiles()` neither writes nor removes it.

## Mechanism per shell

| Shell | How the shim gets in | Typed? |
|---|---|---|
| bash (Linux, macOS) | `bash --rcfile <shell-init>/bashrc -i` | no |
| zsh (Linux, macOS) | `ZDOTDIR=<shell-init>/zsh`, args unchanged (`-l -i`) | no |
| fish | `--init-command 'function claude; …; end'` appended to `-l -i` | no |
| PowerShell, cmd, nushell | none: the shim is POSIX syntax | no |
| sh, dash, ksh, other POSIX shells; WSL; bash on Windows (Git Bash, MSYS2) | the line is typed, **led by a space** | yes |

No shell is given `ENV` or `BASH_ENV`. Both name a *file* to source; neither
can carry code. `BASH_ENV` is read by every non-interactive bash, so it would
also reach every script the user runs from that terminal.

### bash: `--rcfile`, and the login startup it replaces

bash ignores `--rcfile` in a login shell: `bash --login --rcfile f -i` reads
`/etc/profile` and the first of `~/.bash_profile`, `~/.bash_login`,
`~/.profile`, and never reads `f`. The plain terminal is therefore started as a
non-login interactive shell whose rcfile performs the login startup itself, in
the order bash documents for a login shell:

1. `/etc/profile`, if it exists;
2. the first that exists of `~/.bash_profile`, `~/.bash_login`, `~/.profile`;
3. the shim, then `export -f claude` so child bash processes inherit it.

The user gets the files a login shell would have read, and only those. A home
with a `~/.bashrc` but none of the three login files does not get `~/.bashrc`
read, exactly as under the previous `bash -l -i`; on Debian and Ubuntu the
default `~/.profile` sources `~/.bashrc`.

Differences from a real login shell, all consequences of the shell not being
one:

- `shopt -q login_shell` is false, and `logout` refuses (use `exit`). A user
  `~/.bashrc` that branches on `login_shell` takes its non-login branch (not
  verified on a real configuration).
- `~/.bash_logout` does not run on exit.
- A bash built with `SYS_BASHRC` (Debian, Ubuntu) reads `/etc/bash.bashrc`
  before the rcfile, and `/etc/profile` sources it again: it runs twice.
- On Fedora and RHEL, `/etc/bashrc` sources `/etc/profile.d/*.sh` again when
  `! shopt -q login_shell`, so `/etc/profile.d` probably runs twice there (not
  verified).

### zsh: a generated `ZDOTDIR`

zsh reads `$ZDOTDIR/.zshenv`, then for a login shell `.zprofile`, for an
interactive one `.zshrc`, then for a login shell `.zlogin`; each lookup uses the
value `ZDOTDIR` has *at that moment*. Each generated file:

1. gives `ZDOTDIR` back its user value (unset when the user had none, so a
   `~/.zshenv` written as `ZDOTDIR=${ZDOTDIR:-$HOME/.config/zsh}` still takes
   its own default);
2. sources the user's file of the same name from `${ZDOTDIR:-$HOME}`, at top
   level (never inside a function, where the user's `typeset` would become
   local);
3. records the user value again, since the user's `.zshenv` is where
   `ZDOTDIR` is conventionally set;
4. points `ZDOTDIR` back at the generated directory, so zsh reads the next
   generated file.

`.zshrc` defines the shim after the user's `.zshrc`. `.zlogin`, the last file a
login shell reads, restores the user's `ZDOTDIR` for good and unsets its own `_sb_*` variables, so child shells, `.zlogout` and
anything the user runs see their own configuration. A `ZDOTDIR` present in the
environment Switchboard was started with is handed over as
`SWITCHBOARD_USER_ZDOTDIR` and unset by `.zshenv`.

Limits:

- zsh is always started as a login shell (`-l -i`). A non-login zsh would never
  read `.zlogin`, and `ZDOTDIR` would stay on the generated directory.

- A `/etc/zshenv` (or `/etc/zsh/zshenv`) that assigns `ZDOTDIR`
  unconditionally runs before the generated `.zshenv`; zsh then never reads the
  generated files, and the terminal has no shim (nothing is typed either).
- A user `.zshenv` that sets `NO_RCS` stops zsh before `.zshrc`: no shim, and
  `ZDOTDIR` stays on the generated directory for that shell.
- zsh has no `export -f`: a child bash started from a zsh plain terminal runs
  the real `claude`, as before.

### Everything else: the typed fallback

The line is typed 300 ms after the spawn, as
` claude() { … }; export -f claude 2>/dev/null; clear` with a leading space.
bash with `HISTCONTROL` containing `ignorespace` or `ignoreboth` (Ubuntu's
default, WSL Ubuntu included) and zsh with `HIST_IGNORE_SPACE` leave a line
that starts with a space out of the history. Without those settings it is
recorded. The line is still drawn until `clear` runs.

Windows bash gets the fallback rather than `--rcfile` because the generated
file's path is a Windows path, and how Git Bash and MSYS2 resolve it in
`--rcfile` has not been measured; a path bash cannot open would leave the user
with none of their startup files. WSL gets it because the file lives on the
Windows side of a `wsl.exe` boundary.
