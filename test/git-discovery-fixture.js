'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FRENCH = [
  "fatal: ni ceci ni aucun de ses répertoires parents n'est un dépôt git : .git",
  "fatal: ni ceci ni aucun de ses répertoires parents (jusqu'au point de montage /) n'est un dépôt git Arrêt à la limite du système de fichiers (GIT_DISCOVERY_ACROSS_FILESYSTEM n'est pas défini).",
];
const snapshots = new WeakMap();

function savedEnv(t, values) {
  const apply = env => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  let before = snapshots.get(t);
  if (!before) {
    before = {};
    snapshots.set(t, before);
    t.after(() => apply(before));
  }
  for (const key of Object.keys(values)) if (!Object.hasOwn(before, key)) before[key] = process.env[key];
  apply(values);
}

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-discovery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'ancestor', 'notes');
  fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(cwd, 'x.md');
  fs.writeFileSync(file, 'été\n');
  savedEnv(t, { GIT_CEILING_DIRECTORIES: root, GIT_DISCOVERY_ACROSS_FILESYSTEM: undefined });
  return { root, cwd, file, ancestor: path.dirname(cwd) };
}

function assertAbsent(cwd, ceiling) {
  assert.ok(fs.statSync(cwd).isDirectory(), `stat ${cwd}: expected directory`);
  for (let dir = fs.realpathSync.native(cwd); dir !== ceiling; dir = path.dirname(dir)) {
    assert.notEqual(path.dirname(dir), dir, `missing ceiling ${ceiling}`);
    const entry = path.join(dir, '.git');
    let st;
    try { st = fs.lstatSync(entry); } catch (err) {
      assert.ok(['ENOENT', 'ENOTDIR'].includes(err.code), `lstat ${entry}: ${err.code}`);
      continue;
    }
    assert.ok(st.isDirectory(), `${entry}: qualifying file/symlink/unsupported entry`);
    assert.throws(() => fs.lstatSync(path.join(entry, 'HEAD')), err => err.code === 'ENOENT', `${entry}/HEAD: qualifying or uncertain entry`);
  }
}

function shape(type = 'directory', dev = 10) {
  return { dev, isDirectory: () => type === 'directory', isFile: () => type === 'file', isSymbolicLink: () => type === 'symlink' };
}

function synthetic(p = path, root = p.parse(p.resolve('repo')).root) {
  const cwd = p.join(root, 'repo', 'nested', 'notes');
  const ancestor = p.dirname(cwd);
  const repo = p.dirname(ancestor);
  const entries = new Map();
  const failures = new Map();
  const devices = new Map();
  const realpaths = new Map();
  const reads = [];
  const op = (name, value) => {
    reads.push([name, value]);
    const fail = failures.get(name + ':' + value);
    if (fail) throw Object.assign(new Error('injected ' + value), fail === 'unknown' ? {} : { code: fail });
  };
  const fsOps = {
    realpath(value) { op('realpath', value); return realpaths.has(value) ? realpaths.get(value) : value; },
    stat(value) { op('stat', value); return { ...shape(), dev: devices.has(value) ? devices.get(value) : 10 }; },
    lstat(value) {
      op('lstat', value);
      if (entries.has(value)) return shape(entries.get(value));
      throw Object.assign(new Error('missing ' + value), { code: 'ENOENT' });
    },
  };
  return { p, root, cwd, ancestor, repo, entries, failures, devices, realpaths, reads, fsOps };
}

