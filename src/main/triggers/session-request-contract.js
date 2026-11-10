'use strict';

const { TextDecoder } = require('node:util');
const path = require('node:path');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;

function strictJson(bytes, onRootKey) {
  let text;
  try { text = onRootKey ? bytes.toString('utf8') : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('trigger is not valid UTF-8'); }
  let at = 0;
  const space = () => { while (/\s/.test(text[at] || '') && at < text.length) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '\\') at++;
      else if (c === '"') return JSON.parse(text.slice(start, at));
    }
    throw new Error('unterminated string');
  }
  function value(depth = 0, field = '') {
    if (depth > 64) throw new Error('request nesting too deep');
    space();
    if (text[at] === '"') { string(); return; }
    if (text[at] === '{' || text[at] === '[') {
      const object = text[at++] === '{', end = object ? '}' : ']', keys = new Set();
      space();
      if (text[at] === end) { at++; return; }
      for (;;) {
        space();
        if (object) {
          if (text[at] !== '"') throw new Error('invalid object key');
          const key = string();
          if (depth === 0) onRootKey?.(key);
          if (!onRootKey && keys.has(key)) throw new Error('duplicate field: ' + (field ? field + '.' : '') + key);
          if (!onRootKey && ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('unknown field: ' + (field ? field + '.' : '') + key);
          keys.add(key); space();
          if (text[at++] !== ':') throw new Error('invalid object separator');
          value(depth + 1, (field ? field + '.' : '') + key);
        } else {
          value(depth + 1, field);
        }
        space();
        const separator = text[at++];
        if (separator === end) return;
        if (separator !== ',') throw new Error('invalid separator');
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!token) throw new Error('invalid JSON value');
    at += token[0].length;
  }
  value(); space();
  if (at !== text.length) throw new Error('trailing JSON data');
  return JSON.parse(text);
}

function hasTypedPrefix(bytes) {
  if (!bytes) return false;
  const found = Symbol('typed request');
  try { strictJson(bytes, key => { if (key === 'type') throw found; }); }
  catch (error) { return error === found; }
  return false;
}

function parseSessionRequest(bytes, stem) {
  let request = null, reason = null, valid = false;
  try {
    if (!bytes || bytes.length > 65536) throw new Error('trigger too large (max 64 KB)');
    request = strictJson(bytes);
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('trigger must be an object');
    if (!['session-status', 'open-session'].includes(request.type)) throw new Error('unsupported trigger type');
    if (request.version !== 1) throw new Error('unsupported trigger version');
    const required = (field, predicate) => {
      if (!Object.hasOwn(request, field)) throw new Error('missing required field: ' + field);
      if (!predicate(request[field])) throw new Error('invalid field: ' + field);
    };
    required('requestId', id);
    if (!id(stem) || id(stem) !== id(request.requestId)) throw new Error('requestId must match trigger filename');
    if (Object.hasOwn(request, 'action')) throw new Error('incompatible field: action');
    let allowed = ['version', 'type', 'requestId', 'from', 'sessionId'];
    if (request.type === 'session-status') {
      required('from', id); required('sessionId', id);
    } else {
      allowed = ['version', 'type', 'requestId', 'kind', 'cli', 'from', 'project', 'prompt', 'title',
        'worktree', 'sandbox', 'worktreeName', 'permissionMode', 'settings', 'forkFrom'];
      required('kind', value => ['child', 'side-quest'].includes(value));
      if (Object.hasOwn(request, 'cli') && request.cli !== 'claude') throw new Error('invalid field: cli');
      required('from', id);
      required('project', value => typeof value === 'string' && path.isAbsolute(value) && Buffer.byteLength(value) <= 4096 && !/[\0\r\n]/.test(value));
      required('prompt', value => typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= 32768
        && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value) && !value.trimStart().startsWith('/'));
      for (const field of ['worktree', 'sandbox']) if (Object.hasOwn(request, field) && typeof request[field] !== 'boolean') throw new Error('invalid field: ' + field);
      if (Object.hasOwn(request, 'title') && (typeof request.title !== 'string' || !request.title.trim()
        || Buffer.byteLength(request.title.trim()) > 200 || /[\x00-\x1f\x7f]/.test(request.title))) throw new Error('invalid field: title');
      if (Object.hasOwn(request, 'worktreeName') && (typeof request.worktreeName !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.worktreeName))) throw new Error('invalid field: worktreeName');
      if (request.worktree === false && Object.hasOwn(request, 'worktreeName')) throw new Error('incompatible field: worktreeName');
      if (Object.hasOwn(request, 'permissionMode') && !['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'].includes(request.permissionMode)) throw new Error('invalid field: permissionMode');
      if (Object.hasOwn(request, 'forkFrom') && (request.kind === 'child' || !id(request.forkFrom))) throw new Error(request.kind === 'child' ? 'incompatible field: forkFrom' : 'invalid field: forkFrom');
      if (Object.hasOwn(request, 'settings')) {
        const settings = request.settings, object = value => value && typeof value === 'object' && !Array.isArray(value);
        if (!object(settings) || !object(settings.permissions)) throw new Error('invalid field: settings.permissions');
        const unknown = [...Object.keys(settings).filter(k => k !== 'permissions').map(k => 'settings.' + k),
          ...Object.keys(settings.permissions).filter(k => !['allow', 'deny'].includes(k)).map(k => 'settings.permissions.' + k)].sort()[0];
        if (unknown) throw new Error('unknown field: ' + unknown);
        let size = 0;
        for (const field of ['allow', 'deny']) if (Object.hasOwn(settings.permissions, field)) {
          const rules = settings.permissions[field];
          if (!Array.isArray(rules) || rules.length > 64 || rules.some(rule => typeof rule !== 'string' || !rule.trim()
            || Buffer.byteLength(rule) > 512 || /[\x00-\x1f\x7f]/.test(rule))) throw new Error('invalid field: settings.permissions.' + field);
          size += rules.reduce((sum, rule) => sum + Buffer.byteLength(rule), 0);
        }
        if (size > 16384 || Buffer.byteLength(JSON.stringify(settings)) > 20480) throw new Error('invalid field: settings');
      }
    }
    const extra = Object.keys(request).filter(key => !allowed.includes(key)).sort()[0];
    if (extra) throw new Error('unknown field: ' + extra);
    request = { ...request, requestId: id(request.requestId), from: id(request.from),
      ...(request.type === 'session-status' ? { sessionId: id(request.sessionId) }
        : request.forkFrom ? { forkFrom: id(request.forkFrom) } : {}) };
    valid = true;
    if (request.type === 'open-session') reason = 'unsupported trigger type';
  } catch (error) {
    reason = /^(?:trigger |unsupported |missing required field:|invalid field:|duplicate field:|requestId |incompatible field:|unknown field:)/.test(error.message)
      ? error.message : 'invalid JSON';
  }
  return { request, reason, valid, family: request?.type === 'open-session' ? 'open-session' : 'session-status' };
}

function statusEnvelope(request, now = Date.now()) {
  return { version: 1, type: request?.type === 'session-status' ? 'session-status' : null,
    requestId: id(request?.requestId), ok: false, error: 'invalid request', reason: null, submitted: 'no',
    requestedSessionId: id(request?.sessionId), sessionId: null, state: 'unknown', detail: 'no-live-proof',
    liveness: 'unknown', headTurn: 'unknown', descriptorStatus: null, evidence: 'none',
    observed_at: new Date(now).toISOString(), evidence_at: null, pid: null, jobId: null };
}
function openRefusal(request, reason, now = Date.now()) {
  return { version: 1, type: 'open-session', requestId: id(request?.requestId),
    kind: ['child', 'side-quest'].includes(request?.kind) ? request.kind : null,
    ok: false, error: 'invalid request', reason, phase: 'validation', sessionId: null,
    provisionalSessionId: null, pid: null, from: id(request?.from), spawnedBy: null, forkedFrom: null,
    submitted: 'no', text_written: false, enter_written: false,
    created_at: new Date(now).toISOString(), completed_at: new Date(now).toISOString() };
}
module.exports = { parseSessionRequest, hasTypedPrefix, statusEnvelope, openRefusal };
