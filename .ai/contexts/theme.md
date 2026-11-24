# App appearance (#1176)

`public/style.css` owns the color tokens: the default `:root` keeps the existing
dark values, and `:root[data-theme="light"]` swaps them. The light chrome, controls,
text and accents reuse the Settings design's palette. Distinct old shades keep
distinct tokens so Dark does not change. White on solid action buttons, black
shadows/backdrops, brand artwork and fixed search highlights retain their colors.
The Stats heatmap uses CSS classes, not a canvas; its cells and legend therefore
change through the same tokens. Sidebar subagent colors, transcript tool bullets
and toolbar success flashes use CSS variables in their inline styles.

`THEME_CHOICES` in `public/setting-defaults.js` supplies both normalization and
the Appearance select (`#sv-theme`). Native select controls use a theme-specific
color scheme (`--control-color-scheme`, applied by `.control-select`).

The global `theme` setting defaults to `SETTING_DEFAULTS.theme` (`dark`), with
`light` and `system` as the other choices. Settings → General → Appearance saves
it with the other global preferences. The existing Terminal Theme setting remains
the selected dark terminal palette. While Light is active, all terminals use the
matching light palette; returning to Dark restores the selected dark palette.

`public/setting-defaults.js` and `public/theme.js` are blocking head scripts before
stylesheets and body content. Preload's `getInitialTheme()` synchronously requests
the persisted global choice through `get-initial-theme`. This reads only the
already-loaded settings cache. There is no localStorage mirror to drift on reload.
The renderer sets `data-theme` before content is parsed. System watches
`matchMedia('(prefers-color-scheme: dark)')` live; explicit choices ignore changes.
Settings applies the saved choice through `window.appTheme.apply`.

`public/theme.js` is dual-mode: under `require()` it exports `normalize`,
`resolve` and `colors` (the native background, caption and symbol colors per
palette); in the renderer it installs `window.appTheme`.

`src/main/app/window-theme.js` (`installWindowTheme`, wired in `main.js`) owns
the native window colors, uses the same normalizer and color resolver, and observes Electron's `nativeTheme.updated`.
The initial BrowserWindow options include its background and the themed caption
overlay before construction. Dark now explicitly sets native `backgroundColor`
to `#111118` before first paint (accepted startup difference); saved global
changes refresh existing window colors (`windowTheme.refresh()` in the
`writeGlobalSettings`, shared by the `set-setting` handler for the global key and
`merge-global-settings`).
macOS retains its native traffic lights. The new synchronous IPC carries only the
normalized theme name and runs without filesystem IO in the handler.

The renderer emits `app-theme-changed` only when the effective palette changes.
`terminal-themes.js` (`bindTerminalThemes(() => openSessions)`, which installs
`window._applyTerminalTheme`) updates xterm options and container backgrounds
for every entry in `openSessions`, including hidden terminals and panel shells;
under Light, `getTerminalTheme()` returns `LIGHT_TERMINAL_THEME` whatever the
selected dark palette. The normal
terminal creation path reads that same effective palette. CodeMirror's theme
compartment selects the existing Dracula extension or GitHub Light. A view plugin
reconfigures each live editor on the event and removes its listener on destroy;
documents, selections, undo history and merge state are not replaced. The existing
Markdown diagram observer already follows the root's `data-theme`.

`test/theme.test.js` drives the renderer in jsdom and the native controller with
plain Node dependencies, and verifies head/preload/main wiring by reading sources.
`test/fixtures/theme-dark.json` records the pre-change root values and hashes of
all resolved CSS declarations and three inline-color modules at be60eb4a. The
comparison resolves both `var(--token)` and `var(--token, fallback)` against
the dark root tokens, including the baseline fallbacks. Its hash was regenerated
from be60eb4a when fallback resolution was added. `test/css-vars.js` shares this
resolution with the jsdom color assertions. Schedule field errors retain their
old `#e06060` dark value through `--state-error`. The set-setting source harness
asserts native refresh occurs after global persistence and not for project saves.
The comparison removes whitespace and normalizes equivalent decimal alpha spellings
(`0.10`/`0.1`); it preserves selectors, declaration order and all other values.
This is a static resolved-color guarantee, not a browser rendering measurement.
Settings and real CodeMirror integration tests exercise Save and live changes.
Native painting, startup flash, all-screen contrast and real xterm rendering need
manual verification.
