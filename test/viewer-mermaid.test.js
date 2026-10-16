const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');

const fence = source => '\x60\x60\x60mermaid\n' + source + '\n\x60\x60\x60';
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(t, render) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  for (const file of ['node_modules/marked/lib/marked.umd.js', 'node_modules/dompurify/dist/purify.min.js', 'public/viewer-toolbar.js', 'public/viewer-panel.js']) {
    const filename = path.join(__dirname, '..', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx.context, { filename });
  }
  const el = ctx.document.createElement('div');
  el.className = 'markdown-preview';
  ctx.document.body.appendChild(el);
  const realLoader = ctx.window.loadMermaidBundle;
  const calls = [], configs = [];
  let loads = 0;
  ctx.window.previewMermaid = {
    mermaidAPI: { defaultConfig: { securityLevel: 'strict', flowchart: {}, themeCSS: '', htmlLabels: true } },
    initialize: config => configs.push(config),
    render: async (id, source, container) => {
      calls.push({ id, source, container });
      return render ? render(id, source, container) : { svg: '<svg xmlns="http://www.w3.org/2000/svg" id="' + id + '"><text>diagram</text></svg>' };
    },
  };
  ctx.window.loadMermaidBundle = async () => { loads++; return ctx.window.previewMermaid; };
  return { ...ctx, el, calls, configs, realLoader, loads: () => loads, render: text => ctx.window.renderMarkdownPreview(el, text) };
}

test('Mermaid fences render SVG through the shared preview with frontmatter and strict locked configuration', async t => {
  const ctx = setup(t);
  await ctx.render('---\nname: Diagram\n---\n# Heading\n\n' + fence('graph TD; A-->B'));
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].source, 'graph TD; A-->B\n');
  assert.ok(ctx.el.querySelector('svg'));
  assert.equal(ctx.el.querySelector('header strong').textContent, 'Diagram');
  assert.equal(ctx.el.querySelector('h1').textContent, 'Heading');
  const config = ctx.configs[0];
  assert.equal(config.securityLevel, 'strict');
  assert.equal(config.htmlLabels, false);
  assert.equal(config.flowchart.htmlLabels, false);
  assert.equal(config.startOnLoad, false);
  for (const key of ['securityLevel', 'flowchart', 'themeCSS', 'htmlLabels', 'secure']) assert.ok(config.secure.includes(key));
});

test('ordinary Markdown and other fences do not load Mermaid or change their output', async t => {
  const ctx = setup(t);
  const source = '# Hello\n\n\x60\x60\x60js\nalert(1)\n\x60\x60\x60\n\n\x60\x60\x60mermaid extra\ngraph TD; A-->B\n\x60\x60\x60';
  await ctx.render(source);
  assert.equal(ctx.loads(), 0);
  assert.equal(ctx.el.innerHTML, ctx.window.DOMPurify.sanitize(ctx.window.marked.parse(source)));
});

test('raw HTML pretending to be a Mermaid fence does not invoke Mermaid', async t => {
  const ctx = setup(t);
  await ctx.render('<pre><code class="language-mermaid">graph TD; A-->B</code></pre>');
  assert.equal(ctx.loads(), 0);
});

test('one failed diagram keeps escaped source and a short error while other diagrams and prose render', async t => {
  const ctx = setup(t, async (id, source) => {
    if (source.includes('broken')) throw new Error('<img src=x onerror=alert(1)> syntax error\nvery long details');
    return { svg: '<svg id="' + id + '"><text>ok</text></svg>' };
  });
  await ctx.render(fence('broken <script>alert(1)</script>') + '\n\n' + fence('graph TD; A-->B') + '\n\nRest');
  assert.equal(ctx.el.querySelector('pre code').textContent, 'broken <script>alert(1)</script>\n');
  assert.match(ctx.el.querySelector('.mermaid-error').textContent, /diagram/i);
  assert.ok(ctx.el.querySelector('svg'));
  assert.match(ctx.el.textContent, /Rest/);
  assert.equal(ctx.el.querySelector('script, img'), null);
});

