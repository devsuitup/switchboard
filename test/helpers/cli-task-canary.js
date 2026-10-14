'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { assertLaunch, assertNotification, assertChildMeta } = require('./cli-task-format');

async function scanTaskFiles(files, version) {
  const counts = { launches: 0, notifications: 0, metadata: 0, completedNoTool: 0, failedNoTool: 0, aggregates: 0, aggregateIds: 0 };
  for (const file of files) {
    const stream = fs.createReadStream(file);
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.toolUseResult?.isAsync === true && e.toolUseResult?.agentId) { assertLaunch(e, version); counts.launches++; }
        if (e.type === 'user' && typeof e.message?.content === 'string' &&
            e.message.content.trim().startsWith('<task-notification>') && /<status>/.test(e.message.content)) {
          const parsed = assertNotification(e, version);
          if (parsed.ids) { counts.aggregates++; counts.aggregateIds += parsed.ids.length; continue; }
          counts.notifications++;
          if (!e.message.content.includes('<tool-use-id>')) {
            if (e.message.content.includes('<status>completed</status>')) counts.completedNoTool++;
            if (e.message.content.includes('<status>failed</status>')) counts.failedNoTool++;
          }
        }
      }
    } finally {
      const closed = stream.closed ? Promise.resolve() : new Promise(resolve => stream.once('close', resolve));
      lines.close();
      stream.destroy();
      await closed;
    }
    const subdir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
    let names;
    try { names = await fsp.readdir(subdir); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') continue;
      throw error;
    }
    for (const name of names.filter(n => n.endsWith('.meta.json')).slice(-5)) {
      assertChildMeta(JSON.parse(await fsp.readFile(path.join(subdir, name), 'utf8')), version);
      counts.metadata++;
    }
  }
  return counts;
}

module.exports = { scanTaskFiles };
