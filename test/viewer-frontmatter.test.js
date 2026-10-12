const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  for (const file of ['node_modules/marked/lib/marked.umd.js', 'node_modules/dompurify/dist/purify.min.js', 'public/viewer-toolbar.js', 'public/viewer-panel.js']) {
    const filename = path.join(__dirname, '..', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx.context, { filename });
  }
  const el = ctx.document.createElement('div');
  el.className = 'markdown-preview';
  return { ...ctx, el, render: text => ctx.window.renderMarkdownPreview(el, text) };
}

function values(el) {
  return [...el.querySelectorAll('.markdown-frontmatter dl > div')].map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]);
}

test('preview renders name and title in emphasis, description as a lead and other metadata above the body', t => {
  const { el, render } = setup(t);
  render('---\nname: My skill\ntitle: Display title\ndescription: A readable lead\nmode: safe\n---\n# Body\n\n**Content**');
  assert.equal(el.firstElementChild.className, 'markdown-frontmatter');
  assert.deepEqual([...el.querySelectorAll('.markdown-frontmatter strong')].map(n => n.textContent), ['My skill', 'Display title']);
  assert.equal(el.querySelector('.markdown-frontmatter p').textContent, 'A readable lead');
  assert.deepEqual(values(el), [['mode', 'safe']]);
  assert.equal(el.querySelector('h1').textContent, 'Body');
  assert.equal(el.querySelector('hr'), null);
  assert.equal(el.querySelector('h2'), null);
});

test('preview keeps ordinary Markdown unchanged', t => {
  const { el, render, window } = setup(t);
  const text = '# Body\n\nSome **content**\n\n---\n\nMore';
  render(text);
  assert.equal(el.innerHTML, window.DOMPurify.sanitize(window.marked.parse(text)));
});

for (const [label, text] of [
  ['BOM and CRLF', '\uFEFF---\r\nname: CRLF name\r\n---\r\n# Body'],
  ['document end delimiter', '---\nname: CRLF name\n...\n# Body'],
  ['closing delimiter at EOF', '---\nname: CRLF name\n---'],
]) {
  test(`preview detects frontmatter with ${label}`, t => {
    const { el, render } = setup(t);
    render(text);
    assert.equal(el.querySelector('.markdown-frontmatter strong')?.textContent, 'CRLF name');
  });
}

for (const [label, text] of [
  ['unclosed block', '---\nname: skill\n# Body'],
  ['delimiter after line one', '\n---\nname: skill\n---\n# Body'],
  ['opening delimiter with whitespace', '--- \nname: skill\n---\n# Body'],
  ['closing delimiter with whitespace', '---\nname: skill\n--- \n# Body'],
]) {
  test(`preview preserves Markdown for ${label}`, t => {
    const { el, render, window } = setup(t);
    render(text);
    assert.equal(el.querySelector('.markdown-frontmatter'), null);
    assert.equal(el.innerHTML, window.DOMPurify.sanitize(window.marked.parse(text)));
  });
}

test('preview displays block and inline string lists as comma separated values', t => {
  const { el, render } = setup(t);
  render('---\ntools:\n  - Read\n  - Write\ntags: [alpha, "two, words", \'it\'\'s fine\']\n---\nBody');
  assert.deepEqual(values(el), [['tools', 'Read, Write'], ['tags', "alpha, two, words, it's fine"]]);
});

test('preview displays simple nested maps as indented YAML', t => {
  const { el, render } = setup(t);
  render('---\nconfig:\n  model: small\n  limits:\n    tokens: 100\n  tools:\n    - Read\n    - Write\n---\nBody');
  assert.equal(el.querySelector('.markdown-frontmatter dd pre')?.textContent, 'model: small\nlimits:\n  tokens: 100\ntools:\n  - Read\n  - Write');
});

test('preview displays folded and literal block strings without YAML markers', t => {
  const { el, render } = setup(t);
  render('---\ndescription: >-\n  First line\n  second line\nnote: |-\n  one\n  two\n---\nBody');
  assert.equal(el.querySelector('.markdown-frontmatter p')?.textContent, 'First line second line');
  assert.deepEqual(values(el), [['note', 'one\ntwo']]);
});

test('preview preserves a folded block with more-indented text rather than folding it incorrectly', t => {
  const { el, render } = setup(t);
  const raw = 'description: >-\n  Intro\n    indented text\n  Outro';
  render(`---\n${raw}\n---\n# Body`);
  assert.equal(el.querySelector('.markdown-frontmatter > pre')?.textContent, raw);
});

