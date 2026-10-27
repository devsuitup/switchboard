'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { cleanEnv } = require('../clean-env');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test/fixtures/session-capabilities/fake-cli.js');
const EVIDENCE = path.join(ROOT, 'docs/evidence/session-capabilities');
const CAPS = {
  C1: ['singleTurnDelivery', 'literalTranscript', 'eligibleConfirmation'],
  C2: ['forkWorktree'], C3: ['extraPermissionSettings'],
  C4: ['independentSendMessage', 'sandboxChildSendMessage'],
};
const EXECUTIONS = [
  { label: 'windows-conpty-bundled', platform: 'win32', backend: 'conpty-bundled' },
  { label: 'windows-conpty-inbox', platform: 'win32', backend: 'conpty-inbox' },
  { label: 'linux-unix-pty', platform: 'linux', backend: 'unix-pty' },
];
const windowsExecution = ctx => (ctx.opts.platformLabel || '').startsWith('windows-') || !ctx.opts.dryRun && process.platform === 'win32';
const aggregateStatus = statuses => statuses.includes('FAIL') ? 'FAIL' : statuses.every(s => s === 'PASS' || s === 'NOT_APPLICABLE') ? 'PASS' : 'UNVERIFIED';
function capability(ctx, key, status) {
  (ctx.capabilityStatus ||= {})[key] = status;
  ctx.capabilities[key] = status === 'PASS';
}
const LIMITS = { C1: 120000, C2: 900000, C3: 300000, C4: 900000 };
const OWNED = new Set();
let interrupted = false;
const MUTATIONS = ['split-paste', 'placeholder-no-confirmation', 'drop-byte', 'missing-paste-object',
  'reuse-worktree', 'drop-sentinel', 'omit-fork', 'own-title', 'remove-deny', 'writable-settings',
  'fake-denial', 'wrong-recipient', 'no-report', 'shared-descriptors', 'parent-env', 'synthetic-receipt', 'hang'];
const CANARY_MUTATIONS = {
  C1: MUTATIONS.slice(0, 4), C2: MUTATIONS.slice(4, 8), C3: MUTATIONS.slice(8, 11), C4: MUTATIONS.slice(11, 16),
};
Object.assign(CANARY_MUTATIONS, {
  C1: [...CANARY_MUTATIONS.C1, 'meta-users', 'no-paste-ref', 'blocking-dialog', 'exit-on-submit', 'storage-only', 'tab-to-spaces', 'exit-flush-assistant', 'raw-control-no-confirmation', 'trim-boundary-lf'],
  C2: [...CANARY_MUTATIONS.C2, 'natural-source-activity', 'ignore-fork-name', 'rename-fork-source', 'colliding-fork-name', 'delayed-rename-name', 'slow-c2-turn'],
  C3: [...CANARY_MUTATIONS.C3, 'os-denial', 'escaped-settings', 'unknown-denial', 'sandbox-unknown-denial',
    'tool-stop', 'tool-stop-idle', 'tool-stop-waiting', 'missing-allowed-tool', 'denial-no-error-flag', 'wrong-command-denial',
    'premature-final', 'tool-stop-side-effect', 'unlinked-denial', 'single-slash-read-rule'],
  C4: [...CANARY_MUTATIONS.C4, 'missing-name', 'unknown-receipt', 'wrong-control-leak', 'wrong-control-hidden-leak',
    'stale-descriptor-name', 'descriptor-only-name', 'rename-during-child-launch', 'send-failed', 'stale-recipient',
    'receipt-delayed', 'receipt-wrong-sender', 'receipt-extra-body', 'receipt-wrong-scheme', 'receipt-wrong-type',
    'receipt-report-lines', 'receipt-no-leading-lf', 'receipt-nonce-later', 'receipt-empty-body', 'receipt-double-leading-lf',
    'receipt-origin-name-mismatch', 'receipt-origin-body-mismatch', 'receipt-duplicate', 'receipt-extra-enqueue', 'receipt-unrelated-nonce',
    'receipt-teammate', 'sandbox-socket-unavailable', 'sandbox-unreachable', 'send-observation-delayed',
    'receipt-on-turn', 'receipt-empty-boundary', 'receipt-idle-delayed', 'slow-tool-search', 'tool-search-only'],
});
MUTATIONS.push(...Object.values(CANARY_MUTATIONS).flat().filter(x => !MUTATIONS.includes(x)));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const secrets = new Set();
let redactionFailed = false;
class RedactionError extends Error {
  constructor() { super('OAuth redaction guard refused output; run aborted'); }
}
function assertRedacted(value) {
  if (redactionFailed) throw new RedactionError();
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  for (const secret of secrets) {
    if ([secret, JSON.stringify(secret).slice(1, -1)].some(s => text.includes(s))) {
      redactionFailed = true;
      throw new RedactionError();
    }
  }
}
function writeSafe(file, value, options) {
  assertRedacted(value);
  fs.writeFileSync(file, value, options);
}
const save = (file, value) => writeSafe(file, JSON.stringify(value, null, 2) + '\n');
function output(stream, value) { assertRedacted(value); stream.write(value); }
const lexicallyInside = (parent, child) => { const rel = path.relative(parent, child); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const inside = (parent, child) => lexicallyInside(canonicalLocation(parent), canonicalLocation(child));
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const canonical = p => fs.realpathSync.native(p);
function canonicalLocation(location, rejectLinks = false) {
  let existing = path.resolve(location);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    if (existing === path.dirname(existing)) throw new Error('No accessible ancestor');
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  if (rejectLinks) {
    for (let dir = existing; ; dir = path.dirname(dir)) {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Runtime root must be canonical, without aliases');
      if (dir === path.dirname(dir)) break;
    }
  }
  return path.join(canonical(existing), ...suffix);
}
function loadOAuthToken(opts) {
  if (!opts.oauthTokenFile) return undefined;
  const refuse = () => {
    const err = new Error('OAuth token file refused: require one nonempty line outside repository, evidence, runtime and HOME; no copied credentials');
    err.code = 'OAUTH_TOKEN_REFUSED';
    return err;
  };
  try {
    if (!path.isAbsolute(opts.oauthTokenFile)) throw refuse();
    const file = canonical(opts.oauthTokenFile);
    if ([ROOT, EVIDENCE, opts.out, opts.runtimeRoot, opts.home].some(dir => inside(dir, file))) throw refuse();
    try { fs.lstatSync(path.join(opts.home, '.claude/.credentials.json')); throw refuse(); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 65536) throw refuse();
    const raw = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    if (/[\r\n\x00]/.test(raw) || !raw.trim()) throw refuse();
    const token = raw.trim();
    secrets.add(token);
    return token;
  } catch { throw refuse(); }
}
function sameDirectory(a, b) {
  try {
    const x = fs.statSync(a, { bigint: true }), y = fs.statSync(b, { bigint: true });
    return equalPath(canonical(a), canonical(b)) || (x.ino !== 0n && x.dev === y.dev && x.ino === y.ino);
  } catch { return equalPath(path.resolve(a), path.resolve(b)); }
}

function guardedLocation(location, homes) {
  let existing = path.resolve(location);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    if (existing === path.dirname(existing)) throw new Error('Location has no accessible ancestor');
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const resolved = path.join(canonical(existing), ...suffix);
  const ancestors = [];
  for (let dir = resolved; ; dir = path.dirname(dir)) {
    if (homes.some(home => sameDirectory(dir, home))) throw new Error('Refusing location inside real user home');
    ancestors.push(dir);
    if (dir === path.dirname(dir)) break;
  }
  for (const dir of ancestors) {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/settings.json', '.claude/settings.local.json']) {
      if (fs.existsSync(path.join(dir, name))) throw new Error(`Location has a ${name} ancestor`);
    }
  }
}

class Unverified extends Error {}
class Failed extends Error {}

function parse(argv) {
  const opts = { canary: 'all', dryRun: false, sandbox: false };
  const names = { '--canary': 'canary', '--home': 'home', '--cli': 'cli', '--out': 'out',
    '--platform-label': 'platformLabel', '--mutation': 'mutation', '--timeout-ms': 'timeout', '--runtime-root': 'runtimeRoot',
    '--c1-timeout-ms': 'C1', '--c2-timeout-ms': 'C2', '--c3-timeout-ms': 'C3', '--c4-timeout-ms': 'C4',
    '--oauth-token-file': 'oauthTokenFile' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') opts.dryRun = true;
    else if (argv[i] === '--live') opts.dryRun = false;
    else if (argv[i] === '--sandbox') opts.sandbox = true;
    else if (names[argv[i]] && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[names[argv[i]]] = argv[++i];
    else throw new Error('Unknown argument or missing value');
  }
  if (opts.oauthTokenFile && opts.dryRun) throw new Error('--oauth-token-file is live-only');
  if (!opts.dryRun && !opts.oauthTokenFile) throw new Error('Live runs require --oauth-token-file; copied credentials are forbidden');
  if (!opts.home || !opts.out || !['all', ...Object.keys(CAPS)].includes(opts.canary)) throw new Error('Required: --canary C1|C2|C3|C4|all --home DIR --out DIR [--cli FILE] [--sandbox] [--dry-run] --platform-label LABEL');
  opts.home = path.resolve(opts.home);
  let accountHome;
  try { accountHome = os.userInfo().homedir; } catch {}
  const homes = [accountHome, os.homedir(), process.env.HOME, process.env.USERPROFILE,
    process.env.HOMEDRIVE && process.env.HOMEPATH ? process.env.HOMEDRIVE + process.env.HOMEPATH : null].filter(Boolean);
  if (!opts.dryRun && !opts.runtimeRoot) throw new Error('Live runs require an explicit --runtime-root');
  opts.runtimeRoot = path.resolve(opts.runtimeRoot || path.join(os.tmpdir(), 'switchboard-canary380-runtime'));
  for (const location of [opts.home, opts.runtimeRoot, path.join(opts.runtimeRoot, 'project')]) guardedLocation(location, homes);
  opts.runtimeRoot = canonicalLocation(opts.runtimeRoot, true);
  if (!fs.existsSync(opts.home)) throw new Error('Expected a prepared home containing .claude');
  opts.home = canonical(opts.home);
  const state = path.join(opts.home, '.claude');
  if (!fs.existsSync(state) || !fs.lstatSync(state).isDirectory() || fs.lstatSync(state).isSymbolicLink()) throw new Error('Expected a prepared home with a non-linked .claude directory');
  for (const file of [path.join(opts.home, '.claude.json'), path.join(state, 'sessions')]) {
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Prepared config/publication must not be linked');
  }
  const projects = path.join(state, 'projects');
  if (fs.existsSync(projects) && (fs.lstatSync(projects).isSymbolicLink() || fs.readdirSync(projects).length)) throw new Error('Prepared .claude/projects must be empty');
  opts.out = path.resolve(opts.out);
  if (inside(ROOT, opts.runtimeRoot) || inside(opts.out, opts.runtimeRoot) || inside(opts.runtimeRoot, opts.out) || inside(opts.home, opts.runtimeRoot)) throw new Error('Runtime root must be outside repository, evidence and prepared home');
  opts.limits = { ...LIMITS };
  for (const c of Object.keys(LIMITS)) if (opts[c]) {
    if (!/^\d+$/.test(opts[c]) || +opts[c] < 100 || +opts[c] > 3600000) throw new Error('Per-canary caps must be 100..3600000 ms');
    opts.limits[c] = +opts[c];
  }
  if (!opts.dryRun) {
    const labels = process.platform === 'win32' ? ['windows-conpty-bundled', 'windows-conpty-inbox'] : ['linux-unix-pty'];
    if (!labels.includes(opts.platformLabel)) throw new Error(`Live --platform-label must be one of ${labels.join(', ')}`);
    if (!opts.cli || !path.isAbsolute(opts.cli)) throw new Error('Live --cli must name an absolute executable path');
    opts.cli = fs.realpathSync(opts.cli);
    if (!lexicallyInside(path.join(canonical(ROOT), 'docs/evidence/session-capabilities'), canonicalLocation(opts.out)) ||
      !inside(EVIDENCE, opts.out)) throw new Error('Live --out must be under docs/evidence/session-capabilities');
    if (inside(EVIDENCE, opts.home)) throw new Error('Prepared credential home must be outside committed evidence');
  }
  if (opts.mutation && (!opts.dryRun || !MUTATIONS.includes(opts.mutation))) throw new Error('Known --mutation requires --dry-run');
  if (opts.timeout && (!opts.dryRun || !/^\d+$/.test(opts.timeout) || +opts.timeout < 100 || +opts.timeout > 180000)) throw new Error('--timeout-ms is a bounded dry-run-only option');
  opts.platformLabel ||= 'fixture-only';
  opts.backend = opts.dryRun ? 'emulated-pipes' : opts.platformLabel.replace('windows-', '').replace('linux-', '');
  return opts;
}

function environment(home) {
  const cleaned = cleanEnv(process.env);
  const allow = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_[A-Z_]+|TERM|COLORTERM|TMP|TEMP|CLAUDE_CODE_GIT_BASH_PATH|APPDATA|LOCALAPPDATA|ProgramFiles|USERNAME)$/i;
  const env = Object.fromEntries(Object.entries(cleaned).filter(([key]) => allow.test(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, DISABLE_AUTOUPDATER: '1',
    GIT_AUTHOR_NAME: 'Canary', GIT_AUTHOR_EMAIL: 'canary@example.invalid',
    GIT_COMMITTER_NAME: 'Canary', GIT_COMMITTER_EMAIL: 'canary@example.invalid',
    SWITCHBOARD_DATA_DIR: path.join(home, '.canary-data'),
    SWITCHBOARD_TRIGGERS_DIR: path.join(home, '.canary-triggers') });
  return env;
}

function command(ctx, executable, args, cwd = ctx.repo) {
  const remaining = ctx.deadline - Date.now();
  if (remaining <= 0) throw new Unverified('canary deadline expired');
  const r = spawnSync(executable, args, { cwd, env: ctx.env, encoding: 'utf8', windowsHide: true,
    timeout: Math.min(ctx.opts?.dryRun ? 10000 : 4000, remaining), maxBuffer: 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Unverified(`bounded ${path.basename(executable)} command failed (${r.error?.code || r.status})`);
  return r.stdout;
}

async function until(ctx, predicate, label, maxMs = 20000) {
  const end = Math.min(ctx.deadline, Date.now() + maxMs);
  while (Date.now() < end) {
    if (interrupted && !ctx.cleanup) throw new Unverified('interrupted');
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, Math.min(ctx.opts?.dryRun ? 10 : 50, Math.max(1, end - Date.now()))));
  }
  throw new Unverified(`timeout: ${label}`);
}

function check(ctx, name, pass, detail = {}) {
  ctx.evidence.checks.push({ sequence: ++ctx.observation, at: new Date().toISOString(), name, pass: !!pass, ...detail });
  if (!pass) throw new Failed(name);
}

function entries(dir, depth = 0) {
  if (depth > 4 || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? entries(p, depth + 1) : e.isFile() ? [p] : [];
  });
}

