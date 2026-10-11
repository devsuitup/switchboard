'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cssTree = require(require.resolve('css-tree', { paths: [path.dirname(require.resolve('jsdom'))] }));

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const rules = [];
cssTree.walk(cssTree.parse(css), {
  visit: 'Rule',
  enter(rule) {
    if (rule.prelude.type !== 'SelectorList') return;
    const style = new Map();
    rule.block.children.forEach(declaration => {
      if (declaration.type === 'Declaration') style.set(declaration.property, cssTree.generate(declaration.value));
    });
    rule.prelude.children.forEach(ast => rules.push({ selector: cssTree.generate(ast), ast, style }));
  },
});

const containers = [
  ['.worktree-header', '.worktree-new-btn'],
  ['.worktree-header', '.worktree-hide-btn'],
  ['.worktree-header', '.worktree-delete-btn'],
  ['.slug-group-header', '.slug-group-archive-btn'],
  ['.session-item', '.session-actions'],
  ['.grid-card', '.grid-card-stop-btn'],
  ['.memory-item', '.schedule-play-btn'],
  ['.project-header', '.remote-host-refresh-btn'],
  ['#file-panel-actions', '#file-panel-actions'],
];

function hidden(style) {
  return style.get('opacity') === '0' || style.get('visibility') === 'hidden' || style.get('display') === 'none';
}

function revealed(style) {
  return Number(style.get('opacity')) > 0 || style.get('visibility') === 'visible'
    || (style.has('display') && style.get('display') !== 'none');
}

function targets(rule, target) {
  let subject = [];
  rule.ast.children.forEach(node => {
    if (node.type === 'Combinator') subject = [];
    else subject.push(node);
  });
  return subject.some(node => node.type === (target.startsWith('#') ? 'IdSelector' : 'ClassSelector')
    && node.name === target.slice(1));
}

function hasPseudo(ast, name) {
  let found = false;
  cssTree.walk(ast, node => {
    if (node.type === 'PseudoClassSelector' && node.name === name) found = true;
  });
  return found;
}

function keyboardCondition(rule) {
  let subject = [];
  let focusedDescendant = false;
  rule.ast.children.forEach(node => {
    if (node.type === 'Combinator') subject = [];
    else subject.push(node);
    if (node.type === 'PseudoClassSelector' && node.name === 'has' && hasPseudo(node, 'focus-visible')) {
      focusedDescendant = true;
    }
  });
  return focusedDescendant || subject.some(node => node.type === 'PseudoClassSelector' && node.name === 'focus-visible');
}

test('every hidden-until-hover action container is covered by the keyboard inventory', () => {
  const discovered = rules.filter(rule => hidden(rule.style) && !rule.selector.includes(':'))
    .filter(rule => rules.some(hover => hover.selector.includes(':hover')
      && hover.selector.endsWith(rule.selector) && revealed(hover.style)))
    .map(rule => rule.selector);
  assert.deepEqual([...new Set(discovered)].sort(), containers.map(([, target]) => target).sort());
});

for (const [owner, target] of containers) {
  test(`keyboard focus reveals ${target} within ${owner}`, () => {
    const base = rules.find(rule => rule.selector === target && hidden(rule.style));
    assert.ok(base, `${target} is hidden before hover or keyboard focus`);
    const focus = rules.find(rule => targets(rule, target) && keyboardCondition(rule) && revealed(rule.style));
    assert.ok(focus, `${target} needs a reveal conditioned on the button's :focus-visible`);
    for (const property of ['opacity', 'visibility', 'display']) {
      if (!hidden(new Map([[property, base.style.get(property)]]))) continue;
      assert.ok(revealed(new Map([[property, focus.style.get(property)]])), `${target} must reveal ${property}`);
    }
    if (base.style.get('pointer-events') === 'none') assert.equal(focus.style.get('pointer-events'), 'auto');
  });
}

const projectButtons = ['.project-archive-btn', '.project-new-btn', '.project-settings-btn', '.project-schedule-btn'];

for (const target of projectButtons) {
  test(`keyboard focus emphasizes ${target}`, () => {
    assert.ok(rules.some(rule => targets(rule, target) && keyboardCondition(rule) && revealed(rule.style)),
      `${target} needs emphasis conditioned on the button's :focus-visible`);
  });
}

test('focus elsewhere in an owner does not reveal its action targets', () => {
  const targetsToCheck = [...containers.map(([, target]) => target), ...projectButtons];
  const broadReveals = rules.filter(rule => hasPseudo(rule.ast, 'focus-within') && revealed(rule.style)
    && targetsToCheck.some(target => targets(rule, target)));
  assert.deepEqual(broadReveals.map(rule => rule.selector), []);
});

test('keyboard-focused action buttons retain the shared visible outline', () => {
  const focus = rules.find(rule => rule.selector === ':where(button:focus-visible)');
  assert.match(focus?.style.get('outline') || '', /2px solid var\(--accent\)/);
  assert.equal(focus.style.get('outline-offset'), '2px');
  const launchConfig = rules.filter(rule => rule.selector === '.session-launch-config-btn');
  assert.ok(launchConfig.every(rule => !['none', '0'].includes(rule.style.get('outline'))),
    'Launch configuration must not suppress the shared button focus ring');
});
