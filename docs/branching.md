# Branches

How branches are named, protected and merged in `devsuitup/switchboard`, and
how a release line moves between `main` and `release/X.Y`. The release itself
(tag, build, assets, publishing) is in [Releasing](releasing.md).

Every `gh` command run by hand in this clone needs `--repo devsuitup/switchboard`:
gh's default here is the upstream repository, `doctly/switchboard`.

## Branch kinds

| Branch | What it is | Base, and where it merges | Merge method |
|---|---|---|---|
| `main` | The default branch. It never freezes: it takes every PR at any time (maintainer decision, 2026-11-25). | — | — |
| `release/X.Y` | One per minor line (`release/0.1`). Betas and finals of `X.Y.Z` are tagged on it. | Created once, at a tag, by an admin ([First beta of a new minor line](#first-beta-of-a-new-minor-line)). | — |
| `fix/<issue>-<slug>`, `feat/…`, `docs/…`, `ci/…`, `chore/…` | Work branches. | From `origin/main`, PR to `main`. | **Squash** |
| `bump/v<version>` | A beta cut, or a final. | Beta: from `origin/main`, or from `origin/release/X.Y` for a [maintenance beta](#maintenance-beta). Final: from `origin/release/X.Y`. PR to `release/X.Y`. | **Merge commit** |
| `bump/port-back-v<version>` | A release brought back to `main`. | At the release tag, PR to `main`. | **Merge commit** |
| `backport/<issue>-to-X.Y` | One fix already merged on `main`, cherry-picked onto a release line ([Backports](#backports)). | From `origin/release/X.Y`, PR to `release/X.Y`. | **Merge commit** |

Never name a working branch `release/…`: the `release-protection` ruleset
matches `release/*`, so such a branch could not be pushed to again or deleted.
The repository deletes a PR's head branch once it is merged
(`delete_branch_on_merge`): open a PR from its own `bump/…` branch, never with
`release/X.Y` as the head.

## Why each merge method

- **Squash into `main` for work branches.** One commit per PR keeps `main`
  readable and revertible. The squash keeps only the PR title (the
  repository's `squash_merge_commit_title` is `PR_TITLE`) and GitHub appends
  ` (#<PR>)`, so the title must carry the issue it closes:
  `fix(ui): say what to do when a save fails (#709)` became
  `fix(ui): say what to do when a save fails (#709) (#1310)`.
- **Merge commit for everything into `release/*`, and for a port-back.**
  `release-protection` allows only `merge` on release branches, so cuts,
  finals and backports are all merge commits. A squash writes a new commit
  that is in neither branch's history. A cut merged with a merge commit keeps
  `main` an ancestor of `release/X.Y`; a port-back merged with a merge commit
  keeps `release/X.Y` an ancestor of `main`. Each next cut then merges cleanly,
  because the merge base is the last release instead of an older commit both
  sides changed since. A squashed port-back breaks this
  ([Pitfalls](#pitfalls)).

## Protection

Four rulesets, read with `gh api repos/devsuitup/switchboard/rulesets/<id>`:

| Ruleset | Applies to | Rules |
|---|---|---|
| 17240192 `can't delete` | the default branch | no deletion, no non-fast-forward push |
| 17240725 `main-protection` | the default branch | PR required with 0 approvals; required checks `lint`, `test (20, ubuntu-latest)`, `test (22, ubuntu-latest)`, `test (22, windows-2022)`, `changelog`, `e2e`; no deletion, no non-fast-forward push |
| 28112036 `release-protection` | `refs/heads/release/*` | PR required with 0 approvals, **merge commit the only allowed method**; the same six checks, with `do_not_enforce_on_create`; `creation`, so only an admin creates a release branch; no deletion, no non-fast-forward push |
| 28267436 `release-tags` | `refs/tags/v*` (tag ruleset) | `creation`, `update`, `deletion`, `non_fast_forward`: only an admin creates a release tag, and nobody else moves or deletes one |

The classic branch protection on `main` also requires `lint`, `e2e` and the
three `test` checks (not `changelog`), with `enforce_admins` on. The
`main-protection`, `release-protection` and `release-tags` rulesets list the
repository admin role (actor 5) as an "always" bypass actor. That bypass is
for creating a release branch and pushing a release tag, nothing else: never
use it to push commits to `main` or a release branch, everything goes through
a PR. On `main` all three merge methods are allowed, so squash-or-merge-commit
there is procedure, not a setting; on `release/*` only `merge` is. When the
test matrix changes, `main-protection`, `release-protection` and the classic
protection are updated together ([Releasing](releasing.md#steps)).

Two more rules are enforced by `scripts/check-release-provenance.js`:

1. a tag is released only when its commit is on a `release/*` branch:
   the tag mode of `scripts/check-release-provenance.js`, run by `build.yml`'s `release-tag` job on the tag push;
2. every commit a PR brings into `release/*` is already on `main`, unless it
   is a merge commit, the version and `CHANGELOG.md` bump, or a cherry-pick
   whose `(cherry picked from commit <sha>)` trailer (`git cherry-pick -x`)
   names a commit on `main`: the PR mode of `scripts/check-release-provenance.js`, run by the `release-provenance` job of `.github/workflows/release-provenance.yml` on every PR into `release/*`.

`release-provenance` is not yet a required check, and `release/0.1` gets the workflow only at its next cut from `main` (#1318). Both jobs run the checker from `main`'s copy, so editing the checked-out script does not bypass it. The workflow files themselves are not protected that way: `pull_request` reads the workflow from the PR's merge ref, so a PR into `release/*` can edit `release-provenance.yml` or `build.yml` to remove or replace the invocation. Moving the PR check to `pull_request_target` once `release/*` carries the workflow is tracked in #1318.

`test.yml` (PR and push) and `build.yml` and `pr-title.yml` (PR) run for
`main` and `release/*`. A tag push runs `build.yml` whatever the branch; only
a tag push publishes.

## Work branches

```bash
git fetch origin
git checkout -b fix/709-failure-says-what-to-do origin/main
# commit, then
git push origin fix/709-failure-says-what-to-do
gh pr create --repo devsuitup/switchboard --base main --title "fix(ui): say what to do when a save fails (#709)" --body-file <file>
gh pr merge <PR> --repo devsuitup/switchboard --squash --match-head-commit <head sha>
```

To catch up with `main`, or when a parallel PR touched `CHANGELOG.md`,
`git fetch origin` then `git merge origin/main`, keeping both entries. Never
rebase or force-push a pushed branch: a reviewer's read of a head must stay
valid, and the rulesets refuse non-fast-forward pushes to `main` and
`release/*` anyway.

## Cutting a beta

The examples cut `0.1.0-beta.4` from `main` onto `release/0.1`.

1. **Branch from `main` and bump.**

   ```bash
   git fetch origin
   git merge-base --is-ancestor origin/release/0.1 origin/main && echo ancestor
   git checkout -b bump/v0.1.0-beta.4 origin/main
   npm version --no-git-tag-version 0.1.0-beta.4   # package.json and package-lock.json: two "version" fields
   ```

   In `CHANGELOG.md`, rename `## Unreleased` to
   `## v0.1.0-beta.4 — <today, YYYY-MM-DD>` and open a new, empty
   `## Unreleased` above it ([Changelog](changelog.md)).

2. **Compare the dated sections with the release branch.** Every section older
   than the new one must be identical on both sides:

   ```bash
   git diff origin/release/0.1 -- CHANGELOG.md
   ```

   Only `## Unreleased` and the new section may differ (for a final, also the
   `## vX.Y.Z-beta.N` sections of the version being finalised, which it
   folds). An entry that shows up under an older heading did not ship in that
   release: move it to the new section ([Pitfalls](#pitfalls)).

3. **Commit, and bring the release branch in if it is not an ancestor.** When
   step 1 printed nothing, the last port-back was squashed:

   ```bash
   git commit -am "chore(release): v0.1.0-beta.4"
   git merge origin/release/0.1
   ```

   Resolve every conflict on the bump side: the new version, and a
   `CHANGELOG.md` whose older sections equal the release branch's. When
   `origin/release/0.1` already is an ancestor, the merge says
   `Already up to date.`

4. **Open the PR to the release branch and merge it with a merge commit.**

   ```bash
   git push origin bump/v0.1.0-beta.4
   gh pr create --repo devsuitup/switchboard --base release/0.1 --head bump/v0.1.0-beta.4 --title "chore(release): v0.1.0-beta.4" --body-file <file>
   gh pr view <PR> --repo devsuitup/switchboard --json headRefOid,mergeable,mergeStateStatus
   gh pr merge <PR> --repo devsuitup/switchboard --merge --match-head-commit <headRefOid>
   ```

   Say in the body that it is merged with a merge commit and why. Never
   `--squash` here, and never `--auto` without `--merge`.

5. **Tag the merge commit, push only the tag**, then build and publish
   ([Releasing](releasing.md#steps), steps 2–5):

   ```bash
   git fetch origin
   gh pr view <PR> --repo devsuitup/switchboard --json mergeCommit --jq .mergeCommit.oid
   git rev-parse origin/release/0.1      # must print the same commit
   git tag v0.1.0-beta.4 <merge commit>
   git push origin v0.1.0-beta.4
   ```

6. **Port it back** ([below](#port-back)).

### Maintenance beta

Once a line has diverged from `main` (`main` carries code this line must not
ship, typically `main` on `0.2` while `release/0.1` takes `0.1.1`), a beta cut
from `main` would bring that code in. Then the line's fixes arrive only as
[backports](#backports), and the beta's bump branch starts at
`origin/release/0.1`, as the final does:

```bash
git fetch origin
git checkout -b bump/v0.1.1-beta.1 origin/release/0.1
npm version --no-git-tag-version 0.1.1-beta.1
# CHANGELOG.md: rename ## Unreleased (the backports' entries) to ## v0.1.1-beta.1 — <today>, new empty ## Unreleased
git commit -am "chore(release): v0.1.1-beta.1"
git push origin bump/v0.1.1-beta.1
gh pr create --repo devsuitup/switchboard --base release/0.1 --head bump/v0.1.1-beta.1 --title "chore(release): v0.1.1-beta.1" --body-file <file>
gh pr merge <PR> --repo devsuitup/switchboard --merge --match-head-commit <headRefOid>
```

Steps 5 and 6 above are unchanged. Never cut a beta of a diverged line from
`main`.

## Cutting the final

The final `0.1.0` may differ from the last beta only by `package.json`,
`package-lock.json` (their `version` fields) and `CHANGELOG.md`; the tag check
of `build.yml` refuses anything else ([Releasing](releasing.md#the-tag-check)).
It comes at least 24 hours after that beta, and only on the maintainer's
explicit go.

So the final's bump branch starts at `origin/release/0.1`, **not** at
`origin/main`: whatever `main` took since the beta would make the final
differ from it. A fix that must be in `0.1.0` is a new beta first.

```bash
git fetch origin
git checkout -b bump/v0.1.0 origin/release/0.1
npm version --no-git-tag-version 0.1.0
# CHANGELOG.md: fold every ## v0.1.0-beta.N section into one ## v0.1.0 — <today>
git commit -am "chore(release): v0.1.0"
git push origin bump/v0.1.0
gh pr create --repo devsuitup/switchboard --base release/0.1 --head bump/v0.1.0 --title "chore(release): v0.1.0" --body-file <file>
gh pr merge <PR> --repo devsuitup/switchboard --merge --match-head-commit <headRefOid>
```

Then tag the merge commit as in step 5 above, publish with
`--prerelease=false --latest` ([Releasing](releasing.md#steps), step 6), and
port it back.

## Port-back

After every beta and final, the release branch goes back to `main` by a PR
merged with a merge commit. It brings `main` the release's version and its
dated `CHANGELOG.md` section, and makes `release/0.1` an ancestor of `main`.

The port-back branch is created **at the tag**, so the PR's history contains
the release commit itself. A branch cut from `main` that repeats the bump
(as `bump/port-back-v0.1.0-beta.3`, #1293, did) restores no ancestry even
with a merge commit.

```bash
git fetch origin
git checkout -b bump/port-back-v0.1.0-beta.4 v0.1.0-beta.4
git merge origin/main
```

Resolve `CHANGELOG.md` by adding, never by replacing: keep every section
`main` has, its `## Unreleased` entries that the release does not contain and
its own newer sections (a `## v0.2.0-beta.N` when `0.1.1` comes back), and
add the release's dated section in version order. Remove only what the
release supersedes: the `## Unreleased` entries its section contains, and for
a final the `## vX.Y.Z-beta.N` sections of that same version. Keep the
release's version, unless `main`'s `package.json` is already higher.
Then:

```bash
git push origin bump/port-back-v0.1.0-beta.4
gh pr create --repo devsuitup/switchboard --base main --head bump/port-back-v0.1.0-beta.4 --title "chore(release): port v0.1.0-beta.4 back to main" --body-file <file>
gh pr merge <PR> --repo devsuitup/switchboard --merge --match-head-commit <headRefOid>
git fetch origin
git merge-base --is-ancestor origin/release/0.1 origin/main && echo ancestor
```

The last command must print `ancestor`.

## First beta of a new minor line

`release/X.Y` is created at the first beta's tag, never at the tip of `main`
(`release/0.1` was cut at `v0.1.0-beta.2`). That first beta's bump PR has base
`main`; its merged commit is tagged, and the branch is created at the tag.
Both the tag and the branch push are admin acts (`release-tags` and the
`creation` rule of `release-protection`):

```bash
git push origin 'v0.2.0-beta.1^{commit}:refs/heads/release/0.2'
```

`do_not_enforce_on_create` lets that push through without the required
checks. There is nothing to port back.

## Backports

The usual path for a fix is the next beta cut from `main`, which carries
every fix `main` has. A backport is for a line that has diverged from `main`
(for instance `0.1.1` once `main` is on `0.2`), and its beta is then a
[maintenance beta](#maintenance-beta).

The rule: a backport is a `git cherry-pick -x` of a commit already merged on
`main`, never a fix written on the release branch first. The fix PR goes to
`main`, is squashed there, and only that squash commit is cherry-picked; the
`-x` trailer names it, so every backport is also on `main` and nothing ships
from a release branch that `main` lacks. This is enforced by the PR mode of `scripts/check-release-provenance.js`, run by the `release-provenance` job of `.github/workflows/release-provenance.yml` on every PR into `release/*`
([Protection](#protection): not yet a required check, and not yet on
`release/0.1`, #1318).

```bash
git fetch origin
git checkout -b backport/1300-to-0.1 origin/release/0.1
git cherry-pick -x <squash commit on main>
git push origin backport/1300-to-0.1
gh pr create --repo devsuitup/switchboard --base release/0.1 --head backport/1300-to-0.1 --title "fix(area): subject (#1300)" --body-file <file>
gh pr merge <PR> --repo devsuitup/switchboard --merge --match-head-commit <headRefOid>
```

The cherry-pick brings the fix's changelog entry: keep it under the release
branch's `## Unreleased`, and only that entry when the hunk conflicts. The
merge commit keeps the cherry-pick, and its trailer, as it is. Fixes never
reach a release branch by a direct push.

## Pitfalls

- **A squashed port-back.** #1293 (the `0.1.0-beta.3` port-back) was
  squashed: `main` got a new commit on `184e29fc`, and `release/0.1`
  (`fd73a33e`) stopped being an ancestor of `main`. The `0.1.0-beta.4` cut,
  #1312, then came up `CONFLICTING` on the version and `CHANGELOG.md`, both
  sides having changed them since `184e29fc`. It was fixed by merging
  `origin/release/0.1` into the bump branch and resolving on the bump side.
- **An entry under the wrong dated section.** A PR merged on `main` after a
  cut can have its `CHANGELOG.md` entry land under the cut's dated heading,
  where git's text merge put it. The sandbox fix (#1290, entry `(#513)`)
  sits under `## v0.1.0-beta.3` on `main`, though `v0.1.0-beta.3` does not
  contain it; #1312 moves it to the beta.4 section. Step 2 of each cut
  catches it.
- **Parallel PRs touching `CHANGELOG.md`.** Merge `origin/main` into the
  branch and keep both entries. No rebase, no force-push.
- **Tagging the wrong commit.** Tag the merge commit on `release/X.Y`, never
  the bump branch's own commit, which is not on the release branch.
- **A backport, then a cut.** The next cut from `main` brings the original
  fix again; check that its `CHANGELOG.md` entry appears once.
