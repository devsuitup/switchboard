'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

function validatePr(pr) {
  if (!/^\d+$/.test(String(pr ?? ''))) throw new Error('PR must be numeric: task test-pr PR=<number>');
}

function validateIsolated(value) {
  if (![undefined, '', '0', '1'].includes(value)) throw new Error('ISOLATED must be 1 or 0: task test-pr PR=<number> ISOLATED=<1|0>');
  return value === '1';
}

function validateAllowClaude(value, isolated) {
  if (![undefined, '', '0', '1'].includes(value)) throw new Error('ALLOW_CLAUDE must be 1 or 0: task test-pr PR=<number> ISOLATED=1 ALLOW_CLAUDE=<1|0>');
  if (value === '1' && !isolated) throw new Error('ALLOW_CLAUDE=1 requires ISOLATED=1; default mode already uses the real claude');
  return value === '1';
}

function buildLaunch({ pr, home = process.env.HOME || os.homedir(), env = process.env,
  isolated = false, allowClaude = false, tempHome, port = 9223 }) {
  validatePr(pr);
  const pathKeys = Object.keys(env).filter(key => key.toUpperCase() === 'PATH').sort();
  if (pathKeys.length) {
    const originalPath = env[Object.hasOwn(env, 'PATH') ? 'PATH' : pathKeys[0]];
    env = { ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'PATH')), PATH: originalPath };
  }
  const data = path.join(home, `.switchboard-dev-pr${pr}`);
  if (!isolated) {
    return { env: { ...env, SWITCHBOARD_DATA_DIR: data, SWITCHBOARD_TRIGGERS_DIR: path.join(data, 'triggers') },
      args: ['.', '--no-sandbox'] };
  }
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Debug port must be an integer from 1 to 65535');
  if (!tempHome) throw new Error('Isolated mode requires a temporary home');
  const inherited = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(CLAUDE|GIT_)|^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|PATH|ORIGINAL_PATH|ELECTRON_RUN_AS_NODE|HISTFILE)$/i.test(key)));
  const originalPath = env.PATH || '';
  const fixtureData = path.join(tempHome, '.switchboard-test-pr');
  return {
    env: {
      ...inherited,
      HOME: tempHome,
      USERPROFILE: tempHome,
      APPDATA: path.join(tempHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(tempHome, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      XDG_DATA_HOME: path.join(tempHome, '.local', 'share'),
      XDG_CACHE_HOME: path.join(tempHome, '.cache'),
      PATH: allowClaude ? originalPath : path.join(tempHome, 'bin') + path.delimiter + originalPath,
      SWITCHBOARD_DATA_DIR: fixtureData,
      SWITCHBOARD_TRIGGERS_DIR: path.join(fixtureData, 'triggers'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(tempHome, '.gitconfig'),
    },
    args: ['.', '--no-sandbox', `--remote-debugging-port=${Number(port)}`],
  };
}

function prepareFixtures(home, env, { allowClaude = false } = {}) {
  const { makeRepo, makePlainDir } = require('../e2e/fixtures');
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'SWITCHBOARD_DATA_DIR', 'SWITCHBOARD_TRIGGERS_DIR']) fs.mkdirSync(env[key], { recursive: true });
  if (!allowClaude) {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const message = 'claude is disabled in isolated test-pr mode';
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho '${message}' >&2\nexit 1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@echo off\r\necho ${message} 1>&2\r\nexit /b 1\r\n`);
    fs.writeFileSync(path.join(bin, 'claude.ps1'), `[Console]::Error.WriteLine('${message}')\nexit 1\n`);
  }
  const gitEnv = { ...env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const repo = makeRepo(home, gitEnv, { 'README.md': '# Fixture repository\n' });
  const plain = makePlainDir(home);
  return { repo, plain };
}

function lockChanged(base, head) {
  if (base === '' || head === '') return base !== head;
  const normalize = (text) => {
    const lock = JSON.parse(text);
    delete lock.version;
    if (lock.packages?.['']) delete lock.packages[''].version;
    return lock;
  };
  return !isDeepStrictEqual(normalize(base), normalize(head));
}

function statLink(target) {
  try { return fs.lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function unlinkNodeModules(worktree) {
  const target = path.join(worktree, 'node_modules');
  if (statLink(target)?.isSymbolicLink()) {
    if (process.platform === 'win32') fs.rmdirSync(target);
    else fs.unlinkSync(target);
  }
}

function linkNodeModules(worktree, source, { platform = process.platform, symlink = fs.symlinkSync } = {}) {
  const target = path.join(worktree, 'node_modules');
  const stat = statLink(target);
  if (stat && !stat.isSymbolicLink()) return;
  unlinkNodeModules(worktree);
  symlink(path.resolve(source), target, platform === 'win32' ? 'junction' : 'dir');
}

function runCommand(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 180000, ...options });
}

function parseBundleScript(script) {
  const [command, ...args] = typeof script === 'string' ? script.trim().split(/\s+/) : [];
  if (command !== 'esbuild') throw new Error('Unsupported bundle command: expected esbuild');
  const options = { entryPoints: [] };
  for (const arg of args) {
    if (arg === '--bundle' || arg === '--minify') {
      const key = arg.slice(2);
      if (Object.hasOwn(options, key)) throw new Error(`Unsupported duplicate bundle argument: ${arg}`);
      options[key] = true;
    } else if (/^--(outfile|format|platform)=[\w./\\-]+$/.test(arg)) {
      const [key, value] = arg.slice(2).split('=');
      if (Object.hasOwn(options, key)) throw new Error(`Unsupported duplicate bundle argument: ${arg}`);
      options[key] = value;
    } else if (!arg.startsWith('-') && /^[\w./\\-]+$/.test(arg)) {
      options.entryPoints.push(arg);
    } else {
      throw new Error(`Unsupported bundle argument: ${arg}`);
    }
  }
  if (!options.entryPoints.length) throw new Error('Bundle script requires an entry point');
  return options;
}

function cleanWorktree({ checkout, pr, home = process.env.HOME || os.homedir(), run = runCommand }) {
  validatePr(pr);
  const worktree = path.join(checkout, '.worktrees', `pr-${pr}-test`);
  unlinkNodeModules(worktree);
  run('git', ['worktree', 'remove', '--force', worktree], { cwd: checkout, stdio: 'inherit' });
  fs.rmSync(path.join(home, `.switchboard-dev-pr${pr}`), { recursive: true, force: true });
}

function runElectron(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, stdio: 'inherit' });
    const stop = () => {
      if (process.platform === 'win32') {
        if (child.pid) {
          try { runCommand('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill(); }
        }
      } else {
        child.kill('SIGTERM');
      }
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const detach = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    };
    child.once('error', (error) => { detach(); reject(error); });
    child.once('close', (code) => { detach(); resolve(code ?? 1); });
  });
}

async function main({ checkout = path.resolve(__dirname, '..'), env = process.env,
  clean = false, run = runCommand, launch = runElectron, fixtures = prepareFixtures,
  log = console.log, warn = console.error } = {}) {
  const pr = env.PR;
  validatePr(pr);
  const isolated = validateIsolated(env.ISOLATED);
  const allowClaude = validateAllowClaude(env.ALLOW_CLAUDE, isolated);
  const home = env.HOME || os.homedir();
  if (clean) {
    cleanWorktree({ checkout, pr, home, run });
    log(`Cleaned up worktree and data dir for PR #${pr}`);
    return 0;
  }
  buildLaunch({ pr, home, env, isolated, allowClaude, tempHome: os.tmpdir(), port: env.DEBUG_PORT || 9223 });
  const worktree = path.join(checkout, '.worktrees', `pr-${pr}-test`);
  const git = (args, cwd = checkout) => run('git', args, { cwd });
  git(['fetch', 'origin', `pull/${pr}/head`]);
  const sha = git(['rev-parse', 'FETCH_HEAD']).trim();
  if (fs.existsSync(worktree)) {
    git(['checkout', '--detach', sha], worktree);
  } else {
    git(['worktree', 'add', '--detach', worktree, sha]);
  }
  git(['fetch', 'origin', 'main']);
  const readLock = ref => git(['ls-tree', '--name-only', ref, '--', 'package-lock.json']).trim()
    ? git(['show', `${ref}:package-lock.json`]) : '';
  if (lockChanged(readLock('origin/main'), readLock(sha))) {
    warn('WARNING: package-lock.json differs on this PR - shared node_modules may be invalid.');
    warn(`Stop and install the reviewed dependencies in ${worktree} before launching.`);
  }
  linkNodeModules(worktree, path.join(checkout, 'node_modules'));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(worktree, 'package.json'), 'utf8'));
    const options = parseBundleScript(pkg.scripts?.['bundle:codemirror']);
    run(process.execPath, ['-e', 'require(process.argv[1]).buildSync(JSON.parse(process.argv[2]))',
      path.join(worktree, 'node_modules', 'esbuild'), JSON.stringify(options)], { cwd: worktree, stdio: 'inherit' });
  } catch (error) {
    throw new Error(`Failed to build CodeMirror bundle in ${worktree}: ${error.message}`);
  }
  let tempHome;
  try {
    if (isolated) tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sb-pr-${pr}-`)));
    const config = buildLaunch({ pr, home, env, isolated, allowClaude, tempHome, port: env.DEBUG_PORT || 9223 });
    if (isolated) {
      fixtures(tempHome, config.env, { allowClaude });
      log(`Temporary HOME: ${tempHome}`);
      log(allowClaude
        ? 'Real claude enabled; starts logged out. Login is stored in the temporary HOME and deleted on exit.'
        : 'Real claude disabled (refusing stub first on PATH).');
      log(`--remote-debugging-port=${env.DEBUG_PORT || 9223} (http://127.0.0.1:${env.DEBUG_PORT || 9223}/json)`);
    }
    log(`Launching PR #${pr} from ${worktree} (${isolated ? 'fixture HOME + DB + triggers' : 'isolated DB + triggers'})...`);
    warn("Do not pipe this command's output into a reader that exits early - see docs/testing-a-pr.md.");
    const executable = require(path.join(worktree, 'node_modules', 'electron'));
    return await launch(executable, config.args, { cwd: worktree, env: config.env });
  } finally {
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (require.main === module) {
  main({ clean: process.argv.includes('--clean') }).then(code => { process.exitCode = code; }, error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildLaunch, prepareFixtures, lockChanged, linkNodeModules, unlinkNodeModules, cleanWorktree, parseBundleScript, main };
