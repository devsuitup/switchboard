const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { setupSidebarDom } = require('./dom-setup');

const fence = source => '\x60\x60\x60mermaid\n' + source + '\n\x60\x60\x60';
const tick = () => new Promise(resolve => setImmediate(resolve));
let realMermaidBundle;
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

function useRealMermaid(ctx, window = ctx.window) {
  const { SVGElement } = window;
  window.structuredClone = structuredClone;
  window.Math.random = () => 0.5;
  window.Date.now = () => 1792108800000;
  let uuid = 0;
  window.crypto.randomUUID = () => '00000000-0000-4000-8000-' + String(++uuid).padStart(12, '0');
  SVGElement.prototype.getBBox = function () {
    return { x: 0, y: 0, width: (this.textContent || '').length * 8, height: 16 };
  };
  SVGElement.prototype.getComputedTextLength = function () { return this.getBBox().width; };
  SVGElement.prototype.getScreenCTM = () => ({ inverse: () => ({}) });
  window.HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({
      canvas: this,
      measureText: text => ({ width: String(text).length * 8 }),
      getLineDash: () => [],
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
    }, { get: (target, key) => key in target ? target[key] : () => {} });
  };
  const filename = path.join(__dirname, '..', 'node_modules/mermaid/dist/mermaid.js');
  if (window === ctx.window) {
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx.context, { filename });
    window.previewMermaid = window.mermaid;
  } else {
    realMermaidBundle ||= require('esbuild').buildSync({
      entryPoints: [path.join(__dirname, '../public/mermaid-setup.js')],
      bundle: true, write: false, format: 'iife', platform: 'browser', minify: true,
    }).outputFiles[0].text;
    window.eval(realMermaidBundle);
  }
  return window.previewMermaid;
}

async function loadRealMermaid(ctx) {
  const loaded = ctx.realLoader();
  const frame = ctx.document.querySelector('.mermaid-render-frame');
  const rendererWindow = frame?.contentWindow || ctx.window;
  useRealMermaid(ctx, rendererWindow);
  rendererWindow.document.querySelector('script[src="mermaid-bundle.js"]').dispatchEvent(new rendererWindow.Event('load'));
  const mermaid = await loaded;
  ctx.window.loadMermaidBundle = () => loaded;
  return { mermaid, document: rendererWindow.document };
}

