// How a plain terminal defines its `claude` shim without typing it into the
// shell: args and env per shell, the generated startup files run by real
// shells, and the main.js wiring. See .ai/contexts/plain-terminal.md.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  plainTerminalLaunch, writeInitFiles, ensureInitFiles, BASHRC, TYPED_SHIM, FISH_SHIM, HINT,
} = require('../plain-terminal-shell');
const { shellArgs } = require('../shell-profiles');

const INIT = '/data/shell-init';
const BASE_ENV = { HOME: '/home/u', PATH: '/usr/bin:/bin', TERM: 'xterm-256color' };

function launchFor(shell, { env = BASE_ENV, initDir = INIT, platform = 'linux', extra } = {}) {
  return plainTerminalLaunch({ shell, args: shellArgs(shell, undefined, extra), env, initDir, platform });
}

// ── args and env per shell ──────────────────────────────────────────────────

test('bash: an interactive shell reading the generated rcfile, nothing typed', () => {
  const l = launchFor('/bin/bash');
  assert.deepEqual(l.args, ['--rcfile', path.join(INIT, 'bashrc'), '-i']);
  assert.equal(l.typed, null);
  assert.deepEqual(l.env, BASE_ENV);
});

test('bash: no ENV or BASH_ENV is handed to the shell or its children', () => {
  for (const shell of ['/bin/bash', '/usr/bin/zsh', '/usr/bin/dash', '/usr/bin/fish']) {
    const l = launchFor(shell);
    assert.equal('BASH_ENV' in l.env, false, shell);
    assert.equal('ENV' in l.env, false, shell);
  }
});

test('zsh: login interactive args kept, ZDOTDIR points at the generated directory, nothing typed', () => {
  const l = launchFor('/usr/bin/zsh');
  assert.deepEqual(l.args, ['-l', '-i']);
  assert.equal(l.env.ZDOTDIR, path.join(INIT, 'zsh'));
  assert.equal('SWITCHBOARD_USER_ZDOTDIR' in l.env, false);
  assert.equal(l.typed, null);
});

test('zsh: a ZDOTDIR the user already had is handed over for the generated files to restore', () => {
  const l = launchFor('/usr/bin/zsh', { env: { ...BASE_ENV, ZDOTDIR: '/home/u/.config/zsh' } });
  assert.equal(l.env.ZDOTDIR, path.join(INIT, 'zsh'));
  assert.equal(l.env.SWITCHBOARD_USER_ZDOTDIR, '/home/u/.config/zsh');
});

test('zsh: a stale SWITCHBOARD_USER_ZDOTDIR inherited from the parent is dropped', () => {
  const l = launchFor('/usr/bin/zsh', { env: { ...BASE_ENV, SWITCHBOARD_USER_ZDOTDIR: '/stale' } });
  assert.equal('SWITCHBOARD_USER_ZDOTDIR' in l.env, false);
});

test('fish: the shim goes through --init-command, nothing typed', () => {
  const l = launchFor('/usr/bin/fish');
  assert.deepEqual(l.args, ['-l', '-i', '--init-command', FISH_SHIM]);
  assert.equal(l.typed, null);
});

test('other POSIX shells, WSL and Windows bash: the typed fallback, led by a space', () => {
  for (const [shell, platform] of [
    ['/usr/bin/dash', 'linux'], ['/bin/sh', 'linux'], ['/bin/ksh', 'darwin'],
    ['wsl.exe', 'win32'], ['C:\\Program Files\\Git\\bin\\bash.exe', 'win32'],
  ]) {
    const l = launchFor(shell, { platform, extra: shell === 'wsl.exe' ? ['-d', 'Ubuntu'] : undefined });
    assert.deepEqual(l.args, shellArgs(shell, undefined, shell === 'wsl.exe' ? ['-d', 'Ubuntu'] : undefined), shell);
    assert.equal(l.typed, TYPED_SHIM, shell);
    assert.ok(l.typed.startsWith(' claude() {'), shell);
  }
});

test('bash and zsh fall back to the typed line when the generated files could not be written', () => {
  for (const shell of ['/bin/bash', '/usr/bin/zsh']) {
    const l = launchFor(shell, { initDir: null });
    assert.deepEqual(l.args, ['-l', '-i'], shell);
    assert.equal(l.typed, TYPED_SHIM, shell);
    assert.equal('ZDOTDIR' in l.env, false, shell);
  }
});

