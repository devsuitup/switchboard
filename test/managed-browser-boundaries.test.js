'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createBrowser } = require('./fixtures/fake-chromium');
const transport = require('../src/main/browser/transport');
const { createLock } = require('../src/main/browser/owner-lock');

test('loopback HTTP has a total deadline even when the server keeps sending small chunks', async t => {
  const http = require('node:http');
  let timer;
  const server = http.createServer((_req, res) => {
    const parts = ['{', '"Browser"', ':', '"Fake"', '}'];
    res.write(parts.shift());
    timer = setInterval(() => { const part = parts.shift(); if (parts.length) res.write(part); else { clearInterval(timer); res.end(part); } }, 150);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { clearInterval(timer); return new Promise(resolve => server.close(resolve)); });
  await assert.rejects(transport.request(server.address().port, '/json/version'), /timed out/);
});

test('fake browser exercises bounded loopback version, activation and real Browser.close exchange', async t => {
  const previous = global.WebSocket; global.WebSocket = undefined;
  t.after(() => { global.WebSocket = previous; });
  const browser = await createBrowser(); t.after(() => browser.close());
  const version = await transport.request(browser.port, '/json/version');
  assert.equal(version.Browser, 'FakeChromium/1');
  assert.equal((await transport.request(browser.port, '/json/list'))[0].id, 'page');
  await transport.request(browser.port, '/json/activate/page');
  await assert.doesNotReject(() => transport.closeBrowser({ port: browser.port }, version));
  await assert.rejects(transport.request(browser.port, '/json/version'));
});

test('close transport rejects foreign/wildcard WebSocket endpoints before connecting', async () => {
  for (const url of ['ws://0.0.0.0:41000/x', 'ws://127.0.0.1:41001/x', 'ws://example.invalid:41000/x']) {
    await assert.rejects(transport.closeBrowser({ port: 41000 }, { webSocketDebuggerUrl: url }), /owned loopback/);
  }
});

function fakeSocket({ stale = false, change = false } = {}) {
  let inode = 1, listening = false, unlinked = 0, attempts = 0;
  let exists = stale;
  const stat = () => ({ isSocket: () => true, isSymbolicLink: () => false, uid: 1, ino: inode, dev: 1 });
  const fs = { lstatSync: stat, chmodSync() {}, unlinkSync() { exists = false; unlinked++; } };
  const net = { createServer: () => {
    const server = new EventEmitter(); server.unref = () => {};
    server.listen = (_path, fn) => {
      attempts++;
      queueMicrotask(() => { if (exists) server.emit('error', { code: 'EADDRINUSE' }); else { exists = true; listening = true; fn(); } });
    };
    server.close = fn => { listening = false; exists = false; fn(); };
    return server;
  }, createConnection: () => {
    const client = new EventEmitter(); client.destroy = () => {}; client.setTimeout = () => {};
    queueMicrotask(() => { if (change) inode++; if (listening) client.emit('connect'); else client.emit('error', { code: 'ECONNREFUSED' }); });
    return client;
  } };
  return { fs, net, env: {}, uid: 1, stats: () => ({ unlinked, attempts }) };
}

test('owner socket distinguishes follower, takeover, bounded stale recovery and identity change', async () => {
  const f = fakeSocket(); const lock = createLock(f);
  const owner = await lock.acquire('/data', '/data/managed-browser');
  assert.equal(owner.role, 'owner');
  assert.equal((await lock.acquire('/data', '/data/managed-browser')).role, 'follower');
  await owner.release();
  const next = await lock.acquire('/data', '/data/managed-browser'); assert.equal(next.role, 'owner'); await next.release();
  const stale = fakeSocket({ stale: true });
  const recovered = await createLock(stale).acquire('/data', '/data/managed-browser');
  assert.equal(recovered.role, 'owner'); assert.deepEqual(stale.stats(), { unlinked: 1, attempts: 2 }); await recovered.release();
  const changed = fakeSocket({ stale: true, change: true });
  await assert.rejects(createLock(changed).acquire('/data', '/data/managed-browser'), /changed/);
  assert.equal(changed.stats().unlinked, 0);
});

test('an overlong socket path refuses management without trying a listener', async () => {
  const f = fakeSocket();
  await assert.rejects(createLock(f).acquire('/data', '/data/' + 'x'.repeat(150)), /too long/);
  assert.equal(f.stats().attempts, 0);
});

test('socket permission failure closes the newly acquired listener', async () => {
  const f = fakeSocket(); let closed = 0;
  const create = f.net.createServer;
  f.net.createServer = () => { const server = create(); const close = server.close;
    server.close = done => { closed++; close(done); }; return server; };
  f.fs.chmodSync = () => { throw new Error('chmod refused'); };
  await assert.rejects(createLock(f).acquire('/data', '/data/managed-browser'), /chmod refused/);
  assert.equal(closed, 1);
});

test('Snap intermediary symlinks cannot be hidden by a non-Snap real target', () => {
  const { discoverBrowser } = require('../src/main/browser/discovery');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-discovery-'));
  try {
    const binary = path.join(root, 'chrome'); fs.writeFileSync(binary, '\x7fELF', { mode: 0o755 });
    const snapPath = path.join(root, 'snap', 'launcher');
    const fake = { ...fs, lstatSync: file => file === binary ? { isSymbolicLink: () => true } : fs.lstatSync(file),
      readlinkSync: file => file === binary ? snapPath : fs.readlinkSync(file), realpathSync: () => binary,
    };
    assert.throws(() => discoverBrowser({ binaryPath: binary, fs: fake }), /Snap/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
