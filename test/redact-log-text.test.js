'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactLogText } = require('../src/main/shared/redact-log-text');

const cases = [
  ['authorization equals Basic', 'authorization=Basic abc123 next step', 'authorization=Basic [REDACTED] next step'],
  ['authorization equals Bearer', 'authorization=Bearer abc123 next step', 'authorization=Bearer [REDACTED] next step'],
  ['AWS signature', 'https://host/?X-Amz-Signature=abc123&next=ok', 'https://host/?X-Amz-Signature=[REDACTED]&next=ok'],
  ['AWS credential', 'X-Amz-Credential=abc123/scope next step', 'X-Amz-Credential=[REDACTED] next step'],
  ...['mysql', 'postgres', 'redis', 'custom+db'].map(scheme => [scheme + ' URL', `${scheme}://user:abc123@host/db next step`, `${scheme}://user:[REDACTED]@host/db next step`]),
  ['CLI token', 'run --token abc123 --verbose', 'run --token [REDACTED] --verbose'],
  ['CLI API key', 'run --api-key "abc123 two" --verbose', 'run --api-key [REDACTED] --verbose'],
  ['authorization prose', 'Authorization: Bearer abc123 failed at /repo/file', 'Authorization: Bearer [REDACTED] failed at /repo/file'],
  ['Basic prose', 'Authorization: Basic abc123 failed at /repo/file', 'Authorization: Basic [REDACTED] failed at /repo/file'],
  ['cookie prose', 'Cookie: a=abc123; b=def456 failed at /repo/file', 'Cookie: a=[REDACTED]; b=[REDACTED] failed at /repo/file'],
  ['Set-Cookie prose', 'Set-Cookie: a="abc123 two"; HttpOnly failed at /repo/file', 'Set-Cookie: a=[REDACTED]; HttpOnly failed at /repo/file'],
  ['header mentions', 'Authorization: requires a header; Cookie: unsupported format', 'Authorization: [REDACTED]'],
  ['whole pass keys', 'bypass: enabled compass: north trespass=denied pass=abc123 password=def456 passwd=ghi789', 'bypass: enabled compass: north trespass=denied pass=[REDACTED] password=[REDACTED] passwd=[REDACTED]'],
  ['short sk path', '/repo/sk-learn/model.py and sk-short remain', '/repo/sk-learn/model.py and sk-short remain'],
  ['realistic sk key', 'key sk-1234567890abcdefghijklmn end', 'key [REDACTED] end'],
  ['structured credentials', 'DB_PASSWORD="two words" GITHUB_TOKEN=abc123 client_secret=def456', 'DB_PASSWORD=[REDACTED] GITHUB_TOKEN=[REDACTED] client_secret=[REDACTED]'],
  ['nested key context', 'error: token=abc123 next step', 'error: token=[REDACTED] next step'],
  ['quoted JSON keys', '{"password":"two words","bypass":"allowed"}', '{"password":[REDACTED],"bypass":"allowed"}'],
  ['cookie whitespace and hash', 'Cookie: a=abc#123 ; b=def456 end', 'Cookie: a=[REDACTED] ; b=[REDACTED] end'],
  ['unclosed quoted credential', 'password="abc123\nnext line', 'password=[REDACTED]\nnext line'],
  ['unclosed CLI credential', 'run --token "abc123\nnext line', 'run --token [REDACTED]\nnext line'],
  ['URL password with credential-like colon', 'mysql://user:password:abc123@host/db end', 'mysql://user:[REDACTED]@host/db end'],
  ['plain credential hash', 'password=abc#123 next step', 'password=[REDACTED] next step'],
  ['query credential fragment', 'https://host/?password=abc123#section', 'https://host/?password=[REDACTED]#section'],
  ...['token', 'api-key', 'password', 'auth-token'].flatMap(key => ['=', ' '].map(separator =>
    [`CLI ${key} ${JSON.stringify(separator)}`, `claude --${key}${separator}cliSecret123 --verbose`, `claude --${key}${separator}[REDACTED] --verbose`])),
  ['single-dash credential', 'run -token=cliSecret123', 'run -token=[REDACTED]'],
  ...['accessToken', 'refreshToken', 'clientSecret', 'secretKey', 'passwordHash', 'userPassword', 'userPasswd', 'userApiKey', 'userPrivateKey', 'userAccessKey', 'userAuthorization'].map(key =>
    [`camel ${key}`, `{"${key}":"camelSecret123"}`, `{"${key}":[REDACTED]}`]),
  ['AWS4 authorization', 'Authorization: AWS4-HMAC-SHA256 Credential=AKID/scope, SignedHeaders=host, Signature=fe5f123\nnext line', 'Authorization: [REDACTED]\nnext line'],
  ['Digest authorization', 'Authorization: Digest username="u", response="abc"\nnext line', 'Authorization: [REDACTED]\nnext line'],
  ['quoted unknown authorization', '{"Authorization":"Custom opaque credential","next":1}', '{"Authorization":[REDACTED],"next":1}'],
  ['bare cookie', 'Cookie: abc123secret\nnext line', 'Cookie: [REDACTED]\nnext line'],
  ['bare Set-Cookie', 'Set-Cookie: abc123secret', 'Set-Cookie: [REDACTED]'],
  ['Windows credential path', 'C:\\Users\\jb\\password=1\\x', 'C:\\Users\\jb\\password=1\\x'],
  ['POSIX credential path', '/repo/password=1/x', '/repo/password=1/x'],
  ['long sk path', 'C:\\work\\sk-learn-experiments-2024\\run', 'C:\\work\\sk-learn-experiments-2024\\run'],
  ['sk letters only', 'sk-abcdefghijklmnopqrstuvwxyz', 'sk-abcdefghijklmnopqrstuvwxyz'],
  ['sk project key', 'sk-proj-abc123_abcdefghijklmnopqrstuvwxyz', '[REDACTED]'],
  ['sk Anthropic key', 'sk-ant-api03-abc123_abcdefghijklmnopqrstuvwxyz', '[REDACTED]'],
];
for (const [name, input, expected] of cases) test(name, () => {
  assert.equal(redactLogText(input), expected);
});

test('100 KB adversarial lines finish within 250 ms each without changing ordinary text', () => {
  for (const input of ['a'.repeat(102400), 'a-'.repeat(51200), 'a_'.repeat(51200), 'http://' + 'a:'.repeat(51200), 'eyJ' + 'a'.repeat(102400), ' '.repeat(102400), '"'.repeat(102400), 'sk-' + 'a'.repeat(102400), 'C:\\' + 'password\\'.repeat(12000), '--' + 'accessToken'.repeat(10000)]) {
    const start = performance.now();
    assert.equal(redactLogText(input), input);
    assert.ok(performance.now() - start < 250, `100 KB redaction under 250ms: ${input.slice(0, 20)}`);
  }
});

test('100 KB new credential rules finish within 250 ms each', () => {
  for (const prefix of ['--token=', '--password ', 'accessToken=', 'secretKey=', 'passwordHash=', 'Authorization: AWS4-HMAC-SHA256 ', 'Authorization: Digest ', 'Cookie: ', 'sk-proj-', 'sk-ant-']) {
    const input = prefix + (prefix === 'Cookie: ' ? 'a;'.repeat(51200) : 'a'.repeat(102400));
    const start = performance.now();
    assert.ok(redactLogText(input).length < 100, prefix);
    assert.ok(performance.now() - start < 250, `100 KB redaction under 250ms: ${prefix}`);
  }
});
