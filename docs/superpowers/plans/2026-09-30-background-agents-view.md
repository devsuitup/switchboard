# Background Agents View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Switchboard a graphical replacement for the `claude agents` TUI: a dedicated view that lists the daemon's background sessions, reads what each one does, and attaches to, stops, respawns, deletes or dispatches them.

**Architecture:** A main-process module (`bg-agents.js`, with its pure half in `bg-agents-roster.js`) watches `~/.claude/jobs/*/state.json` and the CLI's session descriptors, reconciles them against `claude agents --json --all`, and pushes a roster to the renderer. The renderer's `agents-view.js` renders a master list and a detail pane and calls the verbs over IPC; attach is an ordinary terminal tab running `claude attach <id>`, keyed by the session's real id so the sidebar and the tab coincide.

**Tech Stack:** Electron main (Node, `fs.watch`, `child_process.spawn` through the user's login shell), plain-script renderer (`morphdom`, `xterm`), `node:test` + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-30-background-agents-view-design.md`

## Global Constraints

- Never `--resume` or `--fork-session` a session whose job is `working`; `claude attach` is the only path to a live job.
- Every call to the CLI goes through the login shell with an argv quoted by `quoteArgvForShell` (the scheduler's path, `main.js` `runScheduleCommand`), never a string built by hand. The daemon's control socket and `control.key` are never touched.
- Closing an attach tab detaches (`\x1a`, then 2 s grace, then kill); `claude stop` is the only stop.
- No steady-state cost before the view is first opened: watchers arm on the first `get-bg-agents`.
- `~/.claude/jobs/` and the `kind: "bg"` descriptor are undocumented interfaces: failure is silence, and a canary test pins their observed shape (CLI 2.1.285, 2026-09-30).
- Timeouts: list 5 s, verbs 15 s. Coalescing 250 ms. Reconcile cadence 30 s while the view is visible. `MAX_JOBS` 200.
- Shortcut `agentsToggle`, default Primary+Shift+A. `localStorage` keys `agentsViewActive`, `agentsShowFinished`.
- Renderer files are classic scripts sharing one global scope: every new cross-file name goes into `eslint.config.js`'s `rendererCrossFileGlobals`, or `task check` fails on `no-undef`. Keep names distinct across files (see `.ai/contexts/subagent-observability.md`, "Grid view keeps its own parallel tracking").
- Commit style `(area): imperative subject`, no `Co-Authored-By`. The pre-commit hook runs `task check` (lint + full suite, ~2 min); run single files with `node --test test/<file>` while iterating.
- Comment sweep before the PR: rationale goes to `.ai/contexts/bg-agents.md`, at most a one-line `// see .ai/contexts/bg-agents.md` pointer stays in code.

## Review Focus

1. `claude --bg` prints its id in a format nobody measured; `parseDispatchOutput` must return `null` on anything unrecognised and the dispatch must still report `ok: true`. Test in Task 1.
2. A prompt starting with `-` would be read by the CLI as a flag; `dispatchArgs` refuses it with a clear error instead of shipping it. Test in Task 1.
3. A job id from the renderer is untrusted; a verb whose id is not exactly eight hex characters is refused before any process is spawned. Test in Task 4.
4. `state.json` caught mid-rewrite (empty or truncated) must keep the previous parsed value, not blank the row. Test in Task 4.
5. `hideAllViewers()` runs from `showSession`/`showJsonlViewer` while the Agents view is open; it must close the view without restoring the terminal area (no recursion, no flicker). Test in Task 7.

## Deviations from the spec, recorded here and amended in Task 0

- The view's container is a sibling of `#jsonl-viewer` (outside `#terminal-area`), not of `#grid-viewer`: the grid is a layout of the terminals, and hiding `#terminal-area` the way the Stats tab does leaves the grid state intact for the return trip.
- The CLI is invoked through the login shell with a quoted argv (the scheduler's existing path), not `execFile('claude', …)`: the packaged app's `PATH` does not know version managers, and the argv-quoting keeps the no-injection property.
- The row's `⋯` menu is dropped: a row click selects it and the detail pane carries the verbs. One surface for five verbs is enough.

## File structure

| File | Responsibility |
|---|---|
| `bg-agents-roster.js` (new) | Pure: parse `state.json`, parse the CLI list, merge into roster entries, build dispatch argv, parse the dispatch output |
| `bg-agents.js` (new) | Stateful: watchers over `jobs/`, descriptor subscription, reconcile through the CLI, verbs, dispatch, change events |
| `bg-agents-ipc.js` (new) | The three `ipcMain.handle` and the `bg-agents-changed` push |
| `cli-session-state.js` | `onDescriptorsChanged`, `readAllDescriptors`, `parseDescriptor`, `kind`/`jobId` on live-elsewhere results, export `ownProcessFilter` |
| `pty-ops.js` | `detachPty` |
| `main.js` | `runClaudeCommand`, the attach branch of `open-terminal`, detach in `stop-session`, wiring, `bgAgents.stop()` on close |
| `preload.js` | `getBgAgents`, `bgAgentVerb`, `dispatchBgAgent`, `onBgAgentsChanged` |
| `public/agents-view.js` (new) | The view: state, pure row/verb helpers, render, verbs, attach, show/hide/toggle |
| `public/shortcuts.js` | `agentsToggle` |
| `public/resume-guard.js` | A live `bg` descriptor answers "attach", not "resume anyway?" |
| `public/stop-session-ui.js` | Detach wording for an attach tab |
| `public/app.js`, `public/terminal-manager.js`, `public/grid-view.js`, `public/memory-workfiles-view.js`, `public/sidebar.js`, `public/dialogs.js`, `public/index.html`, `public/style.css`, `eslint.config.js` | Wiring, badge, dialog, markup, styles, globals |
| `test/*.test.js` | One file per unit, listed per task |
| Docs | `docs/background-agents.md`, `.ai/contexts/bg-agents.md`, rows in the README, `docs/README.md`, `docs/keyboard-shortcuts.md`, `docs/settings.md`, `.ai/contexts/ipc-bridge.md`, `.ai/contexts/README.md`, `.ai/shared-guidelines.md`, `.ai/contexts/cli-session-state.md` |

---

### Task 0: Amend the spec with the three deviations

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-background-agents-view-design.md`

- [ ] **Step 1: Edit the three sentences**

In the "Architecture → Renderer" section, replace

```
Container `#agents-viewer` inside `#terminal-area`, a sibling of
`#grid-viewer`, shown and hidden the way the grid is (hide the active
terminal, refit on return).
```

with

```
Container `#agents-viewer`, a sibling of `#jsonl-viewer` outside
`#terminal-area`, shown the way the Stats tab shows its viewer (hide
`#terminal-area`, which keeps the grid's state intact) and hidden by
restoring whichever of grid, active session or placeholder was there.
```

In "Scope → Out", the "Verbs" paragraph and invariant 2, replace every
`execFile('claude', …)` / "with `execFile` and no shell" wording with:
"through the user's login shell with an argv quoted by `quoteArgvForShell`,
the scheduler's existing path in `main.js`; never a command string built by
hand". In the list-row bullet, delete "a `⋯` menu" and the "`⋯` menu and
detail buttons" sentence; write "A row click selects it; the detail pane
carries the verbs."

- [ ] **Step 2: Commit**

```bash
/usr/bin/git add docs/superpowers/specs/2026-09-30-background-agents-view-design.md
/usr/bin/git commit -m "docs(spec): record the three deviations taken while planning the agents view"
```

---

### Task 1: Pure roster parsing (`bg-agents-roster.js`)

**Files:**
- Create: `bg-agents-roster.js`
- Test: `test/bg-agents-roster.test.js`

**Interfaces:**
- Produces:
  - `parseJobState(text) → null | { state, detail, tempo, tokens, fan[], children[], result, template, agent, model, name, sessionId }`
  - `parseCliList(text) → null | [{ id, sessionId, name, cwd, kind, state, status, pid, startedAt }]`
  - `mergeRoster({ cli, jobs, descriptors, isOwnPid, isAttachedHere }) → Entry[]` where `Entry = { id, sessionId, name, cwd, kind: 'background'|'interactive', state, status, pid, startedAt, agent, model, detail, tempo, tokens, fan, children, result, attachedHere }`
  - `dispatchArgs(fields) → { ok: true, args, cwd } | { ok: false, error }`
  - `parseDispatchOutput(stdout) → string | null`
  - `JOB_ID_RE = /^[0-9a-f]{8}$/`

- [ ] **Step 1: Write the failing tests**

```js
// test/bg-agents-roster.test.js — pure parsing and merging for the agents view.
// See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseJobState, parseCliList, mergeRoster, dispatchArgs, parseDispatchOutput, JOB_ID_RE,
} = require('../bg-agents-roster');

const STATE = JSON.stringify({
  state: 'done',
  detail: 'backlog reviewed; awaiting !196 merge',
  tempo: 'idle',
  tokens: 172999,
  fan: [{ id: 'a4a8', kind: 'agent', label: 'Spawn developer', startedAt: 1790590786510, doneAt: 1790590813354 }, 'junk'],
  children: [{ id: '195', href: 'https://gitlab.com/x/-/merge_requests/195', kind: 'merge_request' }],
  output: { result: 'no new action needed' },
  template: 'fleet:em',
  respawnFlags: ['--plugin-dir', '/x', '--agent', 'fleet:em', '--permission-mode', 'auto', '--name', 'em-platform', '--model', 'claude-sonnet-5'],
  linkScanPath: '/home/u/.claude/projects/-home-u-p/bc3fd129-60bb-4bd2-8f38-63fecd1256e5.jsonl',
});

test('parseJobState keeps the fields the view shows and derives agent/model/name/sessionId', () => {
  const job = parseJobState(STATE);
  assert.equal(job.state, 'done');
  assert.equal(job.detail, 'backlog reviewed; awaiting !196 merge');
  assert.equal(job.tokens, 172999);
  assert.deepEqual(job.fan, [{ id: 'a4a8', kind: 'agent', label: 'Spawn developer', startedAt: 1790590786510, doneAt: 1790590813354 }]);
  assert.deepEqual(job.children, [{ id: '195', href: 'https://gitlab.com/x/-/merge_requests/195', kind: 'merge_request' }]);
  assert.equal(job.result, 'no new action needed');
  assert.equal(job.agent, 'fleet:em');
  assert.equal(job.model, 'claude-sonnet-5');
  assert.equal(job.name, 'em-platform');
  assert.equal(job.sessionId, 'bc3fd129-60bb-4bd2-8f38-63fecd1256e5');
});

test('parseJobState: unknown state, missing output and garbage are tolerated', () => {
  assert.equal(parseJobState(''), null);
  assert.equal(parseJobState('[]'), null);
  const job = parseJobState('{"state":"weird","fan":null}');
  assert.equal(job.state, null);
  assert.deepEqual(job.fan, []);
  assert.equal(job.result, null);
  assert.equal(job.sessionId, null);
});

test('parseCliList keeps background and interactive entries and drops the rest', () => {
  const list = parseCliList(JSON.stringify([
    { id: 'bc3fd129', pid: 346590, cwd: '/w', kind: 'background', startedAt: 1, sessionId: 's-bg', name: 'em', status: 'idle', state: 'working' },
    { pid: 5, cwd: '/w', kind: 'interactive', startedAt: 2, sessionId: 's-int', name: 'n', status: 'busy' },
    { kind: 'background', sessionId: '' },
    'junk',
  ]));
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { id: 'bc3fd129', sessionId: 's-bg', name: 'em', cwd: '/w', kind: 'background', state: 'working', status: 'idle', pid: 346590, startedAt: 1 });
  assert.equal(list[1].kind, 'interactive');
  assert.equal(list[1].id, null);
  assert.equal(parseCliList('not json'), null);
  assert.equal(parseCliList('{}'), null);
});

function fixture() {
  const cli = [
    { id: 'aaaaaaaa', sessionId: 's-a', name: 'a', cwd: '/a', kind: 'background', state: 'working', status: 'idle', pid: 10, startedAt: 100 },
    { id: 'bbbbbbbb', sessionId: 's-b', name: 'b', cwd: '/b', kind: 'background', state: 'done', status: null, pid: null, startedAt: 50 },
    { id: null, sessionId: 's-own', name: 'own', cwd: '/o', kind: 'interactive', state: null, status: 'busy', pid: 20, startedAt: 70 },
  ];
  const jobs = new Map([
    ['aaaaaaaa', parseJobState(JSON.stringify({ state: 'done', detail: 'stale detail', tokens: 5, respawnFlags: ['--agent', 'fleet:em'] }))],
    ['cccccccc', parseJobState(JSON.stringify({ state: 'stopped', detail: 'orphan' }))],
  ]);
  const descriptors = [
    { pid: 10, sessionId: 's-a', kind: 'bg', jobId: 'aaaaaaaa', agent: 'fleet:em', name: 'a', cwd: '/a', status: 'busy', startedAt: 100 },
    { pid: 20, sessionId: 's-own', kind: 'interactive', jobId: null, agent: null, name: 'own', cwd: '/o', status: 'busy', startedAt: 70 },
    { pid: 30, sessionId: 's-ext', kind: 'interactive', jobId: null, agent: null, name: 'ext', cwd: '/e', status: 'waiting', startedAt: 80 },
    { pid: 40, sessionId: 's-nojob', kind: 'bg', jobId: 'dddddddd', agent: null, name: 'x', cwd: '/x', status: 'idle', startedAt: 90 },
  ];
  return { cli, jobs, descriptors, isOwnPid: (pid) => pid === 20, isAttachedHere: (id) => id === 'aaaaaaaa' };
}

test('mergeRoster: the CLI list decides which jobs exist and their state; the file and the descriptor enrich', () => {
  const roster = mergeRoster(fixture());
  const ids = roster.map(e => e.kind === 'background' ? e.id : e.sessionId);
  assert.deepEqual(ids, ['aaaaaaaa', 'bbbbbbbb', 's-ext']);
  const a = roster[0];
  assert.equal(a.state, 'working', 'the CLI state wins over the file');
  assert.equal(a.status, 'busy', 'the descriptor status wins over the CLI snapshot');
  assert.equal(a.detail, 'stale detail');
  assert.equal(a.tokens, 5);
  assert.equal(a.agent, 'fleet:em');
  assert.equal(a.attachedHere, true);
  assert.equal(roster[1].attachedHere, false);
  assert.equal(roster[1].detail, null, 'a job without a file still lists');
  const ext = roster[2];
  assert.equal(ext.kind, 'interactive');
  assert.equal(ext.id, null);
  assert.equal(ext.status, 'waiting');
});

test('mergeRoster without the CLI lists the jobs on disk instead', () => {
  const f = fixture();
  const roster = mergeRoster({ ...f, cli: null });
  assert.deepEqual(roster.filter(e => e.kind === 'background').map(e => e.id).sort(), ['aaaaaaaa', 'cccccccc']);
  const a = roster.find(e => e.id === 'aaaaaaaa');
  assert.equal(a.state, 'done', 'file state stands when the CLI is unreachable');
  assert.equal(a.sessionId, 's-a', 'the descriptor supplies the session id');
  assert.equal(a.pid, 10);
});

test('dispatchArgs builds the argv in a fixed order and omits empty options', () => {
  const r = dispatchArgs({ prompt: '  do the thing  ', name: 'n1', agent: 'fleet:em', permissionMode: 'auto', addDirs: '/a, /b', cwd: '/proj' });
  assert.deepEqual(r, { ok: true, cwd: '/proj', args: ['--bg', '--name', 'n1', '--agent', 'fleet:em', '--permission-mode', 'auto', '--add-dir', '/a', '--add-dir', '/b', 'do the thing'] });
  const bare = dispatchArgs({ prompt: 'p', cwd: '/proj', name: '', agent: '  ', dangerouslySkipPermissions: true, permissionMode: 'auto' });
  assert.deepEqual(bare.args, ['--bg', '--dangerously-skip-permissions', 'p']);
});

test('dispatchArgs refuses an empty prompt, a missing cwd, and a prompt that looks like a flag', () => {
  assert.equal(dispatchArgs({ prompt: '', cwd: '/p' }).ok, false);
  assert.equal(dispatchArgs({ prompt: 'p' }).ok, false);
  const flag = dispatchArgs({ prompt: '--help', cwd: '/p' });
  assert.equal(flag.ok, false);
  assert.match(flag.error, /cannot start with/);
});

test('parseDispatchOutput finds an eight-hex id anywhere in the output, or returns null', () => {
  assert.equal(parseDispatchOutput('Started background session de3dfd18\nattach with claude attach de3dfd18\n'), 'de3dfd18');
  assert.equal(parseDispatchOutput('de3dfd18'), 'de3dfd18');
  assert.equal(parseDispatchOutput('deadbeefcafe is not an id, nor is 12345'), null);
  assert.equal(parseDispatchOutput(''), null);
  assert.ok(JOB_ID_RE.test('de3dfd18'));
  assert.ok(!JOB_ID_RE.test('DE3DFD18'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/bg-agents-roster.test.js`
Expected: FAIL with `Cannot find module '../bg-agents-roster'`

- [ ] **Step 3: Write the module**

```js
// bg-agents-roster.js — see .ai/contexts/bg-agents.md
'use strict';

const JOB_STATES = new Set(['working', 'done', 'stopped']);
const SESSION_STATUSES = new Set(['busy', 'idle', 'waiting', 'shell']);
const JOB_ID_RE = /^[0-9a-f]{8}$/;
const JOB_ID_IN_TEXT_RE = /(?:^|[^0-9a-f])([0-9a-f]{8})(?![0-9a-f])/i;
const TRANSCRIPT_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const str = (v) => (typeof v === 'string' && v ? v : null);
const num = (v) => (Number.isFinite(v) ? v : null);

function sessionIdFromLinkScanPath(p) {
  if (typeof p !== 'string') return null;
  const m = TRANSCRIPT_ID_RE.exec(p);
  return m ? m[1].toLowerCase() : null;
}

function flagValue(flags, name) {
  if (!Array.isArray(flags)) return null;
  const i = flags.indexOf(name);
  return i >= 0 && i + 1 < flags.length ? str(flags[i + 1]) : null;
}

function parseJobState(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fan = Array.isArray(raw.fan)
    ? raw.fan.filter(f => f && typeof f === 'object').map(f => ({
      id: str(f.id), kind: str(f.kind), label: str(f.label), startedAt: num(f.startedAt), doneAt: num(f.doneAt),
    }))
    : [];
  const children = Array.isArray(raw.children)
    ? raw.children.filter(c => c && typeof c === 'object').map(c => ({
      id: c.id == null ? null : String(c.id), href: str(c.href), kind: str(c.kind),
    }))
    : [];
  return {
    state: JOB_STATES.has(raw.state) ? raw.state : null,
    detail: str(raw.detail),
    tempo: str(raw.tempo),
    tokens: num(raw.tokens),
    fan,
    children,
    result: raw.output && typeof raw.output === 'object' ? str(raw.output.result) : null,
    template: str(raw.template),
    agent: flagValue(raw.respawnFlags, '--agent'),
    model: flagValue(raw.respawnFlags, '--model'),
    name: flagValue(raw.respawnFlags, '--name'),
    sessionId: sessionIdFromLinkScanPath(raw.linkScanPath),
  };
}

function parseCliList(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const kind = s.kind === 'background' || s.kind === 'interactive' ? s.kind : null;
    if (!kind || typeof s.sessionId !== 'string' || !s.sessionId) continue;
    out.push({
      id: str(s.id),
      sessionId: s.sessionId,
      name: str(s.name),
      cwd: str(s.cwd),
      kind,
      state: JOB_STATES.has(s.state) ? s.state : null,
      status: SESSION_STATUSES.has(s.status) ? s.status : null,
      pid: Number.isInteger(s.pid) && s.pid > 0 ? s.pid : null,
      startedAt: num(s.startedAt),
    });
  }
  return out;
}

function emptyEntry() {
  return {
    id: null, sessionId: null, name: null, cwd: null, kind: 'background',
    state: null, status: null, pid: null, startedAt: null,
    agent: null, model: null, detail: null, tempo: null, tokens: null,
    fan: [], children: [], result: null, attachedHere: false,
  };
}

function backgroundEntry(id, cliEntry, job, descriptor) {
  const e = emptyEntry();
  e.id = id;
  if (job) {
    Object.assign(e, {
      sessionId: job.sessionId, name: job.name, state: job.state, agent: job.agent, model: job.model,
      detail: job.detail, tempo: job.tempo, tokens: job.tokens, fan: job.fan, children: job.children, result: job.result,
    });
  }
  if (cliEntry) {
    e.sessionId = cliEntry.sessionId || e.sessionId;
    e.name = cliEntry.name || e.name;
    e.cwd = cliEntry.cwd || e.cwd;
    e.state = cliEntry.state || e.state;
    e.status = cliEntry.status || e.status;
    e.pid = cliEntry.pid || e.pid;
    e.startedAt = cliEntry.startedAt ?? e.startedAt;
  }
  if (descriptor) {
    e.sessionId = e.sessionId || descriptor.sessionId;
    e.name = e.name || descriptor.name;
    e.cwd = e.cwd || descriptor.cwd;
    e.agent = e.agent || descriptor.agent;
    e.status = descriptor.status || e.status;
    e.pid = descriptor.pid || e.pid;
    e.startedAt = e.startedAt ?? descriptor.startedAt;
  }
  return e;
}

function mergeRoster({ cli, jobs, descriptors, isOwnPid, isAttachedHere }) {
  const own = typeof isOwnPid === 'function' ? isOwnPid : () => false;
  const attached = typeof isAttachedHere === 'function' ? isAttachedHere : () => false;
  const byJobId = new Map();
  for (const d of descriptors || []) {
    if (d && d.kind === 'bg' && typeof d.jobId === 'string') byJobId.set(d.jobId, d);
  }
  const roster = [];
  if (Array.isArray(cli)) {
    for (const s of cli) {
      if (s.kind !== 'background' || !s.id) continue;
      roster.push(backgroundEntry(s.id, s, jobs ? jobs.get(s.id) : null, byJobId.get(s.id)));
    }
  } else if (jobs) {
    for (const [id, job] of jobs) roster.push(backgroundEntry(id, null, job, byJobId.get(id)));
  }
  for (const d of descriptors || []) {
    if (!d || d.kind !== 'interactive' || !d.sessionId || own(d.pid)) continue;
    roster.push({
      ...emptyEntry(), kind: 'interactive', sessionId: d.sessionId, name: d.name, cwd: d.cwd,
      status: d.status, pid: d.pid, startedAt: d.startedAt,
    });
  }
  for (const e of roster) e.attachedHere = e.kind === 'background' && !!attached(e.id);
  return roster;
}

function splitAddDirs(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function dispatchArgs(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const prompt = typeof f.prompt === 'string' ? f.prompt.trim() : '';
  if (!prompt) return { ok: false, error: 'a prompt is required' };
  if (prompt.startsWith('-')) return { ok: false, error: 'the prompt cannot start with "-": the CLI would read it as a flag' };
  if (typeof f.cwd !== 'string' || !f.cwd) return { ok: false, error: 'a project directory is required' };
  const args = ['--bg'];
  const name = typeof f.name === 'string' ? f.name.trim() : '';
  if (name) args.push('--name', name);
  const agent = typeof f.agent === 'string' ? f.agent.trim() : '';
  if (agent) args.push('--agent', agent);
  if (f.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  else if (typeof f.permissionMode === 'string' && f.permissionMode) args.push('--permission-mode', f.permissionMode);
  for (const dir of splitAddDirs(f.addDirs)) args.push('--add-dir', dir);
  args.push(prompt);
  return { ok: true, args, cwd: f.cwd };
}

function parseDispatchOutput(stdout) {
  const m = JOB_ID_IN_TEXT_RE.exec(String(stdout || ''));
  return m ? m[1].toLowerCase() : null;
}

module.exports = {
  parseJobState, parseCliList, mergeRoster, dispatchArgs, parseDispatchOutput,
  sessionIdFromLinkScanPath, JOB_ID_RE, JOB_STATES,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/bg-agents-roster.test.js`
Expected: PASS, 8 tests. If `parseDispatchOutput('deadbeefcafe …')` returns an id, the lookbehind/lookahead in `JOB_ID_IN_TEXT_RE` is wrong: it must reject a hex run longer than eight.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add bg-agents-roster.js test/bg-agents-roster.test.js
/usr/bin/git commit -m "(bg-agents): parse the daemon's job files and the CLI list into one roster"
```

---

### Task 2: Descriptor hooks in `cli-session-state.js`, and the canaries

**Files:**
- Modify: `cli-session-state.js`
- Modify: `test/cli-session-state.test.js` (append)
- Modify: `test/canary-cli-session-state.test.js` (append)
- Create: `test/canary-bg-agents-files.test.js`

**Interfaces:**
- Produces (new exports): `onDescriptorsChanged(listener) → unsubscribe`, `readAllDescriptors() → Descriptor[]`, `parseDescriptor(text) → Descriptor | null`, `ownProcessFilter(ptyPids) → (pid) => boolean`, where `Descriptor = { pid, sessionId, kind, jobId, agent, name, cwd, status, startedAt }`.
- Changes: `liveElsewhere` / `liveElsewhereMany` results gain `kind` and `jobId` (strings or null).

- [ ] **Step 1: Append the failing tests to `test/cli-session-state.test.js`**

```js
// --- Descriptor hooks for the agents view (see .ai/contexts/bg-agents.md) ---

test('onDescriptorsChanged fires once per flushed batch, and the unsubscribe stops it', async () => {
  const dir = mkTmp();
  try {
    boot(dir, oneSession());
    let fired = 0;
    const off = cliSessionState.onDescriptorsChanged(() => { fired++; });
    writeState(dir, 4242, { status: 'busy', kind: 'bg', jobId: 'aaaaaaaa' });
    writeState(dir, 4243, { status: 'idle', sessionId: 'sess-2' });
    await waitFor(() => fired >= 1);
    await delay(SETTLE_MS);
    assert.equal(fired, 1, 'two writes inside one FLUSH_MS window are one notification');
    off();
    writeState(dir, 4242, { status: 'idle', kind: 'bg', jobId: 'aaaaaaaa' });
    await delay(SETTLE_MS);
    assert.equal(fired, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readAllDescriptors returns the live descriptors with their kind, jobId and agent', () => {
  const dir = mkTmp();
  try {
    writeState(dir, 10, { status: 'idle', kind: 'bg', jobId: 'bc3fd129', agent: 'fleet:em', name: 'em', startedAt: 5 });
    writeState(dir, 11, { status: 'busy', kind: 'interactive', sessionId: 'sess-2' });
    writeState(dir, 12, { status: 'busy', kind: 'interactive', sessionId: 'sess-dead' });
    fs.writeFileSync(path.join(dir, '13.json'), '{not json', 'utf8');
    boot(dir, oneSession(), { isProcessAlive: (pid) => pid !== 12 });
    const all = cliSessionState.readAllDescriptors().sort((a, b) => a.pid - b.pid);
    assert.deepEqual(all.map(d => d.pid), [10, 11]);
    assert.deepEqual(all[0], { pid: 10, sessionId: 'sess-1', kind: 'bg', jobId: 'bc3fd129', agent: 'fleet:em', name: 'em', cwd: dir, status: 'idle', startedAt: 5 });
    assert.equal(all[1].kind, 'interactive');
    assert.equal(all[1].jobId, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('liveElsewhere reports the descriptor kind and jobId, so a bg session can be attached instead of resumed', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'idle', kind: 'bg', jobId: 'bc3fd129' });
    boot(dir, new Map());
    const live = await cliSessionState.liveElsewhere('sess-1', () => false, () => []);
    assert.equal(live.pid, 4242);
    assert.equal(live.kind, 'bg');
    assert.equal(live.jobId, 'bc3fd129');
    writeState(dir, 4242, { status: 'idle' });
    const plain = await cliSessionState.liveElsewhere('sess-1', () => false, () => []);
    assert.equal(plain.kind, null);
    assert.equal(plain.jobId, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ownProcessFilter is exported and claims our own PTY pids', () => {
  const dir = mkTmp();
  try {
    boot(dir, new Map());
    const isOwn = cliSessionState.ownProcessFilter(() => [77]);
    assert.equal(isOwn(77), true);
    assert.equal(isOwn(78), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/cli-session-state.test.js`
Expected: the four new tests FAIL (`onDescriptorsChanged is not a function`, etc.); the existing ones pass.

- [ ] **Step 3: Implement in `cli-session-state.js`**

After `const lastProbeAt = new Map();` add:

```js
const MAX_DESCRIPTOR_SCAN = 1000;
// Listeners told "the directory changed" after each flushed batch -- see .ai/contexts/bg-agents.md
const descriptorListeners = new Set();
```

After `parseState` add:

```js
// The descriptor subset the agents view reads -- see .ai/contexts/bg-agents.md
function parseDescriptor(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
  const s = (v) => (typeof v === 'string' && v ? v : null);
  return {
    pid: raw.pid,
    sessionId: raw.sessionId,
    kind: s(raw.kind),
    jobId: s(raw.jobId),
    agent: s(raw.agent),
    name: s(raw.name),
    cwd: s(raw.cwd),
    status: KNOWN_STATUSES.has(raw.status) ? raw.status : null,
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
  };
}

function readAllDescriptors() {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  let seen = 0;
  for (const name of names) {
    if (!STATE_FILE_RE.test(name)) continue;
    if (++seen > MAX_DESCRIPTOR_SCAN) break;
    let text;
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    const d = parseDescriptor(text);
    if (d && isProcessAlive(d.pid)) out.push(d);
  }
  return out;
}

function onDescriptorsChanged(listener) {
  descriptorListeners.add(listener);
  return () => { descriptorListeners.delete(listener); };
}

function notifyDescriptorsChanged() {
  for (const listener of descriptorListeners) {
    try { listener(); } catch (err) { log.warn(`[cli-state] descriptor listener failed: ${err.message}`); }
  }
}
```

In `flush()`, after the `for` loop: `if (batch.length > 0) notifyDescriptorsChanged();`

In `scanLiveProcesses`, the `found.set(raw.sessionId, {...})` object gains two fields:

```js
      kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : null,
      jobId: typeof raw.jobId === 'string' && raw.jobId ? raw.jobId : null,
```

Add to `module.exports`: `onDescriptorsChanged, readAllDescriptors, parseDescriptor, ownProcessFilter,`.

`stop()` does not clear `descriptorListeners`: `init()` calls `stop()` once at startup before anyone subscribes, and the quit path has no subscriber to protect.

- [ ] **Step 4: Run the tests**

Run: `node --test test/cli-session-state.test.js test/resume-guard.test.js`
Expected: PASS.

- [ ] **Step 5: Extend the descriptor canary**

Append to `test/canary-cli-session-state.test.js`:

```js
test('CANARY: a background worker descriptor still carries kind "bg" and its short job id (CLI 2.1.285, 2026-09-30)', (t) => {
  const bg = [];
  for (const name of listStateFiles()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8'));
      if (raw && raw.kind === 'bg') bg.push({ name, raw });
    } catch {}
  }
  if (bg.length === 0) {
    t.skip('no kind:"bg" descriptor on this machine — start one with `claude --bg` to pin the shape');
    return;
  }
  for (const { name, raw } of bg) {
    const seen = `(${name}, CLI version ${raw.version || 'unknown'})`;
    assert.match(String(raw.jobId), /^[0-9a-f]{8}$/,
      `PINNED ASSUMPTION BROKEN: a bg descriptor used to carry "jobId", the eight-hex id that joins it to ~/.claude/jobs/<id> and to \`claude attach <id>\` ${seen}`);
    assert.ok(raw.agent === undefined || typeof raw.agent === 'string',
      `PINNED ASSUMPTION BROKEN: "agent" used to be a string when present ${seen}`);
  }
});
```

- [ ] **Step 6: Write the jobs canary**

```js
// test/canary-bg-agents-files.test.js — canary over an external dependency.
//
// Pins the observed shape of ~/.claude/jobs/<id>/state.json, written by the
// Claude CLI's daemon for every `claude --bg` session (CLI 2.1.285, Linux,
// 2026-09-30). bg-agents-roster.js reads it for the agents view. Not a
// documented interface: this test going red means the CLI changed, not that
// Switchboard broke. Skips wherever the directory is absent.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { JOB_STATES } = require('../bg-agents-roster');

const JOBS_DIR = path.join(os.homedir(), '.claude', 'jobs');

function listStateFiles() {
  try {
    return fs.readdirSync(JOBS_DIR)
      .filter(n => /^[0-9a-f]{8}$/.test(n))
      .map(n => path.join(JOBS_DIR, n, 'state.json'))
      .filter(p => fs.existsSync(p));
  } catch {
    return [];
  }
}

test('CANARY: the Claude CLI daemon still writes jobs/<id>/state.json in the shape the agents view reads', (t) => {
  const files = listStateFiles();
  if (files.length === 0) {
    t.skip(`no ${JOBS_DIR}/<id>/state.json on this machine — nothing to pin`);
    return;
  }
  for (const file of files) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const seen = `(${file})`;
    assert.ok(JOB_STATES.has(raw.state),
      `PINNED ASSUMPTION BROKEN: "state" used to be one of ${[...JOB_STATES].join(', ')} ${seen}`);
    assert.ok(raw.detail === undefined || raw.detail === null || typeof raw.detail === 'string',
      `PINNED ASSUMPTION BROKEN: "detail" used to be a string, the one-line status the view shows ${seen}`);
    assert.ok(raw.respawnFlags === undefined || Array.isArray(raw.respawnFlags),
      `PINNED ASSUMPTION BROKEN: "respawnFlags" used to be the original argv (--agent, --model, --name) ${seen}`);
    assert.ok(raw.linkScanPath === undefined || /\.jsonl$/.test(String(raw.linkScanPath)),
      `PINNED ASSUMPTION BROKEN: "linkScanPath" used to end in the session's <sessionId>.jsonl ${seen}`);
    assert.ok(raw.fan === undefined || raw.fan === null || Array.isArray(raw.fan),
      `PINNED ASSUMPTION BROKEN: "fan" used to be an array of {id, kind, label, startedAt, doneAt} ${seen}`);
  }
});
```

- [ ] **Step 7: Run both canaries**

Run: `node --test test/canary-cli-session-state.test.js test/canary-bg-agents-files.test.js`
Expected: PASS (or skip on a machine without the files).

- [ ] **Step 8: Commit**

```bash
/usr/bin/git add cli-session-state.js test/cli-session-state.test.js test/canary-cli-session-state.test.js test/canary-bg-agents-files.test.js
/usr/bin/git commit -m "(cli-state): expose the session descriptors and their bg job id to the agents view"
```

---

### Task 3: `detachPty` in `pty-ops.js`

**Files:**
- Modify: `pty-ops.js`
- Create: `test/pty-ops-detach.test.js`

**Interfaces:**
- Produces: `detachPty(session, sessionId, { graceMs = 2000, schedule = setTimeout } = {}) → boolean` — writes `\x1a`, schedules a kill after `graceMs` unless `session.exited` became true; falls back to `killPty` when the write itself fails.

- [ ] **Step 1: Write the failing test**

```js
// test/pty-ops-detach.test.js — detaching an attach tab must send Ctrl+Z and
// only kill the client if it does not leave by itself. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detachPty } = require('../pty-ops');

function fakeSession() {
  const calls = { writes: [], kills: 0 };
  const session = { exited: false, pty: { write: (d) => calls.writes.push(d), kill: () => { calls.kills++; } } };
  return { session, calls };
}

test('detach writes Ctrl+Z and, when the client exits in time, never kills', () => {
  const { session, calls } = fakeSession();
  const timers = [];
  const ok = detachPty(session, 's1', { graceMs: 2000, schedule: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; } });
  assert.equal(ok, true);
  assert.deepEqual(calls.writes, ['\x1a']);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);
  session.exited = true;
  timers[0].fn();
  assert.equal(calls.kills, 0);
});

test('detach kills once the grace period passes with the client still attached', () => {
  const { session, calls } = fakeSession();
  const timers = [];
  detachPty(session, 's1', { schedule: (fn) => { timers.push(fn); return {}; } });
  timers[0]();
  assert.equal(calls.kills, 1);
});

test('detach on a pty that refuses the write falls back to a kill', () => {
  const calls = { kills: 0 };
  const session = { exited: false, pty: { write: () => { throw new Error('closed'); }, kill: () => { calls.kills++; } } };
  const ok = detachPty(session, 's1', { schedule: () => { throw new Error('must not schedule'); } });
  assert.equal(ok, true);
  assert.equal(calls.kills, 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/pty-ops-detach.test.js`
Expected: FAIL, `detachPty is not a function`.

- [ ] **Step 3: Implement**

In `pty-ops.js`, after `writePty`:

```js
// Ctrl+Z asks `claude attach` to leave; the session it showed keeps running -- see .ai/contexts/bg-agents.md
function detachPty(session, sessionId, { graceMs = 2000, schedule = setTimeout } = {}) {
  const wrote = withPty(session, 'detach', (pty) => pty.write('\x1a'), sessionId);
  if (!wrote) return killPty(session, sessionId);
  const timer = schedule(() => {
    if (!session.exited) killPty(session, sessionId);
  }, graceMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return true;
}
```

Add `detachPty` to `module.exports`.

- [ ] **Step 4: Run it**

Run: `node --test test/pty-ops-detach.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add pty-ops.js test/pty-ops-detach.test.js
/usr/bin/git commit -m "(pty): detach an attach client with Ctrl+Z before ever killing it"
```

---

### Task 4: The stateful roster (`bg-agents.js`)

**Files:**
- Create: `bg-agents.js`
- Test: `test/bg-agents.test.js`

**Interfaces:**
- Consumes: Task 1's roster functions; Task 2's `cliSessionState.{onDescriptorsChanged, readAllDescriptors, ensureWatching}`.
- Produces:
  - `init({ jobsDir?, log, runClaude, cliSessionState, makeIsOwnPid, isAttachedHere, homeDir? })` where `runClaude(argv, { cwd, timeout }) → Promise<{ code, stdout, stderr }>`
  - `start() → boolean`, `stop()`, `onChange(listener) → unsubscribe` (listener gets `{ roster, daemonReachable }`), `getSnapshot() → { roster, daemonReachable }`, `reconcile() → Promise<snapshot>`, `runVerb(verb, id) → Promise<{ ok, error? }>`, `dispatch(fields) → Promise<{ ok, id?, error? }>`
  - Constants `DEFAULT_JOBS_DIR`, `FLUSH_MS = 250`, `MAX_JOBS = 200`, `LIST_TIMEOUT_MS = 5000`, `VERB_TIMEOUT_MS = 15000`

- [ ] **Step 1: Write the failing tests**

```js
// test/bg-agents.test.js — the stateful half of the agents view: watchers over
// ~/.claude/jobs, reconciliation through the CLI, verbs. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bgAgents = require('../bg-agents');

function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-bg-agents-')));
}
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const delay = (ms) => new Promise(r => setTimeout(r, ms));
function waitFor(fn, maxMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (fn()) return resolve();
      if (Date.now() - start > maxMs) return reject(new Error('timed out'));
      setTimeout(poll, 20);
    })();
  });
}

