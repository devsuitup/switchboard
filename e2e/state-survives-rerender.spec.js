// see docs/e2e.md
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { test, expect, makeRepo } = require('./fixtures');

test('a transcript-driven row state survives a sidebar re-render', async ({ home, env, launch }) => {
  const repo = makeRepo(home, env, { 'readme.txt': 'fixture\n' });
  const folder = path.join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
  const file = path.join(folder, fs.readdirSync(folder).find(f => f.endsWith('.jsonl')));
  const sid = path.basename(file, '.jsonl');
  const bin = path.join(home, 'fixture-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'),
    process.platform === 'win32' ? '@echo off\r\necho Fixture CLI\r\n' : '#!/bin/sh\necho Fixture CLI\n', { mode: 0o755 });
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = bin + path.delimiter + env[pathKey];
  const owner = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  try {
    await once(owner, 'spawn');
    const descriptors = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(descriptors, { recursive: true });
    const descriptor = path.join(descriptors, `${owner.pid}.json`);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: owner.pid, sessionId: sid, cwd: repo, status: 'idle', statusUpdatedAt: Date.now() }));
    const { page } = await launch();
    const row = page.locator(`#sidebar .session-item[data-session-id="${sid}"]`);
    const icon = row.locator('.session-icon');
    const archiveToggle = page.locator('#archive-toggle');
    await expect(icon).toHaveClass(/session-icon--waiting/);
    await expect(row).toHaveClass(/is-alive/);

    fs.appendFileSync(file, JSON.stringify({
      type: 'user', sessionId: sid, cwd: repo, timestamp: new Date(Date.now() + 1).toISOString(),
      uuid: 'a2', parentUuid: 'a1',
      message: { role: 'user', content: 'A genuine later prompt' },
    }) + '\n');

    await expect(icon).toHaveClass(/session-icon--busy/);
    await expect(icon).toHaveAttribute('title', 'Working
CLI status: idle');
    await archiveToggle.click();
    await expect(archiveToggle).toHaveClass(/active/);
    await expect(icon).toHaveClass(/session-icon--busy/, { timeout: 3000 });
    await expect(row).toHaveClass(/cli-busy/);
    await archiveToggle.click();
    await expect(archiveToggle).not.toHaveClass(/active/);
    await expect(icon).toHaveClass(/session-icon--busy/, { timeout: 3000 });

    fs.appendFileSync(file, [
      { type: 'assistant', sessionId: sid, cwd: repo, timestamp: new Date().toISOString(),
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } },
      { type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString() },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await expect(icon).toHaveClass(/session-icon--response-ready/);
    await row.locator('.session-time').click();
    await page.getByRole('button', { name: 'Resume anyway', exact: true }).click();

    await expect(icon).toHaveClass(/session-icon--waiting/, { timeout: 40000 });
    await expect(icon).toHaveAttribute('title', 'Waiting for input
CLI status: idle');
    await archiveToggle.click();
    await expect(archiveToggle).toHaveClass(/active/);
    await expect(icon).toHaveClass(/session-icon--waiting/, { timeout: 3000 });
    await archiveToggle.click();
    await expect(archiveToggle).not.toHaveClass(/active/);
    await expect(icon).toHaveClass(/session-icon--waiting/, { timeout: 3000 });
    await expect(row).not.toHaveClass(/cli-busy|response-ready|needs-attention/);
    const exited = once(owner, 'exit');
    owner.stdin.end();
    await exited;
    fs.unlinkSync(descriptor);
    await page.locator('#search-refresh-btn').click();
    await expect(row).not.toHaveClass(/is-alive|cli-busy/);
    await expect(icon).toHaveClass(/session-icon--idle/);
    await expect(icon).toHaveAttribute('title', 'Idle');
    await archiveToggle.click();
    await expect(icon).toHaveClass(/session-icon--idle/);
    await expect(row).not.toHaveClass(/is-alive/);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill();
  }
});
