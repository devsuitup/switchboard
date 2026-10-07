'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
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

function stageChildren(tmpRoot, src) {
  const children = [];
  const ready = [];
  const results = [];
  const childSource = `
    const { stageNodePty } = require(process.argv[1]);
    process.once('message', () => {
      try {
        process.send(stageNodePty(process.argv[2], process.argv[3]), () => process.exit(0));
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    });
    process.send('ready');
  `;
  for (let i = 0; i < 3; i++) {
    const child = spawn(process.execPath, ['-e', childSource, require.resolve('./pty-ops-conpty-stage'), tmpRoot, src], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    let result;
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    ready.push(new Promise((resolve) => {
      child.on('message', (message) => {
        if (message === 'ready') resolve();
        else result = message;
      });
      child.once('error', resolve);
      child.once('exit', resolve);
    }));
    results.push(new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: null, stderr: error.message }));
      child.once('close', (code) => resolve({ code, result, stderr }));
    }));
  }
  const timeout = setTimeout(() => { for (const child of children) child.kill(); }, 15000);
  return (async () => {
    try {
      await Promise.all(ready);
      for (const child of children) {
        if (child.connected) child.send('stage', () => {});
      }
      return await Promise.all(results);
    } finally {
      clearTimeout(timeout);
    }
  })();
}

test('three concurrent processes publish and reuse the same complete stage in six fresh roots', async (t) => {
  const { tmpRoot, src, prebuild } = fixture(t);
  for (let i = 0; i < 128; i++) fs.writeFileSync(path.join(src, 'lib', `file-${i}.js`), 'library');
  for (let round = 0; round < 6; round++) {
    const roundRoot = path.join(tmpRoot, `round-${round}`);
    fs.mkdirSync(roundRoot);
    const results = await stageChildren(roundRoot, src);
    assert.deepEqual(results.map(({ code }) => code), [0, 0, 0], JSON.stringify(results));
    const staged = results[0].result;
    for (const { result } of results) assert.deepEqual(result, staged);
    assert.deepEqual(fs.readdirSync(roundRoot), [path.basename(staged.dir)]);
    assert.ok(fs.existsSync(path.join(staged.dir, '.complete')));
    assert.equal(fs.readFileSync(path.join(staged.nodePty, 'lib', 'index.js'), 'utf8'), 'original library');
    assert.equal(fs.readFileSync(path.join(staged.nodePty, prebuild, 'pty.node'), 'utf8'), 'original prebuild');
    assert.equal(JSON.parse(fs.readFileSync(path.join(staged.nodePty, 'package.json'), 'utf8')).version, '1.0.0');
  }
});

for (const code of ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY']) {
  test(`a publication race lost with ${code} reuses the completed winner and removes its temporary copy`, (t) => {
    const { tmpRoot, src } = fixture(t);
    const winner = stageNodePty(tmpRoot, src);
    const savedWinner = path.join(path.dirname(tmpRoot), 'winner');
    fs.renameSync(winner.dir, savedWinner);
    fs.writeFileSync(path.join(savedWinner, 'node-pty', 'lib', 'index.js'), 'winner library');
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === winner.dir && path.basename(from).includes('.tmp-')) {
        assert.ok(fs.existsSync(path.join(from, '.complete')));
        rename(savedWinner, winner.dir);
        throw Object.assign(new Error('publication lost'), { code });
      }
      return rename(from, to);
    });
    const staged = stageNodePty(tmpRoot, src);
    assert.deepEqual(staged, winner);
    assert.deepEqual(fs.readdirSync(tmpRoot), [path.basename(staged.dir)]);
    assert.equal(fs.readFileSync(path.join(staged.nodePty, 'lib', 'index.js'), 'utf8'), 'winner library');
  });

  test(`a publication failure with ${code} does not accept an incomplete winner`, (t) => {
    const { tmpRoot, src } = fixture(t);
    const failure = Object.assign(new Error('publication failed'), { code });
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (path.basename(from).includes('.tmp-')) fs.mkdirSync(to);
      throw failure;
    });
    assert.throws(() => stageNodePty(tmpRoot, src), (error) => error === failure);
  });
}