function transcript(ctx, id) {
  const paths = ctx.opts.dryRun ? (ctx.transcriptPaths ||= new Map()) : null;
  let file = paths?.get(id);
  if (!file || !fs.existsSync(file)) {
    file = entries(path.join(ctx.opts.home, '.claude/projects')).find(p => path.basename(p) === `${id}.jsonl`);
    if (file) paths?.set(id, file);
    else paths?.delete(id);
  }
  if (!file) return { file: null, rows: [], bytes: 0 };
  if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Unverified('transcript exceeds bounded reader size');
  const text = fs.readFileSync(file, 'utf8');
  let offset = 0;
  const rows = [];
  for (const line of text.split('\n')) {
    try { rows.push({ ...JSON.parse(line), _offset: offset }); } catch {}
    offset += Buffer.byteLength(line) + 1;
  }
  return { file, rows, bytes: Buffer.byteLength(text) };
}

function content(row) {
  const c = row.message?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
}
const users = rows => rows.filter(r => r.type === 'user' && !r.isMeta && !/<local-command-caveat>/.test(content(r)) && !(Array.isArray(r.message?.content) && r.message.content.some(x => x.type === 'tool_result')));
const blocks = rows => rows.flatMap(r => Array.isArray(r.message?.content) ? r.message.content.map(b => ({ ...b, _offset: r._offset })) : []);
const flatText = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(flatText).join('\n') : value && typeof value === 'object' ? flatText(value.text ?? value.content ?? '') : '';
const normal = value => (process.platform === 'win32' ? String(value).toLowerCase() : String(value)).replace(/\\+/g, '/');

function received(ctx, row, payload) {
  const raw = content(row);
  const envelope = /^(\n*)<pasted_content id="([a-zA-Z0-9_-]{1,64})">\r?\n([\s\S]*?)\n<\/pasted_content id="\2">(\n*)$/.exec(raw);
  const body = envelope ? envelope[3] : raw;
  const literal = Buffer.from(body).equals(Buffer.from(payload));
  const placeholder = /^\[Pasted text(?:\s|\])/.test(body);
  const transformations = byteTransformations(payload, body);
  const inputBytes = Buffer.from(payload), storedBytes = Buffer.from(body);
  const emojiBytes = Buffer.from('😀');
  const emoji = { inputByteOffset: inputBytes.indexOf(emojiBytes), storedByteOffset: storedBytes.indexOf(emojiBytes),
    preserved: inputBytes.includes(emojiBytes) && storedBytes.includes(emojiBytes), hex: emojiBytes.toString('hex') };
  let boundaryChange = null;
  if (inputBytes.length > storedBytes.length) {
    const removedBytes = inputBytes.length - storedBytes.length;
    if (inputBytes.subarray(0, storedBytes.length).equals(storedBytes) && /^\s+$/.test(inputBytes.subarray(storedBytes.length).toString('utf8'))) {
      boundaryChange = { side: 'trailing', offset: storedBytes.length, removedHex: inputBytes.subarray(storedBytes.length).toString('hex'), removedBytes };
    } else if (inputBytes.subarray(removedBytes).equals(storedBytes) && /^\s+$/.test(inputBytes.subarray(0, removedBytes).toString('utf8'))) {
      boundaryChange = { side: 'leading', offset: 0, removedHex: inputBytes.subarray(0, removedBytes).toString('hex'), removedBytes };
    }
  }
  const cache = path.join(ctx.opts.home, '.claude/paste-cache');
  const pasteCache = [];
  let linked = false;
  const reference = typeof row.pasteRef === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(row.pasteRef) ? row.pasteRef : null;
  let hasReference = !!reference;
  if (fs.existsSync(cache) && fs.lstatSync(cache).isDirectory() && !fs.lstatSync(cache).isSymbolicLink()) {
    for (const name of fs.readdirSync(cache).slice(0, 128)) {
      const file = path.join(cache, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) continue;
      const bytes = fs.readFileSync(file);
      pasteCache.push({ bytes: bytes.length, sha256: hash(bytes) });
      if (name === reference || envelope && [envelope[2], `${envelope[2]}.txt`].includes(name)) {
        hasReference = true;
        if (bytes.equals(Buffer.from(payload))) linked = true;
      }
    }
  }
  return { literal, linked, exact: literal || linked, hasReference, placeholder,
    wrapperPresent: !!envelope, wrapperId: envelope?.[2] ?? null,
    openingTagLineEnding: envelope ? raw.slice(envelope[1].length).startsWith(`<pasted_content id="${envelope[2]}">\r\n`) ? 'CRLF' : 'LF' : null,
    envelopePrefix: envelope ? JSON.stringify(envelope[1]).slice(1, -1) : null,
    envelopeSuffix: envelope ? JSON.stringify(envelope[4]).slice(1, -1) : null,
    literalAfterKnownTransformations: !transformations.includes('unclassified-byte-change'), transformations, pasteCache,
    storedBodyBytes: Buffer.byteLength(body), storedBodySha256: hash(body), boundaryChange, emoji };
}

function byteTransformations(payload, body) {
  if (payload === body) return [];
  const operations = [
    ...Array.from({ length: 8 }, (_, i) => [`tab-to-${i + 1}-spaces`, s => s.replaceAll('\t', ' '.repeat(i + 1))]),
    ['lf-to-crlf', s => s.replace(/(?<!\r)\n/g, '\r\n')],
    ['crlf-to-lf', s => s.replaceAll('\r\n', '\n')],
    ['trailing-whitespace-removed', s => s.replace(/[ \t]+(?=\r?$)/gm, '')],
    ['trailing-whitespace-added', s => s + (body.match(/\s+$/)?.[0] || '')],
  ];
  const candidates = [{ text: payload, changes: [] }];
  for (const [name, apply] of operations) {
    for (const candidate of [...candidates]) {
      if (candidate.changes.includes(name)) continue;
      const text = apply(candidate.text);
      if (text !== candidate.text && !candidates.some(x => x.text === text)) candidates.push({ text, changes: [...candidate.changes, name] });
    }
  }
  candidates.sort((a, b) => a.changes.length - b.changes.length);
  const exact = candidates.find(x => x.text === body);
  if (exact) return exact.changes;
  const truncated = candidates.find(x => body.length < x.text.length && x.text.startsWith(body));
  if (truncated) return [...truncated.changes, 'truncation'];
  return ['unclassified-byte-change'];
}

function sandboxPlan(ctx, cwd, settings, privateSessions) {
  const home = ctx.opts.home;
  const state = path.join(home, '.claude');
  const rwNames = new Set(['todos', 'statsig', 'file-history', 'plans', 'tasks', 'cache', 'paste-cache', 'image-cache', 'downloads', 'feedback', 'debug', 'telemetry', 'jobs', 'usage-data', 'agent-memory', '.credentials.json', 'history.jsonl', '.last-cleanup', '.last-update-result.json', 'mcp-needs-auth-cache.json', 'policy-limits.json', 'policy-limits.json.stamp.json', 'stats-cache.json']);
  const args = ['--unshare-all', '--share-net', '--die-with-parent', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--dir', '/var', '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc'];
  for (const [target, source] of [['/bin', 'usr/bin'], ['/sbin', 'usr/sbin'], ['/lib', 'usr/lib'], ['/lib64', 'usr/lib64']]) args.push('--symlink', source, target);
  for (const file of ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/host.conf', '/etc/gai.conf']) {
    if (!fs.existsSync(file)) continue;
    const real = fs.realpathSync(file);
    if (!real.startsWith('/usr/') && !real.startsWith('/etc/')) {
      const source = real.startsWith('/run/') ? path.dirname(real) : real;
      if (inside(source, home)) throw new Unverified('resolver mount overlaps isolated home');
      args.push('--ro-bind', source, source);
    }
  }
  const cliDir = path.dirname(ctx.opts.cli || FIXTURE);
  if (!inside('/usr', cliDir)) args.push('--ro-bind', cliDir, cliDir);
  args.push('--bind', cwd, cwd, '--ro-bind', path.join(cwd, '.claude'), path.join(cwd, '.claude'));
  args.push('--bind', path.join(ctx.repo, '.git'), path.join(ctx.repo, '.git'));
  for (const p of ['config', 'hooks']) {
    const file = path.join(ctx.repo, '.git', p);
    args.push('--ro-bind', file, file);
  }
  args.push('--tmpfs', state);
  for (const e of fs.readdirSync(state, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw new Unverified('prepared .claude contains a linked entry; exact sandbox unsupported');
    if (['sessions', 'projects', 'shell-snapshots', 'session-env', 'backups', 'state'].includes(e.name)) continue;
    const p = path.join(state, e.name);
    args.push(rwNames.has(e.name) ? '--bind' : '--ro-bind', p, p);
  }
  const projects = path.join(state, 'projects');
  const project = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  args.push('--ro-bind', projects, projects, '--bind', project, project,
    '--bind', privateSessions, path.join(state, 'sessions'));
  for (const p of ['shell-snapshots', 'session-env', 'backups', 'state']) args.push('--tmpfs', path.join(state, p));
  for (const p of ['.config/claude', '.cache/claude', '.local/share/claude']) {
    const dir = path.join(home, p); fs.mkdirSync(dir, { recursive: true }); args.push('--bind', dir, dir);
  }
  const config = path.join(ctx.private, `${path.basename(privateSessions)}-claude.json`);
  const prepared = path.join(home, '.claude.json');
  if (!fs.existsSync(config)) writeSafe(config, fs.existsSync(prepared) ? fs.readFileSync(prepared) : '{}', { mode: 0o600 });
  args.push('--bind', config, path.join(home, '.claude.json'), '--dir', '/run', '--perms', '0555', '--dir', '/run/switchboard',
    '--ro-bind', settings, '/run/switchboard/launch-settings.json', '--chdir', cwd, '--setenv', 'SHELL', '/bin/bash');
  return args;
}

function probeMounts(ctx, plan, sessions, settings) {
  const peer = fs.mkdtempSync(path.join(ctx.opts.home, '.claude/sessions/peer-'));
  const peerFile = path.join(peer, 'peer-marker');
  writeSafe(peerFile, 'peer');
  const ordinary = path.join(ctx.repo, `mount-probe-${crypto.randomUUID()}`);
  const code = 'set -eu; printf own > "$1/publication-probe"; test ! -e "$2"; '
    + 'if (printf changed > "$3") 2>/dev/null; then exit 20; fi; '
    + 'if mv "$3" "$3.moved" 2>/dev/null; then exit 22; fi; '
    + 'test ! -w "$5"; test ! -w "$6"; test ! -w /run/switchboard; '
    + 'printf ordinary > "$4"';
  command(ctx, 'bwrap', [...plan, '/bin/sh', '-c', code, 'mount-probe',
    path.join(ctx.opts.home, '.claude/sessions'), peerFile, '/run/switchboard/launch-settings.json', ordinary,
    ctx.env.SWITCHBOARD_TRIGGERS_DIR, ctx.private]);
  check(ctx, 'sandbox launch settings immutable; project and own publication writable',
    fs.readFileSync(path.join(sessions, 'publication-probe'), 'utf8') === 'own' &&
    fs.readFileSync(peerFile, 'utf8') === 'peer' && fs.existsSync(settings) &&
    fs.readFileSync(ordinary, 'utf8') === 'ordinary');
  const peerPlan = sandboxPlan(ctx, ctx.repo, settings, peer);
  command(ctx, 'bwrap', [...peerPlan, '/bin/sh', '-c', code, 'peer-mount-probe',
    path.join(ctx.opts.home, '.claude/sessions'), path.join(sessions, 'publication-probe'), '/run/switchboard/launch-settings.json', ordinary,
    ctx.env.SWITCHBOARD_TRIGGERS_DIR, ctx.private]);
  check(ctx, 'second namespace writes only its publication and cannot reach first generation',
    fs.readFileSync(path.join(peer, 'publication-probe'), 'utf8') === 'own' &&
    fs.readFileSync(path.join(sessions, 'publication-probe'), 'utf8') === 'own');
  (ctx.evidence.peerMountPlans ||= []).push(peerPlan);
  ctx.evidence.bwrapVersion = command(ctx, 'bwrap', ['--version']).trim().replace(/[^\w .+-]/g, '').slice(0, 120);
}

function watchFork(ctx) {
  const dir = path.join(ctx.opts.home, '.claude/projects');
  const existing = new Set(entries(dir));
  const timeline = [];
  let watcher;
  try {
    watcher = fs.watch(dir, { recursive: true }, () => {
      try {
        for (const file of entries(dir).filter(p => p.endsWith('.jsonl') && !existing.has(p))) {
          const id = path.basename(file, '.jsonl');
          const t = transcript(ctx, id);
          const last = timeline.at(-1);
          if (last?.transcriptId !== id || last.bytes !== t.bytes) timeline.push({
            at: new Date().toISOString(), transcriptId: id, bytes: t.bytes, lines: t.rows.length,
            titleOffsets: t.rows.filter(r => ['custom-title', 'agent-name'].includes(r.type)).map(r => r._offset) });
        }
      } catch {}
    });
    watcher.on('error', () => { timeline.push({ observation: 'watcher unavailable' }); });
    ctx.watchers.push(watcher);
  } catch { timeline.push({ observation: 'recursive watcher unavailable' }); }
  return { timeline, close: () => watcher?.close() };
}

function linuxProcesses() {
  const processes = [];
  for (const name of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8').split(') ').at(-1).split(' ');
      processes.push({ pid: +name, parent: +stat[1], start: stat[19] });
    } catch {}
  }
  return processes;
}

