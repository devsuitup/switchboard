// Filesystem paths in terminal output: what becomes a link, and what it opens.
//
// The matrix below is the contract. Each row is one line of terminal output,
// written into a stub xterm buffer, read back by the real link provider, and
// resolved by the real main-side openability check against real files on
// disk. A form added to the table is covered without further wiring.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  findTerminalPathCandidates,
  createTerminalPathResolver,
  readTerminalLogicalLine,
  registerTerminalPathLinks,
} = require('../public/terminal-path-links');
const { resolveTerminalPathTarget, fileHasNullByte } = require('../terminal-path-target');
const { isSensitivePath } = require('../ipc-path-validator');

const MAX_BYTES = 2 * 1024 * 1024;
const COLS = 120;

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-links-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(cwd, 'public'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'emptydir'));
  fs.mkdirSync(path.join(cwd, 'docs'));
  fs.writeFileSync(path.join(cwd, 'public', 'app.js'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(cwd, 'my file.txt'), 'spaced\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# readme\n');
  fs.writeFileSync(path.join(cwd, 'Makefile'), 'all:\n');
  fs.writeFileSync(path.join(cwd, 'plan'), 'the plan\n');
  return { root, home, cwd };
}

const fixture = makeFixture();
const ABS = path.join(fixture.cwd, 'public/app.js');
test.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

// The real openability check, wearing an IPC's clothes. `counter.calls` is the
// IPC round trips; `counter.lookups` is the paths those calls carried.
function makeLookup(counter) {
  return (_sessionId, texts) => {
    counter.calls++;
    counter.lookups = (counter.lookups || 0) + texts.length;
    return Promise.resolve(texts.map((text) => resolveTerminalPathTarget(text, fixture.cwd, {
      isSensitivePath,
      statSync: (p) => fs.statSync(p),
      hasNullByte: fileHasNullByte,
      homedir: () => fixture.home,
      maxBytes: MAX_BYTES,
    })));
  };
}

// --- Stub xterm buffer: the surface the provider reads ---

function makeCell() {
  let chars = '';
  let width = 1;
  return { getChars: () => chars, getWidth: () => width, _set(c, w) { chars = c; width = w; } };
}

function makeLine(text, isWrapped) {
  const padded = text.padEnd(COLS, ' ');
  return {
    isWrapped,
    length: COLS,
    getCell(x, cell) { cell._set(padded[x], 1); },
  };
}

// rows: array of strings, or {text, isWrapped}
function makeTerminal(rows) {
  const lines = rows.map((r) => (typeof r === 'string' ? makeLine(r, false) : makeLine(r.text, !!r.isWrapped)));
  return {
    provider: null,
    buffer: { active: { getLine: (y) => lines[y], getNullCell: makeCell } },
    registerLinkProvider(provider) { this.provider = provider; return { dispose() {} }; },
  };
}

function provideLinks(terminal, bufferLineNumber) {
  return new Promise((resolve) => terminal.provider.provideLinks(bufferLineNumber, (links) => resolve(links || [])));
}

async function linksFor(rows, { row = 1, counter = { calls: 0 }, activated = [] } = {}) {
  const terminal = makeTerminal(rows);
  registerTerminalPathLinks(terminal, 'sess-1', {
    resolver: createTerminalPathResolver(makeLookup(counter)),
    activate: (target) => activated.push(target),
  });
  const links = await provideLinks(terminal, row);
  return { links, terminal, counter, activated };
}

// --- The matrix ---