test('an unrelated rename error is propagated even if a complete winner exists', (t) => {
  const { tmpRoot, src } = fixture(t);
  const failure = Object.assign(new Error('I/O failure'), { code: 'EIO' });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    throw failure;
  });
  assert.throws(() => stageNodePty(tmpRoot, src), (error) => error === failure);
});

test('a stage published between the first marker check and the directory check is reused', (t) => {
  const { tmpRoot, src } = fixture(t);
  const winner = stageNodePty(tmpRoot, src);
  const savedWinner = path.join(path.dirname(tmpRoot), 'winner');
  fs.renameSync(winner.dir, savedWinner);
  fs.writeFileSync(path.join(savedWinner, 'node-pty', 'lib', 'index.js'), 'winner library');
  const exists = fs.existsSync;
  let first = true;
  t.mock.method(fs, 'existsSync', (target) => {
    if (target === path.join(winner.dir, '.complete') && first) {
      first = false;
      fs.renameSync(savedWinner, winner.dir);
      return false;
    }
    return exists(target);
  });
  assert.deepEqual(stageNodePty(tmpRoot, src), winner);
  assert.equal(fs.readFileSync(path.join(winner.nodePty, 'lib', 'index.js'), 'utf8'), 'winner library');
});

for (const code of ['EBUSY', 'EPERM']) {
  test(`a relocated incomplete directory locked with ${code} does not prevent publication`, (t) => {
    const { tmpRoot, src } = fixture(t);
    const dir = path.join(tmpRoot, `sb-nodepty-1.0.0-${process.platform}-${process.arch}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'partial'), 'partial residue');
    const remove = fs.rmSync;
    const mock = t.mock.method(fs, 'rmSync', (target, options) => {
      if (path.basename(target).includes('.stale-')) throw Object.assign(new Error('locked'), { code });
      return remove(target, options);
    });
    const staged = stageNodePty(tmpRoot, src);
    assert.ok(fs.existsSync(path.join(staged.dir, '.complete')));
    assert.equal(fs.readdirSync(tmpRoot).length, 2);
    mock.mock.restore();
    stageNodePty(tmpRoot, src);
    assert.deepEqual(fs.readdirSync(tmpRoot), [path.basename(dir)]);
  });

  test(`a losing temporary copy locked with ${code} does not prevent winner reuse`, (t) => {
    const { tmpRoot, src } = fixture(t);
    t.mock.method(fs, 'renameSync', (from, to) => {
      fs.cpSync(from, to, { recursive: true });
      throw Object.assign(new Error('publication lost'), { code: 'EPERM' });
    });
    const remove = fs.rmSync;
    const mock = t.mock.method(fs, 'rmSync', (target, options) => {
      if (path.basename(target).includes('.tmp-')) throw Object.assign(new Error('locked'), { code });
      return remove(target, options);
    });
    const staged = stageNodePty(tmpRoot, src);
    assert.ok(fs.existsSync(path.join(staged.dir, '.complete')));
    const temp = fs.readdirSync(tmpRoot).find((name) => name.includes('.tmp-'));
    assert.ok(temp);
    mock.mock.restore();
    fs.rmSync(path.join(tmpRoot, temp), { recursive: true });
    assert.deepEqual(fs.readdirSync(tmpRoot), [path.basename(staged.dir)]);
  });
}

test('an incomplete directory already relocated by another process can still be staged', (t) => {
  const { tmpRoot, src } = fixture(t);
  const dir = path.join(tmpRoot, `sb-nodepty-1.0.0-${process.platform}-${process.arch}`);
  fs.mkdirSync(dir);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === dir) {
      rename(from, to);
      throw Object.assign(new Error('already relocated'), { code: 'ENOENT' });
    }
    return rename(from, to);
  });
  const staged = stageNodePty(tmpRoot, src);
  assert.ok(fs.existsSync(path.join(staged.dir, '.complete')));
  assert.deepEqual(fs.readdirSync(tmpRoot), [path.basename(dir)]);
});

test('a completed winner appearing during a failed stale relocation is reused', (t) => {
  const { tmpRoot, src } = fixture(t);
  const dir = path.join(tmpRoot, `sb-nodepty-1.0.0-${process.platform}-${process.arch}`);
  fs.mkdirSync(dir);
  t.mock.method(fs, 'renameSync', (from) => {
    assert.equal(from, dir);
    fs.writeFileSync(path.join(dir, '.complete'), '');
    throw Object.assign(new Error('busy winner'), { code: 'EBUSY' });
  });
  assert.equal(stageNodePty(tmpRoot, src).dir, dir);
  assert.deepEqual(fs.readdirSync(tmpRoot), [path.basename(dir)]);
});

test('a stale relocation failure without a completed winner is propagated', (t) => {
  const { tmpRoot, src } = fixture(t);
  const dir = path.join(tmpRoot, `sb-nodepty-1.0.0-${process.platform}-${process.arch}`);
  fs.mkdirSync(dir);
  const failure = Object.assign(new Error('locked incomplete stage'), { code: 'EBUSY' });
  const renameMock = t.mock.method(fs, 'renameSync', () => { throw failure; });
  assert.throws(() => stageNodePty(tmpRoot, src), (error) => error === failure);
  assert.equal(renameMock.mock.callCount(), 1);
  assert.deepEqual(fs.readdirSync(tmpRoot), [path.basename(dir)]);
});

test('an incomplete final directory is moved aside before best-effort removal', (t) => {
  const { tmpRoot, src } = fixture(t);
  const dir = path.join(tmpRoot, `sb-nodepty-1.0.0-${process.platform}-${process.arch}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'partial'), 'partial residue');
  const remove = fs.rmSync;
  const removed = [];
  t.mock.method(fs, 'rmSync', (target, options) => {
    assert.notEqual(target, dir, 'never delete the publication path in place');
    removed.push(target);
    return remove(target, options);
  });
  const staged = stageNodePty(tmpRoot, src);
  assert.equal(staged.dir, dir);
  assert.ok(removed.some((target) => path.basename(target).startsWith(`${path.basename(dir)}.stale-`)));
  assert.deepEqual(fs.readdirSync(tmpRoot), [path.basename(dir)]);
  assert.ok(fs.existsSync(path.join(dir, '.complete')));
});

