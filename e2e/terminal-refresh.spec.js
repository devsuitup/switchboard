'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect, makeRepo, openPlainTerminal, box } = require('./fixtures');

test('Refresh next to Stop redraws a running plain terminal and restores its fitted size', async ({ home, env, launch }) => {
  const repo = makeRepo(home, env, { 'readme.txt': 'fixture\n' });
  const probe = path.join(repo, 'resize-probe.cjs');
  fs.writeFileSync(probe, `
const fs = require('node:fs');
const path = require('node:path');
let count = 0;
function record() {
  fs.writeFileSync(path.join(__dirname, 'size.json'), JSON.stringify({ count, cols: process.stdout.columns, rows: process.stdout.rows }));
  process.stdout.write('\\x1b[2J\\x1b[Hrefresh fixture ' + count + '\\r\\n');
}
process.stdout.on('resize', () => { count++; record(); });
record();
process.stdin.resume();
`);
  const { app, page } = await launch();
  await openPlainTerminal(page);
  await page.evaluate((command) => window.api.sendInput(activeSessionId, command + '\r'), `node "${probe}"`);
  const sizeFile = path.join(repo, 'size.json');
  await expect.poll(() => fs.existsSync(sizeFile)).toBe(true);
  const before = JSON.parse(fs.readFileSync(sizeFile, 'utf8'));
  await app.evaluate(({ ipcMain }) => {
    global.refreshRequests = [];
    ipcMain.on('terminal-resize', (_event, id, cols, rows, refresh) => {
      if (refresh) global.refreshRequests.push({ id, cols, rows });
    });
  });
  const refresh = page.locator('#terminal-refresh-btn');
  const stop = page.locator('#terminal-stop-btn');
  await expect(refresh).toBeVisible();
  await expect(stop).toBeVisible();
  const r = await box(refresh);
  const s = await box(stop);
  expect(r.x + r.width).toBeLessThanOrEqual(s.x);
  expect(Math.abs(r.y + r.height / 2 - s.y - s.height / 2)).toBeLessThan(2);
  await refresh.click();
  const fitted = await page.evaluate(() => {
    const entry = openSessions.get(activeSessionId);
    return { cols: entry.terminal.cols, rows: entry.terminal.rows };
  });
  await expect.poll(() => {
    try {
      const size = JSON.parse(fs.readFileSync(sizeFile, 'utf8'));
      return size.count > before.count && size.cols === fitted.cols && size.rows === fitted.rows;
    } catch { return false; }
  }).toBe(true);
  const requests = await app.evaluate(() => global.refreshRequests);
  expect(requests).toHaveLength(1);
  expect({ cols: requests[0].cols, rows: requests[0].rows }).toEqual(fitted);
});
