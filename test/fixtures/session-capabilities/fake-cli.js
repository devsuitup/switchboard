'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const mutation = process.env.CANARY_FIXTURE_MUTATION || '';
if (args.includes('--version')) {
  process.stdout.write('fixture-1.0.0 build fixture-only\n');
  process.exit(0);
}
const home = process.env.HOME;
const state = path.join(home, '.claude');
const id = args.includes('--fork-session') && mutation !== 'omit-fork'
  ? crypto.randomUUID() : args.includes('--resume') ? value('--resume') : value('--session-id');
let cwd = process.cwd();
if (args.includes('--worktree') && mutation !== 'reuse-worktree') {
  const target = path.join(process.env.CANARY_FIXTURE_RUNTIME, 'worktrees', value('--worktree'));
  fs.mkdirSync(target, { recursive: true });
  const inventory = path.join(process.env.CANARY_FIXTURE_RUNTIME, 'worktree-inventory.json');
  fs.writeFileSync(inventory, JSON.stringify([...JSON.parse(fs.readFileSync(inventory, 'utf8')), target]));
  cwd = target;
}
const project = path.join(state, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(project, { recursive: true });
const transcript = path.join(project, `${id}.jsonl`);
function findTranscript(sid, dir = path.join(state, 'projects')) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === `${sid}.jsonl`) return p;
    if (e.isDirectory()) { const found = findTranscript(sid, p); if (found) return found; }
  }
  return null;
}
let inherited = '';
if (args.includes('--fork-session') && mutation !== 'omit-fork') {
  const source = findTranscript(value('--resume'));
  if (source) {
    let copied = fs.readFileSync(source, 'utf8');
    if (mutation === 'drop-sentinel') copied = copied.replace(/SENTINEL_[a-z0-9-]+/g, 'REMOVED');
    inherited = copied;
    fs.writeFileSync(transcript, JSON.stringify({ type: 'file-history-snapshot' }) + '\n');
    if (mutation === 'natural-source-activity') fs.appendFileSync(source, JSON.stringify({ type: 'file-history-snapshot' }) + '\n');
  }
}
const sessions = process.env.CANARY_FIXTURE_SESSIONS || path.join(state, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
const descriptor = path.join(sessions, `${process.pid}.json`);
const descriptorIndex = path.join(process.env.CANARY_FIXTURE_RUNTIME, 'descriptor-index');
fs.mkdirSync(descriptorIndex, { recursive: true });
fs.writeFileSync(path.join(descriptorIndex, `${id}.json`), JSON.stringify({ file: descriptor }));
const startedAt = Date.now();
let nativeName = `native-${id}`;
const messagingSocketPath = process.env.CANARY_FIXTURE_WINDOWS_MESSAGING
  ? `\\\\.\\pipe\\canary-message-${process.pid}` : `/tmp/cc-socks/${process.pid}.sock`;
function describe(status, waitingFor = 'trust') {
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, sessionId: id, cwd,
    messagingSocketPath,
    name: mutation === 'missing-name' ? undefined : mutation === 'stale-descriptor-name' ? `native-${id}` : nativeName, status,
    waitingFor: status === 'waiting' ? waitingFor : undefined, statusUpdatedAt: Date.now(), startedAt,
    procStart: process.env.CANARY_FIXTURE_PROC_START || String(startedAt), fixtureOnly: true,
    fixtureSocketDirectoryVisible: !(process.env.CANARY_FIXTURE_SANDBOX && mutation === 'sandbox-socket-unavailable'),
    fixtureEnvKeys: Object.keys(process.env) }));
  process.stdout.write(status === 'idle' ? '\x1b]9;4;0;\x07' : '\x1b]9;4;3;\x07');
}
function append(record, file = transcript) {
  fs.appendFileSync(file, JSON.stringify({ sessionId: id, cwd, uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(), ...record }) + '\n');
}
function tool(name, input, result, isError = false) {
  const toolId = crypto.randomUUID();
  append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name, input }] } });
  append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: mutation === 'unlinked-denial' && isError === true ? crypto.randomUUID() : toolId, content: result, ...(isError === null ? {} : { is_error: isError }) }] } });
}
let pendingAssistant = false;
function exitGracefully() {
  if (pendingAssistant) append({ type: 'user', message: { role: 'user', content: '<command-name>/exit</command-name>' } });
  if (pendingAssistant) append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture exit-flushed reaction' }] } });
  process.exit(0);
}
function handle(text) {
  if (mutation === 'raw-control-no-confirmation' && text.includes('\t')) { describe('waiting'); return; }
  if (mutation === 'hang') return;
  if (mutation === 'exit-on-submit') process.exit(0);
  if (mutation === 'blocking-dialog') { describe('waiting'); return; }
  describe('busy');
  if (inherited) { fs.writeFileSync(transcript, inherited); inherited = ''; }
  if (args.includes('--name') && mutation !== 'ignore-fork-name') {
    const source = args.includes('--resume') ? findTranscript(value('--resume')) : null;
    const rows = source ? fs.readFileSync(source, 'utf8').trim().split('\n').map(r => JSON.parse(r)) : [];
    const inheritedName = rows.filter(r => r.type === 'agent-name').at(-1)?.agentName;
    nativeName = mutation === 'colliding-fork-name' ? inheritedName : value('--name');
    append({ type: 'agent-name', agentName: nativeName });
    if (source && mutation === 'rename-fork-source') {
      append({ type: 'agent-name', agentName: nativeName }, source);
    }
  }
  if (text.startsWith('/rename ')) {
    append({ type: 'custom-title', customTitle: text.slice(8), sessionId: id });
    nativeName = text.slice(8);
    if (!['missing-name', 'descriptor-only-name'].includes(mutation)) append({ type: 'agent-name', agentName: nativeName });
    describe('idle');
    return;
  }
  let stored = mutation === 'drop-byte' ? text.slice(0, -1) : text;
  stored = stored.replaceAll('\t', '    ');
  let pasteRef;
  if (Buffer.byteLength(text) > 4096) {
    const cache = path.join(state, 'paste-cache');
    fs.mkdirSync(cache, { recursive: true });
    const cacheName = `${crypto.randomBytes(8).toString('hex')}.txt`;
    if (['missing-paste-object', 'placeholder-no-confirmation', 'storage-only'].includes(mutation)) pasteRef = cacheName;
    if (mutation !== 'missing-paste-object') fs.writeFileSync(path.join(cache, cacheName), stored);
  }
  if (mutation === 'placeholder-no-confirmation' || mutation === 'storage-only') stored = '[Pasted text #1]';
  if (mutation === 'no-paste-ref') pasteRef = undefined;
  if ((text.trimStart().startsWith('CANARY ') || text.startsWith('CANARY_META ')) && !['placeholder-no-confirmation', 'storage-only'].includes(mutation)) stored = `\n\n<pasted_content id="e7f5">\n${stored}\n</pasted_content id="e7f5">\n`;
  const user = { type: 'user', message: { role: 'user', content: stored }, ...(pasteRef ? { pasteRef } : {}) };
  if (mutation === 'split-paste') {
    for (const line of text.split('\n')) append({ type: 'user', message: { role: 'user', content: line } });
  } else append(user);
  if (mutation === 'meta-users') {
    append({ type: 'user', isMeta: true, message: { content: 'internal bookkeeping' } });
    append({ type: 'user', message: { content: '<local-command-caveat>local caveat</local-command-caveat>' } });
  }
  const match = /^CANARY_META (.+)\n/.exec(text);
  const meta = match ? JSON.parse(match[1]) : {};
  if (meta.kind === 'permissions') {
    const settings = JSON.parse(fs.readFileSync(value('--settings'), 'utf8'));
    const readPath = process.env.CANARY_FIXTURE_SANDBOX ? '/run/switchboard/launch-settings.json' : value('--settings');
    const rulePath = readPath.startsWith('/') ? `/${readPath}` : readPath;
    const readRules = settings.permissions.allow.map(rule => mutation === 'single-slash-read-rule' ? rule.replace(/^Read\(\/\//, 'Read(/') : rule);
    if (!readRules.includes(`Read(${rulePath})`) ||
        (process.env.CANARY_FIXTURE_SANDBOX && !settings.permissions.allow.includes(`Bash(${meta.protectionCommand})`))) {
      describe('waiting', 'permission'); return;
    }
    const settingsText = fs.readFileSync(value('--settings'), 'utf8');
    const renderedSettings = mutation === 'escaped-settings' ? settingsText.split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n') : settingsText;
    tool('Read', { file_path: readPath.replaceAll('\\', '/') }, [{ type: 'text', text: renderedSettings }]);
    const denied = settings.permissions.deny.length > 0 && mutation !== 'remove-deny';
    if (!denied || ['fake-denial', 'tool-stop-side-effect'].includes(mutation)) fs.writeFileSync(meta.deniedFile, 'side effect');
    const unknownDenial = mutation === 'unknown-denial' || mutation === 'sandbox-unknown-denial' && process.env.CANARY_FIXTURE_SANDBOX;
    const denialCommand = mutation === 'wrong-command-denial' ? meta.allowedCommand : meta.deniedCommand;
    tool('Bash', { command: meta.deniedCommand }, [{ type: 'text', text: denied ? unknownDenial ? 'Unrecognized fixture refusal. '.repeat(20) : mutation === 'os-denial' ? 'bash: Permission denied' : `Permission to use Bash with command ${denialCommand} has been denied.` : 'ok' }], mutation === 'denial-no-error-flag' ? null : denied);
    if (mutation === 'missing-allowed-tool') return;
    if (mutation !== 'premature-final') {
      fs.writeFileSync(meta.allowedFile, 'allowed');
      tool('Bash', { command: meta.allowedCommand }, '(Bash completed with no output)');
    }
    if (['tool-stop', 'tool-stop-idle', 'tool-stop-waiting', 'tool-stop-side-effect'].includes(mutation)) {
      if (mutation === 'tool-stop-idle') describe('idle');
      if (mutation === 'tool-stop-waiting') describe('waiting');
      return;
    }
    if (!text.includes('After all required tool calls, reply exactly ' + meta.finalReply)) return;
    if (process.env.CANARY_FIXTURE_SANDBOX) {
      if (mutation === 'writable-settings') fs.writeFileSync(value('--settings'), '{}');
      tool('Bash', { command: meta.protectionCommand }, mutation === 'writable-settings' ? 'ok' : 'Read-only file system', mutation !== 'writable-settings');
    }
  }
  if (meta.kind === 'report' && mutation !== 'no-report') {
    const sendReport = () => {
      const recipient = mutation === 'stale-recipient' ? `native-${meta.orchestrator}`
        : mutation === 'wrong-recipient' && !meta.wrongRecipientControl ? 'unknown-native-recipient' : meta.recipient;
      const reference = path.join(descriptorIndex, `${meta.orchestrator}.json`);
      const peerFile = fs.existsSync(reference) ? JSON.parse(fs.readFileSync(reference, 'utf8')).file : null;
      const peer = peerFile && fs.existsSync(peerFile) ? JSON.parse(fs.readFileSync(peerFile, 'utf8')) : null;
      const dest = findTranscript(meta.orchestrator);
      const peerRows = dest ? fs.readFileSync(dest, 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [];
      const reachable = peer?.sessionId === meta.orchestrator &&
        (peerRows.filter(r => r.type === 'agent-name').at(-1)?.agentName || peer.name) === recipient;
      tool('ToolSearch', { query: 'select:SendMessage' }, 'SendMessage');
      const input = { to: recipient, message: meta.nonce, summary: 'Report canary nonce to orchestrator' };
      const socketUnavailable = process.env.CANARY_FIXTURE_SANDBOX && mutation === 'sandbox-socket-unavailable';
      const sandboxUnreachable = process.env.CANARY_FIXTURE_SANDBOX && mutation === 'sandbox-unreachable';
      const result = socketUnavailable
        ? { success: false, message: 'connect ENOENT /tmp/cc-socks/orchestrator.sock' }
        : reachable && !sandboxUnreachable && mutation !== 'send-failed'
        ? { success: true, message: `“Report canary nonce to orchestrator” → ${recipient} (another Claude session on this machine; in that session's inbox)` }
        : { success: false, message: `No agent named '${recipient}' is reachable.\nUse ListAgents to see everyone you can message.${mutation === 'send-failed' ? ' fixture detail'.repeat(40) : ''}` };
      tool('SendMessage', input, [{ type: 'text', text: JSON.stringify(result) }]);
      if ((result.success && !meta.wrongRecipientControl) || (meta.wrongRecipientControl && ['wrong-control-leak', 'wrong-control-hidden-leak'].includes(mutation))) {
        if (dest) {
          const deliver = () => {
            append({ type: 'queue-operation' }, dest);
            append({ type: 'queue-operation' }, dest);
            const sender = mutation === 'receipt-wrong-sender' ? 'another-child' : nativeName;
            const body = mutation === 'receipt-extra-body' ? meta.nonce + ' extra' : meta.nonce;
            const from = mutation === 'receipt-wrong-scheme' ? `tcp:${messagingSocketPath}`
              : `${process.env.CANARY_FIXTURE_WINDOWS_MESSAGING ? 'pipe:' : 'uds:'}${messagingSocketPath}`;
            const envelope = mutation === 'receipt-teammate' ? `<teammate-message teammate_id="${sender}">\n${body}\n</teammate-message>`
              : `<cross-session-message from="${from}" from-name="${sender}" from-mode="prompting">\n${body}\n</cross-session-message>`;
            append({ type: mutation === 'receipt-wrong-type' ? 'assistant' : mutation === 'unknown-receipt' ? 'unknown-message' : 'user',
              ...(meta.wrongRecipientControl && mutation === 'wrong-control-hidden-leak'
                ? { data: { receiptNonce: meta.nonce } } : { message: { role: 'user', content: mutation === 'synthetic-receipt' ? meta.nonce
                  : `Another Claude session sent a message:\n${envelope}\n\nThis came from another Claude session — not typed by your user.` } }) }, dest);
          };
          if (mutation === 'receipt-delayed') setTimeout(deliver, 80);
          else deliver();
        }
      }
    };
    if (meta.renameAfterPrompt) setTimeout(sendReport, 200);
    else if (mutation === 'send-observation-delayed') setTimeout(sendReport, 750);
    else sendReport();
    return;
  }
  if (mutation === 'own-title' && args.includes('--fork-session')) append({ type: 'custom-title', customTitle: 'own-title-different-from-L' });
  if (mutation === 'exit-flush-assistant') pendingAssistant = true;
  else if (mutation !== 'placeholder-no-confirmation') append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: meta.finalReply || 'fixture reaction' }] } });
  describe('idle');
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', chunk => {
  if (chunk === '/exit\r' || chunk === '/exit\n') exitGracefully();
  if (chunk.includes(`\x1b]CANARY_EXIT;${process.pid}\x07`)) process.exit(0);
  input += chunk;
  for (;;) {
    const start = input.indexOf('\x1b[200~');
    const end = input.indexOf('\x1b[201~\r', start + 6);
    if (start < 0 || end < 0) break;
    const text = input.slice(start + 6, end);
    input = input.slice(end + 7);
    handle(text);
  }
});
if (mutation === 'rename-during-child-launch') {
  for (const file of fs.readdirSync(path.join(state, 'sessions')).filter(x => x.endsWith('.json'))) {
    const peerPath = path.join(state, 'sessions', file);
    const peer = JSON.parse(fs.readFileSync(peerPath, 'utf8'));
    if (!peer.name?.startsWith('UI-')) continue;
    peer.name += '-latest';
    fs.writeFileSync(peerPath, JSON.stringify(peer));
    const dest = findTranscript(peer.sessionId);
    append({ type: 'custom-title', customTitle: peer.name, sessionId: peer.sessionId }, dest);
    append({ type: 'agent-name', agentName: peer.name, sessionId: peer.sessionId }, dest);
  }
}
describe('idle');
process.stdout.write('fixture ready\n');
