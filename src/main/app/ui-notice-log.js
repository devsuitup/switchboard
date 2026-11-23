'use strict';

const { redactLogText } = require('../shared/redact-log-text');

function installUiNoticeLog({ ipcMain, log, getWindow, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let started = 0;
  let writes = 0;
  let suppressed = 0;
  let last = null;
  let repeats = 0;
  const events = new Set(['show', 'dismiss', 'replace', 'merge', 'dialog-show', 'dialog-choice']);
  const bounded = (value, max) => typeof value === 'string' ? redactLogText(value.slice(0, 16384)).slice(0, max) : '';

  function write(line) {
    try { log.info(`[ui-notice] ${line}`); } catch {}
  }

  function flushRepeats() {
    if (repeats) {
      if (writes < 20) { write(`${last} repeated ${repeats}×`); writes++; }
      else suppressed += repeats;
    }
    repeats = 0;
  }

  function flush() {
    clearTimer(timer);
    timer = null;
    flushRepeats();
    if (suppressed) write(`suppressed ${suppressed} events (rate limit)`);
    last = null;
    writes = 0;
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
      };
      const line = JSON.stringify(entry);
      if (timer !== null && now() - started >= 1000) flush();
      if (timer === null) {
        started = now();
        timer = setTimer(flush, 1000);
        timer?.unref?.();
      }
      if (line === last) { repeats++; return; }
      flushRepeats();
      if (writes >= 20) { suppressed++; last = null; return; }
      write(line);
      writes++;
      last = line;
    } catch {}
  }

  ipcMain.on('ui-notice-log', receive);
  return { dispose() { ipcMain.removeListener('ui-notice-log', receive); flush(); } };
}

module.exports = { installUiNoticeLog };
