// see .ai/contexts/bg-agents.md ("Running the CLI")
'use strict';

const fs = require('fs');
const path = require('path');

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function findOnPath(name, { pathEnv, pathExt, exists, sep }) {
  const exts = String(pathExt || '').split(';').filter(Boolean);
  for (const dir of String(pathEnv || '').split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.win32.join(dir, name + ext.toLowerCase());
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function escapeForCmd(arg, passes = 2) {
  let s = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  for (let pass = 0; pass < passes; pass++) s = s.replace(CMD_META, '^$1');
  return s;
}

function resolveWindowsClaude(argv, env = {}, deps = {}) {
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const found = findOnPath('claude', {
    pathEnv: env.PATH || env.Path, pathExt: env.PATHEXT || '.COM;.EXE;.BAT;.CMD', exists, sep: ';',
  });
  if (!found) return { error: 'claude was not found on PATH' };
  const ext = path.win32.extname(found).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { program: found, args: argv, verbatim: false };
  if (ext !== '.cmd' && ext !== '.bat') return { error: `cannot run ${found}` };

  let shim = '';
  try { shim = readFile(found); } catch {}
  const m = /"%dp0%\\([^"]+\.(?:js|exe))"/i.exec(shim);
  if (m) {
    const dir = path.win32.dirname(found);
    const script = path.win32.join(dir, m[1]);
    if (/\.exe$/i.test(script) && exists(script)) return { program: script, args: argv, verbatim: false };
    const bundled = path.win32.join(dir, 'node.exe');
    const node = exists(bundled) ? bundled : findOnPath('node', {
      pathEnv: env.PATH || env.Path, pathExt: '.EXE', exists, sep: ';',
    });
    if (node && exists(script)) return { program: node, args: [script, ...argv], verbatim: false };
  }
  if (argv.some((a) => /[\r\n]/.test(a))) {
    return { error: 'a multi-line argument cannot go through a claude.cmd shim; install claude with its native installer or pick a bash profile' };
  }
  const line = [found, ...argv].map(arg => escapeForCmd(arg)).join(' ');
  return { program: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

function cmdEscapePasses(env = {}, { cwd, wrapped = false, exists = p => fs.existsSync(p) } = {}) {
  if (wrapped) return 1;
  const found = findOnPath('claude', {
    pathEnv: [cwd, env.PATH || env.Path].filter(Boolean).join(';'), pathExt: env.PATHEXT || '.COM;.EXE;.BAT;.CMD', exists, sep: ';',
  });
  return /\.(cmd|bat)$/i.test(found || '') ? 2 : 1;
}

function powershellEscapePasses(env = {}, { wrapped = false, exists = p => fs.existsSync(p) } = {}) {
  if (wrapped) return 1;
  const found = findOnPath('claude', {
    pathEnv: env.PATH || env.Path, pathExt: `.PS1;${env.PATHEXT || '.COM;.EXE;.BAT;.CMD'}`, exists, sep: ';',
  });
  return /\.(cmd|bat)$/i.test(found || '') ? 2 : 1;
}

module.exports = { resolveWindowsClaude, escapeForCmd, cmdEscapePasses, powershellEscapePasses };