test('render scratch follows the preview width at each render, including after waiting in the queue', async t => {
  const ctx = setup(t);
  const { mermaid, document } = await loadRealMermaid(ctx);
  let width = 840;
  Object.defineProperty(ctx.el, 'clientWidth', { get: () => width });
  const next = ctx.document.createElement('div');
  next.className = 'markdown-preview';
  ctx.document.body.appendChild(next);
  let nextWidth = 600;
  Object.defineProperty(next, 'clientWidth', { get: () => nextWidth });
  const widths = [];
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  mermaid.render = async (id, source, container) => {
    widths.push(container.style.width);
    if (widths.length === 1) {
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    return { svg: '<svg id="' + id + '"><text>diagram</text></svg>' };
  };
  const first = ctx.render(fence('graph TD; A-->B'));
  await Promise.race([started, first]);
  assert.equal(typeof release, 'function');
  const queued = ctx.window.renderMarkdownPreview(next, fence('graph TD; B-->C'));
  nextWidth = 299;
  release();
  await Promise.all([first, queued]);
  width = 420;
  await ctx.render(fence('graph TD; C-->D'));
  assert.deepEqual(widths, ['840px', '299px', '420px']);
  assert.equal(ctx.document.querySelectorAll('.mermaid-render-frame').length, 1);
  assert.equal(document.querySelector('.mermaid-render-scratch'), null);
  assert.ok(ctx.el.querySelector('svg'));
  assert.ok(next.querySelector('svg'));
});

test('real Mermaid rendering preserves host lookups and application notifications throughout async work', async t => {
  const ctx = setup(t);
  const { mermaid, document } = await loadRealMermaid(ctx);
  const rendererLookup = document.getElementById;
  const original = ctx.document.getElementById;
  const originalSelector = ctx.document.querySelector;
  const render = mermaid.render;
  const errors = [];
  const unchanged = [];
  mermaid.render = async (...args) => {
    const pending = render(...args);
    for (const id of ['during-render', 'after-yield']) {
      unchanged.push(ctx.document.getElementById === original && ctx.document.querySelector === originalSelector);
      try { ctx.window.showAppNotice({ id, kind: 'error', message: 'Stop failed' }); }
      catch (error) { errors.push(error.message); }
      await tick();
    }
    return pending;
  };
  await ctx.render(fence('graph TD; A-->B'));
  assert.deepEqual(errors, []);
  assert.deepEqual(unchanged, [true, true]);
  assert.equal(ctx.document.querySelectorAll('#app-notices .app-notice').length, 2);
  assert.ok(ctx.el.querySelector('svg'));
  assert.equal(document.getElementById, rendererLookup);
  assert.equal(document.querySelector('.mermaid-render-scratch'), null);
});

for (const [name, source] of [
  ['flowchart', 'graph TD; A[Start]-->B[End]'],
  ['sequence', 'sequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Hi'],
  ['class', 'classDiagram\nAnimal <|-- Duck\nAnimal : +int age'],
  ['state', 'stateDiagram-v2\n[*] --> Still\nStill --> [*]'],
  ['pie', 'pie title Pets\n"Dogs" : 10\n"Cats" : 20'],
  ['gantt', 'gantt\ndateFormat YYYY-MM-DD\nsection Demo\nTask :2026-10-16, 2d'],
  ['mindmap', 'mindmap\n  root((Root))\n    One\n    Two'],
  ['er', 'erDiagram\nCUSTOMER ||--o{ ORDER : places'],
  ['colored markers', 'flowchart TD\nA-->B\nlinkStyle 0 stroke:red'],
  ['architecture', 'architecture-beta\nservice db(database)[Database]'],
]) {
  test('real Mermaid SVG is identical with and without the render guard: ' + name, async t => {
    const guarded = setup(t);
    const baseline = setup(t);
    const { mermaid, document } = await loadRealMermaid(guarded);
    const { mermaid: raw, document: baselineDocument } = await loadRealMermaid(baseline);
    const width = 720;
    Object.defineProperty(guarded.el, 'clientWidth', { value: width });
    for (const doc of [document, baselineDocument]) {
      Object.defineProperty(doc.defaultView.HTMLElement.prototype, 'offsetWidth', {
        get() {
          for (let node = this; node; node = node.parentElement) {
            if (/^\d+px$/.test(node.style.width)) return parseInt(node.style.width, 10);
          }
          return doc.defaultView.innerWidth;
        },
      });
    }
    const initialize = mermaid.initialize;
    let config;
    mermaid.initialize = options => {
      config = { ...options, handDrawnSeed: 1 };
      initialize(config);
    };
    let actual;
    const lookups = [];
    const render = mermaid.render;
    mermaid.render = async (...args) => {
      const scoped = document.getElementById;
      document.getElementById = id => {
        lookups.push(String(id));
        return scoped(id);
      };
      actual = await render(...args);
      return actual;
    };
    await guarded.render(fence(source));
    assert.ok(actual?.svg, 'guarded real renderer must succeed');
    assert.ok(guarded.el.querySelector('svg'), 'shared preview must insert the sanitized diagram');
    assert.equal(guarded.el.querySelector('.mermaid-error'), null);
    raw.initialize(config);
    const container = baselineDocument.createElement('div');
    container.className = 'mermaid-render-scratch';
    container.style.width = width + 'px';
    container.setAttribute('aria-hidden', 'true');
    baselineDocument.body.appendChild(container);
    const expected = await raw.render('preview-mermaid-1', source + '\n', container);
    if (actual.svg !== expected.svg) {
      const offset = [...actual.svg].findIndex((char, index) => char !== expected.svg[index]);
      t.diagnostic(JSON.stringify({ offset, actual: actual.svg.slice(offset, offset + 120), expected: expected.svg.slice(offset, offset + 120) }));
    }
    assert.ok(actual.svg === expected.svg, 'raw SVG must be byte-identical: ' + name);
    assert.equal(guarded.document.querySelector('.mermaid-render-scratch'), null);
    assert.equal(document.querySelector('.mermaid-render-scratch'), null);
    t.diagnostic(JSON.stringify({ fixture: name, bytes: Buffer.byteLength(actual.svg), sha256: createHash('sha256').update(actual.svg).digest('hex'), lookups: [...new Set(lookups)] }));
  });
}

for (const source of [
  'sequenceDiagram\nparticipant A#1;\ndetails A#1;: secretjson',
  'sequenceDiagram\nparticipant Al#x;ice\ndetails Al#x;ice: secretjson',
  'sequenceDiagram\nparticipant style@{"alias":"#"}; details Ali;ce: secretjson',
]) {
  test('entity preprocessing cannot expose private page JSON: ' + source, async t => {
    const ctx = setup(t);
    useRealMermaid(ctx);
    const secret = ctx.document.createElement('div');
    secret.id = 'secretjson';
    secret.textContent = '{"links":{"private text":"https://private.test"}}';
    ctx.document.body.appendChild(secret);
    let lookups = 0;
    const original = ctx.document.getElementById;
    ctx.document.getElementById = function (id) {
      if (id === 'secretjson') lookups++;
      return original.call(this, id);
    };
    await ctx.render(fence(source));
    assert.equal(lookups, 0, 'Mermaid must not look up private page JSON');
    assert.doesNotMatch(ctx.el.textContent, /private text|private\.test/);
    assert.equal(ctx.document.querySelector('.mermaid-render-scratch'), null);
  });
}

test('the DOM guard protects real Mermaid details even when the source pre-check is bypassed', async t => {
  const ctx = setup(t);
  const { mermaid, document } = await loadRealMermaid(ctx);
  const render = mermaid.render;
  const secret = document.createElement('div');
  secret.id = 'secretjson';
  secret.textContent = '{"links":{"private text":"https://private.test"}}';
  document.body.appendChild(secret);
  let lookups = 0;
  const original = document.getElementById;
  document.getElementById = function (id) {
    if (id === 'secretjson') lookups++;
    return original.call(this, id);
  };
  let attempts = 0;
  for (const attack of [
    'sequenceDiagram\nparticipant A#1;\ndetails A#1;: secretjson',
    'sequenceDiagram\nparticipant Al#x;ice\ndetails Al#x;ice: secretjson',
    'sequenceDiagram\nparticipant style@{"alias":"#"}; details Ali;ce: secretjson',
  ]) {
    mermaid.render = (id, source, container) => {
      attempts++;
      return render(id, attack, container);
    };
    await ctx.render(fence('sequenceDiagram\nAlice->>Bob: Hello ' + attempts));
    assert.equal(lookups, 0);
    assert.ok(ctx.el.querySelector('svg'));
    assert.doesNotMatch(ctx.el.textContent, /private text|private\.test/);
  }
  assert.equal(attempts, 3);
});

test('repeated real layout renders preserve preexisting page nodes and leave no Cytoscape styles behind', async t => {
  const ctx = setup(t);
  useRealMermaid(ctx);
  ctx.document.head.insertAdjacentHTML('beforeend', '<style id="__________cytoscape_stylesheet">body { color: red }</style>');
  ctx.document.body.insertAdjacentHTML('beforeend', '<div id="cy">private text</div>');
  const pageStyle = ctx.document.head.lastElementChild;
  const pageCy = ctx.document.body.lastElementChild;
  for (const label of ['One', 'Two']) {
    await ctx.render(fence('mindmap\n  root((Root))\n    ' + label));
    assert.ok(ctx.el.querySelector('svg'));
    assert.equal(ctx.document.querySelectorAll('#__________cytoscape_stylesheet').length, 1);
    assert.equal(ctx.document.head.lastElementChild, pageStyle);
    assert.equal(pageCy.textContent, 'private text');
    assert.equal(pageCy.parentElement, ctx.document.body);
    assert.doesNotMatch(ctx.el.textContent, /private text/);
  }
});

test('the render guard resolves only its scratch including duplicate IDs and survives asynchronous work', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const ctx = setup(t, async (id, source, container) => {
    container.innerHTML = '<svg id="' + id + '"><defs><marker id="shared-id"/><marker id="special:#[]"/></defs></svg>';
    assert.equal(ctx.document.getElementById('shared-id'), container.querySelector('marker'));
    assert.equal(ctx.document.getElementById(id), container.querySelector('svg'));
    assert.equal(ctx.document.getElementById('special:#[]'), container.querySelectorAll('marker')[1]);
    assert.equal(ctx.document.querySelector('body'), container);
    assert.equal(ctx.document.getElementById('secretjson'), null);
    entered();
    await new Promise(resolve => { release = resolve; });
    assert.equal(ctx.document.getElementById('secretjson'), null);
    return { svg: container.innerHTML };
  });
  ctx.document.body.insertAdjacentHTML('afterbegin', '<div id="shared-id"></div><div id="secretjson">private text</div>');
  const original = ctx.document.getElementById;
  const originalSelector = ctx.document.querySelector;
  const originalDescriptor = Object.getOwnPropertyDescriptor(ctx.document, 'getElementById');
  const pending = ctx.render(fence('graph TD; A-->B'));
  await Promise.race([started, pending]);
  assert.equal(typeof release, 'function');
  assert.equal(ctx.document.getElementById('secretjson'), null);
  release();
  await pending;
  assert.equal(ctx.document.getElementById, original);
  assert.equal(ctx.document.querySelector, originalSelector);
  assert.deepEqual(Object.getOwnPropertyDescriptor(ctx.document, 'getElementById'), originalDescriptor);
  assert.equal(ctx.document.getElementById('secretjson').textContent, 'private text');
  assert.ok(ctx.el.querySelector('svg'));
});

