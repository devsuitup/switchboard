// terminal-path-links.js — filesystem paths in terminal output, matched and
// linked — see .ai/contexts/terminal-path-links.md

'use strict';

const TPL_SEGMENT = '[A-Za-z0-9._\\-+@%~$#=]+';
// see .ai/contexts/terminal-path-links.md ("What becomes a candidate")
const TPL_BARE_SOURCE =
  `(?<![A-Za-z0-9._\\-+@%~$#=:/\\\\])(?:[A-Za-z]:)?(?:${TPL_SEGMENT}(?:[/\\\\]${TPL_SEGMENT})*|(?:[/\\\\]${TPL_SEGMENT})+)(?::\\d+(?::\\d+)?)?`;
const TPL_QUOTED_RE = /`([^`\n]{1,1024})`|"([^"\n]{1,1024})"|'([^'\n]{1,1024})'/g;
const TPL_URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const TPL_TRAILING_RE = /[.,;:!?)\]}>'"`]+$/;
const TPL_LINE_COL_RE = /^(.*?):(\d+)(?::(\d+))?$/;
const TPL_MAX_CANDIDATES = 64;
const TPL_MAX_WRAPPED_ROWS = 24;
const TPL_MAX_NAME_LENGTH = 255;

function tplStripSuffixes(raw) {
  let text = raw.replace(TPL_TRAILING_RE, '');
  let line = null;
  let column = null;
  const m = TPL_LINE_COL_RE.exec(text);
  if (m) {
    line = Number(m[2]);
    column = m[3] === undefined ? null : Number(m[3]);
    text = m[1];
  }
  return { text, line, column };
}

function tplIsPathShaped(text) {
  if (!text || TPL_URL_RE.test(text)) return false;
  return text.split(/[/\\]/).every((segment) => segment.length <= TPL_MAX_NAME_LENGTH);
}

// see .ai/contexts/terminal-path-links.md ("What becomes a candidate")
function tplQuotedCandidates(lineText) {
  const out = [];
  TPL_QUOTED_RE.lastIndex = 0;
  let match;
  while ((match = TPL_QUOTED_RE.exec(lineText)) !== null) {
    const inner = match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3];
    if (!inner || !inner.includes(' ') || inner.trim() !== inner) continue;
    const parsed = tplStripSuffixes(inner);
    if (!tplIsPathShaped(parsed.text)) continue;
    out.push({
      text: parsed.text,
      line: parsed.line,
      column: parsed.column,
      start: match.index + 1,
      end: match.index + 1 + inner.length,
    });
  }
  return out;
}

function tplBareCandidates(lineText) {
  const out = [];
  const re = new RegExp(TPL_BARE_SOURCE, 'g');
  let match;
  while ((match = re.exec(lineText)) !== null) {
    if (match[0] === '') { re.lastIndex++; continue; }
    const kept = match[0].replace(TPL_TRAILING_RE, '');
    if (lineText.startsWith('://', match.index + kept.length)) continue;
    const parsed = tplStripSuffixes(match[0]);
    if (!tplIsPathShaped(parsed.text)) continue;
    out.push({
      text: parsed.text,
      line: parsed.line,
      column: parsed.column,
      start: match.index,
      end: match.index + kept.length,
    });
  }
  return out;
}

/**
 * Every filesystem-path candidate on one logical terminal line.
 *
 * @param {string} lineText
 * @returns {{text: string, line: number|null, column: number|null, start: number, end: number}[]}
 */
function findTerminalPathCandidates(lineText) {
  if (typeof lineText !== 'string' || lineText === '') return [];
  const all = tplQuotedCandidates(lineText).concat(tplBareCandidates(lineText));
  all.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  return all.slice(0, TPL_MAX_CANDIDATES);
}

// see .ai/contexts/terminal-path-links.md ("What becomes a candidate")
function tplDropOverlaps(links) {
  const kept = [];
  for (const link of links) {
    const clash = kept.find((k) => link.start < k.end && k.start < link.end);
    if (!clash) { kept.push(link); continue; }
    if (link.end - link.start > clash.end - clash.start) kept[kept.indexOf(clash)] = link;
  }
  return kept;
}

/**
 * Per-path memo in front of the openability IPC, refusals included. A line's
 * unknown candidates go out in one call — see .ai/contexts/terminal-path-links.md
 *
 * @param {(sessionId: string, texts: string[]) => Promise} lookupMany
 * @param {{max?: number, ttlMs?: number, now?: () => number}} [opts]
 */
