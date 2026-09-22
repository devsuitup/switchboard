// The wiring between createTerminalEntry and the path-link provider.
//
// terminal-path-links.test.js exercises the module; this exercises the four
// things only terminal-manager.js decides — that the provider is registered at
// all, that a left click reaches openFileInPanel with the session and the line,
// that any other button does not, and that destroySession forgets the session's
// memo. Each of those can be deleted without the module suite noticing.

const test = require('node:test');
const assert = require('node:assert');
const { setupTerminalDom } = require('./terminal-manager-harness');

// Resolves every candidate whose text is in `openable`, refuses the rest.
function resolverApi(openable, calls) {
  return {
    resolveTerminalPaths: (sessionId, texts) => {
      calls.push({ sessionId, texts });
      return Promise.resolve(texts.map((t) => (
        openable[t] ? { ok: true, path: openable[t] } : { ok: false, reason: 'missing' }
      )));
    },
  };
}

async function provideLinks(entryTerminal, row) {
  return new Promise((resolve) => {
    entryTerminal.linkProviders[0].provideLinks(row, resolve);
  });
}

test('a path in terminal output becomes a link that opens the panel at its line', async () => {
  const calls = [];
  const { window, destroy } = setupTerminalDom({
    api: resolverApi({ 'public/app.js': '/repo/public/app.js' }, calls),
  });
  try {
    const opened = [];
    window.openFileInPanel = (sessionId, filePath, opts) => opened.push({ sessionId, filePath, opts });

    const entry = window.createTerminalEntry({ sessionId: 's1' });
    assert.strictEqual(entry.terminal.linkProviders.length, 1, 'the path-link provider is registered');

    entry.terminal.setBufferRows(['edited public/app.js:7 just now']);
    const links = await provideLinks(entry.terminal, 1);

    assert.ok(links && links.length === 1, `expected one link, got ${JSON.stringify(links)}`);
    assert.strictEqual(links[0].text, 'public/app.js');
    assert.strictEqual(calls[0].sessionId, 's1', 'the session id is what main resolves against');

    links[0].activate({ button: 0 });
    // Field by field: these objects are built in the jsdom realm, so their
    // prototypes are not this realm's and deepStrictEqual refuses them.
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0].sessionId, 's1');
    assert.strictEqual(opened[0].filePath, '/repo/public/app.js');
    assert.strictEqual(opened[0].opts.line, 7, 'path:line carries the line into the panel');
  } finally {
    destroy();
  }
});

test('a right-click on a link does not open the panel', async () => {
  const { window, destroy } = setupTerminalDom({
    api: resolverApi({ 'public/app.js': '/repo/public/app.js' }, []),
  });
  try {
    const opened = [];
    window.openFileInPanel = (...args) => opened.push(args);

    const entry = window.createTerminalEntry({ sessionId: 's1' });
    entry.terminal.setBufferRows(['see public/app.js']);
    const links = await provideLinks(entry.terminal, 1);

    links[0].activate({ button: 2 });
    assert.deepStrictEqual(opened, [], 'the context menu must not also open the file');
    links[0].activate({ button: 1 });
    assert.deepStrictEqual(opened, [], 'nor must a middle click');
  } finally {
    destroy();
  }
});

test('a line with no openable path produces no links and still asks once', async () => {
  const calls = [];
  const { window, destroy } = setupTerminalDom({ api: resolverApi({}, calls) });
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    entry.terminal.setBufferRows(['nothing here is a file']);
    assert.strictEqual(await provideLinks(entry.terminal, 1), undefined);
    assert.strictEqual(calls.length, 1, 'one batched call for the whole line');
  } finally {
    destroy();
  }
});

test('destroySession forgets the session memo, so a reopened session re-asks', async () => {
  const calls = [];
  const { window, destroy } = setupTerminalDom({
    api: resolverApi({ 'public/app.js': '/repo/public/app.js' }, calls),
  });
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    entry.terminal.setBufferRows(['see public/app.js']);
    await provideLinks(entry.terminal, 1);
    assert.strictEqual(calls.length, 1);

    // Same line, same session: the memo answers and nothing goes out.
    await provideLinks(entry.terminal, 1);
    assert.strictEqual(calls.length, 1, 'the memo answers the second hover');

    window.destroySession('s1');

    const reopened = window.createTerminalEntry({ sessionId: 's1' });
    reopened.terminal.setBufferRows(['see public/app.js']);
    await provideLinks(reopened.terminal, 1);
    assert.strictEqual(calls.length, 2, 'the destroyed session left nothing cached');
  } finally {
    destroy();
  }
});