function processStart(pid) {
  if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19];
  if (process.platform === 'win32') {
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`],
    { encoding: 'utf8', timeout: 4000, windowsHide: true });
    const result = probe.stdout?.trim();
    if (probe.status === 0 && /^\d{17,19}$/.test(result)) return result;
  }
  throw new Unverified('owned process creation time unavailable');
}

function descriptor(ctx, proc) {
  if (!proc.pid || proc.exited) return null;
  const dir = proc.sessions;
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(x => /^\d+\.json$/.test(x));
  if (ctx.opts.dryRun) {
    const owned = files.indexOf(`${proc.pid}.json`);
    if (owned > 0) files.unshift(...files.splice(owned, 1));
  }
  for (const file of files) {
    try {
      const descriptorFile = path.join(dir, file);
      if (fs.statSync(descriptorFile).size > 65536) continue;
      const bytes = fs.readFileSync(descriptorFile);
      if (proc.preexisting.get(file) === hash(bytes)) continue;
      const d = JSON.parse(bytes.toString('utf8'));
      const started = typeof d.startedAt === 'number' ? d.startedAt : Date.parse(d.startedAt);
      if (!Number.isFinite(started) || started < proc.spawnedAt || (proc.requestedId && d.sessionId !== proc.requestedId)) continue;
      if ((!proc.sandbox || ctx.opts.dryRun) && d.pid === proc.pid && String(d.procStart) === proc.procStart) return d;
      if (proc.sandbox && process.platform === 'linux') {
        const all = linuxProcesses();
        const owned = new Set([proc.pid]);
        for (let depth = 0; depth < 12; depth++) for (const p of all) if (owned.has(p.parent)) owned.add(p.pid);
        const candidates = [];
        for (const p of all.filter(p => owned.has(p.pid))) {
          try {
            const status = fs.readFileSync(`/proc/${p.pid}/status`, 'utf8');
            const inner = +(status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).at(-1));
            if (inner === d.pid && String(d.procStart) === p.start) candidates.push({ ...p, inner,
              namespace: fs.readlinkSync(`/proc/${p.pid}/ns/pid`) });
          } catch {}
        }
        if (candidates.length === 1) {
          const p = candidates[0];
          const current = fs.statSync(dir, { bigint: true });
          if (current.dev !== proc.directoryIdentity.dev || current.ino !== proc.directoryIdentity.ino) return null;
          if (proc.writerPid && (proc.writerPid !== p.pid || proc.procStart !== p.start || proc.namespace !== p.namespace)) return null;
          proc.writerPid = p.pid; proc.namespace = p.namespace;
          proc.innerPid = p.inner; proc.procStart = p.start;
          return d;
        }
      }
    } catch {}
  }
  return null;
}

function rememberDescriptor(proc, d) {
  if (!d) return;
  proc.record.lastDescriptor = { observedAt: Date.now(), status: d.status,
    statusUpdatedAt: d.statusUpdatedAt ?? null, waitingFor: d.waitingFor ?? null };
  proc.record.waitingFor = d.waitingFor ?? null;
}

async function launch(ctx, { cwd = ctx.repo, args = [], sandbox = false, settings, mutation = ctx.opts.mutation } = {}) {
  if (!ctx.opts.dryRun && sandbox && process.platform !== 'linux') throw new Unverified('bubblewrap is Linux-only');
  trusted(ctx, args.includes('--worktree') ? path.join(ctx.repo, '.claude/worktrees', args[args.indexOf('--worktree') + 1]) : cwd);
  const sid = crypto.randomUUID();
  const cliArgs = args.includes('--fork-session') ? args : ['--session-id', sid, ...args];
  const sessions = sandbox && !(ctx.opts.dryRun && mutation === 'shared-descriptors')
    ? fs.mkdtempSync(path.join(ctx.runtime, 'generation-')) : path.join(ctx.opts.home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const env = { ...ctx.env };
  const fixtureStart = crypto.randomUUID();
  let exe, argv, plan = null;
  if (ctx.opts.dryRun) {
    Object.assign(env, { CANARY_FIXTURE_MUTATION: mutation || '', CANARY_FIXTURE_SESSIONS: sessions,
      CANARY_FIXTURE_SANDBOX: sandbox ? '1' : '', CANARY_FIXTURE_PROC_START: fixtureStart, CANARY_FIXTURE_RUNTIME: ctx.runtime,
      CANARY_FIXTURE_WINDOWS_MESSAGING: windowsExecution(ctx) ? '1' : '' });
    if (mutation === 'parent-env') env.CLAUDE_CODE_MESSAGING_TOKEN = 'fixture-only-not-a-real-token';
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    exe = process.execPath; argv = [FIXTURE, ...cliArgs];
    if (sandbox) plan = sandboxPlan(ctx, cwd, settings || ctx.emptySettings, sessions);
  } else {
    if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== '1') throw new Unverified('Electron requires ELECTRON_RUN_AS_NODE=1; no window is allowed');
    exe = ctx.opts.cli; argv = cliArgs;
    if (sandbox) {
      plan = sandboxPlan(ctx, cwd, settings, sessions);
      command(ctx, 'bwrap', [...plan, '/bin/true'], cwd);
      probeMounts(ctx, plan, sessions, settings);
      exe = 'bwrap'; argv = [...plan, ctx.opts.cli, ...cliArgs];
    }
  }
  if (settings) argv.push('--settings', sandbox && !ctx.opts.dryRun ? '/run/switchboard/launch-settings.json' : settings);
  if (ctx.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = ctx.oauthToken;
  assertRedacted(JSON.stringify([exe, argv]));
  const descriptorFiles = fs.readdirSync(sessions).filter(x => /^\d+\.json$/.test(x));
  const preexisting = new Map();
  if (ctx.opts.dryRun) {
    for (let at = 0; at < descriptorFiles.length; at += 8) {
      const batch = await Promise.all(descriptorFiles.slice(at, at + 8).map(async file => {
        const p = path.join(sessions, file);
        const stat = await fs.promises.stat(p);
        return [file, stat.size <= 65536 ? hash(await fs.promises.readFile(p)) : 'oversized'];
      }));
      for (const [file, sha256] of batch) preexisting.set(file, sha256);
    }
  } else {
    for (const file of descriptorFiles) {
      const p = path.join(sessions, file);
      preexisting.set(file, fs.statSync(p).size <= 65536 ? hash(fs.readFileSync(p)) : 'oversized');
    }
  }
  const spawnedAt = Date.now();
  const osc = [];
  let tail = '';
  const observe = data => {
    tail = (tail + String(data)).slice(-4096);
    const sequences = [...tail.matchAll(/\x1b\](0|9);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)];
    for (const match of sequences) {
      const progress = match[1] === '9' && /^4;([0-4]);/.exec(match[2]);
      osc.push({ at: Date.now(), code: progress ? '9;4' : match[1],
        ...(progress ? { level: progress[1] } : { payloadSha256: hash(match[2]) }) });
    }
    if (sequences.length) tail = tail.slice(sequences.at(-1).index + sequences.at(-1)[0].length);
    if (osc.length > 64) osc.splice(0, osc.length - 64);
  };
  let child;
  if (ctx.ptyFactory) {
    child = ctx.ptyFactory(exe, argv, { cwd, env });
    child.onData(observe);
  } else if (ctx.opts.dryRun) {
    child = spawn(exe, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', observe); child.stderr.resume();
  } else {
    let pty;
    try { pty = require('node-pty'); }
    catch { throw new Unverified('node-pty ABI mismatch: use matching Electron with ELECTRON_RUN_AS_NODE=1 or an available Node-ABI node-pty; never rebuild shared node_modules'); }
    try {
      child = pty.spawn(exe, argv, { cwd, env, name: 'xterm-256color', cols: 120, rows: 40,
        useConptyDll: ctx.opts.backend === 'conpty-bundled' });
      child.onData(observe);
    } catch { throw new Unverified('node-pty spawn/ABI failure; use a matching Node or Electron runtime; backend fallback is forbidden'); }
  }
  const ds = fs.statSync(sessions, { bigint: true });
  const proc = { child, isPty: !!ctx.ptyFactory || !ctx.opts.dryRun, pid: child.pid, sessions, sandbox, directoryIdentity: { dev: ds.dev, ino: ds.ino },
    preexisting, spawnedAt, requestedId: cliArgs.includes('--session-id') ? cliArgs[cliArgs.indexOf('--session-id') + 1] : null,
    procStart: ctx.opts.dryRun ? fixtureStart : null, envKeys: Object.keys(env), osc, exited: false, id: null };
  OWNED.add(proc);
  const record = { pid: child.pid, sandbox, backend: ctx.opts.backend, cleaned: false, waitingFor: null, argv: ctx.opts.dryRun ? cliArgs : argv, mountPlan: plan };
  record.environmentKeys = proc.envKeys.sort();
  proc.record = record;
  if (plan) record.privateConfigSha256 = hash(fs.readFileSync(path.join(ctx.private, `${path.basename(sessions)}-claude.json`)));
  ctx.processes.push(proc); ctx.evidence.processes.push(record);
  if (ctx.ptyFactory) child.onExit(() => { proc.exited = true; });
  else if (ctx.opts.dryRun) {
    child.stdin.on('error', () => {});
    child.on('error', err => { record.processError = err.code || err.name; if (!child.pid) proc.exited = true; });
    child.on('exit', () => { proc.exited = true; });
  } else child.onExit(() => { proc.exited = true; });
  await until(ctx, () => {
    if (proc.exited) throw new Unverified('owned CLI exited before pid ready');
    proc.pid = child.pid;
    return proc.pid > 0;
  }, 'owned CLI non-zero pid');
  record.pid = proc.pid;
  if (!ctx.opts.dryRun && !sandbox) proc.procStart = processStart(proc.pid);
  const ready = await until(ctx, () => {
    if (proc.exited) throw new Unverified('owned CLI exited before idle');
    const d = descriptor(ctx, proc);
    rememberDescriptor(proc, d);
    if (d?.status === 'waiting') { record.waitingFor = d.waitingFor || 'unknown'; throw new Unverified('owned CLI blocking dialog at launch'); }
    if (d?.waitingFor) record.waitingFor = d.waitingFor;
    return d?.status === 'idle' ? d : null;
  }, 'owned CLI idle descriptor');
  proc.id = ready.sessionId; proc.cwd = ready.cwd; proc.name = ready.name;
  record.sessionId = proc.id; record.cwd = proc.cwd;
  record.descriptorSource = path.relative(ctx.run, sessions).replaceAll('\\', '/');
  record.namespace = proc.namespace || null; record.innerPid = proc.innerPid || null; record.procStart = proc.procStart || null;
  record.writerHostPid = proc.writerPid || proc.pid; record.directoryIdentity = { dev: String(ds.dev), ino: String(ds.ino) };
  return proc;
}

async function submit(ctx, proc, payload, { maxMs = !payload.startsWith('/rename ') && ctx.turnBudgetMs || 20000, finalReply, observe, onSubmitted } = {}) {
  if (proc.exited) throw new Unverified('owned CLI exited before submit');
  const before = transcript(ctx, proc.id);
  const time = Date.now();
  const bytes = '\x1b[200~' + payload + '\x1b[201~';
  if (!proc.isPty) { proc.child.stdin.write(bytes); proc.child.stdin.write('\r'); }
  else { proc.child.write(bytes); proc.child.write('\r'); }
  let lastBytes = before.bytes, stableSince = Date.now();
  const phase = payload.startsWith('/rename ') ? 'rename' : /^CANARY_META /.test(payload) ? 'tool task' : 'ordinary turn';
  const submission = { phase, beforeBytes: before.bytes, submittedAt: time, waitBudgetMs: maxMs, outcome: 'UNVERIFIED' };
  (proc.record.submissions ||= []).push(submission);
  try {
    if (onSubmitted) await onSubmitted();
    await until(ctx, () => {
      if (proc.exited) throw new Unverified('owned CLI exited before confirmation');
      const t = transcript(ctx, proc.id);
      const d = descriptor(ctx, proc);
      rememberDescriptor(proc, d);
      if (observe) {
        if (observe(t.rows.filter(r => r._offset >= before.bytes))) {
          submission.confirmation = 'observation';
          return t;
        }
        return null;
      }
      if (d?.status === 'waiting') { proc.record.waitingFor = d.waitingFor || 'unknown'; throw new Unverified('owned CLI blocking dialog before confirmation'); }
      if (d?.waitingFor) proc.record.waitingFor = d.waitingFor;
      if (t.bytes !== lastBytes) { lastBytes = t.bytes; stableSince = Date.now(); }
      const renamed = payload.startsWith('/rename ') && t.rows.some(r => r._offset >= before.bytes && r.type === 'custom-title');
      const replied = !finalReply || t.rows.some(r => r._offset >= before.bytes && r.type === 'assistant' && content(r).trim() === finalReply);
      if (replied && t.bytes > before.bytes && d?.status === 'idle' && (d.statusUpdatedAt >= time || renamed) && Date.now() - stableSince >= (ctx.opts.dryRun ? 20 : 100)) {
        proc.record.descriptorConfirmation = { submittedAt: time, observedAt: Date.now(), status: d.status,
          statusUpdatedAt: d.statusUpdatedAt ?? null, waitingFor: d.waitingFor ?? null };
        proc.record.oscObservations = proc.osc.filter(x => x.at >= time);
        return t;
      }
      return null;
    }, observe ? 'native send result and receipt observation' : `new transcript${finalReply ? ', explicit final reply' : ''} and owned post-submit idle: ${phase}`, maxMs);
    submission.outcome = 'PASS';
    return transcript(ctx, proc.id).rows.filter(r => r._offset >= before.bytes);
  } finally {
    rememberDescriptor(proc, descriptor(ctx, proc));
    submission.observedAt = Date.now();
    submission.descriptor = proc.record.lastDescriptor ?? null;
    proc.record.oscObservations = proc.osc.filter(x => x.at >= time);
    try {
      const t = transcript(ctx, proc.id);
      const rows = t.rows.filter(r => r._offset >= before.bytes);
      submission.transcriptBytes = t.bytes;
      submission.rowCount = rows.length;
      submission.lastRows = rows.slice(-16).map(r => ({ type: r.type, offset: r._offset,
        blocks: blocks([r]).map(b => ({ type: b.type, ...(b.type === 'tool_use' ? { name: b.name } : {}) })) }));
    } catch (err) { submission.snapshotError = err.code || err.name; }
  }
}

async function stop(ctx, proc) {
  if (proc.record.cleaned) return;
  if (!proc.exited) {
    if (proc.id && (proc.record.descriptorConfirmation || proc.gracefulStop)) {
      const shutdown = proc.record.shutdown = { stable: false, gracefulExit: false, forcedKill: false };
      try {
        const quietMs = ctx.opts.dryRun ? 10 : 1000;
        let lastBytes = transcript(ctx, proc.id).bytes, stableSince = Date.now();
        try {
          await until({ opts: ctx.opts, cleanup: true, deadline: Date.now() + (ctx.opts.dryRun ? 500 : 5000) }, () => {
            const bytes = transcript(ctx, proc.id).bytes;
            if (bytes !== lastBytes) { lastBytes = bytes; stableSince = Date.now(); }
            return proc.exited || Date.now() - stableSince >= quietMs;
          }, 'transcript quiescence', 5000);
          shutdown.stable = true;
        } catch { shutdown.quiescenceTimedOut = true; }
        shutdown.beforeExitBytes = lastBytes;
        shutdown.exitRequestedAt = Date.now();
        if (!proc.exited) {
          try {
            if (proc.isPty) proc.child.write('/exit\r');
            else proc.child.stdin.write('/exit\r');
            await until({ opts: ctx.opts, cleanup: true, deadline: Date.now() + 2000 }, () => proc.exited, 'graceful owned process exit', 2000);
            shutdown.gracefulExit = true;
          } catch { shutdown.gracefulExitTimedOut = true; }
        }
        shutdown.finalBytes = transcript(ctx, proc.id).bytes;
      } catch { shutdown.transcriptReadFailed = true; }
    }
    if (!proc.exited) {
      if (proc.record.shutdown) proc.record.shutdown.forcedKill = true;
      proc.child.kill();
      await until({ opts: ctx.opts, cleanup: true, deadline: Date.now() + 2000 }, () => proc.exited, 'owned process exit', 2000);
    }
  }
  proc.record.cleaned = proc.exited;
  if (proc.exited) OWNED.delete(proc);
}

function inventory(ctx) {
  if (ctx.opts.dryRun) return json(path.join(ctx.runtime, 'worktree-inventory.json'));
  return command(ctx, 'git', ['worktree', 'list', '--porcelain']).split('\n').filter(x => x.startsWith('worktree ')).map(x => path.resolve(x.slice(9)));
}

function validateDeliveryPayload(payload) {
  if (!payload.length) throw new Failed('empty delivery payload');
  if (/^\s|\s$/.test(payload)) throw new Failed('delivery payload has boundary whitespace');
  return payload;
}

async function c1(ctx) {
  const results = [];
  for (const [index, size] of [180, 5000, 32768, 49152, 256, 180].entries()) {
    const rawControl = index === 5;
    const whitespaceBoundary = index === 4;
    const nonce = crypto.randomUUID();
    const prefix = `${whitespaceBoundary ? ' \n  ' : ''}CANARY ${nonce}\nLiteral LF\tTAB \"quotes\" 'single' café 東京 😀\nReply only OK.\n`;
    const expanded = rawControl ? prefix : prefix.replaceAll('\t', '    ');
    const suffix = whitespaceBoundary ? '  \n \n' : '';
    const payload = expanded + 'x'.repeat(size - Buffer.byteLength(expanded + suffix)) + suffix;
    const validation = { accepted: true, rule: 'reject-leading-or-trailing-whitespace' };
    try { validateDeliveryPayload(payload); }
    catch (err) {
      validation.accepted = false;
      validation.reason = err.message;
      if (!whitespaceBoundary) throw err;
    }
    let proc;
    try {
      proc = await launch(ctx);
      const before = transcript(ctx, proc.id).bytes;
      await submit(ctx, proc, payload);
      const confirmed = transcript(ctx, proc.id).bytes;
      await stop(ctx, proc);
      const final = transcript(ctx, proc.id);
      const rows = final.rows.filter(r => r._offset >= before);
      const deliveryEnd = proc.record.shutdown?.beforeExitBytes ?? confirmed;
      const turns = users(rows.filter(r => r._offset < deliveryEnd));
      const one = turns.length === 1;
      const stored = one ? received(ctx, turns[0], payload) : { exact: false, literal: false, linked: false };
      const reaction = rows.some(r => r.type === 'assistant' && r._offset > (turns[0]?._offset ?? Infinity));
      const result = { one, ...stored, literal: stored.wrapperPresent && stored.literal, reaction };
      if (!rawControl && validation.accepted) results.push(result);
      const observation = { bytes: size, sha256: hash(payload), nonce, userTurns: turns.length,
        inputTabs: (prefix.match(/\t/g) || []).length, deliveredTabs: (payload.match(/\t/g) || []).length,
        containsEmoji: payload.includes('😀'), whitespaceBoundary, validation,
        ...(whitespaceBoundary ? { informational: true, branch: '6238870479 section 1: reject boundary whitespace' } : {}),
        boundaryChange: stored.boundaryChange, emoji: stored.emoji, openingTagLineEnding: stored.openingTagLineEnding ?? null,
        literal: stored.literal, linkedPaste: stored.linked, independentlyObservedReaction: reaction,
        wrapperPresent: stored.wrapperPresent ?? false, wrapperId: stored.wrapperId ?? null,
        envelopePrefix: stored.envelopePrefix ?? null, literalAfterKnownTransformations: stored.literalAfterKnownTransformations ?? false,
        envelopeSuffix: stored.envelopeSuffix ?? null,
        transformations: stored.transformations ?? [], pasteCache: stored.pasteCache ?? [],
        storedBodyBytes: stored.storedBodyBytes, storedBodySha256: stored.storedBodySha256,
        singleTurnDelivery: one, eligibleConfirmation: one && reaction,
        descriptorConfirmation: proc.record.descriptorConfirmation, oscObservations: proc.record.oscObservations,
        transcriptId: proc.id, userOffsets: turns.map(r => r._offset),
        transcriptConfirmedBytes: confirmed, transcriptFinalBytes: final.bytes,
        finalRowTypes: rows.map(r => ({ type: r.type, offset: r._offset })) };
      if (rawControl) ctx.evidence.rawTabControl = { ...observation, informational: true };
      else ctx.evidence.payloads.push(observation);
      if (rawControl) break;
    } catch (err) {
      if (!rawControl && !whitespaceBoundary) throw err;
      const observation = { bytes: size, sha256: hash(payload), nonce, validation, whitespaceBoundary,
        informational: true, status: 'UNVERIFIED', failure: err.message };
      if (rawControl) ctx.evidence.rawTabControl = observation;
      else ctx.evidence.payloads.push(observation);
      if (proc) await stop(ctx, proc);
      if (rawControl) break;
    }
  }
  ctx.evidence.controls.push({ name: 'short literal control', status: results[0].one && results[0].literal && results[0].reaction ? 'PASS' : 'FAIL' });
  capability(ctx, 'singleTurnDelivery', results.every(x => x.one) ? 'PASS' : 'FAIL');
  capability(ctx, 'literalTranscript', results.every(x => x.literal) ? 'PASS' : 'FAIL');
  capability(ctx, 'eligibleConfirmation', results.every(x => x.one && x.reaction) ? 'PASS' : 'FAIL');
  check(ctx, 'one received user turn at every size', ctx.capabilities.singleTurnDelivery);
  check(ctx, 'eligible post-submit confirmation at every size', ctx.capabilities.eligibleConfirmation);
  ctx.evidence.checks.push({ sequence: ++ctx.observation, at: new Date().toISOString(),
    name: 'paste-cache reference (informational)', pass: results.every(x => !x.hasReference || x.linked), informational: true });
  check(ctx, 'literal envelope body equals delivered bytes at every size', ctx.capabilities.literalTranscript);
}