test('real DOMPurify neutralizes malicious SVG, HTML, resource URLs, CSS URLs and event handlers', async t => {
  const ctx = setup(t, async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"><script>evil()</script><foreignObject><img src="https://evil.test/x" onerror="evil()"></foreignObject><a href="javascript:evil()"><text>link</text></a><image href="https://evil.test/x"/><use href="file:///secret"/><style>@import "https://evil.test/x"; path { fill:url(https://evil.test/a) }</style><path style="fill:url(https://evil.test/x)" fill="url(https://evil.test/x)"/><animate attributeName="href" values="https://evil.test/x"/><path marker-end="url(#arrow)"/><defs><marker id="arrow"/></defs></svg>' }));
  await ctx.render(fence('graph TD; A-->B'));
  const svg = ctx.el.querySelector('svg');
  assert.ok(svg);
  assert.equal(svg.querySelector('script, foreignObject, image, style, animate'), null);
  assert.doesNotMatch(svg.outerHTML, /onload|onerror|javascript:|https:|file:/);
  assert.equal(svg.querySelector('[marker-end]').getAttribute('marker-end'), 'url(#' + svg.querySelector('marker').id + ')');
});

test('untrusted HTML labels and resource-bearing source are refused before the Mermaid renderer can attach them', async t => {
  const ctx = setup(t);
  for (const source of ['graph TD; A["<img src=https://evil.test/x>"]', 'graph TD; A@{ img: "https://evil.test/x" }', 'graph TD; A@{ "img": "https://evil.test/x", shape: image }', 'graph TD; A-->B; classDef danger fill:url(https://evil.test/x)', 'graph TD; A["&#60;img src=x&#62;"]', 'sequenceDiagram\nparticipant Alice\nproperties Alice: {"icon":"https://evil.test/image.svg"}', 'sequenceDiagram\nparticipant Alice\ndetails Alice: payload']) {
    await ctx.render(fence(source));
    assert.equal(ctx.calls.length, 0);
    assert.ok(ctx.el.querySelector('pre code'));
    assert.ok(ctx.el.querySelector('.mermaid-error'));
  }
});

test('repeated previews get unique render IDs and remove temporary renderer containers, including errors', async t => {
  const ctx = setup(t, async (id, source, container) => {
    container.innerHTML = '<div id="temporary"></div>';
    if (source.includes('bad')) throw Error('bad');
    return { svg: '<svg id="' + id + '"></svg>' };
  });
  await ctx.render(fence('graph TD; A-->B'));
  await ctx.render(fence('bad') + '\n\n' + fence('graph TD; C-->D'));
  assert.equal(new Set(ctx.calls.map(c => c.id)).size, 3);
  assert.equal(ctx.document.querySelectorAll('#temporary').length, 0);
  assert.equal(ctx.el.querySelectorAll('svg').length, 1);
  assert.ok(ctx.calls.every(c => !c.container.isConnected));
});

test('a newer preview cancels stale asynchronous output and still renders the current document', async t => {
  let finish;
  const ctx = setup(t, async (id, source) => {
    if (source.includes('old')) await new Promise(resolve => { finish = resolve; });
    return { svg: '<svg id="' + id + '"><text>' + source + '</text></svg>' };
  });
  const old = ctx.render(fence('old'));
  await tick();
  assert.equal(typeof finish, 'function');
  const current = ctx.render(fence('current'));
  finish();
  await Promise.all([old, current]);
  assert.match(ctx.el.textContent, /current/);
  assert.doesNotMatch(ctx.el.textContent, /old/);
  assert.equal(ctx.el.querySelectorAll('svg').length, 1);
});

test('theme changes re-render connected previews using the new palette', async t => {
  const ctx = setup(t);
  ctx.document.documentElement.dataset.theme = 'light';
  await ctx.render(fence('graph TD; A-->B'));
  assert.equal(ctx.configs.at(-1).theme, 'default');
  ctx.document.documentElement.dataset.theme = 'dark';
  await tick(); await tick();
  assert.equal(ctx.configs.at(-1).theme, 'dark');
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.el.querySelectorAll('svg').length, 1);
});

test('bundle load failure is contained and leaves source visible', async t => {
  const ctx = setup(t);
  ctx.window.loadMermaidBundle = async () => { throw Error('missing bundle'); };
  await ctx.render(fence('graph TD; A-->B'));
  assert.ok(ctx.el.querySelector('pre code'));
  assert.ok(ctx.el.querySelector('.mermaid-error'));
});

