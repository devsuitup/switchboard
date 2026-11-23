'use strict';

const { redactLogText } = require('../shared/redact-log-text');

function installUiNoticeLog({ ipcMain, log, getWindow, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let started = 0;
  let writes = 0;
  let bytes = 0;
  let secondStarted = 0;
  let secondWrites = 0;
  let suppressed = 0;
  let last = null;
  let repeats = 0;
  let lastSeen = -Infinity;
  const events = new Set(['show', 'dismiss', 'replace', 'merge', 'dialog-show', 'dialog-choice']);
  const bounded = (value, max) => typeof value === 'string' ? redactLogText(value.slice(0, max + 128)).slice(0, max) : '';

  function write(line) {
    try { log.info(`[ui-notice] ${line}`); } catch {}
  }

  function flushRepeats() {
    if (repeats) {
      emit(`repeated ${repeats}× (consecutive notice)`, repeats);
    }
    repeats = 0;
  }

  function emit(line, count = 1) {
    if (now() - secondStarted >= 1000) { secondStarted = now(); secondWrites = 0; }
    const size = Buffer.byteLength(`[ui-notice] ${line}\n`);
    if (writes >= 60 || secondWrites >= 20 || bytes + size > 65536) { suppressed += count; return; }
    write(line);
    writes++;
    secondWrites++;
    bytes += size;
  }

  function flush() {
    clearTimer(timer);
    timer = null;
    flushRepeats();
    if (suppressed) write(`suppressed ${suppressed} events (rate limit)`);
    writes = 0;
    bytes = 0;
    suppressed = 0;
  }

  function receive(event, value) {
    try {
      const win = getWindow();
      if (!win || win.isDestroyed() || win.webContents.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
      if (!value || !events.has(value.event)) return;
      const entry = {
        event: value.event,
        kind: ['warning', 'error'].includes(value.kind) ? value.kind : 'info',
        id: bounded(value.id, 160),
        source: bounded(value.source, 80),
        text: bounded(value.text, 4096),
        title: bounded(value.title, 256),
        choices: Array.isArray(value.choices) ? value.choices.slice(0, 20).map(choice => bounded(choice, 256)) : [],
        choice: bounded(value.choice, 1024),
        reason: ['user', 'expired', 'cleared'].includes(value.reason) ? value.reason : '',
        counts: Array.isArray(value.counts) ? value.counts.slice(0, 5).map(member => ({ id: bounded(member.id, 160), count: Number.isSafeInteger(member.count) && member.count > 0 ? member.count : 1 })) : [],
      };
      const line = JSON.stringify(entry);
      if (timer !== null && now() - started >= 60000) flush();
      if (timer === null) {
        started = now();
        timer = setTimer(flush, 60000);
        timer?.unref?.();
      }
      if (now() - lastSeen >= 60000) { flushRepeats(); last = null; }
      lastSeen = now();
      if (line === last) { repeats++; return; }
      flushRepeats();
      emit(line);
      last = line;
    } catch {}
  }

  ipcMain.on('ui-notice-log', receive);
  return { dispose() { ipcMain.removeListener('ui-notice-log', receive); flush(); } };
}

module.exports = { installUiNoticeLog };
