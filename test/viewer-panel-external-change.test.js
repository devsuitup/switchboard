'use strict';

// What a ViewerPanel does with its buffer when the file it shows changes on
// disk: a clean buffer is reloaded, a dirty one is kept and the notice says
// so. The CodeMirror bundle is replaced by an editor stub whose document is a
// plain string, since the behaviour under test is the panel's, not the editor's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const FILE = '/home/u/.claude/projects/p/memory/note.md';

function fakeEditor() {
  let doc = '';
  const view = {
    dispatches: 0,
    state: { doc: { toString: () => doc, get length() { return doc.length; } } },
    dispatch(tr) {
      if (tr && tr.changes) {
        const { from, to, insert } = tr.changes;
        doc = doc.slice(0, from) + insert + doc.slice(to);
        view.dispatches += 1;
      }
    },
    type(text) { doc += text; },
    destroy() {},
  };
  return view;
}

// What main does: write only over the content the save says it agreed to replace.
function mainSave(state, content, expected) {
  const onDisk = state.disk === null ? null : state.disk.replace(/\r\n?/g, '\n');
  if (onDisk === null) return { ok: false, error: 'file does not exist' };
  if (typeof expected !== 'string') return { ok: false, reason: 'invalid-expected', error: 'missing expected content' };
  if (onDisk !== expected) return { ok: false, reason: 'stale', error: 'this file changed on disk since it was opened', disk: onDisk };
  state.disk = content;
  return { ok: true };
}

function setup({ disk }) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="c"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const state = { disk, fileChanged: null, confirms: [], confirmAnswer: true, saves: [], saveImpl: null, readImpl: null, watchImpl: null, watchCalls: [], unwatchCalls: [] };

  window.api = {
    onFileChanged: (cb) => { state.fileChanged = cb; },
    watchFile: (p) => { state.watchCalls.push(p); return Promise.resolve(state.watchImpl ? state.watchImpl(p) : { ok: true }); },
    unwatchFile: (p) => { state.unwatchCalls.push(p); return Promise.resolve({ ok: true }); },
    readFileForPanel: async (p) => (state.readImpl ? state.readImpl(p) : state.disk === null
      ? { ok: false, error: 'ENOENT: no such file or directory', code: 'ENOENT' }
      : { ok: true, content: state.disk }),
  };
  window.confirm = (msg) => { state.confirms.push(msg); return state.confirmAnswer; };

  const realCreate = window.document.createElement.bind(window.document);
  window.document.createElement = function (tag, ...args) {
    const el = realCreate(tag, ...args);
    if (tag.toLowerCase() === 'script') Promise.resolve().then(() => el.onload && el.onload());
    return el;
  };

  let editor = null;
  window.createPlanEditor = () => { editor = fakeEditor(); return editor; };

  const ctx = dom.getInternalVMContext();
  for (const f of ['viewer-toolbar.js', 'viewer-panel.js']) {
    const file = path.join(PUBLIC_DIR, f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }

  const container = window.document.getElementById('c');
  const panel = new window.ViewerPanel(container, {
    onSave: async (filePath, content, expected) => {
      state.saves.push({ filePath, content, expected });
      if (state.saveImpl) return state.saveImpl(filePath, content, expected);
      return mainSave(state, content, expected);
    },
  });

  return {
    window,
    state,
    panel,
    editor: () => editor,
    notice: () => container.querySelector('.viewer-panel-notice'),
    async open(content, file = FILE) {
      panel.open('note', file, content);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
    async externalWrite(content) {
      state.disk = content;
      state.fileChanged(FILE);
      await new Promise((r) => setTimeout(r, 0));
    },
    destroy: () => window.close(),
  };
}

function visible(el) {
  return !!el && el.style.display !== 'none';
}

test('a clean buffer reloads quietly on an external write', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    await t.externalWrite('two\n');
    assert.equal(t.panel.getContent(), 'two\n');
    assert.equal(visible(t.notice()), false, 'no notice for a clean buffer');
  } finally { t.destroy(); }
});

test('a dirty buffer survives an external write, and the notice says the file changed', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('my edit');
    await t.externalWrite('two\n');
    assert.equal(t.panel.getContent(), 'one\nmy edit', 'the edits must not be replaced');
    assert.equal(visible(t.notice()), true);
    assert.match(t.notice().querySelector('.viewer-panel-notice-text').textContent, /changed on disk/);
    assert.equal(visible(t.notice().querySelector('.viewer-panel-notice-reload')), true);
    assert.equal(visible(t.notice().querySelector('.viewer-panel-notice-keep')), true);
  } finally { t.destroy(); }
});

