const { test, expect, makeRepo } = require('./fixtures');

test('background Delete is a designed confirmation: Escape cancels and Delete proceeds', async ({ home, env, launch }) => {
  makeRepo(home, env, { 'dialog.txt': 'fixture\n' });
  const { app, page } = await launch();
  const native = [];
  page.on('dialog', dialog => { native.push(dialog.type()); dialog.dismiss(); });
  await app.evaluate(({ ipcMain }) => {
    globalThis.dialogDeletes = [];
    ipcMain.removeHandler('get-bg-agents');
    ipcMain.handle('get-bg-agents', () => ({ daemonReachable: true, roster: [
      { id: 'aaaaaaaa', sessionId: 'dialog-session', name: 'Dialog fixture', cwd: '/fixture', kind: 'background', state: 'done', attachedHere: false },
    ] }));
    ipcMain.removeHandler('check-bg-agent-verb');
    ipcMain.handle('check-bg-agent-verb', () => ({ ok: true }));
    ipcMain.removeHandler('bg-agent-verb');
    ipcMain.handle('bg-agent-verb', (_event, verb, id) => {
      globalThis.dialogDeletes.push([verb, id]);
      return { ok: true };
    });
  });
  await page.locator('#agents-toggle-btn').click();
  await page.locator('.agents-row[data-key="bg:aaaaaaaa"]').click();
  const opener = page.locator('#agents-detail [data-verb="rm"]');
  await app.evaluate(({ app: electronApp }) => {
    const load = process.mainModule.require;
    return load(load('path').join(electronApp.getAppPath(), 'bg-agents.js')).reconcile();
  });
  await expect(opener).toBeVisible();
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('.choice-dialog-overlay');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.choice-dialog-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await app.evaluate(() => globalThis.dialogDeletes)).toEqual([]);
  await opener.click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.dialogDeletes)).toEqual([['rm', 'aaaaaaaa']]);
  expect(native).toEqual([]);
});