function discoveryCases(p = path, root) {
  const cases = [];
  const add = (label, setup, expected) => {
    const s = synthetic(p, root);
    const env = { GIT_CEILING_DIRECTORIES: s.root };
    setup(s, env);
    cases.push({ label, ...s, env, expected });
  };
  add('empty region', () => {}, false);
  for (const type of ['file', 'symlink', 'directory']) add('qualifying ' + type, s => {
    s.entries.set(p.join(s.ancestor, '.git'), type);
    if (type === 'directory') s.entries.set(p.join(s.ancestor, '.git', 'HEAD'), 'symlink');
  }, true);
  add('unsupported entry', s => s.entries.set(p.join(s.cwd, '.git'), 'socket'), null);
  add('missing entry metadata', s => { s.fsOps.lstat = () => undefined; }, null);
  add('empty own and ancestor directories', s => {
    s.entries.set(p.join(s.cwd, '.git'), 'directory');
    s.entries.set(p.join(s.ancestor, '.git'), 'directory');
  }, false);
  add('empty directory does not hide higher HEAD', s => {
    s.entries.set(p.join(s.cwd, '.git'), 'directory');
    s.entries.set(p.join(s.repo, '.git'), 'directory');
    s.entries.set(p.join(s.repo, '.git', 'HEAD'), 'file');
  }, true);
  for (const code of ['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'unknown']) add('HEAD ' + code, s => {
    s.entries.set(p.join(s.cwd, '.git'), 'directory');
    s.failures.set('lstat:' + p.join(s.cwd, '.git', 'HEAD'), code);
  }, null);
  for (const name of ['stat', 'realpath', 'lstat']) add(name + ' failure', s => s.failures.set(name + ':' + (name === 'lstat' ? p.join(s.ancestor, '.git') : s.cwd), 'EACCES'), null);
  for (const name of ['stat', 'realpath', 'lstat']) add('missing operation ' + name, s => delete s.fsOps[name], null);
  add('not directory', s => { s.fsOps.stat = () => shape('file'); }, null);
  add('unusable cwd dev', s => s.devices.set(s.cwd, undefined), null);
  add('unusable parent dev', s => s.devices.set(s.ancestor, NaN), null);
  add('parent stat failure', s => s.failures.set('stat:' + s.ancestor, 'EACCES'), null);
  const booleans = [[undefined,false],['',false],['0',false],['false',false],['no',false],['off',false],['FaLsE',false],['-0k',false],['1',true],['2',true],['true',true],['yes',true],['on',true],['TrUe',true],['+2k',true],['-1M',true],['1g',true],['invalid',null],['1kb',null],['999999999999999999999999',null]];
  booleans.push(['0x0',false],['0x10',true],['+0x1',true],[' 1',true],['010',true],['08',null],['1 ',null],['-2147483648',null]);
  for (const [value, across] of booleans) add('device boolean ' + value, (s, env) => {
    env.GIT_DISCOVERY_ACROSS_FILESYSTEM = value;
    s.devices.set(s.ancestor, 20);
    s.entries.set(p.join(s.ancestor, '.git'), 'file');
  }, across === null ? null : across);
  add('starting device entry first', s => {
    s.devices.set(s.ancestor,20);
    s.entries.set(p.join(s.cwd,'.git'),'file');
  }, true);
  const delim = p.delimiter;
  for (const mode of ['nearest', 'equal', 'equal-and-repo', 'sibling', 'textual-prefix', 'relative', 'missing', 'trailing', 'symlink-before', 'symlink-after', 'dot-after', 'excluded-parent']) add('ceiling ' + mode, (s, env) => {
    s.entries.set(p.join(s.repo, '.git'), 'file');
    const alias = p.join(s.root, 'alias');
    s.realpaths.set(alias, s.repo);
    let ceiling = s.repo;
    if (mode === 'nearest') ceiling = [s.root,s.repo,s.ancestor].join(delim);
    if (mode === 'equal') ceiling = [s.cwd,s.root].join(delim);
    if (mode === 'equal-and-repo') ceiling = [s.cwd,s.repo,s.root].join(delim);
    if (mode === 'textual-prefix') ceiling = [s.ancestor.slice(0,-2),s.repo,s.root].join(delim);
    if (mode === 'sibling') ceiling = [s.repo+'-sibling',s.root].join(delim);
    if (mode === 'relative') ceiling = ['repo',s.root].join(delim);
    if (mode === 'missing') { ceiling = [alias,s.root].join(delim); s.failures.set('realpath:'+alias,'ENOENT'); }
    if (mode === 'trailing') ceiling = s.repo+p.sep;
    if (mode === 'symlink-before') ceiling = alias;
    if (mode === 'symlink-after') ceiling = ['',alias,s.root].join(delim);
    if (mode === 'dot-after') ceiling = ['',s.repo+p.sep+'.',s.root].join(delim);
    if (mode === 'excluded-parent') s.failures.set('stat:'+s.repo,'EACCES');
    env.GIT_CEILING_DIRECTORIES = ceiling;
  }, ['nearest','equal-and-repo','textual-prefix','trailing','symlink-before','excluded-parent'].includes(mode) ? false : true);
  return cases;
}

async function emptyAncestorMatrix(t) {
  const { cwd, ancestor, file } = fixture(t);
  fs.mkdirSync(path.join(cwd,'.git'));
  fs.mkdirSync(path.join(ancestor,'.git'));
  const { readTouchedChangesFile } = require('../git-changes-file');
  const { createGitChangesRunner, gitEntryAtOrAbove } = require('../git-changes-runner');
  for (const stderr of [...FRENCH, 'fatal: not a git repository', '']) {
    const runGit=async()=>({code:128,stdout:'',stderr});
    await t.test('walk: '+(stderr || 'empty stderr'),()=>assert.equal(gitEntryAtOrAbove(cwd),false));
    await t.test('Touched: '+(stderr || 'empty stderr'),async()=>assert.deepEqual(await readTouchedChangesFile({absolutePath:file,maxBytes:1024},{runGit}),{ok:true,git:false}));
    await t.test('Changes: '+(stderr || 'empty stderr'),async()=>assert.deepEqual(await createGitChangesRunner({kind:'local',cwd,exec:runGit}).isWorkTree(),{ok:true,isRepo:false}));
    await t.test('status: '+(stderr || 'empty stderr'),async()=>assert.equal((await createGitChangesRunner({kind:'local',cwd,exec:runGit}).status()).reason,'not-a-repo'));
  }
  fs.writeFileSync(path.join(ancestor,'.git','HEAD'),'ref: refs/heads/main\n');
  assert.equal(gitEntryAtOrAbove(cwd),true);
  const runGit=async()=>({code:128,stdout:'',stderr:'retained'});
  assert.deepEqual(await readTouchedChangesFile({absolutePath:file,maxBytes:1024},{runGit}),{ok:false,reason:'git',error:'retained'});
  assert.deepEqual(await createGitChangesRunner({kind:'local',cwd,exec:runGit}).isWorkTree(),{ok:false,error:'retained'});
}

module.exports = { FRENCH, fixture, assertAbsent, savedEnv, shape, synthetic, discoveryCases, emptyAncestorMatrix };
