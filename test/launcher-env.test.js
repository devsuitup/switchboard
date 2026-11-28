'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildLaunch, isolatedEnv, writeRefusingStubs } = require('../scripts/launcher-env');

function temporaryHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-launcher-env-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const launchers = [
  ['test-pr', (home, env) => buildLaunch({ pr: 1314, isolated: true, tempHome: home, env }).env],
  ['e2e fixtures', isolatedEnv],
];

for (const [name, buildEnv] of launchers) {
  for (const key of ['CODEX_HOME', 'codex_home', 'CoDeX_HoMe', undefined]) {
    test(name + ' replaces inherited ' + (key || 'unset CODEX_HOME') + ' with disposable Codex home', t => {
      const home = temporaryHome(t);
      const inheritedHome = path.join(home, 'inherited-state');
      const inherited = Object.freeze({
        ...(key ? { [key]: inheritedHome } : {}),
        HOME: inheritedHome, USERPROFILE: inheritedHome,
        SWITCHBOARD_DATA_DIR: inheritedHome, SWITCHBOARD_TRIGGERS_DIR: inheritedHome,
        CLAUDE_CONFIG_DIR: inheritedHome, KEEP_ME: 'retained',
      });
      const env = buildEnv(home, inherited);
      assert.equal(env.CODEX_HOME, path.join(home, '.codex'), 'Codex home must be disposable');
      assert.deepEqual(Object.keys(env).filter(k => k.toUpperCase() === 'CODEX_HOME'), ['CODEX_HOME']);
      assert.equal(env.HOME, home);
      assert.equal(env.USERPROFILE, home);
      assert.ok(env.SWITCHBOARD_DATA_DIR.startsWith(home + path.sep));
      assert.notEqual(env.SWITCHBOARD_DATA_DIR, inheritedHome);
      assert.equal(env.SWITCHBOARD_TRIGGERS_DIR, path.join(env.SWITCHBOARD_DATA_DIR, 'triggers'));
      assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
      assert.equal(env.KEEP_ME, 'retained');
      if (key) assert.equal(inherited[key], inheritedHome);
    });
  }
}

for (const [name, buildEnv] of launchers) {
  test(name + ' drops inherited shell startup variables and points XDG roots at the disposable home', t => {
    const home = temporaryHome(t);
    const outside = path.join(home, 'inherited-state');
    const inherited = Object.freeze({
      ZDOTDIR: outside, BASH_ENV: path.join(outside, 'bashenv'), ENV: path.join(outside, 'shenv'),
      zdotdir: outside, XDG_STATE_HOME: outside, XDG_DATA_HOME: outside, XDG_CACHE_HOME: outside,
      XDG_CONFIG_HOME: outside, KEEP_ME: 'retained',
    });
    const env = buildEnv(home, inherited);
    for (const key of ['ZDOTDIR', 'BASH_ENV', 'ENV']) {
      assert.deepEqual(Object.keys(env).filter(k => k.toUpperCase() === key), [], key + ' must be dropped');
    }
    assert.equal(env.XDG_STATE_HOME, path.join(home, '.local', 'state'));
    assert.equal(env.XDG_DATA_HOME, path.join(home, '.local', 'share'));
    assert.equal(env.XDG_CACHE_HOME, path.join(home, '.cache'));
    assert.equal(env.XDG_CONFIG_HOME, path.join(home, '.config'));
    assert.equal(env.KEEP_ME, 'retained');
  });
}

test('default launch keeps the caller shell startup variables', t => {
  const home = temporaryHome(t);
  const env = Object.freeze({ ZDOTDIR: path.join(home, 'z'), BASH_ENV: path.join(home, 'b') });
  const out = buildLaunch({ pr: 1314, home, env }).env;
  assert.equal(out.ZDOTDIR, env.ZDOTDIR);
  assert.equal(out.BASH_ENV, env.BASH_ENV);
});

test('default launch preserves the caller Codex home', t => {
  const home = temporaryHome(t);
  const env = Object.freeze({ CODEX_HOME: path.join(home, 'inherited-state') });
  assert.equal(buildLaunch({ pr: 1314, home, env }).env.CODEX_HOME, env.CODEX_HOME);
});

for (const allowClaude of [false, true]) {
  test('isolated command lookup refuses Codex with ALLOW_CLAUDE=' + allowClaude, t => {
    const home = temporaryHome(t);
    const bin = path.join(home, 'bin');
    writeRefusingStubs(home, { allowClaude });
    for (const suffix of ['', '.cmd', '.ps1']) {
      assert.ok(fs.existsSync(path.join(bin, 'codex' + suffix)), 'Codex refusing stub must exist: ' + suffix);
      assert.equal(fs.existsSync(path.join(bin, 'claude' + suffix)), !allowClaude);
    }
    const fallback = path.join(home, 'fallback');
    fs.mkdirSync(fallback);
    for (const command of ['codex', 'claude']) {
      fs.writeFileSync(path.join(fallback, command + '.cmd'), '@echo fallback\r\n@exit /b 0\r\n');
      fs.writeFileSync(path.join(fallback, command), '#!/bin/sh\necho fallback\nexit 0\n', { mode: 0o755 });
    }
    const config = buildLaunch({ pr: 1314, isolated: true, allowClaude, tempHome: home,
      env: { SystemRoot: process.env.SystemRoot, PATH: fallback, PATHEXT: '.COM;.EXE;.BAT;.CMD' } });
    assert.equal(config.env.PATH.split(path.delimiter)[0], bin);
    const execute = command => process.platform === 'win32'
      ? spawnSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', command],
        { cwd: home, env: config.env, encoding: 'utf8', timeout: 10000 })
      : spawnSync('/bin/sh', ['-c', command], { cwd: home, env: config.env, encoding: 'utf8', timeout: 10000 });
    const codex = execute('codex');
    assert.ifError(codex.error);
    assert.equal(codex.status, 1);
    assert.match(codex.stderr, /codex is disabled in isolated test-pr mode/);
    assert.equal(codex.stdout, '');
    const claude = execute('claude');
    assert.ifError(claude.error);
    assert.equal(claude.status, allowClaude ? 0 : 1);
    if (allowClaude) assert.equal(claude.stdout.trim(), 'fallback');
    else assert.match(claude.stderr, /claude is disabled in isolated test-pr mode/);
  });
}
