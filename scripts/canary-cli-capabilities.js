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
const LIMITS = { C1: 120000, C2: 900000, C3: 180000, C4: 180000 };
const OWNED = new Set();
let interrupted = false;
const MUTATIONS = ['split-paste', 'placeholder-no-confirmation', 'drop-byte', 'missing-paste-object',
  'reuse-worktree', 'drop-sentinel', 'omit-fork', 'own-title', 'remove-deny', 'writable-settings',
  'fake-denial', 'wrong-recipient', 'no-report', 'shared-descriptors', 'parent-env', 'synthetic-receipt', 'hang'];
const CANARY_MUTATIONS = {
  C1: MUTATIONS.slice(0, 4), C2: MUTATIONS.slice(4, 8), C3: MUTATIONS.slice(8, 11), C4: MUTATIONS.slice(11, 16),
};
Object.assign(CANARY_MUTATIONS, {
  C1: [...CANARY_MUTATIONS.C1, 'meta-users', 'no-paste-ref', 'blocking-dialog', 'exit-on-submit', 'storage-only', 'tab-to-spaces', 'exit-flush-assistant'],
  C2: [...CANARY_MUTATIONS.C2, 'natural-source-activity'],
  C3: [...CANARY_MUTATIONS.C3, 'os-denial', 'escaped-settings', 'unknown-denial', 'sandbox-unknown-denial'],
  C4: [...CANARY_MUTATIONS.C4, 'missing-name', 'unknown-receipt', 'wrong-control-leak', 'wrong-control-hidden-leak'],
});
MUTATIONS.push(...Object.values(CANARY_MUTATIONS).flat().filter(x => !MUTATIONS.includes(x)));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const inside = (parent, child) => { const rel = path.relative(parent, child); return !rel.startsWith('..') && !path.isAbsolute(rel); };
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const canonical = p => fs.realpathSync.native(p);
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
    '--c1-timeout-ms': 'C1', '--c2-timeout-ms': 'C2', '--c3-timeout-ms': 'C3', '--c4-timeout-ms': 'C4' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') opts.dryRun = true;
    else if (argv[i] === '--live') opts.dryRun = false;
    else if (argv[i] === '--sandbox') opts.sandbox = true;
    else if (names[argv[i]] && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[names[argv[i]]] = argv[++i];
    else throw new Error('Unknown argument or missing value');
  }
  if (!opts.home || !opts.out || !['all', ...Object.keys(CAPS)].includes(opts.canary)) throw new Error('Required: --canary C1|C2|C3|C4|all --home DIR --out DIR [--cli FILE] [--sandbox] [--dry-run] --platform-label LABEL');
  opts.home = path.resolve(opts.home);
  let accountHome;
  try { accountHome = os.userInfo().homedir; } catch {}
  const homes = [accountHome, os.homedir(), process.env.HOME, process.env.USERPROFILE,
    process.env.HOMEDRIVE && process.env.HOMEPATH ? process.env.HOMEDRIVE + process.env.HOMEPATH : null].filter(Boolean);
  if (!opts.dryRun && !opts.runtimeRoot) throw new Error('Live runs require an explicit --runtime-root');
  opts.runtimeRoot = path.resolve(opts.runtimeRoot || path.join(os.tmpdir(), 'switchboard-canary380-runtime'));
  for (const location of [opts.home, opts.runtimeRoot, path.join(opts.runtimeRoot, 'project')]) guardedLocation(location, homes);
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
    if (!inside(EVIDENCE, opts.out)) throw new Error('Live --out must be under docs/evidence/session-capabilities');
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
    timeout: Math.min(4000, remaining), maxBuffer: 1024 * 1024 });
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
  const file = entries(path.join(ctx.opts.home, '.claude/projects')).find(p => path.basename(p) === `${id}.jsonl`);
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
  const envelope = /^<pasted_content id="(\d+)">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="\1">$/.exec(raw);
  const body = envelope ? envelope[2] : raw;
  const literal = Buffer.from(body).equals(Buffer.from(payload));
  const placeholder = /^\[Pasted text(?:\s|\])/.test(body);
  const transformations = byteTransformations(payload, body);
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
      if (name === reference || envelope && [envelope[1], `${envelope[1]}.txt`].includes(name)) {
        hasReference = true;
        if (bytes.equals(Buffer.from(payload))) linked = true;
      }
    }
  }
  return { literal, linked, exact: literal || linked, hasReference, placeholder,
    wrapperPresent: !!envelope, wrapperId: envelope?.[1] ?? null, transformations, pasteCache,
    storedBodyBytes: Buffer.byteLength(body), storedBodySha256: hash(body) };
}

