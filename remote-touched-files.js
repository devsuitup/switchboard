// see .ai/contexts/touched-files.md ("Remote sessions")
'use strict';

const path = require('path');
const { defaultRunRemoteCommand } = require('./remote-attach');
const { shQuote, buildRemoteGitCommand, buildGitArgs, isSafeGitPath } = require('./git-changes-runner');
const { toLf, decodeUtf8 } = require('./git-changes-file');
const { matchesDenylist } = require('./ipc-path-validator');
const { isValidAlias } = require('./remote-hosts');

const REMOTE_TOUCHED_READ_MAX_BYTES = 2 * 1024 * 1024;
const REMOTE_TOUCHED_STAT_MAX_BYTES = 64 * 1024;
const REMOTE_TOUCHED_TIMEOUT_MS = 20000;
const REMOTE_TOUCHED_MAX_FILES = 500;
const REMOTE_KEY_NAMES = ['rsa', 'dsa', 'ecdsa', 'ed25519'].flatMap(algorithm =>
  ['', '_sk', '.pub', '_sk.pub'].map(suffix => 'id_' + algorithm + suffix));

function isRemoteTouchedPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 4096 && p.startsWith('/')
    && !/[\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}]/u.test(p)
    && !p.split(/[/\\]/).includes('..');
}

function isProtectedRemotePath(p) {
  const normalized = path.posix.normalize(p).toLowerCase();
  return p.split('/').includes('.git') || matchesDenylist([p])
    || normalized === '/etc/shadow' || normalized === '/etc/gshadow'
    || normalized.startsWith('/etc/ssh/ssh_host_')
    || REMOTE_KEY_NAMES.includes(path.posix.basename(normalized))
    || /\.(?:pem|key)$/.test(normalized);
}

const PROTECTED_CHECK = `protected() {
  case "$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]')" in
    /etc/shadow|/etc/gshadow|/etc/ssh/ssh_host_*|*.pem|*.key|${REMOTE_KEY_NAMES.map(name => '*/' + name).join('|')}|*/.git/*|*/.git|*/.ssh/*|*/.gnupg/*|*/.config/gcloud/*) return 0 ;;
    */.env.example|*/.env.sample|*/.env.template) return 1 ;;
    */.git/*|*/.git|*/.ssh/*|*/.gnupg/*|*/.aws/credentials|*/.env|*/.env.*|*/.netrc|*/.docker/config.json|*/.kube/config|*/.claude/.credentials.json|*/.git-credentials|*/.config/gh/hosts.yml|*/.config/gh/hosts.yaml|*/.config/gcloud/*|*/.npmrc|*/.pypirc|*/.pgpass|*/.my.cnf) return 0 ;;
  esac
  return 1
}`;

const MISSING_CHECK = `missing_state() {
  parent=\${1%/*}
  [ -n "$parent" ] || parent=/
  while [ "$parent" != / ] && [ ! -d "$parent" ]; do parent=\${parent%/*}; [ -n "$parent" ] || parent=/; done
  if [ -x "$parent" ]; then printf 'gone\\t-\\n'; else printf 'unreadable\\t-\\n'; fi
}`;

const STAT_SCRIPT = `${PROTECTED_CHECK}
${MISSING_CHECK}
stat -L -c '%Y' -- / >/dev/null 2>&1 || exit 48
realpath -m -- / >/dev/null 2>&1 || exit 48
while IFS= read -r p; do
  resolved=$(realpath -m -- "$p" 2>/dev/null) || { printf 'unknown\\t-\\n'; continue; }
  if protected "$resolved"; then printf 'refused\\t-\\n'
  elif [ ! -e "$resolved" ]; then missing_state "$resolved"
  elif [ ! -f "$resolved" ]; then printf 'not-file\\t-\\n'
  elif [ ! -r "$resolved" ]; then printf 'unreadable\\t-\\n'
  else
    mtime=$(stat -L -c '%Y' -- "$resolved" 2>/dev/null) || { printf 'unreadable\\t-\\n'; continue; }
    printf 'present\\t%s\\n' "$mtime"
  fi
done`;

function shellCommand(script, paths) {
  return ['sh', '-c', shQuote(script), 'sh', ...paths.map(shQuote)].join(' ');
}

async function inspectRemoteTouchedPaths(alias, paths, deps = {}) {
  const states = new Map(paths.map(p => [p, { state: 'unknown', diskMtime: null }]));
  const accepted = [];
  for (const p of paths) {
    if (!isRemoteTouchedPath(p) || isProtectedRemotePath(p)) states.set(p, { state: 'refused', diskMtime: null });
    else if (accepted.length < REMOTE_TOUCHED_MAX_FILES) accepted.push(p);
  }
  if (!isValidAlias(alias) || accepted.length === 0) return states;
  try {
    const run = deps.runRemoteCommand || defaultRunRemoteCommand;
    const result = await run(alias, shellCommand(STAT_SCRIPT, []), {
      timeoutMs: REMOTE_TOUCHED_TIMEOUT_MS, maxStdoutBytes: REMOTE_TOUCHED_STAT_MAX_BYTES,
      input: accepted.join('\n') + '\n',
    });
    if (result.code !== 0 || result.timedOut || Buffer.byteLength(result.stdout || '') > REMOTE_TOUCHED_STAT_MAX_BYTES) return states;
    const lines = String(result.stdout || '').split('\n');
    if (lines.pop() !== '' || lines.length !== accepted.length) return states;
    const parsed = lines.map(line => /^(present|gone|unreadable|not-file|refused|unknown)\t(-|[0-9]+)$/.exec(line));
    if (parsed.some(m => !m || (m[1] === 'present' && (m[2] === '-' || !Number.isSafeInteger(Number(m[2]) * 1000))))) return states;
    accepted.forEach((p, i) => states.set(p, { state: parsed[i][1], diskMtime: parsed[i][1] === 'present' ? Number(parsed[i][2]) * 1000 : null }));
  } catch {
    return states;
  }
  return states;
}

