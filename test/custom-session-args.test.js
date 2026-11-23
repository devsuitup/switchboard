'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { extractFunction } = require('./app-source');
const { fixture, ID } = require('./fixtures/trigger-main-open.cjs');
const profiles = require('../src/main/terminals/shell-profiles');
const { SETTING_DEFAULTS } = require('../public/setting-defaults');
const { buildLaunchScript } = require('../src/main/remote/remote-launch');
const { handleLaunchRequest } = require('../src/main/remote/remote-launch');
const { shellSingleQuote } = require('../src/main/remote/remote-attach');
const raw = `--settings '{"outputStyle":"Learning"}'`;

test('custom arguments default to empty independently for both CLIs', () => {
  assert.equal(SETTING_DEFAULTS.customArgs, '');
  assert.equal(SETTING_DEFAULTS.codexCustomArgs, '');
});

test('command validation rejects every C0/C1 control and Unicode line separator', () => {
  for (const code of [...Array.from({ length: 32 }, (_, n) => n), ...Array.from({ length: 33 }, (_, n) => n + 127), 0x2028, 0x2029]) {
    assert.throws(() => profiles.claudeCommand('/bin/bash', ['--resume', ID], { customArgs: '--x' + String.fromCharCode(code), windows: false }), /control|newline/i, `control U+${code.toString(16)} must be rejected`);
  }
  assert.throws(() => profiles.claudeCommand('/bin/bash', [], { customArgs: 12 }), /string/i);
});

for (const shell of ['/bin/bash', 'cmd.exe', 'powershell.exe', 'wsl.exe']) {
  test(`${shell}: raw arguments follow quoted generated arguments`, () => {
    const opts = { windows: true, env: {}, customArgs: raw };
    const base = profiles.claudeCommand(shell, ['--resume', ID], { ...opts, customArgs: '' });
    assert.equal(profiles.claudeCommand(shell, ['--resume', ID], opts), base + ' ' + raw);
  });
}

for (const runtime of ['claude', 'codex']) {
  for (const mode of ['new', 'resume', 'fork']) {
    test(`${runtime} ${mode}: stored arguments reach the PTY and stay separate`, async () => {
      const f = fixture({ ...profiles, os, armLaunchSweep() {}, sessionTranscriptExists: () => true,
        resolveSessionRealCwd: () => process.cwd(),
        getCachedSession: () => ({ runtime, projectPath: process.cwd(), sessionFile: __filename }),
        getSetting: key => key === 'global' ? { customArgs: '--claude-global', codexCustomArgs: '--codex-only' } : { customArgs: '--claude-project' },
      });
      const result = await f.open(null, mode === 'new', { runtime, ...(mode === 'fork' ? { forkFrom: ID } : {}) });
      assert.equal(result.ok, true, result.error);
      const command = f.spawns[0].args.join(' ');
      assert.ok(command.endsWith(runtime === 'codex' ? '--codex-only' : '--claude-project'), command);
      assert.ok(!command.includes(runtime === 'codex' ? '--claude-' : '--codex-only'));
    });
  }
}

test('main rejects invalid custom arguments before spawning', async () => {
  const f = fixture({ ...profiles, getSetting: () => ({ customArgs: '--bad\n--next' }) });
  const result = await f.open(null, true);
  assert.equal(result.ok, false, 'invalid stored custom arguments must refuse launch');
  assert.match(result.error, /control|newline/i);
  assert.equal(f.spawns.length, 0);
});

test('an explicit empty project override removes global arguments', async () => {
  const f = fixture({ ...profiles, getSetting: key => key === 'global' ? { customArgs: '--global' } : { customArgs: '' } });
  const result = await f.open(null, true);
  assert.equal(result.ok, true, result.error);
  assert.ok(!f.spawns[0].args.join(' ').includes('--global'));
});

test('local sandbox replacement retains custom arguments', async () => {
  const f = fixture({ ...profiles, os, process: { platform: 'linux' },
    getSetting: () => ({ customArgs: raw }), sandboxScriptPath: () => '/sandbox.sh', sandboxBindEnv: () => '', parseAddDirs: () => [],
  });
  const result = await f.open(null, true, { sandbox: true });
  assert.equal(result.ok, true, result.error);
  const command = f.spawns[0].args.join(' ');
  assert.ok(command.includes('/sandbox.sh') && command.endsWith(' ' + raw), command);
});

test('remote requests inherit project arguments, reject controls and honor an empty override', async () => {
  const seen = [];
  let project = { customArgs: raw };
  const deps = { hasHost: () => true, launchBlockReason: () => null,
    getSetting: key => key === 'global' ? { customArgs: '--global' } : project,
    adapter: { launch: async (_alias, request) => { seen.push(request); return { ok: true, descriptor: { tmux: 'fixture' } }; } },
    attach: async () => ({ ok: true }),
  };
  const request = () => handleLaunchRequest({ alias: 'fixture', sessionId: ID, cwd: '/srv/app' }, deps);
  assert.equal((await request()).ok, true);
  assert.equal(seen[0].options.customArgs, raw);
  project = { customArgs: '\n' };
  assert.equal((await request()).ok, false);
  assert.equal(seen.length, 1);
  project = { customArgs: '' };
  assert.equal((await request()).ok, true);
  assert.equal(seen[1].options.customArgs, '');
});

for (const sandbox of [false, true]) {
  test(`scheduled launch, sandbox=${sandbox}: project arguments reach the spawn`, async () => {
    const filename = path.resolve(__dirname, '../main.js');
    const calls = [];
    const context = vm.createContext({ require: createRequire(filename), fs, path, os, process: { platform: 'linux' },
      ...profiles, cleanPtyEnv: {}, SETTING_DEFAULTS,
      getSetting: key => key === 'global' ? { customArgs: '--global' } : { customArgs: raw },
      isProjectSettingsArchived: () => false, resolveShell: () => ({ path: '/bin/bash' }),
      resolveScheduleSandbox: () => sandbox, scheduleLaunchRefusal: () => null,
      scheduleProjects: () => ({ list: async () => [] }), sandboxScriptPath: () => '/sandbox.sh', sandboxBindEnv: () => '', encodeProjectPath: () => 'fixture',
      log: { info() {}, warn() {}, error() {} }, cliSessionState: { trackScheduleRun() {} }, activityReporter: { sessionStarted() {} },
      cpSpawn: (program, args) => { calls.push({ program, args }); const child = new EventEmitter(); child.stderr = new EventEmitter(); queueMicrotask(() => child.emit('spawn')); return child; },
    });
    const source = fs.readFileSync(filename, 'utf8').replace(/^    (async )?function runScheduleCommand/m, '$1function runScheduleCommand');
    vm.runInContext(extractFunction(source, 'runScheduleCommand'), context, { filename });
    const result = await context.runScheduleCommand(['--resume', ID, '-p', 'Run'], process.cwd(), 'fixture', null);
    assert.equal(result.ok, true, result.error);
    assert.ok(calls[0].args.at(-1).endsWith(' ' + raw), calls[0].args.at(-1));
  });
}

test('remote launch keeps the complete command inside the tmux shell argument', () => {
  const script = buildLaunchScript({ sessionId: ID, cwd: '/srv/app', options: { customArgs: raw } });
  const command = profiles.claudeCommand('/bin/sh', ['--session-id', ID], { windows: false, customArgs: raw });
  assert.ok(script.endsWith(shellSingleQuote(command)), script);
  assert.throws(() => buildLaunchScript({ sessionId: ID, cwd: '/srv/app', options: { customArgs: '\n' } }), /control|newline/i);
});
