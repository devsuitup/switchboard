# 0005 — Move main-process modules into flat contexts

Status: Accepted by JB, 2026-10-28. Preparation: #832; lint prerequisite: #833.

## Context

The Electron main process has over one hundred root modules. Its boundaries already exist in the code,
but packaging, worker entry points, lazy requires and VM test stubs assume the root layout.
Issue #816 corrects documentation before the codemod rewrites qualified references; #833 enables lint
for `src/main/**`. Those prerequisites precede the context moves.

## Decision

Keep CommonJS and relative requires; do not introduce package.json `imports` aliases.
Use `src/main/<context>/` with domain and application code together. Add `adapters/` where existing
external-system seams justify it and `workers/` for worker entry points. Keep every module filename.
The composition root eventually becomes `src/main/main.js` and preload becomes `src/preload/preload.js`.
Keep `public/` in place and tests flat under `test/` for this migration.

Each move PR changes paths only. Commit 1 is pure `git mv`; commit 2 updates references and path
configuration, shrinks `test/fixtures/root-app-modules.json`, and records the full pure-move commit SHA
in `.git-blame-ignore-revs`. Merge with a merge commit, preserving the pure-move commit; do not squash.
Use `git config blame.ignoreRevsFile .git-blame-ignore-revs` locally when desired.
Move a context only when no open issue or PR touches it. Recheck that condition before starting;
authors rerun the codemod after rebasing. Codex port #820 must land at upstream paths before moving
sessions or harness modules. This preparatory PR moves no modules and leaves the source map empty.

Migration order from the 2026-10-28 architecture audit:

1. Guardrails and codemod (0a, #832); main-process lint coverage (0b, #833).
2. Pilot `viewer/`.
3. `app/` and `integrations/`.
4. `shared/`.
5. `remote/`.
6. `changes/`.
7. `terminals/`.
8. `schedules/` and `triggers/`.
9. `bg-agents/`.
10. Land #820, then `harnesses/`, `harnesses/claude/` and the harness contract.
11. `session-state/`.
12. `sessions/`.
13. Move `main.js` and preload and update the package entry point.
14. Optional later decisions: renderer relocation and mirrored test directories.

## Tooling and verification

See [the codemod guide](../module-moves.md). Packaging includes `src/**/*`; coverage exclusions match
entry-point basenames and nested worker directories. Static require resolution covers lazy calls and
main-required public modules, including literal `require.resolve` calls. Static
`path.join(__dirname, <string literals>)` targets must exist, including worker entries, preload,
HTML and shell scripts; optional dependency paths have reasoned exceptions in the layout test.
Non-literal require calls fail unless explicitly allowed with a reason.
The root module allow-list shrinks with each context move.

Every move requires lint, the full test suite, the CI matrix, diff coverage, the leftover check and e2e
in the appropriate CI environment. JB verifies a packaged build when worker paths, build.files or the
package entry point change. #832's local verification follows its stricter brief: Node-only tests,
no Electron, Playwright, e2e or packaged builds.

The leftover check is `node scripts/move-modules.js --check` with the move's source map still
present. It reports every pending literal reference rewrite and any source file awaiting its
move, exits 1 if either remains, and never writes files. Exit 0 means the scanner has no pending
edits or moves; computed paths, bare documentation names and manual configuration scopes still
need the review described in the guide.

## Consequences

The migration makes ownership and dependency paths easier to see without changing runtime behavior.
Relative paths become longer across contexts, so the codemod and resolver guard are necessary.
Existing dependency cycles remain; refactoring them belongs to a later behavior change.
VM stubs need the same specifier changes as their loaded source; ambiguous stub rewrites fail for
manual review. Filename-only documentation mentions stay valid and remain unchanged.