function createTerminalPathResolver(lookupMany, opts = {}) {
  const max = opts.max || 4096;
  const ttlMs = opts.ttlMs || 30000;
  const now = opts.now || (() => Date.now());
  const cache = new Map();

  function normalise(result) {
    if (result && result.ok) return { ok: true, path: result.path };
    return { ok: false, reason: (result && result.reason) || 'unresolved' };
  }

  function resolveAll(sessionId, texts) {
    const pending = new Map();
    const settled = texts.map((text) => {
      const key = `${sessionId}\u0000${text}`;
      const hit = cache.get(key);
      // see .ai/contexts/terminal-path-links.md ("The memo evicts least-recently-used")
      if (hit && now() - hit.at < ttlMs) { cache.delete(key); cache.set(key, hit); return hit.promise; }
      if (hit) cache.delete(key);
      if (!pending.has(text)) pending.set(text, null);
      return null;
    });

    if (pending.size) {
      const wanted = Array.from(pending.keys());
      const batch = Promise.resolve()
        .then(() => lookupMany(sessionId, wanted))
        .catch(() => null);
      wanted.forEach((text, i) => {
        const promise = batch.then((results) => normalise(Array.isArray(results) ? results[i] : null));
        pending.set(text, promise);
        cache.set(`${sessionId}\u0000${text}`, { at: now(), promise });
      });
      while (cache.size > max) cache.delete(cache.keys().next().value);
    }

    return Promise.all(texts.map((text, i) => settled[i] || pending.get(text)));
  }

  function forget(sessionId) {
    const prefix = `${sessionId}\u0000`;
    for (const key of Array.from(cache.keys())) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }

  return { resolveAll, forget, get size() { return cache.size; } };
}

// The logical (unwrapped) line under `row`, with the buffer cell behind every string index.
function readTerminalLogicalLine(buffer, row) {
  let top = row;
  while (top > 0) {
    const line = buffer.getLine(top);
    if (!line || !line.isWrapped) break;
    top--;
  }
  let text = '';
  const positions = [];
  const cell = buffer.getNullCell();
  for (let y = top; y < top + TPL_MAX_WRAPPED_ROWS; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    if (y > top && !line.isWrapped) break;
    for (let x = 0; x < line.length; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let i = 0; i < chars.length; i++) positions.push({ x, y });
      text += chars;
    }
  }
  return { text, positions };
}

function tplFileUri(absolutePath) {
  const normalized = absolutePath.replace(/\\/g, '/');
  const withRoot = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${withRoot.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Register the link provider that turns openable filesystem paths into links.
 *
 * @param {object} terminal        xterm terminal
 * @param {string} sessionId
 * @param {object} deps
 * @param {object} deps.resolver   createTerminalPathResolver() result
 * @param {Function} deps.activate (target, event) => void
 * @param {Function} [deps.hover]  (uri) => void
 * @param {Function} [deps.leave]  () => void
 */
function registerTerminalPathLinks(terminal, sessionId, deps) {
  return terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active;
      const { text, positions } = readTerminalLogicalLine(buffer, bufferLineNumber - 1);
      const candidates = findTerminalPathCandidates(text);
      if (candidates.length === 0) { callback(undefined); return; }

      deps.resolver.resolveAll(sessionId, candidates.map((c) => c.text))
        .then((results) => {
          const openable = [];
          for (let i = 0; i < candidates.length; i++) {
            const result = results[i];
            if (!result || !result.ok) continue;
            const c = candidates[i];
            if (!positions[c.start] || !positions[c.end - 1]) continue;
            openable.push({ ...c, resolvedPath: result.path });
          }
          const links = tplDropOverlaps(openable).map((c) => {
            const from = positions[c.start];
            const to = positions[c.end - 1];
            const target = { path: c.resolvedPath, line: c.line, column: c.column };
            return {
              text: c.text,
              range: { start: { x: from.x + 1, y: from.y + 1 }, end: { x: to.x + 1, y: to.y + 1 } },
              activate: (event) => deps.activate(target, event),
              hover: () => { if (deps.hover) deps.hover(tplFileUri(c.resolvedPath)); },
              leave: () => { if (deps.leave) deps.leave(); },
            };
          });
          callback(links.length ? links : undefined);
        })
        .catch(() => callback(undefined));
    },
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    findTerminalPathCandidates,
    createTerminalPathResolver,
    readTerminalLogicalLine,
    registerTerminalPathLinks,
  };
}
