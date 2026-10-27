'use strict';

const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { createTaskRegistry } = require('../public/task-registry');
const { createTaskTranscriptReader } = require('../task-transcript-reader');
const { createTranscriptTurnReader } = require('../transcript-turn');

const registry = createTaskRegistry({ onRekey: (oldId, newId, continued) => parentPort.postMessage({ rekey: { oldId, newId, continued } }) });
const reader = createTaskTranscriptReader({ registry });
const turnReader = createTranscriptTurnReader();
const turns = new Map();
let turnRevision = 0;
let queue = Promise.resolve();
async function readHead(message) {
  const { file, parentSessionId, turnOnly } = message;
  if (!turnOnly) await reader.read(file, parentSessionId);
  const turn = turnReader.read(file);
  turns.set(parentSessionId, { sessionId: parentSessionId, state: turn?.state || 'unknown',
    lastEntryAt: turn?.lastEntryAt ?? null, mtimeMs: turn?.mtimeMs ?? null,
    writtenOutput: turn?.writtenOutput ?? turns.get(parentSessionId)?.writtenOutput ?? '', revision: ++turnRevision });
  while (turns.size > 2048) turns.delete(turns.keys().next().value);
}
parentPort.on('message', message => {
  queue = queue.then(async () => {
    const { type, parentSessionId } = message;
    if (type === 'read') {
      await readHead(message);
    }
    else if (type === 'readBatch') {
      for (const row of message.rows) {
        await readHead(row);
        const id = registry.resolve(row.parentSessionId);
        parentPort.postMessage({ snapshot: { ...registry.snapshot(id), headTurn: turns.get(id) } });
      }
    }
    else if (type === 'child') {
      try {
        const file = message.file.replace(/\.jsonl$/, '.meta.json');
        const stat = await fs.stat(file);
        if (stat.size <= 65536) {
          const meta = JSON.parse(await fs.readFile(file, 'utf8'));
          if (typeof meta.toolUseId === 'string' && /^toolu_\w+$/.test(meta.toolUseId)) {
            registry.note(parentSessionId, message.agentId, 'cli-task', meta);
          }
        }
      } catch {}
    }
    else if (type === 'job') registry.applyJob(parentSessionId, message.evidence, { jobId: message.jobId });
    else if (type === 'death') registry.ownerDied(parentSessionId);
    else if (type === 'alive') registry.ownerAlive(parentSessionId, { startedAt: message.startedAt });
    else if (type === 'rekey') {
      registry.rekey(message.oldId, message.newId, { continued: message.continued });
      const turn = turns.get(message.oldId);
      if (message.continued && turn) {
        const target = turns.get(message.newId);
        if (!target || turn.revision > target.revision) turns.set(message.newId, { ...turn, sessionId: message.newId });
        turns.delete(message.oldId);
      }
    }
    if (parentSessionId) {
      const id = registry.resolve(parentSessionId);
      parentPort.postMessage({ snapshot: { ...registry.snapshot(id), headTurn: turns.get(id) } });
    }
    if (type === 'rekey') parentPort.postMessage({ snapshot: { ...registry.snapshot(registry.resolve(message.newId)), headTurn: turns.get(message.newId) } });
    if (message.requestId) parentPort.postMessage({ requestId: message.requestId });
  }).catch(error => parentPort.postMessage({ error: error.message, requestId: message.requestId }));
});