for (const asynchronous of [false, true]) {
  test('a render that ' + (asynchronous ? 'rejects' : 'throws') + ' restores the original DOM lookup and the queue recovers', async t => {
    const ctx = setup(t);
    const original = ctx.document.getElementById;
    const originalSelector = ctx.document.querySelector;
    const normalRender = ctx.window.previewMermaid.render;
    let guarded = false;
    ctx.window.previewMermaid.render = () => {
      guarded = ctx.document.getElementById !== original;
      if (asynchronous) return Promise.reject(new Error('render rejected'));
      throw new Error('render threw');
    };
    await ctx.render(fence('graph TD; A-->B'));
    assert.equal(guarded, true);
    assert.equal(ctx.document.getElementById, original);
    assert.equal(ctx.document.querySelector, originalSelector);
    assert.ok(ctx.el.querySelector('.mermaid-error'));
    ctx.window.previewMermaid.render = normalRender;
    await ctx.render(fence('graph TD; C-->D'));
    assert.ok(ctx.el.querySelector('svg'));
    assert.equal(ctx.document.getElementById, original);
  });
}

test('overlapping and re-entrant previews serialize guards and restore the DOM lookup after each render', async t => {
  let release, entered, nested;
  let active = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const ctx = setup(t, async (id, source) => {
    assert.equal(++active, 1);
    assert.equal(ctx.document.getElementById('secretjson'), null);
    if (source.includes('first')) {
      nested = ctx.window.renderMarkdownPreview(other, fence('nested'));
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    assert.equal(ctx.document.getElementById('secretjson'), null);
    active--;
    return { svg: '<svg id="' + id + '"><text>' + source.trim() + '</text></svg>' };
  });
  const other = ctx.document.createElement('div');
  ctx.document.body.appendChild(other);
  ctx.document.body.insertAdjacentHTML('beforeend', '<div id="secretjson">private text</div>');
  const original = ctx.document.getElementById;
  const first = ctx.render(fence('first'));
  await Promise.race([started, first]);
  assert.equal(typeof release, 'function');
  const overlapping = ctx.render(fence('overlapping'));
  release();
  await Promise.all([first, nested, overlapping]);
  assert.equal(ctx.document.getElementById, original);
  assert.equal(ctx.calls.length, 3);
  assert.equal(other.querySelector('svg text').textContent, 'nested');
  assert.equal(ctx.el.querySelector('svg text').textContent, 'overlapping');
  assert.equal(ctx.document.querySelectorAll('.mermaid-render-scratch').length, 0);
});

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
  let frame = ctx.document.querySelector('.mermaid-render-frame');
  let scripts = frame.contentDocument.querySelectorAll('script[src="mermaid-bundle.js"]');
  assert.equal(scripts.length, 1);
  scripts[0].dispatchEvent(new ctx.window.Event('error'));
  await assert.rejects(first);
  assert.equal(frame.isConnected, false);
  const retry = ctx.window.loadMermaidBundle();
  frame = ctx.document.querySelector('.mermaid-render-frame');
  scripts = frame.contentDocument.querySelectorAll('script[src="mermaid-bundle.js"]');
  assert.equal(scripts.length, 1);
  assert.equal(ctx.document.querySelectorAll('.mermaid-render-frame').length, 1);
  frame.contentWindow.previewMermaid = ctx.window.previewMermaid;
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
  'classDiagram\nclass Shape\n<<value-object>> Shape',
  'classDiagram\nclass Shape\n<<Service Provider>> Shape',
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

for (const source of [
  'sequenceDiagram\nparticipant Alice; details Alice: private-data',
  'sequenceDiagram\nparticipant Alice Smith\ndetails Alice Smith: private-data',
  'sequenceDiagram; participant Alice Smith; DeTaIlS\tAlice Smith: private-data',
  'graph TD; A[sequenceDiagram]; B[See details X:]',
  '%%{init: {"label": "sequenceDiagram"}}%%\ngraph TD; A[de%%{init: {}}%%tails X:]',
  'sequence%%{init: {}}%%Diagram\n%%{x details Alice: private-data',
  '---\ntitle: sequence%%{init: {}}%%Diagram\n---\ngraph TD; A[details X:]',
  '\uFEFF---\ntitle: "%%{x"\n---\nsequence%%{init: {}}%%Diagram\nde%%{init: {}}%%tails Alice: private-data',
  'classDiagram\nclass Shape\n<<img src=x>> Shape',
  'classDiagram\nclass Shape\n<<img src=https://evil.test/x>> Shape',
  'classDiagram\nclass Shape\n<<&lt;img&gt;>> Shape',
  'classDiagram\nclass Shape\n<<img: https://evil.test/x>> Shape',
  'classDiagram\nclass Shape\n<<url(https://evil.test/x)>> Shape',
]) {
  test('unsafe Mermaid source is refused before rendering: ' + source, async t => {
    const ctx = setup(t);
    const privateData = ctx.document.createElement('div');
    privateData.id = 'private-data';
    privateData.textContent = '{"links":{"private text":"https://private.test"}}';
    ctx.document.body.appendChild(privateData);
    await ctx.render(fence(source));
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.configs.length, 0);
    assert.equal(ctx.document.querySelector('.mermaid-render-scratch'), null);
    assert.equal(ctx.el.querySelectorAll('svg').length, 0);
    assert.equal(ctx.el.querySelector('pre code')?.textContent, source + '\n');
    assert.ok(ctx.el.querySelector('.mermaid-error'));
    assert.doesNotMatch(ctx.el.textContent, /private text/);
  });
}

