'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRemoteIndexer } = require('../src/main/remote/remote-index');

function errors(t, method) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-914-'));
  const warnings = [];
  let message;
  const indexer = createRemoteIndexer({
    dataDir, getHosts: () => [{ alias: 'vps' }],
    log: { info() {}, warn: value => warnings.push(value) },
    sync: async () => ({ fetched: 0, unchanged: 0, removed: 0, failed: 0, changedFolders: new Set(), sessions: [] }),
    refreshHeadTurns: async () => { throw new Error(message); },
  });
  t.after(() => { indexer.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { warnings, emit: async value => {
    message = value;
    const result = await indexer[method]('vps');
    assert.deepEqual(method === 'refreshNow' ? result.errors : result.error, method === 'refreshNow' ? [] : null);
  } };
}

for (const method of ['refreshNow', 'refreshHostNow']) {
  test(`${method}: escape tokens keep distinct warning signatures`, async t => {
    const h = errors(t, method);
    for (const token of [String.raw`\n`, String.raw`\t`, String.raw`\u001b[0m`]) {
      await h.emit('unexpected token ' + token);
      await h.emit('unexpected token ' + token);
    }
    assert.equal(h.warnings.length, 3, 'each escape token must warn once');
    assert.ok(h.warnings[1].endsWith(String.raw`\t`));
    assert.ok(h.warnings[2].endsWith(String.raw`\u001b[0m`));
  });

  for (const prefix of ['', 'key=']) {
    test(`${method}: UNC paths coalesce at anchor ${JSON.stringify(prefix)}`, async t => {
      const h = errors(t, method);
      await h.emit(prefix + '//server/share/a failed');
      await h.emit(prefix + '//other/volume/b failed');
      assert.equal(h.warnings.length, 1, 'forward-slash UNC paths must share a signature');
    });
  }

  test(`${method}: Windows roots coalesce while URLs stay distinct`, async t => {
    const h = errors(t, method);
    for (const root of [String.raw`\server\share`, String.raw`\?\C:\x`, String.raw`C:\x`, String.raw`\\server\share`]) {
      await h.emit(root + ' failed');
    }
    assert.equal(h.warnings.length, 1);
    await h.emit(String.raw`key=\x\y failed`);
    await h.emit(String.raw`key=\a\b failed`);
    assert.equal(h.warnings.length, 2);
    for (const url of ['http://one.example/a', 'http://two.example/b', 'file:///one/a', 'file:///two/b']) {
      await h.emit(url + ' failed');
      await h.emit(url + ' failed');
    }
    assert.equal(h.warnings.length, 6, 'each URL stays distinct and repeats stay quiet');
  });
}
