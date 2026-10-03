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