async function c2(ctx) {
  ctx.turnBudgetMs = 90000;
  for (const atWorktree of [false, true]) {
    let cwd = ctx.repo;
    if (atWorktree) {
      cwd = path.join(ctx.runtime, 'W1');
      if (ctx.opts.dryRun) save(path.join(ctx.runtime, 'worktree-inventory.json'), [...inventory(ctx), cwd]);
      else command(ctx, 'git', ['worktree', 'add', '-qb', 'fixture-W1', cwd]);
      fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    }
    for (const large of [false, true]) {
      const origin = await launch(ctx, { cwd });
      const sentinel = `SENTINEL_${crypto.randomUUID()}`;
      await submit(ctx, origin, `Remember this conversation-only sentinel ${sentinel}; reply OK without tools.`);
      const titles = large ? [`A-${crypto.randomUUID()}`, `B-${crypto.randomUUID()}`] : [`S-${crypto.randomUUID()}`];
      await submit(ctx, origin, `/rename ${titles[0]}`);
      if (large) {
        for (let n = 0; n < 6; n++) await submit(ctx, origin, `Reply OK, no tools. Padding ${n}\n` + 'z'.repeat(48000));
        await submit(ctx, origin, `/rename ${titles[1]}`);
      }
      const source = transcript(ctx, origin.id);
      const sourceHash = hash(fs.readFileSync(source.file));
      const sourceBytes = fs.readFileSync(source.file);
      if (large && !(source.rows.find(r => r.type === 'custom-title' && (r.customTitle || r.custom_title) === titles[1])?._offset > 262144)) {
        throw new Unverified('large-origin B title did not land beyond the 256 KiB head window');
      }
      check(ctx, 'origin CLI rename is stored', source.rows.some(r => r.type === 'custom-title' && (r.customTitle || r.custom_title) === titles.at(-1)));
      const before = inventory(ctx);
      const name = `canary-${atWorktree ? 'W1' : 'root'}-${large ? 'large' : 'small'}`;
      const watched = watchFork(ctx);
      const fork = await launch(ctx, { cwd: origin.cwd, args: ['--resume', origin.id, '--fork-session', '--worktree', name] });
      check(ctx, 'fork has new identity', fork.id !== origin.id);
      const prefix = transcript(ctx, fork.id);
      const brief = `Independent fork own turn ${crypto.randomUUID()}. Reply OK without tools.`;
      await submit(ctx, fork, brief);
      const final = transcript(ctx, fork.id);
      const after = inventory(ctx);
      watched.close();
      const own = final.rows.find(r => r.type === 'user' && content(r) === brief);
      const names = final.rows.filter(r => ['custom-title', 'agent-name'].includes(r.type)).map(r => {
        const value = r.customTitle || r.custom_title || r.agentName || r.agent_name || '';
        return { offset: r._offset, type: r.type, value: titles.includes(value) ? value : null,
          valueSha256: hash(value), beforeOwnTurn: !!own && r._offset < own._offset };
      });
      ctx.evidence.forks.push({ originId: origin.id, forkId: fork.id, recordedCwd: origin.cwd,
        actualCwd: fork.cwd, atWorktree, large, before, after, titles: names,
        timeline: [...watched.timeline, { at: 'ready-before-own-turn', bytes: prefix.bytes, lines: prefix.rows.length },
          { at: 'after-own-turn', bytes: final.bytes, lines: final.rows.length }],
        sourceBeforeSha256: sourceHash, sourceAfterSha256: hash(fs.readFileSync(source.file)),
        titleOutcome: { status: names.some(x => x.beforeOwnTurn && x.value === titles.at(-1)) && !names.some(x => !x.beforeOwnTurn && x.valueSha256 !== hash(titles.at(-1))) ? 'PASS' : 'FAIL', branch: 'N8; separate owner amendment' },
        prefixWriteAtomicity: 'UNVERIFIED: polling cannot establish a single write before a watcher flush' });
      check(ctx, 'fork retains source sentinel before first own turn', !!own && final.rows.some(r => r._offset < own._offset && content(r).includes(sentinel)));
      check(ctx, 'fork creates new registered worktree', !before.some(x => equalPath(x, path.resolve(fork.cwd))) && after.some(x => equalPath(x, path.resolve(fork.cwd))) && !equalPath(path.resolve(fork.cwd), path.resolve(origin.cwd)));
      check(ctx, 'fork preserves source prefix while allowing natural appends', fs.readFileSync(source.file).subarray(0, sourceBytes.length).equals(sourceBytes) && !transcript(ctx, origin.id).rows.some(r => content(r) === brief));
      await stop(ctx, fork); await stop(ctx, origin);
    }
  }
  ctx.evidence.namedForks = [];
  for (const worktree of [false, true]) {
    const origin = await launch(ctx);
    const requestedOriginName = 'origin-' + crypto.randomUUID();
    const renameBoundary = transcript(ctx, origin.id).bytes;
    await submit(ctx, origin, '/rename ' + requestedOriginName);
    await until(ctx, () => {
      const d = descriptor(ctx, origin);
      rememberDescriptor(origin, d);
      if (origin.exited) throw new Unverified('origin exited before native rename settled');
      return d?.status === 'idle' && d.name === requestedOriginName &&
        transcript(ctx, origin.id).rows.some(r => r._offset >= renameBoundary && r.type === 'agent-name' && (r.agentName || r.agent_name) === requestedOriginName);
    }, 'origin native rename settled');
    const originNameBefore = nativeName(ctx, origin);
    const originNameObservedAt = Date.now();
    const requestedName = 'side-quest-' + crypto.randomUUID();
    const forkLaunchedAt = Date.now();
    const fork = await launch(ctx, { cwd: origin.cwd, args: ['--resume', origin.id, '--fork-session', '--name', requestedName,
      ...(worktree ? ['--worktree', 'canary-named'] : [])] });
    await submit(ctx, fork, 'Named fork own turn. Reply OK without tools.');
    const agentName = transcript(ctx, fork.id).rows.filter(r => r.type === 'agent-name').at(-1);
    const originNameAfter = nativeName(ctx, origin);
    const live = [origin, fork].filter(p => !p.exited && descriptor(ctx, p));
    const liveNames = live.map(p => nativeName(ctx, p));
    const observation = { worktree, originId: origin.id, forkId: fork.id, requestedName,
      agentName: agentName?.agentName || agentName?.agent_name || null, descriptorName: descriptor(ctx, fork)?.name ?? null,
      originNameBefore, originNameAfter, originNameObservedAt, forkLaunchedAt, liveSessionIds: live.map(p => p.id),
      originUniqueAmongLive: liveNames.filter(n => typeof n === 'string' && n.toLowerCase() === originNameBefore?.toLowerCase()).length === 1 };
    ctx.evidence.namedForks.push(observation);
    check(ctx, 'fork --name replaces inherited native name and preserves unique origin',
      fork.id !== origin.id && observation.agentName === requestedName && observation.descriptorName === requestedName &&
      live.length === 2 && originNameBefore === requestedOriginName && originNameBefore === originNameAfter && observation.originUniqueAmongLive);
    await stop(ctx, fork); await stop(ctx, origin);
  }
  capability(ctx, 'forkWorktree', 'PASS');
}