test('Keep my edits hides the notice and leaves the buffer as it is', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.externalWrite('two\n');
    t.notice().querySelector('.viewer-panel-notice-keep').click();
    assert.equal(visible(t.notice()), false);
    assert.equal(t.panel.getContent(), 'one\nmine');

    await t.externalWrite('three\n');
    assert.equal(t.panel.getContent(), 'one\nmine', 'a kept buffer is still dirty against the disk');
    assert.equal(visible(t.notice()), true);
  } finally { t.destroy(); }
});

test('Reload asks, then replaces the buffer with the file on disk', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.externalWrite('two\n');

    t.state.confirmAnswer = false;
    t.notice().querySelector('.viewer-panel-notice-reload').click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(t.state.confirms, ['This file has unsaved edits. Discard them?']);
    assert.equal(t.panel.getContent(), 'one\nmine', 'a refused confirm keeps the edits');

    t.state.confirmAnswer = true;
    t.notice().querySelector('.viewer-panel-notice-reload').click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(t.panel.getContent(), 'two\n');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

test('a deleted file keeps a dirty buffer and says the file is gone; a recreate is seen', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.externalWrite(null);
    assert.equal(t.panel.getContent(), 'one\nmine');
    assert.equal(visible(t.notice()), true);
    assert.match(t.notice().querySelector('.viewer-panel-notice-text').textContent, /no longer exists on disk\. Your unsaved edits are kept/);

    await t.externalWrite('recreated\n');
    assert.equal(t.panel.getContent(), 'one\nmine');
    assert.match(t.notice().querySelector('.viewer-panel-notice-text').textContent, /changed on disk/);
  } finally { t.destroy(); }
});

test('a deleted then recreated file reloads a clean buffer', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    await t.externalWrite(null);
    assert.equal(t.panel.getContent(), 'one\n', 'a clean buffer is not emptied by a delete');
    assert.match(t.notice().querySelector('.viewer-panel-notice-text').textContent, /no longer exists on disk\.$/);

    await t.externalWrite('back\n');
    assert.equal(t.panel.getContent(), 'back\n');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

test('a saved buffer is clean again, so the next external write reloads it', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.panel._save();
    t.state.disk = 'one\nmine';
    await t.externalWrite('two\n');
    assert.equal(t.panel.getContent(), 'two\n');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

test('a CRLF file is not dirty just because the editor holds it with LF', async () => {
  const t = setup({ disk: 'a\r\nb\r\n' });
  try {
    await t.open('a\r\nb\r\n');
    t.editor().dispatch({ changes: { from: 0, to: t.editor().state.doc.length, insert: 'a\nb\n' } });
    await t.externalWrite('a\r\nc\r\n');
    assert.equal(t.panel.getContent(), 'a\nc\n');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const noticeText = (t) => t.notice().querySelector('.viewer-panel-notice-text').textContent;
const button = (t, name) => t.notice().querySelector(`.viewer-panel-notice-${name}`);

test('an external write that lands just after our save is reloaded, not dropped', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.panel._save();
    await t.externalWrite('written by the session\n');
    assert.equal(t.panel.getContent(), 'written by the session\n');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

test("our own save's echo, arriving while the save is in flight, raises no notice", async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    let finish;
    t.state.saveImpl = (fp, content) => new Promise((resolve) => { t.state.disk = content; finish = () => resolve({ ok: true }); });
    const saving = t.panel._save();
    t.editor().type(' and more');
    t.state.fileChanged(FILE);
    await tick();
    assert.equal(visible(t.notice()), false, 'the echo of our own write is not an external change');
    finish();
    await saving;
    assert.equal(t.panel.getContent(), 'one\nmine and more');
  } finally { t.destroy(); }
});

test('a save sends the disk baseline, so main can refuse a stale write', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.panel._save();
    assert.deepEqual(t.state.saves.map((x) => x.expected), ['one\n']);
  } finally { t.destroy(); }
});


test('a failed save says so in the notice', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    t.state.saveImpl = () => ({ ok: false, error: 'file does not exist' });
    await t.panel._save();
    assert.equal(visible(t.notice()), true);
    assert.equal(noticeText(t), 'Save failed: file does not exist');
  } finally { t.destroy(); }
});

