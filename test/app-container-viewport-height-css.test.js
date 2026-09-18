// #app-container is a flex child of body, sharing the window with the 22px
// #status-bar, so it is strictly shorter than the viewport. A descendant sized
// to 100vh therefore overflows it by the height of the status bar, and since
// #app-container is overflow: hidden the browser can scroll that overflow out
// of view (a focus or scrollIntoView below the fold is enough) with no
// scrollbar to bring it back — the top row stays clipped until a reload.
// Container-relative heights are the only safe way to fill #app-container.
//
// Same source-grep shape as test/session-meta-layout-css.test.js — no real CSS
// parser, just brace/comment stripping good enough to isolate selector text —
// with index.html parsed by jsdom to decide which selectors actually land
// inside #app-container.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

const RULE_BLOCKS = CSS_NO_COMMENTS.match(/[^{}]+\{[^{}]*\}/g) || [];

function selectorOf(block) {
  const head = block.slice(0, block.lastIndexOf('{'));
  const lines = head.split('\n');
  return lines[lines.length - 1].trim();
}

function declarationsOf(block) {
  return block.slice(block.lastIndexOf('{') + 1, block.lastIndexOf('}'));
}

function ruleFor(selectorPattern) {
  return RULE_BLOCKS.find((block) => selectorPattern.test(selectorOf(block)));
}

// Every (min-/max-)height declaration whose value reaches or exceeds the full
// viewport height.
function fullViewportHeights(declarations) {
  const found = [];
  const re = /(?:^|;)\s*((?:min-|max-)?height)\s*:\s*([^;]+)/g;
  let m;
  while ((m = re.exec(declarations)) !== null) {
    const value = m[2].trim();
    const vh = /(\d+(?:\.\d+)?)vh\b/.exec(value);
    if (vh && Number(vh[1]) >= 100) found.push(`${m[1]}: ${value}`);
  }
  return found;
}

test('style.css: nothing inside #app-container is sized to the full viewport height', () => {
  const dom = new JSDOM(HTML);
  const { document } = dom.window;
  const appContainer = document.getElementById('app-container');
  assert.ok(appContainer, 'expected #app-container in public/index.html');

  const offenders = [];
  for (const block of RULE_BLOCKS) {
    const declarations = declarationsOf(block);
    const heights = fullViewportHeights(declarations);
    if (heights.length === 0) continue;

    const selector = selectorOf(block);
    // Pseudo-elements are not queryable; they are sized by their originating
    // element, which its own rule covers.
    const queryable = selector.replace(/::[a-z-]+(\([^)]*\))?/g, '');
    let matched;
    try {
      matched = Array.from(document.querySelectorAll(queryable));
    } catch {
      offenders.push(`${selector} { ${heights.join('; ')} } — selector could not be evaluated`);
      continue;
    }
    if (matched.some((el) => el === appContainer || appContainer.contains(el))) {
      offenders.push(`${selector} { ${heights.join('; ')} }`);
    }
  }

  assert.deepEqual(offenders, [],
    'these rules size an element inside #app-container to the window instead of its container; '
    + 'use a container-relative height (100%, or flex stretch)');

  dom.window.close();
});

test('style.css: #app-container shares the window with a fixed-height #status-bar and hides its overflow', () => {
  const dom = new JSDOM(HTML);
  const { document } = dom.window;
  const appContainer = document.getElementById('app-container');
  const statusBar = document.getElementById('status-bar');
  assert.ok(statusBar, 'expected #status-bar in public/index.html');
  assert.ok(!appContainer.contains(statusBar),
    '#status-bar sits beside #app-container, so its height comes off the space #app-container gets');
  dom.window.close();

  const statusBarRule = ruleFor(/^#status-bar$/);
  assert.ok(statusBarRule, 'expected a #status-bar rule');
  const statusBarHeight = /(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)px/.exec(declarationsOf(statusBarRule));
  assert.ok(statusBarHeight && Number(statusBarHeight[1]) > 0,
    '#status-bar reserves a fixed pixel strip of the window');

  const appContainerRule = ruleFor(/^#app-container$/);
  assert.ok(appContainerRule, 'expected an #app-container rule');
  assert.match(declarationsOf(appContainerRule), /overflow:\s*hidden/,
    'overflow that escapes #app-container gets no scrollbar, so it cannot be scrolled back into view');
});
