'use strict';

// Loads functions out of public/app.js into a jsdom window's VM context.
// app.js cannot be evaluated whole (module scope builds real panels and
// terminals), so a test names the top-level functions and one-line
// declarations it needs and gets the shipped source of exactly those.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_PATH = path.join(__dirname, '..', 'public', 'app.js');

function readAppSource() {
  return fs.readFileSync(APP_PATH, 'utf8');
}

function skipString(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      i = skipBalanced(src, i + 1, '{', '}') + 1;
      continue;
    }
    if (c === quote) return i;
    i++;
  }
  throw new Error('unterminated string literal in app.js');
}

function skipRegex(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') break;
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i;
    i++;
  }
  throw new Error('unterminated regular expression literal in app.js');
}

function skipBalanced(src, open, openCh, closeCh) {
  let depth = 0;
  let prev = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); prev = c; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '/' && (/[(,=:[!&|?{};]/.test(prev) || /\b(?:return|typeof|case|throw|void|delete|in|of)\s*$/.test(src.slice(Math.max(0, i - 10), i)))) {
      i = skipRegex(src, i);
      prev = '/';
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) { depth--; if (depth === 0) return i; }
    if (!/\s/.test(c)) prev = c;
  }
  throw new Error(`unbalanced ${openCh}${closeCh} in app.js`);
}

function extractFunction(src, name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`public/app.js must define a top-level function ${name}`);
  const paramsOpen = m.index + m[0].length - 1;
  const paramsClose = skipBalanced(src, paramsOpen, '(', ')');
  const bodyOpen = src.indexOf('{', paramsClose);
  const bodyClose = skipBalanced(src, bodyOpen, '{', '}');
  const slice = src.slice(m.index, bodyClose + 1);
  const next = src[bodyClose + 1];
  if (next !== undefined && next !== '\n' && next !== '\r') {
    throw new Error(`extraction of ${name} from app.js ended mid-line; the brace scanner lost track`);
  }
  try {
    new vm.Script(slice);
  } catch (err) {
    throw new Error(`extraction of ${name} from app.js does not compile: ${err.message}`);
  }
  return slice;
}

function extractDeclaration(src, name) {
  const re = new RegExp(`^(let|const) ${name}\\b[^\\n]*;[ \\t]*$`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`public/app.js must declare ${name} on a single line`);
  return m[0];
}

// Evaluates the named declarations and functions of public/app.js in `context`
// (a jsdom VM context) and returns the functions by name.
function loadAppFunctions(context, { functions, declarations = [], sourcePath = APP_PATH }) {
  const src = fs.readFileSync(sourcePath, 'utf8');
  const parts = [
    ...declarations.map((n) => extractDeclaration(src, n)),
    ...functions.map((n) => extractFunction(src, n)),
  ];
  vm.runInContext(parts.join('\n'), context, { filename: sourcePath });
  const out = {};
  for (const n of functions) out[n] = vm.runInContext(n, context);
  return out;
}

module.exports = { loadAppFunctions, extractFunction, extractDeclaration, readAppSource };