for (const source of [
  'sequenceDiagram details Alice: secretjson',
  '---\ntitle: Sequence\n---\nsequenceDiagram details Alice: secretjson',
  'sequenceDiagram\n%%{init: {}}%% details Alice: secretjson',
  'sequenceDiagram\naccDescr { x }details Alice: secretjson',
  'sequenceDiagram\nloop Example\nAlice->>Bob: Hello\nend details Alice: secretjson',
  'sequenceDiagram\nde%%{init: {}}%%tails Alice: secretjson',
  'sequenceDiagram\ndetails%%{init: {}}%% Alice: secretjson',
  'sequence%%{init: {}}%%Diagram details Alice: secretjson',
  'sequenceDiagram\n%%{init: {a: 0\u2028details Alice: secretjson\n%% ignore}%%',
  '%%{init: {a: 0\u2028sequenceDiagram\ndetails Alice: secretjson\n%% ignore}%%',
  '---   \ntitle: "%%{x"\n---\nsequenceDiagram\nparticipant Alice\ndetails Alice: secretjson',
  '  ---\ntitle: "%%{x"\n  ---\nsequenceDiagram\nparticipant Alice\ndetails Alice: secretjson',
]) {
  test('sequence details bypass is refused without a real Mermaid DOM lookup: ' + source, async t => {
    const ctx = setup(t);
    const filename = path.join(__dirname, '..', 'node_modules/mermaid/dist/mermaid.js');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx.context, { filename });
    ctx.window.previewMermaid = ctx.window.mermaid;
    const privateData = ctx.document.createElement('div');
    privateData.id = 'secretjson';
    privateData.textContent = '{"links":{"private text":"https://private.test"}}';
    ctx.document.body.appendChild(privateData);
    let lookups = 0;
    const getElementById = ctx.document.getElementById.bind(ctx.document);
    ctx.document.getElementById = id => {
      if (id === 'secretjson') lookups++;
      return getElementById(id);
    };
    await ctx.render(fence(source));
    assert.equal(lookups, 0, 'Mermaid must not read the private page element');
    assert.equal(ctx.document.querySelector('.mermaid-render-scratch'), null);
    assert.equal(ctx.el.querySelectorAll('svg').length, 0);
    assert.equal(ctx.el.querySelector('pre code')?.textContent, source + '\n');
    assert.ok(ctx.el.querySelector('.mermaid-error'));
    assert.doesNotMatch(ctx.el.textContent, /private text/);
  });
}