test('preview preserves excessively deep maps as raw YAML', t => {
  const { el, render } = setup(t);
  const raw = Array.from({ length: 23 }, (_, n) => `${'  '.repeat(n)}level${n}:`).join('\n');
  render(`---\n${raw}\n---\n# Body`);
  assert.equal(el.querySelector('.markdown-frontmatter > pre')?.textContent, raw);
});

for (const raw of [
  'name: "unterminated',
  'tags: [one, two',
  'name: first\nname: second',
  'config:\n  child: ok\n broken: bad indentation',
  'name: !custom something',
  'name: &anchor something\ncopy: *anchor',
  'config: {inline: map}',
  'tools:\n  - name: complex list',
  'just invalid yaml',
]) {
  test(`preview preserves unsupported or malformed YAML in pre: ${raw}`, t => {
    const { el, render } = setup(t);
    render(`---\n${raw}\n---\n# Body`);
    assert.equal(el.querySelector('.markdown-frontmatter > pre')?.textContent, raw);
    assert.equal(el.querySelector('h1').textContent, 'Body');
  });
}

test('preview escapes HTML in keys, scalar values, lists and nested values and sanitizes the body', t => {
  const { el, render, window } = setup(t);
  window.frontmatterExecuted = false;
  const attack = '<img src=x onerror="window.frontmatterExecuted=true">';
  render(`---\nname: ${attack}\ndescription: <script>alert(1)</script>\nitems:\n  - ${attack}\nconfig:\n  html: ${attack}\n---\n[unsafe](javascript:alert(1))`);
  assert.equal(el.querySelector('.markdown-frontmatter strong')?.textContent, attack);
  assert.ok(el.querySelector('.markdown-frontmatter').textContent.includes('<script>alert(1)</script>'));
  assert.equal(el.querySelector('img, script, [onerror]'), null);
  assert.equal(el.querySelector('a').getAttribute('href'), null);
  assert.equal(window.frontmatterExecuted, false);
  render(`---\n<img>: ${attack}\n---\nBody`);
  assert.equal(el.querySelector('.markdown-frontmatter > pre')?.textContent, `<img>: ${attack}`);
  assert.equal(el.querySelector('img'), null);
});

test('preview supports empty frontmatter, comments, quoted strings and empty values', t => {
  const { el, render } = setup(t);
  render('---\n# metadata\n---\n# Body');
  assert.equal(el.querySelector('hr'), null);
  assert.equal(el.querySelector('h1').textContent, 'Body');
  render('---\n# metadata\nname: "Quoted name" # comment\nowner:\ntags: []\nmode: safe # comment\n---\nBody');
  assert.equal(el.querySelector('strong')?.textContent, 'Quoted name');
  assert.deepEqual(values(el), [['owner', ''], ['tags', ''], ['mode', 'safe']]);
});

test('viewer preview toggle retains the complete source document', t => {
  const { el, window, document } = setup(t);
  const source = '---\nname: Original\n---\n# Body';
  const editorEl = document.createElement('div');
  const toggleBtn = document.createElement('button');
  const editorView = { state: { doc: { toString: () => source } } };
  const args = { editorEl, previewEl: el, toggleBtn, editorView, isPreview: false };
  assert.equal(window.toggleMarkdownPreview(args), true);
  assert.equal(el.querySelector('strong')?.textContent, 'Original');
  assert.equal(window.toggleMarkdownPreview({ ...args, isPreview: true }), false);
  assert.equal(editorView.state.doc.toString(), source);
  assert.equal(editorEl.style.display, '');
});

test('viewer refresh uses the same frontmatter rendering while updating its source', t => {
  const { el, window, document } = setup(t);
  const panel = new window.ViewerPanel(document.createElement('div'));
  let source = 'old';
  panel.editorView = {
    state: { doc: { toString: () => source, get length() { return source.length; } } },
    dispatch: ({ changes }) => { source = changes.insert; },
  };
  panel.previewEl = el;
  panel.previewMode = true;
  const next = '---\nname: Reloaded\n---\n# Body';
  panel._replaceContent(next);
  assert.equal(el.querySelector('strong')?.textContent, 'Reloaded');
  assert.equal(panel.getContent(), next);
});
