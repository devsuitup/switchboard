'use strict';

// Stands in for the `claude` command in the trigger-actions journey: records how it was
// started and stays attached to stdin. It never runs the arguments it receives.
const fs = require('fs');
const path = require('path');

const out = path.join(process.env.HOME, 'trigger-session-runs');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `${process.pid}.json`), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
