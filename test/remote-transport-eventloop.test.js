'use strict';

// The kill timer in remote-transport.js must not be unref'd. Unref'd, a process
// whose only pending handle is that timer exits before it fires: the child is
// never killed and the promise never settles. That is invisible from inside
// node:test — the runner itself keeps the loop alive — and it shipped once,
// surfacing on CI as five `cancelledByParent` tests with `# fail 0`.
//
// So the property is observed from OUTSIDE: a child node process with nothing
// else pending must print settled=true and exit 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

const TRANSPORT = path.join(__dirname, '..', 'remote-transport.js').replace(/\\/g, '\\\\');

const PROBE = `
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { createSshTransport } = require('${TRANSPORT}');
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new Readable({ read() {} });
  c.stderr = new Readable({ read() {} });
  c.kill = () => c.emit('close', null);
  return c;
}
const t = createSshTransport({ spawn: () => fakeChild(), listTimeoutMs: 150 });
let settled = false;
t.listFiles('vps').then(() => { settled = true; }, () => { settled = true; });
process.on('exit', () => process.stdout.write('settled=' + settled));
`;

test('a hung ssh still times out when nothing else holds the event loop', async () => {
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', PROBE], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    // Bounded and reaped: this test must never leave a node process behind.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('probe did not exit within 15 s'));
    }, 15000);
    child.stdout.on('data', c => { stdout += c; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => { clearTimeout(timer); resolve(stdout); });
  });

  assert.equal(out.trim(), 'settled=true',
    'the listFiles promise must settle before the process exits — the kill timer must not be unref\'d');
});
