'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codexPath = path.join(__dirname, '../harnesses/codex.js');

function rollout({ cwd, turns, meta, model }) {
  const lines = [
    { timestamp: '2026-08-26T10:00:00.000Z', type: 'session_meta',
      payload: { session_id: 'lineage-root', id: 'lineage-root', cwd, cli_version: '0.149.1', ...meta } },
    { timestamp: '2026-08-26T10:00:00.100Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: '2026-08-26T10:00:00.200Z', type: 'turn_context', payload: { turn_id: 't1', cwd, model: model || 'gpt-6', effort: 'high' } },
    { timestamp: '2026-08-26T10:00:01.000Z', type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'text', text: '<skills_instructions>…' }] } },
    { timestamp: '2026-08-26T10:00:01.100Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: '<environment_context>\n  <cwd>' + cwd + '</cwd>\n</environment_context>' }] } },
  ];
  let t = 2;
  for (const [role, text] of turns) {
    lines.push({ timestamp: `2026-08-26T10:00:${String(t++).padStart(2, '0')}.000Z`,
      type: 'response_item', payload: { type: 'message', role, content: [{ type: 'text', text }] } });
    lines.push({ timestamp: `2026-08-26T10:00:${String(t++).padStart(2, '0')}.000Z`,
      type: 'event_msg', payload: { type: role === 'user' ? 'user_message' : 'agent_message', message: text } });
  }
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

function withFixture(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fixture-'));
  try {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, 'utf8');
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withCodexHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try { return fn(home); } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const ID = '01a03f6c-fdf9-7c83-86e3-c388f81d765c';
const NAME = `rollout-2026-08-26T11-55-02-${ID}.jsonl`;

test('the Codex adapter exists and is registered under its own runtime', () => {
  assert.ok(fs.existsSync(codexPath), 'harnesses/codex.js must exist');
  const codex = require('../harnesses/codex');
  const { HARNESSES, getHarness, harnessForFolder } = require('../harnesses');
  assert.equal(HARNESSES.codex, codex);
  assert.equal(getHarness('codex'), codex);
  assert.equal(harnessForFolder('codex/2026/08/26'), codex);
  assert.equal(codex.id, 'codex');
  assert.equal(codex.label, 'Codex');
  assert.equal(codex.binary, 'codex');
  assert.equal(codex.folderPrefix, 'codex/');
  assert.equal(codex.groupsByProject, false);
  assert.equal(codex.capabilities.subagents, false);
  assert.equal(codex.capabilities.continuations, false);
  assert.equal(codex.capabilities.deleteTranscript, false);
  assert.equal(require('../harnesses/claude').capabilities.deleteTranscript, true);
});

test('parses a rollout into the shape the cache expects', () => {
  const codex = require('../harnesses/codex');
  withFixture({ [NAME]: rollout({ cwd: '/Users/me/proj',
    turns: [['user', 'fix the parser'], ['assistant', 'done'], ['user', 'thanks']] }) }, dir => {
    const s = codex.readSessionFile(path.join(dir, NAME), 'codex/2026/08/26');
    assert.equal(s.sessionId, ID);
    assert.equal(s.projectPath, '/Users/me/proj');
    assert.equal(s.runtime, 'codex');
    assert.equal(s.summary, 'fix the parser');
    assert.equal(s.sessionFile, path.join(dir, NAME));
    assert.equal(s.folder, 'codex/2026/08/26');
    assert.equal(s.messageCount, 3);
    assert.ok(s.textContent.includes('fix the parser'));
    assert.ok(!s.textContent.includes('skills_instructions'));
    assert.equal(s.customTitle, '', 'a known-empty title keeps the Claude title backfill away from the rollout');
    assert.equal(s.entrypoint, '', 'a known-empty entrypoint keeps the SDK backfill away from the rollout');
    assert.equal(typeof s.fileSize, 'number');
  });
});

test('the session id comes from the file name, not session_meta', () => {
  const codex = require('../harnesses/codex');
  withFixture({ [NAME]: rollout({ cwd: '/p', turns: [['user', 'hi']] }) }, dir => {
    const s = codex.readSessionFile(path.join(dir, NAME), 'f');
    assert.equal(s.sessionId, ID);
    assert.notEqual(s.sessionId, 'lineage-root');
  });
});

test('injected user turns never become the summary', () => {
  const codex = require('../harnesses/codex');
  const injected = ['<environment_context>\nnoise\n</environment_context>', '<recommended_plugins>x</recommended_plugins>',
    '<turn_aborted>y</turn_aborted>', '<transcript>z</transcript>',
    '# AGENTS.md instructions for C:\\Serveur\\project\n\n<INSTRUCTIONS>\nread me\n</INSTRUCTIONS>'];
  for (const text of injected) {
    withFixture({ [NAME]: rollout({ cwd: '/p', turns: [['user', text], ['user', 'the real question']] }) }, dir => {
      const s = codex.readSessionFile(path.join(dir, NAME), 'f');
      assert.equal(s.summary, 'the real question', text.slice(0, 20));
      assert.equal(s.messageCount, 1, text.slice(0, 20));
    });
  }
});

test('a session with no user turn and a subagent rollout are skipped', () => {
  const codex = require('../harnesses/codex');
  withFixture({ [NAME]: rollout({ cwd: '/p', turns: [] }) }, dir => {
    assert.equal(codex.readSessionFile(path.join(dir, NAME), 'f'), null);
  });
  for (const meta of [{ thread_source: 'subagent' }, { parent_thread_id: 'parent' }, { agent_path: '/root/x' }, { agent_nickname: 'x' }]) {
    withFixture({ [NAME]: rollout({ cwd: '/p', turns: [['user', 'hi']], meta }) }, dir => {
      assert.equal(codex.readSessionFile(path.join(dir, NAME), 'f'), null, JSON.stringify(meta));
    });
  }
  assert.equal(codex.isSubagentMeta({ thread_source: 'user' }), false);
});

test('large tool output is streamed and a final Unicode turn needs no newline', () => {
  const codex = require('../harnesses/codex');
  const body = rollout({ cwd: '/p', turns: [['user', 'first']] })
    + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'discard this tool output '.repeat(50000) } }) + '\n'
    + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Finished 🦒 '.repeat(30000) }] } });
  withFixture({ [NAME]: body }, dir => {
    const original = fs.readFileSync;
    fs.readFileSync = file => {
      if (file === path.join(dir, NAME)) throw new Error('whole-file allocation');
      return original(file);
    };
    try {
      const session = codex.readSessionFile(path.join(dir, NAME), 'f');
      assert.equal(session.messageCount, 2);
      assert.equal(session.textContent, 'first\n' + 'Finished 🦒 '.repeat(30000));
    } finally { fs.readFileSync = original; }
  });
});

