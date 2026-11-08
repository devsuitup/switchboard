'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupDom, flush, rows, openLink } = require('./touched-panel-harness');

test('fix1025: Refresh clears an earlier open refusal and its action', async () => {
  const ctx = setupDom({ readImpl: () => ({ ok: false, reason: 'binary', error: 'binary file' }) });
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/a.bin');
    assert.ok(ctx.document.querySelector('.panel-file-refusal'));
    ctx.document.getElementById('touched-refresh-btn').click();
    await flush();
    assert.equal(ctx.document.querySelector('.panel-file-refusal'), null, 'Refresh must remove the stale refusal');
  } finally { ctx.destroy(); }
});

test('fix1025: a detached old image error cannot refuse its replacement', async () => {
  const ctx = setupDom({ readImpl: () => imageResult() });
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/shot.png');
    const old = ctx.document.querySelector('img.panel-image');
    ctx.changed('/work/shot.png');
    await flush();
    const current = ctx.document.querySelector('img.panel-image');
    assert.notEqual(old, current);
    assert.equal(old.isConnected, false);
    old.dispatchEvent(new ctx.window.Event('error'));
    assert.equal(ctx.document.querySelector('img.panel-image'), current, 'the replacement must remain visible');
    assert.equal(ctx.document.querySelector('.panel-file-refusal'), null);
  } finally { ctx.destroy(); }
});

for (const [action, target, answer] of [
  ['showItemInFolder', '/work/a.bin', { ok: false, reason: 'missing' }],
  ['showItemInFolder', '/work/a.bin', undefined],
  ['openPath', '/work/doc.pdf', 'No associated app'],
  ['openPath', '/work/doc.pdf', undefined],
  ['showItemInFolder', '/work/a.bin', new Error('IPC failed')],
  ['openPath', '/work/doc.pdf', new Error('IPC failed')],
]) {
  test(`fix1025: ${action} failure is visible (${String(answer?.reason || answer)})`, async () => {
    const ctx = setupDom({ readImpl: () => ({ ok: false, reason: 'binary', error: 'binary file' }) });
    ctx.window.api[action] = async () => { if (answer instanceof Error) throw answer; return answer; };
    try {
      ctx.window.switchPanel('s1');
      await openLink(ctx, target);
      ctx.document.querySelector('.panel-file-refusal button').click();
      await flush();
      const error = ctx.document.querySelector('.panel-file-refusal .changes-error');
      assert.ok(error, 'the failed system action must show an error');
      assert.match(error.textContent, /Could not/);
    } finally { ctx.destroy(); }
  });
}

for (const [action, target, answer] of [
  ['showItemInFolder', '/work/a.bin', { ok: true }], ['openPath', '/work/doc.pdf', ''],
]) {
  test(`fix1025: successful ${action} clears a prior action error`, async () => {
    const ctx = setupDom({ readImpl: () => ({ ok: false, reason: 'binary', error: 'binary file' }) });
    let fail = true;
    ctx.window.api[action] = async () => { if (fail) throw new Error('IPC failed'); return answer; };
    try {
      ctx.window.switchPanel('s1');
      await openLink(ctx, target);
      const button = ctx.document.querySelector('.panel-file-refusal button');
      button.click(); await flush();
      assert.ok(ctx.document.querySelector('.panel-file-refusal .changes-error'), 'the first failure must be visible');
      fail = false;
      button.click(); await flush();
      assert.equal(ctx.document.querySelector('.panel-file-refusal .changes-error'), null);
    } finally { ctx.destroy(); }
  });
}

function imageResult(base64 = 'cG5n') {
  return { ok: true, image: { mime: 'image/png', base64, size: 3 } };
}

