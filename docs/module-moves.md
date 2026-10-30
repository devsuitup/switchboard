# Moving main-process modules

Follow [ADR 0005](decisions/0005-main-process-context-layout.md) and check open work before moving a context.
The preparatory source map is deliberately empty. For a viewer pilot, set `scripts/source-map.json` to:

```json
{
  "file-lists-path.js": "src/main/viewer/file-lists-path.js"
}
```

Create the destination directory and make a pure `git mv` commit first. Keep that commit's full SHA
for `.git-blame-ignore-revs`, then run:

```sh
node scripts/move-modules.js --check
node scripts/move-modules.js
node scripts/move-modules.js --check
```

The first check reports each pending reference and exits 1 until the references are rewritten.
Check mode never writes. Apply mode updates references only; it never moves files or runs git.
It plans all edits before writing and rejects invalid maps, renames and ambiguous VM stub mappings.
Apply exits 2 without writing anything while any source in the map still awaits `git mv`.
Check may run before the moves and lists those pending moves with exit 1.
All ambiguous stub keys across all scanned files are reported before exit 2; no edits are applied.
Keep the map for the move until verification finishes; a second apply must produce no changes.
Use `--root <repository>` to exercise a disposable copy without modifying the working checkout.

The scanner reads `.js`, `.cjs` and `.mjs` sources at root and in workers, src, scripts, public, test (including fixtures), e2e,
and Markdown/JSON context documents under .ai and docs. It updates literal relative requires
(including `require.resolve`),
static `path.join(__dirname, ...)` and `path.join(ROOT, ...)` expressions, literal file paths and
VM stub keys/comparisons inferred from the source files the test loads. Only stub literals
actually present in the test participate in ambiguity checks. Loaded source requires are resolved
from their current location once rewritten, so repeated apply/check runs preserve the stubs.
Shared stub keys must agree across loaded sources, including sources that keep their original location.
Sources read only for `indexOf`/`slice`/`extract*` excerpts produce a `WARNING` and do not
contribute their whole module's requires to stub ambiguity checks. The excerpt and its stubs
still need manual review. A full source evaluation keeps participating even when the same text
is also sliced. Unknown source uses remain conservative; separate VM contexts can still require
manual ambiguity resolution.
Non-first path segments in `path.join` are never rewritten as standalone module filenames.
Qualified documentation paths
change; bare filenames remain valid. It does not evaluate code or computed path expressions.
Review dynamic paths manually, especially interpolated worker paths and source strings inside tests.
Source-text assertions such as `"} = require('./db');"` are not parsed as executable requires and
remain unchanged; string literals containing quoted relative paths to moved modules produce a
`WARNING` with the file, line and reference. Review and update them manually after a move. Helper loaders such as
`loadShipped(filename)` with `path.join(__dirname, '..', filename)` do not associate a loaded source
with its VM stubs. If no static loaded application source is detected and a stub-shaped literal matches a moved
module or one of its relative dependencies, both apply and check print an explicit `WARNING` listing
the file and key. These warnings require manual review and do not change the exit status; a clean
check proves only that no supported rewrites or moves remain. This heuristic cannot identify every
computed loader or stub and may also flag ordinary comparisons.
A final `--check` exit 0 is not evidence that the moved test suite is green: run the full suite.
The layout guard rejects non-literal requires unless explicitly allowed with a reason and checks
every static `path.join(__dirname, <string literals>)` target on disk. Optional dependency paths
are listed with reasons in `test/module-layout.test.js`.

Review `.ai/project.json` scopes manually: bare paths such as `db.js`, `session-cache.js` and the
glob `schedule-*.js` are not qualified documentation references and are not rewritten by this
codemod. Replace or remove stale scope entries after moves; `src/main/**/*.js` already covers the
destination contexts. This manual check is part of each move PR's configuration review.

The scanner does not read `.d.ts` files: check `import('./x')` type references in root `*.d.ts`
files (such as `session-index-writer.d.ts`) and coverage or diff-cover exclude lists by hand.

Shrink `test/fixtures/root-app-modules.json` manually after a move. Root inventory equality rejects
both new root modules and stale allow-list entries. Run the resolver and affected tests, lint, the
full suite and CI checks prescribed by the ADR. No installation or native rebuild is needed to run
the codemod. Never copy writable node_modules into a disposable test checkout.