const MATRIX = [
  {
    name: 'absolute path, bare',
    line: () => `wrote ${ABS} just now`,
    expect: [{ text: ABS, line: null, column: null }],
  },
  {
    name: 'absolute path, in backticks',
    line: () => `see \`${ABS}\` for the detail`,
    expect: [{ text: ABS, line: null, column: null }],
  },
  {
    name: 'absolute path with :line',
    line: () => `${ABS}:12: const x = 1`,
    expect: [{ text: ABS, line: 12, column: null }],
  },
  {
    name: 'relative path, bare',
    line: () => 'public/app.js changed',
    expect: [{ text: path.join(fixture.cwd, 'public/app.js'), line: null, column: null }],
  },
  {
    name: 'relative path with :line',
    line: () => 'public/app.js:3 needs a look',
    expect: [{ text: path.join(fixture.cwd, 'public/app.js'), line: 3, column: null }],
  },
  {
    name: 'relative path with :line:col',
    line: () => 'public/app.js:2:7 unexpected token',
    expect: [{ text: path.join(fixture.cwd, 'public/app.js'), line: 2, column: 7 }],
  },
  {
    name: 'the URI of an OSC 8 hyperlink is left to the existing file:// route',
    line: () => `file://${ABS}`,
    expect: [],
  },
  {
    name: 'an http URL is left to the web-links addon',
    line: () => 'see https://example.com/a/b for more',
    expect: [],
  },
  {
    name: 'a path that does not exist gets no link',
    line: () => 'public/ghost.js is not there',
    expect: [],
  },
  {
    name: 'a path the guards refuse gets no link',
    line: () => `open ${path.join(fixture.cwd, '.env')} now`,
    expect: [],
  },
  {
    name: 'a directory gets no link',
    line: () => 'cd emptydir/ first',
    expect: [],
  },
  {
    name: 'a name with spaces links when quoted',
    line: () => 'open "my file.txt" please',
    expect: [{ text: path.join(fixture.cwd, 'my file.txt'), line: null, column: null }],
  },
  {
    name: 'a name with spaces, unquoted, links nothing rather than half of it',
    line: () => 'open my file.txt please',
    expect: [],
  },
  {
    name: 'a trailing period is prose, not part of the name',
    line: () => 'it is in public/app.js.',
    expect: [{ text: path.join(fixture.cwd, 'public/app.js'), line: null, column: null }],
  },
  {
    name: 'a bare filename that exists and is openable links',
    line: () => 'README.md was updated',
    expect: [{ text: path.join(fixture.cwd, 'README.md'), line: null, column: null }],
  },
  {
    name: 'an extensionless bare filename links',
    line: () => 'run Makefile first',
    expect: [{ text: path.join(fixture.cwd, 'Makefile'), line: null, column: null }],
  },
  {
    name: 'a bare filename that collides with an ordinary English word links anyway',
    line: () => 'we should plan the work',
    expect: [{ text: path.join(fixture.cwd, 'plan'), line: null, column: null }],
  },
  {
    name: 'a bare filename that does not exist gets no link',
    line: () => 'ghost.js was updated and README too',
    expect: [],
  },
  {
    name: 'a bare name that is a directory gets no link',
    line: () => 'look in emptydir for it',
    expect: [],
  },
  {
    name: 'a bare filename the guards refuse gets no link',
    line: () => 'open .env now',
    expect: [],
  },
  {
    name: 'a bare filename with :line carries the line',
    line: () => 'README.md:2 is the heading',
    expect: [{ text: path.join(fixture.cwd, 'README.md'), line: 2, column: null }],
  },
  {
    name: 'two paths on one line get two links',
    line: () => 'public/app.js and "my file.txt"',
    expect: [
      { text: path.join(fixture.cwd, 'my file.txt'), line: null, column: null },
      { text: path.join(fixture.cwd, 'public/app.js'), line: null, column: null },
    ],
  },
];

for (const row of MATRIX) {
  test(`link matrix: ${row.name}`, async () => {
    const { links, activated, terminal } = await linksFor([row.line()]);
    assert.strictEqual(links.length, row.expect.length, `links: ${JSON.stringify(links.map((l) => l.text))}`);

    const seen = [];
    for (const link of links) {
      link.activate({ button: 0 });
      assert.ok(link.range.start.y === 1 && link.range.end.y === 1);
      assert.ok(link.range.start.x >= 1 && link.range.end.x >= link.range.start.x);
    }
    for (const target of activated) seen.push({ text: target.path, line: target.line, column: target.column });
    seen.sort((a, b) => a.text.localeCompare(b.text));
    const want = row.expect.slice().sort((a, b) => a.text.localeCompare(b.text));
    assert.deepStrictEqual(seen, want);
    assert.ok(terminal.provider);
  });
}

// --- Ranges, wrapping, and the buffer read ---

test('the link range covers exactly the matched text, including its :line suffix', async () => {
  const line = `x ${ABS}:12 y`;
  const { links } = await linksFor([line]);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].range.start.x, 3);
  assert.strictEqual(links[0].range.end.x, 2 + `${ABS}:12`.length);
});

