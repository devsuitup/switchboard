# Context: subagent-observability

**Purpose**: Surface Claude's subagent runs (child tasks spawned via the `Agent` tool) in the Switchboard sidebar with parent→child grouping, live status badges, and a read-only transcript viewer. Avoid the original mistake of treating subagents as resumable sessions — they're ephemeral and re-resuming corrupts their context.

This is the **#1 fork-specific feature** (upstream PR #47 still pending). It pervades many files rather than living in a single module.

## Key files (by layer)

### Indexing (main → DB)

| File | Role |
|---|---|
| `session-cache.js` | `enumerateSessionFiles(folderPath)` walks `<folder>/*.jsonl` AND `<folder>/<parentSessionId>/subagents/*.jsonl` (+ legacy `<folder>/<parentSessionId>/*.jsonl`). Sets `subagentType` from JSONL metadata. |
| `db.js` | `session_cache` row has `parentSessionId`, `agentId`, `subagentType` columns. `getCachedByParent(parentSessionId)` returns all children. |
| `read-session-file.js` | `readSessionDisplayHeader()` extracts `agentId` + `isSidechain` flags from the first 256 KB. |

### IPC bridge (main ↔ renderer)

| IPC | What it does |
|---|---|
| `read-subagent-jsonl(parentSessionId, agentId)` | Returns parsed JSONL entries for the transcript view |
| `list-subagents(parentSessionId)` | Returns all subagent rows for a parent (used by the sidebar nesting) |
| `start-subagent-watch(parentSessionId, agentId)` | Begin tailing the subagent's JSONL; emits `subagent-watch-event` per change |
| `stop-subagent-watch(watchId)` | Tear down the watch |
| Events (main → renderer): `subagent-spawned`, `subagent-completed`, `subagent-watch-event` | Live status changes |

### UI

| File | Role |
|---|---|
| `public/sidebar.js` | Renders the "Orphan subagents" collapsible group; nests subagents under their parent in worktree/session groups; click handler routes subagent items to the transcript view. |
| `public/jsonl-viewer.js` | `showSubagentTranscript(session)` — read-only render of the subagent's JSONL with `mergeLocalCommandEntries` + `renderJsonlEntry` + a "Resume in terminal anyway" escape banner. |

## Public surface (for code that wants to integrate)

- From renderer code: `window.api.readSubagentJsonl`, `window.api.listSubagents`, `window.api.startSubagentWatch`, `window.api.stopSubagentWatch`, listeners `window.api.onSubagentSpawned/Completed/WatchEvent`
- From renderer JS: `showSubagentTranscript(session)` (cross-file global, declared in `eslint.config.js` rendererCrossFileGlobals)
- From sidebar UI: subagent rows carry `dataset.subagent = true` and `dataset.parentId = parentSessionId` for downstream wiring

## Invariants

- **A subagent click MUST NOT spawn `claude --resume`.** The opener routing in `sidebar.js` checks `item.dataset.subagent && session.parentSessionId` and dispatches to `showSubagentTranscript` instead of `openSession`. **If you add a new sidebar opener path, replicate this discriminator.**
- **`subagentType` is the canonical "is-subagent" signal**: non-null/non-empty string. The agent type itself (e.g. `'frontend-implementer'`, `'researcher'`) is human-meaningful but the *presence* of the value is what matters for routing.
- **Subagent JSONLs are at `<folder>/<parentSessionId>/subagents/<agentId>.jsonl`**, NOT at `<folder>/<agentId>.jsonl`. There's also a legacy layout `<folder>/<parentSessionId>/<agentId>.jsonl`. **Always use `enumerateSessionFiles()` to walk both layouts.**
- **Watchers are scoped per `(parentSessionId, agentId)`**: don't share a watcher across subagents — `start-subagent-watch` returns a `watchId` that's unique per call.
- **Watch cleanup is mandatory** when the transcript view is closed. `drainViewerWatches()` (in `jsonl-viewer.js`) walks `activeViewerWatches` and calls `stopSubagentWatch` for each. Forgetting this leaks `fs.watch` handles.

## Non-obvious behaviors

