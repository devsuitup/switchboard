'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const cssTree = require(require.resolve('css-tree', { paths: [path.dirname(require.resolve('jsdom'))] }));

const publicDir = path.join(__dirname, '..', 'public');
const stateSource = fs.readFileSync(path.join(publicDir, 'session-state.js'), 'utf8');
const icons = vm.runInNewContext(stateSource + '\nICON_BY_RUNG');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');

function stylesheetRules() {
  const rules = [];
  cssTree.walk(cssTree.parse(css), {
    visit: 'Rule',
    enter(rule) {
      const style = new Map();
      rule.block.children.forEach(declaration => {
        if (declaration.type === 'Declaration') style.set(declaration.property, cssTree.generate(declaration.value));
      });
      rules.push({ selectorText: cssTree.generate(rule.prelude), style });
    },
  });
  return rules;
}

const rules = stylesheetRules();
function rungRules(icon) {
  return rules.filter(rule => rule.selectorText.split(',').some(selector =>
    icon.slotClasses.some(cls => selector.trim() === `.${cls}` || selector.trim() === `.${cls}::before`)));
}

for (const [rung, icon] of Object.entries(icons)) {
  test(`every slot class has a CSS rule: ${rung}`, { timeout: 1000 }, () => {
    for (const cls of icon.slotClasses) {
      assert.ok(rungRules({ slotClasses: [cls] }).length, `missing CSS rule for ${cls}`);
    }
  });
}

function styledSlots(rowClass = 'session-item') {
  const dom = new JSDOM(`<style>${css}</style><div class="${rowClass}">
    <span id="base" class="session-icon"></span>
    <span id="live" class="session-icon running"></span>
    <span id="idle" class="session-icon session-icon--idle" data-glyph="${icons.idle.glyph}"></span>
    <span id="live-idle" class="session-icon running session-icon--idle" data-glyph="${icons.idle.glyph}"></span>
    <span id="waiting" class="session-icon running session-icon--waiting" data-glyph="${icons.waitingForInput.glyph}"></span>
    <span id="stale" class="session-icon session-icon--stale" data-glyph="${icons.stale.glyph}"></span>
    <span id="archived" class="session-icon session-icon--archived" data-glyph="${icons.archived.glyph}"></span>
  </div>`);
  return {
    style: id => dom.window.getComputedStyle(dom.window.document.getElementById(id)),
    destroy: () => dom.window.close(),
  };
}

