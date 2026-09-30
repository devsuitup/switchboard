# Live Testing with a Throwaway HOME

An instance with its own `SWITCHBOARD_DATA_DIR` has its own database and its own
single-instance lock, but it still reads `~/.claude/projects`: it lists every
one of your sessions, and a click, a reload or a restore can resume one of them
(see [Testing a PR live](testing-a-pr.md#4-sessions--the-transcripts-are-shared)).

Launched with a temporary `HOME`, the instance has an empty `~/.claude`. It can
not list, open or resume any of your sessions, nor touch your `~/.claude`
settings, memory or IDE lock files. Everything it needs is built inside that
directory, and deleted with it.

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
- **Never open the fixture's session row.** It would run `claude --resume` on a
  session that exists nowhere else. Open a plain terminal from the project's
  `+` → **Terminal** instead. Inside it, `claude` is a function that refuses to
  start a session.

## Driving it with Playwright

Playwright's `_electron.launch()`, from `playwright-core`, starts Electron, and
its locators wait for elements on their own. `app.evaluate(fn)` runs `fn` in the
main process, with Electron's module as its argument; `app.firstWindow()` is the
renderer, a regular Playwright `Page`.

Playwright is **not** a dependency of this repository. Install it outside the
repository's `package.json`, in a scratch directory — `.work-files/` is
gitignored:

```bash
mkdir -p .work-files/live && cd .work-files/live
npm init -y >/dev/null && npm install playwright-core
```

`live.js` in that directory — the whole technique in one file:

```js
// live.js <checkout> — launch that checkout under a throwaway HOME and open a plain terminal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright-core');

const APP = path.resolve(process.argv[2]);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-home-'));
const data = path.join(home, '.switchboard-test');
const env = {
  // Drop the variables of any Claude session this script runs under.
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE'))),
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  SWITCHBOARD_DATA_DIR: data,
  SWITCHBOARD_TRIGGERS_DIR: path.join(data, 'triggers'),
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

// A fixture repository with one commit.
const repo = path.join(home, 'work', 'fixture');
fs.mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repo, env });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
git('add', '.');
git('commit', '-qm', 'init');

// A two-line transcript, so the project shows in the sidebar.
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

(async () => {
  const app = await electron.launch({
    executablePath: require(path.join(APP, 'node_modules', 'electron')),
    args: [APP, '--no-sandbox'],
    cwd: APP,
    env,
  });
  try {
    const page = await app.firstWindow();
    // A plain terminal from the project's "+", never the fixture's session row.
    await page.locator('.project-new-btn').first().click();
    await page.locator('.popover-option-terminal').click();
    await page.locator('.xterm-screen').first().waitFor();
    console.log('userData:', await app.evaluate(({ app }) => app.getPath('userData')));
    console.log('sessions:', await page.locator('.session-item').count());
    await page.screenshot({ path: 'live.png' });
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
```

Run it against a checkout whose `node_modules` is installed and whose CodeMirror
bundle is built (`npm run bundle:codemirror`):

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
- The script's `git(...)` still works on the fixture repository once the app
  runs, to make changes for the [Changes view](changes-view.md) to show.
- Assert structure and geometry (element boxes, computed styles) rather than
  pixels; take screenshots to look at, and keep them under `.work-files/`.
- Run one instance at a time, niced: each is a full Electron.

Close the app and delete the temporary `HOME` in a `finally`, as above, or
temporary homes accumulate in `/tmp`.

Turning such journeys into a CI suite is tracked in
[#304](https://github.com/devsuitup/switchboard/issues/304).

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