test('a rollout with no cwd is skipped and a corrupt line does not lose the rest', () => {
  const codex = require('../harnesses/codex');
  const noCwd = JSON.stringify({ timestamp: '2026-08-26T10:00:00Z', type: 'session_meta', payload: { session_id: 'x' } }) + '\n'
    + JSON.stringify({ timestamp: '2026-08-26T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n';
  withFixture({ [NAME]: noCwd }, dir => assert.equal(codex.readSessionFile(path.join(dir, NAME), 'f'), null));
  const good = rollout({ cwd: '/p', turns: [['user', 'first'], ['assistant', 'ok']] });
  withFixture({ [NAME]: good.trimEnd() + '\n{"type":"response_item","payload":{"type":"mess\n' }, dir => {
    const s = codex.readSessionFile(path.join(dir, NAME), 'f');
    assert.equal(s.summary, 'first');
    assert.equal(s.messageCount, 2);
  });
});

test('created and modified come from conversation records, not the file or settings', () => {
  const codex = require('../harnesses/codex');
  withFixture({ [NAME]: rollout({ cwd: '/p', turns: [['user', 'hello'], ['assistant', 'done']] }) }, dir => {
    const file = path.join(dir, NAME);
    const before = codex.readSessionFile(file, 'f');
    assert.equal(before.created, '2026-08-26T10:00:00.000Z');
    assert.ok(before.modified > before.created);
    assert.ok(before.fileMtime);
    const timestamp = '2026-09-19T16:32:46.980Z';
    for (const record of [
      { type: 'event_msg', payload: { type: 'thread_settings_applied' } },
      { type: 'token_usage_record', payload: {} },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: 'Settings' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: '<environment_context>Updated</environment_context>' } },
    ]) {
      fs.appendFileSync(file, JSON.stringify({ timestamp, ...record }) + '\n');
      const after = codex.readSessionFile(file, 'f');
      assert.equal(after.modified, before.modified);
      assert.equal(after.messageCount, before.messageCount);
    }
    fs.appendFileSync(file, JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: 'A real follow-up' } }) + '\n');
    assert.equal(codex.readSessionFile(file, 'f').modified, timestamp);
  });
});

