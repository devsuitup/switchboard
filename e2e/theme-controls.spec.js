'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect, makeRepo, openPlainTerminal } = require('./fixtures');

const FILE_COUNT = 80;

function makeTouchedFixture(home, env) {
  const content = Array.from({ length: 240 }, (_, i) => `Line ${i + 1}: ${'content '.repeat(24)}`).join('\n') + '\n';
  const files = Object.fromEntries(Array.from({ length: FILE_COUNT }, (_, i) => [
    `file-${String(i).padStart(3, '0')}.txt`, content,
  ]));
  files['older.txt'] = content;
  const repo = makeRepo(home, env, files);
  const folder = path.join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
  const transcript = path.join(folder, fs.readdirSync(folder).find(name => name.endsWith('.jsonl')));
  const now = Date.now();
  const records = fs.readFileSync(transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const record of records) record.timestamp = new Date(now - 3 * 86400000).toISOString();
  const template = records.at(-1);
  const touch = (name, timestamp, index) => ({
    ...template, uuid: `touch-${index}`, parentUuid: records[0].uuid,
    timestamp: new Date(timestamp).toISOString(),
    message: { ...template.message, content: [{
      type: 'tool_use', id: `write-${index}`, name: 'Write', input: { file_path: path.join(repo, name) },
    }] },
  });
  records.push(touch('older.txt', now - 2 * 86400000, FILE_COUNT));
  for (let i = 0; i < FILE_COUNT; i++) {
    records.push(touch(`file-${String(i).padStart(3, '0')}.txt`, now - 60000 + i, i));
  }
  fs.writeFileSync(transcript, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return template.sessionId;
}

test('the themed file panel shows a long Touched list and scrollable file contents', async ({ home, env, launch }, testInfo) => {
  const sessionId = makeTouchedFixture(home, env);
  const { page } = await launch();
  await openPlainTerminal(page);
  await expect(page.locator('#terminal-header')).toBeVisible();
  await expect(page.locator('.session-item.active')).toHaveCount(1);
  await page.evaluate(id => { window.setActiveSession(id); }, sessionId);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('activeSessionId'))).toBe(sessionId);
  await page.locator('#touched-toggle-btn').click();
  const panel = page.locator('#file-panel');
  const list = page.locator('#touched-list');
  await expect(panel).toBeVisible();
  await expect(list.locator('.touched-file-row')).toHaveCount(FILE_COUNT);
  await expect(page.locator('#touched-more-btn')).toBeVisible();
  await expect.poll(() => list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect.poll(() => list.evaluate(el => ({
    standardWidth: getComputedStyle(el).scrollbarWidth,
    standardColor: getComputedStyle(el).scrollbarColor,
    webkitWidth: getComputedStyle(el, '::-webkit-scrollbar').width,
  }))).toEqual({ standardWidth: 'auto', standardColor: 'auto', webkitWidth: '5px' });
  await page.locator('#touched-sort').selectOption('path');
  await panel.screenshot({ path: testInfo.outputPath('touched-list.png') });
  await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await panel.screenshot({ path: testInfo.outputPath('touched-list-older-control.png') });
  await list.evaluate(el => { el.scrollTop = 0; });
  await expect(list.locator('.touched-openable')).toHaveCount(FILE_COUNT);
  await list.locator('.touched-openable').first().click();
  const scroller = page.locator('#changes-diff-host .cm-scroller');
  await expect(scroller).toBeVisible();
  const back = page.locator('#file-panel-back-btn');
  await expect(back).toBeVisible();
  await expect(back).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(back).toHaveCSS('padding', '3px 10px');
  await expect(back).toHaveCSS('border-radius', '5px');
  await expect.poll(() => scroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect.poll(() => scroller.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await panel.screenshot({ path: testInfo.outputPath('opened-file.png') });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('activeSessionId'))).toBe(sessionId);
  await back.click();
  await expect(list.locator('.touched-file-row')).toHaveCount(FILE_COUNT);
  await expect(back).toBeHidden();
});
