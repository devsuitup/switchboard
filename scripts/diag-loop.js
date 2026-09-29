'use strict';

const { spawn } = require('child_process');

const total = Number(process.argv[2] || 400);
const concurrency = Number(process.argv[3] || 4);
const pattern = process.argv[4] || 'blob over the cap';
const file = process.argv[5] || 'test/git-changes-file-real-git.test.js';

let started = 0;
let done = 0;
let failed = 0;
let ebusy = 0;

function one() {
  if (started >= total) return;
  started++;
  const child = spawn(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => {
    done++;
    if (code !== 0) {
      failed++;
      if (/EBUSY/.test(out)) ebusy++;
      console.log(out.split('\n').filter((l) => /not ok|EBUSY/.test(l)).slice(0, 4).join('\n'));
    }
    if (done === total) console.log(`RESULT runs=${total} concurrency=${concurrency} failed=${failed} ebusy=${ebusy}`);
    else one();
  });
}

for (let i = 0; i < concurrency; i++) one();
