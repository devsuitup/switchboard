# Live Testing with a Throwaway HOME

An instance with its own `SWITCHBOARD_DATA_DIR` has its own database and its own
single-instance lock, but it still reads Claude and Codex transcript directories: it lists
every one of your sessions, and a click, a reload or a restore can resume one of them
(see [Testing a PR live](testing-a-pr.md#4-sessions--the-transcripts-are-shared)).

Use a temporary `HOME` and `USERPROFILE`, and point `CODEX_HOME` inside it
as well. This isolates both CLI transcript locations, including when your
normal environment sets `CODEX_HOME` to an absolute path. The sample creates
only a fixture Claude transcript in that temporary home.
Launched that way, the instance cannot list, open or resume any of your
sessions, nor touch your `~/.claude` settings, memory or IDE lock files.

## What the environment needs

- `HOME` set to a fresh temporary directory, and `XDG_CONFIG_HOME` under it, so
  nothing lands in your real `~/.config`.
- `SWITCHBOARD_DATA_DIR` and `SWITCHBOARD_TRIGGERS_DIR` under it too. The
  triggers directory is `~/.switchboard/triggers` by default whatever the data
  directory; set it explicitly.
- **A fixture project.** With an empty `~/.claude/projects` the sidebar is
  empty. A git repository plus a two-line transcript —
  `~/.claude/projects/<encoded path>/<uuid>.jsonl`, a `user` and an `assistant`
  line, both carrying the repository's `cwd` — makes the project appear. The
  encoded path is the absolute path with every character other than a letter or
  a digit replaced by `-`.
- **Git identity.** Your `~/.gitconfig` is not under the fake `HOME`, so git has
  no user: set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and
  `GIT_COMMITTER_EMAIL` in the environment, for the fixture's commits and for
  any git the app runs.
- **No inherited Claude variables.** Run from inside a Claude session, the
  environment carries `CLAUDE_CODE_SSE_PORT` and other `CLAUDE*` variables,
  which would reach every shell the instance starts; drop them.
- **On Windows, `USERPROFILE` as well as `HOME`.** Node's `os.homedir()` reads
  `USERPROFILE` there. The [end-to-end fixture](e2e.md#writing-one) sets both,
  and also drops inherited `GIT_*` variables (a `GIT_DIR` or `GIT_WORK_TREE`
  would point git at another repository), `HISTFILE` and `ELECTRON_RUN_AS_NODE`.
- **Never open the fixture's session row.** It would run `claude --resume` on a
  session that exists nowhere else. Open a plain terminal from the project's
  `+` → **Terminal** instead. Inside it, `claude` is a function that refuses to
  start a session.

## Driving it with Playwright

Playwright's `_electron.launch()` starts Electron, and
its locators wait for elements on their own. `app.evaluate(fn)` runs `fn` in the
main process, with Electron's module as its argument; `app.firstWindow()` is the
renderer, a regular Playwright `Page`.

`@playwright/test` is a dev dependency of this repository, for the
[end-to-end journeys](e2e.md). A one-off script can live in `.work-files/`
(gitignored) and `require('@playwright/test')` from the checkout's
`node_modules`:

```bash
mkdir -p .work-files/live && cd .work-files/live
```

`live.js` in that directory — the whole technique in one file:

```js
// live.js <checkout> — launch that checkout under a throwaway HOME and open a plain terminal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('@playwright/test');

// A fixture repository with one commit, and a two-line transcript so the project shows in the sidebar.
function makeFixture(home, env) {
  const repo = path.join(home, 'work', 'fixture');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, env });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-qm', 'init');

  const sid = '00000000-0000-4000-8000-000000000001';
  const now = new Date().toISOString();
  const projectDir = path.join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sid}.jsonl`), [
    { type: 'user', sessionId: sid, cwd: repo, timestamp: now, uuid: 'u1',
      message: { role: 'user', content: 'fixture' } },
    { type: 'assistant', sessionId: sid, cwd: repo, timestamp: now, uuid: 'a1', parentUuid: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');
  return { repo, git };
}

async function main(appDir) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-home-'));
  let app;
  try {
    const data = path.join(home, '.switchboard-test');
    const env = {
      // Drop the variables of any Claude session this script runs under.
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|GIT_)/.test(k) && !['HISTFILE', 'ELECTRON_RUN_AS_NODE'].includes(k))),
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, '.codex'),
      ELECTRON_IS_DEV: '0',
      XDG_CONFIG_HOME: path.join(home, '.config'),
      SWITCHBOARD_DATA_DIR: data,
      SWITCHBOARD_TRIGGERS_DIR: path.join(data, 'triggers'),
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    makeFixture(home, env);

    app = await electron.launch({
      executablePath: require(path.join(appDir, 'node_modules', 'electron')),
      args: [appDir, '--no-sandbox'],
      cwd: home,
      env,
    });
    const page = await app.firstWindow();
    // A plain terminal from the project's "+", never the fixture's session row.
    await page.locator('.project-new-btn').first().click();
    await page.locator('.popover-option-terminal').click();
    await page.locator('.xterm-screen').first().waitFor();
    console.log('userData:', await app.evaluate(({ app }) => app.getPath('userData')));
    console.log('sessions:', await page.locator('.session-item').count());
    await page.screenshot({ path: 'live.png' });
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main(path.resolve(process.argv[2])).catch((err) => { console.error(err); process.exitCode = 1; });
```

Run it against a checkout whose `node_modules` is installed and whose CodeMirror
and Mermaid bundles are built (`npm run bundle:codemirror`,
`npm run bundle:mermaid`):

```bash
nice -n 10 node live.js /path/to/checkout
# userData: /tmp/sb-home-XXXXXX/.switchboard-test/electron
# sessions: 2          (the fixture session and the terminal)
```

From there:

- `app.evaluate(({ BrowserWindow }) => …)` reaches the main process: windows,
  menus, anything Electron exposes.
- `page.evaluate(() => …)` runs in the renderer. A terminal's text is in its
  xterm buffer: `window._openSessions` maps session ids to entries whose
  `terminal.buffer.active` can be read line by line.
- `makeFixture` returns the repository and a `git(...)` helper: keep them in
  `main` to make changes, once the app runs, for the
  [Changes view](changes-view.md) to show.
- Assert structure and geometry (element boxes, computed styles) rather than
  pixels; take screenshots to look at, and keep them under `.work-files/`.
- Run one instance at a time, niced: each is a full Electron.

Everything after `mkdtempSync` — the fixture, the launch, the test — runs inside
the `try`, so the `finally` closes the app, if it started, and deletes the
temporary `HOME` on every path, a failed `git` or a failed launch included.
Keep new steps inside it, or temporary homes accumulate in `/tmp`.

Journeys worth keeping belong in the CI suite: see [End-to-end journeys](e2e.md).

## A dataset for the Schedules tab

`scripts/schedule-dataset.js` fills a new throwaway `HOME` with projects,
schedules and recorded runs, so the Schedules tab and the run history can be
checked without your own schedules:

```bash
node scripts/schedule-dataset.js /path/to/new-home [--data-dir <dir>] [--now 2026-11-25T08:00:00Z]
```

It refuses a directory that is not empty, and a `--now` before 2000. On Windows,
where creating a symbolic link needs a privilege, the linked schedule is
skipped and named in the output. Git runs without inherited
`GIT_*` variables, so `git init` lands in each fixture project. The data
directory defaults to
`<home>/.switchboard-dev`; launch the instance with `HOME`, the `XDG_*`
directories and `SWITCHBOARD_DATA_DIR` pointing there, as in
[What the environment needs](#what-the-environment-needs).

| What | Where |
|---|---|
| Projects `alpha`, `beta` (with schedules) and `gamma` (none) | `<home>/work/<name>`, each a git repository, so Switchboard registers the ones with schedules at first launch |
| One Add project seed transcript per project | `<home>/.claude/projects/<encoded path>/` |
| Schedules covering the states the tab shows: worded and unworded cron, disabled, catch-up, background, a malformed expression, a cron that is never due, a symlink to a file outside the project, a long name | `<project>/.claude/commands/schedule-*.md`; the symlink target is under `<home>/shared` |
| Runs: a transcript per run, first line `Scheduled Task: …` with its `scheduleSlug`, an assistant reply for a successful run | the project's transcript folder |
| Results: exit 0, exit 1, a signal, a refusal, and one run without a result | `<data dir>/schedule-runs/` |

The table of schedules and runs is `SCHEDULES` at the top of the script; add a
case there, and `test/schedule-dataset.test.js` checks that the scheduler lists
it and that its results read back as valid. Runs are dated relative to `--now`
(default: the current time).

Every schedule that can fire is due between 03:00 and 03:59. An instance left
running then starts a real `claude` run in the fixture project; under the fake
`HOME` that `claude` is not logged in, and the run fails.

## Which one to use

| | `task test-pr` | Throwaway `HOME` |
|---|---|---|
| Transcripts | yours, shared with your running app | a fixture only |
| Your sessions | listed, and resumable by mistake | invisible |
| Launch | one command, from a PR number | a script |
| Driving | by hand, or over CDP | Playwright, scripted |
| Good for | using a PR with real history: search, the heatmap, subagents, large projects, your remote hosts | anything that clicks, types or starts processes; journeys to repeat; running unattended |

Use `task test-pr` to look at a change against your real data, by hand, with
care about which sessions you open. Use a throwaway `HOME` whenever something
other than you drives the instance, or when nothing of yours should be reachable
from it.