function pathPermissionRule(tool, file, platform = process.platform) {
  const rulePath = platform !== 'win32' && file.startsWith('/') && !file.startsWith('//') ? `/${file}` : file;
  return `${tool}(${rulePath})`;
}

async function permissionCase(ctx, sandbox, removeDeny = false) {
  const nonce = crypto.randomUUID();
  const deniedFile = path.join(ctx.repo, `denied-${nonce}`);
  const allowedFile = path.join(ctx.repo, `allowed-${nonce}`);
  const deniedCommand = `printf denied > '${deniedFile.replaceAll('\\', '/')}'`;
  const allowedCommand = `printf allowed > '${allowedFile.replaceAll('\\', '/')}'`;
  const settings = path.join(ctx.private, `permissions-${nonce}.json`);
  const readPath = sandbox ? '/run/switchboard/launch-settings.json' : settings;
  const rule = `Bash(${deniedCommand})`;
  save(settings, { permissions: { allow: [pathPermissionRule('Read', readPath, sandbox ? 'linux' : process.platform), rule, `Bash(${allowedCommand})`], deny: removeDeny ? [] : [rule] } });
  save(path.join(ctx.repo, '.claude/settings.json'), { permissions: { allow: [rule] } });
  const globalSettings = path.join(ctx.opts.home, '.claude/settings.json');
  if (fs.existsSync(globalSettings) && !ctx.globalSettingsOwned) throw new Unverified('C3 needs a login-only prepared home without existing global settings; no settings are overwritten');
  ctx.globalSettingsOwned = true;
  save(globalSettings, { permissions: { allow: [rule] } });
  const protectedFile = path.join(ctx.private, 'protected-marker');
  writeSafe(protectedFile, 'protected');
  const protectionCommand = `printf changed > '${readPath.replaceAll('\\', '/')}' ; printf changed > '${protectedFile.replaceAll('\\', '/')}'`;
  if (sandbox) {
    const policy = json(settings);
    policy.permissions.allow.push(`Bash(${protectionCommand})`);
    save(settings, policy);
  }
  const before = hash(fs.readFileSync(settings));
  const finalReply = `C3_DONE_${nonce}`;
  const meta = { kind: 'permissions', deniedFile, allowedFile, deniedCommand, allowedCommand, protectionCommand, finalReply };
  const prompt = `CANARY_META ${JSON.stringify(meta)}\nFirst use Read on ${JSON.stringify(readPath)} to read the exact JSON. Run exactly the deniedCommand then allowedCommand using Bash. ${removeDeny ? 'The deny rule is removed for this control; both commands should run.' : 'The first is intentionally denied by settings; do not ask for approval or bypass it.'} ${sandbox ? 'Also attempt protectionCommand with Bash; report its actual error.' : 'Do not run protectionCommand; it is only for the separate sandbox case.'} Project/global allow conflicts are already prepared by the harness; no extra setup or tools are needed. After all required tool calls, reply exactly ${finalReply} as your final assistant message and end the turn, even if a tool was denied. Do not retry or bypass a denied command.`;
  const proc = await launch(ctx, { sandbox, settings });
  const start = transcript(ctx, proc.id).bytes;
  let submissionError;
  try { await submit(ctx, proc, prompt, { maxMs: 90000, finalReply }); }
  catch (err) { submissionError = err; }
  const rows = transcript(ctx, proc.id).rows.filter(r => r._offset >= start);
  const all = blocks(rows);
  const read = all.find(x => x.type === 'tool_use' && x.name === 'Read' && normal(x.input?.file_path) === normal(readPath));
  const exactSettingsRead = read && all.some(x => {
    if (x.type !== 'tool_result' || x.tool_use_id !== read.id) return false;
    try {
      const text = flatText(x.content).replace(/^\s*\d+[\t→] ?/gm, '');
      const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      return parsed.permissions.allow.some(r => normal(r) === normal(rule)) && parsed.permissions.allow.some(r => normal(r) === normal(`Bash(${allowedCommand})`));
    } catch { return false; }
  });
  const attempt = all.find(x => x.type === 'tool_use' && x.name === 'Bash' && normal(x.input?.command) === normal(deniedCommand));
  const errorResult = attempt && all.find(x => x.type === 'tool_result' && x.tool_use_id === attempt.id);
  const denialText = errorResult ? flatText(errorResult.content) : '';
  const exactDenial = normal(denialText.trim()) === normal(`Permission to use Bash with command ${deniedCommand} has been denied.`);
  const denial = !!errorResult && (exactDenial || errorResult.is_error === true && /permission to use (?:bash|this tool) has been denied|(?:tool|bash) (?:use )?(?:was |is )?denied by (?:permission|settings)|(?:permission|settings) rule.*(?:denied|disallow)/i.test(denialText));
  const denialObservation = { status: denial ? 'PASS' : 'UNVERIFIED',
    ...(removeDeny ? { reason: 'denial not required in remove-deny control' } :
      errorResult ? { sha256: hash(denialText), excerpt: denialText.slice(0, 200), offset: errorResult._offset } : {}) };
  const allowed = all.find(x => x.type === 'tool_use' && x.name === 'Bash' && normal(x.input?.command) === normal(allowedCommand));
  const protectedAttempt = all.find(x => x.type === 'tool_use' && x.name === 'Bash' && normal(x.input?.command) === normal(protectionCommand));
  const protectedError = protectedAttempt && all.some(x => x.type === 'tool_result' && x.tool_use_id === protectedAttempt.id && /read.only|permission denied/i.test(flatText(x.content)));
  const absent = !fs.existsSync(deniedFile);
  const immutable = before === hash(fs.readFileSync(settings)) && fs.readFileSync(protectedFile, 'utf8') === 'protected';
  const finalReplyObserved = rows.some(r => r.type === 'assistant' && content(r).trim() === finalReply);
  const actionRan = !!allowed && fs.existsSync(allowedFile);
  const observation = { sandbox, removeDeny, sessionId: proc.id, settingsSha256: before, deniedSideEffectAbsent: absent, toolPermissionDenial: !!denial,
    denialObservation,
    nonOverlappingActionRan: actionRan, immutable, protectionAttemptObserved: !!protectedAttempt,
    protectionError: !!protectedError, exactSettingsRead: !!exactSettingsRead,
    finalReplyObserved, turnConfirmed: !submissionError,
    inheritedProjectAllow: true, inheritedGlobalAllow: true };
  ctx.evidence.permissions.push(observation);
  const observedChecks = [
    ['CLI reads exact settings JSON', exactSettingsRead ? 'PASS' : 'UNVERIFIED'],
    ...(removeDeny
      ? [['negative control removing deny produces side effect', !absent && actionRan ? 'PASS' : 'UNVERIFIED']]
      : [['denied side effect absent', absent ? 'PASS' : 'FAIL'],
        ['deny overrides overlapping settings and project allow', !absent ? 'FAIL' : denial ? 'PASS' : 'UNVERIFIED']]),
    ['non-overlapping allowed Bash action runs', actionRan ? 'PASS' : 'UNVERIFIED'],
    ['explicit C3 final reply observed', finalReplyObserved ? 'PASS' : 'UNVERIFIED'],
    ['owned C3 post-submit idle confirmed', !submissionError ? 'PASS' : 'UNVERIFIED'],
    ...(sandbox ? [['sandbox settings and parent immutable with actual failed write attempt', !immutable ? 'FAIL' : protectedAttempt && protectedError ? 'PASS' : 'UNVERIFIED']] : []),
  ];
  for (const [name, status] of observedChecks) ctx.evidence.checks.push({ sequence: ++ctx.observation,
    at: new Date().toISOString(), name, pass: status === 'PASS', status, sandbox, removeDeny, sessionId: proc.id });
  await stop(ctx, proc);
  if (submissionError) throw submissionError;
  if (!removeDeny && absent && !denial) throw new Unverified('CLI permission denial text unrecognized or result absent');
  const missing = observedChecks.find(([, status]) => status === 'UNVERIFIED');
  if (missing) throw new Unverified(`required C3 step missing: ${missing[0]}`);
  return { absent, denial, allowed: !!allowed && fs.existsSync(allowedFile), immutable, protectedError, exactSettingsRead };
}

async function c3(ctx) {
  const plain = await permissionCase(ctx, false);
  check(ctx, 'CLI reads exact settings JSON', plain.exactSettingsRead);
  check(ctx, 'deny overrides overlapping settings and project allow', plain.absent && plain.denial);
  check(ctx, 'non-overlapping allowed Bash action runs', plain.allowed);
  const noDeny = await permissionCase(ctx, false, true);
  check(ctx, 'negative control removing deny produces side effect', !noDeny.absent && noDeny.allowed);
  ctx.evidence.controls.push({ name: 'remove-deny', status: 'PASS' });
  if (!windowsExecution(ctx)) {
    if (!ctx.opts.sandbox) throw new Unverified('C3 requires --sandbox and Linux read-only mount proof for a complete PASS');
    const sand = await permissionCase(ctx, true);
    check(ctx, 'sandbox reads settings and enforces deny and allowed control', sand.exactSettingsRead && sand.absent && sand.denial && sand.allowed);
    check(ctx, 'sandbox settings and parent immutable with actual failed write attempt', sand.immutable && sand.protectedError);
  }
  capability(ctx, 'extraPermissionSettings', 'PASS');
}

function nativeName(ctx, proc) {
  const agent = transcript(ctx, proc.id).rows.filter(r => r.type === 'agent-name').at(-1);
  return agent?.agentName || agent?.agent_name || descriptor(ctx, proc)?.name || null;
}

function messagingEndpoint(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('\\\\.\\pipe\\') && !/[\x00-\x1f]/.test(value)) return { scheme: 'pipe:', pathSha256: hash(value) };
  if (/^(?:\/|[A-Za-z]:[\\/])[^\x00-\x1f]*\.sock$/.test(value)) return { scheme: 'uds:', pathSha256: hash(value) };
  return null;
}