function byteTransformations(payload, body) {
  if (payload === body) return [];
  const operations = [
    ...Array.from({ length: 8 }, (_, i) => ['tab-to-spaces', s => s.replaceAll('\t', ' '.repeat(i + 1))]),
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
  if (!fs.existsSync(config)) fs.writeFileSync(config, fs.existsSync(prepared) ? fs.readFileSync(prepared) : '{}', { mode: 0o600 });
  args.push('--bind', config, path.join(home, '.claude.json'), '--dir', '/run', '--perms', '0555', '--dir', '/run/switchboard',
    '--ro-bind', settings, '/run/switchboard/launch-settings.json', '--chdir', cwd, '--setenv', 'SHELL', '/bin/bash');
  return args;
}

function probeMounts(ctx, plan, sessions, settings) {
  const peer = fs.mkdtempSync(path.join(ctx.opts.home, '.claude/sessions/peer-'));
  const peerFile = path.join(peer, 'peer-marker');
  fs.writeFileSync(peerFile, 'peer');
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
  for (const file of fs.readdirSync(dir).filter(x => /^\d+\.json$/.test(x))) {
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
          const current = fs.statSync(dir);
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

async function launch(ctx, { cwd = ctx.repo, args = [], sandbox = false, settings, mutation = ctx.opts.mutation } = {}) {
  if (!ctx.opts.dryRun && sandbox && process.platform !== 'linux') throw new Unverified('bubblewrap is Linux-only');
  trusted(ctx, args.includes('--worktree') ? path.join(cwd, '.claude/worktrees', args[args.indexOf('--worktree') + 1]) : cwd);
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
      CANARY_FIXTURE_SANDBOX: sandbox ? '1' : '', CANARY_FIXTURE_PROC_START: fixtureStart, CANARY_FIXTURE_RUNTIME: ctx.runtime });
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
  const preexisting = new Map(fs.readdirSync(sessions).filter(x => /^\d+\.json$/.test(x)).map(file => {
    const p = path.join(sessions, file);
    return [file, fs.statSync(p).size <= 65536 ? hash(fs.readFileSync(p)) : 'oversized'];
  }));
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
    child = ctx.ptyFactory(exe, cliArgs, { cwd, env });
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
  const ds = fs.statSync(sessions);
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
    if (d?.status === 'waiting') { record.waitingFor = d.waitingFor || 'unknown'; throw new Unverified('owned CLI blocking dialog at launch'); }
    if (d?.waitingFor) record.waitingFor = d.waitingFor;
    return d?.status === 'idle' ? d : null;
  }, 'owned CLI idle descriptor');
  proc.id = ready.sessionId; proc.cwd = ready.cwd; proc.name = ready.name;
  record.sessionId = proc.id; record.cwd = proc.cwd;
  record.descriptorSource = path.relative(ctx.run, sessions).replaceAll('\\', '/');
  record.namespace = proc.namespace || null; record.innerPid = proc.innerPid || null; record.procStart = proc.procStart || null;
  record.writerHostPid = proc.writerPid || proc.pid; record.directoryIdentity = proc.directoryIdentity;
  return proc;
}