test('a path split across a wrapped line is read back whole', () => {
  const text = `${ABS}`;
  const head = text.slice(0, 40);
  const tail = text.slice(40);
  const terminal = makeTerminal([head.padEnd(COLS, ' '), { text: tail, isWrapped: true }]);
  // A wrapped row must be read from its first row, which is where xterm asks.
  const logical = readTerminalLogicalLine(terminal.buffer.active, 0);
  assert.ok(logical.text.startsWith(head));
  assert.strictEqual(logical.positions.length, logical.text.length);
});

test('provideLinks asked about the wrapped continuation row walks back to the start', async () => {
  const head = 'run '.padEnd(COLS - 20, ' ');
  const terminal = makeTerminal([head, { text: `${ABS}`, isWrapped: true }]);
  registerTerminalPathLinks(terminal, 'sess-1', {
    resolver: createTerminalPathResolver(makeLookup({ calls: 0 })),
    activate: () => {},
  });
  const links = await provideLinks(terminal, 2);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].text, ABS);
});

test('hover reports a file:// URI so the existing context menu classifies it', async () => {
  const hovered = [];
  const terminal = makeTerminal([`see ${ABS}`]);
  registerTerminalPathLinks(terminal, 'sess-1', {
    resolver: createTerminalPathResolver(makeLookup({ calls: 0 })),
    activate: () => {},
    hover: (uri) => hovered.push(uri),
    leave: () => hovered.push(null),
  });
  const links = await provideLinks(terminal, 1);
  links[0].hover();
  links[0].leave();
  assert.strictEqual(hovered.length, 2);
  assert.ok(hovered[0].startsWith('file:///'));
  assert.strictEqual(hovered[1], null);
});

// --- The cache ---

test('a sweep across repeated lines costs one call, not one per line', async () => {
  const counter = { calls: 0 };
  const LINES = 200;
  const rows = Array.from({ length: LINES }, () => 'public/app.js and public/ghost.js');
  const terminal = makeTerminal(rows);
  registerTerminalPathLinks(terminal, 'sess-1', {
    resolver: createTerminalPathResolver(makeLookup(counter)),
    activate: () => {},
  });
  for (let i = 1; i <= LINES; i++) {
    const links = await provideLinks(terminal, i);
    assert.strictEqual(links.length, 1);
  }
  assert.strictEqual(counter.calls, 1);
  // Three distinct candidates: the openable path, the missing one, and "and".
  assert.strictEqual(counter.lookups, 3);
});

test('an ordinary sentence of prose costs one call on the first pass and none on the second', async () => {
  const counter = { calls: 0 };
  const prose = 'the watcher now reports every change it sees without waiting for a poll';
  const terminal = makeTerminal([prose]);
  registerTerminalPathLinks(terminal, 'sess-1', {
    resolver: createTerminalPathResolver(makeLookup(counter)),
    activate: () => {},
  });
  assert.deepStrictEqual(await provideLinks(terminal, 1), []);
  assert.strictEqual(counter.calls, 1);
  assert.strictEqual(counter.lookups, new Set(prose.split(' ')).size);

  assert.deepStrictEqual(await provideLinks(terminal, 1), []);
  assert.strictEqual(counter.calls, 1);
});

test('simultaneous lookups of the same path share one call', async () => {
  const counter = { calls: 0 };
  const resolver = createTerminalPathResolver(makeLookup(counter));
  await Promise.all([
    resolver.resolveAll('s', ['public/app.js']),
    resolver.resolveAll('s', ['public/app.js']),
    resolver.resolveAll('s', ['public/app.js']),
  ]);
  assert.strictEqual(counter.calls, 1);
});

test('a refusal is cached too, so a missing path is not asked about twice', async () => {
  const counter = { calls: 0 };
  const resolver = createTerminalPathResolver(makeLookup(counter));
  assert.deepStrictEqual((await resolver.resolveAll('s', ['public/ghost.js']))[0], { ok: false, reason: 'missing' });
  assert.deepStrictEqual((await resolver.resolveAll('s', ['public/ghost.js']))[0], { ok: false, reason: 'missing' });
  assert.strictEqual(counter.calls, 1);
});

