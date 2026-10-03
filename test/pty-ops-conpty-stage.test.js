'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stageNodePty } = require('./pty-ops-conpty-stage');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-conpty-stage-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tmpRoot = path.join(root, 'temp');
  const src = path.join(root, 'source');
  const prebuild = path.join('prebuilds', `${process.platform}-${process.arch}`);
  fs.mkdirSync(tmpRoot);
  fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(src, prebuild), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(src, 'lib', 'index.js'), 'original library');
  fs.writeFileSync(path.join(src, prebuild, 'pty.node'), 'original prebuild');
  return { tmpRoot, src, prebuild };
}

test('consecutive stagings reuse one complete directory without copying again', (t) => {
  const { tmpRoot, src } = fixture(t);
  const first = stageNodePty(tmpRoot, src);
  fs.writeFileSync(path.join(src, 'lib', 'index.js'), 'changed source');
  const second = stageNodePty(tmpRoot, src);

  assert.equal(second.dir, first.dir);
  assert.equal(second.nodePty, first.nodePty);
  assert.deepEqual(fs.readdirSync(tmpRoot), [path.basename(first.dir)]);
  assert.equal(fs.readFileSync(path.join(second.nodePty, 'lib', 'index.js'), 'utf8'), 'original library');
  assert.ok(fs.existsSync(path.join(second.dir, '.complete')));
});

test('a directory without the completion marker is cleared and re-staged', (t) => {
  const { tmpRoot, src, prebuild } = fixture(t);
  const dir = path.join(tmpRoot, `sb-nodepty-1.0.0-${process.platform}-${process.arch}`);
  const nodePty = path.join(dir, 'node-pty');
  fs.mkdirSync(path.join(nodePty, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(nodePty, 'lib', 'index.js'), 'partial library');
  fs.writeFileSync(path.join(nodePty, 'obsolete'), 'partial residue');
  const staged = stageNodePty(tmpRoot, src);

  assert.equal(staged.dir, dir);
  assert.equal(fs.readFileSync(path.join(nodePty, 'lib', 'index.js'), 'utf8'), 'original library');
  assert.equal(fs.readFileSync(path.join(nodePty, prebuild, 'pty.node'), 'utf8'), 'original prebuild');
  assert.equal(JSON.parse(fs.readFileSync(path.join(nodePty, 'package.json'), 'utf8')).version, '1.0.0');
  assert.equal(fs.existsSync(path.join(nodePty, 'obsolete')), false);
  assert.ok(fs.existsSync(path.join(dir, '.complete')));
});

test('stale staging siblings are swept even when the current stage is complete', (t) => {
  const { tmpRoot, src } = fixture(t);
  const current = stageNodePty(tmpRoot, src);
  const stale = path.join(tmpRoot, 'sb-nodepty-old');
  const unrelated = path.join(tmpRoot, 'unrelated');
  const file = path.join(tmpRoot, 'sb-nodepty-file');
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'residue'), 'old copy');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(file, 'keep');
  stageNodePty(tmpRoot, src);

  assert.equal(fs.existsSync(stale), false);
  assert.ok(fs.existsSync(path.join(current.dir, '.complete')));
  assert.ok(fs.existsSync(path.join(current.nodePty, 'lib', 'index.js')));
  assert.ok(fs.existsSync(unrelated));
  assert.ok(fs.existsSync(file));
});

test('a different package version gets a different staging directory', (t) => {
  const { tmpRoot, src } = fixture(t);
  const first = stageNodePty(tmpRoot, src);
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  fs.writeFileSync(path.join(src, 'lib', 'index.js'), 'new version');
  const second = stageNodePty(tmpRoot, src);

  assert.notEqual(second.dir, first.dir);
  assert.equal(path.basename(second.dir), `sb-nodepty-2.0.0-${process.platform}-${process.arch}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(second.nodePty, 'package.json'), 'utf8')).version, '2.0.0');
  assert.equal(fs.readFileSync(path.join(second.nodePty, 'lib', 'index.js'), 'utf8'), 'new version');
});

test('a failed copy has no completion marker and is retried successfully', (t) => {
  const { tmpRoot, src, prebuild } = fixture(t);
  const prebuildFile = path.join(src, prebuild, 'pty.node');
  fs.unlinkSync(prebuildFile);
  fs.rmdirSync(path.join(src, prebuild));

  assert.throws(() => stageNodePty(tmpRoot, src), { code: 'ENOENT' });
  const entries = fs.readdirSync(tmpRoot);
  assert.equal(entries.length, 1);
  assert.equal(fs.existsSync(path.join(tmpRoot, entries[0], '.complete')), false);
  fs.mkdirSync(path.join(src, prebuild));
  fs.writeFileSync(prebuildFile, 'restored prebuild');
  const staged = stageNodePty(tmpRoot, src);
  assert.equal(path.basename(staged.dir), entries[0]);
  assert.equal(fs.readFileSync(path.join(staged.nodePty, prebuild, 'pty.node'), 'utf8'), 'restored prebuild');
  assert.ok(fs.existsSync(path.join(staged.dir, '.complete')));
});

for (const code of ['EBUSY', 'EPERM']) {
  test(`a stale directory locked with ${code} is kept and retried next time`, (t) => {
    const { tmpRoot, src } = fixture(t);
    const stale = path.join(tmpRoot, 'sb-nodepty-locked');
    fs.mkdirSync(stale);
    const remove = fs.rmSync;
    const mock = t.mock.method(fs, 'rmSync', (target, options) => {
      if (target === stale) throw Object.assign(new Error('locked'), { code });
      return remove(target, options);
    });
    let staged;
    try {
      staged = stageNodePty(tmpRoot, src);
      assert.ok(fs.existsSync(stale));
      assert.ok(fs.existsSync(path.join(staged.dir, '.complete')));
    } finally {
      mock.mock.restore();
    }
    assert.equal(stageNodePty(tmpRoot, src).dir, staged.dir);
    assert.equal(fs.existsSync(stale), false);
  });
}
