'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('CANARY: live CLI main-turn stop reasons and duration records retain the consumed closure contract', async t => {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let folders;
  try { folders = await fs.readdir(projects); } catch {
    t.skip('no readable Claude projects directory; live head-turn closure format is unverified');
    return;
  }
  const candidates = [];
  for (const folder of folders) {
    const dir = path.join(projects, folder);
    let names;
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const name of names.filter(n => /^[0-9a-f-]{36}\.jsonl$/i.test(n))) {
      const file = path.join(dir, name);
      try { candidates.push({ file, at: (await fs.stat(file)).mtimeMs }); } catch {}
    }
  }
  const files = candidates.sort((a, b) => b.at - a.at).slice(0, 50);
  let closures = 0;
  for (const { file } of files) {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const stat = await handle.stat();
      const length = Math.min(stat.size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
      let assistant;
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || entry.isSidechain) continue;
        if (entry.type === 'user') assistant = null;
        if (entry.type === 'assistant') assistant = entry;
        if (entry.type !== 'system' || entry.subtype !== 'turn_duration' || !assistant?.message?.stop_reason) continue;
        const version = entry.version || assistant.version || 'unknown CLI version';
        assert.ok(['end_turn', 'stop_sequence'].includes(assistant.message.stop_reason),
          `${version}: main assistant before turn_duration has changed stop_reason ${assistant.message.stop_reason}`);
        assert.equal(typeof assistant.timestamp, 'string', `${version}: assistant timestamp must remain a string`);
        assert.ok(Number.isFinite(Date.parse(assistant.timestamp)), `${version}: assistant timestamp must remain parseable`);
        closures++;
      }
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }
  if (!closures) t.skip('no suitable live stop_reason plus turn_duration pair in the newest 50 transcript tails; closure format is unverified');
  else t.diagnostic(JSON.stringify({ sampledTranscripts: files.length, closures }));
});
