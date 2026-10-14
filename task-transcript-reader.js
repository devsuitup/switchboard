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
          const stat = await handle.stat();
          let c = cursors.get(file);
          let boundaryChanged = false;
          if (c?.boundary.length && (stat.mtimeMs !== c.mtimeMs || stat.size !== c.offset)) {
            const boundary = Buffer.alloc(c.boundary.length);
            const read = await handle.read(boundary, 0, boundary.length, c.offset - boundary.length);
            boundaryChanged = read.bytesRead !== boundary.length || !boundary.equals(c.boundary);
          }
          if (!c || c.dev !== stat.dev || c.ino !== stat.ino || c.birthtimeMs !== stat.birthtimeMs || stat.size < c.offset || boundaryChanged) {
            c = { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, offset: 0, pending: '', decoder: new StringDecoder('utf8'), mtimeMs: stat.mtimeMs, boundary: Buffer.alloc(0) };
            cursors.set(file, c);
          }
          while (!disposed && c.offset < stat.size) {
            const buffer = Buffer.alloc(Math.min(chunkBytes, stat.size - c.offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, c.offset);
            if (!bytesRead) break;
            const current = await files.stat(file);
            if (current.dev !== c.dev || current.ino !== c.ino || current.birthtimeMs !== c.birthtimeMs || current.size < stat.size) {
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
            c.mtimeMs = stat.mtimeMs;
            await yieldRead();
          }
          c.mtimeMs = stat.mtimeMs;
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
