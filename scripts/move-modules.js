'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isJavaScript, walk, appFiles, nodes, relativeRequires } = require('./module-paths');
const p = path.posix;

function validateMap(map) {
  if (!map || Array.isArray(map) || typeof map !== 'object') throw new Error('Expected an object mapping old paths to new paths');
  const destinations = new Set();
  for (const [old, target] of Object.entries(map)) {
    for (const value of [old, target]) {
      if (typeof value !== 'string' || value.includes('\\') || p.isAbsolute(value)
        || /^[A-Za-z]:/.test(value) || value.split('/').some((s) => !s || s === '.' || s === '..')
        || !value.endsWith('.js')) throw new Error(`Invalid module path: ${value}`);
    }
    if (p.basename(old) !== p.basename(target) || old === target || map[target]
      || destinations.has(target)) throw new Error(`Invalid move: ${old} -> ${target}`);
    destinations.add(target);
  }
  return map;
}

function originalFile(file, map) {
  return Object.keys(map).find((old) => map[old] === file) || file;
}

function relative(from, to) {
  const spec = p.relative(p.dirname(from), to);
  return spec.startsWith('.') ? spec : `./${spec}`;
}

function moduleTarget(file, spec, map, root) {
  const target = p.normalize(p.join(p.dirname(file), spec));
  for (const candidate of [target, `${target}.js`, `${target}/index.js`]) {
    if (map[candidate] || Object.values(map).includes(candidate)
      || (root && fs.existsSync(path.join(root, candidate)))) return candidate;
  }
  return target.endsWith('.js') ? target : `${target}.js`;
}

function alreadyRewritten(file, spec, map, root) {
  const current = moduleTarget(file, spec, map, root);
  return Object.values(map).includes(current)
    || (root && !map[current] && fs.existsSync(path.join(root, current)));
}

