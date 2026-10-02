# Hidden-terminal buffer — trimming cost

A session that is neither the active single-view terminal nor part of an open
grid hands nothing to xterm: its PTY output accumulates in
`hiddenAccumulators` (`public/terminal-manager.js`) and replays in one
`write()` on reveal. The accumulator is capped at `HIDDEN_BUFFER_MAX_LEN`
(2 MB of UTF-16 code units).

## Why the trim goes below the cap

Trimming exactly to the cap left the buffer full, so every following chunk
overflowed it again and re-ran the whole trim: four `lastIndexOf` over the
buffer, the boundary search, and a ~2 MB `slice`. The Claude TUI redraws with
cursor moves, not with the `SAFE_REDRAW_MARKERS`, so the marker path rarely
shortened the buffer and the fallback ran on every chunk.

Measured (2026-10-02, 6 live Claude sessions): the renderer averaged ~34 % of
a core and its RSS climbed to 2.47 GB before a major GC brought it back to
~390 MB — garbage, not retained memory. A micro-benchmark of 1 400-char chunks
into a full hidden buffer: 12.2 ms per chunk before, 0.037 ms after.

On overflow the buffer is now trimmed to `HIDDEN_BUFFER_TRIM_TO` (1.5 MB), so
the next trim only happens after another ~0.5 MB of output. The replay on
reveal holds between 1.5 and 2 MB instead of exactly 2 MB.

A marker that arrives in a chunk *after* a trim is no longer cut to
immediately; it is cut to at the next overflow. The replay is visually the
same — the marker redraws the screen — only longer.

## Why the boundary search starts at the last ESC

`advanceToAnsiSafeBoundary` used to walk the buffer from index 0 to find
whether the cut point falls inside an escape sequence: ~2 M steps per trim.
It now examines only the last ESC before the cut point. That ESC either opens
the sequence the cut may fall inside, or is the ST (`ESC \`) closing a
string-type sequence, which `findEscapeSequenceEnd` reads as a 2-byte escape.

The only divergence from the forward walk is a stray ESC (not followed by
`\`) inside an OSC/DCS/APC/PM payload, which is malformed output. The test
`advanceToAnsiSafeBoundary: matches a full forward scan on well-formed output`
in `test/terminal-hidden-suspend.test.js` pins the equivalence for everything
else.
