'use strict';

const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');

parentPort.once('message', () => {
  fs.mkdirSync(workerData, { recursive: true });
  parentPort.close();
});