test('a touch or a same-content write on a dirty buffer raises no notice', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.externalWrite('one\n');
    assert.equal(visible(t.notice()), false);
    assert.equal(t.panel.getContent(), 'one\nmine');
  } finally { t.destroy(); }
});

test('a re-read of the previous file that resolves after another open leaves the new buffer alone', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    let resolveA;
    t.state.readImpl = () => new Promise((resolve) => { resolveA = resolve; });
    t.state.fileChanged(FILE);
    await tick();
    const other = '/home/u/.claude/projects/p/memory/other.md';
    await t.open('other file\n', other);
    resolveA({ ok: true, content: 'A changed on disk\n' });
    await tick();
    assert.equal(t.panel.getContent(), 'other file\n');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

test('the watch event that follows a stale refusal leaves the "not saved" notice and its Overwrite in place', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    t.state.disk = 'unseen external write\n';
    t.state.saveImpl = (fp, content, expected) => (expected === t.state.disk
      ? { ok: true }
      : { ok: false, reason: 'stale', error: 'this file changed on disk since it was opened' });
    await t.panel._save();
    t.state.fileChanged(FILE);
    await tick();
    assert.match(noticeText(t), /your edits were not saved/);
    assert.equal(visible(button(t, 'overwrite')), true);
    assert.equal(t.panel.getContent(), 'one\nmine');
  } finally { t.destroy(); }
});

test('an unchanged re-read that resolves during a save does not keep the saved buffer dirty', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    let resolveRead;
    t.state.readImpl = () => new Promise((resolve) => { resolveRead = resolve; });
    t.state.fileChanged(FILE);
    await tick();
    t.editor().type('mine');
    let finishSave;
    t.state.saveImpl = (fp, content) => new Promise((resolve) => { finishSave = () => { t.state.disk = content; resolve({ ok: true }); }; });
    const saving = t.panel._save();
    resolveRead({ ok: true, content: 'one\n' });
    await tick();
    finishSave();
    await saving;
    assert.equal(t.panel._isDirty(), false, 'a successful save leaves the buffer clean');

    t.state.readImpl = null;
    t.state.saveImpl = null;
    t.editor().type('!');
    await t.panel._save();
    assert.equal(t.state.saves[1].expected, 'one\nmine', 'the next save is checked against what was saved');
  } finally { t.destroy(); }
});

test('a second save while the first is in flight is queued, then sent against the first one\'s content', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('A');
    let finishFirst;
    t.state.saveImpl = (fp, content) => new Promise((resolve) => { finishFirst = () => { t.state.disk = content; resolve({ ok: true }); }; });
    const first = t.panel._save();
    t.editor().type('B');
    t.panel._save();
    await tick();
    assert.equal(t.state.saves.length, 1, 'the second save waits for the first');

    t.state.saveImpl = null;
    finishFirst();
    await first;
    await tick();
    assert.equal(t.state.saves.length, 2, 'the queued save is sent once the first returns');
    assert.equal(t.state.saves[1].content, 'one\nAB');
    assert.equal(t.state.saves[1].expected, 'one\nA', 'not the baseline from before the first save');
    assert.equal(visible(t.notice()), false, 'no false "not saved"');
    assert.equal(t.panel._isDirty(), false);
  } finally { t.destroy(); }
});

test('a rejected save shows the failure in the notice', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    t.state.saveImpl = () => Promise.reject(new Error('the channel is gone'));
    await t.panel._save();
    assert.equal(noticeText(t), 'Save failed: the channel is gone');
  } finally { t.destroy(); }
});

test('a watch that failed is not released on close, so it cannot drop another panel\'s reference', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    t.state.watchImpl = () => ({ ok: false, error: 'could not watch this file' });
    await t.open('one\n');
    t.panel.destroy();
    assert.deepEqual(t.state.unwatchCalls, []);
  } finally { t.destroy(); }
});

test('a watch acknowledged after the panel moved on is released, not leaked', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    let ackFirst;
    t.state.watchImpl = () => new Promise((resolve) => { ackFirst = () => resolve({ ok: true }); });
    t.panel.open('note', FILE, 'one\n');
    t.state.watchImpl = null;
    const other = '/home/u/.claude/projects/p/memory/other.md';
    await t.open('other\n', other);
    ackFirst();
    await tick();
    assert.deepEqual(t.state.unwatchCalls, [FILE], 'the superseded watch is given back');
    t.panel.destroy();
    assert.deepEqual(t.state.unwatchCalls, [FILE, other]);
  } finally { t.destroy(); }
});


