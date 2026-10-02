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

function escapeForCmd(arg) {
  let s = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  return s.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

// How to run `claude <argv>` on Windows without a shell profile: the .exe itself, the .exe or node + cli.js an npm
// .cmd shim points to, or cmd.exe over the shim. Only PATHEXT names count: npm also leaves an extensionless sh shim. Returns { program, args, verbatim } or { error }.
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
  const line = [found, ...argv].map(escapeForCmd).join(' ');
  return { program: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

module.exports = { resolveWindowsClaude, escapeForCmd };
