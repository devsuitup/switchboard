Perform a release for this project, following [docs/releasing.md](../../docs/releasing.md). Always push with an explicit remote (`git push origin …`): a clone whose `main` tracks `upstream` would send a bare `git push` to `doctly/switchboard`. Steps:

1. Find the most recent version tag with `git fetch origin --tags && git describe --tags --abbrev=0 origin/main`, and read the commits since it: `git log {prev_tag}..origin/main --format="%B---"`. Check that every user-visible change among them has its entry under `## Unreleased` in `CHANGELOG.md` (the rule is in [docs/changelog.md](../../docs/changelog.md)); if one is missing, show the user the entry you would add and add it in the bump PR.
2. Bump the version on a release branch, never on `main` (the ruleset rejects direct pushes). In `CHANGELOG.md`, rename `## Unreleased` to `## v{version} — {today, YYYY-MM-DD}` and open a new, empty `## Unreleased` above it:
   ```bash
   git checkout -b release/v{version} origin/main
   npm version patch --no-git-tag-version      # or the version asked for
   # edit CHANGELOG.md as above
   git commit -am "v{version}"
   git push origin release/v{version}
   ```
   Do **not** tag this commit: a squash merge replaces it, and a tag on it would not be on `main`.
3. Open the PR and merge it once the required checks pass:
   ```bash
   gh pr create --repo devsuitup/switchboard --base main --head release/v{version} --title "v{version}" --fill
   gh pr merge --repo devsuitup/switchboard --squash --auto release/v{version}
   ```
   Wait until `gh pr view --repo devsuitup/switchboard release/v{version} --json state` reports `MERGED`.
4. Update the local `main` to the merged commit:
   ```bash
   git checkout main
   git fetch origin
   git reset --hard origin/main
   ```
5. **Run the app before tagging.** The tag is what publishes. Launch the merged `main` in an isolated instance and ask the user to use it — see [docs/testing-a-pr.md](../../docs/testing-a-pr.md) and [docs/live-testing.md](../../docs/live-testing.md). Tag only once they confirm.
6. Tag the merged commit and push the tag alone (never `--tags`, which would push every local tag):
   ```bash
   git tag v{version} origin/main
   git push origin v{version}
   ```
   Pushing the tag starts `.github/workflows/build.yml`.
7. Watch the build: `gh run list --repo devsuitup/switchboard --workflow build.yml --limit 1`, then `gh run watch <id> --repo devsuitup/switchboard`. Its publish job creates a draft release, uploads the assets, and writes the release notes: the tag's `CHANGELOG.md` section, then a full-changelog compare link. It fails if that section is missing or empty.
8. Check that all 19 assets are on the draft (`gh release view v{version} --repo devsuitup/switchboard --json assets --jq '.assets | length'`); upload any missing one with `gh release upload v{version} <file> --clobber --repo devsuitup/switchboard`.
9. Keep the notes the workflow wrote: they are the changelog section the installed apps show in their What's new dialog, and the two must say the same thing. Check the body (`gh release view v{version} --repo devsuitup/switchboard --json body --jq .body`); a wording to change is changed in `CHANGELOG.md`, through a PR. If the notes step failed, add the missing section through a PR, then fill in the draft by hand: `node scripts/changelog-section.js v{version} > notes.md` on the merged `main`, and `gh release edit v{version} --repo devsuitup/switchboard --notes-file notes.md`.
10. Publish the draft: `gh release edit v{version} --repo devsuitup/switchboard --draft=false --latest`.

If a build started from a wrong tag, cancel it (`gh run cancel <id>`), delete the tag locally and on `origin`, and tag the merged commit.