async function submit(ctx, proc, payload) {
  if (proc.exited) throw new Unverified('owned CLI exited before submit');
  const before = transcript(ctx, proc.id);
  const time = Date.now();
  const bytes = '\x1b[200~' + payload + '\x1b[201~';
  if (!proc.isPty) { proc.child.stdin.write(bytes); proc.child.stdin.write('\r'); }
  else { proc.child.write(bytes); proc.child.write('\r'); }
  let lastBytes = before.bytes, stableSince = Date.now();
  const phase = payload.startsWith('/rename ') ? 'rename' : /^CANARY_META /.test(payload) ? 'tool task' : 'ordinary turn';
  await until(ctx, () => {
    if (proc.exited) throw new Unverified('owned CLI exited before confirmation');
    const t = transcript(ctx, proc.id);
    const d = descriptor(ctx, proc);
    if (d?.status === 'waiting') { proc.record.waitingFor = d.waitingFor || 'unknown'; throw new Unverified('owned CLI blocking dialog before confirmation'); }
    if (d?.waitingFor) proc.record.waitingFor = d.waitingFor;
    if (t.bytes !== lastBytes) { lastBytes = t.bytes; stableSince = Date.now(); }
    const renamed = payload.startsWith('/rename ') && t.rows.some(r => r._offset >= before.bytes && r.type === 'custom-title');
    if (t.bytes > before.bytes && d?.status === 'idle' && (d.statusUpdatedAt >= time || renamed) && Date.now() - stableSince >= (ctx.opts.dryRun ? 20 : 100)) {
      proc.record.descriptorConfirmation = { submittedAt: time, observedAt: Date.now(), status: d.status,
        statusUpdatedAt: d.statusUpdatedAt ?? null, waitingFor: d.waitingFor ?? null };
      proc.record.oscObservations = proc.osc.filter(x => x.at >= time);
      return t;
    }
    return null;
  }, `new transcript and owned post-submit idle: ${phase}`);
  return transcript(ctx, proc.id).rows.filter(r => r._offset >= before.bytes);
}

