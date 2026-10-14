'use strict';

const test = require('node:test');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { scanTaskFiles } = require('./helpers/cli-task-canary');

test('CANARY: live CLI task launch and terminal notification envelopes still match the consumed schema', async t => {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let folders;
  try { folders = await fsp.readdir(projects); } catch { t.skip('no readable Claude projects directory; no live task record to validate'); return; }
  const candidates = [];
  for (const folder of folders) {
    const dir = path.join(projects, folder);
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const name of names.filter(n => /^[0-9a-f-]{36}\.jsonl$/i.test(n))) {
      const file = path.join(dir, name);
      try { candidates.push({ file, at: (await fsp.stat(file)).mtimeMs }); } catch {}
    }
  }
  const files = candidates.sort((a, b) => b.at - a.at || a.file.localeCompare(b.file)).slice(0, 200).map(c => c.file);
  const counts = await scanTaskFiles(files, '2.1.29x transcript contract (CLI not launched)');
  if (!counts.launches && !counts.notifications) t.skip('no suitable live Agent launch or terminal task notification found in the newest 200 transcripts');
  else t.diagnostic(JSON.stringify({ sampledTranscripts: files.length, ...counts }));
});