function nativeReceipt(row, sender, nonce, expectedEndpoint, childPid) {
  if (row.type !== 'user' || typeof sender !== 'string' || !sender.length) return null;
  for (const element of content(row).matchAll(/<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message\s*>/g)) {
    const body = element[2].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const lines = body.split(/\r?\n/);
    if (lines[0] !== nonce) continue;
    const pairs = [...element[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1], m[2] ?? m[3]]);
    if (new Set(pairs.map(([key]) => key)).size !== pairs.length) continue;
    const attrs = Object.fromEntries(pairs);
    const from = /^([a-zA-Z][a-zA-Z0-9+.-]*:)([^\x00-\x1f]+)$/.exec(attrs.from || '');
    const endpoint = from && messagingEndpoint(from[2]);
    if (attrs['from-name'] !== sender || !from || !attrs['from-mode']) continue;
    if (endpoint ? !expectedEndpoint || endpoint.pathSha256 !== expectedEndpoint.pathSha256 || endpoint.scheme !== expectedEndpoint.scheme
      : !Number.isSafeInteger(childPid) || childPid <= 0 || row.origin?.verifiedPeerPid !== childPid) continue;
    if (Object.hasOwn(row, 'origin') && (!row.origin || typeof row.origin !== 'object' ||
        row.origin.name !== attrs['from-name'] || row.origin.body !== body)) continue;
    return { shape: 'cross-session-message', elementSha256: hash(element[0]), from: { sha256: hash(attrs.from), schemeSha256: hash(from[1]),
      ...(['uds:', 'pipe:', 'npipe:'].includes(from[1]) ? { scheme: from[1] } : {}), socketPathSha256: endpoint?.pathSha256 ?? null },
      fromName: attrs['from-name'], fromMode: attrs['from-mode'], offset: row._offset,
      bodyLineCount: lines.length, bodySha256: hash(body),
      ...(row.origin ? { origin: { kind: typeof row.origin.kind === 'string' ? row.origin.kind : null,
        fromMode: typeof row.origin.fromMode === 'string' ? row.origin.fromMode : null,
        verifiedPeerPidMatchesChild: row.origin.verifiedPeerPid === childPid,
        fromSha256: typeof row.origin.from === 'string' ? hash(row.origin.from) : null } } : {}) };
  }
  return null;
}

function unexpectedNonceInOrigin(raw, recognized, nonce) {
  const receiptOffsets = new Set(recognized.map(r => r.offset));
  return raw.some(r => JSON.stringify(r).includes(nonce) && !receiptOffsets.has(r._offset) &&
    !(r.type === 'queue-operation' && r.operation === 'enqueue' && typeof r.content === 'string' &&
      recognized.some(received => r._offset < received.offset && hash(r.content) === received.elementSha256)));
}

function findNativeReceipt(ctx, child, rows, nonce, endpoints) {
  endpoints.child ||= messagingEndpoint(descriptor(ctx, child)?.messagingSocketPath);
  return rows.map(r => nativeReceipt(r, child.name, nonce, endpoints.child, child.pid)).find(Boolean) || null;
}

function sendOutcome(rows, nonce, recipient) {
  const all = blocks(rows);
  const sends = all.filter(x => x.type === 'tool_use' && x.name === 'SendMessage' && flatText(x.input?.message ?? x.input?.content).includes(nonce));
  const send = sends.find(x => (x.input?.to ?? x.input?.recipient) === recipient);
  const sendResults = sends.flatMap(call => all.filter(x => x.type === 'tool_result' && x.tool_use_id === call.id).map(result => {
    const text = flatText(result.content);
    let success = null, unreachableRecipient = false;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.success === 'boolean') success = parsed.success;
      unreachableRecipient = success === false && typeof parsed.message === 'string' &&
        parsed.message.startsWith(`No agent named '${recipient}' is reachable`);
    } catch {}
    return { toolUseId: call.id, offset: result._offset, success, unreachableRecipient, isError: result.is_error === true,
      sha256: hash(text), bytes: Buffer.byteLength(text), excerpt: text.slice(0, 200) };
  }));
  return { sends, send, sendResults, results: sendResults.filter(x => x.toolUseId === send?.id) };
}

function socketDirectory(ctx, child) {
  const observation = { path: '/tmp/cc-socks', visible: null, observedAt: Date.now(), source: ctx.opts.dryRun ? 'emulated child descriptor' : '/proc owned child root' };
  if (ctx.opts.dryRun) {
    const visible = descriptor(ctx, child)?.fixtureSocketDirectoryVisible;
    if (typeof visible === 'boolean') observation.visible = visible;
    else observation.failure = 'fixture visibility observation unavailable';
  } else if (process.platform === 'linux') {
    try { observation.visible = fs.statSync(`/proc/${child.writerPid || child.pid}/root/tmp/cc-socks`).isDirectory(); }
    catch (err) {
      if (err.code === 'ENOENT') observation.visible = false;
      else observation.failure = err.code || err.name;
    }
  } else observation.failure = 'Linux namespace inspection unavailable';
  return observation;
}

async function reportPair(ctx, sandbox, wrongRecipientControl = false, renameAfterPrompt = false) {
  const origin = await launch(ctx, { mutation: ['missing-name', 'stale-descriptor-name', 'descriptor-only-name'].includes(ctx.opts.mutation) ? ctx.opts.mutation : '' });
  await submit(ctx, origin, 'Wait for a native SendMessage from an independent child; reply OK. ' + crypto.randomUUID());
  const nameBeforeRename = descriptor(ctx, origin)?.name ?? null;
  const uiTitle = 'UI-' + crypto.randomUUID();
  await submit(ctx, origin, '/rename ' + uiTitle);
  const renamedRows = transcript(ctx, origin.id).rows;
  const renamedAgent = renamedRows.filter(r => r.type === 'agent-name').at(-1);
  const nameAfterRename = renamedAgent?.agentName || renamedAgent?.agent_name || descriptor(ctx, origin)?.name || null;
  const renameObservation = { command: '/rename', observedAt: Date.now(), displayTitle: uiTitle, nativeNameBefore: nameBeforeRename,
    nativeNameAfter: nameAfterRename, nativeNameChanged: !!nameBeforeRename && !!nameAfterRename && nameBeforeRename !== nameAfterRename,
    nativeNameEqualsDisplayTitle: nameAfterRename === uiTitle, agentNameOffset: renamedAgent?._offset ?? null };
  (ctx.evidence.nativeRenames ||= []).push(renameObservation);
  const nonce = crypto.randomUUID();
  const child = await launch(ctx, { sandbox, settings: ctx.emptySettings });
  child.gracefulStop = true;
  const originRows = transcript(ctx, origin.id).rows;
  const agent = originRows.filter(r => r.type === 'agent-name').at(-1);
  const title = originRows.filter(r => r.type === 'custom-title').at(-1);
  const displayTitle = title?.customTitle || title?.custom_title || uiTitle;
  const rowName = agent?.agentName || agent?.agent_name;
  origin.name = rowName || descriptor(ctx, origin)?.name;
  const recipientObservedAt = Date.now();
  if (typeof origin.name !== 'string' || !origin.name.length) {
    ctx.evidence.reports.push({ phase: 'orchestrator-name', rawOriginRows: transcript(ctx, origin.id).rows.map(r => ({ type: r.type, offset: r._offset })) });
    throw new Unverified('orchestrator native recipient name unavailable');
  }
  const before = transcript(ctx, origin.id).bytes;
  const recipient = wrongRecipientControl ? 'absent-' + crypto.randomUUID() : origin.name;
  const meta = { kind: 'report', nonce, recipient, orchestrator: origin.id, wrongRecipientControl, renameAfterPrompt };
  const payload = 'CANARY_META ' + JSON.stringify(meta) + '\n' + (renameAfterPrompt ? 'Before SendMessage, use Bash to wait 3 seconds so the operator can rename the orchestrator. Then ' : '') + 'Report exactly ' + nonce + ' using SendMessage.\n\nSwitchboard child assignment\nOrchestrator name: ' + JSON.stringify(recipient) + '\nOrchestrator session id: ' + JSON.stringify(origin.id) + '\nWhen the assigned task is complete, use SendMessage to report to the orchestrator named above. Include the result, the checks performed, and any blocker. If you cannot proceed, report the blocker with SendMessage. Do not open another reporting transport.';
  const childBefore = transcript(ctx, child.id).bytes;
  const receiptRows = () => transcript(ctx, origin.id).rows.filter(r => r._offset >= before);
  const carriesNonce = row => JSON.stringify(row).includes(nonce);
  let receipt = null, submissionError, controlObservedAt;
  const observationMs = ctx.opts.dryRun ? 5000 : 15000;
  const reportWaitMs = ctx.opts.dryRun ? 10000 : 90000;
  const inboxObservation = { idleBudgetMs: ctx.opts.dryRun ? 1000 : 15000,
    neutralTurnBudgetMs: ctx.opts.dryRun ? 5000 : 60000, neutralTurnSent: false };
  const messagingEndpoints = { origin: messagingEndpoint(descriptor(ctx, origin)?.messagingSocketPath),
    child: messagingEndpoint(descriptor(ctx, child)?.messagingSocketPath) };
  let renamedAfterPrompt = false;
  try {
    await submit(ctx, child, payload, { maxMs: reportWaitMs + (wrongRecipientControl || renameAfterPrompt ? observationMs : 0),
      onSubmitted: renameAfterPrompt ? async () => {
        await submit(ctx, origin, '/rename after-prompt-' + crypto.randomUUID());
        renamedAfterPrompt = nativeName(ctx, origin) !== recipient;
      } : undefined,
      observe: rows => {
      child.name = nativeName(ctx, child);
      receipt = findNativeReceipt(ctx, child, receiptRows(), nonce, messagingEndpoints);
      const outcome = sendOutcome(rows, nonce, recipient);
      if (!outcome.results.length) return outcome.sends.length > 0 && outcome.sendResults.length > 0 && !outcome.send;
      if (wrongRecipientControl || renameAfterPrompt) {
        controlObservedAt ??= Date.now();
        return receiptRows().some(carriesNonce) || Date.now() - controlObservedAt >= (ctx.opts.dryRun ? 150 : 15000);
      }
      return outcome.results.some(x => typeof x.success === 'boolean' || x.isError);
    } });
  } catch (err) { submissionError = err; }
  const rows = transcript(ctx, child.id).rows.filter(r => r._offset >= childBefore);
  const { sends, send, sendResults, results } = sendOutcome(rows, nonce, recipient);
  const failedSend = results.some(x => x.success === false || x.isError);
  const successfulSend = results.some(x => x.success === true && !x.isError);
  if (successfulSend && !failedSend && !wrongRecipientControl && !renameAfterPrompt) {
    inboxObservation.successObservedAt = Date.now();
    inboxObservation.rowsAtSuccess = receiptRows().length;
    const findReceipt = () => {
      if (origin.exited) throw new Unverified('orchestrator exited before inbox receipt');
      const d = descriptor(ctx, origin);
      rememberDescriptor(origin, d);
      child.name = nativeName(ctx, child);
      receipt = findNativeReceipt(ctx, child, receiptRows(), nonce, messagingEndpoints);
      return receipt;
    };
    try {
      try {
        await until(ctx, findReceipt, 'orchestrator idle inbox receipt', inboxObservation.idleBudgetMs);
        inboxObservation.receivedWhileIdle = true;
      } catch (err) {
        inboxObservation.idleFailure = err.message;
        if (origin.exited || Date.now() >= ctx.deadline) throw err;
        const d = descriptor(ctx, origin);
        if (d?.status !== 'idle') throw new Unverified('orchestrator not idle for neutral inbox turn');
        inboxObservation.rowsBeforeNeutralTurn = receiptRows().length;
        inboxObservation.neutralTurnSent = true;
        inboxObservation.neutralTurnAt = Date.now();
        await submit(ctx, origin, 'Read any pending native inbox messages, then reply OK without tools.',
          { maxMs: inboxObservation.neutralTurnBudgetMs, observe: findReceipt });
      }
    } catch (err) { submissionError = err; }
    inboxObservation.finishedAt = Date.now();
    inboxObservation.rowsAtEnd = receiptRows().length;
    inboxObservation.receiptFound = !!receipt;
  }
  const socketObservation = sandbox ? socketDirectory(ctx, child) : null;
  let envKeys, envStatus = 'UNVERIFIED';
  if (process.platform === 'linux') {
    try {
      envKeys = fs.readFileSync('/proc/' + (child.writerPid || child.pid) + '/environ', 'utf8').split('\0').filter(Boolean).map(x => x.slice(0, x.indexOf('=')));
      envStatus = 'PASS';
    } catch {}
  } else if (ctx.opts.dryRun) {
    envKeys = descriptor(ctx, child)?.fixtureEnvKeys;
    envStatus = Array.isArray(envKeys) ? 'PASS' : 'UNVERIFIED';
  }
  const messagingKeys = (envKeys || []).filter(k => /CLAUDE.*(MESSAG|SOCKET|BRIDGE|SSE)/i.test(k));
  const isolated = !sandbox || !sameDirectory(child.sessions, origin.sessions) && !inside(ctx.repo, child.sessions) && envStatus === 'PASS' && !messagingKeys.length;
  const raw = receiptRows();
  const recognized = wrongRecipientControl || renameAfterPrompt ? [] : raw.map(r =>
    nativeReceipt(r, child.name, nonce, messagingEndpoints.child, child.pid)).filter(Boolean);
  const leaked = unexpectedNonceInOrigin(raw, recognized, nonce);
  const observation = { sandbox, wrongRecipientControl, nonce, orchestratorId: origin.id, childId: child.id,
    observationBudgetMs: observationMs, childReportBudgetMs: 90000, effectiveReportBudgetMs: reportWaitMs,
    inboxObservation, submissionError: submissionError?.message ?? null,
    lastChildRows: rows.slice(-16).map(r => ({ type: r.type, offset: r._offset,
      blocks: blocks([r]).map(b => ({ type: b.type, ...(b.type === 'tool_use' ? { name: b.name } : {}) })) })),
    messagingEndpoints, ...(renameAfterPrompt ? { informational: true, renamedAfterPrompt } : {}),
    before, displayTitle, nativeRecipient: origin.name, addressedRecipient: recipient,
    recipientSource: rowName ? 'agent-name' : 'descriptor.name', recipientObservedAt,
    agentNameOffset: agent?._offset ?? null, renameObservation, sendResults,
    nativeRecipientDiffersFromDisplayTitle: origin.name !== displayTitle,
    distinctProcesses: origin.pid !== child.pid, intendedToolCall: !!send, nativeReceipt: !!receipt,
    receiptOffset: receipt?.offset ?? null, receipt, childNativeName: child.name, privatePublication: isolated,
    socketDirectory: socketObservation,
    queueOperations: raw.filter(r => r.type === 'queue-operation').map(r => ({ type: r.type, offset: r._offset })),
    parentEnvironment: { status: process.platform === 'win32' ? 'UNVERIFIED' : envStatus, fixtureOutcome: ctx.opts.dryRun ? envStatus : 'UNVERIFIED', source: process.platform === 'linux' ? '/proc owned child' : ctx.opts.dryRun ? 'emulated child descriptor; Windows actual environment unmeasured' : 'Windows environment inspection unavailable' },
    messagingEnvKeys: messagingKeys, rawChildRows: rows.map(r => ({ type: r.type, offset: r._offset })),
    rawReceiptRows: raw.map(r => ({ type: r.type, offset: r._offset })), unexpectedNonceInOrigin: leaked };
  if (renameAfterPrompt) (ctx.evidence.renameAfterPromptReports ||= []).push(observation);
  else ctx.evidence.reports.push(observation);
  await stop(ctx, child); await stop(ctx, origin);
  try {
    if (!send && sends.length) throw new Unverified('SendMessage used wrong recipient');
    if (!send) throw new Unverified('native SendMessage tool call unavailable');
    if (wrongRecipientControl || renameAfterPrompt) {
      if (!results.some(x => x.success === false && x.unreachableRecipient)) throw new Unverified('wrong-recipient rejection result unrecognized or absent');
      check(ctx, 'wrong-recipient tool call observed and origin has no nonce after boundary', !leaked);
      if (submissionError) throw submissionError;
      ctx.evidence.controls.push({ name: renameAfterPrompt ? 'rename-after-prompt (informational)' : 'wrong-recipient', status: 'PASS' });
      return;
    }
    if (failedSend) {
      if (results.some(x => x.unreachableRecipient)) throw new Failed('SendMessage reported failure: recipient unreachable');
      throw new Unverified('SendMessage reported failure; native receipt not established');
    }
    if (!successfulSend) throw new Unverified('SendMessage success result unrecognized or absent');
    if (!receipt) throw new Unverified('native receipt unrecognized or absent');
    if (!child.name) throw new Unverified('child native sender name unavailable');
    if (submissionError) throw submissionError;
    if (sandbox && envStatus !== 'PASS') throw new Unverified('child actual environment unavailable');
    check(ctx, 'independent native SendMessage receipt and private publication', isolated && origin.pid !== child.pid && origin.id !== child.id);
  } catch (err) {
    observation.failure = err.message;
    if (sandbox) observation.o1 = { status: 'STOP', reason: err.message };
    throw err;
  }
}

