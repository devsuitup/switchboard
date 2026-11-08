'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STRONG_MARKERS = {
  platform: /process\.platform|os\.platform\(\)|\bplatform\s*:\s*['"](win32|linux|darwin)|['"]win32['"]|path\.win32|path\.posix|isWindows|IS_WINDOWS/,
  winpath: /[A-Za-z]:\\|\b[A-Za-z]:\/|RUNNER~1|~1[\/]|\\\\\?\\|\bUNC\b/,
  conpty: /conpty|useConptyDll|node-pty/i,
  shell: /cmd\.exe|powershell|pwsh|\.bat['"]|\.cmd['"]|COMSPEC|ComSpec/,
  links: /junction|symlink|reparse|EPERM|EBUSY|EACCES/,
  env: /USERPROFILE|LOCALAPPDATA|APPDATA|\bTEMP\b|process\.env\.TMP\b|HOMEDRIVE/,
  crlf: /\\r\\n|CRLF/,
  case: /toLowerCase\(\)[^;\n]{0,40}(path|dir|cwd)|case-?insensitive/i,
  optIn: /\/\/\s*platform:\s*windows\b/i,
  processes: /\b(?:spawn(?:Sync)?|execFile(?:Sync)?)\s*\(|\.kill\s*\(/,
  filesystem: /\bfs\.(?:promises\.)?rename(?:Sync)?\s*\(|\brealpath(?:Sync)?\b|\bbirthtime(?:Ms|Ns)?\b|\bbigint\s*:\s*true/,
};
const MIN_PLATFORM_TESTS = 150;

function selectPlatformTests(files, { root = path.resolve(__dirname, '..'), minimum = MIN_PLATFORM_TESTS } = {}) {
  const sources = new Map();
  const read = file => {
    if (!sources.has(file)) sources.set(file, fs.readFileSync(file, 'utf8').replace(/\r/g, ''));
    return sources.get(file);
  };
  const testDir = path.join(root, 'test') + path.sep;
  const dependencies = new Map();
  const relativeDependencies = file => {
    if (!dependencies.has(file)) {
      const resolved = [];
      for (const match of read(file).matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        const base = path.resolve(path.dirname(file), match[1]);
        const dependency = [base, base + '.js', base + '.cjs', path.join(base, 'index.js')]
          .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (!dependency || dependency.includes(path.sep + 'node_modules' + path.sep)) continue;
        resolved.push(dependency);
      }
      dependencies.set(file, resolved);
    }
    return dependencies.get(file);
  };
  const reachesPlatform = (file, visited) => {
    if (visited.has(file)) return false;
    visited.add(file);
    return relativeDependencies(file).some(dependency =>
      (!dependency.startsWith(testDir) && /process\.platform/.test(read(dependency))) || reachesPlatform(dependency, visited));
  };
  const selected = files.filter(file => {
    const absolute = path.resolve(root, file);
    return Object.values(STRONG_MARKERS).some(marker => marker.test(read(absolute))) || reachesPlatform(absolute, new Set());
  });
  if (selected.length < minimum) {
    throw new Error(`platform-only: ${selected.length} of ${files.length} test files; below the minimum of ${minimum}`);
  }
  return selected;
}

module.exports = { STRONG_MARKERS, MIN_PLATFORM_TESTS, selectPlatformTests };