- **The parent JSONL doesn't contain the subagent's text** — it just records a `subagent-spawn` event. The actual conversation lives in the child JSONL. The viewer pieces them together via `mergeLocalCommandEntries`.
- **Orphan subagents** (no findable parent in cache) are surfaced in a dedicated `.orphan-subagents` group in the sidebar, **collapsed by default**. State is persisted per-project in `localStorage['orphanExpanded:' + projectPath]`.
- **Subagent status badges**: derived from the most recent JSONL line — `isSidechain: true` means active, completion is inferred from mtime stability (see PR #48 observability follow-up).
- **The "Resume in terminal anyway" button** in the transcript view bypasses the routing and calls the original `openSession` opener. This is intentional — for the rare debugging case where a user genuinely wants to re-enter the subagent's session.

## Live "running" indicator in the sidebar (PR #130, fixes #129)

- **Why `activePtyIds` can't work for subagents**: a subagent runs inside its
  parent's process and never owns a PTY, so `activePtyIds.has(sessionId)` is
  structurally always false for it. The real liveness signal is the
  `subagent-spawned` / `subagent-completed` IPC pair emitted by
  `session-transitions.js:detectSubagentTransitions()` (also consumed by
  `grid-view.js` and `jsonl-viewer.js`).
- **State**: `activeSubagentsByParent` in `public/sidebar.js` —
  `parentSessionId → Map<agentId, spawnedAt(ms)>` of spawned-but-not-completed
  subagents. `buildSubagentItem()` / `appendSubagentChildren()` re-derive
  `.running` from this Map on every render, so the state survives a full
  sidebar rebuild; the IPC handlers only fast-path the visual toggle between
  rebuilds (`reflectSubagentRunningState`).
- **Why a TTL** (`SUBAGENT_LIVE_TTL_MS` = 60s, mirroring grid-view's):
  `detectSubagentTransitions()` only polls subagents of `!exited` sessions —
  if the parent's PTY dies before a subagent goes 30s quiet, the matching
  `subagent-completed` never fires and the entry would be stuck forever.
  `pruneStaleSubagents()` runs at the top of every `renderProjects()` — a
  render-time prune, not a standalone timer (ADR 0002: no added steady-state
  cost).
- **Collapsed parents**: a running child's own dot is hidden inside the
  collapsed `childrenContainer`, so `appendSubagentChildren` also toggles
  `has-running-child` on the caret row (`.caret-running-dot` in style.css) to
  surface liveness at the caret level.
- **The `updateRunningIndicators` guard** (`public/app.js`): the periodic PTY
  poll must skip `dataset.subagent` items, or it would clear the `.running`
  state within one cycle of the IPC setting it.
- **`subagentDomId()`** mirrors `subagentSessionId()` in
  `read-session-file.js` — that file is main-process and not `require()`-able
  from the renderer (sidebar.js loads as a plain script), hence the local copy.

## Subagent children inside a slug group (issue #128 ask 4, rehab-plan.md A3)

- **The bug**: `buildSlugGroup()` used to append its sessions via the raw
  `buildSessionItem(session)`, never through `appendSubagentChildren()` — only
  the ungrouped/top-level render path (`buildSessionsList`) called that
  helper. Any session rendered inside a slug group (i.e. any second-or-later
  rerun of a schedule sharing a slug — the only real producer, see
  `schedule-runner.js:createScheduleSession()`) silently lost its subagent
  caret/children.
- **The fix**: `appendSubagentChildren()` was hoisted from a closure inside
  `renderProjects()` to module scope (it never captured any of that
  function's locals) so `buildSlugGroup(slug, sessions, subagentIndex)` can
  call it directly for each session it renders, exactly like
  `buildSessionsList` does for ungrouped sessions.
- **The knock-on bug this caused**: a slug-group `<div>` carries no
  `dataset.sessionId` of its own, so the "orphan subagents" pass in
  `buildSessionsList` — which built `allTopLevelIds` from
  `item.element.dataset.sessionId` — never counted the sessions grouped
  inside it as accounted-for. Their subagents were treated as parentless and
  duplicated into the project's "Orphan subagents" bucket even after the fix
  above attached them correctly inside the group. `collectTopLevelSessionIds(el)`
  fixes this by walking into `el` for nested `[data-session-id]` session-items
  (excluding subagent ones) when `el` itself isn't a session item.
- **Coverage**: `test/dom-slug-group-subagent-nesting.test.js` seeds two
  schedule-rerun-shaped sessions sharing a slug plus a subagent parented to
  one of them, and pins both the caret-attachment fix and the
  no-duplicate-orphan fix (failed on both before the fix, confirmed by
  reverting it locally during development).
- **A second knock-on bug (PR #134 review F1)**: nesting the subagent's
  caret/children as DOM siblings inside the group means every DOM query
  scoped to `.slug-group` that matches on `.session-item` alone now also
  matches the nested subagent item (`buildSubagentItem` includes
  `session-item` in its className for shared styling). The "Archive all
  sessions in group" handler (`rebindSidebarEvents`, `.slug-group-archive-btn`)
  had exactly this query and, unguarded, called `archiveSession`/`stopSession`
  on the subagent's id. Fixed with the same `:not([data-subagent])` guard
  already used elsewhere in this file (e.g. the per-item click wiring). Any
  *new* query scoped to a slug-group's subtree must apply this guard too —
  it's not automatic.

## If you change this, also check

- `eslint.config.js` `rendererCrossFileGlobals` — must list any new renderer-global functions (e.g. `showSubagentTranscript`, `drainViewerWatches`) or lint fails on `no-undef`
- `test/dom-subagent-transcript.test.js` — 4 tests covering the routing branch + transcript render
- `test/dom-sidebar.test.js` — covers orphan group rendering
- `public/sidebar.js:771` (the routing branch) — the one-line decision that makes the whole feature work
- IPC handler security: `read-subagent-jsonl` MUST validate that `agentId` and `parentSessionId` are filename-safe (see `resolveJsonlPath` calls in main.js — fixed in PR #8 hardening)

## History

- Upstream PR #47: original subagent indexing + search (still open upstream, merged on fork)
- Upstream PR #48: live transitions, status badges
- Fork PR #9: subagent click → transcript view (replaces resume-in-terminal default)
- Fork PR #8: security hardening on subagent IPCs + watch drain on viewer close