test('real lazy loader shares one local script and retries a failed load', async t => {
  const ctx = setup(t);
  ctx.window.loadMermaidBundle = ctx.realLoader;
  const first = ctx.window.loadMermaidBundle();
  const second = ctx.window.loadMermaidBundle();
  assert.equal(first, second);
  let scripts = ctx.document.querySelectorAll('script[src="mermaid-bundle.js"]');
  assert.equal(scripts.length, 1);
  scripts[0].dispatchEvent(new ctx.window.Event('error'));
  await assert.rejects(first);
  const retry = ctx.window.loadMermaidBundle();
  scripts = ctx.document.querySelectorAll('script[src="mermaid-bundle.js"]');
  assert.equal(scripts.length, 1);
  scripts[0].dispatchEvent(new ctx.window.Event('load'));
  assert.equal(await retry, ctx.window.previewMermaid);
});

test('every CodeMirror build entry also builds the local Mermaid bundle and packaging includes it', () => {
  const base = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['bundle:mermaid'], /^esbuild public\/mermaid-setup\.js .*--outfile=public\/mermaid-bundle\.js/);
  for (const [key, script] of Object.entries(pkg.scripts)) {
    if (script.includes('npm run bundle:codemirror')) assert.ok(script.includes('npm run bundle:mermaid'), key);
  }
  for (const file of ['.github/workflows/build.yml', '.github/workflows/test.yml']) {
    assert.match(fs.readFileSync(path.join(base, file), 'utf8'), /npm run bundle:codemirror && npm run bundle:mermaid/);
  }
  assert.ok(pkg.build.files.includes('public/**/*'));
  assert.equal(pkg.devDependencies.mermaid, '12.1.0');
  assert.equal(pkg.dependencies.mermaid, undefined);
  const lock = JSON.parse(fs.readFileSync(path.join(base, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].devDependencies.mermaid, '12.1.0');
  assert.equal(lock.packages['node_modules/mermaid'].dev, true);
  assert.match(fs.readFileSync(path.join(base, '.gitignore'), 'utf8'), /^public\/mermaid-bundle\.js$/m);
  const taskfile = fs.readFileSync(path.join(base, 'Taskfile.yaml'), 'utf8');
  assert.match(taskfile, /npm run bundle:codemirror\r?\n\s*- npm run bundle:mermaid/);
  const coverage = JSON.parse(fs.readFileSync(path.join(base, '.c8rc.json'), 'utf8'));
  assert.ok(coverage.exclude.includes('public/mermaid-bundle.js'));
  assert.ok(coverage.exclude.includes('public/mermaid-setup.js'));
});


test('safe Mermaid styles with child selectors survive sanitization and wide SVG retains intrinsic width', async t => {
  const ctx = setup(t, async id => ({ svg: '<svg id="' + id + '" viewBox="0 0 2400 200" width="100%" style="max-width:2400px"><style>#' + id + ' .actor > text {fill: #ccc}</style><text>wide</text></svg>' }));
  await ctx.render(fence('graph TD; A-->B'));
  assert.ok(ctx.el.querySelector('svg style'));
  assert.equal(ctx.el.querySelector('svg').getAttribute('width'), '2400');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/style.css'), 'utf8');
  assert.match(css, /\.mermaid-diagram\s*\{[^}]*overflow-x:\s*auto/);
});

test('two diagrams namespace every SVG ID and preserve marker, label and style references', async t => {
  const ctx = setup(t, async id => ({ svg: '<svg id="' + id + '" aria-labelledby="label"><style>#' + id + ' #node {fill:red}</style><title id="label">diagram</title><defs><marker id="arrow"/></defs><path id="node" marker-end="url(#arrow)"/><a href="#node"><text>link</text></a></svg>' }));
  await ctx.render(fence('graph TD; A-->B') + '\n\n' + fence('graph TD; A-->B'));
  assert.equal(ctx.el.querySelectorAll('svg').length, 2);
  const ids = [...ctx.el.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const svg of ctx.el.querySelectorAll('svg')) {
    const marker = svg.querySelector('marker').id;
    const node = svg.querySelector('path').id;
    assert.equal(svg.querySelector('path').getAttribute('marker-end'), 'url(#' + marker + ')');
    assert.equal(svg.querySelector('a').getAttribute('href'), '#' + node);
    assert.equal(svg.getAttribute('aria-labelledby'), svg.querySelector('title').id);
    assert.ok(svg.querySelector('style').textContent.includes('#' + node));
  }
});