async function stop(ctx, proc) {
  if (proc.record.cleaned) return;
  if (!proc.exited) {
    if (proc.id && proc.record.descriptorConfirmation) {
      const shutdown = proc.record.shutdown = { stable: false, gracefulExit: false, forcedKill: false };
      try {
        const quietMs = ctx.opts.dryRun ? 50 : 1000;
        let lastBytes = transcript(ctx, proc.id).bytes, stableSince = Date.now();
        try {
          await until({ cleanup: true, deadline: Date.now() + (ctx.opts.dryRun ? 500 : 5000) }, () => {
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
            await until({ cleanup: true, deadline: Date.now() + 2000 }, () => proc.exited, 'graceful owned process exit', 2000);
            shutdown.gracefulExit = true;
          } catch { shutdown.gracefulExitTimedOut = true; }
        }
        shutdown.finalBytes = transcript(ctx, proc.id).bytes;
      } catch { shutdown.transcriptReadFailed = true; }
    }
    if (!proc.exited) {
      if (proc.record.shutdown) proc.record.shutdown.forcedKill = true;
      proc.child.kill();
      await until({ cleanup: true, deadline: Date.now() + 2000 }, () => proc.exited, 'owned process exit', 2000);
    }
  }
  proc.record.cleaned = proc.exited;
  if (proc.exited) OWNED.delete(proc);
}

function inventory(ctx) {
  if (ctx.opts.dryRun) return json(path.join(ctx.runtime, 'worktree-inventory.json'));
  return command(ctx, 'git', ['worktree', 'list', '--porcelain']).split('\n').filter(x => x.startsWith('worktree ')).map(x => path.resolve(x.slice(9)));
}

async function c1(ctx) {
  const results = [];
  for (const size of [180, 5000, 32768, 49152]) {
    const nonce = crypto.randomUUID();
    const prefix = `CANARY ${nonce}\nLiteral LF\tTAB \"quotes\" 'single' café 東京\nReply only OK.\n`;
    const payload = prefix + 'x'.repeat(size - Buffer.byteLength(prefix));
    const proc = await launch(ctx);
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
    results.push({ one, ...stored, reaction });
    ctx.evidence.payloads.push({ bytes: size, sha256: hash(payload), nonce, userTurns: turns.length,
      literal: stored.literal, linkedPaste: stored.linked, independentlyObservedReaction: reaction,
      wrapperPresent: stored.wrapperPresent ?? false, wrapperId: stored.wrapperId ?? null,
      transformations: stored.transformations ?? [], pasteCache: stored.pasteCache ?? [],
      storedBodyBytes: stored.storedBodyBytes, storedBodySha256: stored.storedBodySha256,
      singleTurnDelivery: one, eligibleConfirmation: one && reaction,
      descriptorConfirmation: proc.record.descriptorConfirmation, oscObservations: proc.record.oscObservations,
      transcriptId: proc.id, userOffsets: turns.map(r => r._offset),
      transcriptConfirmedBytes: confirmed, transcriptFinalBytes: final.bytes,
      finalRowTypes: rows.map(r => ({ type: r.type, offset: r._offset })) });
  }
  ctx.evidence.controls.push({ name: 'short literal control', status: results[0].one && results[0].literal && results[0].reaction ? 'PASS' : 'FAIL' });
  ctx.capabilities.singleTurnDelivery = results.every(x => x.one);
  ctx.capabilities.literalTranscript = results.every(x => x.literal);
  ctx.capabilities.eligibleConfirmation = results.every(x => x.one && x.reaction);
  check(ctx, 'one received user turn at every size', ctx.capabilities.singleTurnDelivery);
  check(ctx, 'eligible post-submit confirmation at every size', ctx.capabilities.eligibleConfirmation);
  check(ctx, 'supported paste object agrees with own payload', results.every(x => !x.hasReference || x.linked));
  if (!ctx.capabilities.literalTranscript && results.every(x => x.exact || x.placeholder)) throw new Unverified('storage-only branch needs owner amendment');
  check(ctx, 'literal transcript at every size; storage-only branch requires owner amendment', ctx.capabilities.literalTranscript);
}

async function c2(ctx) {
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
  ctx.capabilities.forkWorktree = true;
}

async function permissionCase(ctx, sandbox, removeDeny = false) {
  const nonce = crypto.randomUUID();
  const deniedFile = path.join(ctx.repo, `denied-${nonce}`);
  const allowedFile = path.join(ctx.repo, `allowed-${nonce}`);
  const deniedCommand = `printf denied > '${deniedFile.replaceAll('\\', '/')}'`;
  const allowedCommand = `printf allowed > '${allowedFile.replaceAll('\\', '/')}'`;
  const settings = path.join(ctx.private, `permissions-${nonce}.json`);
  const readPath = sandbox && !ctx.opts.dryRun ? '/run/switchboard/launch-settings.json' : settings;
  const rule = `Bash(${deniedCommand})`;
  save(settings, { permissions: { allow: [`Read(${readPath})`, rule, `Bash(${allowedCommand})`], deny: removeDeny ? [] : [rule] } });
  save(path.join(ctx.repo, '.claude/settings.json'), { permissions: { allow: [rule] } });
  const globalSettings = path.join(ctx.opts.home, '.claude/settings.json');
  if (fs.existsSync(globalSettings) && !ctx.globalSettingsOwned) throw new Unverified('C3 needs a login-only prepared home without existing global settings; no settings are overwritten');
  ctx.globalSettingsOwned = true;
  save(globalSettings, { permissions: { allow: [rule] } });
  const protectedFile = path.join(ctx.private, 'protected-marker');
  fs.writeFileSync(protectedFile, 'protected');
  const protectionCommand = `printf changed > '${readPath.replaceAll('\\', '/')}' ; printf changed > '${protectedFile.replaceAll('\\', '/')}'`;
  if (sandbox) {
    const policy = json(settings);
    policy.permissions.allow.push(`Bash(${protectionCommand})`);
    save(settings, policy);
  }
  const before = hash(fs.readFileSync(settings));
  const meta = { kind: 'permissions', deniedFile, allowedFile, deniedCommand, allowedCommand, protectionCommand };
  const prompt = `CANARY_META ${JSON.stringify(meta)}\nFirst use Read on ${JSON.stringify(readPath)} to read the exact JSON. Run exactly the deniedCommand then allowedCommand using Bash. The first is intentionally denied by settings; do not ask for approval or bypass it. ${sandbox ? 'Also attempt protectionCommand with Bash; report its actual error.' : ''}`;
  const proc = await launch(ctx, { sandbox, settings });
  const rows = await submit(ctx, proc, prompt);
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
  const errorResult = attempt && all.find(x => x.type === 'tool_result' && x.tool_use_id === attempt.id && x.is_error === true);
  const denialText = errorResult ? flatText(errorResult.content) : '';
  const denial = !!errorResult && /permission to use (?:bash|this tool) has been denied|(?:tool|bash) (?:use )?(?:was |is )?denied by (?:permission|settings)|(?:permission|settings) rule.*(?:denied|disallow)/i.test(denialText);
  const denialObservation = { status: denial ? 'PASS' : 'UNVERIFIED',
    ...(errorResult ? { sha256: hash(denialText), excerpt: denialText.slice(0, 200), offset: errorResult._offset } : {}) };
  const allowed = all.find(x => x.type === 'tool_use' && x.name === 'Bash' && normal(x.input?.command) === normal(allowedCommand));
  const protectedAttempt = all.find(x => x.type === 'tool_use' && x.name === 'Bash' && normal(x.input?.command) === normal(protectionCommand));
  const protectedError = protectedAttempt && all.some(x => x.type === 'tool_result' && x.tool_use_id === protectedAttempt.id && /read.only|permission denied/i.test(flatText(x.content)));
  const absent = !fs.existsSync(deniedFile);
  const immutable = before === hash(fs.readFileSync(settings)) && fs.readFileSync(protectedFile, 'utf8') === 'protected';
  ctx.evidence.permissions.push({ sandbox, settingsSha256: before, deniedSideEffectAbsent: absent, toolPermissionDenial: !!denial,
    denialObservation,
    nonOverlappingActionRan: !!allowed && fs.existsSync(allowedFile), immutable, protectionAttemptObserved: !!protectedAttempt,
    protectionError: !!protectedError, exactSettingsRead: !!exactSettingsRead,
    inheritedProjectAllow: true, inheritedGlobalAllow: true });
  await stop(ctx, proc);
  if (!removeDeny && absent && !denial) throw new Unverified('CLI permission denial text unrecognized or result absent');
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
  if (!ctx.opts.sandbox) throw new Unverified('C3 requires --sandbox and Linux read-only mount proof for a complete PASS');
  const sand = await permissionCase(ctx, true);
  check(ctx, 'sandbox reads settings and enforces deny and allowed control', sand.exactSettingsRead && sand.absent && sand.denial && sand.allowed);
  check(ctx, 'sandbox settings and parent immutable with actual failed write attempt', sand.immutable && sand.protectedError);
  ctx.capabilities.extraPermissionSettings = true;
}

async function reportPair(ctx, sandbox, wrongRecipientControl = false) {
  const origin = await launch(ctx, { mutation: ctx.opts.mutation === 'missing-name' ? 'missing-name' : '' });
  await submit(ctx, origin, 'Wait for a native SendMessage from an independent child; reply OK. ' + crypto.randomUUID());
  const uiTitle = 'UI-' + crypto.randomUUID();
  await submit(ctx, origin, '/rename ' + uiTitle);
  origin.name = descriptor(ctx, origin)?.name;
  if (typeof origin.name !== 'string' || !origin.name.length) {
    ctx.evidence.reports.push({ phase: 'orchestrator-name', rawOriginRows: transcript(ctx, origin.id).rows.map(r => ({ type: r.type, offset: r._offset })) });
    throw new Unverified('orchestrator native recipient name unavailable');
  }
  if (origin.name === uiTitle) throw new Unverified('native recipient name indistinguishable from display title');
  const before = transcript(ctx, origin.id).bytes;
  const nonce = crypto.randomUUID();
  const child = await launch(ctx, { sandbox, settings: ctx.emptySettings });
  const recipient = wrongRecipientControl ? 'absent-' + crypto.randomUUID() : origin.name;
  const meta = { kind: 'report', nonce, recipient, orchestrator: origin.id, wrongRecipientControl };
  const payload = 'CANARY_META ' + JSON.stringify(meta) + '\nReport exactly ' + nonce + ' using SendMessage.\n\nSwitchboard child assignment\nOrchestrator name: ' + JSON.stringify(recipient) + '\nOrchestrator session id: ' + JSON.stringify(origin.id) + '\nWhen the assigned task is complete, use SendMessage to report to the orchestrator named above. Include the result, the checks performed, and any blocker. If you cannot proceed, report the blocker with SendMessage. Do not open another reporting transport.';
  const rows = await submit(ctx, child, payload);
  const sends = blocks(rows).filter(x => x.type === 'tool_use' && x.name === 'SendMessage' && flatText(x.input?.content).includes(nonce));
  const send = sends.find(x => x.input?.recipient === recipient);
  const receiptRows = () => transcript(ctx, origin.id).rows.filter(r => r._offset >= before);
  const carriesNonce = row => JSON.stringify(row).includes(nonce);
  const recognize = r => content(r).includes(nonce) && (ctx.opts.dryRun
    ? r.type === 'system' && r.subtype === 'native-message' && r.fixtureSender === child.id
    : typeof child.name === 'string' && /<teammate-message\b/.test(content(r)) && content(r).includes(child.name));
  let receipt;
  if (send) {
    if (wrongRecipientControl) {
      const end = Math.min(ctx.deadline, Date.now() + (ctx.opts.dryRun ? 150 : 15000));
      await until(ctx, () => Date.now() >= end || receiptRows().some(carriesNonce), 'wrong-recipient observation window', Math.max(100, end - Date.now() + 100));
    } else {
      try { receipt = await until(ctx, () => receiptRows().find(recognize), 'native receipt', ctx.opts.dryRun ? 250 : 15000); }
      catch (err) { if (!(err instanceof Unverified)) throw err; }
    }
  }
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
  const isolated = !sandbox || child.sessions !== origin.sessions && !inside(ctx.repo, child.sessions) && envStatus === 'PASS' && !messagingKeys.length;
  const raw = receiptRows();
  const leaked = raw.some(carriesNonce);
  const observation = { sandbox, wrongRecipientControl, nonce, orchestratorId: origin.id, childId: child.id,
    before, nativeRecipientDiffersFromDisplayTitle: origin.name !== uiTitle,
    distinctProcesses: origin.pid !== child.pid, intendedToolCall: !!send, nativeReceipt: !!receipt,
    receiptOffset: receipt?._offset ?? null, privatePublication: isolated,
    parentEnvironment: { status: process.platform === 'win32' ? 'UNVERIFIED' : envStatus, fixtureOutcome: ctx.opts.dryRun ? envStatus : 'UNVERIFIED', source: process.platform === 'linux' ? '/proc owned child' : ctx.opts.dryRun ? 'emulated child descriptor; Windows actual environment unmeasured' : 'Windows environment inspection unavailable' },
    messagingEnvKeys: messagingKeys, rawChildRows: rows.map(r => ({ type: r.type, offset: r._offset })),
    rawReceiptRows: raw.map(r => ({ type: r.type, offset: r._offset })), unexpectedNonceInOrigin: leaked };
  ctx.evidence.reports.push(observation);
  await stop(ctx, child); await stop(ctx, origin);
  if (!send && sends.length) throw new Unverified('SendMessage used wrong recipient');
  if (!send) throw new Unverified('native SendMessage tool call unavailable');
  if (wrongRecipientControl) {
    check(ctx, 'wrong-recipient tool call observed and origin has no nonce after boundary', !leaked);
    ctx.evidence.controls.push({ name: 'wrong-recipient', status: 'PASS' });
    return;
  }
  if (!receipt) throw new Unverified('native receipt unrecognized or absent');
  if (!child.name) throw new Unverified('child native sender name unavailable');
  if (sandbox && envStatus !== 'PASS') throw new Unverified('child actual environment unavailable');
  check(ctx, 'independent native SendMessage receipt and private publication', isolated && origin.pid !== child.pid && origin.id !== child.id);
}

async function c4(ctx) {
  if (!ctx.opts.dryRun && process.platform === 'win32') throw new Unverified('C4 Linux-only namespace proof; Windows does not qualify');
  await reportPair(ctx, false);
  await reportPair(ctx, false, true);
  if (!ctx.opts.sandbox) throw new Unverified('C4 requires --sandbox for private-publication child proof');
  await reportPair(ctx, true);
  ctx.capabilities.independentSendMessage = true;
  ctx.capabilities.sandboxChildSendMessage = true;
}

async function makeContext(opts, canary, run) {
  opts = { ...opts, mutation: opts.mutation === 'hang' || CANARY_MUTATIONS[canary].includes(opts.mutation) ? opts.mutation : undefined };
  const runtime = opts.runtimeRoot;
  const repo = path.join(runtime, 'project');
  const privateDir = path.join(runtime, 'private');
  if (fs.existsSync(repo) || fs.existsSync(privateDir) || fs.existsSync(path.join(runtime, 'W1'))) throw new Unverified('runtime fixture leftovers require operator inspection');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtime, 0o700);
  const env = environment(opts.home);
  const ctx = { opts, run, repo, private: privateDir, runtime, env, deadline: Date.now() + (+opts.timeout || opts.limits[canary]),
    processes: [], watchers: [], observation: 0, capabilities: Object.fromEntries(CAPS[canary].map(k => [k, false])),
    evidence: { schemaVersion: 1, canary, dryRun: opts.dryRun, qualifiesProduction: false,
      platform: process.platform, kernel: os.release(), platformLabel: opts.platformLabel, ptyBackend: opts.backend,
      environmentKeys: Object.keys(env).sort(), mutation: opts.mutation || null,
      workBudgetMs: +opts.timeout || opts.limits[canary], fixtureIdentity: hash(repo),
      inventorySource: opts.dryRun ? 'emulated fixture manifest; no real git worktrees' : 'git worktree list --porcelain',
      peerAliasThreat: { status: 'UNVERIFIED', reason: 'publication-path probe does not establish resistance to shared sessions directory aliases' },
      checks: [], controls: [], processes: [], payloads: [], forks: [], permissions: [], reports: [] } };
  ctx.emptySettings = path.join(privateDir, 'empty-settings.json'); save(ctx.emptySettings, {});
  if (opts.dryRun) save(path.join(runtime, 'worktree-inventory.json'), [repo]);
  try {
    command(ctx, 'git', ['init', '-q']);
    command(ctx, 'git', ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Capability canary fixture\n');
    command(ctx, 'git', ['add', 'README.md']);
    command(ctx, 'git', ['commit', '-qm', 'Create disposable canary fixture']);
  } catch (err) { removeRuntime(ctx); throw err; }
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

async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parse(argv); } catch (err) { process.stderr.write(err.message + '\n'); return 2; }
  if (!opts.dryRun) {
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, env: environment(opts.home), encoding: 'utf8', windowsHide: true, timeout: 4000 });
    if (status.status !== 0 || status.stdout.trim()) { process.stderr.write('Refusing live run: dirty or unreadable repository\n'); return 2; }
  }
  fs.mkdirSync(opts.out, { recursive: true });
  if (opts.dryRun) opts.sandbox = true;
  const ledgerFile = path.join(opts.out, opts.dryRun ? 'ledger.dry-run.json' : 'ledger.json');
  const baseline = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 2000 }).stdout?.trim();
  if (!/^[a-f0-9]{40}$/.test(baseline || '')) { process.stderr.write('Cannot identify baseline HEAD\n'); return 2; }
  const ledger = fs.existsSync(ledgerFile) ? json(ledgerFile) : { schemaVersion: 1, baselineHead: baseline, measurements: [] };
  if (ledger.schemaVersion !== 1 || ledger.baselineHead !== baseline || !Array.isArray(ledger.measurements)) { process.stderr.write('Incompatible existing ledger\n'); return 2; }
  const executable = opts.dryRun ? FIXTURE : opts.cli;
  const cliHash = hash(fs.readFileSync(executable));
  let version = 'unknown', build = 'unknown';
  const probeEnv = environment(opts.home);
  if (opts.dryRun && process.versions.electron) probeEnv.ELECTRON_RUN_AS_NODE = '1';
  const probe = spawnSync(opts.dryRun ? process.execPath : opts.cli, opts.dryRun ? [FIXTURE, '--version'] : ['--version'],
    { cwd: opts.out, env: probeEnv, encoding: 'utf8', timeout: 2000, maxBuffer: 4096, windowsHide: true });
  if (probe.status === 0 && /^[\w .()+:-]+\s*$/.test(probe.stdout || '')) {
    version = probe.stdout.trim(); build = /\bbuild\s+([\w.-]+)/i.exec(version)?.[1] || 'unknown';
  }
  fs.mkdirSync(opts.runtimeRoot, { recursive: true, mode: 0o700 });
  if (!equalPath(canonical(opts.runtimeRoot), opts.runtimeRoot)) { process.stderr.write('Runtime root must be canonical, without aliases\n'); return 2; }
  if (fs.readdirSync(opts.runtimeRoot).length) { process.stderr.write('Runtime root must be empty; inspect existing files/lock\n'); return 2; }
  const lock = path.join(opts.runtimeRoot, '.lock');
  let lockHandle;
  try { lockHandle = fs.openSync(lock, 'wx', 0o600); }
  catch { process.stderr.write('Runtime root is already owned or has an unreviewed lock\n'); return 2; }
  let exit = 0;
  try {
  for (const canary of opts.canary === 'all' ? Object.keys(CAPS) : [opts.canary]) {
    const sequence = (ledger.measurements.at(-1)?.sequence || 0) + 1;
    const run = path.join(opts.out, `${String(sequence).padStart(4, '0')}-${canary}-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(run);
    let ctx, status = 'UNVERIFIED';
    try {
      ctx = await makeContext(opts, canary, run);
      await ({ C1: c1, C2: c2, C3: c3, C4: c4 })[canary](ctx);
      status = 'PASS';
    } catch (err) {
      status = err instanceof Failed ? 'FAIL' : 'UNVERIFIED';
      if (!ctx) ctx = { processes: [], capabilities: Object.fromEntries(CAPS[canary].map(k => [k, false])), evidence: { dryRun: opts.dryRun, qualifiesProduction: false, checks: [], controls: [], processes: [] } };
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
    if (ctx.opts?.mutation) {
      const positive = ['own-title', 'natural-source-activity', 'meta-users', 'escaped-settings', 'no-paste-ref', 'exit-flush-assistant'];
      const unavailable = ['no-report', 'synthetic-receipt', 'missing-name', 'unknown-receipt', 'blocking-dialog', 'exit-on-submit', 'storage-only', 'hang', 'wrong-recipient', 'os-denial', 'unknown-denial', 'sandbox-unknown-denial'];
      const expected = positive.includes(ctx.opts.mutation) ? 'PASS' : unavailable.includes(ctx.opts.mutation) ? 'UNVERIFIED' : 'FAIL';
      ctx.evidence.controls.push({ name: ctx.opts.mutation, status: status === expected ? 'PASS' : 'FAIL', expected, observed: status });
    }
    if (!ctx.evidence.controls.length) ctx.evidence.controls.push({ name: 'table mutations', status: 'UNVERIFIED', reason: 'run separate --dry-run --mutation invocations; no result inferred from a different run' });
    if (status !== 'PASS') for (const key of Object.keys(ctx.capabilities)) ctx.capabilities[key] = false;
    const evidenceFile = path.join(run, 'evidence.json');
    save(evidenceFile, ctx.evidence);
    ledger.measurements.push({ sequence, canary, status, measuredAt: new Date().toISOString(),
      cli: { version, build, sha256: cliHash }, harnessRevision: hash(fs.readFileSync(__filename)),
      evidencePath: path.relative(ROOT, evidenceFile).replaceAll('\\', '/'), evidenceSha256: hash(fs.readFileSync(evidenceFile)),
      capabilities: ctx.capabilities, acceptedSpecBranch: null,
      execution: { label: opts.platformLabel, platform: process.platform, backend: opts.backend } });
    save(ledgerFile, ledger);
    process.stdout.write(`${canary} ${status}${opts.dryRun ? ' (EMULATED; not production evidence)' : ''}\n`);
    if (status !== 'PASS') exit = 1;
    if (ctx.processes.some(p => !p.exited)) throw new Unverified('owned handles remain live after ledger write');
    if (interrupted) return 130;
  }
  return exit;
  } finally {
    fs.closeSync(lockHandle);
    if (!OWNED.size) fs.unlinkSync(lock);
  }
}

if (require.main === module) main().then(code => {
  if (OWNED.size) throw new Error('Owned handles remain live');
  process.exit(code);
}).catch(async () => {
  process.stderr.write('Harness setup failed; no capability is qualified\n');
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
module.exports = { main, parse, environment, received, sandboxPlan, probeMounts, launch, stop, descriptor, submit };
