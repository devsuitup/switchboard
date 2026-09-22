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
  fs.writeFileSync(path.join(cwd, 'docs', 'my file.txt'), 'spaced\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# readme\n');
  return { root, home, cwd };
}

const fixture = makeFixture();
const ABS = path.join(fixture.cwd, 'public/app.js');
test.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

// The real openability check, wearing an IPC's clothes.
function makeLookup(counter) {
  return (_sessionId, text) => {
    counter.calls++;
    return Promise.resolve(resolveTerminalPathTarget(text, fixture.cwd, {
      isSensitivePath,
      statSync: (p) => fs.statSync(p),
      hasNullByte: fileHasNullByte,
      homedir: () => fixture.home,
      maxBytes: MAX_BYTES,
    }));
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
    name: 'a relative path the guards refuse gets no link',
    line: () => 'open .env now',
    expect: [],
  },
  {
    name: 'a directory gets no link',
    line: () => 'cd emptydir/ first',
    expect: [],
  },
  {
    name: 'a path with spaces links when quoted',
    line: () => 'open "docs/my file.txt" please',
    expect: [{ text: path.join(fixture.cwd, 'docs/my file.txt'), line: null, column: null }],
  },
  {
    name: 'a path with spaces, unquoted, links nothing rather than half of it',
    line: () => 'open docs/my file.txt please',
    expect: [],
  },
  {
    name: 'a trailing period is prose, not part of the name',
    line: () => 'it is in public/app.js.',
    expect: [{ text: path.join(fixture.cwd, 'public/app.js'), line: null, column: null }],
  },
  {
    name: 'a bare word is never a path',
    line: () => 'app.js was updated and README too',
    expect: [],
  },
  {
    // Prose names files constantly. Without a separator the candidate is not a
    // path, even when a file of that name does sit in the session's cwd.
    name: 'a bare filename that does exist is still not a path',
    line: () => 'README.md was updated',
    expect: [],
  },
  {
    name: 'two paths on one line get two links',
    line: () => 'public/app.js and "docs/my file.txt"',
    expect: [
      { text: path.join(fixture.cwd, 'docs/my file.txt'), line: null, column: null },
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

test('a right-click does not activate the link', async () => {
  const activated = [];
  const terminal = makeTerminal([`see ${ABS}`]);
  registerTerminalPathLinks(terminal, 'sess-1', {
    resolver: createTerminalPathResolver(makeLookup({ calls: 0 })),
    activate: (target, event) => {
      if (event && typeof event.button === 'number' && event.button !== 0) return;
      activated.push(target);
    },
  });
  const links = await provideLinks(terminal, 1);
  links[0].activate({ button: 2 });
  assert.deepStrictEqual(activated, []);
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

test('a sweep across the scrollback costs one lookup per distinct candidate, not one per line', async () => {
  const counter = { calls: 0 };
  const rows = [];
  const LINES = 200;
  for (let i = 0; i < LINES; i++) rows.push(`${i}: public/app.js and public/ghost.js`);
  const terminal = makeTerminal(rows);
  registerTerminalPathLinks(terminal, 'sess-1', {
    resolver: createTerminalPathResolver(makeLookup(counter)),
    activate: () => {},
  });
  for (let i = 1; i <= LINES; i++) {
    const links = await provideLinks(terminal, i);
    assert.strictEqual(links.length, 1);
  }
  // Two distinct candidates on every line: the openable one and the missing one.
  assert.strictEqual(counter.calls, 2);
});

test('simultaneous lookups of the same path share one call', async () => {
  const counter = { calls: 0 };
  const resolver = createTerminalPathResolver(makeLookup(counter));
  await Promise.all([
    resolver.resolve('s', 'public/app.js'),
    resolver.resolve('s', 'public/app.js'),
    resolver.resolve('s', 'public/app.js'),
  ]);
  assert.strictEqual(counter.calls, 1);
});

test('a refusal is cached too, so a missing path is not asked about twice', async () => {
  const counter = { calls: 0 };
  const resolver = createTerminalPathResolver(makeLookup(counter));
  assert.deepStrictEqual(await resolver.resolve('s', 'public/ghost.js'), { ok: false, reason: 'missing' });
  assert.deepStrictEqual(await resolver.resolve('s', 'public/ghost.js'), { ok: false, reason: 'missing' });
  assert.strictEqual(counter.calls, 1);
});

test('an entry is asked again once its time-to-live has passed', async () => {
  const counter = { calls: 0 };
  let clock = 0;
  const resolver = createTerminalPathResolver(makeLookup(counter), { ttlMs: 1000, now: () => clock });
  await resolver.resolve('s', 'public/app.js');
  clock = 999;
  await resolver.resolve('s', 'public/app.js');
  assert.strictEqual(counter.calls, 1);
  clock = 1001;
  await resolver.resolve('s', 'public/app.js');
  assert.strictEqual(counter.calls, 2);
});

test('the cache is bounded and sheds its oldest entries', async () => {
  const resolver = createTerminalPathResolver(makeLookup({ calls: 0 }), { max: 10 });
  for (let i = 0; i < 50; i++) await resolver.resolve('s', `public/missing-${i}.js`);
  assert.strictEqual(resolver.size, 10);
});

test('closing a session drops that session s entries and no other s', async () => {
  const resolver = createTerminalPathResolver(makeLookup({ calls: 0 }));
  await resolver.resolve('a', 'public/app.js');
  await resolver.resolve('b', 'public/app.js');
  resolver.forget('a');
  assert.strictEqual(resolver.size, 1);
});

test('a lookup that throws is a refusal, not an unhandled rejection', async () => {
  const resolver = createTerminalPathResolver(() => Promise.reject(new Error('ipc down')));
  assert.deepStrictEqual(await resolver.resolve('s', 'public/app.js'), { ok: false, reason: 'error' });
});

// --- The matcher on its own ---

test('the matcher caps how many candidates one line can produce', () => {
  const line = Array.from({ length: 40 }, (_, i) => `a/b${i}`).join(' ');
  assert.ok(findTerminalPathCandidates(line).length <= 16);
});

test('the matcher needs a separator: a word is not a candidate', () => {
  assert.deepStrictEqual(findTerminalPathCandidates('README app.js Makefile'), []);
});

test('a quoted span needs a separator too, so prose in quotes is not a candidate', () => {
  assert.deepStrictEqual(findTerminalPathCandidates('he said "that was the plan" today'), []);
});