function rewrite(file, source, map, options = {}) {
  const edits = [];
  const before = originalFile(file, map);
  const add = (start, end, value, old) => {
    if (source.slice(start, end) !== value) edits.push({ start, end, value, old });
  };
  if (/\.(md|json)$/.test(file)) {
    for (const [old, target] of Object.entries(map)) {
      const escaped = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?<![\\w/.-])((?:\\.\\.?/)+)?${escaped}(?![\\w/.-])`, 'g');
      for (const match of source.matchAll(pattern)) {
        if (!match[1] && !old.includes('/')) continue;
        add(match.index, match.index + match[0].length, `${match[1] || ''}${target}`, match[0]);
      }
    }
  } else {
    const tree = nodes(source);
    const handled = new Set();
    const loaded = new Set();
    const stubNodes = new Set(tree.filter(({ node, parent }) => node.type === 'Literal'
      && typeof node.value === 'string' && node.value.startsWith('.')
      && ((parent?.type === 'Property' && parent.key === node && !parent.computed)
        || (parent?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator))
        || (parent?.type === 'SwitchCase' && parent.test === node)))
      .map(({ node }) => node));
    const stubValues = new Set([...stubNodes].map(node => node.value));
    const quote = (node, value) => `${source[node.range[0]]}${value}${source[node.range[0]]}`;
    for (const { node } of tree) {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression'
        || node.callee.object.name !== 'path' || node.callee.property.name !== 'join') continue;
      const [anchor, ...parts] = node.arguments;
      if (anchor?.type !== 'Identifier' || !['__dirname', 'ROOT'].includes(anchor.name)
        || !parts.length || !parts.every((n) => n.type === 'Literal' && typeof n.value === 'string')) continue;
      const base = anchor.name === 'ROOT' ? '' : p.dirname(before);
      const old = p.join(base, ...parts.map((n) => n.value));
      const currentBase = anchor.name === 'ROOT' ? '' : p.dirname(file);
      const current = p.join(currentBase, ...parts.map((n) => n.value));
      loaded.add(originalFile(Object.values(map).includes(current) ? current : old, map));
      if (Object.values(map).includes(current) || old.startsWith('../')) continue;
      if (map[old] || before !== file) {
        const nextBase = anchor.name === 'ROOT' ? '' : p.dirname(file);
        const dest = map[old] || old;
        const next = p.relative(nextBase, dest);
        const value = quote(parts[0], next);
        add(parts[0].range[0], parts.at(-1).range[1], value, parts.map((n) => n.value).join('/'));
        parts.forEach((n) => handled.add(n));
      }
    }
    const stubs = new Map();
    for (const old of loaded) {
      const content = options.sources?.[old];
      if (!content) continue;
      for (const spec of relativeRequires(content)) {
        if (!stubValues.has(spec.value)) continue;
        const currentFile = map[old] || old;
        const oldTarget = moduleTarget(old, spec.value, map, options.root);
        const from = alreadyRewritten(currentFile, spec.value, map, options.root)
          || oldTarget.startsWith('../') ? currentFile : old;
        const target = moduleTarget(from, spec.value, map, options.root);
        let next = relative(currentFile, map[target] || target);
        if (!spec.value.endsWith('.js')) next = next.replace(/\.js$/, '');
        if (stubs.has(spec.value) && stubs.get(spec.value) !== next) throw new Error(`${file}: ambiguous vm stub ${spec.value}`);
        stubs.set(spec.value, next);
      }
    }
    const loadedApp = [...loaded].some(old => !old.startsWith('test/') && isJavaScript(old) && options.sources?.[old]);
    if (file.startsWith('test/') && !loadedApp && stubValues.size) {
      const affected = new Set();
      for (const old of Object.keys(map)) {
        affected.add(`./${p.basename(old, '.js')}`);
        affected.add(`./${p.basename(old)}`);
        for (const spec of relativeRequires(options.sources?.[old] || '')) {
          affected.add(spec.value);
          const currentFile = map[old];
          const from = alreadyRewritten(currentFile, spec.value, map, options.root) ? currentFile : old;
          const target = originalFile(moduleTarget(from, spec.value, map, options.root), map);
          const originalSpec = relative(old, target);
          affected.add(spec.value.endsWith('.js') ? originalSpec : originalSpec.replace(/\.js$/, ''));
        }
      }
      for (const value of stubValues) {
        if (affected.has(value)) options.onWarning?.(`${file}: unassociated vm stub ${value}; helper/computed source loader requires manual review`);
      }
    }
    const requires = new Set(relativeRequires(source).map((n) => n.range[0]));
    for (const { node } of tree) {
      if (node.type !== 'Literal' || typeof node.value !== 'string' || handled.has(node)) continue;
      const value = node.value;
      let next = value;
      if (requires.has(node.range[0])) {
        const target = moduleTarget(before, value, map, options.root);
        if (!alreadyRewritten(file, value, map, options.root) && !target.startsWith('../')
          && (map[target] || before !== file)) {
          next = relative(file, map[target] || target);
          if (!value.endsWith('.js')) next = next.replace(/\.js$/, '');
        }
      } else if (stubNodes.has(node) && stubs.has(value)) {
        next = stubs.get(value);
      } else if (map[value]) {
        next = map[value];
      } else if (value.startsWith('.')) {
        const target = moduleTarget(before, value, map, options.root);
        if (map[target]) {
          next = relative(file, map[target]);
          if (!value.endsWith('.js')) next = next.replace(/\.js$/, '');
        }
      }
      if (next !== value) add(node.range[0], node.range[1], quote(node, next), value);
    }
  }
  options.onEdits?.(edits);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  }
  return source;
}

function run(argv) {
  let root = path.resolve(__dirname, '..');
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
    else throw new Error('usage: move-modules.js [--check] [--root <repository>]');
  }
  const map = validateMap(JSON.parse(fs.readFileSync(path.join(root, 'scripts/source-map.json'), 'utf8')));
  const files = [...new Set([...appFiles(root), ...walk(root, 'public'), ...walk(root, 'test'),
    ...walk(root, 'e2e'), ...walk(root, '.ai', (f) => /\.(md|json)$/.test(f)),
    ...walk(root, 'docs', (f) => f.endsWith('.md'))])];
  const sources = {};
  for (const file of files.filter(isJavaScript)) {
    sources[originalFile(file, map)] = fs.readFileSync(path.join(root, file), 'utf8');
  }
  const changes = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const output = rewrite(file, source, map, { root, sources, onWarning: warning => console.warn(`WARNING ${warning}`), onEdits(edits) {
      for (const edit of edits) {
        const line = source.slice(0, edit.start).split('\n').length;
        console.log(`${file}:${line}: ${edit.old} -> ${edit.value}`);
      }
    } });
    if (output !== source) changes.push({ file, output });
  }
  const pending = Object.keys(map).filter((old) => fs.existsSync(path.join(root, old)));
  for (const old of pending) console.log(`${old}: pending git mv -> ${map[old]}`);
  if (!check) for (const { file, output } of changes) fs.writeFileSync(path.join(root, file), output);
  return check && (changes.length || pending.length) ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}

module.exports = { rewrite, validateMap };
