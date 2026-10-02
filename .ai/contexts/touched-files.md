# Context: touched-files

**Purpose**: a per-session list of the files the session's *file tools* touched,
in the right-hand file panel, for a local session. It answers "who touched what"
where Changes cannot: outside any repository, in a directory with no git, when
sessions share a tree, and after a change was committed or reverted. Issue #309.
User-facing behavior: `docs/touched-files.md`. IPC and its guard row:
`.ai/contexts/ipc-bridge.md` ("Touched files").

## Key files

| File | Role |
|---|---|
| `session-touched-files.js` | Main-side module, no electron: `extractTouches(line)`, `resolveTouchedPath(raw, {cwd})`, `collectSessionTouchedFiles(opts)` (the walk, with every dependency injected) and `listSessionTouchedFiles(sessionId, deps)` (the IPC's target resolution). |
| `public/touched-files-view.js` | Renderer: the `'touched'` tab type, its container, rows, toggle and refresh. Loaded after `file-panel.js`, which reaches it behind `typeof` (`initTouchedView`, `renderTouchedTab`, `hideTouchedView`). |
| `read-session-file.js` | `enumerateSessionFiles(folderPath)` lists the parent and subagent transcripts (both layouts); the module keeps the entries that belong to the session. |

## What "touched" means, and what it does not

A row exists when a transcript holds an assistant `tool_use` block named `Edit`,
`Write`, `MultiEdit` or `NotebookEdit` whose input has a non-empty string
`file_path` (`notebook_path` for `NotebookEdit`). Nothing else counts. This is a
**lower bound**: measured on one project, 522 of 2829 tool calls carried a path,
2182 were `Bash`, and in one session 385 `Bash` calls against 27 file-tool calls
made nearly every changed file invisible here. Parsing shell commands was
considered and rejected (redirections, pipes, `find -exec`, computed names: any
coverage figure would be a guess).

So the tab says what it is where it is read: `#touched-coverage`, a static
string in the renderer (`TOUCHED_COVERAGE_TEXT`) that is in the DOM while the
list loads, when it fails and when it is empty. `test/dom-file-panel-touched.test.js`
pins it. The empty state reads "No files touched by the file tools", never
"nothing changed". Changes stays the authority on the working tree.

The transcript records intent, not outcome: a refused `Write` is listed. Each
row is checked against the disk when the list is built (`state`): `present`,
`gone` (`ENOENT`/`ENOTDIR`), `not-file`, `unreadable` (any other error, or no
answer in 3 s), or `refused` (see below). The list is not live: it is built on
open and on the refresh button, not on every busy-to-idle edge, because a
build reads every transcript of the session (up to 256 MiB in total, then
`coverage.truncated`) and stats up to 500 paths.

## Trust: the paths are attacker-influenced

A sandboxed session writes its own transcripts, so every path here is data an
attacker may have chosen. Listing one is harmless; the guards are about what the
listing *does* with it.

- **`resolveTouchedPath`** accepts an absolute path, normalised, and refuses
  (the row goes to `unresolved`, with no `path` field at all): control
  characters, over 4096 characters, a leading `~`, on Windows any leading
  double separator (UNC, `\\?\`, `\\.\`: a `stat` on a UNC path reaches the
  network), a rooted path with no drive and a drive-relative one.
- **A relative path** resolves only against a cwd passed through
  `verifiedTranscriptCwd` (`encode-project-path.js`, #419): the transcript's own
  `cwd` must encode back to the folder it sits in. The parent and each subagent
  are verified on their own transcript, so a subagent in a worktree (whose cwd
  encodes to another folder) leaves its relative paths `unresolved` with reason
  `relative-no-cwd`. The cwd of the Changes target is not used.
- **Before any `stat`**, every resolved path goes through `isSensitivePathAsync`
  (credential-directory denylist, 8.3 and `\\?\` handling, fail closed). A hit,
  or a check that throws, gives `state: 'refused'` and the path is never
  stat-ed. The row stays in the list so the user sees the session reached for
  it.
- **Listing is not opening.** The renderer opens a row with `readFileForPanel`
  (`read-file-for-panel`, its own `isSensitivePath`, regular-file, size and
  binary checks) and then the ordinary file tab. Only a row with
  `openable === true` **and** `state === 'present'` has a click handler; a source
  check (`test/touched-files-wiring.test.js`) pins that the view calls no other
  `window.api` method than `sessionTouchedFiles` and `readFileForPanel`. The
  absolute path the renderer passes is one the main process returned.
- **The folder** comes from `getCachedFolder` and must be a plain name (no
  separator, not `.` or `..`) before it is joined to the projects directory; a
  `sub:` session id and a remote folder are refused.
- **Rendering** is `textContent` throughout; sources (subagent type from the
  `.meta.json` sidecar) are stripped of control characters and cut to 80.

Bounds: 500 distinct resolved rows and 500 unresolved (`omitted` counts the
rest), stat concurrency 8, a line over 32 MiB is skipped, and a prefilter
(`tool_use` plus a quoted tool name) keeps `JSON.parse` off every other line.

## Decisions that were open in the issue

- **Placement**: its own tab and header toggle (`Touched`, after `Changes`),
  not a section of the Changes list; the issue puts changing the Changes panel
  out of scope.
- **Remote sessions**: the issue is silent; local only. The IPC answers
  `reason: 'remote'` and the tab shows the message. Remote transcripts are
  mirrored copies, but their paths name the host's disk, which cannot be stat-ed
  from here.
- **Ordering**: first touch, parent transcript first, then subagents by file
  name; no timestamps.
- **Open**: a row opens the plain file viewer. It does not route to the Changes
  diff when the file is also changed in the working tree (`openFileInPanel` does,
  for terminal links); doing so needs a Changes target, which a file outside any
  repository does not have.

## Not covered

- Files touched through `Bash`, MCP tools or any tool other than the four.
- Attribution between sessions sharing a directory, beyond the `sources` labels.
- A tool result that says the call failed (`is_error`) is not read.

## If you change this, also check

- `test/session-touched-files.test.js` (extraction, resolution, walk, target resolution), `test/dom-file-panel-touched.test.js`, `test/touched-files-wiring.test.js`
- `public/header-controls.js` (`HEADER_CONTROLS`, the icon) and `test/header-controls.test.js`
- the guard row in `.ai/contexts/ipc-bridge.md`