test('PowerShell and cmd get no bash-syntax line typed into them', () => {
  for (const shell of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\WINDOWS\\system32\\cmd.exe']) {
    const l = launchFor(shell, { platform: 'win32' });
    assert.equal(l.typed, null, shell);
  }
});

test('ensureInitFiles writes once per directory and reports a failure as false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-init-'));
  try {
    assert.equal(ensureInitFiles(dir), true);
    fs.writeFileSync(path.join(dir, 'bashrc'), 'changed');
    assert.equal(ensureInitFiles(dir), true);
    assert.equal(fs.readFileSync(path.join(dir, 'bashrc'), 'utf8'), 'changed');
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    assert.equal(ensureInitFiles(path.join(blocker, 'sub')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureInitFiles rewrites the files when they disappear while the app runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-init-'));
  try {
    assert.equal(ensureInitFiles(dir), true);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(ensureInitFiles(dir), true);
    assert.equal(fs.readFileSync(path.join(dir, 'bashrc'), 'utf8'), BASHRC);
    fs.rmSync(path.join(dir, 'zsh', '.zlogin'));
    assert.equal(ensureInitFiles(dir), true);
    assert.ok(fs.existsSync(path.join(dir, 'zsh', '.zlogin')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the bash rcfile starts with /etc/profile, as a login shell does', () => {
  const lines = BASHRC.split('\n').filter((l) => !l.startsWith('#'));
  assert.equal(lines[0], 'if [ -f /etc/profile ]; then . /etc/profile; fi');
});

// ── the generated files, run by real shells ─────────────────────────────────

function findShell(name, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-plain-'));
  const home = path.join(root, 'home');
  const init = path.join(root, 'init dir');
  fs.mkdirSync(home);
  writeInitFiles(init);
  return { root, home, init, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function run(shell, args, env, script) {
  const r = spawnSync(shell, [...args, '-c', script], { env, encoding: 'utf8', timeout: 20000 });
  return r.stdout + r.stderr;
}

const BASH = process.platform === 'win32' ? null : findShell('bash', 'SWITCHBOARD_TEST_BASH');
const ZSH = process.platform === 'win32' ? null : findShell('zsh', 'SWITCHBOARD_TEST_ZSH');

test('real bash: the login files run as a login shell would, then the shim is defined and exported', (t) => {
  if (!BASH) return t.skip('bash not found');
  const s = sandbox();
  try {
    fs.writeFileSync(path.join(s.home, '.profile'),
      'export PROFILE_MARK=1\nif [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n');
    fs.writeFileSync(path.join(s.home, '.bashrc'), "alias sbmarker='echo MARKER_OK'\n");
    const l = plainTerminalLaunch({ shell: BASH, args: shellArgs(BASH), env: { HOME: s.home, PATH: process.env.PATH }, initDir: s.init, platform: process.platform });
    const out = run(BASH, l.args, l.env,
      'sbmarker; echo "P=$PROFILE_MARK"; claude; echo "rc=$?"; bash -c claude; echo "child=$?"');
    assert.match(out, /^MARKER_OK$/m);
    assert.match(out, /^P=1$/m);
    assert.ok(out.includes(`\x1b[33m${HINT}\x1b[0m\nrc=1`), out);
    assert.match(out, /use the \+ button in the sidebar\.\x1b\[0m\nchild=1/);
  } finally { s.cleanup(); }
});

function bashLoginWinner(files) {
  const s = sandbox();
  try {
    for (const name of files) fs.writeFileSync(path.join(s.home, name), `W=${name}\n`);
    const l = plainTerminalLaunch({ shell: BASH, args: shellArgs(BASH), env: { HOME: s.home, PATH: process.env.PATH }, initDir: s.init, platform: process.platform });
    return (run(BASH, l.args, l.env, 'echo "W=$W"').match(/^W=(.*)$/m) || [])[1];
  } finally { s.cleanup(); }
}

test('real bash: the first of ~/.bash_profile, ~/.bash_login, ~/.profile is read, and only it', (t) => {
  if (!BASH) return t.skip('bash not found');
  assert.equal(bashLoginWinner(['.bash_profile', '.bash_login', '.profile']), '.bash_profile');
  assert.equal(bashLoginWinner(['.bash_login', '.profile']), '.bash_login');
  assert.equal(bashLoginWinner(['.profile']), '.profile');
});

function zshCase(t, { userZdotdir, files }) {
  const s = sandbox();
  try {
    for (const [rel, content] of Object.entries(files(s.home))) {
      fs.mkdirSync(path.dirname(path.join(s.home, rel)), { recursive: true });
      fs.writeFileSync(path.join(s.home, rel), content);
    }
    const env = { HOME: s.home, PATH: process.env.PATH };
    if (userZdotdir) env.ZDOTDIR = userZdotdir(s.home);
    const l = plainTerminalLaunch({ shell: ZSH, args: shellArgs(ZSH), env, initDir: s.init, platform: process.platform });
    return run(ZSH, l.args, l.env,
      'claude; echo "rc=$?"; echo "ZD=${ZDOTDIR-unset} SBU=${SWITCHBOARD_USER_ZDOTDIR-unset} TMP=${_sb_init_dir-unset}"; echo "M=$MARKS"')
      .replaceAll(s.home, '~');
  } finally { s.cleanup(); }
}

test('real zsh: the user files run in order from $HOME, the shim is defined, ZDOTDIR is left unset', (t) => {
  if (!ZSH) return t.skip('zsh not found');
  const out = zshCase(t, {
    files: () => ({
      '.zshenv': 'MARKS=env\n', '.zprofile': 'MARKS+=,profile\n', '.zshrc': 'MARKS+=,rc\n', '.zlogin': 'MARKS+=,login\n',
    }),
  });
  assert.ok(out.includes(`\x1b[33m${HINT}\x1b[0m\nrc=1`), out);
  assert.match(out, /^ZD=unset SBU=unset TMP=unset$/m);
  assert.match(out, /^M=env,profile,rc,login$/m);
});

test('real zsh: a ZDOTDIR the user had is where their files are read from, and it is restored', (t) => {
  if (!ZSH) return t.skip('zsh not found');
  const out = zshCase(t, {
    userZdotdir: (home) => path.join(home, 'zd'),
    files: () => ({ 'zd/.zshenv': 'MARKS=env\n', 'zd/.zshrc': 'MARKS+=,rc\n', '.zshrc': 'MARKS+=,WRONG\n' }),
  });
  assert.match(out, /^ZD=~\/zd SBU=unset TMP=unset$/m);
  assert.match(out, /^M=env,rc$/m);
});

test('real zsh: a ZDOTDIR set by ~/.zshenv from its own default is followed and kept', (t) => {
  if (!ZSH) return t.skip('zsh not found');
  const out = zshCase(t, {
    files: () => ({
      '.zshenv': 'export ZDOTDIR=${ZDOTDIR:-$HOME/.config/zsh}\nMARKS=env\n',
      '.config/zsh/.zprofile': 'MARKS+=,profile\n',
      '.config/zsh/.zshrc': 'MARKS+=,rc\n',
      '.zshrc': 'MARKS+=,WRONG\n',
    }),
  });
  assert.match(out, /^ZD=~\/.config\/zsh SBU=unset TMP=unset$/m);
  assert.match(out, /^M=env,profile,rc$/m);
  assert.ok(out.includes(HINT), out);
});

// ── main.js wiring ──────────────────────────────────────────────────────────

test('main.js: the plain-terminal branch spawns what plainTerminalLaunch returns and types only its fallback', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = main.indexOf('    if (isPlainTerminal) {\n      const launch = plainTerminalLaunch(');
  assert.notEqual(start, -1, 'plain-terminal branch does not call plainTerminalLaunch');
  const branch = main.slice(start, main.indexOf('    } else {', start));
  assert.match(branch, /spawnPty\(shell, launch\.args, \{/);
  assert.match(branch, /env: launch\.env,/);
  assert.match(branch, /if \(launch\.typed\) \{/);
  assert.match(branch, /ptyProcess\.write\(launch\.typed\);/);
  assert.doesNotMatch(branch, /BASH_ENV|\bENV:/);
  assert.doesNotMatch(main, /claudeShim/);
  assert.match(branch, /initDir: ensurePlainTerminalInitFiles\(PLAIN_TERMINAL_INIT_DIR, log\) \? PLAIN_TERMINAL_INIT_DIR : null,/);
  assert.match(main, /const PLAIN_TERMINAL_INIT_DIR = path\.join\(path\.dirname\(DB_PATH\), 'shell-init'\);/);
});
