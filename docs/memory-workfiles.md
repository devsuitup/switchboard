# Agent Files and Work Files

Two sidebar tabs list files that Claude Code reads or that sessions leave
behind, and open them in a CodeMirror editor in the main area. Each tab's list
is read when the tab is clicked.

## Agent Files

The **Agent Files** tab (brain icon) lists Markdown files, grouped by where
they live:

- **Global**: every `.md` file directly in `~/.claude/` — `CLAUDE.md` among
  them.
- **Per project**, for each project in `~/.claude/projects/`:
  - the `.md` files directly in `~/.claude/projects/<folder>/` and in its
    `memory/` directory (Claude Code's auto-memory, `MEMORY.md` and the files
    it indexes);
  - `CLAUDE.md`, `GEMINI.md` and `agents.md` at the project root;
  - the `.md` files directly in `<project>/.claude/` and
    `<project>/.claude/commands/`.

No directory is scanned recursively. Archived and deleted projects are left out.

Files named `schedule-*.md` carry a clock icon and a **Run now** button — see
[Automation](automation.md#schedules).

The editor offers:

- Markdown highlighting, and a preview toggle that renders the document (the
  choice is remembered);
- **Copy path** and **Copy content**;
- a word-wrap toggle;
- `Ctrl+F` / `Cmd+F` to find, `Ctrl+G` / `Cmd+G` to go to a line;
- **Save**, or `Ctrl+S` / `Cmd+S`;
- a reload when the file changes on disk.

Markdown previews render fenced `mermaid` blocks as diagrams, including in the
Touched/Changes editor. Invalid diagrams keep their source visible with an inline
error. The source filter refuses HTML-style tag openers (except Mermaid
`<<word>>` annotations), numeric/angle entities (`&#…` or `&lt;`), `img:`/`icon:`
properties, sequence details statements (`details participant: …`), `@import`,
`url(…)` and `image-set(…)`. Ordinary details text, Windows paths and `x<y` labels
are allowed. SVG output also drops scripts, event handlers, embedded HTML,
images, animations, non-fragment links, resource attributes and CSS containing
external resources or escapes.

## Work Files

The **Work Files** tab (folder icon) lists, per project, the files under
`<project>/.work-files/`, recursively, most recent first, at most 200 per
project. `.work-files/` is a scratch directory for session notes, plans and
agent reports that belong with a project without being committed; add it to
the project's `.gitignore`.

The Work Files editor has no save; it offers:

- **Format**, for `.json` and `.jsonl` files: pretty-prints the content in the
  editor, without writing to disk;
- **Copy path** and **Copy content**;
- **Delete**, which removes the file from disk after the confirmation
  *Delete "&lt;name&gt;"? This cannot be undone.*;
- **Close**.

## Search

The search field searches the tab that is open: Agent Files searches the listed
agent files, Work Files the work files — see
[Session browser](session-browser.md#search).
