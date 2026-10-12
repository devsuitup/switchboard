const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ESLint } = require('eslint');

for (const name of ['confirm', 'alert', 'prompt']) {
  for (const prefix of ['', 'window.']) {
    test('renderer lint rejects ' + prefix + name, async () => {
      const lint = new ESLint({ cwd: path.join(__dirname, '..') });
      const [result] = await lint.lintText(prefix + name + '("native");', { filePath: 'public/dialog-ban-fixture.js' });
      assert.equal(result.errorCount, 1);
      assert.match(result.messages[0].message, /public\/app-dialogs\.js/);
      assert.equal(result.messages[0].ruleId, prefix ? 'no-restricted-properties' : 'no-restricted-globals');
    });
  }
}
