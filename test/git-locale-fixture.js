'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { fixture, savedEnv } = require('./git-discovery-fixture');

const DISCOVERY = ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'];

function isolateGitSuite() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-git-home-')));
  const config = path.join(root, '.gitconfig');
  fs.writeFileSync(config, '');
  const values = Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith('GIT_') || k.startsWith('HUSKY')).map(k => [k, undefined]));
  Object.assign(values,{ HOME:root, USERPROFILE:root, XDG_CONFIG_HOME:root, GIT_CONFIG_GLOBAL:config, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_COUNT:'1', GIT_CONFIG_KEY_0:'core.hooksPath', GIT_CONFIG_VALUE_0:'/dev/null', LC_ALL:process.env.LC_ALL, LC_MESSAGES:process.env.LC_MESSAGES, LANG:process.env.LANG, LANGUAGE:process.env.LANGUAGE });
  savedEnv({ after: fn => require('node:test').after(fn) },values);
  require('node:test').after(() => fs.rmSync(root,{recursive:true,force:true}));
}

function realFixture(t) {
  const f = fixture(t);
  const home = path.join(f.root, 'home');
  fs.mkdirSync(home);
  const config = path.join(home, '.gitconfig');
  fs.writeFileSync(config, '');
  const clear = Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith('GIT_') || k.startsWith('HUSKY')).map(k => [k, undefined]));
  savedEnv(t, { ...clear, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CEILING_DIRECTORIES: f.root });
  return f;
}

function raw(cwd, args = DISCOVERY, env = process.env, encoding = 'utf8') {
  return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding });
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env: process.env, encoding: 'utf8' });
}

function frenchLocale(t, cwd) {
  const locales = spawnSync('locale', ['-a'], { cwd, env: process.env, encoding: 'utf8' });
  if (locales.error || locales.status !== 0) { t.skip('locale -a unavailable on this platform'); return null; }
  const locale = locales.stdout.split(/\r?\n/).find(v => /^fr_FR\.(utf-?8)$/i.test(v));
  if (!locale) { t.skip('locale -a lists no fr_FR UTF-8 locale'); return null; }
  const english = raw(cwd, DISCOVERY, { ...process.env, LANG: 'C', LC_ALL: 'C', LC_MESSAGES: 'C', LANGUAGE: 'C' });
  const french = raw(cwd, DISCOVERY, { ...process.env, LANG: locale, LC_ALL: locale, LC_MESSAGES: locale, LANGUAGE: 'fr' });
  if (english.status !== 128 || french.status !== 128 || !/dépôt/.test(french.stderr) || french.stderr === english.stderr) {
    t.skip('Git lacks French diagnostic translations for the installed locale'); return null;
  }
  return locale;
}

module.exports = { realFixture, raw, git, frenchLocale, DISCOVERY, isolateGitSuite };
