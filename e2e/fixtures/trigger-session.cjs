'use strict';

// see docs/e2e.md ("Trigger actions journey")
const fs = require('fs');
const path = require('path');

const out = path.join(process.env.HOME, 'trigger-session-runs');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `${process.pid}.json`), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