const READ_SCRIPT = `${PROTECTED_CHECK}
${MISSING_CHECK}
p=$1
resolved=$(realpath -e -- "$p" 2>/dev/null) || { state=$(missing_state "$p"); case "$state" in gone*) exit 44;; *) exit 45;; esac; }
protected "$resolved" && exit 46
[ -f "$resolved" ] || exit 47
[ -r "$resolved" ] || exit 45
head -c ${REMOTE_TOUCHED_READ_MAX_BYTES + 1} -- "$resolved"`;

function readFailure(result) {
  if (result.code === 44) return { ok: false, reason: 'gone', error: 'File does not exist' };
  if (result.code === 45) return { ok: false, reason: 'unreadable', error: 'File could not be read' };
  if (result.code === 46) return { ok: false, reason: 'refused', error: 'access to sensitive path denied' };
  if (result.code === 47) return { ok: false, reason: 'not-file', error: 'not a regular file' };
  return { ok: false, reason: 'unknown', error: 'the remote connection failed or the host is unreachable' };
}

function checkedContent(result) {
  if (result.overflow) return { ok: false, reason: 'too-large', error: 'file too large to display' };
  if (result.code !== 0 || result.timedOut) return readFailure(result);
  const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
  if (bytes.length > REMOTE_TOUCHED_READ_MAX_BYTES) return { ok: false, reason: 'too-large', error: 'file too large to display' };
  if (bytes.includes(0)) return { ok: false, reason: 'binary', error: 'binary file' };
  const content = decodeUtf8(bytes);
  if (content === null) return { ok: false, reason: 'encoding', error: 'file is not valid UTF-8' };
  return { ok: true, content: toLf(content) };
}

async function readRemoteTouchedFile({ target, absolutePath }, deps = {}) {
  if (!target?.ok || target.kind !== 'remote' || !isValidAlias(target.alias)
      || !isRemoteTouchedPath(absolutePath) || !isRemoteTouchedPath(target.cwd)) {
    return { ok: false, reason: 'invalid-path', error: 'invalid remote path or target' };
  }
  if (isProtectedRemotePath(absolutePath)) return { ok: false, reason: 'refused', error: 'access to sensitive path denied' };
  const run = deps.runRemoteCommand || defaultRunRemoteCommand;
  const options = { timeoutMs: REMOTE_TOUCHED_TIMEOUT_MS, maxStdoutBytes: REMOTE_TOUCHED_READ_MAX_BYTES + 1, rawStdout: true };
  try {
    const current = checkedContent(await run(target.alias, shellCommand(READ_SCRIPT, [absolutePath]), options));
    if (!current.ok) return current;
    const plain = { ok: true, kind: 'remote', git: false, readOnly: true, original: current.content, current: current.content };
    const repo = await run(target.alias, buildRemoteGitCommand(target.cwd, buildGitArgs(['rev-parse', '--show-toplevel'])),
      { ...options, maxStdoutBytes: REMOTE_TOUCHED_STAT_MAX_BYTES });
    if (repo.code !== 0 || repo.timedOut) {
      if (repo.code !== -1 && repo.code !== 255 && !repo.timedOut) return plain;
      return readFailure(repo);
    }
    const root = String(repo.stdout || '').replace(/\r?\n$/, '');
    if (!isRemoteTouchedPath(root)) return { ok: false, reason: 'invalid-path', error: 'invalid remote repository root' };
    const rel = path.posix.relative(root, absolutePath);
    if (!rel || rel.startsWith('../') || !isSafeGitPath(rel)) return plain;
    const originalResult = await run(target.alias, buildRemoteGitCommand(root, buildGitArgs(['show', 'HEAD:' + rel])), options);
    if (originalResult.overflow) return checkedContent(originalResult);
    if (originalResult.code !== 0 || originalResult.timedOut) {
      if (originalResult.code === 128 && !originalResult.timedOut
          && /path .* does not exist in 'HEAD'|invalid object name 'HEAD'/i.test(originalResult.stderr || '')) {
        return { ...plain, git: true, original: '' };
      }
      if (originalResult.code !== -1 && originalResult.code !== 255 && !originalResult.timedOut) return plain;
      return readFailure(originalResult);
    }
    const original = checkedContent(originalResult);
    if (!original.ok) return original;
    return { ...plain, git: true, original: original.content };
  } catch {
    return readFailure({ code: -1 });
  }
}

module.exports = { isRemoteTouchedPath, inspectRemoteTouchedPaths, readRemoteTouchedFile, REMOTE_TOUCHED_READ_MAX_BYTES };