function writeJob(dir, id, state) {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'state.json'), JSON.stringify(state), 'utf8');
}

const CLI_LIST = [
  { id: 'aaaaaaaa', sessionId: 's-a', name: 'a', cwd: '/a', kind: 'background', startedAt: 1, state: 'working', status: 'idle', pid: 10 },
  { id: 'bbbbbbbb', sessionId: 's-b', name: 'b', cwd: '/b', kind: 'background', startedAt: 2, state: 'done' },
];

function fakeCli(overrides = {}) {
  const calls = [];
  const runClaude = async (argv, opts) => {
    calls.push({ argv, opts });
    if (overrides.fail) return { code: 1, stdout: '', stderr: 'boom' };
    if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(overrides.list || CLI_LIST), stderr: '' };
    if (argv[0] === '--bg') return { code: 0, stdout: 'Started background session cccccccc\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, runClaude };
}

function fakeSessionState(descriptors = []) {
  const listeners = new Set();
  return {
    listeners,
    onDescriptorsChanged: (l) => { listeners.add(l); return () => listeners.delete(l); },
    readAllDescriptors: () => descriptors,
    ensureWatching: () => true,
    fire() { for (const l of listeners) l(); },
  };
}

function boot(dir, { cli = fakeCli(), sessionState = fakeSessionState(), attached = () => false } = {}) {
  bgAgents.init({
    jobsDir: dir, log: silentLog, runClaude: cli.runClaude, cliSessionState: sessionState,
    makeIsOwnPid: () => () => false, isAttachedHere: attached,
  });
  return { cli, sessionState };
}

test.afterEach(() => bgAgents.stop());

test('reconcile runs `claude agents --json --all`, merges the job files, and reports the daemon reachable', async () => {
  const dir = mkTmp();
  try {
    writeJob(dir, 'aaaaaaaa', { state: 'working', detail: 'reading rules', tokens: 42 });
    const { cli } = boot(dir);
    assert.equal(bgAgents.start(), true);
    const snap = await bgAgents.reconcile();
    assert.deepEqual(cli.calls[0].argv, ['agents', '--json', '--all']);
    assert.equal(cli.calls[0].opts.timeout, bgAgents.LIST_TIMEOUT_MS);
    assert.equal(snap.daemonReachable, true);
    assert.deepEqual(snap.roster.map(e => e.id), ['aaaaaaaa', 'bbbbbbbb']);
    assert.equal(snap.roster[0].detail, 'reading rules');
    assert.equal(snap.roster[0].tokens, 42);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a state.json rewrite reaches listeners once, coalesced, without another CLI call', async () => {
  const dir = mkTmp();
  try {
    writeJob(dir, 'aaaaaaaa', { state: 'working', detail: 'one' });
    const { cli } = boot(dir);
    bgAgents.start();
    await bgAgents.reconcile();
    const seen = [];
    bgAgents.onChange((snap) => seen.push(snap.roster.find(e => e.id === 'aaaaaaaa').detail));
    const callsBefore = cli.calls.length;
    writeJob(dir, 'aaaaaaaa', { state: 'working', detail: 'two' });
    await waitFor(() => seen.includes('two'));
    await delay(bgAgents.FLUSH_MS * 2);
    assert.deepEqual(seen, ['two']);
    assert.equal(cli.calls.length, callsBefore, 'a file change never spawns the CLI');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a job directory that appears after start is watched too', async () => {
  const dir = mkTmp();
  try {
    boot(dir);
    bgAgents.start();
    await bgAgents.reconcile();
    const seen = [];
    bgAgents.onChange((snap) => seen.push((snap.roster.find(e => e.id === 'bbbbbbbb') || {}).detail));
    writeJob(dir, 'bbbbbbbb', { state: 'done', detail: 'late' });
    await waitFor(() => seen.includes('late'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an empty state.json (mid-rewrite) keeps the previous value', async () => {
  const dir = mkTmp();
  try {
    writeJob(dir, 'aaaaaaaa', { state: 'working', detail: 'kept' });
    boot(dir);
    bgAgents.start();
    await bgAgents.reconcile();
    fs.writeFileSync(path.join(dir, 'aaaaaaaa', 'state.json'), '', 'utf8');
    await delay(bgAgents.FLUSH_MS * 3);
    assert.equal(bgAgents.getSnapshot().roster[0].detail, 'kept');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a descriptor change rebuilds the roster from readAllDescriptors', async () => {
  const dir = mkTmp();
  try {
    const descriptors = [];
    const sessionState = fakeSessionState(descriptors);
    boot(dir, { sessionState });
    bgAgents.start();
    await bgAgents.reconcile();
    const seen = [];
    bgAgents.onChange((snap) => seen.push(snap.roster.map(e => e.sessionId).join(',')));
    descriptors.push({ pid: 30, sessionId: 's-ext', kind: 'interactive', jobId: null, agent: null, name: 'ext', cwd: '/e', status: 'busy', startedAt: 3 });
    sessionState.fire();
    await waitFor(() => seen.some(s => s.includes('s-ext')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('when the CLI fails the roster comes from the files and the daemon is reported unreachable', async () => {
  const dir = mkTmp();
  try {
    writeJob(dir, 'cccccccc', { state: 'stopped', detail: 'from disk' });
    boot(dir, { cli: fakeCli({ fail: true }) });
    bgAgents.start();
    const snap = await bgAgents.reconcile();
    assert.equal(snap.daemonReachable, false);
    assert.deepEqual(snap.roster.map(e => e.id), ['cccccccc']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runVerb spawns `claude <verb> <id>` in the session cwd when it exists, then reconciles', async () => {
  const dir = mkTmp();
  try {
    const list = [{ ...CLI_LIST[0], cwd: dir }];
    const { cli } = boot(dir, { cli: fakeCli({ list }) });
    bgAgents.start();
    await bgAgents.reconcile();
    const r = await bgAgents.runVerb('stop', 'aaaaaaaa');
    assert.deepEqual(r, { ok: true });
    const verbCall = cli.calls.find(c => c.argv[0] === 'stop');
    assert.deepEqual(verbCall.argv, ['stop', 'aaaaaaaa']);
    assert.equal(verbCall.opts.cwd, dir);
    assert.equal(verbCall.opts.timeout, bgAgents.VERB_TIMEOUT_MS);
    assert.equal(cli.calls[cli.calls.length - 1].argv[0], 'agents', 'a verb is followed by a reconcile');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runVerb refuses an unknown verb or a malformed id before spawning anything', async () => {
  const dir = mkTmp();
  try {
    const { cli } = boot(dir);
    bgAgents.start();
    assert.equal((await bgAgents.runVerb('kill', 'aaaaaaaa')).ok, false);
    assert.equal((await bgAgents.runVerb('stop', '--all')).ok, false);
    assert.equal((await bgAgents.runVerb('rm', 'AAAAAAAA')).ok, false);
    assert.equal(cli.calls.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runVerb reports the CLI stderr when it fails', async () => {
  const dir = mkTmp();
  try {
    boot(dir, { cli: fakeCli({ fail: true }) });
    bgAgents.start();
    const r = await bgAgents.runVerb('rm', 'aaaaaaaa');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'boom');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dispatch runs `claude --bg …` in the project directory and returns the printed id', async () => {
  const dir = mkTmp();
  try {
    const { cli } = boot(dir);
    bgAgents.start();
    const r = await bgAgents.dispatch({ prompt: 'hello', name: 'n', cwd: dir });
    assert.deepEqual(r, { ok: true, id: 'cccccccc' });
    const call = cli.calls.find(c => c.argv[0] === '--bg');
    assert.deepEqual(call.argv, ['--bg', '--name', 'n', 'hello']);
    assert.equal(call.opts.cwd, dir);
    const missing = await bgAgents.dispatch({ prompt: 'hello', cwd: path.join(dir, 'nope') });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /no longer exists/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stop releases the watchers: a later write reaches nobody', async () => {
  const dir = mkTmp();
  try {
    writeJob(dir, 'aaaaaaaa', { state: 'working' });
    boot(dir);
    bgAgents.start();
    let fired = 0;
    bgAgents.onChange(() => fired++);
    bgAgents.stop();
    writeJob(dir, 'aaaaaaaa', { state: 'done' });
    await delay(bgAgents.FLUSH_MS * 3);
    assert.equal(fired, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/bg-agents.test.js`
Expected: FAIL, `Cannot find module '../bg-agents'`.

- [ ] **Step 3: Write the module**

```js
// bg-agents.js — see .ai/contexts/bg-agents.md
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseJobState, parseCliList, mergeRoster, dispatchArgs, parseDispatchOutput, JOB_ID_RE,
} = require('./bg-agents-roster');

const DEFAULT_JOBS_DIR = path.join(os.homedir(), '.claude', 'jobs');
const FLUSH_MS = 250;
const MAX_JOBS = 200;
const LIST_TIMEOUT_MS = 5000;
const VERB_TIMEOUT_MS = 15000;
const VERBS = new Set(['stop', 'respawn', 'rm']);

let jobsDir = DEFAULT_JOBS_DIR;
let homeDir = os.homedir();
let log = { info() {}, warn() {}, error() {}, debug() {} };
let runClaude = null;
let cliSessionState = null;
let makeIsOwnPid = () => () => false;
let isAttachedHere = () => false;

let started = false;
let dirWatcher = null;
const jobWatchers = new Map();
const jobs = new Map();
let cliList = null;
let daemonReachable = false;
let roster = [];
let flushTimer = null;
let unsubscribeDescriptors = null;
const listeners = new Set();

function init(ctx) {
  stop();
  jobsDir = ctx.jobsDir || DEFAULT_JOBS_DIR;
  homeDir = ctx.homeDir || os.homedir();
  log = ctx.log || log;
  runClaude = ctx.runClaude;
  cliSessionState = ctx.cliSessionState;
  makeIsOwnPid = ctx.makeIsOwnPid || (() => () => false);
  isAttachedHere = ctx.isAttachedHere || (() => false);
}

function onChange(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot() {
  return { roster, daemonReachable };
}

function emit() {
  const snapshot = getSnapshot();
  for (const listener of listeners) {
    try { listener(snapshot); } catch (err) { log.warn(`[bg-agents] listener failed: ${err.message}`); }
  }
}

function rebuild() {
  let descriptors = [];
  try { descriptors = cliSessionState ? cliSessionState.readAllDescriptors() : []; } catch {}
  roster = mergeRoster({
    cli: daemonReachable ? cliList : null,
    jobs,
    descriptors,
    isOwnPid: makeIsOwnPid(),
    isAttachedHere,
  });
  emit();
}

function scheduleRebuild() {
  if (!started || flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; rebuild(); }, FLUSH_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function readJob(id) {
  let text;
  try { text = fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8'); } catch { return; }
  const job = parseJobState(text);
  if (job) jobs.set(id, job);
  else log.debug(`[bg-agents] ${id}/state.json unreadable, keeping the previous value`);
}

function watchJob(id) {
  if (jobWatchers.has(id)) return;
  readJob(id);
  try {
    const watcher = fs.watch(path.join(jobsDir, id), (_eventType, filename) => {
      if (filename && filename !== 'state.json') return;
      readJob(id);
      scheduleRebuild();
    });
    watcher.on('error', () => { try { watcher.close(); } catch {} jobWatchers.delete(id); });
    jobWatchers.set(id, watcher);
  } catch (err) {
    log.debug(`[bg-agents] cannot watch ${id}: ${err.message}`);
  }
}

function syncJobWatchers() {
  let names;
  try { names = fs.readdirSync(jobsDir); } catch { names = []; }
  const ids = names.filter(n => JOB_ID_RE.test(n)).sort().slice(0, MAX_JOBS);
  const wanted = new Set(ids);
  for (const [id, watcher] of jobWatchers) {
    if (wanted.has(id)) continue;
    try { watcher.close(); } catch {}
    jobWatchers.delete(id);
    jobs.delete(id);
  }
  for (const id of ids) watchJob(id);
  scheduleRebuild();
}

function start() {
  if (started) return true;
  started = true;
  try {
    dirWatcher = fs.watch(jobsDir, () => syncJobWatchers());
    dirWatcher.on('error', (err) => { log.warn(`[bg-agents] jobs watcher error: ${err.message}`); });
  } catch (err) {
    dirWatcher = null;
    log.debug(`[bg-agents] cannot watch ${jobsDir}: ${err.message}`);
  }
  syncJobWatchers();
  if (cliSessionState) {
    unsubscribeDescriptors = cliSessionState.onDescriptorsChanged(scheduleRebuild);
    try { cliSessionState.ensureWatching(); } catch {}
  }
  return true;
}

function stop() {
  started = false;
  if (dirWatcher) { try { dirWatcher.close(); } catch {} dirWatcher = null; }
  for (const watcher of jobWatchers.values()) { try { watcher.close(); } catch {} }
  jobWatchers.clear();
  jobs.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (unsubscribeDescriptors) { unsubscribeDescriptors(); unsubscribeDescriptors = null; }
  listeners.clear();
  cliList = null;
  daemonReachable = false;
  roster = [];
}

async function run(argv, opts) {
  if (typeof runClaude !== 'function') return { code: null, stdout: '', stderr: 'claude runner not configured' };
  try {
    return await runClaude(argv, opts);
  } catch (err) {
    return { code: null, stdout: '', stderr: err && err.message ? err.message : String(err) };
  }
}

async function reconcile() {
  const result = await run(['agents', '--json', '--all'], { cwd: homeDir, timeout: LIST_TIMEOUT_MS });
  const list = result.code === 0 ? parseCliList(result.stdout) : null;
  if (list) {
    cliList = list;
    daemonReachable = true;
    syncJobWatchers();
  } else {
    cliList = null;
    daemonReachable = false;
    log.debug(`[bg-agents] claude agents --json failed: code=${result.code} ${String(result.stderr).trim().slice(0, 200)}`);
  }
  rebuild();
  return getSnapshot();
}

function cwdFor(id) {
  const entry = roster.find(e => e.kind === 'background' && e.id === id);
  if (entry && entry.cwd && fs.existsSync(entry.cwd)) return entry.cwd;
  return homeDir;
}

async function runVerb(verb, id) {
  if (!VERBS.has(verb)) return { ok: false, error: `unknown verb: ${String(verb)}` };
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) return { ok: false, error: 'invalid background session id' };
  const result = await run([verb, id], { cwd: cwdFor(id), timeout: VERB_TIMEOUT_MS });
  const ok = result.code === 0;
  const error = ok ? null : (String(result.stderr).trim() || `claude ${verb} exited with ${result.code}`);
  await reconcile();
  return ok ? { ok: true } : { ok: false, error };
}

async function dispatch(fields) {
  const built = dispatchArgs(fields);
  if (!built.ok) return { ok: false, error: built.error };
  if (!fs.existsSync(built.cwd)) return { ok: false, error: `project directory no longer exists: ${built.cwd}` };
  const result = await run(built.args, { cwd: built.cwd, timeout: VERB_TIMEOUT_MS });
  if (result.code !== 0) {
    return { ok: false, error: String(result.stderr).trim() || `claude --bg exited with ${result.code}` };
  }
  const id = parseDispatchOutput(result.stdout);
  await reconcile();
  return { ok: true, id };
}

module.exports = {
  init, start, stop, onChange, getSnapshot, reconcile, runVerb, dispatch,
  DEFAULT_JOBS_DIR, FLUSH_MS, MAX_JOBS, LIST_TIMEOUT_MS, VERB_TIMEOUT_MS,
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/bg-agents.test.js`
Expected: PASS, 11 tests. If "a job directory that appears after start" is flaky, the directory watcher fired before `state.json` existed: `watchJob` reads nothing then, and the per-directory watcher catches the file's creation — check `readJob` is called from that watcher for a `filename` of `null` too (it is: only a non-null, different name returns early).

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add bg-agents.js test/bg-agents.test.js
/usr/bin/git commit -m "(bg-agents): keep a roster of the daemon's sessions from its files, reconciled by the CLI"
```

---

### Task 5: Main-process wiring: IPC, attach, detach, preload

**Files:**
- Create: `bg-agents-ipc.js`
- Modify: `main.js` (imports at the top; a `runClaudeCommand` helper before `open-terminal`; the attach branch inside `open-terminal`; `stop-session`; the `closed` handler; module wiring after `sessions-live-elsewhere`)
- Modify: `preload.js`
- Create: `test/bg-agents-ipc.test.js`
- Create: `test/open-terminal-attach.test.js`

**Interfaces:**
- Consumes: `bgAgents` (Task 4), `detachPty` (Task 3).
- Produces:
  - IPC `get-bg-agents` → `{ roster, daemonReachable }` (arms the watchers, reconciles); `bg-agent-verb (verb, id)` → `{ ok, error? }`; `dispatch-bg-agent (fields)` → `{ ok, id?, error? }`; event `bg-agents-changed` with `{ roster, daemonReachable }`.
  - `open-terminal` accepts `sessionOptions = { type: 'attach', jobId, cwd }` and runs `claude attach <jobId>`; the session record carries `isAttach: true, attachJobId`.
  - `stop-session` on an attach session detaches and returns `{ ok: true, detached: true }`.
  - `preload.js`: `getBgAgents()`, `bgAgentVerb(verb, id)`, `dispatchBgAgent(fields)`, `onBgAgentsChanged(cb)`.

- [ ] **Step 1: Write the failing IPC test**

```js
// test/bg-agents-ipc.test.js — the three handlers and the push. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { init } = require('../bg-agents-ipc');

function fakeIpc() {
  const handlers = new Map();
  return { handlers, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
}

function fakeBgAgents() {
  const calls = [];
  let listener = null;
  return {
    calls,
    start: () => { calls.push('start'); return true; },
    reconcile: async () => { calls.push('reconcile'); return { roster: [], daemonReachable: true }; },
    runVerb: async (verb, id) => { calls.push(['verb', verb, id]); return { ok: true }; },
    dispatch: async (fields) => { calls.push(['dispatch', fields]); return { ok: true, id: 'aaaaaaaa' }; },
    onChange: (l) => { listener = l; return () => { listener = null; }; },
    fire: (snap) => listener && listener(snap),
  };
}

test('get-bg-agents arms the watchers then reconciles; the verbs pass straight through', async () => {
  const { handlers, ipcMain } = fakeIpc();
  const bg = fakeBgAgents();
  init({ ipcMain, bgAgents: bg, getMainWindow: () => null, log: { warn() {} } });
  assert.deepEqual(await handlers.get('get-bg-agents')({}), { roster: [], daemonReachable: true });
  assert.deepEqual(bg.calls, ['start', 'reconcile']);
  assert.deepEqual(await handlers.get('bg-agent-verb')({}, 'stop', 'aaaaaaaa'), { ok: true });
  assert.deepEqual(await handlers.get('dispatch-bg-agent')({}, { prompt: 'p', cwd: '/x' }), { ok: true, id: 'aaaaaaaa' });
  assert.deepEqual(bg.calls.slice(2), [['verb', 'stop', 'aaaaaaaa'], ['dispatch', { prompt: 'p', cwd: '/x' }]]);
});

test('a roster change is pushed to the window on bg-agents-changed, and skipped when the window is gone', () => {
  const { ipcMain } = fakeIpc();
  const bg = fakeBgAgents();
  const sent = [];
  let window = { isDestroyed: () => false, webContents: { send: (ch, payload) => sent.push([ch, payload]) } };
  init({ ipcMain, bgAgents: bg, getMainWindow: () => window, log: { warn() {} } });
  bg.fire({ roster: [{ id: 'aaaaaaaa' }], daemonReachable: true });
  assert.deepEqual(sent, [['bg-agents-changed', { roster: [{ id: 'aaaaaaaa' }], daemonReachable: true }]]);
  window = null;
  bg.fire({ roster: [], daemonReachable: false });
  assert.equal(sent.length, 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/bg-agents-ipc.test.js`
Expected: FAIL, `Cannot find module '../bg-agents-ipc'`.

- [ ] **Step 3: Write `bg-agents-ipc.js`**

```js
// bg-agents-ipc.js — see .ai/contexts/bg-agents.md and .ai/contexts/ipc-bridge.md
'use strict';

function init({ ipcMain, bgAgents, getMainWindow, log }) {
  ipcMain.handle('get-bg-agents', async () => {
    bgAgents.start();
    return bgAgents.reconcile();
  });
  ipcMain.handle('bg-agent-verb', (_event, verb, id) => bgAgents.runVerb(verb, id));
  ipcMain.handle('dispatch-bg-agent', (_event, fields) => bgAgents.dispatch(fields));
  bgAgents.onChange((snapshot) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('bg-agents-changed', snapshot); } catch (err) { log.warn(`[bg-agents] push failed: ${err.message}`); }
  });
}

module.exports = { init };
```

- [ ] **Step 4: Run it**

Run: `node --test test/bg-agents-ipc.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing source-level pins for `main.js`**

```js
// test/open-terminal-attach.test.js — main.js cannot be required in a test
// (it boots Electron), so the attach branch of open-terminal, the detach in
// stop-session and the teardown are pinned at source level, the technique of
// test/open-session-terminal.test.js. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('open-terminal builds `claude attach <id>` for an attach session and never a --resume', () => {
  assert.match(MAIN, /const isAttach = sessionOptions\?\.type === 'attach';/);
  assert.match(MAIN, /claudeArgs\.push\('attach', attachJobId\);/);
  assert.match(MAIN, /if \(!isAttach && sessionOptions\?\.sandbox\)/);
  assert.match(MAIN, /if \(!isAttach && sessionOptions\?\.preLaunchCmd\)/);
  assert.match(MAIN, /if \(!isAttach && sessionOptions\?\.mcpEmulation !== false\)/);
  assert.match(MAIN, /isAttach, attachJobId,/, 'the session record must carry both fields');
});

test('an attach job id is validated against the eight-hex shape before anything is spawned', () => {
  assert.match(MAIN, /JOB_ID_RE\.test\(String\(sessionOptions\.jobId\)\)/);
});

test('stop-session detaches an attach session instead of killing it', () => {
  const idx = MAIN.indexOf("ipcMain.handle('stop-session'");
  const body = MAIN.slice(idx, idx + 600);
  assert.match(body, /if \(session\.isAttach\)/);
  assert.match(body, /detachPty\(session, sessionId\)/);
  assert.match(body, /detached: true/);
});

test('the window closing releases the agents watchers', () => {
  const idx = MAIN.indexOf("mainWindow.on('closed'");
  assert.match(MAIN.slice(idx, idx + 900), /bgAgents\.stop\(\);/);
});

test('preload exposes the four agents-view entries', () => {
  for (const name of ['getBgAgents', 'bgAgentVerb', 'dispatchBgAgent', 'onBgAgentsChanged']) {
    assert.ok(PRELOAD.includes(name + ':'), `${name} missing from preload.js`);
  }
  assert.match(PRELOAD, /ipcRenderer\.on\('bg-agents-changed'/);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test test/open-terminal-attach.test.js`
Expected: 5 FAIL.

- [ ] **Step 7: Edit `main.js`**

Line 3, the `child_process` import becomes:

```js
const { execFile, spawn: spawnChild } = require('child_process');
```

Line 83, the pty-ops import gains `detachPty`:

```js
const { setPtyOpLogger, resizePty, killPty, detachPty, ptyExitSignalName } = require('./pty-ops');
```

Next to the other top-level requires (after line 83), add:

```js
const { JOB_ID_RE } = require('./bg-agents-roster');
```

`cleanPtyEnv` is a top-level const (`main.js:46`) and `getSetting` a top-level import (`main.js:149`), so the helper below can use them. Immediately before `ipcMain.handle('open-terminal'` (line 2272), add the runner the agents module uses. It is the scheduler's spawn path (login shell, quoted argv) with captured output and a timeout:

```js
// Run `claude <argv>` to completion through the login shell -- see .ai/contexts/bg-agents.md
function runClaudeCommand(claudeArgv, { cwd, timeout }) {
  return new Promise((resolve) => {
    const globalSettings = getSetting('global') || {};
    const profile = resolveShell(globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile);
    const shell = profile.path;
    const args = shellArgs(shell, 'claude ' + quoteArgvForShell(shell, claudeArgv), profile.args || []);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code, err) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr: err ? `${stderr}${err.message}` : stderr });
    };
    let child;
    try {
      child = spawnChild(shell, args, {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...cleanPtyEnv, FORCE_COLOR: '0' }, windowsHide: true,
      });
    } catch (err) {
      finish(null, err);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(null, new Error(`claude ${claudeArgv[0]} timed out after ${timeout} ms`));
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); finish(null, err); });
    child.on('exit', (code) => { clearTimeout(timer); finish(code); });
  });
}
```

Inside `open-terminal`:

(a) The resume-cwd block at line 2347 must not run for an attach:

```js
  if (resumeSourceId && sessionOptions?.type !== 'terminal' && sessionOptions?.type !== 'attach') {
```

(b) Right after that block (before the `panelOwnerId` comment) add:

```js
  // see .ai/contexts/bg-agents.md ("Attach")
  const isAttach = sessionOptions?.type === 'attach';
  let attachJobId = null;
  if (isAttach) {
    if (!JOB_ID_RE.test(String(sessionOptions.jobId))) return { ok: false, error: 'invalid background session id' };
    attachJobId = String(sessionOptions.jobId);
    if (typeof sessionOptions.cwd === 'string' && sessionOptions.cwd) spawnCwd = sessionOptions.cwd;
  }
```

(c) In the `else` branch that builds the claude command, wrap the existing args logic:

```js
      const claudeArgs = [];
      if (isAttach) {
        claudeArgs.push('attach', attachJobId);
      } else {
        // (the existing block from `const startsFresh = …` through the
        //  `--append-system-prompt` push moves here, unchanged)
      }
```

and guard the three post-processing blocks:

```js
      if (!isAttach && sessionOptions?.sandbox) {
      …
      if (!isAttach && sessionOptions?.preLaunchCmd) {
      …
      if (!isAttach && sessionOptions?.mcpEmulation !== false) {
```

(d) The session record (line 2598) gains, after `isPlainTerminal, panelFor: panelOwnerId, forkFrom: …,`:

```js
    isAttach, attachJobId,
```

`stop-session` (line 1689) becomes:

```js
ipcMain.handle('stop-session', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited) return { ok: false, error: 'not running' };
  session.stopRequested = true;
  // see .ai/contexts/bg-agents.md ("Detach")
  if (session.isAttach) {
    detachPty(session, sessionId);
    return { ok: true, detached: true };
  }
  killPty(session, sessionId);
  return { ok: true };
});
```

In the `closed` handler (line 412), after `closeAllFileWatchers();` add `bgAgents.stop();`. `bgAgents` is declared later in the file with `const`; the handler runs long after module evaluation, so the reference is fine (the same holds for `changesWatchers` there).

After the `sessions-live-elsewhere` handler (line 2861) add:

```js
// see .ai/contexts/bg-agents.md
const bgAgents = require('./bg-agents');
bgAgents.init({
  log,
  runClaude: runClaudeCommand,
  cliSessionState,
  makeIsOwnPid: () => cliSessionState.ownProcessFilter(ptyPids),
  isAttachedHere: (jobId) => {
    for (const session of activeSessions.values()) {
      if (session && !session.exited && session.isAttach && session.attachJobId === jobId) return true;
    }
    return false;
  },
});
require('./bg-agents-ipc').init({ ipcMain, bgAgents, getMainWindow: () => mainWindow, log });
```

- [ ] **Step 8: Edit `preload.js`**

After the `stopSession:` line add:

```js
  // see .ai/contexts/bg-agents.md
  getBgAgents: () => ipcRenderer.invoke('get-bg-agents'),
  bgAgentVerb: (verb, id) => ipcRenderer.invoke('bg-agent-verb', verb, id),
  dispatchBgAgent: (fields) => ipcRenderer.invoke('dispatch-bg-agent', fields),
```

In the listeners block, after `onSubagentWatchEvent`:

```js
  onBgAgentsChanged: (cb) => ipcRenderer.on('bg-agents-changed', (_e, payload) => cb(payload)),
```

- [ ] **Step 9: Run the pins and the lint**

Run: `node --test test/open-terminal-attach.test.js && npx eslint main.js preload.js bg-agents-ipc.js`
Expected: PASS, 0 lint errors.

- [ ] **Step 10: Commit**

```bash
/usr/bin/git add main.js preload.js bg-agents-ipc.js test/bg-agents-ipc.test.js test/open-terminal-attach.test.js
/usr/bin/git commit -m "(main): attach to a background session in a tab, detach on close, expose the agents roster"
```

---

### Task 6: Shortcut, resume guard, detach wording

**Files:**
- Modify: `public/shortcuts.js`, `public/resume-guard.js`, `public/stop-session-ui.js`
- Create: `test/agents-toggle-shortcut.test.js`, `test/stop-session-ui-attach.test.js`
- Modify: `test/resume-guard.test.js` (append)

**Interfaces:**
- Produces: `DEFAULT_SHORTCUTS.agentsToggle = { primary: true, alt: false, shift: true, key: 'a' }`; `guardResume(...)` now returns `true | false | { attach: jobId, cwd }`; `resolveSessionStop(session, { attach })` returns `{ remote: false, alias: null, attach: true, confirmText }` for an attach tab.

- [ ] **Step 1: Write the failing tests**

```js
// test/agents-toggle-shortcut.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SHORTCUTS, SHORTCUT_DEFS, matchShortcut, normalizeShortcuts, formatBinding } = require('../public/shortcuts');

test('agentsToggle defaults to Primary+Shift+A and is a rebindable key-family action', () => {
  assert.deepEqual(DEFAULT_SHORTCUTS.agentsToggle, { primary: true, alt: false, shift: true, key: 'a' });
  const def = SHORTCUT_DEFS.find(d => d.id === 'agentsToggle');
  assert.equal(def.family, 'key');
  assert.equal(formatBinding('agentsToggle', false, normalizeShortcuts(null)), 'Ctrl+Shift+A');
  const e = { key: 'A', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
  assert.equal(matchShortcut('agentsToggle', e, false, normalizeShortcuts(null)), true);
  assert.equal(matchShortcut('gridToggle', e, false, normalizeShortcuts(null)), false);
});
```

Append to `test/resume-guard.test.js`:

```js
// --- Background sessions (see .ai/contexts/bg-agents.md) --------------------

const LIVE_BG = { pid: 346590, cwd: '/w/em', startedAt: 1, kind: 'bg', jobId: 'bc3fd129' };

test('a user click on a session the daemon runs answers "attach", without asking', async () => {
  const api = makeApi(LIVE_BG);
  const { confirm, messages } = makeConfirm(false);
  assert.deepEqual(await guardResume(SESSION, { api, confirm }), { attach: 'bc3fd129', cwd: '/w/em' });
  assert.equal(messages.length, 0);
});

test('an automatic resume of a session the daemon runs is still refused', async () => {
  const api = makeApi(LIVE_BG);
  const { confirm } = makeConfirm(true);
  assert.equal(await guardResume(SESSION, { automatic: true, api, confirm }), false);
});

test('app.js turns the attach verdict into attach options and skips the guard for an explicit attach', () => {
  const app = read('public/app.js');
  assert.match(app, /customOptions\?\.type === 'attach'\s*\?\s*true\s*:\s*await guardResume\(/);
  assert.match(app, /if \(verdict === false\) return false;/);
  assert.match(app, /customOptions = \{ type: 'attach', jobId: verdict\.attach, cwd: verdict\.cwd \|\| projectPath \};/);
  assert.match(app, /entry\.attach = resumeOptions\.type === 'attach';/);
  assert.match(app, /if \(entry\.attach\) continue; \/\/ attach tabs are not restored/);
});
```

```js
// test/stop-session-ui-attach.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSessionStop } = require('../public/stop-session-ui');

test('an attach tab asks to detach, not to stop, and stays local', () => {
  const plan = resolveSessionStop({ sessionId: 's' }, { attach: true });
  assert.equal(plan.remote, false);
  assert.equal(plan.attach, true);
  assert.match(plan.confirmText, /Detach/);
  assert.match(plan.confirmText, /keeps running/);
  assert.equal(resolveSessionStop({ sessionId: 's' }).attach, false);
  assert.equal(resolveSessionStop({ sessionId: 's', remoteAlias: 'h' }, { attach: true }).remote, true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/agents-toggle-shortcut.test.js test/resume-guard.test.js test/stop-session-ui-attach.test.js`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

`public/shortcuts.js`, in `DEFAULT_SHORTCUTS` after `gridToggle`:

```js
  // Ctrl/Cmd+Shift+A — toggle the background agents view.
  agentsToggle: { primary: true, alt: false, shift: true, key: 'a' },
```

and in `SHORTCUT_DEFS` after the `gridToggle` entry:

```js
  {
    id: 'agentsToggle',
    label: 'Toggle agents view',
    description: 'Show or hide the background agents view',
    family: 'key',
  },
```

`public/resume-guard.js`, `guardResume` becomes:

```js
async function guardResume(session, { automatic = false, api, confirm, live } = {}) {
  if (!session || session.type === 'terminal') return true;
  if (live === undefined) {
    try {
      live = await api.getSessionLiveElsewhere(session.sessionId);
    } catch {
      live = null;
    }
  }
  if (!live) return true;
  if (automatic) return false;
  // A session the claude daemon runs is attached, never resumed -- see .ai/contexts/bg-agents.md
  if (live.kind === 'bg' && typeof live.jobId === 'string' && live.jobId) {
    return { attach: live.jobId, cwd: live.cwd || null };
  }
  return !!confirm(liveElsewhereMessage(live));
}
```

`public/stop-session-ui.js`, `resolveSessionStop` becomes:

```js
function resolveSessionStop(session, { attach = false } = {}) {
  const alias = session && session.remoteAlias;
  if (alias) {
    return { remote: true, alias, attach: false, confirmText: `Stop this session on ${alias}?` };
  }
  if (attach) {
    return { remote: false, alias: null, attach: true, confirmText: 'Detach from this background session? It keeps running; the Agents view can stop it.' };
  }
  return { remote: false, alias: null, attach: false, confirmText: 'Stop this session?' };
}
```

`public/app.js`:

In `persistWorkingSet` (line 176), after `if (entry.session.type === 'terminal') continue; // exclude plain shells` add:

```js
      if (entry.attach) continue; // attach tabs are not restored
```

In `openSession` (line 1170), replace the guard line and the `resumeOptions` block with:

```js
  // see .ai/contexts/cli-session-state.md ("Live elsewhere") and .ai/contexts/bg-agents.md ("Attach")
  const verdict = customOptions?.type === 'attach' ? true : await guardResume(session, { automatic, live, api: window.api, confirm: (msg) => window.confirm(msg) });
  if (verdict === false) return false;
  if (verdict && typeof verdict === 'object' && verdict.attach) {
    customOptions = { type: 'attach', jobId: verdict.attach, cwd: verdict.cwd || projectPath };
  }

  // Create new terminal entry (hidden until showSession)
  const entry = createTerminalEntry(session);

  // Open terminal in main process — see .ai/contexts/session-state.md ("Reopening a plain terminal")
  const resumeOptions = customOptions
    || (session.type === 'terminal' ? { type: 'terminal' } : await resolveDefaultSessionOptions({ projectPath }));
  entry.attach = resumeOptions.type === 'attach';
```

In `confirmAndStopSession` (line 822), the first line becomes:

```js
  const openEntry = openSessions.get(sessionId);
  const plan = resolveSessionStop(sessionMap.get(sessionId), { attach: !!(openEntry && openEntry.attach) });
```

In `showTerminalHeader` (line 1140), after `terminalHeaderSandbox.style.display = …;` add:

```js
  const headerEntry = openSessions.get(session.sessionId);
  terminalStopBtn.title = headerEntry && headerEntry.attach ? 'Detach (the session keeps running)' : 'Stop process';
  terminalStopBtn.setAttribute('aria-label', terminalStopBtn.title);
```

- [ ] **Step 4: Run the tests and lint**

Run: `node --test test/agents-toggle-shortcut.test.js test/resume-guard.test.js test/stop-session-ui-attach.test.js test/confirm-and-stop-session.test.js test/open-session-terminal.test.js && npx eslint public/`
Expected: PASS; if `test/confirm-and-stop-session.test.js` or `test/open-session-terminal.test.js` pins a line you changed, update that pin to the new text (they are source-level mirrors, not behavior changes).

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add public/shortcuts.js public/resume-guard.js public/stop-session-ui.js public/app.js test/agents-toggle-shortcut.test.js test/resume-guard.test.js test/stop-session-ui-attach.test.js
/usr/bin/git commit -m "(sessions): attach to a session the daemon runs instead of asking to resume it"
```

---

### Task 7: The Agents view (`public/agents-view.js`)

**Files:**
- Create: `public/agents-view.js`
- Modify: `public/index.html` (markup + script tag), `public/style.css`, `public/memory-workfiles-view.js` (`hideAllViewers`), `public/app.js` (toggle button, shortcut, init, restore, stats-tab branch), `public/terminal-manager.js` (shortcut inside xterm), `eslint.config.js`
- Create: `test/agents-view-pure.test.js`, `test/dom-agents-view.test.js`

**Interfaces:**
- Consumes: `window.api.getBgAgents/bgAgentVerb/onBgAgentsChanged/openExternal/stopSession` (Task 5), `renderSessionIcon` (session-state.js), `escapeHtml`, `shortProjectPath` (utils.js), `hideAllViewers`, `showSession`, `openSession`, `showJsonlViewer`, `refreshSidebar`, `fitAndScroll`, DOM handles from app.js.
- Produces (globals): `agentsViewActive` (writable), `bgAgentSessionIds` (Set of background session ids, read by sidebar.js in Task 8), `initAgentsView()`, `showAgentsView()`, `hideAgentsView({ restore })`, `toggleAgentsView()`, `applyAgentsSnapshot(snapshot)`, `renderAgentsView()`, `refreshAgentsRoster()`, `attachBgAgent(entry)`, `runAgentVerb(verb, entry)`, `selectAgentsRow(id)`; pure `sortAgentEntries`, `agentRowIcon`, `agentVerbAvailability`, `formatTokens`, `formatAgentAge`, `agentsEntryKey` (also `module.exports` for tests). `showDispatchAgentDialog` is called if defined (Task 9).

- [ ] **Step 1: Write the failing pure tests**

```js
// test/agents-view-pure.test.js — the decision helpers of the agents view. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sortAgentEntries, agentRowIcon, agentVerbAvailability, formatTokens, formatAgentAge, agentsEntryKey } = require('../public/agents-view');

const bg = (over) => ({ id: 'aaaaaaaa', sessionId: 's', kind: 'background', state: 'working', status: 'idle', startedAt: 100, ...over });

test('sort: working and external-interactive first, then newest first, unknown start last', () => {
  const sorted = sortAgentEntries([
    bg({ id: 'd1', state: 'done', startedAt: 500 }),
    bg({ id: 'w1', startedAt: 100 }),
    { kind: 'interactive', sessionId: 'i1', state: null, status: 'busy', startedAt: 300 },
    bg({ id: 'w2', startedAt: null }),
    bg({ id: 'w3', startedAt: 200 }),
  ]);
  assert.deepEqual(sorted.map(e => e.id || e.sessionId), ['i1', 'w3', 'w1', 'w2', 'd1']);
});

test('row icon: busy spinner, waiting, idle for live rows; stale for finished ones', () => {
  assert.equal(agentRowIcon(bg({ status: 'busy' })).slotClass, 'session-icon--busy');
  assert.equal(agentRowIcon(bg({ status: 'waiting' })).slotClass, 'session-icon--waiting');
  assert.equal(agentRowIcon(bg({ status: 'idle' })).slotClass, 'session-icon--idle');
  assert.equal(agentRowIcon(bg({ state: 'done', status: 'busy' })).slotClass, 'session-icon--stale');
  assert.equal(agentRowIcon({ kind: 'interactive', status: 'busy' }).slotClass, 'session-icon--busy');
});

test('verb availability follows the state, the kind and the daemon', () => {
  assert.deepEqual(agentVerbAvailability(bg(), true), { transcript: true, attach: true, stop: true, respawn: true, rm: false });
  assert.deepEqual(agentVerbAvailability(bg({ state: 'done' }), true), { transcript: true, attach: false, stop: false, respawn: true, rm: true });
  assert.deepEqual(agentVerbAvailability(bg(), false), { transcript: true, attach: false, stop: false, respawn: false, rm: false });
  assert.deepEqual(agentVerbAvailability({ kind: 'interactive', sessionId: 'i' }, true), { transcript: true, attach: false, stop: false, respawn: false, rm: false });
  assert.equal(agentVerbAvailability(bg({ sessionId: null, state: 'done' }), true).transcript, false);
});

test('formatting helpers', () => {
  assert.equal(formatTokens(null), '');
  assert.equal(formatTokens(274), '274');
  assert.equal(formatTokens(172999), '173k');
  assert.equal(formatTokens(2500000), '2.5M');
  const now = 1_000_000_000;
  assert.equal(formatAgentAge(null, now), '');
  assert.equal(formatAgentAge(now - 30_000, now), '30s');
  assert.equal(formatAgentAge(now - 12 * 60_000, now), '12 min');
  assert.equal(formatAgentAge(now - 3 * 3_600_000, now), '3 h');
  assert.equal(formatAgentAge(now - (2 * 24 + 6) * 3_600_000, now), '2d 6h');
  assert.equal(agentsEntryKey(bg()), 'bg:aaaaaaaa');
  assert.equal(agentsEntryKey({ kind: 'interactive', sessionId: 'x' }), 'int:x');
});
```

- [ ] **Step 2: Write the failing DOM test**

```js
// test/dom-agents-view.test.js — the agents view rendered in jsdom. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const HTML = `<!DOCTYPE html><html><body>
  <div id="placeholder"></div>
  <div id="terminal-area"><div id="terminal-header"></div><div id="grid-viewer"></div><div id="terminals"></div></div>
  <div id="stats-viewer"></div><div id="memory-viewer"></div><div id="work-files-viewer"></div><div id="settings-viewer"></div><div id="jsonl-viewer"></div>
  <div id="agents-viewer" style="display:none;">
    <div id="agents-viewer-header"><span id="agents-viewer-title">Agents</span><span id="agents-viewer-count"></span>
      <label id="agents-finished-toggle"><input type="checkbox" id="agents-show-finished" checked> Finished</label>
      <button id="agents-new-btn" type="button">New agent</button></div>
    <div id="agents-viewer-banner" style="display:none;"></div>
    <div id="agents-viewer-body"><div id="agents-list"></div><div id="agents-detail"></div></div>
  </div>
  <div id="sidebar-filters"><button id="resort-btn"></button></div>
</body></html>`;

function evalFile(dom, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext(), { filename: file });
}

function setup() {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = { verbs: [], opened: [], jsonl: [], external: [], stopped: [], shown: [], sidebarRefreshes: 0 };
  let changedCb = null;
  let snapshot = { roster: [], daemonReachable: true };
  window.api = {
    getBgAgents: async () => snapshot,
    bgAgentVerb: async (verb, id) => { calls.verbs.push([verb, id]); return { ok: verb !== 'rm', error: verb === 'rm' ? 'nope' : undefined }; },
    onBgAgentsChanged: (cb) => { changedCb = cb; },
    openExternal: async (href) => calls.external.push(href),
    stopSession: async (id) => { calls.stopped.push(id); return { ok: true }; },
  };
  const g = {
    placeholder: window.document.getElementById('placeholder'),
    terminalArea: window.document.getElementById('terminal-area'),
    terminalHeader: window.document.getElementById('terminal-header'),
    gridViewer: window.document.getElementById('grid-viewer'),
    statsViewer: window.document.getElementById('stats-viewer'),
    memoryViewer: window.document.getElementById('memory-viewer'),
    workFilesViewer: window.document.getElementById('work-files-viewer'),
    settingsViewer: window.document.getElementById('settings-viewer'),
    jsonlViewer: window.document.getElementById('jsonl-viewer'),
    resortBtn: window.document.getElementById('resort-btn'),
    openSessions: new Map(),
    sessionMap: new Map(),
    activeSessionId: null,
    gridViewActive: false,
    showSession: (id) => calls.shown.push(id),
    openSession: (session, opts) => calls.opened.push([session, opts]),
    showJsonlViewer: (session) => calls.jsonl.push(session),
    refreshSidebar: () => { calls.sidebarRefreshes++; },
    fitAndScroll: () => {},
    confirm: () => true,
  };
  for (const [k, v] of Object.entries(g)) Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'morphdom', 'dist', 'morphdom-umd.js'), 'utf8'), dom.getInternalVMContext());
  evalFile(dom, path.join(PUBLIC, 'utils.js'));
  evalFile(dom, path.join(PUBLIC, 'session-state.js'));
  evalFile(dom, path.join(PUBLIC, 'memory-workfiles-view.js'));
  evalFile(dom, path.join(PUBLIC, 'agents-view.js'));
  window.initAgentsView();
  const read = (expr) => vm.runInContext(expr, dom.getInternalVMContext());
  return {
    window, document: window.document, calls, read,
    setSnapshot(s) { snapshot = s; },
    emitChanged(s) { snapshot = s; changedCb(s); },
    destroy() { window.close(); },
  };
}

const ROSTER = [
  { id: 'aaaaaaaa', sessionId: 's-a', name: 'em-platform', cwd: '/w/em', kind: 'background', state: 'working', status: 'idle', pid: 10, startedAt: Date.now() - 60_000, agent: 'fleet:em', model: 'sonnet', detail: 'awaiting !196', tempo: 'idle', tokens: 173000, fan: [{ id: 'f', kind: 'agent', label: 'Spawn developer', startedAt: 1, doneAt: 27_000 }], children: [{ id: '195', href: 'https://gitlab.example/mr/195', kind: 'mr' }], result: 'no action', attachedHere: false },
  { id: 'bbbbbbbb', sessionId: 's-b', name: 'spike', cwd: '/w/f', kind: 'background', state: 'done', status: null, pid: null, startedAt: Date.now() - 3_600_000, agent: null, model: null, detail: null, tempo: null, tokens: 274, fan: [], children: [], result: null, attachedHere: false },
  { id: null, sessionId: 's-i', name: 'lvds-1b', cwd: '/w/l', kind: 'interactive', state: null, status: 'busy', pid: 30, startedAt: Date.now() - 10_000, agent: null, model: null, detail: null, tempo: null, tokens: null, fan: [], children: [], result: null, attachedHere: false },
];

test('showing the view hides the terminal area, lists the roster sorted, and counts running/finished', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  assert.equal(ctx.window.terminalArea.style.display, 'none');
  assert.equal(ctx.document.getElementById('agents-viewer').style.display, 'flex');
  assert.equal(ctx.read('agentsViewActive'), true);
  const names = [...ctx.document.querySelectorAll('.agents-row-name')].map(el => el.textContent);
  assert.deepEqual(names, ['lvds-1b', 'em-platform', 'spike']);
  assert.equal(ctx.document.getElementById('agents-viewer-count').textContent, '1 running · 1 finished');
  assert.equal(ctx.document.getElementById('agents-viewer-banner').style.display, 'none');
  assert.equal(ctx.window.localStorage.getItem('agentsViewActive'), '1');
});

test('the Finished filter hides done and stopped jobs and is remembered', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  const box = ctx.document.getElementById('agents-show-finished');
  box.checked = false;
  box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  assert.deepEqual([...ctx.document.querySelectorAll('.agents-row-name')].map(el => el.textContent), ['lvds-1b', 'em-platform']);
  assert.equal(ctx.window.localStorage.getItem('agentsShowFinished'), '0');
});

test('selecting a row renders its detail with the verbs disabled by state, and a roster update keeps the selection', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]').click();
  const detail = ctx.document.getElementById('agents-detail');
  assert.match(detail.textContent, /awaiting !196/);
  assert.match(detail.textContent, /173k tokens/);
  assert.match(detail.textContent, /Spawn developer/);
  assert.equal(detail.querySelector('[data-verb="rm"]').disabled, true);
  assert.equal(detail.querySelector('[data-verb="stop"]').disabled, false);
  assert.equal(detail.querySelector('[data-verb="attach"]').disabled, false);
  ctx.emitChanged({ roster: [{ ...ROSTER[0], detail: 'changed' }, ROSTER[1], ROSTER[2]], daemonReachable: true });
  assert.match(ctx.document.getElementById('agents-detail').textContent, /changed/);
  assert.ok(ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]').classList.contains('selected'));
});

test('the verbs: attach opens a tab keyed by the session id, transcript opens the viewer, stop calls the IPC, a failure shows in the detail', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]').click();
  const detail = ctx.document.getElementById('agents-detail');
  detail.querySelector('[data-verb="attach"]').click();
  assert.equal(ctx.calls.opened.length, 1);
  assert.equal(ctx.calls.opened[0][0].sessionId, 's-a');
  assert.deepEqual(ctx.calls.opened[0][1], { type: 'attach', jobId: 'aaaaaaaa', cwd: '/w/em' });
  detail.querySelector('[data-verb="transcript"]').click();
  assert.equal(ctx.calls.jsonl[0].sessionId, 's-a');
  await ctx.window.runAgentVerb('stop', ROSTER[0]);
  assert.deepEqual(ctx.calls.verbs, [['stop', 'aaaaaaaa']]);
  ctx.document.querySelector('.agents-row[data-key="bg:bbbbbbbb"]').click();
  await ctx.window.runAgentVerb('rm', ROSTER[1]);
  assert.match(ctx.document.getElementById('agents-detail').textContent, /nope/);
});

test('stop on a session attached here detaches the tab first', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  await ctx.window.showAgentsView();
  await ctx.window.runAgentVerb('stop', { ...ROSTER[0], attachedHere: true });
  assert.deepEqual(ctx.calls.stopped, ['s-a']);
  assert.deepEqual(ctx.calls.verbs, [['stop', 'aaaaaaaa']]);
});

test('an unreachable daemon shows the banner and disables every verb but Transcript; an empty roster shows the empty state', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: false });
  await ctx.window.showAgentsView();
  assert.notEqual(ctx.document.getElementById('agents-viewer-banner').style.display, 'none');
  ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]').click();
  const detail = ctx.document.getElementById('agents-detail');
  assert.equal(detail.querySelector('[data-verb="stop"]').disabled, true);
  assert.equal(detail.querySelector('[data-verb="transcript"]').disabled, false);
  ctx.emitChanged({ roster: [], daemonReachable: true });
  assert.match(ctx.document.getElementById('agents-list').textContent, /No background agents/);
});

test('hideAllViewers closes the view without restoring the terminal; hideAgentsView restores it', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.window.activeSessionId = 'open-1';
  ctx.window.openSessions.set('open-1', { closed: false });
  await ctx.window.showAgentsView();
  ctx.window.hideAllViewers();
  assert.equal(ctx.read('agentsViewActive'), false);
  assert.equal(ctx.document.getElementById('agents-viewer').style.display, 'none');
  assert.deepEqual(ctx.calls.shown, [], 'no restore from hideAllViewers');
  await ctx.window.showAgentsView();
  ctx.window.hideAgentsView();
  assert.deepEqual(ctx.calls.shown, ['open-1']);
  assert.equal(ctx.window.terminalArea.style.display, '');
});

test('a roster push updates bgAgentSessionIds and refreshes the sidebar only when the set changes', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.emitChanged({ roster: ROSTER, daemonReachable: true });
  assert.deepEqual([...ctx.read('bgAgentSessionIds')].sort(), ['s-a', 's-b']);
  assert.equal(ctx.calls.sidebarRefreshes, 1);
  ctx.emitChanged({ roster: ROSTER, daemonReachable: true });
  assert.equal(ctx.calls.sidebarRefreshes, 1);
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `node --test test/agents-view-pure.test.js test/dom-agents-view.test.js`
Expected: FAIL, `Cannot find module '../public/agents-view'` / eval error on the missing file.

- [ ] **Step 4: Write `public/agents-view.js`**

```js
// --- Agents view: the sessions the claude daemon runs in the background ---
// see .ai/contexts/bg-agents.md
// Depends on globals: escapeHtml, shortProjectPath (utils.js), renderSessionIcon
// (session-state.js), morphdom, hideAllViewers (memory-workfiles-view.js),
// showSession, openSession, showJsonlViewer, refreshSidebar, fitAndScroll,
// placeholder, terminalArea, terminalHeader, gridViewer, gridViewActive,
// activeSessionId, openSessions, sessionMap (app.js / grid-view.js / terminal-manager.js).
// showDispatchAgentDialog (dialogs.js) is optional.

const AGENTS_RECONCILE_MS = 30000;
const bgAgentSessionIds = new Set();
let agentsViewActive = false;
let agentsRoster = [];
let agentsDaemonReachable = true;
let agentsSelectedKey = null;
let agentsShowFinished = true;
let agentsReconcileTimer = null;
const agentsPendingVerbs = new Set();
const agentsVerbErrors = new Map();

// --- pure helpers ---

function agentsEntryKey(entry) {
  return entry.kind === 'background' ? 'bg:' + entry.id : 'int:' + entry.sessionId;
}

function agentIsLive(entry) {
  return entry.kind === 'interactive' || entry.state === 'working';
}

function sortAgentEntries(entries) {
  return entries.slice().sort((a, b) => {
    const rank = (e) => (agentIsLive(e) ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const sa = Number.isFinite(a.startedAt) ? a.startedAt : -Infinity;
    const sb = Number.isFinite(b.startedAt) ? b.startedAt : -Infinity;
    return sb - sa;
  });
}

function agentRowIcon(entry) {
  const live = agentIsLive(entry);
  const icon = renderSessionIcon({
    busy: live && entry.status === 'busy',
    waitingForInput: live && entry.status === 'waiting',
    stale: !live,
  });
  return { slotClass: icon.slotClasses[0], title: icon.title };
}

function agentVerbAvailability(entry, daemonReachable) {
  const bg = entry.kind === 'background';
  const working = bg && entry.state === 'working';
  return {
    transcript: !!entry.sessionId,
    attach: working && !!daemonReachable,
    stop: working && !!daemonReachable,
    respawn: bg && !!daemonReachable,
    rm: bg && !working && !!daemonReachable,
  };
}

function formatTokens(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

function formatAgentAge(startedAt, now = Date.now()) {
  if (!Number.isFinite(startedAt)) return '';
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

// --- state ---

function agentsSelectedEntry() {
  return agentsRoster.find(e => agentsEntryKey(e) === agentsSelectedKey) || null;
}

function applyAgentsSnapshot(snapshot) {
  agentsRoster = Array.isArray(snapshot && snapshot.roster) ? snapshot.roster : [];
  agentsDaemonReachable = !snapshot || snapshot.daemonReachable !== false;
  const next = new Set(agentsRoster.filter(e => e.kind === 'background' && e.sessionId).map(e => e.sessionId));
  let changed = next.size !== bgAgentSessionIds.size;
  if (!changed) for (const id of next) if (!bgAgentSessionIds.has(id)) { changed = true; break; }
  if (changed) {
    bgAgentSessionIds.clear();
    for (const id of next) bgAgentSessionIds.add(id);
    if (typeof refreshSidebar === 'function') refreshSidebar();
  }
  if (agentsViewActive) renderAgentsView();
}

async function refreshAgentsRoster() {
  try {
    applyAgentsSnapshot(await window.api.getBgAgents());
  } catch (err) {
    console.warn('[agents-view] roster refresh failed', err);
  }
}

function selectAgentsRow(id) {
  agentsSelectedKey = 'bg:' + id;
  if (agentsViewActive) renderAgentsView();
}

// --- render ---

function renderAgentRow(entry) {
  const key = agentsEntryKey(entry);
  const icon = agentRowIcon(entry);
  const state = entry.kind === 'interactive' ? 'external' : (entry.state || '?');
  const status = entry.status ? ' · ' + entry.status : '';
  const classes = ['agents-row'];
  if (key === agentsSelectedKey) classes.push('selected');
  if (agentsPendingVerbs.has(key)) classes.push('pending');
  return `<div class="${classes.join(' ')}" data-key="${escapeHtml(key)}">
    <span class="session-icon ${icon.slotClass}" title="${escapeHtml(icon.title)}"></span>
    <span class="agents-row-name">${escapeHtml(entry.name || entry.sessionId || entry.id || '')}</span>
    <span class="agents-row-agent">${escapeHtml(entry.agent || '—')}</span>
    <span class="agents-row-state">${escapeHtml(state + status)}</span>
    <span class="agents-row-cwd" title="${escapeHtml(entry.cwd || '')}">${escapeHtml(entry.cwd ? shortProjectPath(entry.cwd) : '')}</span>
    <span class="agents-row-age">${escapeHtml(formatAgentAge(entry.startedAt))}</span>
  </div>`;
}

function renderAgentDetail(entry) {
  const key = agentsEntryKey(entry);
  const v = agentVerbAvailability(entry, agentsDaemonReachable);
  const pending = agentsPendingVerbs.has(key);
  const btn = (verb, label, enabled) =>
    `<button type="button" class="agents-verb-btn" data-verb="${verb}"${enabled && !pending ? '' : ' disabled'}>${label}</button>`;
  const meta = [];
  if (Number.isFinite(entry.tokens)) meta.push(formatTokens(entry.tokens) + ' tokens');
  if (entry.model) meta.push(entry.model);
  if (Number.isFinite(entry.startedAt)) meta.push('started ' + new Date(entry.startedAt).toLocaleString());
  if (entry.pid) meta.push('pid ' + entry.pid);
  const fan = (entry.fan || []).map((f) => {
    const dur = Number.isFinite(f.startedAt) && Number.isFinite(f.doneAt) ? formatAgentAge(f.startedAt, f.doneAt) : '';
    const tail = f.doneAt ? (dur ? ` (${dur}, done)` : ' (done)') : ' (running)';
    return `<li>${escapeHtml(f.label || f.id || '')}${escapeHtml(tail)}</li>`;
  }).join('');
  const children = (entry.children || []).filter(c => c.href)
    .map(c => `<a href="#" class="agents-link" data-href="${escapeHtml(c.href)}">${escapeHtml(c.id || c.href)}</a>`)
    .join(' · ');
  const error = agentsVerbErrors.get(key);
  return `
    <div class="agents-detail-head">
      <span class="agents-detail-name">${escapeHtml(entry.name || entry.sessionId || '')}</span>
      <span class="agents-detail-actions">
        ${btn('attach', 'Attach', v.attach)}${btn('transcript', 'Transcript', v.transcript)}${btn('stop', 'Stop', v.stop)}${btn('respawn', 'Respawn', v.respawn)}${btn('rm', 'Delete', v.rm)}
      </span>
    </div>
    ${entry.detail ? `<div class="agents-detail-line">${escapeHtml(entry.detail)}</div>` : ''}
    ${meta.length ? `<div class="agents-detail-meta">${escapeHtml(meta.join(' · '))}</div>` : ''}
    ${entry.kind === 'interactive' ? `<div class="agents-detail-meta">${escapeHtml(entry.cwd || '')}${entry.status ? ' · ' + escapeHtml(entry.status) : ''}</div>` : ''}
    ${fan ? `<div class="agents-detail-section">Subagents<ul>${fan}</ul></div>` : ''}
    ${children ? `<div class="agents-detail-section">Produced: ${children}</div>` : ''}
    ${entry.result ? `<div class="agents-detail-section">Last result: ${escapeHtml(entry.result)}</div>` : ''}
    ${error ? `<div class="agents-detail-error">${escapeHtml(error)}</div>` : ''}
  `;
}

function renderAgentsView() {
  const listEl = document.getElementById('agents-list');
  const detailEl = document.getElementById('agents-detail');
  const countEl = document.getElementById('agents-viewer-count');
  const bannerEl = document.getElementById('agents-viewer-banner');
  if (!listEl || !detailEl) return;
  const visible = sortAgentEntries(agentsRoster.filter(e => agentsShowFinished || agentIsLive(e)));
  const running = agentsRoster.filter(e => e.kind === 'background' && e.state === 'working').length;
  const finished = agentsRoster.filter(e => e.kind === 'background' && e.state !== 'working').length;
  if (countEl) countEl.textContent = `${running} running · ${finished} finished`;
  if (bannerEl) {
    bannerEl.textContent = 'The daemon is not answering; state comes from files only.';
    bannerEl.style.display = agentsDaemonReachable ? 'none' : '';
  }
  if (agentsSelectedKey && !visible.some(e => agentsEntryKey(e) === agentsSelectedKey)) agentsSelectedKey = null;

  const nextList = document.createElement('div');
  nextList.id = 'agents-list';
  nextList.innerHTML = visible.length
    ? visible.map(renderAgentRow).join('')
    : '<div class="plans-empty">No background agents. <code>claude --bg</code> starts one, or New agent.</div>';
  morphdom(listEl, nextList);

  const selected = agentsSelectedEntry();
  const nextDetail = document.createElement('div');
  nextDetail.id = 'agents-detail';
  nextDetail.innerHTML = selected ? renderAgentDetail(selected) : '<div class="agents-detail-empty">Select an agent</div>';
  morphdom(detailEl, nextDetail);
}

// --- verbs ---

function attachBgAgent(entry) {
  if (!entry || entry.kind !== 'background' || !entry.sessionId) return;
  let session = sessionMap.get(entry.sessionId);
  if (!session) {
    session = { sessionId: entry.sessionId, projectPath: entry.cwd, name: entry.name, summary: entry.name || entry.id, firstPrompt: '' };
    sessionMap.set(entry.sessionId, session);
  }
  openSession(session, { type: 'attach', jobId: entry.id, cwd: entry.cwd });
}

async function runAgentVerb(verb, entry) {
  if (!entry) return;
  const key = agentsEntryKey(entry);
  if (verb === 'transcript') {
    showJsonlViewer(sessionMap.get(entry.sessionId) || { sessionId: entry.sessionId, name: entry.name, projectPath: entry.cwd });
    return;
  }
  if (verb === 'attach') {
    attachBgAgent(entry);
    return;
  }
  if (verb === 'rm' && !window.confirm('Delete this background session? Its conversation goes, and its worktree when that is safe.')) return;
  if (entry.attachedHere && (verb === 'stop' || verb === 'rm')) {
    try { await window.api.stopSession(entry.sessionId); } catch {}
  }
  agentsPendingVerbs.add(key);
  agentsVerbErrors.delete(key);
  if (agentsViewActive) renderAgentsView();
  let result;
  try {
    result = await window.api.bgAgentVerb(verb, entry.id);
  } catch (err) {
    result = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  agentsPendingVerbs.delete(key);
  if (!result || result.ok === false) agentsVerbErrors.set(key, (result && result.error) || 'unknown error');
  await refreshAgentsRoster();
}

// --- show / hide ---

function setAgentsToggleActive(on) {
  const btn = document.getElementById('agents-toggle-btn');
  if (btn) btn.classList.toggle('active', on);
}

async function showAgentsView() {
  hideAllViewers();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  terminalHeader.style.display = 'none';
  const el = document.getElementById('agents-viewer');
  if (el) el.style.display = 'flex';
  agentsViewActive = true;
  localStorage.setItem('agentsViewActive', '1');
  setAgentsToggleActive(true);
  renderAgentsView();
  await refreshAgentsRoster();
  if (!agentsReconcileTimer) {
    agentsReconcileTimer = setInterval(() => { if (agentsViewActive) refreshAgentsRoster(); }, AGENTS_RECONCILE_MS);
  }
}

function hideAgentsView({ restore = true } = {}) {
  const el = document.getElementById('agents-viewer');
  if (el) el.style.display = 'none';
  const wasActive = agentsViewActive;
  agentsViewActive = false;
  localStorage.setItem('agentsViewActive', '0');
  if (agentsReconcileTimer) { clearInterval(agentsReconcileTimer); agentsReconcileTimer = null; }
  setAgentsToggleActive(false);
  if (!wasActive || !restore) return;
  terminalArea.style.display = '';
  if (gridViewActive) {
    placeholder.style.display = 'none';
    terminalHeader.style.display = 'none';
    gridViewer.style.display = 'block';
    for (const entry of openSessions.values()) if (!entry.closed) fitAndScroll(entry);
  } else if (activeSessionId && openSessions.has(activeSessionId)) {
    showSession(activeSessionId);
  } else {
    placeholder.style.display = '';
  }
}

function toggleAgentsView() {
  if (agentsViewActive) hideAgentsView();
  else showAgentsView();
}

function initAgentsView() {
  agentsShowFinished = localStorage.getItem('agentsShowFinished') !== '0';
  const box = document.getElementById('agents-show-finished');
  if (box) {
    box.checked = agentsShowFinished;
    box.addEventListener('change', () => {
      agentsShowFinished = box.checked;
      localStorage.setItem('agentsShowFinished', agentsShowFinished ? '1' : '0');
      renderAgentsView();
    });
  }
  const newBtn = document.getElementById('agents-new-btn');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      if (typeof showDispatchAgentDialog !== 'function') return;
      const active = activeSessionId ? sessionMap.get(activeSessionId) : null;
      showDispatchAgentDialog(active && active.projectPath ? { projectPath: active.projectPath } : null);
    });
  }
  const viewer = document.getElementById('agents-viewer');
  if (viewer) {
    viewer.addEventListener('click', (e) => {
      const link = e.target.closest('.agents-link');
      if (link) {
        e.preventDefault();
        window.api.openExternal(link.dataset.href);
        return;
      }
      const verbBtn = e.target.closest('.agents-verb-btn');
      if (verbBtn) {
        if (!verbBtn.disabled) runAgentVerb(verbBtn.dataset.verb, agentsSelectedEntry());
        return;
      }
      const row = e.target.closest('.agents-row');
      if (row) {
        agentsSelectedKey = row.dataset.key;
        renderAgentsView();
      }
    });
  }
  window.api.onBgAgentsChanged((snapshot) => applyAgentsSnapshot(snapshot));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sortAgentEntries, agentRowIcon, agentVerbAvailability, formatTokens, formatAgentAge, agentsEntryKey };
}
```

- [ ] **Step 5: Markup, styles, wiring**

`public/index.html`: after the `#jsonl-viewer` `</div>` (before `<div id="terminal-area">`) add:

```html
    <div id="agents-viewer" style="display:none;">
      <div id="agents-viewer-header">
        <span id="agents-viewer-title">Agents</span>
        <span id="agents-viewer-count"></span>
        <label id="agents-finished-toggle"><input type="checkbox" id="agents-show-finished" checked> Finished</label>
        <button id="agents-new-btn" type="button">New agent</button>
      </div>
      <div id="agents-viewer-banner" style="display:none;"></div>
      <div id="agents-viewer-body">
        <div id="agents-list"></div>
        <div id="agents-detail"></div>
      </div>
    </div>
```

and the script tag after `memory-workfiles-view.js`:

```html
  <!-- agents-view.js: the background agents view; needs hideAllViewers (memory-workfiles-view.js) and dialogs.js before it. -->
  <script src="agents-view.js"></script>
```

`public/memory-workfiles-view.js`, in `hideAllViewers()` after `jsonlViewer.style.display = 'none';`:

```js
  if (typeof hideAgentsView === 'function') hideAgentsView({ restore: false });
```

`public/app.js`:

- after `initGridGroupToggle();` (line 1303): `initAgentsView();`
- in the sidebar-filters block (line 1375), after `resortBtn.parentElement.insertBefore(gridToggleBtn, resortBtn);`:

```js
  const agentsToggleBtn = document.createElement('button');
  agentsToggleBtn.id = 'agents-toggle-btn';
  agentsToggleBtn.title = 'Background agents';
  agentsToggleBtn.innerHTML = '<svg width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"></path></svg>';
  agentsToggleBtn.addEventListener('click', toggleAgentsView);
  resortBtn.parentElement.insertBefore(agentsToggleBtn, resortBtn);
```

- in the same block's keydown listener, before the grid branch:

```js
    if (matchShortcut('agentsToggle', e, isMac, appShortcuts)) {
      e.preventDefault();
      toggleAgentsView();
      return;
    }
```

- in the startup `loadProjects().then(async () => {` (line 1438), after the grid restore:

```js
  if (localStorage.getItem('agentsViewActive') === '1') showAgentsView();
```

- in the tab-switch `stats` branch (line 1276), before `statsViewer.style.display = 'flex';`:

```js
      if (typeof hideAgentsView === 'function') hideAgentsView({ restore: false });
```

`public/terminal-manager.js`, before the `gridToggle` branch at line 95:

```js
    if (matchShortcut('agentsToggle', e, isMac, appShortcuts)) {
      if (e.type === 'keydown') { e._handled = true; toggleAgentsView(); }
      return false;
    }
```

`public/style.css`, after the `#grid-viewer-count` rule:

```css
/* Agents view — see .ai/contexts/bg-agents.md */
#agents-viewer { display: none; flex-direction: column; flex: 1; min-height: 0; }
#agents-viewer-header {
  display: flex; align-items: center; gap: 10px; padding: 8px 16px;
  background: var(--surface-chrome); border-bottom: 1px solid var(--hairline); flex-shrink: 0;
}
#agents-viewer-title { font-size: 13px; color: #b0b0c4; font-weight: 500; }
#agents-viewer-count { font-size: 11px; color: #7a7a90; margin-right: auto; }
#agents-finished-toggle { font-size: 11px; color: #7a7a90; display: inline-flex; align-items: center; gap: 4px; }
#agents-new-btn, .agents-verb-btn {
  background: transparent; border: 1px solid var(--control-border); color: #b0b0c4;
  font-size: 11px; padding: 3px 8px; border-radius: 6px; cursor: pointer; font-family: inherit;
}
#agents-new-btn:hover, .agents-verb-btn:hover:not([disabled]) { background: var(--control-surface); }
.agents-verb-btn[disabled] { opacity: 0.4; cursor: default; }
#agents-viewer-banner { padding: 6px 16px; font-size: 11px; color: #f0a050; background: rgba(240,160,80,0.08); }
#agents-viewer-body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
#agents-list { flex: 1; overflow: auto; min-height: 0; }
.agents-row {
  display: grid; grid-template-columns: 18px minmax(160px, 2fr) minmax(90px, 1fr) minmax(110px, 1fr) minmax(160px, 2fr) 60px;
  gap: 8px; align-items: center; padding: 6px 16px; font-size: 12px; color: #c8c8d8; cursor: pointer;
  border-bottom: 1px solid var(--hairline);
}
.agents-row:hover { background: var(--control-surface); }
.agents-row.selected { background: rgba(128,136,255,0.1); }
.agents-row.pending { opacity: 0.5; }
.agents-row-name, .agents-row-cwd { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agents-row-agent, .agents-row-state, .agents-row-age { color: #7a7a90; }
#agents-detail { border-top: 1px solid var(--hairline); padding: 10px 16px; max-height: 40%; overflow: auto; font-size: 12px; color: #c8c8d8; flex-shrink: 0; }
.agents-detail-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.agents-detail-name { font-weight: 500; margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agents-detail-actions { display: flex; gap: 6px; flex-shrink: 0; }
.agents-detail-line { margin: 4px 0; }
.agents-detail-meta, .agents-detail-empty { color: #7a7a90; margin: 4px 0; }
.agents-detail-section { margin-top: 8px; }
.agents-detail-section ul { margin: 4px 0 0 16px; padding: 0; }
.agents-detail-error { margin-top: 8px; color: #f06060; }
.agents-link { color: var(--accent); }
```

and add `#agents-toggle-btn` to the three selectors that name `#grid-toggle-btn` (base, `:hover`, `.active`), plus `#agents-toggle-btn { margin-left: 2px; }` after `#grid-toggle-btn { margin-left: auto; }`.

`eslint.config.js`, in `rendererCrossFileGlobals` after `liveElsewhereMany: 'readonly',`:

```js
  // Agents view (public/agents-view.js) — see .ai/contexts/bg-agents.md
  agentsViewActive: 'writable',
  bgAgentSessionIds: 'readonly',
  initAgentsView: 'readonly',
  showAgentsView: 'readonly',
  hideAgentsView: 'readonly',
  toggleAgentsView: 'readonly',
  applyAgentsSnapshot: 'readonly',
  refreshAgentsRoster: 'readonly',
  attachBgAgent: 'readonly',
  runAgentVerb: 'readonly',
  selectAgentsRow: 'readonly',
  showDispatchAgentDialog: 'readonly',
```

If `npx eslint public/` still reports `no-undef` for a name agents-view.js reads (for instance `fitAndScroll` or `gridViewActive`), add that name as `'readonly'` in the same list; do not disable the rule.

- [ ] **Step 6: Run the tests and the lint**

Run: `node --test test/agents-view-pure.test.js test/dom-agents-view.test.js && npx eslint public/ eslint.config.js`
Expected: PASS, 4 + 8 tests; 0 errors.

- [ ] **Step 7: Commit**

```bash
/usr/bin/git add public/agents-view.js public/index.html public/style.css public/memory-workfiles-view.js public/app.js public/terminal-manager.js eslint.config.js test/agents-view-pure.test.js test/dom-agents-view.test.js
/usr/bin/git commit -m "(agents): a view of the daemon's background sessions, with attach, transcript, stop, respawn and delete"
```

---

### Task 8: The sidebar's "bg" badge

**Files:**
- Modify: `public/sidebar.js` (in `buildSessionItem`, after the remote badge), `public/style.css`
- Create: `test/dom-sidebar-bg-badge.test.js`

**Interfaces:**
- Consumes: `bgAgentSessionIds` (Task 7).

- [ ] **Step 1: Write the failing test**

```js
// test/dom-sidebar-bg-badge.test.js — a session the daemon runs carries a "bg" badge once the roster is known.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

test('a row whose session id is in bgAgentSessionIds shows the bg badge; the others do not', (t) => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  Object.defineProperty(ctx.window, 'bgAgentSessionIds', { value: new Set(['s-top-1']), writable: true, configurable: true });
  const project = makeSampleProject();
  ctx.sidebar.renderProjects([project], false);
  const badged = ctx.document.querySelector('[data-session-id="s-top-1"] .bg-badge');
  assert.ok(badged, 'the badge is there');
  assert.equal(badged.textContent, 'bg');
  assert.equal(ctx.document.querySelector('[data-session-id="s-top-2"] .bg-badge'), null);
});

test('without the roster global the sidebar renders as before', (t) => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.sidebar.renderProjects([makeSampleProject()], false);
  assert.equal(ctx.document.querySelector('.bg-badge'), null);
});
```

`renderProjects(projects, resort)` is the signature in `public/sidebar.js:576`; `test/dom-sidebar-icon-slot.test.js` calls it the same way.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/dom-sidebar-bg-badge.test.js`
Expected: the first test FAILS on "the badge is there".

- [ ] **Step 3: Implement**

`public/sidebar.js`, in `buildSessionItem` right after the `if (session.remoteAlias) { … }` badge block:

```js
  // see .ai/contexts/bg-agents.md ("The sidebar")
  if (typeof bgAgentSessionIds !== 'undefined' && bgAgentSessionIds.has(session.sessionId)) {
    const badge = document.createElement('span');
    badge.className = 'bg-badge';
    badge.title = 'Background session run by the claude daemon — click to attach';
    badge.textContent = 'bg';
    summaryEl.prepend(badge);
  }
```

`public/style.css`, after `.remote-badge { … }`:

```css
.bg-badge {
  display: inline-block; margin-right: 5px; padding: 0 5px;
  border: 1px solid #5a4a7a; border-radius: 3px; color: #b39ddb;
  font-size: 10px; line-height: 15px; vertical-align: middle;
}
```

- [ ] **Step 4: Run the sidebar tests**

Run: `node --test test/dom-sidebar-bg-badge.test.js test/dom-sidebar-icon-slot.test.js && npx eslint public/sidebar.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add public/sidebar.js public/style.css test/dom-sidebar-bg-badge.test.js
/usr/bin/git commit -m "(sidebar): badge the sessions the daemon runs in the background"
```

---

### Task 9: The dispatch dialog

**Files:**
- Modify: `public/dialogs.js` (append `showDispatchAgentDialog`)
- Create: `test/dom-dispatch-dialog.test.js`

**Interfaces:**
- Consumes: `window.api.dispatchBgAgent(fields)` (Task 5), `selectAgentsRow(id)` (Task 7), `cachedAllProjects`, `PERMISSION_MODES`, `SETTING_DEFAULTS`, `escapeHtml`, `shortProjectPath`.
- Produces: `showDispatchAgentDialog(project | null)`.

- [ ] **Step 1: Write the failing test**

```js
// test/dom-dispatch-dialog.test.js — the fields become exactly the dispatch payload. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const tick = () => new Promise(r => setTimeout(r, 0));

function setup({ dispatchResult = { ok: true, id: 'cccccccc' } } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = { dispatched: [], selected: [] };
  window.api = {
    platform: 'linux',
    getEffectiveSettings: async () => ({ permissionMode: 'auto', addDirs: '' }),
    dispatchBgAgent: async (fields) => { calls.dispatched.push(fields); return dispatchResult; },
  };
  const g = {
    cachedAllProjects: [{ projectPath: '/w/one' }, { projectPath: '/w/two' }],
    selectAgentsRow: (id) => calls.selected.push(id),
    launchNewSession: () => {}, cachedProjects: [], sessionMap: new Map(), pendingSessions: new Map(),
    openSessions: new Map(), activePtyIds: new Set(), refreshSidebar: () => {}, pollActiveSessions: () => {},
  };
  for (const [k, v] of Object.entries(g)) Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  for (const f of ['setting-defaults.js', 'utils.js', 'icons.js', 'dialogs.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), dom.getInternalVMContext(), { filename: f });
  }
  return { window, document: window.document, calls, destroy: () => window.close() };
}

test('Start sends the trimmed fields with the chosen project and mode, then selects the new row', async (t) => {
  const ctx = setup(); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog({ projectPath: '/w/two' });
  const d = ctx.document;
  assert.equal(d.querySelector('#dad-project').value, '/w/two', 'the given project is preselected');
  d.querySelector('#dad-prompt').value = '  review the backlog  ';
  d.querySelector('#dad-name').value = 'em-1';
  d.querySelector('#dad-agent').value = 'fleet:em';
  d.querySelector('#dad-add-dirs').value = '/srv/a';
  d.querySelector('.permission-option[data-mode="plan"]').click();
  d.querySelector('.new-session-start-btn').click();
  await tick(); await tick();
  assert.deepEqual(ctx.calls.dispatched, [{ prompt: 'review the backlog', name: 'em-1', agent: 'fleet:em', cwd: '/w/two', permissionMode: 'plan', dangerouslySkipPermissions: false, addDirs: '/srv/a' }]);
  assert.deepEqual(ctx.calls.selected, ['cccccccc']);
  assert.equal(d.querySelector('.new-session-overlay'), null, 'the dialog closed');
});

test('an empty prompt never reaches main, and a failed dispatch keeps the dialog open with the error', async (t) => {
  const ctx = setup({ dispatchResult: { ok: false, error: 'daemon said no' } }); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const d = ctx.document;
  d.querySelector('.new-session-start-btn').click();
  await tick();
  assert.equal(ctx.calls.dispatched.length, 0);
  assert.match(d.querySelector('#dad-error').textContent, /prompt/);
  d.querySelector('#dad-prompt').value = 'go';
  d.querySelector('.new-session-start-btn').click();
  await tick(); await tick();
  assert.equal(ctx.calls.dispatched.length, 1);
  assert.equal(ctx.calls.dispatched[0].cwd, '/w/one', 'first project by default');
  assert.match(d.querySelector('#dad-error').textContent, /daemon said no/);
  assert.ok(d.querySelector('.new-session-overlay'), 'still open');
});

test('Enter inside the prompt does not start; Escape closes', async (t) => {
  const ctx = setup(); t.after(ctx.destroy);
  await ctx.window.showDispatchAgentDialog(null);
  const d = ctx.document;
  const prompt = d.querySelector('#dad-prompt');
  prompt.value = 'x';
  prompt.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  assert.equal(ctx.calls.dispatched.length, 0);
  d.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(d.querySelector('.new-session-overlay'), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/dom-dispatch-dialog.test.js`
Expected: FAIL, `showDispatchAgentDialog is not a function`.

- [ ] **Step 3: Implement**

Append to `public/dialogs.js`:

```js
// --- Dispatch a background agent — see .ai/contexts/bg-agents.md ("Dispatch") ---
async function showDispatchAgentDialog(project) {
  const projects = (typeof cachedAllProjects !== 'undefined' ? cachedAllProjects : [])
    .map(p => p && p.projectPath).filter(Boolean);
  const requested = project && project.projectPath;
  if (requested && !projects.includes(requested)) projects.unshift(requested);
  const defaultPath = requested || projects[0] || '';
  let effective = {};
  if (defaultPath) {
    try { effective = await window.api.getEffectiveSettings(defaultPath); } catch { effective = {}; }
  }

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  let selectedMode = effective.permissionMode || null;
  let dangerousSkip = !!effective.dangerouslySkipPermissions;

  function renderModeGrid() {
    return PERMISSION_MODES.map(m => {
      const isSelected = !dangerousSkip && selectedMode === m.value;
      return `<button class="permission-option${isSelected ? ' selected' : ''}" data-mode="${m.value}"><span class="perm-name">${m.label}</span><span class="perm-desc">${m.desc}</span></button>`;
    }).join('') +
    `<button class="permission-option dangerous${dangerousSkip ? ' selected' : ''}" data-mode="dangerous-skip"><span class="perm-name">Dangerous Skip</span><span class="perm-desc">Skip all safety prompts (use with caution)</span></button>`;
  }

  dialog.innerHTML = `
    <h3>New background agent</h3>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Prompt</span>
        <div class="settings-description">The task the agent runs, in the background, under the claude daemon</div>
      </div>
      <div class="settings-field-control">
        <textarea class="settings-input" id="dad-prompt" rows="4"></textarea>
      </div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Project</span>
        <div class="settings-description">Working directory of the agent</div>
      </div>
      <div class="settings-field-control">
        <select class="settings-input" id="dad-project">${projects.map(p => `<option value="${escapeHtml(p)}"${p === defaultPath ? ' selected' : ''}>${escapeHtml(shortProjectPath(p))}</option>`).join('')}</select>
      </div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Name</span>
        <div class="settings-description">--name; empty lets the CLI pick one</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="dad-name" placeholder="optional">
      </div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Agent</span>
        <div class="settings-description">--agent, e.g. fleet:em; empty for none</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="dad-agent" placeholder="optional">
      </div>
    </div>
    <div class="settings-field">
      <div class="settings-label">Permission Mode</div>
      <div class="permission-grid" id="dad-mode-grid">${renderModeGrid()}</div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Additional Directories</span>
        <div class="settings-description">Extra directories to include (comma-separated)</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="dad-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(effective.addDirs || SETTING_DEFAULTS.addDirs || '')}">
      </div>
    </div>
    <div id="dad-error" class="agents-detail-error"></div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Start</button>
    </div>
  `;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const modeGrid = dialog.querySelector('#dad-mode-grid');
  modeGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.permission-option');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === 'dangerous-skip') {
      dangerousSkip = !dangerousSkip;
      if (dangerousSkip) selectedMode = null;
    } else {
      dangerousSkip = false;
      selectedMode = mode === 'null' ? null : mode;
    }
    modeGrid.innerHTML = renderModeGrid();
  });

  const errorEl = dialog.querySelector('#dad-error');
  const startBtn = dialog.querySelector('.new-session-start-btn');

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  async function start() {
    const prompt = dialog.querySelector('#dad-prompt').value.trim();
    if (!prompt) { errorEl.textContent = 'A prompt is required.'; return; }
    const fields = {
      prompt,
      name: dialog.querySelector('#dad-name').value.trim(),
      agent: dialog.querySelector('#dad-agent').value.trim(),
      cwd: dialog.querySelector('#dad-project').value,
      permissionMode: dangerousSkip ? null : selectedMode,
      dangerouslySkipPermissions: dangerousSkip,
      addDirs: dialog.querySelector('#dad-add-dirs').value.trim(),
    };
    errorEl.textContent = '';
    startBtn.disabled = true;
    let result;
    try { result = await window.api.dispatchBgAgent(fields); } catch (err) { result = { ok: false, error: err.message }; }
    startBtn.disabled = false;
    if (!result || result.ok === false) {
      errorEl.textContent = (result && result.error) || 'unknown error';
      return;
    }
    close();
    if (result.id && typeof selectAgentsRow === 'function') selectAgentsRow(result.id);
  }

  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  startBtn.onclick = start;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !e.target.matches('input, textarea, select')) start();
  }
  document.addEventListener('keydown', onKey);
  dialog.querySelector('#dad-prompt').focus();
}
```

- [ ] **Step 4: Run the test and the lint**

Run: `node --test test/dom-dispatch-dialog.test.js && npx eslint public/dialogs.js`
Expected: PASS, 3 tests, 0 lint errors: `cachedAllProjects` is already declared in `eslint.config.js` (line 89), and `selectAgentsRow` / `showDispatchAgentDialog` were added there in Task 7.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add public/dialogs.js test/dom-dispatch-dialog.test.js
/usr/bin/git commit -m "(agents): dispatch a new background agent from a dialog"
```

---

### Task 10: Documentation and context engineering

**Files:**
- Create: `docs/background-agents.md`, `.ai/contexts/bg-agents.md`
- Modify: `README.md` (feature table), `docs/README.md`, `docs/keyboard-shortcuts.md`, `docs/settings.md` (if it lists `localStorage` keys; otherwise skip), `.ai/contexts/ipc-bridge.md`, `.ai/contexts/README.md`, `.ai/contexts/cli-session-state.md`, `.ai/shared-guidelines.md`

- [ ] **Step 1: Write `docs/background-agents.md`**

```markdown
# Background agents

The Agents view is Switchboard's replacement for the `claude agents` TUI: it
lists the sessions the Claude CLI daemon runs in the background
(`claude --bg`) and the interactive `claude` sessions running outside this
Switchboard, and acts on them without a terminal.

## Opening it

The people icon in the sidebar's filter row, or `Ctrl+Shift+A` (`Cmd+Shift+A`
on macOS; [rebindable](keyboard-shortcuts.md)). The same toggle closes it and
brings back whatever was there: the grid, the active session, or the
placeholder. Whether the view is open is remembered across restarts.

## The list

One row per session: a state glyph (the same rungs as the sidebar: spinner
while busy, orange while waiting, green when idle, grey when finished), its
name, its `--agent`, `state · status`, its directory, and its age. Working
sessions and external interactive sessions come first, newest first.
**Finished** shows or hides `done` and `stopped` sessions; the choice is
remembered.

Selecting a row opens its detail: the daemon's one-line status, tokens,
model, start time, pid, the subagents it ran, the links it produced (merge
requests open in the browser), its last result, and the verbs:

| Verb | Runs | Available |
|---|---|---|
| Attach | `claude attach <id>` in a terminal tab | while the session is `working` |
| Transcript | the read-only transcript viewer | whenever the transcript exists |
| Stop | `claude stop <id>`; the conversation is kept | while `working` |
| Respawn | `claude respawn <id>` | any background session |
| Delete | `claude rm <id>`, after confirmation; the worktree goes too when that is safe | when not `working` |

An external interactive session offers Transcript only.

## Attaching

An attach tab is an ordinary terminal tab running `claude attach`. Its stop
button reads **Detach**: closing the tab sends Ctrl+Z, the attach client
leaves, and the session keeps running under the daemon. Stopping the session
is only offered in the Agents view. Attach tabs are not reopened by
[session restore](session-restore.md).

A click in the sidebar on a session the daemon is running attaches to it
instead of asking to resume it; the row carries a `bg` badge once the Agents
view has been opened. A finished background session resumes like any other.

## New agent

**New agent** opens a dialog: prompt, project, name (`--name`), agent
(`--agent`), permission mode or Dangerous Skip, additional directories. It
runs `claude --bg …` in the project directory and selects the new row.

## When the daemon does not answer

The view reads two files the CLI writes for itself, `~/.claude/jobs/<id>/state.json`
and `~/.claude/sessions/<pid>.json`, and asks `claude agents --json --all`
which sessions exist. When that command fails, a banner says so, the list
comes from the files alone, and every verb but Transcript is disabled.
Neither file is a documented interface; a CLI upgrade may change them, and
`test/canary-bg-agents-files.test.js` says so when it happens.
```

- [ ] **Step 2: Write `.ai/contexts/bg-agents.md`**

```markdown
# Context: bg-agents

**Purpose**: The Agents view — a graphical replacement for the `claude agents`
TUI. Lists the daemon's `--bg` sessions and the external interactive ones,
attaches/stops/respawns/deletes/dispatches through the CLI. Design:
`docs/superpowers/specs/2026-09-30-background-agents-view-design.md`.

## Key files

| File | Role |
|---|---|
| `bg-agents-roster.js` | Pure: `parseJobState`, `parseCliList`, `mergeRoster`, `dispatchArgs`, `parseDispatchOutput` |
| `bg-agents.js` | Watchers over `~/.claude/jobs/*/state.json`, descriptor subscription, `reconcile()` through `claude agents --json --all`, `runVerb`, `dispatch`, `onChange` |
| `bg-agents-ipc.js` | `get-bg-agents`, `bg-agent-verb`, `dispatch-bg-agent`, the `bg-agents-changed` push |
| `cli-session-state.js` | `onDescriptorsChanged`, `readAllDescriptors`, `kind`/`jobId` on live-elsewhere |
| `pty-ops.js` | `detachPty` |
| `main.js` | `runClaudeCommand`; the `type: 'attach'` branch of `open-terminal`; detach in `stop-session` |
| `public/agents-view.js` | The view; `bgAgentSessionIds` for the sidebar badge |
| `public/resume-guard.js` | A live `kind: 'bg'` descriptor answers `{ attach }` |
| `public/dialogs.js` | `showDispatchAgentDialog` |

## Invariants

1. Never `--resume` or `--fork-session` a session whose job is `working`.
   `claude attach` is the only path to a live job (`guardResume` turns a
   `bg` verdict into attach options; `open-terminal` builds `claude attach`).
2. Every call to the CLI goes through the login shell with an argv quoted by
   `quoteArgvForShell` (`runClaudeCommand`, the scheduler's path). Never a
   command string built by hand. The daemon's control socket and
   `control.key` are never touched.
3. Closing an attach tab detaches (`\x1a`, 2 s grace, then kill —
   `detachPty`). `claude stop` is the only stop. App quit kills the attach
   client outright; the CLI documents that the session survives either way.
4. No steady-state cost before the view is first opened: `bgAgents.start()`
   runs on the first `get-bg-agents`. Closing the view keeps the watchers so
   the sidebar badge stays current; the window's `closed` handler releases
   them.
5. `jobs/` and the `kind: "bg"` descriptor are undocumented. Failure is
   silence: an unreadable `state.json` keeps the previous value; a CLI that
   fails leaves a file-only roster with `daemonReachable: false`. Canaries:
   `test/canary-bg-agents-files.test.js`, `test/canary-cli-session-state.test.js`.
6. A verb's id is validated against `JOB_ID_RE` before any spawn; a prompt
   starting with `-` is refused by `dispatchArgs`.

## Data flow

`jobs/<id>/state.json` (fs.watch, per directory) and `sessions/<pid>.json`
(through `cli-session-state`'s flush) both call `scheduleRebuild()`,
coalesced at `FLUSH_MS` (250 ms). `rebuild()` = `mergeRoster(cli, jobs,
readAllDescriptors())`. The CLI list is the authority for which jobs exist
and their `state`; the file supplies `detail`, `tokens`, `fan`, `children`,
`result`, `--agent`/`--model`/`--name`; the descriptor supplies `status`,
`pid`, `agent`. `reconcile()` runs on every `get-bg-agents` (the renderer
calls it on open and every 30 s while visible) and after every verb.

## Non-obvious behaviors

- The view is a sibling of `#jsonl-viewer`, shown by hiding
  `#terminal-area` (as the Stats tab does), so the grid's state survives.
  `hideAllViewers()` calls `hideAgentsView({ restore: false })`; only the
  toggle restores the terminal area.
- `claude --bg` prints its id in a format nobody measured (2026-09-30);
  `parseDispatchOutput` takes the first eight-hex token and `dispatch`
  reports `ok: true, id: null` otherwise — the row arrives through the files.
- An attach tab's `cli-session-state` status comes from the daemon worker's
  descriptor (same `sessionId`), so busy/idle needs no special path.
- Attach tabs are excluded from the working set (`entry.attach`).

## Measured facts (CLI 2.1.285, Linux, 2026-09-30)

- `claude agents --json --all`: ~0.15 s CPU; array of `{id, sessionId, name,
  cwd, kind, startedAt, pid?, state?, status?}`.
- `claude attach <id>` in a pty: Ctrl+Z detaches, client exits 0, session
  stays `working`.
- `claude logs <id>` prints screen ANSI, unusable without xterm — not used.

## If you change this, also check

- `.ai/contexts/ipc-bridge.md` (the three handlers, the event)
- `.ai/contexts/cli-session-state.md` (the descriptor hooks)
- `docs/background-agents.md`, `docs/keyboard-shortcuts.md`
```

- [ ] **Step 3: Rows in the shared docs**

`README.md`, feature table, after the Subagents row:

```
| The sessions the claude daemon runs in the background: list, attach, stop, dispatch | [Background agents](docs/background-agents.md) |
```

`docs/README.md`, after the Subagents row:

```
| [Background agents](background-agents.md) | The Agents view: the daemon's `--bg` sessions, attach in a tab, stop, respawn, delete, dispatch |
```

`docs/keyboard-shortcuts.md`, in the rebindable table after the grid row:

```
| Toggle agents view | Primary+Shift+`A` | Show or hide the [background agents](background-agents.md) view |
```

and change "how to rebind the three that can be" in `docs/README.md` to "the four".

`docs/settings.md` does not list `localStorage` keys (checked 2026-09-30: no `gridViewActive` in it), so it is not touched; the two keys are named in `docs/background-agents.md` ("remembered").

`.ai/contexts/ipc-bridge.md`: a new subsection before "Misc":

```
### Background agents (see `.ai/contexts/bg-agents.md`)

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `get-bg-agents` | — | `{roster, daemonReachable}` | Arms the watchers on first call, then reconciles through `claude agents --json --all`. Handler in `bg-agents-ipc.js`. |
| `bg-agent-verb` | `(verb, id)` | `{ok, error?}` | `stop` \| `respawn` \| `rm`; id validated against `JOB_ID_RE`. |
| `dispatch-bg-agent` | `(fields)` | `{ok, id?, error?}` | `claude --bg …` in `fields.cwd`. |

`open-terminal` accepts `sessionOptions = {type: 'attach', jobId, cwd}` and runs `claude attach <jobId>`; `stop-session` on such a session detaches (`{ok, detached: true}`).
```

and add `bg-agents-changed` to the events list. Add `bg-agents-ipc.js` to the "Key files" table with the same warning as `schedule-ipc.js`.

`.ai/contexts/README.md`, in the "When to read which" table:

```
| The Agents view, the daemon's job files, attach/detach, dispatch | [bg-agents](bg-agents.md) |
```

`.ai/contexts/cli-session-state.md`: a short section "Descriptor hooks for the agents view": `onDescriptorsChanged` fires once per flushed batch; `readAllDescriptors` returns the live descriptors' subset; `liveElsewhere` results carry `kind`/`jobId`; pointer to `bg-agents.md`.

`.ai/shared-guidelines.md`: an orientation row ("Change the Agents view, the daemon's job files, attach/detach, dispatch | [contexts/bg-agents.md]") and a fork-feature bullet ("**Background agents view** — the daemon's `--bg` sessions listed, attached, stopped, dispatched; see [contexts/bg-agents.md]").

- [ ] **Step 4: Lint the markdown links by reading them once**

Run: `ls docs/background-agents.md .ai/contexts/bg-agents.md && grep -n "background-agents\|bg-agents" README.md docs/README.md docs/keyboard-shortcuts.md .ai/contexts/README.md .ai/contexts/ipc-bridge.md .ai/shared-guidelines.md`
Expected: each file lists at least one hit.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add README.md docs/ .ai/
/usr/bin/git commit -m "(docs): document the background agents view and its context"
```

---

### Task 11: Comment sweep, full check, live check, PR

**Files:** every file touched above.

- [ ] **Step 1: Comment sweep**

Run: `/usr/bin/git diff main --stat && /usr/bin/git diff main -- '*.js' | grep -n "^+.*//" | grep -v "see .ai/contexts" `
Expected: only one-line pointers remain. Move any rationale that survived into `.ai/contexts/bg-agents.md` and delete it from the code.

- [ ] **Step 2: Full check**

Run: `task check`
Expected: 0 errors (pre-existing warnings are fine), every test passing including the canaries (or skipping where the files are absent).

- [ ] **Step 3: Live check against the isolated instance**

Follow `docs/testing-a-pr.md` with this branch. In the test instance:

1. In a shell, `cd` to any project and run `claude --bg --name plan-check "say hello and wait"`. Note the printed id and its exact output format; if `parseDispatchOutput` would not have found it, fix the regex in `bg-agents-roster.js` and its test, and record the format in `.ai/contexts/bg-agents.md`.
2. `Ctrl+Shift+A`: the row shows `working`, its detail line, and the sidebar row of that session carries `bg`.
3. Attach: a tab opens on the session; the header button reads Detach; close it; the Agents view still says `working`.
4. Click the same session in the sidebar: it attaches without a "Resume anyway?" dialog.
5. Stop from the view: the state goes `stopped`; Delete asks and removes it.
6. New agent with a prompt and the same project: a new row appears and is selected.
7. Quit the daemon-less path: `mv ~/.claude/daemon.lock ~/.claude/daemon.lock.bak`, reopen the view: the banner shows and the list still lists the jobs; restore the file.

Record anything that differs from the plan in `.ai/contexts/bg-agents.md` before the PR.

- [ ] **Step 4: Squash to clear commits and open the PR**

Keep one commit per task if they read well, or squash into: roster + watchers (main), attach/detach (main + renderer), the view, the dialog, docs. Then:

```bash
/usr/bin/git push -u origin worktree-background-agents-view
gh pr create --repo devsuitup/switchboard --base main --title "(agents): a view of the sessions the claude daemon runs in the background" --body-file - <<'EOF'
A graphical replacement for the `claude agents` TUI.

- Lists the daemon's `--bg` sessions and the interactive sessions running outside this Switchboard, from `~/.claude/jobs/*/state.json` and the session descriptors, reconciled by `claude agents --json --all`.
- Attach opens `claude attach <id>` in a terminal tab keyed by the session's real id; closing it detaches (Ctrl+Z), never kills.
- Stop, respawn, delete and dispatch go through the CLI with a quoted argv.
- A click in the sidebar on a session the daemon runs attaches instead of asking to resume.

Design: docs/superpowers/specs/2026-09-30-background-agents-view-design.md
Context: .ai/contexts/bg-agents.md
EOF
```

The review loop and the reviewer request (`gh api -X POST repos/devsuitup/switchboard/pulls/<n>/requested_reviewers -f 'reviewers[]=devsuitup'`) follow `.ai/shared-guidelines.md` "When you finish work", step 6, once the review converges.
