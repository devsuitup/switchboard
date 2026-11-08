'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const modulePath = path.join(__dirname, '../src/main/files/panel-image.js');
const panelImage = require(modulePath);

test('T1: magic bytes identify the five raster image formats', () => {
  assert.equal(typeof panelImage.sniffPanelImage, 'function');
  const bmp = Buffer.alloc(26);
  bmp.write('BM');
  bmp.writeUInt32LE(12, 14);
  for (const [buf, mime] of [
    [Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png'],
    [Buffer.from('ffd8ff', 'hex'), 'image/jpeg'],
    [Buffer.from('GIF87a'), 'image/gif'],
    [Buffer.from('GIF89a'), 'image/gif'],
    [Buffer.from('RIFF1234WEBP'), 'image/webp'],
    [bmp, 'image/bmp'],
  ]) assert.equal(panelImage.sniffPanelImage(buf), mime);
  for (const size of [40, 56, 108, 124]) {
    bmp.writeUInt32LE(size, 14);
    assert.equal(panelImage.sniffPanelImage(bmp), 'image/bmp');
  }
});

test('T1: non-images and truncated signatures are refused', () => {
  assert.equal(typeof panelImage.sniffPanelImage, 'function');
  const bmp = Buffer.alloc(26);
  bmp.write('BM');
  bmp.writeUInt32LE(40, 14);
  bmp[6] = 1;
  for (const buf of [Buffer.from([3, 7, 42]), Buffer.from('RIFF1234WAVE'), Buffer.from('<svg/>'),
    Buffer.from('BM this is text only'), Buffer.alloc(0), Buffer.from([0, 0, 1, 0]), bmp,
    Buffer.from('89504e47', 'hex'), Buffer.from('ffd8', 'hex'), Buffer.from('GIF89'), Buffer.from('RIFF1234WEB')]) {
    assert.equal(panelImage.sniffPanelImage(buf), null, buf.toString('hex'));
  }
});

function shellHandlers(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const calls = { open: [], show: [], order: [] };
  const handlers = new Map();
  const absolute = path.resolve('fixture.png');
  const context = {
    path, SYSTEM_VIEWER_EXTENSIONS: panelImage.SYSTEM_VIEWER_EXTENSIONS,
    fs: {
      realpathSync: { native: p => { calls.order.push('realpath'); return p; } },
      statSync: () => { calls.order.push('stat'); return { isFile: () => true }; },
      ...overrides.fs,
    },
    gitChangesFile: require('../src/main/changes/git-changes-file'),
    isSensitivePath: p => { calls.order.push('sensitive'); return overrides.sensitive?.(p) || false; },
    shell: { openPath: p => calls.open.push(p), showItemInFolder: p => calls.show.push(p) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  };
  for (const name of ['open-path', 'show-item-in-folder']) {
    const start = source.indexOf("ipcMain.handle('" + name + "'");
    if (start === -1) continue;
    const end = source.indexOf('\n});', start) + '\n});'.length;
    vm.runInNewContext(source.slice(start, end), context, { filename: 'main.js' });
  }
  return { calls, absolute, open: (...args) => handlers.get('open-path')?.(null, ...args),
    show: (...args) => handlers.get('show-item-in-folder')?.(null, ...args) };
}

test('T8b: main enforces the system-viewer allowlist and keeps the terminal route', async () => {
  const api = shellHandlers();
  for (const ext of ['.exe', '.pif', '.url']) await api.open(path.resolve('tool' + ext), { viewer: true });
  assert.equal(api.calls.open.length, 0);
  await api.open(api.absolute, { viewer: true });
  assert.deepEqual(api.calls.open, [api.absolute]);
  await api.open(path.resolve('tool.exe'));
  assert.equal(api.calls.open.length, 2);
});

for (const kind of ['relative', 'raw git', 'real git', 'sensitive', 'directory', 'regular']) {
  test('T8c: show in folder guards ' + kind, async () => {
    const api = shellHandlers({
      sensitive: () => kind === 'sensitive',
      fs: {
        realpathSync: { native: p => {
          api.calls.order.push('realpath');
          return kind === 'real git' ? path.resolve('.git/config') : p;
        } },
        statSync: () => {
          api.calls.order.push('stat');
          return { isFile: () => kind !== 'directory' };
        },
      },
    });
    const target = kind === 'relative' ? 'file.txt' : kind === 'raw git' ? path.resolve('.git/config') : api.absolute;
    await api.show(target);
    assert.deepEqual(api.calls.show, kind === 'regular' ? [target] : []);
    const order = { relative: [], 'raw git': [], 'real git': ['realpath'], sensitive: ['realpath', 'sensitive'],
      directory: ['realpath', 'sensitive', 'stat'], regular: ['realpath', 'sensitive', 'stat'] };
    assert.deepEqual(api.calls.order, order[kind]);
  });
}

test('T8d: renderer and main system-viewer extensions match', () => {
  assert.ok(Array.isArray(panelImage.SYSTEM_VIEWER_EXTENSIONS));
  const renderer = path.join(__dirname, '../public/touched-files-view.js');
  assert.ok(fs.existsSync(renderer));
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(renderer, 'utf8'), context, { filename: renderer });
  const extensions = vm.runInContext('SYSTEM_VIEWER_EXTENSIONS', context);
  assert.deepEqual(Array.from(extensions), panelImage.SYSTEM_VIEWER_EXTENSIONS);
});
