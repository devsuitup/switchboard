'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const hashes = ['4432f59e494f84aa61d2023af7a3455e1e476eb913869c8ec51e2fefbebf75e7', 'fa7685454d5e4dc3fdac9c90908eae8ae0cbcb3344bec39573850a5788db1221', 'd2395a41213ee87e034310cb1d3c5cd28d476e98f1057d85b34aee2ebbac3eff', 'c7050c07b3ca19b7306c9d67ab44de00d013547077a32a906cf7809a9d20a8da'];
const fixtures = ['f1332a9c', '89b38a59', 'd35270f9', '14957f88'].map(sha => fs.readFileSync(path.join(__dirname, 'fixtures/schedule-creator', sha + '.md')));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-template-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const filename = path.join(__dirname, '../src/main/schedules/schedule-ipc.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console,
    require: name => name === 'electron' ? { ipcMain: { handle() {} } } : name === 'os' ? { ...os, homedir: () => home } : realRequire(name),
  }, { filename });
  const file = path.join(home, '.claude/commands/create-switchboard-schedule.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { api: module.exports, file };
}
test('every historical hash is pinned and a missing template is installed with discoverable Schedules wording', t => {
  const h = setup(t);
  assert.deepEqual(fixtures.map(hash), hashes);
  assert.ok(h.api.SHIPPED_CREATOR_TEMPLATE_SHA256, 'the shipped hash inventory is exported');
  for (const value of hashes) assert.ok(h.api.SHIPPED_CREATOR_TEMPLATE_SHA256.includes(value), value);
  h.api.ensureScheduleCreatorCommand();
  const bytes = fs.readFileSync(h.file);
  assert.match(bytes.toString(), /Schedules tab \(Global Settings → Schedules tab\)/);
  assert.doesNotMatch(bytes.toString(), /brain tab/);
  const before = fs.statSync(h.file).mtimeMs;
  h.api.ensureScheduleCreatorCommand();
  assert.equal(fs.statSync(h.file).mtimeMs, before);
});
for (const [index, bytes] of fixtures.entries()) test(`replaces historical template ${hashes[index]}`, t => {
  const h = setup(t);
  fs.writeFileSync(h.file, bytes);
  h.api.ensureScheduleCreatorCommand();
  assert.match(fs.readFileSync(h.file, 'utf8'), /Schedules tab \(Global Settings → Schedules tab\)/);
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)), ['create-switchboard-schedule.md']);
});
for (const [name, bytes] of [['one byte', Buffer.concat([fixtures[3], Buffer.from('x')])], ['whitespace', Buffer.concat([fixtures[3], Buffer.from(' ')])], ['BOM', Buffer.concat([Buffer.from([239, 187, 191]), fixtures[3]])], ['CRLF', Buffer.from(fixtures[3].toString().replace(/\n/g, '\r\n'))]]) test(`preserves customized bytes: ${name}`, t => {
  const h = setup(t);
  fs.writeFileSync(h.file, bytes);
  h.api.ensureScheduleCreatorCommand();
  assert.deepEqual(fs.readFileSync(h.file), bytes);
});
