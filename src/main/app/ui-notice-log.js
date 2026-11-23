'use strict';

const { redactLogText } = require('../shared/redact-log-text');

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const SECOND_WRITE_LIMIT = 20;
const MINUTE_WRITE_LIMIT = 60;
const MINUTE_BYTE_LIMIT = 64 * 1024;
const HOUR_BYTE_LIMIT = 256 * 1024;
const HOUR_SUMMARY_RESERVE = 256;

function installUiNoticeLog({ ipcMain, log, getWindow, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let started = 0;
  let writes = 0;
  let bytes = 0;
  let secondStarted = 0;
  let secondWrites = 0;
  let suppressed = 0;
  let hourStarted = now();
  let hourBytes = 0;
  let hourLimited = false;
  let hourDropped = 0;
  let last = null;
  let repeats = 0;
  let lastSeen = -Infinity;
  const events = new Set(['show', 'dismiss', 'action', 'replace', 'merge', 'dialog-show', 'dialog-choice']);
  const bounded = (value, max) => typeof value === 'string' ? redactLogText(value.slice(0, max + 128)).slice(0, max) : '';

  function write(line) {
    try { log.info(`[ui-notice] ${line}`); } catch {}
    hourBytes += Buffer.byteLength(`[ui-notice] ${line}\n`);
  }

  function writeHourly(line, count) {
    if (now() - hourStarted >= HOUR_MS) {
      hourStarted = now();
      hourBytes = 0;
      if (hourLimited) write(`resumed after hourly byte limit; dropped ${hourDropped} notices`);
      hourLimited = false;
      hourDropped = 0;
    }
    const size = Buffer.byteLength(`[ui-notice] ${line}\n`);
    if (hourLimited || hourBytes + size > HOUR_BYTE_LIMIT - HOUR_SUMMARY_RESERVE) {
      if (!hourLimited) write('hourly byte limit reached; dropping notices until the next hour');
      hourLimited = true;
      hourDropped += count;
      return false;
    }
    write(line);
    return true;
  }

  function flushRepeats() {
    if (repeats) {
      emit(`repeated ${repeats}× (consecutive notice)`, repeats);
    }
    repeats = 0;
  }

  function emit(line, count = 1) {
    if (now() - secondStarted >= SECOND_MS) { secondStarted = now(); secondWrites = 0; }
    const size = Buffer.byteLength(`[ui-notice] ${line}\n`);
    if (hourLimited && now() - hourStarted < HOUR_MS) { hourDropped += count; return false; }
    if (writes >= MINUTE_WRITE_LIMIT || secondWrites >= SECOND_WRITE_LIMIT || bytes + size > MINUTE_BYTE_LIMIT) { suppressed += count; return false; }
    if (!writeHourly(line, count)) return false;
    writes++;
    secondWrites++;
    bytes += size;
    return true;
  }

  function flush() {
    clearTimer(timer);
    timer = null;
    flushRepeats();
    if (suppressed) writeHourly(`suppressed ${suppressed} events (rate limit)`, suppressed);
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
        reason: ['user', 'expired', 'cleared'].includes(value.reason) ? value.reason
          : typeof value.reason === 'string' && value.reason.startsWith('action:') ? bounded(value.reason, 256) : '',
        counts: Array.isArray(value.counts) ? value.counts.slice(0, 5).map(member => ({ id: bounded(member.id, 160), count: Number.isSafeInteger(member.count) && member.count > 0 ? member.count : 1 })) : [],
      };
      if (value.unmarked === true) {
        delete entry.text;
        delete entry.title;
        delete entry.choice;
        delete entry.choices;
        entry.sessions = Array.isArray(value.sessions) ? value.sessions.slice(0, 100).filter(id => typeof id === 'string' && /^[a-f0-9]{8}$/i.test(id)) : [];
        entry.unmarked = true;
      }
      const line = JSON.stringify(entry);
      if (timer !== null && now() - started >= MINUTE_MS) flush();
      if (timer === null) {
        started = now();
        timer = setTimer(flush, MINUTE_MS);
        timer?.unref?.();
      }
      if (now() - lastSeen >= MINUTE_MS) { flushRepeats(); last = null; }
      lastSeen = now();
      if (line === last) { repeats++; return; }
      flushRepeats();
      last = emit(line) ? line : null;
    } catch {}
  }

  ipcMain.on('ui-notice-log', receive);
  return { dispose() {
    ipcMain.removeListener('ui-notice-log', receive);
    flush();
    if (hourLimited) {
      write(`disposed after hourly byte limit; dropped ${hourDropped} notices`);
      hourLimited = false;
      hourDropped = 0;
    }
  } };
}

module.exports = { installUiNoticeLog };
