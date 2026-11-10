'use strict';
const watcher = require('../../src/main/triggers/trigger-watcher');
const { createJournal } = require('./session-request-journal.cjs');
module.exports = { ...watcher, start(ctx) {
  ctx.sessionRequests ||= createJournal();
  return watcher.start(ctx);
} };