test('T6: a linked image opens as data in an image tab with an Opened row', async () => {
  const ctx = setupDom({ readImpl: (_p, opts) => opts?.image ? imageResult() : { ok: false, reason: 'binary', error: 'binary file' } });
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/shot.png');
    const imgs = ctx.document.querySelectorAll('img.panel-image');
    assert.equal(imgs.length, 1);
    assert.match(imgs[0].src, /^data:image\/png;base64,/);
    assert.equal(imgs[0].alt, 'shot.png');
    assert.equal(ctx.document.querySelector('.cm-editor'), null);
    assert.ok(rows(ctx).some(r => r.dataset.path === '/work/shot.png'));
    assert.equal(ctx.stateOf('s1').currentTab.editable, false);
    for (const id of ['changes-diff-format-btn', 'changes-diff-mode-btn', 'changes-diff-save-btn', 'changes-diff-reload-btn']) {
      assert.equal(ctx.document.getElementById(id)?.style.display, 'none', id);
    }
    imgs[0].click();
    assert.ok(imgs[0].classList.contains('panel-image-actual'));
    imgs[0].click();
    assert.equal(imgs[0].classList.contains('panel-image-actual'), false);
    assert.deepEqual(ctx.watchCalls, [['watch', '/work/shot.png']]);
  } finally { ctx.destroy(); }
});

test('T7: a refused PDF offers the system viewer with its flag', async () => {
  const ctx = setupDom({ readImpl: () => ({ ok: false, reason: 'binary', error: 'binary file' }) });
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/doc.pdf');
    const refusal = ctx.document.querySelector('.panel-file-refusal');
    assert.ok(refusal);
    assert.equal(refusal.firstChild.textContent, "This file can't be shown here.");
    const button = refusal.querySelector('button');
    assert.equal(button.textContent, 'Open with system viewer');
    button.click();
    assert.equal(JSON.stringify(ctx.calls.openPath), JSON.stringify([['/work/doc.pdf', { viewer: true }]]));
    assert.equal(ctx.calls.showItem.length, 0);
  } finally { ctx.destroy(); }
});

test('T8: non-viewer files only offer Show in folder', async () => {
  for (const target of ['/work/tool.exe', '/work/x.pif', '/work/site.url', '/work/a.bin', '/work/no-extension', '/work/.pdf']) {
    const ctx = setupDom({ readImpl: () => ({ ok: false, reason: 'binary', error: 'binary file' }) });
    try {
      ctx.window.switchPanel('s1');
      await openLink(ctx, target);
      const button = ctx.document.querySelector('.panel-file-refusal button');
      assert.ok(button, target);
      assert.equal(button.textContent, 'Show in folder', target);
      button.click();
      assert.deepEqual(ctx.calls.showItem, [[target]]);
      assert.equal(ctx.calls.openPath.length, 0);
    } finally { ctx.destroy(); }
  }
});

test('T9: file-changed rereads an image with the image flag and replaces its source', async () => {
  let bytes = 'b2xk';
  const ctx = setupDom({ readImpl: (_p, opts) => opts?.image ? imageResult(bytes) : { ok: false, reason: 'binary', error: 'binary file' } });
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/shot.png');
    const before = ctx.document.querySelector('img.panel-image');
    assert.ok(before);
    bytes = 'bmV3';
    ctx.changed('/work/shot.png');
    await flush();
    assert.equal(ctx.calls.readFile.length, 2);
    assert.equal(ctx.calls.readOptions.at(-1).image, true);
    assert.equal(ctx.document.querySelector('img.panel-image')?.src, 'data:image/png;base64,bmV3');
  } finally { ctx.destroy(); }
});

test('T10: image decode failure shows the refusal and system action', async () => {
  const ctx = setupDom({ readImpl: () => imageResult() });
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/shot.png');
    const img = ctx.document.querySelector('img.panel-image');
    assert.ok(img);
    img.dispatchEvent(new ctx.window.Event('error'));
    assert.equal(ctx.document.querySelector('img.panel-image'), null);
    const refusal = ctx.document.querySelector('#changes-diff-host .panel-file-refusal');
    assert.ok(refusal);
    assert.equal(refusal.firstChild.textContent, "This file can't be shown here.");
    assert.equal(refusal.querySelector('button').textContent, 'Open with system viewer');
  } finally { ctx.destroy(); }
});