test('the sweep preserves young temporary stages and removes old temporary and stale stages', (t) => {
  const { tmpRoot, src } = fixture(t);
  const young = path.join(tmpRoot, 'sb-nodepty-other.tmp-young');
  const old = path.join(tmpRoot, 'sb-nodepty-other.tmp-old');
  const stale = path.join(tmpRoot, 'sb-nodepty-other.stale-old');
  for (const dir of [young, old, stale]) fs.mkdirSync(dir);
  const past = new Date(Date.now() - 10 * 60 * 1000);
  for (const dir of [old, stale]) fs.utimesSync(dir, past, past);
  stageNodePty(tmpRoot, src);
  assert.ok(fs.existsSync(young));
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(stale), false);
});

test('the sweep tolerates a temporary sibling disappearing before its age is checked', (t) => {
  const { tmpRoot, src } = fixture(t);
  const temp = path.join(tmpRoot, 'sb-nodepty-other.tmp-disappearing');
  fs.mkdirSync(temp);
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (target, options) => {
    if (target === temp) {
      fs.rmdirSync(temp);
      throw Object.assign(new Error('already published'), { code: 'ENOENT' });
    }
    return stat(target, options);
  });
  const staged = stageNodePty(tmpRoot, src);
  assert.deepEqual(fs.readdirSync(tmpRoot), [path.basename(staged.dir)]);
});

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

  const copy = fs.cpSync;
  t.mock.method(fs, 'cpSync', (from, to, options) => {
    if (from === path.join(src, prebuild)) {
      const stagingDir = path.dirname(path.dirname(path.dirname(to)));
      assert.equal(fs.existsSync(path.join(stagingDir, '.complete')), false);
    }
    return copy(from, to, options);
  });

  assert.throws(() => stageNodePty(tmpRoot, src), { code: 'ENOENT' });
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
  fs.mkdirSync(path.join(src, prebuild));
  fs.writeFileSync(prebuildFile, 'restored prebuild');
  const staged = stageNodePty(tmpRoot, src);
  assert.equal(path.basename(staged.dir), `sb-nodepty-1.0.0-${process.platform}-${process.arch}`);
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
