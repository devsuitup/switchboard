'use strict';

const { test, expect, makePlainDir } = require('./fixtures');

for (const size of [{ width: 1400, height: 900 }, { width: 900, height: 700 }]) {
  test(`New agent rows contain their controls and align their columns at ${size.width}x${size.height}`, async ({ home, launch }) => {
    makePlainDir(home);
    const { app, page } = await launch();
    await app.evaluate(({ BrowserWindow, ipcMain }, dimensions) => {
      ipcMain.removeHandler('get-bg-agents');
      ipcMain.handle('get-bg-agents', () => ({ roster: [], daemonReachable: true }));
      BrowserWindow.getAllWindows()[0].setContentSize(dimensions.width, dimensions.height);
    }, size);
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(size);
    await page.locator('#agents-toggle-btn').click();
    await page.locator('#agents-new-btn').click();
    const dialog = page.locator('.dispatch-agent-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.settings-field')).toHaveCount(6);

    const geometry = await dialog.evaluate(el => {
      const rect = node => {
        const b = node.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
      };
      return {
        rows: [...el.querySelectorAll('.settings-field')].map(row => ({
          row: rect(row),
          label: rect(row.querySelector('.settings-label')),
          info: rect(row.querySelector('.settings-field-info') || row.querySelector('.settings-label')),
          controls: [...row.querySelectorAll('input, select, textarea, .permission-grid')].map(rect),
        })),
        columns: ['dad-project', 'dad-name', 'dad-agent'].map(id => rect(el.querySelector(`#${id}`))),
      };
    });
    for (const [index, { row, label, controls }] of geometry.rows.entries()) {
      expect(controls.length, `row ${index} has a control`).toBeGreaterThan(0);
      for (const control of controls) {
        expect(control.width, `row ${index} control has width`).toBeGreaterThan(0);
        expect(control.height, `row ${index} control has height`).toBeGreaterThan(0);
        expect(control.left, `row ${index} left edge`).toBeGreaterThanOrEqual(row.left);
        expect(control.right, `row ${index} right edge`).toBeLessThanOrEqual(row.right);
        expect(control.top, `row ${index} top edge`).toBeGreaterThanOrEqual(row.top);
        expect(control.bottom, `row ${index} separator`).toBeLessThanOrEqual(row.bottom - 1);
        if (index + 1 < geometry.rows.length) {
          const next = geometry.rows[index + 1];
          expect(control.bottom, `row ${index} does not overlap next row`).toBeLessThanOrEqual(next.row.top);
          expect(control.bottom, `row ${index} does not overlap next label or description`).toBeLessThanOrEqual(next.info.top);
        }
        if (control.height > 50) expect(label.top, `row ${index} label aligns to tall control`).toBeLessThanOrEqual(control.top + 1);
      }
    }
    const [project, ...others] = geometry.columns;
    for (const control of others) {
      expect(Math.abs(control.left - project.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(control.right - project.right)).toBeLessThanOrEqual(1);
    }
    await dialog.locator('.new-session-cancel-btn').click();
    await expect(dialog).toHaveCount(0);
  });
}
