# Releasing

A release is a version tag on a release branch, `release/X.Y`. A beta's bump
branch starts at `main` and reaches the release branch through a pull request
merged with a merge commit; the tag goes on that merge commit, and the release
then returns to `main` through a port-back PR, also merged with a merge
commit. Branch kinds, protection, merge methods and the cut and port-back
commands are in [Branches](branching.md).

Every `gh` command run by hand in this clone needs `--repo devsuitup/switchboard`:
gh's default here is the upstream repository, `doctly/switchboard`.

## Betas and finals

Every version ships twice (maintainer decision, #1199):

- **Betas** `vX.Y.Z-beta.N` (N from 1) are GitHub pre-releases. Only installs
  with **Receive beta versions** on are offered them.
- The **final** `vX.Y.Z` is rebuilt from a commit that differs from the last
  beta tag only by `package.json`, `package-lock.json` (their `version` fields)
  and `CHANGELOG.md`. CI checks this before it publishes
  ([The tag check](#the-tag-check)). It is published as the latest release,
  and both channels are offered it.

No other tag shape is accepted: `-rc.N` and other identifiers strand beta
installs ([Update channels](#update-channels)).

The beta rule starts with the first beta of a version: a final with no
`vX.Y.Z-beta.N` tag of its own version, as every release up to `v0.0.N` was,
is checked for release-branch provenance, its tag shape and `package.json`
version. That keeps a plain final releasable; the next version, `0.1.0`, ships as `0.1.0-beta.1`
first (maintainer decision, 2026-11-24).

## Release branches

`main` never freezes: it takes every PR at any time (maintainer decision,
2026-11-25). Stabilisation happens on `release/X.Y`, one branch per minor
line. Betas, finals and hotfixes (`vX.Y.1-beta.1`, then `vX.Y.1`) are tagged
from it.

- **Create.** `release/X.Y` is created at a release tag, not at the tip of
  `main`, and only by an admin (the `creation` rule of `release-protection`).
  `release/0.1` was created at `v0.1.0-beta.2`. A new minor line enters
  through its first beta: its bump PR lands on `main`, the merged commit is
  tagged locally, and the branch is pushed before the tag so CI can verify
  its provenance:

  ```bash
  git push origin 'v0.2.0-beta.1^{commit}:refs/heads/release/0.2'
  git push origin v0.2.0-beta.1
  ```

- **Cut a beta from `main`.** While the line has not diverged from `main`,
  each later beta brings the whole of `main` onto the release branch:
  `bump/vX.Y.Z-beta.N` from `origin/main`, PR to `release/X.Y`, **merged with
  a merge commit** (the only method `release-protection` allows), so `main`
  stays an ancestor of `release/X.Y` (#1292, #1312). This is how fixes
  normally reach a release line.
- **Cut a maintenance beta from the release branch.** Once `main` carries code
  the line must not ship (a `vX.Y.1` once `main` is on the next minor), the
  line takes only backports, and its beta's bump branch starts at
  `origin/release/X.Y`, like the final
  ([Branches](branching.md#maintenance-beta)). Never cut a beta of a diverged
  line from `main`: it would bring that code in.
- **Cut the final from the release branch.** `bump/vX.Y.Z` starts at
  `origin/release/X.Y`, since the final may differ from the last beta only by
  its version and changelog ([The tag check](#the-tag-check)). Same PR and
  merge commit.
- **Port back.** After each beta and final, a `bump/port-back-v…` branch
  created at the tag goes to `main` by a PR **merged with a merge commit**, so
  `release/X.Y` stays an ancestor of `main` and the next cut merges cleanly.
  #1293 was squashed instead, and the next cut, #1312, came up conflicting
  ([Branches](branching.md#pitfalls)).
- **Backport.** For a fix that must ship on a diverged line, the fix lands in
  `main` first, then its squash commit is cherry-picked with `-x` onto a
  branch cut from the release branch, and opened as a PR whose base is the
  release branch, merged with a merge commit. Never write a fix on the
  release branch first: every commit a PR brings into `release/*` must
  already be on `main`, unless it is a verified two-parent merge, the version and
  changelog bump, or a cherry-pick whose `-x` trailer and patch or changed
  file set match a commit on `main` (see [Release provenance](#release-provenance)); this is enforced by the PR mode of `scripts/check-release-provenance.js`, run by the `release-provenance` job of `.github/workflows/release-provenance.yml` on every PR into `release/*` (not yet a required check, and
  not yet on `release/0.1`, #1318). The line's next beta is then a
  maintenance beta:

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
  merge commit keeps the cherry-pick and its `cherry picked from commit`
  trailer as they are.
- **Every code change on the branch ships in a new beta before the final.**
  From the last beta tag until the final tag, `release/X.Y` takes **only the
  release PR**; anything else merged in between makes the final differ from
  the beta, the tag check fails, and the fix is another beta. Only the release
  branch waits, never `main`.
- **Branch names.** Bump branches are `bump/vX.Y.Z…`, port-back branches
  `bump/port-back-vX.Y.Z…`, cherry-pick branches `backport/…`. Never
  `release/…`: the ruleset matches `release/*`, so such a working branch could
  not be pushed to again or deleted.
- **One minor line in betas at a time.** A beta install takes the newest entry
  of the releases feed, not the highest version: publishing `v0.1.1-beta.1`
  after `v0.2.0-beta.1` hides the latter from beta installs until the next
  publication. Publish a final of an older line with `--latest=false` once a
  newer final exists.

**CI on a release branch.** `test.yml` (PRs and pushes), `build.yml` and
`pr-title.yml` (PRs) run for `release/*` as for `main`. GitHub reads a pull
request's workflows from the PR merged into its base: a PR to a release branch
runs CI only if that branch, or the PR itself, carries these triggers. A
branch created before they existed has none, and without its checks a PR
cannot merge; it gets them in its next beta, never straight in a final: the
tag check refuses a final that differs from its last beta by a workflow file.
`release/0.1`, created at `v0.1.0-beta.2`, got them with the `0.1.0-beta.3`
cut from `main` (#1292).

## Steps

The examples cut `0.1.0-beta.4` onto `release/0.1`, then the final `0.1.0`.
The first beta of a new minor line is the exception: its bump PR has base
`main`, and its tag is where the release branch is created. The full
commands, with the ancestry checks around them, are in
[Branches](branching.md#cutting-a-beta).

1. **Bump the version and date the changelog** on a bump branch, and open the
   PR to `release/0.1`. A beta's branch starts at `origin/main`; a maintenance
   beta's, on a line diverged from `main`, and the final's at
   `origin/release/0.1`. In [`CHANGELOG.md`](../CHANGELOG.md) (see
   [Changelog](changelog.md)):
   - for a **beta**, rename `## Unreleased` to
     `## v0.1.0-beta.4 — <today, YYYY-MM-DD>`, and open a new, empty
     `## Unreleased` above it. The next beta's section holds only what changed
     since this one.
   - for the **final**, `## Unreleased` must be empty (anything in it shipped
     after the last beta). Fold every `## v0.1.0-beta.N` section into one
     `## v0.1.0 — <today>` section: merge their entries by group, drop the
     entries about a problem only a beta ever had, and delete the beta
     headings. The final section says what changed since the previous final.

   Read the section once more: it becomes the release notes as it stands.
   Then compare it with the release branch: every older dated section must be
   identical on both sides (`git diff origin/release/0.1 -- CHANGELOG.md`),
   except, for a final, the `## v0.1.0-beta.N` sections it folds, which the
   tag check requires gone. An entry merged on `main` after the previous cut
   can sit under that cut's heading although the release does not contain
   it.

   ```bash
   git fetch origin
   git checkout -b bump/v0.1.0-beta.4 origin/main
   npm version --no-git-tag-version 0.1.0-beta.4   # package.json and package-lock.json
   # edit CHANGELOG.md as above
   git diff origin/release/0.1 -- CHANGELOG.md
   git commit -am "chore(release): v0.1.0-beta.4"
   git merge origin/release/0.1   # "Already up to date." unless the last port-back was squashed
   git push origin bump/v0.1.0-beta.4
   gh pr create --repo devsuitup/switchboard --base release/0.1 --head bump/v0.1.0-beta.4 --title "chore(release): v0.1.0-beta.4" --body-file <file>
   ```

   For the final, the same with `0.1.0` from `origin/release/0.1`. Bump
   `package.json` and the lock only with `npm version`: the tag check refuses
   any other change to them.

   `test/changelog.test.js` fails when `CHANGELOG.md` has no section for the
   version in `package.json`, or still has beta sections beside their final,
   so a bump without its section does not pass CI.

   Commit subjects and PR titles use `type(area): subject`; the release title
   is `chore(release): v0.1.0` (`chore(release): v0.1.0-beta.4` for a beta).
   The separate `pr-title` check is advisory during rollout and is not a
   required release check.

   The required PR checks for this workflow are `lint`,
   `test (20, ubuntu-latest)`, `test (22, ubuntu-latest)`,
   `test (22, windows-2022)`, `changelog` and `e2e`: ruleset 17240725
   (`main-protection`) requires all six, and the classic branch protection on
   `main` requires the same list minus `changelog`. Ruleset 28112036
   (`release-protection`) covers `refs/heads/release/*`: it requires a PR and
   the same six checks, and forbids deletion and force-push; creating a branch
   does not need the checks. Build is not required.
   Required checks and review requirements are GitHub repository settings,
   separate from these workflow definitions: keep both rulesets and the branch
   protection aligned whenever the test matrix changes. No approving review is
   required. Merge the bump PR **with a merge commit**, naming the head you
   checked, never with a squash:

   ```bash
   gh pr view <bump PR> --repo devsuitup/switchboard --json headRefOid,mergeable,mergeStateStatus
   gh pr merge <bump PR> --repo devsuitup/switchboard --merge --match-head-commit <headRefOid>
   ```

   CI-only PRs use the `no-changelog` label.

2. **Run the app before tagging.** The tag is what publishes, and nothing
   between the merge and the tag looks at the assembled whole; the test suite
   does not see layout, a control drawn in the wrong colour, or raw tool output
   in a locale. Launch the merged `release/0.1` in an isolated instance and use it — see
   [Testing a PR live](testing-a-pr.md) and
   [Live testing with a throwaway HOME](live-testing.md).

3. **Tag the merge commit** on `release/0.1` and push only the tag. Only an
   admin can (ruleset 28267436 `release-tags` on `refs/tags/v*`: creation,
   update and deletion are restricted, so nobody else moves or deletes a
   release tag either). The tag is released only when its commit is on a
   `release/*` branch, enforced by the tag mode of `scripts/check-release-provenance.js`, run by `build.yml`'s `release-tag` job on the tag push:

   ```bash
   git fetch origin
   gh pr view <bump PR> --repo devsuitup/switchboard --json mergeCommit --jq .mergeCommit.oid
   git rev-parse origin/release/0.1   # the same commit, unless the branch moved since
   git tag v0.1.0-beta.4 <that commit>
   git push origin v0.1.0-beta.4
   ```

   Name the commit rather than a branch tip, which may have moved since.

4. **Wait for the build.** The tag starts `.github/workflows/build.yml`. Its
   `release-tag` job runs the provenance tag mode and [the tag check](#the-tag-check) while the packages
   build; publish needs both. The builds run on macOS
   (macos-15), Windows (windows-2022), and Linux x64 and arm64 on separate
   runners. Packaging-related pull requests and manual dispatches build only
   Windows and both Linux architectures; macOS remains part of every tag push
   build. A dispatch never publishes, even on a tag ref. For a PR installer,
   see [Testing a PR live](testing-a-pr.md#obtaining-a-pr-installer).
   Each build job retains its 60-minute timeout for native rebuilds and
   multi-architecture packaging; publish has a 10-minute timeout.
   The publish job keeps `needs: build`: all matrix entries must succeed before
   it runs. If macOS fails, is cancelled or times out, nothing is published
   automatically, even when Windows and Linux succeed.

   Tag artifacts are downloaded by publish in the same run and retained for
   14 days (PR artifacts: 3 days). Only older runs of the same PR are cancelled
   by its newer runs; tag and branch pushes never cancel in-progress runs.

   To recover, re-run the failed macOS job in the tag's Actions run (or re-run
   failed jobs) and let the dependent publish job run once every build succeeds.
   Alternatively, create the release draft by hand using only artifacts from
   that tag's successful builds. In Bash, replace `<run>` with the tag's Actions
   run ID and `<x.y.z>` with its version:

   ```bash
   gh run download <run> --repo devsuitup/switchboard --dir .work-files/release-artifacts-v<x.y.z>
   ```

   The download directory must not exist yet. Merge its `dist-*` artifact
   directories into one fresh directory containing only the assets to upload.
   Keep both Linux pacman packages: `switchboard-doctly-<v>-x64.pacman`
   from `dist-linux-x64` and `switchboard-doctly-<v>-aarch64.pacman` from
   `dist-linux-arm64`. Their distinct names let both coexist in the merged
   directory. Verify that `latest-linux.yml` and `latest-linux-arm64.yml`
   reference their respective packages with matching sizes and hashes. If macOS
   artifacts are absent, omit `latest-mac.yml`. Never copy a previous release's
   mac manifest: upload it only when its version, filenames, sizes and hashes
   match the macOS files actually attached to this release.

   Create or complete the draft from the merged directory (`<dir>`):

   ```bash
   GITHUB_REPOSITORY=devsuitup/switchboard GITHUB_REF_NAME=v<x.y.z> DIST_DIR=<dir> bash scripts/publish-release.sh
   ```

   Both GitHub variables must be set and non-empty; the script refuses before
   calling gh otherwise. It reads and writes the explicitly named repository.
   From a checkout containing the tag's `CHANGELOG.md`, extract and attach its
   notes, then inspect the draft's asset names and sizes:

   ```bash
   node scripts/changelog-section.js v<x.y.z> > .work-files/release-notes.md
   PREV_TAG="$(git describe --tags --abbrev=0 v<x.y.z>^)"
   printf '\n**Full changelog**: https://github.com/devsuitup/switchboard/compare/%s...v<x.y.z>\n' "$PREV_TAG" >> .work-files/release-notes.md
   gh release edit v<x.y.z> --repo devsuitup/switchboard --notes-file .work-files/release-notes.md
   gh release view v<x.y.z> --repo devsuitup/switchboard --json assets --jq '.assets[] | {name, size}'
   ```

   Check those assets against the merged directory and verify the update
   manifests before publishing the draft as described below.

   After all builds and the tag check succeed, the publish job:
   - creates a **draft** release named after the version, flagged pre-release
     when the tag has a `-` (a beta) and not otherwise, sets the same flag on a
     draft a previous run left, and reads the draft back: it uploads nothing
     unless the release reads back as a draft with that flag;
   - uploads each artifact separately, retrying each up to five times — 20
     assets for a full build (dmg, zip and their blockmaps for arm64 and x64; the
     Windows installer and its blockmap; two AppImages, two debs, two pacman
     packages (`-x64.pacman` and `-aarch64.pacman`); four `latest*.yml` update manifests);
     measured on v0.1.0-beta.3 (2026-11-27): 9 of the 20 are macOS (two `.dmg`,
     two `.zip`, their four `.blockmap` and `latest-mac.yml`), so a release
     drafted without macOS has 11;
   - writes the release notes: the text of the tag's `CHANGELOG.md` section,
     without its heading (`scripts/changelog-section.js`), then a **Full
     changelog** link comparing the previous tag with this one (for a final,
     the previous final, skipping its betas). The previous tag is looked up
     on the tag's own history. Once an older line's releases are ported back
     with a merge commit, its tags are in `main`'s history and a new line
     sees them; when a port-back was squashed or skipped, the first beta of a
     new minor line and that line's `X.Y.0` final do not, so check their
     compare link in the draft and correct it by hand. It fails
     rather than publish an empty body when the section is missing or empty.
     The fix is then in `CHANGELOG.md`, through a PR to the release branch; `gh release edit
     --repo devsuitup/switchboard --notes-file` can fill in the draft by hand meanwhile.

   Re-running CI while the release is a draft is fine: it completes or replaces
   the draft's assets. CI refuses to publish if it cannot read the releases,
   and never writes to a published release. Once published, add or replace an
   asset by hand with `gh release upload --repo devsuitup/switchboard --clobber` (see below), or tag a new
   version. A draft may be deleted while it is still a draft; a tag is never
   moved or deleted ([Fork release-flow gotchas](#fork-release-flow-gotchas)).
   The workflow token has `contents: read`; only the publish job has
   `contents: write`, and no checkout persists credentials.

5. **Publish a beta draft**, after checking its assets and its flag:

   ```bash
   gh release view v0.1.0-beta.4 --repo devsuitup/switchboard --json assets,isPrerelease --jq '{assets: (.assets | length), isPrerelease}'
   gh release edit v0.1.0-beta.4 --repo devsuitup/switchboard --draft=false --prerelease
   gh api repos/devsuitup/switchboard/releases/latest --jq .tag_name   # must not contain "-"
   ```

   Installed copies with **Receive beta versions** and automatic updates on
   pick the release up from its `latest*.yml` manifests; a draft is invisible
   to them. The pre-release flag is the only thing that keeps the beta from
   stable installs: if the last command prints a `-beta` tag, set the flag
   again at once (`gh release edit <tag> --repo devsuitup/switchboard --prerelease`) and mark the previous
   final `--latest`. On their first start after the update, the What's new
   dialog shows this section, and those of any version they skipped.

   Fixes found on beta land in `main` and ship in the next beta cut from it,
   `0.1.0-beta.5`, and so on, through steps 1–5 and 7 (a backport only when
   `main` carries something the line must not ship,
   [Release branches](#release-branches)).

6. **Cut the final**, only on the maintainer's go. First require at least
   24 hours of use on the last beta and no open issue labelled `regression`
   for it. Inspect the open regression issues and confirm which version each
   affects:

   ```bash
   gh issue list --repo devsuitup/switchboard --state open --label regression --limit 1000
   ```

   Then steps 1–4 again with `0.1.0`, its bump branch from
   `origin/release/0.1`, the release branch having taken nothing since the
   last beta tag; what `main` took meanwhile does not matter, because the final
   is not cut from it. The tag check compares the tag with `v0.1.0-beta.<last>`
   and fails the run before publish when anything else differs. Publish the
   final draft as the latest release:

   ```bash
   gh release view v0.1.0 --repo devsuitup/switchboard --json assets,isPrerelease --jq '{assets: (.assets | length), isPrerelease}'
   gh release edit v0.1.0 --repo devsuitup/switchboard --draft=false --prerelease=false --latest
   gh api repos/devsuitup/switchboard/releases/latest --jq .tag_name   # must print v0.1.0
   ```

   Stable installs are offered it, and so are beta installs: the beta channel
   moves from `0.1.0-beta.N` to `0.1.0`.

7. **Port the release back to `main`**, after every beta and final, from a
   branch created **at the tag**, merged **with a merge commit**:

   ```bash
   git fetch origin
   git checkout -b bump/port-back-v0.1.0-beta.4 v0.1.0-beta.4
   git merge origin/main
   git push origin bump/port-back-v0.1.0-beta.4
   gh pr create --repo devsuitup/switchboard --base main --head bump/port-back-v0.1.0-beta.4 --title "chore(release): port v0.1.0-beta.4 back to main" --body-file <file>
   gh pr merge <port-back PR> --repo devsuitup/switchboard --merge --match-head-commit <headRefOid>
   git fetch origin
   git merge-base --is-ancestor origin/release/0.1 origin/main && echo ancestor
   ```

   When `git merge origin/main` conflicts on `CHANGELOG.md`, keep under
   `## Unreleased` the entries `main` took after the cut, and the dated
   sections as the release branch has them; for a final, that drops the
   `## v0.1.0-beta.N` sections it folds. Keep the release's version unless
   `main`'s is already higher: `test/changelog.test.js` needs a section for
   the version in `package.json`. The last command must print `ancestor`; if
   it does not, the next cut merges `origin/release/0.1` into its bump branch
   ([Branches](branching.md#pitfalls)). A first beta tagged on `main` has
   nothing to port.

## The tag check

The `release-tag` job of `build.yml` runs
`node scripts/check-release-tag.js "$GITHUB_REF_NAME"` on a checkout with
every tag, on each tag push, and `publish` needs it. It fails (exit 1) when:

- the tag is not `vX.Y.Z` or `vX.Y.Z-beta.N` (N from 1, no leading zero);
- `package.json` at the tag does not carry the tag's version;
- for a final `vX.Y.Z` with at least one `vX.Y.Z-beta.N` tag:
  `git diff --name-only --no-renames <last beta> <tag>` lists any file besides
  `CHANGELOG.md`, `package.json` and `package-lock.json`; or `package.json`
  or the lock differ from the beta's by more than their version fields; or
  the tag's `CHANGELOG.md` has no `## vX.Y.Z` section, or still has a
  `## vX.Y.Z-beta.N` one.

A final with no beta tag of its version skips the third point (diff,
package/lock comparison, changelog section and fold) and passes on the first
two plus release-branch provenance; the job
logs `no vX.Y.Z-beta.N tag, so no beta comparison`. Betas of other versions do
not count.

The last beta is the highest N among the existing tags, compared as a number.
The diff compares the two trees, whatever the history between them. Exit 2 is
a usage error or a git failure, a tag that names no commit included; a file
missing at an existing tag is a contract failure (exit 1).
`test/check-release-tag.test.js` covers each case and runs the script on a
temporary repository.

### Release provenance

The maintainer's rule (2026-11-27) is enforced by
`scripts/check-release-provenance.js`, using only Node built-ins. Both jobs
fetch `origin/main`, extract its checker with
`git show origin/main:scripts/check-release-provenance.js` into
`$RUNNER_TEMP/check-release-provenance.js`, and execute that copy from the
repository working directory. The PR or tag cannot replace the checker
through edits to its checked-out script. The checker must land on main
before these workflows run; a missing main copy fails the job.

The workflow files are the boundary that is not covered: `pull_request` reads
`release-provenance.yml` and `build.yml` from the PR's merge ref, so a PR into
`release/*` can edit either to remove or replace the invocation, and its run
then checks nothing. A tag push likewise runs the `build.yml` of the tagged
commit. Moving the PR check to `pull_request_target` once `release/*` carries
the workflow is tracked in #1318; until then, review every change to these
two files in a PR into `release/*`.

- On every tag push, `release-tag` explicitly fetches `origin/release/*`
  and runs `node "$RUNNER_TEMP/check-release-provenance.js" tag "$GITHUB_REF_NAME"`
  before the version/beta check. The tag's peeled commit must be reachable
  from at least one fetched release branch; an ancestor is sufficient.
  This also applies to betas and finals without a previous beta.
- On PRs into `release/*`, the `release-provenance` job fetches `origin/main`
  and the release branches and checks every commit in
  `origin/<base>..<PR head SHA>`, including commits brought by a merge.
  A commit passes if it is reachable from `origin/main`, is a checked two-parent merge,
  is a bump limited to the root `CHANGELOG.md`, `package.json` and/or
  `package-lock.json`, or has a standalone
  `(cherry picked from commit <sha>)` line from `git cherry-pick -x` whose
  full source SHA is reachable from `origin/main` and passes the content check below.
  A bump may change `CHANGELOG.md` freely. Package JSON is compared with
  its parent after deleting only `version`; the lock comparison deletes
  only root `version` and `packages[""].version`. All remaining parsed JSON
  must be equal, so scripts and dependencies cannot be changed as a bump.
  Missing or invalid package JSON does not qualify. Empty non-main commits
  do not count as bumps. Renames include both paths.
  Failures list every offending commit: land the fix on main first and
  backport it with `-x`.

For a two-parent merge outside main, the PR check reconstructs the automatic
merge with `git merge-tree --write-tree <p1> <p2>` (Git 2.38 or newer).
It compares that tree with the recorded merge tree. Differences are allowed
only in the three bump files, with the same version-only JSON rule. Any
automatic conflict outside those files fails and names the hand-resolved
paths, even if the resolution chose one parent's contents. Conflicted
package files must match both parents after removing the allowed version
fields; this fails closed if the parents also differ in scripts or
dependencies. Changelog conflicts may be resolved freely. Octopus merges
(more than two parents) fail explicitly. Incoming parent histories are still
checked, so a clean merge cannot hide an unported commit.

For a `-x` trailer naming a source on main, the check compares both commits'
`git patch-id --stable` values. An equal, non-empty patch ID passes. When
patches differ, a conflict-resolved cherry-pick is allowed only if every
changed path also occurs in the source's changed file set. Otherwise the
failure says that the trailer does not match its source. Renames count both
paths. This fallback permits adapted content within those paths; it does
not prove semantic equivalence or that a conflict actually occurred.

The PR check compares ordinary bumps to their parent; the final-tag check
compares package files to the last beta. Exit 1 means a rule violation;
exit 2 means invalid usage or unreadable Git inputs, including unsupported
Git. Both block the job. Full checkout history and the explicit fetch of
main and release refs supply the merge parents and reachable cherry-pick
sources; no shallow fetch is used.

Only items 2 and 3 of #1318 are addressed here. Items 1, 4 and 5 remain open:
workflow trust, requiring the provenance check, and getting the workflow onto
the existing release line are not solved by these content checks.

Release PRs use merge commits, preserving the checked commits and their
`-x` lines. The maintainer configured `release/*` as merge-commit only and
creation, update and deletion of `v*` tags as admin-only. `release-provenance` is not yet a required check, and `release/0.1` gets the workflow only at its next cut from `main` (#1318):
making it required is a separate repository setting, and until that cut a PR
into `release/0.1` runs it only if the PR itself carries the workflow (a cut
from `main` does). Local tests do not verify these GitHub settings or runs.

## Update channels

How electron-builder 26.8.1 and electron-updater 6.8.9 treat a `-beta.N`
version with the GitHub provider (read in their sources, #1199):

- The build writes only `latest*.yml` manifests, for betas too: for the
  GitHub provider the channel list is always the single `latest` one, so the
  20 assets keep the same names apart from the version.
- A **stable** install (`allowPrerelease` false) asks GitHub for its latest
  release, which is never a pre-release or a draft. It never sees a beta
  that carries the pre-release flag. An unflagged beta is an ordinary release
  and does reach stable installs.
- A **beta** install still on a final version takes the newest entry of the
  releases feed, beta or final. It first asks for `beta*.yml`, which does not
  exist, and falls back to `latest*.yml`.
- A **beta** install on `X.Y.Z-beta.N` takes the newest feed entry whose tag
  is a final or a `beta` pre-release (`alpha` is skipped), so it moves on to the next beta
  or to the final `X.Y.Z`. A `-rc.N` tag would be skipped by it, and an
  install on `-rc.N` would only follow other `-rc` tags: hence `-beta.N` only.
- Nothing downgrades: Switchboard never sets the updater's `channel`, which
  would turn `allowDowngrade` on. An install on a beta whose owner turns beta
  off stays on it until a higher final is published.

`npm run release` builds for the local platform only and publishes through
electron-builder; it needs `GH_TOKEN` (a token with `repo` scope).

## Withdraw a stable release

On the maintainer's go, set the affected release back to pre-release:

```bash
gh release edit v0.1.0 --repo devsuitup/switchboard --prerelease
gh release edit v0.0.99 --repo devsuitup/switchboard --latest   # the previous stable
```

Stable installs stop being offered the withdrawn version; new installs get the
previous stable release. A stable install that already downloaded the withdrawn
version still installs it at its next quit. Installs already on the withdrawn version keep it: never
downgrade, because the SQLite cache only migrates forward. Fix forward with a
beta of the next version (`v0.1.1-beta.1`, from `release/0.1`), then its final
through the same gate. Beta installs can still receive a withdrawn release, now a pre-release.

## Fork release-flow gotchas

- **Push with an explicit remote.** A clone whose `main` tracks `upstream`
  (`doctly/switchboard`) sends a bare `git push` there, which fails on
  permissions. `git push origin …` always targets the fork.
- **Direct pushes to `main` and `release/*` are rejected** by the rulesets: the
  bump goes through a PR. Release branches and `v*` tags are created by an
  admin only, and a release tag is never moved or deleted.
- **Tag the merge commit, never the local bump commit.** The merge makes a new
  commit on the release branch, which is what the branch ships. A tag on the
  bump branch's own commit is not the release branch's tip, names a different
  tree whenever the release branch held something the bump branch did not, and
  points at nothing that was merged if the PR changes before it lands.
- **A wrong tag is never reused.** Cancel its build
  (`gh run cancel <id> --repo devsuitup/switchboard`); never publish its draft,
  and delete the draft release if the build created one
  (`gh release delete <tag> --repo devsuitup/switchboard`, which leaves the tag
  in place); then tag the right commit under the next version (the next beta
  number), whose version bump goes through the normal cut. The admin bypass of
  `release-tags` technically allows deleting or moving a tag; the project does
  not use it for release tags.
- **Unsigned macOS builds need `"mac": {"identity": null}` and
  `"notarize": false` in `package.json`.** electron-builder reads a `CSC_LINK`
  that is set but empty as a certificate path; `stat('')` resolves to the
  working directory, and the mac job fails with `… not a file` on tag builds
  only. Setting `CSC_IDENTITY_AUTO_DISCOVERY` according to whether the secret
  exists does not avoid it; `identity: null` does.
- **A single asset upload can fail with a 401** from `uploads.github.com`
  (often a `.blockmap`). The workflow retries each file; if one is still
  missing, upload it by hand:
  `gh release upload v0.1.0 <file> --clobber --repo devsuitup/switchboard`.
