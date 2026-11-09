'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');

function createLock({ fs = require('node:fs'), net = require('node:net'), uid = process.getuid?.(), env = process.env } = {}) {
  function safeRuntime(dir) {
    try { const stat = fs.lstatSync(dir); return path.isAbsolute(dir) && !stat.isSymbolicLink() && stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0; } catch { return false; }
  }
  function connect(socket) {
    return new Promise(resolve => {
      const client = net.createConnection(socket);
      const finish = code => { client.destroy(); resolve(code); };
      client.once('connect', () => finish('live'));
      client.once('error', error => finish(error.code));
      client.setTimeout(300, () => finish('ETIMEDOUT'));
    });
  }
  async function acquire(dataDir, managed) {
    const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 24);
    const socket = env.XDG_RUNTIME_DIR && safeRuntime(env.XDG_RUNTIME_DIR)
      ? path.join(env.XDG_RUNTIME_DIR, `sb-browser-${hash}.sock`) : path.join(managed, 'owner.sock');
    if (Buffer.byteLength(socket) > 100) throw new Error('Managed browser management unavailable: owner socket path too long');
    for (let attempt = 0; attempt < 2; attempt++) {
      const server = net.createServer(client => client.end());
      const error = await new Promise(resolve => {
        server.once('error', resolve);
        server.listen(socket, () => resolve(null));
      });
      if (!error) {
        let ours;
        try { fs.chmodSync(socket, 0o600); ours = fs.lstatSync(socket); }
        catch (setupError) { await new Promise(resolve => server.close(resolve)); throw setupError; }
        server.unref();
        return { role: 'owner', release: () => new Promise((resolve, reject) => {
          let current;
          try { current = fs.lstatSync(socket); } catch (e) { if (e.code !== 'ENOENT') { reject(e); return; } }
          if (current && (current.dev !== ours.dev || current.ino !== ours.ino)) { reject(new Error('Owner socket identity changed; retaining lock')); return; }
          server.close(resolve);
        }) };
      }
      if (error.code !== 'EADDRINUSE') throw new Error(`Managed browser management unavailable: ${error.message}`);
      const before = fs.lstatSync(socket);
      if (!before.isSocket() || before.isSymbolicLink() || (uid !== undefined && before.uid !== uid)) throw new Error('Unsafe owner socket');
      const result = await connect(socket);
      if (result === 'live') return { role: 'follower' };
      if (result !== 'ECONNREFUSED' || attempt !== 0) throw new Error('Managed browser lock ownership is uncertain');
      const current = fs.lstatSync(socket);
      if (current.ino !== before.ino || current.dev !== before.dev || !current.isSocket()) throw new Error('Owner socket changed during stale recovery');
      fs.unlinkSync(socket);
    }
    throw new Error('Managed browser lock recovery exhausted');
  }
  return { acquire };
}

module.exports = { createLock };
