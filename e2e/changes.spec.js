// see docs/e2e.md
'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect, makeRepo, openPlainTerminal, box } = require('./fixtures');

const TRACKED = {
  'alpha.txt': 'one\ntwo\nthree\n',
  'beta.txt': 'red\ngreen\n',
};

function count(text) {
  const m = /\d+/.exec(text);
  if (!m) throw new Error(`no number in ${JSON.stringify(text)}`);
  return Number(m[0]);
}

async function rowCounts(row) {
  return {
    added: count(await row.locator('.changes-added').textContent()),
    deleted: count(await row.locator('.changes-deleted').textContent()),
  };
}

async function openChanges(page) {
  await page.locator('#changes-toggle-btn').click();
  await expect(page.locator('#file-panel')).toBeVisible();
}

test('a changed tracked file is listed with its counts, and the header total matches', async ({ home, env, launch }) => {
  const repo = makeRepo(home, env, TRACKED);
  fs.appendFileSync(path.join(repo, 'alpha.txt'), 'four\nfive\n');
  fs.writeFileSync(path.join(repo, 'beta.txt'), 'red\nblue\n');

  const { page } = await launch();
  await openPlainTerminal(page);
  await openChanges(page);

  const alpha = page.locator('.changes-file-row[data-path="alpha.txt"]');
  const beta = page.locator('.changes-file-row[data-path="beta.txt"]');
  await expect(alpha.locator('.changes-added')).toBeVisible();
  await expect(beta.locator('.changes-added')).toBeVisible();
  expect(await rowCounts(alpha)).toEqual({ added: 2, deleted: 0 });
  expect(await rowCounts(beta)).toEqual({ added: 1, deleted: 1 });

  const summary = await page.locator('#changes-summary').textContent();
  expect(summary).toMatch(/\+3\b/);
  expect(summary).toMatch(/[−-]1\b/);
});

test('clicking an untracked file opens it and its line count appears', async ({ home, env, launch }) => {
  const repo = makeRepo(home, env, TRACKED);
  fs.writeFileSync(path.join(repo, 'fresh.txt'), 'a\nb\nc\nd\n');

  const { page } = await launch();
  await openPlainTerminal(page);
  await openChanges(page);

  const row = page.locator('.changes-file-row[data-path="fresh.txt"]');
  await row.click();
  await expect(page.locator('#changes-diff-host .cm-editor').first()).toBeVisible();
  await expect(row).toHaveClass(/\bselected\b/);
  await expect(row.locator('.changes-added')).toBeVisible();
  expect(await rowCounts(row)).toEqual({ added: 4, deleted: 0 });
});

test('an edit saved in the panel editor reaches disk, and the file stays changed', async ({ home, env, launch }) => {
  const repo = makeRepo(home, env, TRACKED);
  const target = path.join(repo, 'alpha.txt');
  fs.appendFileSync(target, 'four\n');

  const { page } = await launch();
  await openPlainTerminal(page);
  await openChanges(page);

  const row = page.locator('.changes-file-row[data-path="alpha.txt"]');
  await row.click();
  const host = page.locator('#changes-diff-host');
  const editors = host.locator('.cm-editor');
  await expect(editors.first()).toBeVisible();
  expect(await rowCounts(row)).toEqual({ added: 1, deleted: 0 });

  const hostBox = await box(host);
  for (const editor of await editors.all()) {
    expect((await box(editor)).width).toBeGreaterThan(hostBox.width * 0.8);
  }

  const content = host.locator('.cm-content').last();
  await content.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('edited-in-panel');
  const save = page.locator('#changes-diff-save-btn');
  await expect(save).toBeEnabled();
  await save.click();

  await expect.poll(() => fs.readFileSync(target, 'utf8')).toContain('edited-in-panel');
  await expect(save).toBeDisabled();
  await expect.poll(() => rowCounts(row)).toEqual({ added: 2, deleted: 0 });
});

test('a Touched modified file shows the shared diff below its list and Close restores the full list', async ({ home, env, launch }) => {
  const repo = makeRepo(home, env, TRACKED);
  const target = path.join(repo, 'alpha.txt');
  fs.appendFileSync(target, 'four\n');
  const projects = path.join(home, '.claude', 'projects');
  const folder = path.join(projects, fs.readdirSync(projects)[0]);
  const transcript = path.join(folder, fs.readdirSync(folder).find(name => name.endsWith('.jsonl')));
  const header = JSON.parse(fs.readFileSync(transcript, 'utf8').split('\n')[0]);
  fs.appendFileSync(transcript, JSON.stringify({
    type: 'assistant', sessionId: header.sessionId, cwd: repo, timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'touch-fixture', name: 'Edit', input: { file_path: target } }] },
  }) + '\n');

  const { page } = await launch();
  await page.locator('[data-session-id="' + header.sessionId + '"]').first().waitFor();
  await page.evaluate(({ sessionId, projectPath }) => window.openSession({ sessionId, projectPath, name: 'Touched fixture' }, { type: 'terminal' }),
    { sessionId: header.sessionId, projectPath: repo });
  await expect(page.locator('#terminals .xterm-screen').first()).toBeVisible();
  await page.locator('#tool-bar #touched-toggle-btn').click();
  const list = page.locator('#touched-list');
  const row = list.locator('.touched-openable').filter({ hasText: 'alpha.txt' });
  await expect(row).toHaveCount(1);
  await row.click();
  const diff = page.locator('#changes-diff-view');
  await expect(diff).toBeVisible();
  await expect(diff.locator('.cm-editor')).toHaveCount(1);
  await expect(diff.locator('.cm-changedLine').first()).toBeVisible();
  await expect(diff.locator('#changes-diff-save-btn')).toBeVisible();
  const hostBox = await box(page.locator('#changes-diff-host'));
  expect((await box(diff.locator('.cm-editor'))).width).toBeGreaterThan(hostBox.width * 0.8);
  await expect(list).toBeVisible();
  await expect(page.locator('#file-panel-back-btn')).toBeHidden();
  expect((await box(list)).y + (await box(list)).height).toBeLessThanOrEqual((await box(diff)).y);
  await page.locator('#changes-diff-close-btn').click();
  await expect(list).toBeVisible();
  await expect(row).toHaveClass(/\bselected\b/);
  await expect(diff).toBeHidden();
});

test('a clicked markdown file opens formatted in Touched as an opened row, and its preview scrolls inside the panel', async ({ home, env, launch }) => {
  const paragraphs = Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
  const repo = makeRepo(home, env, { 'README.md': `# Title\n\n${paragraphs}\n` });
  const readme = path.join(repo, 'README.md');

  const { page } = await launch();
  await openPlainTerminal(page);
  const id = await page.evaluate(() => activeSessionId);
  expect(id).toBeTruthy();
  await page.evaluate(([sessionId, filePath]) => window.openFileInPanel(sessionId, filePath), [id, readme]);

  const list = page.locator('#touched-list');
  await expect(list.locator('.touched-opened')).toHaveCount(1);
  const preview = page.locator('#changes-diff-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('h1')).toHaveCount(1);
  const previewBox = await box(preview);
  const contentBox = await box(page.locator('#file-panel-content'));
  expect(previewBox.y + previewBox.height).toBeLessThanOrEqual(contentBox.y + contentBox.height + 1);
  expect(await preview.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  const listBox = await box(list);
  expect(listBox.y + listBox.height).toBeLessThanOrEqual(previewBox.y);

  await page.locator('#changes-diff-format-btn').click();
  await expect(page.locator('#changes-diff-host .cm-editor')).toBeVisible();
  await expect(preview).toBeHidden();
});
