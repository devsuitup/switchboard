# Worktree Sessions

A worktree session runs Claude in its own git worktree: a second working
directory of the same repository, on its own branch. Several sessions can then
work on one repository at once without editing the same files, switching each
other's branch, or mixing their changes in one `git status`.

## Starting one

- For one session: `+` → **Claude (Configure...)**, turn **Worktree** on, and
  optionally type a name.
- For every new session: the **Worktree** and **Worktree Name** settings, in
  Global or Project Settings. **Claude** in the `+` menu then starts worktree
  sessions directly.

Switchboard passes `--worktree`, followed by the name when one is given, to
`claude`. The CLI creates the worktree and its branch, and runs the session in
it; without a name, the CLI picks one. The worktree lands at
`<repository>/.claude/worktrees/<name>/`.

The option applies to every launch that starts a session rather than resuming
one:

- a new session;
- a **fork**: with Worktree on in the effective settings, the command is
  `claude --resume <id> --fork-session --worktree [name]`, so the fork runs in a
  new worktree;
- a row whose transcript was never written, which is started with
  `--session-id` rather than resumed.

It is ignored on a plain resume, which keeps the directory the session already
runs in. It is also
dropped, with a warning in the main log, when the project directory is not
inside a git repository: `claude` refuses `--worktree` outside one, and the
session starts in the project directory instead.

A **Worktree Name** saved in the settings is passed to every new session; leave
it empty (placeholder `auto`) to let the CLI name each worktree.

## How Switchboard shows it

- **Sidebar.** A worktree session's transcript is stored by the CLI under the
  worktree's own encoded path in `~/.claude/projects/`. Switchboard maps any
  directory of the form `<repo>/.claude/worktrees/<name>`,
  `<repo>/.claude-worktrees/<name>` or `<repo>/.worktrees/<name>` back to
  `<repo>` when `<repo>` exists — whether the worktree still does or not — so
  the session is listed in the
  repository's project, beside the sessions run in the repository itself.
- **Resume and fork** run in the directory recorded in the session's
  transcript — the worktree — because `claude --resume` looks the session up
  by directory and would not find it from the repository root.
- The **Changes** panel and the **Shell** panel read and run in the worktree
  too — see [Changes view](changes-view.md) and
  [Terminal](terminal.md#panel-shell).
- In the [sandbox](sandbox.md), a resumed worktree session also gets the
  repository root bound read-write, because the worktree's git metadata lives
  there; the repository's config and hooks stay read-only
  ([What the sandbox protects](sandbox.md#git)).

## Cleaning up

When the work is merged or abandoned, remove the worktree from Switchboard or
with git.

**From Switchboard.** A worktree the sidebar shows as a nested header, under
its repository, has a delete button in that header (**Delete worktree from
disk**).
Before opening the dialog, Switchboard checks that the path uses a recognized
worktree layout and its parent repository is a known project. A refusal appears
in a notice, without a confirmation. These checks run again when deleting.
The dialog shows the full folder path (your home as `~`, the absolute path on
hover), branch, and local running sessions whose working directory is inside
the worktree, including open terminals and live sessions outside this window.
It warns that uncommitted changes are lost and lists their paths, ten at most.
When ignored entries exist, it counts them and warns that they are deleted too;
an ignored directory such as `node_modules` counts as one entry, not each file.
**Delete worktree** rechecks Git's status, staged contents and the contents of
every changed or untracked file against the preview. Untracked files are listed
individually even if your Git configuration normally hides them. A clean
worktree without submodules or a lock is removed without force. Dirty files
permit force only while their paths and contents still match the preview.
Ignored directory contents are neither expanded nor compared; their warning
covers everything inside them. A changed snapshot or a Git refusal leaves
a persistent notice and reopens the dialog with the fresh status, requiring
another confirmation. A locked worktree shows its lock reason and requires
checking **Delete this locked worktree, overriding its lock** before deletion;
there is no automatic double-force retry. Worktrees containing submodules also
require checking **Delete this worktree and its submodules with force**;
changes inside dirty submodules are rechecked too. The branch is kept. The
worktree's sessions move under the repository's header, at once or at the
next refresh, since their transcripts are still on disk. Deleting a
finished background session in the [Agents view](background-agents.md) delegates
to `claude rm <job>` without any force option; Switchboard does not retry it
with force. Both surfaces require fresh checks and never silently escalate a
refusal into forced removal. The sidebar's remote worktree headers share the
local button code, but cannot use the local deletion backend: their notice
directs you to review and remove the worktree with git on its host.

**With git**, from the repository:

```bash
git worktree list
git worktree remove .claude/worktrees/<name>      # refuses if it has uncommitted changes
git branch -d <branch>                             # the branch stays after the worktree goes
git worktree prune                                 # after deleting a worktree directory by hand
```

Either way, the sessions' transcripts are the CLI's and are not deleted. Once
its worktree is gone, a session is resumed from the repository root, where the
CLI does not find it; [delete](session-browser.md#delete) or archive it.

Add `.claude/worktrees/` to the repository's `.gitignore`, or the worktrees
show up as untracked files in the main working tree.
