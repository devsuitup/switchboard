'use strict';

const { spawn } = require('child_process');

// Settles on 'close' and never kills over a stdout cap — see .ai/contexts/changes-view.md ("A capped read waits for git to exit")
function runToExit(file, args, { cwd, env, timeoutMs, maxBuffer }, spawnFn = spawn) {
  return new Promise((resolve) => {
    const command = [file, ...args].join(' ');
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let timer = null;

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      let message = '';
      if (spawnError) message = spawnError.message;
      else if (overflow) message = 'stdout maxBuffer length exceeded';
      else if (exitCode !== 0) message = `Command failed: ${command}`;
      const code = spawnError || overflow || timedOut || typeof exitCode !== 'number' ? -1 : exitCode;
      resolve({ code, stdout, stderr, overflow, timedOut, message });
    };

    let child;
    try {
      child = spawnFn(file, args, { cwd, env, windowsHide: true });
    } catch (err) {
      spawnError = err;
      finish(null);
      return;
    }

    child.stdout.on('data', (chunk) => {
      if (overflow) return;
      if (stdoutBytes + chunk.length > maxBuffer) {
        stdoutChunks.push(chunk.subarray(0, maxBuffer - stdoutBytes));
        stdoutBytes = maxBuffer;
        overflow = true;
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= maxBuffer) return;
      const kept = chunk.subarray(0, maxBuffer - stderrBytes);
      stderrChunks.push(kept);
      stderrBytes += kept.length;
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
    }
    child.on('error', (err) => {
      if (child.pid !== undefined) return;
      spawnError = err;
      finish(null);
    });
    child.on('close', (exitCode) => finish(exitCode));
  });
}

module.exports = { runToExit };
