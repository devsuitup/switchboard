'use strict';

const fs = require('node:fs');
setTimeout(() => process.exit(0), Number(process.env.FIXTURE_LIFETIME) || 20000);
const pidFile = process.argv[2];
fs.writeFileSync(`${pidFile}.tmp`, JSON.stringify({ rootPid: process.ppid, grandchildPid: process.pid }));
fs.renameSync(`${pidFile}.tmp`, pidFile);
