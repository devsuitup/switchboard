# End-to-end journeys

`e2e/` holds a few Playwright journeys that launch the real Electron app and
check what only a running app shows: layout, the IPC round trips, the
main-process data behind the sidebar. The node:test suite under `test/` runs
over jsdom, which has no layout, and over injected fakes. It cannot see these.
Issue [#304](https://github.com/devsuitup/switchboard/issues/304).

## Running them

```bash
task e2e          # Linux: builds the CodeMirror bundle, wraps the run in xvfb-run when there is no display
npm run e2e       # any platform, with a display, once the bundle is built
```

They need an installed `node_modules` whose native modules are built for
Electron. `npm install` does that already: `postinstall` runs
`electron-builder install-app-deps`. No browser download is needed, because
Playwright drives the Electron binary from `node_modules/electron`.

`npm test` and `npm run coverage` never run these files.
`scripts/run-tests.js` reads only `test/`, and `.c8rc.json` and the
patch-coverage gate exclude `e2e/**`.

## In CI

The `e2e` job of `.github/workflows/test.yml` runs on `ubuntu-latest` under
`xvfb-run` (1920x1080 screen) on every pull request and every push to `main`.
Before the run, it checks that `better-sqlite3` and `node-pty` load under
Electron's ABI. `postinstall` swallows a failed rebuild, and without that check
a failed rebuild would show up as an app that does not start. When a journey
fails, the job uploads `e2e/test-results/` (a `trace.zip` and a `failure.png`
for each failed journey) and the HTML report as the `e2e-results` artifact.
Open a trace with `npx playwright show-trace trace.zip`. It has the DOM and a
screenshot for each step.

Whether the job is a required check is a repository setting. It is not set
here.

## The journeys

| Journey | File | What it pins |
|---|---|---|
| A changed tracked file is listed with its counts, and the header total matches | `changes.spec.js` | status → rows → summary, through the real git and IPC |
| Clicking an untracked file opens it and its line count appears | `changes.spec.js` | the row click, the editable content pair, the count on open |
| An edit saved in the panel editor reaches disk, and the file stays changed | `changes.spec.js` | the editor gets the panel's width (not two 225 px columns), save writes the bytes |
| The shell opened with no tab fills the panel and is not a sidebar row | `panel.spec.js` | the `.shell-only` layout, and `buildProjectsFromCache` skipping the panel shell |
| Changes on a project with no git work tree says so, with no git output | `panel.spec.js` | the not-a-repository note instead of git's raw output |

The issue's fifth journey expected the Changes control to disappear. #310 made
it unconditional, so the journey checks what the panel says instead (see
`.ai/contexts/changes-view.md`, "Not a repository").

## Writing one

- **Few and coarse.** Each journey costs an Electron launch. Add one only for
  something jsdom cannot see.
- **Isolated.** The `launch` fixture in `e2e/fixtures.js` gives each test its
  own temporary `HOME` (and `USERPROFILE`), its own `SWITCHBOARD_DATA_DIR` and
  `SWITCHBOARD_TRIGGERS_DIR`, a git identity, and no inherited `CLAUDE*`
  variable. Build the fixture projects with `makeRepo` / `makePlainDir` before
  calling `launch()`, because the app reads them at startup. See
  [Live testing](live-testing.md) for why each of these is needed.
- **Plain terminals only.** Open a session with `openPlainTerminal`, the
  project's `+` → Terminal. Never click the fixture's session row: that would
  start `claude --resume`.
- **Structure and geometry, never pixels or wording.** Assert element boxes,
  classes, counts, and what reaches disk. Match a number in a label, never the
  sentence around it. There are no screenshot baselines.
- **No `waitForTimeout`.** Wait on a locator assertion (`toBeVisible`,
  `toHaveCount`) or on `expect.poll`. A journey that needs a sleep is written
  wrong.
- **Bounded teardown.** The fixture closes the app, and kills the whole process
  tree if it does not exit within 10 s. Then it deletes the temporary `HOME`.

## Proving a journey can fail

Each journey was turned red by reverting the behaviour it pins:

| Mutation | Red journey |
|---|---|
| Drop the `.shell-only` region rule in `public/style.css` | the shell fills the panel (height ratio 0.26) |
| Drop both `.shell-only` rules | the shell fills the panel (the handle is visible) |
| Remove the `isPanelShellSession` skip in `session-cache.js` | the shell is not a sidebar row |
| Default the Changes editor to `side-by-side` | the saved edit (each editor 224.5 px wide in a 449 px host) |
| Skip the not-a-repository branch in `refreshChanges` | no git work tree |
| Show the deleted count as the added count in a row | the tracked file's counts |
| Turn off up-front untracked counting and the count on open | the untracked file |

With up-front untracked counting on, removing only the count on open leaves the
untracked journey green, because status has already counted the file.