test('frontmatter variants cannot hide directive-split sequence details from the source filter', async t => {
  const ctx = setup(t);
  const filename = path.join(__dirname, '..', 'node_modules/mermaid/dist/mermaid.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx.context, { filename });
  ctx.window.previewMermaid = ctx.window.mermaid;
  const privateData = ctx.document.createElement('div');
  privateData.id = 'secretjson';
  privateData.textContent = '{"links":{"private text":"https://private.test"}}';
  ctx.document.body.appendChild(privateData);
  const lookups = [];
  const getElementById = ctx.document.getElementById.bind(ctx.document);
  ctx.document.getElementById = id => {
    if (id === 'secretjson') lookups.push(id);
    return getElementById(id);
  };
  for (const body of [
    'sequenceDiagram\nparticipant Alice\ndetails Alice: secretjson',
    'sequenceDiagram\nparticipant Alice\nde%%{init: {}}%%tails Alice: secretjson',
    'sequenceDiagram\nparticipant Alice\ndetails%%{init: {}}%% Alice: secretjson',
    'sequence%%{init: {}}%%Diagram\nparticipant Alice\ndetails Alice: secretjson',
    'sequence%%{init: {}}%%Diagram\nparticipant Alice\nde%%{init: {}}%%tails Alice: secretjson',
  ]) {
    for (const indent of ['', ' ', '  ', '\t', '\uFEFF']) {
      for (const suffix of ['', ' ', '   ', '\t']) {
        for (const eol of ['\n', '\r\n', '\r']) {
          const source = indent + '---' + suffix + eol + 'title: "%%{x"' + eol + indent + '---' + suffix + eol + body.replace(/\n/g, eol);
          await ctx.render(fence(source));
          assert.equal(lookups.length, 0, 'Mermaid must not read the private page element: ' + JSON.stringify(source));
          assert.equal(ctx.document.querySelector('.mermaid-render-scratch'), null);
          assert.equal(ctx.el.querySelectorAll('svg').length, 0);
          assert.equal(ctx.el.querySelector('pre code')?.textContent, source.replace(/\r\n?/g, '\n') + '\n');
          assert.ok(ctx.el.querySelector('.mermaid-error'));
          assert.doesNotMatch(ctx.el.textContent, /private text/);
        }
      }
    }
  }
});

test('sequence labels with a details participant colon shape are deliberately refused', async t => {
  const ctx = setup(t);
  await ctx.render(fence('%%{init: {}}%% sequenceDiagram\nAlice->>Bob: See details X:'));
  assert.equal(ctx.calls.length, 0);
  assert.ok(ctx.el.querySelector('.mermaid-error'));
});

for (const source of ['sequenceDiagram\nAlice->>Bob: See details below', 'graph TD; A[See details X:]']) {
  test('details text outside the refused sequence shape remains renderable: ' + source, async t => {
    const ctx = setup(t);
    await ctx.render(fence(source));
    assert.equal(ctx.calls.length, 1);
    assert.ok(ctx.el.querySelector('svg'));
    assert.equal(ctx.el.querySelector('.mermaid-error'), null);
  });
}

for (const statement of ['links Alice: {"Docs":"#private-data"}', 'link Alice: Docs @ #private-data']) {
  test('sequence links without a DOM lookup remain renderable: ' + statement, async t => {
    const ctx = setup(t);
    await ctx.render(fence('sequenceDiagram\nparticipant Alice; ' + statement));
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
  const frame = ctx.document.querySelector('.mermaid-render-frame');
  const script = frame.contentDocument.querySelector('script[src="mermaid-bundle.js"]');
  script.dispatchEvent(new ctx.window.Event('load'));
  await assert.rejects(first, /unavailable/);
  assert.equal(frame.isConnected, false);
  const retry = ctx.window.loadMermaidBundle();
  ctx.window.previewMermaid = library;
  const retryFrame = ctx.document.querySelector('.mermaid-render-frame');
  retryFrame.contentWindow.previewMermaid = library;
  retryFrame.contentDocument.querySelector('script[src="mermaid-bundle.js"]').dispatchEvent(new ctx.window.Event('load'));
  assert.equal(await retry, library);
});