for (const source of [
  'classDiagram\nclass Shape\n<<interface>> Shape',
  'classDiagram\nclass Shape\n<<abstract>> Shape',
  'stateDiagram-v2\nstate split <<fork>>',
  'stateDiagram-v2\nstate merge <<join>>',
  'stateDiagram-v2\nstate decide <<choice>>',
  'graph TD; A[See details below]',
  'graph TD; A["C:\\Serveur"]',
  'graph TD; A["x<y"]',
]) {
  test('harmless Mermaid source renders: ' + source, async t => {
    const ctx = setup(t);
    await ctx.render(fence(source));
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.el.querySelectorAll('svg').length, 1);
    assert.equal(ctx.el.querySelector('.mermaid-error'), null);
  });
}

for (const html of ['<div data-preview-mermaid>keep block</div>', 'Text <span data-preview-mermaid>keep inline</span>.']) {
  test('valueless placeholder attributes in raw HTML preserve content: ' + html, async t => {
    const ctx = setup(t);
    await ctx.render(fence('graph TD; A-->B') + '\n\n' + html);
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.el.querySelectorAll('svg').length, 1);
    assert.match(ctx.el.textContent, /keep (?:block|inline)/);
    assert.equal(ctx.el.querySelectorAll('[data-preview-mermaid]').length, 1);
  });
}

test('unchanged diagrams are restored synchronously on prose refresh without another render or source flash', async t => {
  const ctx = setup(t);
  const diagram = fence('graph TD; A-->B');
  await ctx.render('# Before\n\n' + diagram);
  const svg = ctx.el.querySelector('svg').outerHTML;
  ctx.el.scrollTop = 123;
  ctx.el.scrollLeft = 17;
  const refreshed = ctx.render('# After\n\n' + diagram);
  assert.equal(ctx.el.querySelector('pre code'), null);
  assert.equal(ctx.el.querySelector('svg')?.outerHTML, svg);
  assert.equal(ctx.el.scrollTop, 123);
  assert.equal(ctx.el.scrollLeft, 17);
  await refreshed;
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.loads(), 1);
  assert.equal(ctx.el.querySelector('h1').textContent, 'After');
});

test('cache keys include source, theme and position and disappear with removed diagrams', async t => {
  const ctx = setup(t);
  const a = fence('graph TD; A-->B'), b = fence('graph TD; C-->D');
  await ctx.render(a + '\n\n' + b);
  await ctx.render(a + '\n\n' + fence('graph TD; E-->F'));
  assert.equal(ctx.calls.length, 3);
  await ctx.render(b + '\n\n' + a);
  assert.equal(ctx.calls.length, 5);
  ctx.document.documentElement.dataset.theme = 'light';
  await tick(); await tick();
  assert.equal(ctx.calls.length, 7);
  await ctx.render(b + '\n\n' + a);
  assert.equal(ctx.calls.length, 7);
  await ctx.render('No diagrams');
  await ctx.render(b);
  assert.equal(ctx.calls.length, 8);
});


test('a loaded bundle without its export is removed and the next load can recover', async t => {
  const ctx = setup(t);
  ctx.window.loadMermaidBundle = ctx.realLoader;
  const library = ctx.window.previewMermaid;
  delete ctx.window.previewMermaid;
  const first = ctx.window.loadMermaidBundle();
  const script = ctx.document.querySelector('script[src="mermaid-bundle.js"]');
  script.dispatchEvent(new ctx.window.Event('load'));
  await assert.rejects(first, /unavailable/);
  assert.equal(script.isConnected, false);
  const retry = ctx.window.loadMermaidBundle();
  ctx.window.previewMermaid = library;
  ctx.document.querySelector('script[src="mermaid-bundle.js"]').dispatchEvent(new ctx.window.Event('load'));
  assert.equal(await retry, library);
});
