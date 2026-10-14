'use strict';

const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const { assertLaunch, assertNotification, assertChildMeta } = require('./helpers/cli-task-format');

test('CANARY: live CLI task launch and terminal notification envelopes still match the consumed schema', async t => {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let folders;
  try { folders = await fsp.readdir(projects); } catch { t.skip('no readable Claude projects directory; no live task record to validate'); return; }
  let launches = 0;
  let notifications = 0;
  let metadata = 0;
  let version = 'unknown (version command unavailable)';
  try { version = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim(); } catch {}
  for (const folder of folders.slice(0, 40)) {
    let names;
    try { names = await fsp.readdir(path.join(projects, folder)); } catch { continue; }
    for (const name of names.filter(n => /^[0-9a-f-]{36}\.jsonl$/i.test(n)).slice(-20)) {
      const stream = fs.createReadStream(path.join(projects, folder, name));
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let e;
          try { e = JSON.parse(line); } catch { continue; }
          if (e.toolUseResult?.isAsync === true && e.toolUseResult?.agentId) { assertLaunch(e, version); launches++; }
          if (e.type === 'user' && typeof e.message?.content === 'string' && e.message.content.trim().startsWith('<task-notification>')) {
            assertNotification(e, version);
            notifications++;
          }
          if (metadata < 5) {
        const subdir = path.join(projects, folder, name.slice(0, -6), 'subagents');
        try {
          const names = await fsp.readdir(subdir);
          for (const name of names.filter(n => n.endsWith('.meta.json')).slice(-5)) {
            const raw = JSON.parse(await fsp.readFile(path.join(subdir, name), 'utf8'));
            assertChildMeta(raw, version);
            metadata++;
          }
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
      }
      if (launches >= 5 && notifications >= 5) break;
        }
      } finally { lines.close(); stream.destroy(); }
      if (launches >= 5 && notifications >= 5) break;
    }
    if (launches >= 5 && notifications >= 5) break;
  }
  if (!launches && !notifications) t.skip('no suitable live Agent launch or task notification found in the bounded read-only sample');
  else t.diagnostic(`Validated ${launches} launch acknowledgements and ${notifications} terminal notifications and ${metadata} child metadata records; observed ${version}.`);
});
