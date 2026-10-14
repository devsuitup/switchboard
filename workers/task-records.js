'use strict';

const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { createTaskRegistry } = require('../public/task-registry');
const { createTaskTranscriptReader } = require('../task-transcript-reader');

const registry = createTaskRegistry({ onRekey: (oldId, newId) => parentPort.postMessage({ rekey: { oldId, newId } }) });
const reader = createTaskTranscriptReader({ registry });
let queue = Promise.resolve();
parentPort.on('message', message => {
  queue = queue.then(async () => {
    const { type, parentSessionId } = message;
    if (type === 'read') await reader.read(message.file, parentSessionId);
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
    else if (type === 'job') registry.applyJob(parentSessionId, message.evidence);
    else if (type === 'death') registry.ownerDied(parentSessionId);
    else if (type === 'alive') registry.ownerAlive(parentSessionId);
    else if (type === 'rekey') registry.rekey(message.oldId, message.newId);
    if (parentSessionId) parentPort.postMessage({ snapshot: registry.snapshot(registry.resolve(parentSessionId)) });
    if (type === 'rekey') parentPort.postMessage({ snapshot: registry.snapshot(registry.resolve(message.newId)) });
    if (message.requestId) parentPort.postMessage({ requestId: message.requestId });
  }).catch(error => parentPort.postMessage({ error: error.message, requestId: message.requestId }));
});
