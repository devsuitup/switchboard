# Releasing

A release is a version tag on `main`. The version bump lands through a pull
request first, because `main` is protected.

Every `gh` command run by hand in this clone needs `--repo devsuitup/switchboard`:
gh's default here is the upstream repository, `doctly/switchboard`.

## Steps

1. **Bump the version and date the changelog** on a branch, and open the PR.
   In [`CHANGELOG.md`](../CHANGELOG.md) (see [Changelog](changelog.md)),
   rename `## Unreleased` to `## v0.1.0 — <today, YYYY-MM-DD>`, and open a new,
   empty `## Unreleased` above it. Read the section once more: it becomes the
   release notes as it stands.

   ```bash
   git checkout -b release/v0.1.0 origin/main
   npm version --no-git-tag-version 0.1.0   # package.json and package-lock.json
   # edit CHANGELOG.md as above
   git commit -am v0.1.0
   git push origin release/v0.1.0
   gh pr create --repo devsuitup/switchboard --base main --title v0.1.0 --fill
   ```

   `test/changelog.test.js` fails when `CHANGELOG.md` has no section for the
   version in `package.json`, so a bump without its section does not pass CI.

   The required PR checks for this workflow are `lint`,
   `test (20, ubuntu-latest)`, `test (22, ubuntu-latest)`,
   `test (22, windows-2022)`, `changelog` and `e2e`. Build is not required.
   JB must remove the obsolete `test (20, windows-2022)` context from both
   places that require it: ruleset 17240725 (`main-protection`) and the classic
   branch protection on `main` (`required_status_checks.contexts`). Both must
   be updated together whenever the test matrix changes; workflow changes do
   not change repository settings. The documented ruleset requires
   no approving review, so `gh pr merge --repo devsuitup/switchboard --auto --squash` can be armed once the
   required checks run. CI-only PRs use the `no-changelog` label.

2. **Run the app before tagging.** The tag is what publishes, and nothing
   between the merge and the tag looks at the assembled whole; the test suite
   does not see layout, a control drawn in the wrong colour, or raw tool output
   in a locale. Launch the merged `main` in an isolated instance and use it — see
   [Testing a PR live](testing-a-pr.md) and
   [Live testing with a throwaway HOME](live-testing.md).

3. **Tag the merged commit** and push the tag:

   ```bash
   git fetch origin
   git tag v0.1.0 origin/main
   git push origin v0.1.0
   ```

4. **Wait for the build.** The tag starts `.github/workflows/build.yml`: macOS
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
   by its newer runs; tag and main pushes never cancel in-progress runs.

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

   After all builds succeed, the publish job:
   - creates a **draft** release named after the version;
   - uploads each artifact separately, retrying each up to five times — 20
     assets for a full build (dmg, zip and their blockmaps for arm64 and x64; the
     Windows installer and its blockmap; two AppImages, two debs, two pacman
     packages (`-x64.pacman` and `-aarch64.pacman`); four `latest*.yml` update manifests);
   - writes the release notes: the text of the tag's `CHANGELOG.md` section,
     without its heading (`scripts/changelog-section.js`), then a **Full
     changelog** link comparing the previous tag with this one. It fails
     rather than publish an empty body when the section is missing or empty.
     The fix is then in `CHANGELOG.md`, through a PR; `gh release edit
     --repo devsuitup/switchboard --notes-file` can fill in the draft by hand meanwhile.

   Re-running CI while the release is a draft is fine: it completes or replaces
   the draft's assets. CI refuses to publish if it cannot read the releases,
   and never writes to a published release. Once published, add or replace an
   asset by hand with `gh release upload --repo devsuitup/switchboard --clobber` (see below), or tag a new
   version. Delete the draft or move the tag only while the release is still a
   draft. The workflow token has `contents: read`; only the publish job has
   `contents: write`, and no checkout persists credentials.

5. **Publish the draft to beta**, after checking its assets:

   ```bash
   gh release view v0.1.0 --repo devsuitup/switchboard --json assets --jq '.assets | length'
   gh release edit v0.1.0 --repo devsuitup/switchboard --draft=false --prerelease
   ```

   Installed copies with **Receive beta versions** and automatic updates on
   pick the release up from its `latest*.yml` manifests; a draft is invisible
   to them, and stable installs skip pre-releases. On their first start
   after the update, the What's new dialog shows this section, and those of
   any version they skipped.

6. **Promote to stable**, only on the maintainer's go. First require at least
   24 hours of use on beta and no open issue labelled `regression` for this
   version. Inspect the open regression issues and confirm which version each
   affects before promoting:

   ```bash
   gh issue list --repo devsuitup/switchboard --state open --label regression --limit 1000
   gh release edit v0.1.0 --repo devsuitup/switchboard --prerelease=false --latest
   ```

   One binary serves both channels: beta is the GitHub pre-release flag.
   Promotion changes that flag and marks the release latest; keep the same
   version tag and assets, with no beta tags or rebuild.

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
new version published to beta, then use the same promotion gate. Beta installs
can still receive a withdrawn pre-release.

## Fork release-flow gotchas

- **Push with an explicit remote.** A clone whose `main` tracks `upstream`
  (`doctly/switchboard`) sends a bare `git push` there, which fails on
  permissions. `git push origin …` always targets the fork.
- **Direct pushes to `main` are rejected** by the ruleset: the bump goes through
  a PR.
- **Tag the merged commit, never the local bump commit.** A squash merge makes
  a new commit; a tag on the pre-merge commit is not an ancestor of `main`, so
  `git describe --tags` and the release-notes range skip it. If a build already
  started from such a tag, cancel it (`gh run cancel --repo devsuitup/switchboard`), delete the tag locally
  and on `origin`, and tag the merged commit.
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
