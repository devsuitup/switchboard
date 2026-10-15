'use strict';

const fs = require('node:fs/promises');
const { StringDecoder } = require('node:string_decoder');
const { setImmediate: yieldRead } = require('node:timers/promises');

function createTaskTranscriptReader({ registry, files = fs, chunkBytes = 64 * 1024 } = {}) {
  const cursors = new Map();
  const pending = new Map();
  let disposed = false;
  async function read(file, parentSessionId) {
    const running = pending.get(file);
    if (running) { running.dirty = true; return running.promise; }
    const work = { dirty: false };
    work.promise = (async () => {
      do {
        work.dirty = false;
        let handle;
        try {
          handle = await files.open(file, 'r');
          const stat = await handle.stat({ bigint: true });
          const size = Number(stat.size);
          let c = cursors.get(file);
          let boundaryChanged = false;
          if (c?.boundary.length && (stat.mtimeNs !== c.mtimeNs || stat.size !== BigInt(c.offset))) {
            const boundary = Buffer.alloc(c.boundary.length);
            const read = await handle.read(boundary, 0, boundary.length, c.offset - boundary.length);
            boundaryChanged = read.bytesRead !== boundary.length || !boundary.equals(c.boundary);
          }
          if (!c || c.dev !== stat.dev || c.ino !== stat.ino || c.birthtimeNs !== stat.birthtimeNs || stat.size < BigInt(c.offset) || boundaryChanged) {
            c = { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs, offset: 0, pending: '', decoder: new StringDecoder('utf8'), mtimeNs: stat.mtimeNs, boundary: Buffer.alloc(0) };
            cursors.set(file, c);
          }
          while (!disposed && c.offset < size) {
            const buffer = Buffer.alloc(Math.min(chunkBytes, size - c.offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, c.offset);
            if (!bytesRead) break;
            const current = await files.stat(file, { bigint: true });
            if (current.dev !== c.dev || current.ino !== c.ino || current.birthtimeNs !== c.birthtimeNs || current.size < stat.size) {
              cursors.delete(file);
              work.dirty = true;
              break;
            }
            c.offset += bytesRead;
            c.boundary = Buffer.from(Buffer.concat([c.boundary, buffer.subarray(0, bytesRead)]).subarray(-128));
            const lines = (c.pending + c.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
            c.pending = lines.pop();
            for (const line of lines) {
              if (disposed) break;
              let entry;
              try { entry = JSON.parse(line); } catch { continue; }
              registry.ingest(parentSessionId, entry);
            }
            c.mtimeNs = stat.mtimeNs;
            await yieldRead();
          }
          c.mtimeNs = stat.mtimeNs;
        } catch {}
        finally { if (handle) await handle.close().catch(() => {}); }
      } while (!disposed && work.dirty);
    })().finally(() => pending.delete(file));
    pending.set(file, work);
    return work.promise;
  }
  return { read, dispose() { disposed = true; cursors.clear(); }, cursorCount: () => cursors.size };
}

module.exports = { createTaskTranscriptReader };