for (const [left, right] of [['idle', 'stale'], ['live-idle', 'idle']]) {
  test(`#563 ${left} and ${right} differ by shape beyond colour and opacity`, () => {
    const { style, destroy } = styledSlots();
    try {
      const shape = id => ['width', 'height', 'border-radius', 'border-bottom-width', 'border-bottom-style',
        'transform', 'clip-path', 'box-shadow'].map(property => style(id).getPropertyValue(property)
        .replace(/rgba?\([^)]*\)|#[\da-f]+/gi, ''));
      assert.notDeepEqual(shape(left), shape(right));
    } finally {
      destroy();
    }
  });
}

for (const rowClass of ['session-item', 'session-item is-terminal']) {
  test(`idle with running keeps the running green: ${rowClass}`, { timeout: 1000 }, () => {
    const { style, destroy } = styledSlots(rowClass);
    try {
      assert.equal(style('live-idle').backgroundColor, style('live').backgroundColor);
      assert.equal(style('live-idle').backgroundColor, 'rgb(62, 207, 90)');
      assert.equal(icons.idle.glyph, '');
      assert.ok(rungRules(icons.idle).every(rule => rule.style.size === 0), 'idle must have no overrides');
    } finally {
      destroy();
    }
  });

  test(`waiting with running is transparent and has no halo: ${rowClass}`, { timeout: 1000 }, () => {
    const { style, destroy } = styledSlots(rowClass);
    try {
      assert.equal(style('waiting').boxShadow, 'none');
      assert.equal(style('waiting').backgroundColor, 'rgba(0, 0, 0, 0)');
      assert.equal(style('waiting').animation, 'none');
    } finally {
      destroy();
    }
  });
}

test('idle without running stays the base grey filled dot', { timeout: 1000 }, () => {
  const { style, destroy } = styledSlots();
  try {
    assert.equal(style('idle').backgroundColor, style('base').backgroundColor);
    assert.equal(style('idle').borderRadius, style('base').borderRadius);
    assert.notEqual(style('idle').backgroundColor, style('live').backgroundColor);
    assert.notEqual(style('idle').backgroundColor, 'rgba(0, 0, 0, 0)');
    assert.equal(icons.idle.glyph, '');
  } finally {
    destroy();
  }
});

test('waiting is hollow while idle is filled, independent of colour and opacity', { timeout: 1000 }, () => {
  const { style, destroy } = styledSlots();
  try {
    assert.equal(icons.waitingForInput.glyph, '○');
    assert.ok(rungRules(icons.waitingForInput).some(rule => rule.style.get('content') === 'attr(data-glyph)'));
    assert.equal(style('waiting').backgroundColor, 'rgba(0, 0, 0, 0)');
    assert.notEqual(style('idle').backgroundColor, 'rgba(0, 0, 0, 0)');
    assert.equal(icons.idle.glyph, '');
    assert.ok(rungRules(icons.idle).every(rule => !rule.style.has('content')));
  } finally {
    destroy();
  }
});

test('stale and reserved archived are the same dim grey filled dot with no glyph', { timeout: 1000 }, () => {
  const { style, destroy } = styledSlots();
  try {
    for (const rung of ['stale', 'archived']) {
      assert.equal(icons[rung].glyph, '');
      assert.equal(style(rung).backgroundColor, style('base').backgroundColor);
      assert.equal(style(rung).borderRadius, style('base').borderRadius);
      assert.ok(Number(style(rung).opacity) > 0 && Number(style(rung).opacity) < Number(style('base').opacity));
      assert.ok(rungRules(icons[rung]).every(rule => !rule.style.has('content')));
    }
    assert.equal(style('stale').opacity, style('archived').opacity);
  } finally {
    destroy();
  }
});

test('waiting and attention reuse the waiting orange token', { timeout: 1000 }, () => {
  assert.ok(rungRules(icons.waitingForInput).some(rule => rule.style.get('color') === 'var(--state-waiting)'));
  assert.equal(rungRules(icons.attention).find(rule => rule.style.has('background'))?.style.get('background'), 'var(--state-waiting)');
  assert.equal(rules.find(rule => rule.selectorText === '.session-item.needs-attention .session-summary')?.style.get('color'), 'var(--state-waiting)');
  assert.ok(!css.includes('--state-idle'), 'idle has no colour token');
});

test('the sidebar projection supplies each static glyph without changing the slot box', { timeout: 1000 }, () => {
  const dom = new JSDOM('<span class="session-icon running"></span>', { runScripts: 'outside-only' });
  try {
    const context = dom.getInternalVMContext();
    vm.runInContext(stateSource, context);
    vm.runInContext(fs.readFileSync(path.join(publicDir, 'session-activity-dom.js'), 'utf8'), context);
    for (const rung of ['waitingForInput', 'idle', 'stale', 'archived']) {
      vm.runInContext(`writeIconSlot(document.querySelector('span'), renderSessionIcon(${JSON.stringify(rung === 'idle' ? {} : { [rung]: true })}))`, context);
      const slot = dom.window.document.querySelector('span');
      assert.equal(slot.dataset.glyph, icons[rung].glyph);
      assert.ok(slot.classList.contains(icons[rung].slotClasses[0]));
      if (rung === 'waitingForInput') {
        const pseudo = rungRules(icons[rung]).find(rule => rule.style.has('content'));
        assert.equal(pseudo?.style.get('content'), 'attr(data-glyph)', 'waiting must display its projected ring');
      } else {
        assert.equal(icons[rung].glyph, '', `${rung} uses the filled slot rather than a glyph`);
      }
      for (const rule of rungRules(icons[rung])) {
        assert.ok(!rule.style.has('animation') || rule.style.get('animation') === 'none', `${rung} must be static`);
        assert.equal(rule.style.has('width'), false, `${rung} must preserve slot width`);
        assert.equal(rule.style.has('height'), false, `${rung} must preserve slot height`);
      }
    }
  } finally {
    dom.window.close();
  }
});
