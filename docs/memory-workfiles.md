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
error. Mermaid renders in a separate off-screen document. During each serialized
render, a DOM guard resolves `document.getElementById` only inside that render's
scratch container and SVG; page elements are inaccessible
even if Mermaid preprocesses the source differently. The original DOM methods are
restored in `finally`, including after a thrown or rejected render. Mermaid's
temporary body selections stay inside the scratch, including layout containers.
The main interface's DOM lookups and notifications continue normally.
The source filter refuses HTML-style tag openers, numeric/angle entities
(`&#…` or `&lt;`), `img:`/`icon:` properties, and any case-insensitive
`\bdetails[ \t]+[^\n:;]+[:;]` match in any checked source form when any checked
form also matches `/sequenceDiagram/i` (including participant names with
spaces). The forms are the raw source, the raw source with Mermaid 12.1.0's
directive pattern removed, and the source with leading frontmatter stripped
by `/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/` before removing directives.
An additional form normalizes CR/CRLF to LF and strips frontmatter with
`/^([^\S\n]*)---[^\S\n]*\n[\s\S]*?\n\1---[^\S\n]*(?:\n|$)/` before removing
directives, covering indented fences, trailing whitespace and BOM indentation.
This `details` regex is a cheap pre-check; the DOM guard provides the protection.
The two matches may come from different forms; no statement boundaries are modelled.
This deliberately also refuses sequence labels such as “See details X:” and
non-sequence diagrams mentioning “sequenceDiagram” and containing “details X:”.
The filter also refuses `@import`,
`url(…)` and `image-set(…)`. Paired `<<…>>` annotations containing no angle
brackets, newline or `=` are exempt from the tag-opener check; spaces and hyphens
are allowed, but `<<img src=x>>` is refused. Entity and resource checks still
inspect the original source, including annotation contents. Ordinary “See details
below” text, Windows paths and `x<y` labels are allowed. Sequence `link`/`links`
statements do not read page elements and remain allowed. SVG output also drops
scripts, event handlers, embedded HTML, images, animations, non-fragment links,
resource attributes and CSS containing external resources or escapes.

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
