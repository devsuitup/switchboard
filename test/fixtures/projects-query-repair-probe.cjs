'use strict';

const threads = require('node:worker_threads');
let nestedWorkers = 0;
threads.Worker = class {
  constructor() { nestedWorkers++; throw new Error('query worker must not start a repair worker'); }
};
const post = threads.parentPort.postMessage.bind(threads.parentPort);
threads.parentPort.postMessage = message => post(message.result ? { ...message, result: { ...message.result, nestedWorkers } } : message);
require('../../workers/projects-query');