test('an entry is asked again once its time-to-live has passed', async () => {
  const counter = { calls: 0 };
  let clock = 0;
  const resolver = createTerminalPathResolver(makeLookup(counter), { ttlMs: 1000, now: () => clock });
  await resolver.resolveAll('s', ['public/app.js']);
  clock = 999;
  await resolver.resolveAll('s', ['public/app.js']);
  assert.strictEqual(counter.calls, 1);
  clock = 1001;
  await resolver.resolveAll('s', ['public/app.js']);
  assert.strictEqual(counter.calls, 2);
});

test('the cache is bounded and sheds its oldest entries', async () => {
  const resolver = createTerminalPathResolver(makeLookup({ calls: 0 }), { max: 10 });
  for (let i = 0; i < 50; i++) await resolver.resolveAll('s', [`public/missing-${i}.js`]);
  assert.strictEqual(resolver.size, 10);
});

test('closing a session drops that session s entries and no other s', async () => {
  const resolver = createTerminalPathResolver(makeLookup({ calls: 0 }));
  await resolver.resolveAll('a', ['public/app.js']);
  await resolver.resolveAll('b', ['public/app.js']);
  resolver.forget('a');
  assert.strictEqual(resolver.size, 1);
});

test('a lookup that throws is a refusal, not an unhandled rejection', async () => {
  const resolver = createTerminalPathResolver(() => Promise.reject(new Error('ipc down')));
  assert.deepStrictEqual(await resolver.resolveAll('s', ['a', 'b']), [
    { ok: false, reason: 'unresolved' },
    { ok: false, reason: 'unresolved' },
  ]);
});

// --- The matcher on its own ---

test('the matcher caps how many candidates one line can produce', () => {
  const line = Array.from({ length: 200 }, (_, i) => `a/b${i}`).join(' ');
  assert.strictEqual(findTerminalPathCandidates(line).length, 64);
});

test('a bare word is a candidate; whether it links is the openability question', () => {
  assert.deepStrictEqual(
    findTerminalPathCandidates('README app.js Makefile').map((c) => c.text),
    ['README', 'app.js', 'Makefile'],
  );
});

test('a component longer than a filename may be is not a candidate', () => {
  assert.deepStrictEqual(findTerminalPathCandidates('x'.repeat(256)), []);
  assert.strictEqual(findTerminalPathCandidates('x'.repeat(255)).length, 1);
});

test('a URL scheme is not a candidate, and neither is anything inside the URL', () => {
  assert.deepStrictEqual(
    findTerminalPathCandidates('see https://example.com/a/b and http://x.y/z').map((c) => c.text),
    ['see', 'and'],
  );
});

// The bare pass drops a URL by looking for '://' just past the match. A quoted
// string is taken whole, so that lookahead never applies and the shape check is
// the only thing left to refuse it.
test('a quoted URL is not a candidate either', () => {
  assert.deepStrictEqual(
    findTerminalPathCandidates('fetched "http://example.com/a b/c" twice').map((c) => c.text),
    // 'b/c' comes from the bare pass, which reads inside the quotes; what must
    // not appear is the quoted string itself, URL scheme and all.
    ['fetched', 'b/c', 'twice'],
  );
});

// The memo sheds its oldest *insertion*, so without re-inserting on a hit the
// hot region is what gets evicted: a sweep wider than the cap would drop to a
// zero hit rate in one step instead of degrading.
test('the memo keeps what is being used and sheds what is not', async () => {
  const asked = [];
  const resolver = createTerminalPathResolver(
    (_sessionId, texts) => { asked.push(...texts); return Promise.resolve(texts.map(() => ({ ok: false, reason: 'missing' }))); },
    { max: 2 },
  );

  await resolver.resolveAll('s', ['a']);
  await resolver.resolveAll('s', ['b']);
  await resolver.resolveAll('s', ['a']);   // a is now the most recently used
  await resolver.resolveAll('s', ['c']);   // evicts the least recently used
  assert.deepStrictEqual(asked, ['a', 'b', 'c'], 'the third hover of a was free');

  await resolver.resolveAll('s', ['a']);
  assert.deepStrictEqual(asked, ['a', 'b', 'c'], 'a survived the eviction');

  await resolver.resolveAll('s', ['b']);
  assert.deepStrictEqual(asked, ['a', 'b', 'c', 'b'], 'b was the one shed');
});