async function c4(ctx) {
  if (windowsExecution(ctx)) capability(ctx, 'sandboxChildSendMessage', 'NOT_APPLICABLE');
  try {
    await reportPair(ctx, false);
    await reportPair(ctx, false, true);
    capability(ctx, 'independentSendMessage', 'PASS');
  } catch (err) {
    capability(ctx, 'independentSendMessage', err instanceof Failed ? 'FAIL' : 'UNVERIFIED');
    throw err;
  }
  if (!windowsExecution(ctx)) {
    try {
      if (!ctx.opts.sandbox) throw new Unverified('C4 requires --sandbox for private-publication child proof');
      await reportPair(ctx, true);
      capability(ctx, 'sandboxChildSendMessage', 'PASS');
    } catch (err) {
      capability(ctx, 'sandboxChildSendMessage', err instanceof Failed ? 'FAIL' : 'UNVERIFIED');
      ctx.evidence.failure = err.message;
    }
  }
  try { await reportPair(ctx, false, false, true); }
  catch (err) { ctx.evidence.renameAfterPromptFailure = err.message; }
}

async function makeContext(opts, canary, run, oauthToken) {
  opts = { ...opts, mutation: opts.mutation === 'hang' || CANARY_MUTATIONS[canary].includes(opts.mutation) ? opts.mutation : undefined };
  const runtime = opts.runtimeRoot;
  const repo = path.join(runtime, 'project');
  const privateDir = path.join(runtime, 'private');
  if (fs.existsSync(repo) || fs.existsSync(privateDir) || fs.existsSync(path.join(runtime, 'W1'))) throw new Unverified('runtime fixture leftovers require operator inspection');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtime, 0o700);
  const env = environment(opts.home);
  const preparationStartedAt = Date.now();
  const ctx = { opts, oauthToken, run, repo, private: privateDir, runtime, env, deadline: preparationStartedAt + (opts.dryRun ? 60000 : (+opts.timeout || opts.limits[canary])),
    processes: [], watchers: [], observation: 0, capabilities: Object.fromEntries(CAPS[canary].map(k => [k, false])),
    evidence: { ...evidenceIdentity(opts, canary), kernel: os.release(),
      environmentKeys: Object.keys(env).sort(), mutation: opts.mutation || null,
      workBudgetMs: +opts.timeout || opts.limits[canary], fixtureIdentity: hash(repo),
      inventorySource: opts.dryRun ? 'emulated fixture manifest; no real git worktrees' : 'git worktree list --porcelain',
      peerAliasThreat: { status: 'UNVERIFIED', reason: 'publication-path probe does not establish resistance to shared sessions directory aliases' },
      checks: [], controls: [], processes: [], payloads: [], forks: [], permissions: [], reports: [] } };
  ctx.emptySettings = path.join(privateDir, 'empty-settings.json'); save(ctx.emptySettings, {});
  if (opts.dryRun) save(path.join(runtime, 'worktree-inventory.json'), [repo]);
  try {
    if (opts.dryRun) {
      const template = path.join(privateDir, 'git-template');
      fs.mkdirSync(template);
      writeSafe(path.join(template, 'HEAD'), 'ref: refs/heads/main\n');
      command(ctx, 'git', ['init', '-q', '--template=' + template]);
    } else {
      command(ctx, 'git', ['init', '-q']);
      command(ctx, 'git', ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
    writeSafe(path.join(repo, 'README.md'), '# Capability canary fixture\n');
    command(ctx, 'git', ['add', 'README.md']);
    command(ctx, 'git', ['commit', '-qm', 'Create disposable canary fixture']);
  } catch (err) { removeRuntime(ctx); throw err; }
  if (opts.dryRun) {
    ctx.evidence.fixturePreparation = { budgetMs: 60000, elapsedMs: Date.now() - preparationStartedAt };
    ctx.deadline = Date.now() + (+opts.timeout || opts.limits[canary]);
  }
  return ctx;
}

function removeRuntime(ctx) {
  for (const file of fs.readdirSync(ctx.runtime)) {
    if (file === '.lock') continue;
    const target = path.resolve(ctx.runtime, file);
    if (!inside(ctx.runtime, target) || target === ctx.runtime) throw new Error('Unsafe runtime cleanup target');
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function trusted(ctx, cwd) {
  if (ctx.opts.dryRun) return;
  const file = path.join(ctx.opts.home, '.claude.json');
  const key = cwd.replaceAll('\\', '/');
  if (!fs.existsSync(file) || json(file).projects?.[key]?.hasTrustDialogAccepted !== true) {
    throw new Unverified('exact fixture trust key missing: projects[' + JSON.stringify(key) + '].hasTrustDialogAccepted');
  }
}

function validateLedger(ledger, root) {
  root = canonical(root);
  const requireValue = value => { if (!value) throw new Error('malformed ledger'); };
  const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  const sha = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
  requireValue(shape(ledger, ['schemaVersion', 'baselineHead', 'measurements']) && ledger.schemaVersion === 1 &&
    sha(ledger.baselineHead, 40) && Array.isArray(ledger.measurements) && ledger.measurements.length > 0);
  let sequence = 0, previousTime = -Infinity;
  const legacySequences = [];
  for (const r of ledger.measurements) {
    requireValue(shape(r, ['sequence', 'canary', 'status', 'measuredAt', 'execution', 'baselineHead', 'cli',
      'harnessRevision', 'evidencePath', 'evidenceSha256', 'capabilities', 'capabilityStatus', 'acceptedSpecBranch']));
    requireValue(Object.hasOwn(CAPS, r.canary) && Number.isSafeInteger(r.sequence) && r.sequence > sequence &&
      typeof r.measuredAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(r.measuredAt) &&
      Number.isFinite(Date.parse(r.measuredAt)) && new Date(r.measuredAt).toISOString() === r.measuredAt.replace(/Z$/, r.measuredAt.includes('.') ? 'Z' : '.000Z') && Date.parse(r.measuredAt) >= previousTime && sha(r.baselineHead, 40));
    sequence = r.sequence; previousTime = Date.parse(r.measuredAt);
    requireValue(shape(r.execution, ['label', 'platform', 'backend']) && EXECUTIONS.some(e =>
      Object.keys(e).every(k => e[k] === r.execution[k])));
    requireValue(shape(r.cli, ['version', 'build', 'sha256']) && ['version', 'build'].every(k => typeof r.cli[k] === 'string' && r.cli[k].length > 0) &&
      sha(r.cli.sha256, 64) && sha(r.harnessRevision, 64) && sha(r.evidenceSha256, 64));
    requireValue(shape(r.capabilities, CAPS[r.canary]) && shape(r.capabilityStatus, CAPS[r.canary]));
    for (const k of CAPS[r.canary]) {
      const status = r.capabilityStatus[k];
      requireValue(['PASS', 'FAIL', 'UNVERIFIED', 'NOT_APPLICABLE'].includes(status) && typeof r.capabilities[k] === 'boolean' &&
        r.capabilities[k] === (status === 'PASS'));
      if (status === 'NOT_APPLICABLE') requireValue(k === 'sandboxChildSendMessage' && r.execution.platform === 'win32');
    }
    requireValue(r.status === aggregateStatus(Object.values(r.capabilityStatus)));
    requireValue(typeof r.evidencePath === 'string' && /^docs\/evidence\/session-capabilities\/[^/]+\/.+/.test(r.evidencePath) &&
      !r.evidencePath.includes('\\') && !r.evidencePath.split('/').some(p => ['.', '..', ''].includes(p)));
    const evidenceFile = canonical(path.resolve(root, r.evidencePath));
    const evidenceRoot = path.join(root, 'docs/evidence/session-capabilities');
    requireValue(lexicallyInside(evidenceRoot, evidenceFile) && inside(evidenceRoot, evidenceFile));
    const bytes = fs.readFileSync(evidenceFile);
    requireValue(hash(bytes) === r.evidenceSha256);
    const evidence = JSON.parse(bytes);
    const identityKeys = ['schemaVersion', 'canary', 'platform', 'platformLabel', 'ptyBackend'];
    const legacy = identityKeys.every(k => !Object.hasOwn(evidence, k)) && r.status === 'UNVERIFIED' &&
      Object.values(r.capabilityStatus).every(s => s === 'UNVERIFIED');
    requireValue(evidence.dryRun === false && (legacy || evidence.schemaVersion === 1 && evidence.canary === r.canary &&
      evidence.platform === r.execution.platform && evidence.platformLabel === r.execution.label && evidence.ptyBackend === r.execution.backend));
    if (legacy) legacySequences.push(r.sequence);
    if (!legacy && r.canary === 'C4' && r.execution.platform === 'win32') requireValue(r.capabilityStatus.sandboxChildSendMessage === 'NOT_APPLICABLE');
    if (r.acceptedSpecBranch !== null) {
      const runDir = path.join(root, ...r.evidencePath.split('/').slice(0, 4));
      requireValue(['C1', 'C2'].includes(r.canary) && typeof r.acceptedSpecBranch === 'string' &&
        lexicallyInside(runDir, path.resolve(root, r.acceptedSpecBranch)) &&
        lexicallyInside(runDir, canonical(path.resolve(root, r.acceptedSpecBranch))) &&
        inside(runDir, canonical(path.resolve(root, r.acceptedSpecBranch))));
    }
  }
  return { ledger, legacySequences };
}

function readCapabilities(file, { root = ROOT } = {}) {
  try {
    const bytes = fs.readFileSync(file);
    const { ledger, legacySequences } = validateLedger(JSON.parse(bytes), root);
    const capabilities = {}, capabilityStatus = {}, selectedSequences = {};
    for (const [canary, keys] of Object.entries(CAPS)) {
      selectedSequences[canary] = {};
      const last = Object.fromEntries(EXECUTIONS.map(e => {
        const record = ledger.measurements.filter(r => r.canary === canary && r.execution.label === e.label).at(-1);
        selectedSequences[canary][e.label] = record?.sequence ?? null;
        return [e.label, record];
      }));
      for (const key of keys) {
        const executions = key === 'sandboxChildSendMessage' ? EXECUTIONS.filter(e => e.platform === 'linux') : EXECUTIONS;
        const statuses = executions.map(e => last[e.label]?.capabilityStatus[key] ?? 'UNVERIFIED');
        capabilityStatus[key] = aggregateStatus(statuses);
        capabilities[key] = capabilityStatus[key] === 'PASS';
      }
    }
    return { capabilities, capabilityStatus, selectedSequences, legacySequences, ledgerSha256: hash(bytes) };
  } catch { throw new Error('session capability evidence is unavailable'); }
}

function consolidate(dirs, out, { root = ROOT, baselineHead } = {}) {
  if (!Array.isArray(dirs) || !dirs.length) throw new Error('Consolidation requires per-run directories');
  baselineHead ||= spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 }).stdout?.trim();
  const measurements = dirs.flatMap(dir => {
    const ledger = json(path.join(dir, 'ledger.json'));
    if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.measurements)) throw new Error('Incompatible per-run ledger');
    return ledger.measurements.map(record => ({ ...record, baselineHead: record.baselineHead ?? ledger.baselineHead,
      capabilityStatus: record.capabilityStatus ?? Object.fromEntries((CAPS[record.canary] || []).map(k => [k, record.status])) }));
  }).sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt) || String(a.evidencePath).localeCompare(String(b.evidencePath)))
    .map((record, i) => ({ ...record, sequence: i + 1 }));
  const { ledger } = validateLedger({ schemaVersion: 1, baselineHead, measurements }, root);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  save(out, ledger);
  return ledger;
}