function pendingSaves(t) {
  const finishers = [];
  t.state.saveImpl = (fp, content) => new Promise((resolve) => {
    finishers.push((result = { ok: true }) => { if (result.ok) t.state.disk = content; resolve(result); });
  });
  return finishers;
}


test('a queued save is dropped when the first save fails', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('A');
    const finish = pendingSaves(t);
    const first = t.panel._save();
    t.editor().type('B');
    t.panel._save();
    await tick();
    finish[0]({ ok: false, error: 'disk full' });
    await first;
    await tick();
    assert.equal(t.state.saves.length, 1);
    assert.equal(noticeText(t), 'Save failed: disk full');
  } finally { t.destroy(); }
});

test('a save on a file opened while the previous file was saving goes out on its own', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('A');
    const finish = pendingSaves(t);
    const first = t.panel._save();
    const other = '/home/u/.claude/projects/p/memory/other.md';
    await t.open('other\n', other);
    t.editor().type('B');
    t.panel._save();
    await tick();
    assert.equal(t.state.saves.length, 2, 'the save of the new file is not queued behind the old one');
    assert.equal(t.state.saves[1].filePath, other);
    assert.equal(t.state.saves[1].content, 'other\nB');
    finish[0]();
    await first;
    await tick();
    assert.equal(t.state.saves.length, 2);
  } finally { t.destroy(); }
});

test("the previous file's save resolving does not release the new file's in-flight save", async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('A');
    const finish = pendingSaves(t);
    const first = t.panel._save();
    const other = '/home/u/.claude/projects/p/memory/other.md';
    await t.open('other\n', other);
    t.editor().type('B');
    t.panel._save();
    t.editor().type('C');
    t.panel._save();
    await tick();
    assert.equal(t.state.saves.length, 2, 'the second save of the new file waits');
    finish[0]();
    await first;
    await tick();
    assert.equal(t.state.saves.length, 2, 'still waiting for its own first save, not for the old file');
    finish[1]();
    await tick();
    await tick();
    assert.equal(t.state.saves.length, 3);
    assert.equal(t.state.saves[2].content, 'other\nBC');
  } finally { t.destroy(); }
});

test('a panel destroyed before its watch is acknowledged gives the watch back', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    let ack;
    t.state.watchImpl = () => new Promise((resolve) => { ack = () => resolve({ ok: true }); });
    t.panel.open('note', FILE, 'one\n');
    t.panel.destroy();
    ack();
    await tick();
    assert.deepEqual(t.state.unwatchCalls, [FILE]);
  } finally { t.destroy(); }
});



test("a save queued on the previous file does not re-send the new file's first save", async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('A');
    const finish = pendingSaves(t);
    const first = t.panel._save();
    t.panel._save();
    const other = '/home/u/.claude/projects/p/memory/other.md';
    await t.open('other\n', other);
    t.editor().type('B');
    t.panel._save();
    await tick();
    finish[0]();
    await first;
    finish[1]();
    await tick();
    await tick();
    assert.deepEqual(t.state.saves.map((x) => x.filePath), [FILE, other], "B's save goes out once");
  } finally { t.destroy(); }
});

async function fire(t) {
  t.state.fileChanged(FILE);
  await tick();
}



test('after Keep my edits, a save goes out without asking', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.externalWrite('session\n');
    button(t, 'keep').click();
    await t.panel._save();
    assert.deepEqual(t.state.confirms, []);
    assert.equal(t.state.saves.length, 1);
    assert.equal(t.state.saves[0].expected, 'session\n');
  } finally { t.destroy(); }
});


async function unagreed(t) {
  await t.open('one\n');
  t.editor().type('mine');
  await t.externalWrite('session\n');
  assert.match(noticeText(t), /changed on disk/);
}


test('after Reload, a save goes out without asking', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await unagreed(t);
    button(t, 'reload').click();
    await tick();
    assert.equal(t.panel.getContent(), 'session\n');
    t.editor().type('!');
    await t.panel._save();
    assert.deepEqual(t.state.confirms, ['This file has unsaved edits. Discard them?']);
    assert.equal(t.state.saves.length, 1);
  } finally { t.destroy(); }
});

test('once the disk holds exactly the buffer, a save goes out without asking', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await unagreed(t);
    await t.externalWrite('one\nmine');
    assert.equal(visible(t.notice()), false);
    t.editor().type('!');
    await t.panel._save();
    assert.deepEqual(t.state.confirms, []);
  } finally { t.destroy(); }
});