test('daily metrics come from turn_context models and token_usage_record usage', () => {
  const codex = require('../harnesses/codex');
  const body = rollout({ cwd: '/p', turns: [['user', 'q'], ['assistant', 'a']], model: 'gpt-6' })
    + JSON.stringify({ timestamp: '2026-08-26T10:00:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'ls' } }) + '\n'
    + JSON.stringify({ timestamp: '2026-08-26T10:00:06.000Z', type: 'token_usage_record', payload: { usage: {
      input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 7, reasoning_output_tokens: 2, total_tokens: 107 } } }) + '\n'
    + JSON.stringify({ timestamp: '2026-08-27T10:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-6-mini' } }) + '\n'
    + JSON.stringify({ timestamp: '2026-08-27T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'later' }] } }) + '\n'
    + JSON.stringify({ timestamp: '2026-08-27T10:00:02.000Z', type: 'token_usage_record', payload: { usage: { input_tokens: 5, output_tokens: 3 } } }) + '\n';
  withFixture({ [NAME]: body }, dir => {
    const s = codex.readSessionFile(path.join(dir, NAME), 'f');
    assert.deepEqual(s.dailyMetrics, [
      { date: '2026-08-26', model: 'gpt-6', messageCount: 2, toolCallCount: 1, inputTokens: 100, outputTokens: 7, cacheReadTokens: 40, cacheCreationTokens: 10 },
      { date: '2026-08-27', model: 'gpt-6-mini', messageCount: 1, toolCallCount: 0, inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]);
  });
});

test('only rollout files are listed, ids are read without opening them, and sessionFile is the only way back', () => {
  const codex = require('../harnesses/codex');
  withFixture({ [NAME]: 'ignored', 'notes.jsonl': 'ignored', 'rollout-broken.jsonl': 'ignored' }, dir => {
    const found = codex.listTranscripts(dir);
    assert.deepEqual(found.map(f => path.basename(f)), [NAME]);
    assert.equal(codex.sessionIdFromPath(found[0]), ID);
    assert.equal(codex.sessionIdFromPath('/x/notes.jsonl'), null);
  });
  assert.equal(codex.transcriptPath({ sessionId: ID, sessionFile: '/a/b.jsonl' }), '/a/b.jsonl');
  assert.equal(codex.transcriptPath({ sessionId: ID }), null);
  assert.equal(codex.deriveProjectPath('/anything'), null);
  assert.equal(codex.folderForProject('/anything'), null);
});

test('folder keys are date paths under the codex prefix and malformed keys resolve nowhere', () => {
  const codex = require('../harnesses/codex');
  withCodexHome(home => {
    const sessions = path.join(home, 'sessions');
    assert.equal(codex.available(), false);
    fs.mkdirSync(path.join(sessions, '2026', '08', '26'), { recursive: true });
    fs.mkdirSync(path.join(sessions, '2026', '09', '01'), { recursive: true });
    fs.mkdirSync(path.join(sessions, 'junk', '08', '26'), { recursive: true });
    fs.mkdirSync(path.join(sessions, '2026', 'x', '26'), { recursive: true });
    assert.equal(codex.available(), true);
    assert.equal(codex.sessionsRoot(), sessions);
    assert.deepEqual(codex.listFolders().sort(), ['codex/2026/08/26', 'codex/2026/09/01']);
    assert.equal(codex.folderPath('2026/08/26'), path.join(sessions, '2026', '08', '26'));
    assert.equal(codex.folderPath('codex/2026/08/26'), path.join(sessions, '2026', '08', '26'));
    for (const bad of ['../2026/08/26', '2026/../../etc', '2026\\08\\26', '2026/08', 'codex/2026/08/26/x', '', null]) {
      assert.equal(codex.folderPath(bad), null, String(bad));
    }
  });
});

test('thread names come from session_index.jsonl, newest record first, a cleared name wins', () => {
  const codex = require('../harnesses/codex');
  withCodexHome(home => {
    assert.deepEqual([...codex.readSessionTitles()], [], 'a missing index is an empty state');
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), [
      JSON.stringify({ id: 'a', thread_name: 'first name', updated_at: '2026-09-07T08:10:17Z' }),
      JSON.stringify({ id: 'a', thread_name: 'renamed', updated_at: '2026-09-07T08:47:07Z' }),
      JSON.stringify({ id: 'b', thread_name: 'kept', updated_at: '2026-09-07T08:47:07Z' }),
      JSON.stringify({ id: 'b', thread_name: '   ', updated_at: '2026-09-08T08:47:07Z' }),
      'not json', JSON.stringify({ id: 7, thread_name: 'bad id' }),
    ].join('\n') + '\n');
    const titles = codex.readSessionTitles();
    assert.equal(titles.get('a'), 'renamed');
    assert.equal(titles.get('b'), null);
    assert.equal(titles.has('7'), false);
    assert.equal(codex.titleIndexPath(), path.join(home, 'session_index.jsonl'));
    fs.mkdirSync(path.join(home, 'sessions', '2026', '08', '26'), { recursive: true });
    fs.writeFileSync(path.join(home, 'sessions', '2026', '08', '26', NAME), rollout({ cwd: '/p', turns: [['user', 'hello']] }));
    fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: ID, thread_name: 'Parser work' }) + '\n');
    const s = codex.readSessionFile(path.join(home, 'sessions', '2026', '08', '26', NAME), 'codex/2026/08/26');
    assert.equal(s.aiTitle, 'Parser work', 'the thread name is the AI title so a Switchboard rename still wins');
  });
});

