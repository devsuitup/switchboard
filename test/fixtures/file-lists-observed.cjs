'use strict';
const fs = require('node:fs');
const { parentPort } = require('node:worker_threads');
let reads = 0;
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (String(file).endsWith('.md')) reads++;
  return read.call(this, file, ...args);
};
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => {
  if (message.result) message.result.bodyReads = reads;
  post(message);
};
require('../../workers/file-lists-query');
