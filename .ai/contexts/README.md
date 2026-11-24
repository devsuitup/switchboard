# Context engineering — Switchboard

Thirty sub-system docs, written for AI agents who need to make a focused
change without re-reading `main.js` (about 4700 lines as of 2026-11) or the
main-process modules under `src/main/<context>/`.

## When to read which

| Touching this area | Read |
|---|---|
| Module-move codemod, VM stub inference and layout checks | [module-moves](module-moves.md) |
| CLI adapter contract, Claude delegation, pure launch argv, the Codex adapter and its index/viewer wiring | [cli-harnesses](cli-harnesses.md) |
| Managed browser lifecycle library, Linux identity/lock and test-pr cleanup | [managed-browser](managed-browser.md) |
| The fast pre-commit check (staged lint, test selection) | [fast-check](fast-check.md) |
| SQLite, indexing, search, heatmap aggregation, fs.watch | [session-cache](session-cache.md) |
| Cron schedules, schedule `.md` files, `claude --resume -p` spawn | [schedule-runner](schedule-runner.md) |
| Project operation admission, launch reservations and draining in-flight spawns | [project-operation-gate](project-operation-gate.md) |
| Project deletion: the preview, the process reads, the removal | [project-delete](project-delete.md) |
| Subagent sidebar grouping, transcript view, parent→child wiring | [subagent-observability](subagent-observability.md) |
| Memory and Activity trace viewers, CodeMirror panel, toolbar buttons | [viewer-panel](viewer-panel.md) |
| New IPC, preload bridge changes, renderer ↔ main protocol | [ipc-bridge](ipc-bridge.md) |
| File-trigger watcher, harness input injection, idle-wait | [trigger-watcher](trigger-watcher.md) |
| Claude CLI state files, early subagent rescan, canary tests | [cli-session-state](cli-session-state.md) |
| Busy/attention/response-ready state, the session-state domain module, the icon-slot projection | [session-state](session-state.md) |
| The Changes panel: git-status parser, local/remote runner, cwd resolution, no-polling refresh | [changes-view](changes-view.md) |
| The Touched tab: files a session's file tools touched, from its transcript and its subagents', checked against disk | [touched-files](touched-files.md) |
| The shell inside the file panel: mount point, hidden-write exemption, shell lifecycle, the splitter | [panel-terminal](panel-terminal.md) |
| How a plain terminal's shell starts: the `claude` shim per shell, the generated rcfile and `ZDOTDIR`, the typed fallback | [plain-terminal](plain-terminal.md) |
| Paths in terminal output becoming links: the matcher, the openability check, `path:line` | [terminal-path-links](terminal-path-links.md) |
| What the right mouse button does in a terminal: the four modes, and keeping the press from the application | [terminal-right-click](terminal-right-click.md) |
| The frameless window: the strip that replaces the title bar, its drag regions, the window controls, the menu's accelerators | [window-frame](window-frame.md) |
| The Agents view, the daemon's job files, attach/detach, dispatch | [bg-agents](bg-agents.md) |
| The session index's writer worker (ADR 0004) | [session-index-writer](session-index-writer.md) |
| The renderer's modal stack and its question dialogs (`appConfirm`, `appChoose`) | [app-dialogs](app-dialogs.md) |
| The session tool bar, ownership, Diff parking, shortcuts, overflow | [tool-bar](tool-bar.md) |
| What is reported to ActivityWatch: the two buckets, focus, the Settings section | [activitywatch](activitywatch.md) |
| Screen refresh on return, the Refresh controls, the PTY resize nudge | [terminal-refresh](terminal-refresh.md) |
| The Linux updater restart, environment, lock retry, manual restart notice | [updater-relaunch](updater-relaunch.md) |
| The build/release workflow: matrix per event, strict publish, release notes, the PR-title check | [build-release](build-release.md) |
| The app theme: Dark/Light/System, the color tokens, the light terminal palette | [theme](theme.md) |

## Reading order for a new contributor (~30 min)

0. **[ADR 0005](../../docs/decisions/0005-main-process-context-layout.md)** — why main-process modules live under `src/main/<context>/`, and how a move is done
1. **`ipc-bridge`** — gives you the public surface of the whole app in one page
2. **`session-cache`** — gives you the data model
3. **`subagent-observability`** — the #1 fork-specific feature, touches everything
4. **`viewer-panel`** — the reusable read/edit-file framework
5. **`schedule-runner`** — least-cross-cutting; safe to skip if you're not touching schedules

## What's NOT in these contexts (intentionally)

- **Terminal management core** — xterm.js + node-pty integration in `public/terminal-manager.js`. Its edges are documented (terminal-refresh, terminal-path-links, terminal-right-click, plain-terminal, panel-terminal; user doc [docs/terminal.md](../../docs/terminal.md)), the core is not: it is largely upstream code with minor extensions. If you're working there, read the file directly.
- **MCP / IDE emulation** — file diff panel, OSC 8 hyperlinks, etc. Lives in `public/file-panel.js` and `src/main/integrations/mcp/mcp-bridge.js` (only the `mcp-diff-response` handler stays in `main.js`). No context doc; the user doc is [docs/ide-emulation.md](../../docs/ide-emulation.md).
- **Remote hosts over SSH** — `src/main/remote/`. No context doc; the user doc is [docs/remote-hosts.md](../../docs/remote-hosts.md).
- **Settings UI** — per-project + global, lives in `public/settings-panel.js`; the user doc is [docs/settings.md](../../docs/settings.md). Defaults come from `SETTING_DEFAULTS` in `public/setting-defaults.js`.
- **Sidebar rendering details** — covered piecemeal in subagent-observability + session-cache; the full sidebar is `public/sidebar.js`. If you're doing UI work there, expect to read the file.
- **Local build / electron-builder** — covered in [docs/development.md](../../docs/development.md); the CI build and release workflow is [build-release](build-release.md).

## Updating these docs

When a feature lands, the corresponding context doc should change in the same PR. **If you can't decide which context owns a change, it probably means a new sub-system is emerging — write a new doc instead of stretching an existing one.**

Pre-existing observations / nits found while writing these docs are captured in [_issues.md](_issues.md). They're not blockers but worth a follow-up when adjacent work happens.