test('once a clean buffer has been reloaded quietly, a save goes out without asking', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await unagreed(t);
    t.editor().dispatch({ changes: { from: 0, to: t.editor().state.doc.length, insert: 'session\n' } });
    await t.externalWrite('session again\n');
    assert.equal(t.panel.getContent(), 'session again\n');
    t.editor().type('!');
    await t.panel._save();
    assert.deepEqual(t.state.confirms, []);
  } finally { t.destroy(); }
});



const OVERWRITE = 'This file changed on disk since you opened it. Overwrite it with your edits?';

test('a dirty re-read does not move the baseline: a plain save is refused by main, then confirmed, then written with the agreed text', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await unagreed(t);
    t.state.confirmAnswer = true;
    await t.panel._save();
    assert.deepEqual(t.state.saves.map((x) => x.expected), ['one\n', 'session\n'],
      'the first save carries the base the user agreed to, the retry the disk they then agreed to');
    assert.deepEqual(t.state.confirms, [OVERWRITE]);
    assert.equal(t.state.disk, 'one\nmine');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

test('a declined confirm writes nothing and says the edits were not saved', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await unagreed(t);
    t.state.confirmAnswer = false;
    await t.panel._save();
    assert.equal(t.state.disk, 'session\n');
    assert.match(noticeText(t), /your edits were not saved/);
    assert.equal(visible(button(t, 'overwrite')), true);
    assert.equal(visible(button(t, 'reload')), true);
  } finally { t.destroy(); }
});

test('Overwrite while the disk moves during its confirm asks again and never writes blind', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await unagreed(t);
    let asked = 0;
    t.window.confirm = (msg) => {
      t.state.confirms.push(msg);
      asked += 1;
      if (asked === 1) { t.state.disk = 'second session write\n'; return true; }
      return false;
    };
    await t.panel._save();
    assert.equal(t.state.confirms.length, 2, 'asked again once the retry was refused');
    assert.equal(t.state.disk, 'second session write\n', 'the write that landed during the confirm survives');
    assert.ok(t.state.saves.every((x) => typeof x.expected === 'string'), 'never an expected of null');
    assert.match(noticeText(t), /your edits were not saved/);
  } finally { t.destroy(); }
});

test('the Overwrite button saves through the same check, and asks exactly once', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await unagreed(t);
    t.state.confirmAnswer = false;
    await t.panel._save();
    assert.equal(t.state.confirms.length, 1);
    t.state.confirmAnswer = true;
    button(t, 'overwrite').click();
    await tick();
    await tick();
    assert.equal(t.state.confirms.length, 2, 'one confirm for the Overwrite');
    assert.equal(t.state.disk, 'one\nmine');
    assert.equal(t.state.saves.at(-1).expected, 'session\n');
  } finally { t.destroy(); }
});

test('after an agreed save, the next save goes out without asking', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await unagreed(t);
    await t.panel._save();
    t.editor().type('!');
    await t.panel._save();
    assert.equal(t.state.confirms.length, 1);
    assert.equal(t.state.disk, 'one\nmine!');
  } finally { t.destroy(); }
});

test('an unagreed write stays protected after an "unreadable" notice came and went', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await unagreed(t);
    t.state.readImpl = () => ({ ok: false, error: 'EACCES: permission denied', code: 'EACCES' });
    await fire(t);
    assert.match(noticeText(t), /can no longer be read/);
    t.state.readImpl = null;
    await fire(t);
    assert.match(noticeText(t), /changed on disk/);
    t.state.confirmAnswer = false;
    await t.panel._save();
    assert.deepEqual(t.state.confirms, [OVERWRITE]);
    assert.equal(t.state.disk, 'session\n');
  } finally { t.destroy(); }
});

test('an unagreed write stays protected after the file was deleted and recreated identically', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await unagreed(t);
    await t.externalWrite(null);
    assert.match(noticeText(t), /no longer exists/);
    await t.externalWrite('session\n');
    assert.match(noticeText(t), /changed on disk/);
    t.state.confirmAnswer = false;
    await t.panel._save();
    assert.deepEqual(t.state.confirms, [OVERWRITE]);
    assert.equal(t.state.disk, 'session\n');
  } finally { t.destroy(); }
});

