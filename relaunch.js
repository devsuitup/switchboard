'use strict';

// see .ai/contexts/updater-relaunch.md
module.exports = async function relaunch({
  execPath = process.env.APPIMAGE || process.execPath, argv = process.argv.slice(1), cwd = process.cwd(),
  env = process.env, spawnSync = require('node:child_process').spawnSync, now = Date.now,
  quit, notify, log = console,
}) {
  const unit = `switchboard-relaunch-${now()}-${process.pid}`;
  const runtimeKeys = new Set(['CHROME_CRASHPAD_PIPE_NAME', 'CHROME_RESTART', 'INVOCATION_ID', 'JOURNAL_STREAM',
    'SYSTEMD_EXEC_PID', 'NOTIFY_SOCKET', 'WATCHDOG_PID', 'WATCHDOG_USEC', 'SWITCHBOARD_RELAUNCH']);
  const cleaned = require('./clean-env').cleanEnv(env, { locale: false });
  if (env.ELECTRON_OZONE_PLATFORM_HINT) cleaned.ELECTRON_OZONE_PLATFORM_HINT = env.ELECTRON_OZONE_PLATFORM_HINT;
  const skipped = Object.keys(cleaned).filter(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  if (skipped.length) log.warn('[relaunch] not forwarding environment names systemd rejects:', skipped.join(', '));
  const childEnv = Object.fromEntries(Object.entries(cleaned).filter(([key]) => !runtimeKeys.has(key) && !skipped.includes(key)));
  const args = ['--user', `--unit=${unit}`, '--collect', '--service-type=exec', '--property=KillMode=process', `--working-directory=${cwd}`];
  for (const key of Object.keys(childEnv)) args.push(`--setenv=${key}`);
  const commandArgs = argv.filter(arg => arg !== '--switchboard-relaunch').map(arg => arg.replace(/\$/g, () => '$$'));
  args.push('--', execPath, ...commandArgs, '--switchboard-relaunch');
  let result;
  try {
    result = spawnSync('systemd-run', args, { shell: false, timeout: 5000, encoding: 'utf8', env: childEnv });
  } catch (error) { result = { error }; }
  if (result.error?.code === 'ETIMEDOUT') {
    try {
      const active = spawnSync('systemctl', ['--user', 'is-active', '--quiet', unit], { shell: false, timeout: 2000, encoding: 'utf8', env: childEnv });
      if (!active.error && active.status === 0) result = active;
    } catch {}
  }
  if (result.error || result.status !== 0) {
    log.warn('[relaunch] user service unavailable:', result.error?.message || result.stderr || result.status);
    await notify('Switchboard will close; start it again from the application menu.');
  }
  quit();
};
