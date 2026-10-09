'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
test('CANARY live: bounded CLI transcript sampling retains the continued-in field names', { timeout: 9000 }, async t => {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let files = [];
  try {
    const folders = fs.readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory()).slice(0, 32);
    for (const folder of folders) {
      const dir = path.join(projects, folder.name);
      files.push(...fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).slice(0, 4).map(name => path.join(dir, name)));
    }
  } catch { t.skip('CLI transcript directory unavailable; observed-format fixture still runs'); return; }
  const deadline = Date.now() + 3000;
  let budget = 8 * 1024 * 1024, checked = 0;
  for (const file of files) {
    if (budget <= 0 || Date.now() >= deadline) break;
    let pending = '';
    const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024, encoding: 'utf8' });
    try {
      for await (const chunk of stream) {
        budget -= Buffer.byteLength(chunk);
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          if (!line.includes('continued-in')) continue;
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry.type !== 'continued-in') continue;
          assert.equal(typeof entry.sessionId, 'string', 'CLI continued-in must carry sessionId');
          assert.equal(typeof entry.continuedInSessionId, 'string', 'CLI continued-in must carry continuedInSessionId');
          assert.equal(typeof entry.timestamp, 'string', 'CLI continued-in must carry timestamp');
          checked++;
        }
        if (pending.length > 1024 * 1024) pending = '';
        if (checked || budget <= 0 || Date.now() >= deadline) break;
      }
    } catch (err) {
      if (err.code === 'ERR_ASSERTION') throw err;
    } finally { stream.destroy(); }
    if (checked) break;
  }
  if (!checked) t.skip('no continued-in record within 8 MiB / 3 s bounded sample; CLI drift not measured');
});