test('a queued save after a session write during the first save is refused by main and asks', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('A');
    const finish = [];
    t.state.saveImpl = (fp, content, expected) => {
      const outcome = mainSave(t.state, content, expected);
      return new Promise((resolve) => finish.push(() => resolve(outcome)));
    };
    const first = t.panel._save();
    t.editor().type('B');
    t.panel._save();
    await tick();
    await t.externalWrite('session\n');
    assert.match(noticeText(t), /changed on disk/);
    t.state.confirmAnswer = false;
    finish[0]();
    await first;
    await tick();
    await tick();
    finish[1]();
    await tick();
    await tick();
    assert.equal(t.state.saves.length, 2, 'the queued save is sent');
    assert.equal(t.state.saves[1].expected, 'one\nA', 'against what the first save wrote');
    assert.equal(t.state.disk, 'session\n', 'and refused, so the reported write survives');
    assert.deepEqual(t.state.confirms, [OVERWRITE]);
  } finally { t.destroy(); }
});

test('a session write read back while our save is in flight keeps its notice, and the next save asks', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    let finishSave;
    t.state.saveImpl = (fp, content, expected) => new Promise((resolve) => {
      const outcome = mainSave(t.state, content, expected);
      finishSave = () => resolve(outcome);
    });
    const saving = t.panel._save();
    await t.externalWrite('the session wrote after us\n');
    finishSave();
    await saving;
    t.state.saveImpl = null;
    assert.match(noticeText(t), /changed on disk/, 'the notice about the later write stays');
    t.state.confirmAnswer = false;
    await t.panel._save();
    assert.deepEqual(t.state.confirms, [OVERWRITE]);
    assert.equal(t.state.disk, 'the session wrote after us\n');
  } finally { t.destroy(); }
});

test('a newly opened file starts from its own base, with nothing to agree to', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await unagreed(t);
    await t.open('other\n', '/home/u/.claude/projects/p/memory/other.md');
    t.state.disk = 'other\n';
    t.editor().type('!');
    await t.panel._save();
    assert.deepEqual(t.state.confirms, []);
    assert.equal(t.state.saves.at(-1).expected, 'other\n');
  } finally { t.destroy(); }
});

test('a notice clears once the disk is back to the agreed base, and the edits stay', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await unagreed(t);
    await t.externalWrite('one\n');
    assert.equal(visible(t.notice()), false, 'the reported write was undone');
    await t.externalWrite(null);
    assert.match(noticeText(t), /no longer exists/);
    await t.externalWrite('one\n');
    assert.equal(visible(t.notice()), false, 'recreated as it was');
    assert.equal(t.panel.getContent(), 'one\nmine');
    await t.panel._save();
    assert.deepEqual(t.state.confirms, [], 'nothing to agree to');
    assert.equal(t.state.disk, 'one\nmine');
  } finally { t.destroy(); }
});

test('a stale refusal nothing had announced shows its notice and says the file changed before asking', async () => {
  const t = setup({ disk: 'written by the session\n' });
  try {
    await t.open('first read\n');
    t.editor().type('mine');
    let noticeAtConfirm = null;
    t.window.confirm = (msg) => {
      t.state.confirms.push(msg);
      noticeAtConfirm = visible(t.notice()) ? noticeText(t) : null;
      return false;
    };
    await t.panel._save();
    assert.deepEqual(t.state.confirms, [OVERWRITE]);
    assert.match(noticeAtConfirm, /changed on disk since you opened it/, 'the notice is up while the user decides');
    assert.equal(t.state.disk, 'written by the session\n');
  } finally { t.destroy(); }
});

test('switching file during the confirm sends no retry, for either file', async () => {
  const t = setup({ disk: 'session\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    const other = '/home/u/.claude/projects/p/memory/other.md';
    t.window.confirm = (msg) => {
      t.state.confirms.push(msg);
      t.panel.open('other', other, 'other\n');
      return true;
    };
    await t.panel._save();
    await tick();
    assert.equal(t.state.saves.length, 1, 'only the refused first save');
    assert.equal(t.state.saves[0].filePath, FILE);
    assert.equal(t.state.disk, 'session\n');
  } finally { t.destroy(); }
});

test('a stale refusal that comes back after the file was switched asks nothing about the new file', async () => {
  const t = setup({ disk: 'session\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    let finish;
    t.state.saveImpl = (fp, content, expected) => new Promise((resolve) => {
      finish = () => resolve(mainSave(t.state, content, expected));
    });
    const saving = t.panel._save();
    await t.open('other\n', '/home/u/.claude/projects/p/memory/other.md');
    finish();
    await saving;
    assert.deepEqual(t.state.confirms, []);
    assert.equal(t.state.saves.length, 1);
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});