test('viewer entries map codex records onto the transcript shape the viewer renders', () => {
  const codex = require('../harnesses/codex');
  const entries = [
    { type: 'session_meta', payload: { cwd: '/p' } },
    { type: 'response_item', timestamp: 't1', payload: { type: 'message', role: 'developer', content: [{ type: 'text', text: 'scaffold' }] } },
    { type: 'response_item', timestamp: 't2', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    { type: 'response_item', timestamp: 't3', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] } },
    { type: 'response_item', timestamp: 't4', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking about it' }], encrypted_content: 'x' } },
    { type: 'response_item', timestamp: 't5', payload: { type: 'reasoning', summary: [], encrypted_content: 'x' } },
    { type: 'response_item', timestamp: 't6', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'ls' } },
    { type: 'response_item', timestamp: 't7', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'a.txt' } },
    { type: 'response_item', timestamp: 't8', payload: { type: 'function_call', call_id: 'c2', name: 'apply_patch', arguments: '{"x":1}' } },
    { type: 'response_item', timestamp: 't9', payload: { type: 'function_call_output', call_id: 'c2', output: [{ type: 'output_text', text: 'ok' }] } },
    { type: 'response_item', timestamp: 't10', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
  ];
  const out = codex.toViewerEntries(entries);
  assert.deepEqual(out.map(e => [e.type, e.timestamp, e.message.content[0].type]), [
    ['user', 't3', 'text'], ['assistant', 't4', 'thinking'], ['assistant', 't6', 'tool_use'], ['user', 't7', 'tool_result'],
    ['assistant', 't8', 'tool_use'], ['user', 't9', 'tool_result'], ['assistant', 't10', 'text'],
  ]);
  assert.equal(out[2].message.content[0].id, 'c1');
  assert.equal(out[3].message.content[0].tool_use_id, 'c1');
  assert.equal(out[3].message.content[0].content, 'a.txt');
  assert.equal(out[4].message.content[0].input, '{"x":1}');
  assert.equal(out[5].message.content[0].content, 'ok');
  assert.equal(codex.toViewerEntry(entries[1]), null);
  assert.deepEqual(codex.toViewerEntry(entries[3]), out[0]);
  const claude = require('../harnesses/claude');
  assert.equal(claude.toViewerEntries(entries), entries);
  assert.equal(claude.toViewerEntry(entries[0]), entries[0]);
});

test('CODEX_HOME relocates the sessions root', () => {
  const codex = require('../harnesses/codex');
  withCodexHome(home => assert.equal(codex.sessionsRoot(), path.join(home, 'sessions')));
});
