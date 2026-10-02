'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractFunction, extractDeclaration } = require('./app-source');

test('extractFunction: braces inside strings, templates, comments and regexes do not end the body', () => {
  const src = [
    'function a(x = { k: 1 }) {',
    "  const s = '}' + \"}\" + `${ {a: 1}.a }}`; // }",
    '  /* } */',
    '  return /}/.test(s);',
    '}',
    'function b() {}',
  ].join('\n');
  assert.equal(extractFunction(src, 'a'), src.split('\nfunction b')[0]);
});

test('extractFunction: a slash inside a regex class does not end the regex', () => {
  const src = 'function a() {\n  return /[/]}/.test("x");\n}\nfunction b() {}';
  assert.equal(extractFunction(src, 'a'), 'function a() {\n  return /[/]}/.test("x");\n}');
});

test('extractFunction: a regex the scanner mistakes for a division is refused, not silently truncated', () => {
  const src = 'function a(x) {\n  if (x) /}/.test("y");\n  return 1;\n}\n';
  assert.throws(() => extractFunction(src, 'a'), /extraction of a /);
});

test('extractFunction: an unterminated regex throws instead of looping', () => {
  assert.throws(() => extractFunction('function a() {\n  return /abc;\n}\n', 'a'), /unterminated regular expression/);
});

test('extractFunction: a body that does not close throws', () => {
  assert.throws(() => extractFunction('function a() {\n  return 1;\n', 'a'), /unbalanced/);
});

test('extractFunction: a slice that ends mid-line is refused and names the function', () => {
  assert.throws(() => extractFunction('function a() { return 1; } trailing();\n', 'a'), /extraction of a .*mid-line/);
});

test('extractFunction: a missing function is reported by name', () => {
  assert.throws(() => extractFunction('function a() {}\n', 'zzz'), /zzz/);
});

test('extractDeclaration: takes the single-line declaration, refuses a missing one', () => {
  const src = "let x = 1;\nconst MIN = 3;\n";
  assert.equal(extractDeclaration(src, 'MIN'), 'const MIN = 3;');
  assert.throws(() => extractDeclaration(src, 'nope'), /nope/);
});
