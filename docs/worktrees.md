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

The option applies only when a session **starts**. It is ignored on resume and
on fork, which keep the directory the session already runs in. It is also
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
  `<repo>` when that directory exists, so the session is listed in the
  repository's project, beside the sessions run in the repository itself.
- **Resume and fork** run in the directory recorded in the session's
  transcript — the worktree — because `claude --resume` looks the session up
  by directory and would not find it from the repository root.
- The **Changes** panel and the **Shell** panel read and run in the worktree
  too — see [Changes view](changes-view.md) and
  [Terminal](terminal.md#panel-shell).
- In the [sandbox](sandbox.md), a resumed worktree session also gets the
  repository root bound read-write, because the worktree's git metadata lives
  there.

## Cleaning up

Switchboard does not remove worktrees. When the work is merged or abandoned,
remove the worktree with git from the repository:

```bash
git worktree list
git worktree remove .claude/worktrees/<name>      # refuses if it has uncommitted changes
git branch -d <branch>                             # the branch stays after the worktree goes
git worktree prune                                 # after deleting a worktree directory by hand
```

The sessions stay in the sidebar: their transcripts are the CLI's and are not
touched. Once its worktree is gone, a session is resumed from the repository
root, where the CLI does not find it; [delete](session-browser.md#delete) or
archive it.

Add `.claude/worktrees/` to the repository's `.gitignore`, or the worktrees
show up as untracked files in the main working tree.
