'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTaskRegistry } = require('../public/task-registry');
const { createTaskTranscriptReader } = require('../task-transcript-reader');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');

for (const timing of ['between reads', 'during a chunk read']) {
  test(`given colliding Number file ids and equal birth times, replacement ${timing} replays completion from offset zero`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-task-identity-650-'));
    t.after(async () => {
      assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
      await fs.rm(root, { recursive: true, force: true });
    });
    const file = path.join(root, 'parent.jsonl');
    const parent = fixture.parentSessionId;
    const originalId = 2n ** 53n;
    const replacementId = originalId + 1n;
    assert.notEqual(originalId, replacementId);
    assert.equal(Number(originalId), Number(replacementId));
    const before = [fixture.use, fixture.launch].map(e => JSON.stringify(e) + '\n').join('') + '\n'.repeat(256);
    const completion = JSON.stringify(fixture.notification) + '\n';
    assert.ok(Buffer.byteLength(before) - Buffer.byteLength(completion) >= 128);
    const after = completion + '\n'.repeat(Buffer.byteLength(before) - Buffer.byteLength(completion));
    await fs.writeFile(file, before);
    const birth = await fs.stat(file, { bigint: true });
    let currentId = originalId;
    let rotateOnRead = timing === 'during a chunk read';
    const positions = [];
    const replace = async () => {
      await fs.rename(file, file + '.old');
      await fs.writeFile(file, after);
      currentId = replacementId;
    };
    const stamp = (stat, inode, options) => Object.assign(stat, {
      ino: options?.bigint ? inode : Number(inode),
      birthtimeMs: options?.bigint ? birth.birthtimeMs : Number(birth.birthtimeMs),
      birthtimeNs: options?.bigint ? birth.birthtimeNs : undefined,
    });
    const files = {
      async open(name, flags) {
        const handle = await fs.open(name, flags);
        const openedId = currentId;
        return {
          stat: async options => stamp(await handle.stat(options), openedId, options),
          async read(...args) {
            positions.push(args[3]);
            const result = await handle.read(...args);
            if (rotateOnRead) {
              rotateOnRead = false;
              await replace();
            }
            return result;
          },
          close: () => handle.close(),
        };
      },
      stat: async (name, options) => stamp(await fs.stat(name, options), currentId, options),
    };
    const registry = createTaskRegistry();
    const reader = createTaskTranscriptReader({ registry, files });
    t.after(() => reader.dispose());
    if (timing === 'between reads') {
      await reader.read(file, parent);
      assert.equal(registry.agents(parent).length, 1);
      positions.length = 0;
      await replace();
    } else {
      registry.ingest(parent, fixture.use);
      registry.ingest(parent, fixture.launch);
    }

    await reader.read(file, parent);

    assert.equal(registry.agents(parent).length, 0, 'the replacement completion must close the running agent');
    assert.equal(positions.filter(position => position === 0).length, timing === 'between reads' ? 1 : 2,
      'each distinct file must be read from offset zero');
    assert.equal(reader.cursorCount(), 1);
    assert.doesNotThrow(() => JSON.stringify(registry.snapshot(parent)));
  });
}