function consolidateArgs(argv) {
  const dirs = [];
  let out;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--out' && !out && argv[i + 1] && !argv[i + 1].startsWith('--')) out = argv[++i];
    else if (!argv[i].startsWith('--')) dirs.push(argv[i]);
    else throw new Error('Unknown consolidation argument');
  }
  if (!out) throw new Error('Consolidation requires --out FILE');
  consolidate(dirs, out);
}

function evidenceIdentity(opts, canary) {
  return { schemaVersion: 1, canary, dryRun: opts.dryRun, qualifiesProduction: false,
    platform: process.platform, platformLabel: opts.platformLabel, ptyBackend: opts.backend };
}

function emptyContext(opts, canary) {
  return { opts, processes: [], capabilities: Object.fromEntries(CAPS[canary].map(k => [k, false])),
    evidence: { ...evidenceIdentity(opts, canary), checks: [], controls: [], processes: [] } };
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--consolidate') {
    try { consolidateArgs(argv); return 0; }
    catch (err) { output(process.stderr, 'Consolidation refused: ' + err.message + '\n'); return 2; }
  }
  let opts, oauthToken;
  try { opts = parse(argv); oauthToken = loadOAuthToken(opts); } catch (err) { output(process.stderr, err.message + '\n'); return 2; }
  if (!opts.dryRun) {
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, env: environment(opts.home), encoding: 'utf8', windowsHide: true, timeout: 4000 });
    if (status.status !== 0 || status.stdout.trim()) { output(process.stderr, 'Refusing live run: dirty or unreadable repository\n'); return 2; }
  }
  fs.mkdirSync(opts.out, { recursive: true });
  if (opts.dryRun) opts.sandbox = true;
  const ledgerFile = path.join(opts.out, opts.dryRun ? 'ledger.dry-run.json' : 'ledger.json');
  const baseline = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: opts.dryRun ? 10000 : 2000 }).stdout?.trim();
  if (!/^[a-f0-9]{40}$/.test(baseline || '')) { output(process.stderr, 'Cannot identify baseline HEAD\n'); return 2; }
  const ledger = fs.existsSync(ledgerFile) ? json(ledgerFile) : { schemaVersion: 1, baselineHead: baseline, measurements: [] };
  if (ledger.schemaVersion !== 1 || ledger.baselineHead !== baseline || !Array.isArray(ledger.measurements)) { output(process.stderr, 'Incompatible existing ledger\n'); return 2; }
  const executable = opts.dryRun ? FIXTURE : opts.cli;
  const cliHash = hash(fs.readFileSync(executable));
  let version = 'unknown', build = 'unknown';
  const probeEnv = environment(opts.home);
  if (oauthToken) probeEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  if (opts.dryRun && process.versions.electron) probeEnv.ELECTRON_RUN_AS_NODE = '1';
  const probe = spawnSync(opts.dryRun ? process.execPath : opts.cli, opts.dryRun ? [FIXTURE, '--version'] : ['--version'],
    { cwd: opts.out, env: probeEnv, encoding: 'utf8', timeout: opts.dryRun ? 10000 : 2000, maxBuffer: 4096, windowsHide: true });
  if (probe.status === 0 && /^[\w .()+:-]+\s*$/.test(probe.stdout || '')) {
    assertRedacted(probe.stdout);
    version = probe.stdout.trim(); build = /\bbuild\s+([\w.-]+)/i.exec(version)?.[1] || 'unknown';
  }
  fs.mkdirSync(opts.runtimeRoot, { recursive: true, mode: 0o700 });
  if (!equalPath(canonical(opts.runtimeRoot), opts.runtimeRoot)) { output(process.stderr, 'Runtime root must be canonical, without aliases\n'); return 2; }
  if (fs.readdirSync(opts.runtimeRoot).length) { output(process.stderr, 'Runtime root must be empty; inspect existing files/lock\n'); return 2; }
  const lock = path.join(opts.runtimeRoot, '.lock');
  let lockHandle;
  try { lockHandle = fs.openSync(lock, 'wx', 0o600); }
  catch { output(process.stderr, 'Runtime root is already owned or has an unreviewed lock\n'); return 2; }
  let exit = 0, pendingRun;
  const persist = ({ ctx, canary, sequence, run }) => {
    const evidenceFile = path.join(run, 'evidence.json');
    save(evidenceFile, ctx.evidence);
    const record = { sequence, canary, status: aggregateStatus(Object.values(ctx.capabilityStatus)), measuredAt: new Date().toISOString(),
      cli: { version, build, sha256: cliHash }, harnessRevision: hash(fs.readFileSync(__filename)),
      evidencePath: path.relative(ROOT, evidenceFile).replaceAll('\\', '/'), evidenceSha256: hash(fs.readFileSync(evidenceFile)),
      capabilities: ctx.capabilities, capabilityStatus: ctx.capabilityStatus, baselineHead: baseline, acceptedSpecBranch: null,
      execution: { label: opts.platformLabel, platform: process.platform, backend: opts.backend } };
    ledger.measurements = ledger.measurements.filter(r => r.sequence !== sequence);
    ledger.measurements.push(record);
    save(ledgerFile, ledger);
  };
  try {
  for (const canary of opts.canary === 'all' ? Object.keys(CAPS) : [opts.canary]) {
    const sequence = (ledger.measurements.at(-1)?.sequence || 0) + 1;
    const run = path.join(opts.out, `${String(sequence).padStart(4, '0')}-${canary}-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(run);
    pendingRun = { canary, sequence, run, ctx: emptyContext(opts, canary) };
    let ctx, status = 'UNVERIFIED';
    try {
      ctx = await makeContext(opts, canary, run, oauthToken);
      pendingRun.ctx = ctx;
      await ({ C1: c1, C2: c2, C3: c3, C4: c4 })[canary](ctx);
      status = 'PASS';
    } catch (err) {
      if (err instanceof RedactionError) throw err;
      status = err instanceof Failed ? 'FAIL' : 'UNVERIFIED';
      if (!ctx) ctx = pendingRun.ctx;
      ctx.evidence.failure = err instanceof Failed || err instanceof Unverified ? err.message : `harness error: ${err.code || err.name}`;
    } finally {
      if (ctx) {
        for (const watcher of ctx.watchers || []) watcher.close();
        for (const proc of ctx.processes) {
          try { await stop(ctx, proc); } catch { status = 'UNVERIFIED'; ctx.evidence.cleanupFailure = true; }
        }
        if (ctx.runtime && ctx.processes.every(p => p.record.cleaned)) removeRuntime(ctx);
        if (ctx.globalSettingsOwned && ctx.processes.every(p => p.record.cleaned)) fs.unlinkSync(path.join(opts.home, '.claude/settings.json'));
      }
    }
    for (const key of CAPS[canary]) {
      if (key === 'sandboxChildSendMessage' && windowsExecution({ opts })) capability(ctx, key, 'NOT_APPLICABLE');
      if (!ctx.capabilityStatus?.[key]) capability(ctx, key, ctx.capabilities[key] ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'UNVERIFIED');
      if (ctx.evidence.cleanupFailure && ctx.capabilityStatus[key] === 'PASS') capability(ctx, key, 'UNVERIFIED');
    }
    status = aggregateStatus(Object.values(ctx.capabilityStatus));
    if (ctx.opts?.mutation) {
      const positive = ['own-title', 'natural-source-activity', 'meta-users', 'escaped-settings', 'no-paste-ref', 'exit-flush-assistant', 'denial-no-error-flag', 'tab-to-spaces', 'raw-control-no-confirmation', 'missing-paste-object', 'send-observation-delayed',
        'stale-descriptor-name', 'descriptor-only-name', 'rename-during-child-launch', 'receipt-delayed',
        'trim-boundary-lf', 'delayed-rename-name', 'slow-c2-turn', 'receipt-on-turn', 'receipt-empty-boundary', 'receipt-idle-delayed', 'slow-tool-search', 'receipt-wrong-scheme',
        'receipt-report-lines', 'receipt-no-leading-lf', 'receipt-duplicate', 'receipt-extra-enqueue', 'receipt-unrelated-nonce'];
      const unavailable = ['no-report', 'synthetic-receipt', 'missing-name', 'unknown-receipt', 'blocking-dialog', 'exit-on-submit', 'hang', 'wrong-recipient', 'os-denial', 'unknown-denial', 'sandbox-unknown-denial',
        'tool-stop', 'tool-stop-idle', 'tool-stop-waiting', 'missing-allowed-tool', 'wrong-command-denial',
        'premature-final', 'tool-stop-side-effect', 'unlinked-denial', 'single-slash-read-rule', 'stale-recipient',
        'receipt-wrong-sender', 'receipt-extra-body', 'receipt-wrong-type', 'receipt-teammate', 'sandbox-socket-unavailable', 'tool-search-only',
        'receipt-nonce-later', 'receipt-empty-body', 'receipt-double-leading-lf', 'receipt-origin-name-mismatch', 'receipt-origin-body-mismatch'];
      const expected = positive.includes(ctx.opts.mutation) ? 'PASS' : unavailable.includes(ctx.opts.mutation) ? 'UNVERIFIED' : 'FAIL';
      ctx.evidence.controls.push({ name: ctx.opts.mutation, status: status === expected ? 'PASS' : 'FAIL', expected, observed: status });
    }
    if (!ctx.evidence.controls.length) ctx.evidence.controls.push({ name: 'table mutations', status: 'UNVERIFIED', reason: 'run separate --dry-run --mutation invocations; no result inferred from a different run' });
    persist(pendingRun);
    if (ctx.processes.some(p => !p.exited)) throw new Unverified('owned handles remain live after ledger write');
    pendingRun = null;
    output(process.stdout, `${canary} ${status}${opts.dryRun ? ' (EMULATED; not production evidence)' : ''}\n`);
    if (status !== 'PASS') exit = 1;
    if (interrupted) return 130;
  }
  return exit;
  } catch (err) {
    if (err instanceof RedactionError || !pendingRun) throw err;
    const { ctx, canary } = pendingRun;
    for (const proc of ctx.processes) {
      try { await stop(ctx, proc); } catch { ctx.evidence.cleanupFailure = true; }
    }
    ctx.evidence.failure = `harness error: ${err.code || err.name}`;
    for (const key of CAPS[canary]) capability(ctx, key,
      key === 'sandboxChildSendMessage' && windowsExecution({ opts }) ? 'NOT_APPLICABLE' : 'UNVERIFIED');
    persist(pendingRun);
    output(process.stdout, `${canary} UNVERIFIED${opts.dryRun ? ' (EMULATED; not production evidence)' : ''}\n`);
    output(process.stderr, 'Harness run aborted; UNVERIFIED evidence retained\n');
    return 2;
  } finally {
    fs.closeSync(lockHandle);
    if (!OWNED.size) fs.unlinkSync(lock);
  }
}

if (require.main === module) main().then(code => {
  if (OWNED.size) throw new Error('Owned handles remain live');
  process.exit(code);
}).catch(async () => {
  try { output(process.stderr, 'Harness setup failed; no capability is qualified\n'); } catch {}
  for (const proc of OWNED) { try { await stop({ opts: { dryRun: !proc.isPty } }, proc); } catch {} }
  if (!OWNED.size) process.exit(2);
  process.exitCode = 2;
});
if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    interrupted = true;
    for (const proc of OWNED) if (!proc.exited) { try { proc.child.kill(); } catch {} }
  });
}
module.exports = { main, parse, environment, received, sandboxPlan, probeMounts, launch, stop, descriptor, submit, pathPermissionRule,
  consolidate, readCapabilities, validateDeliveryPayload, loadOAuthToken, save, nativeReceipt, unexpectedNonceInOrigin, findNativeReceipt };
