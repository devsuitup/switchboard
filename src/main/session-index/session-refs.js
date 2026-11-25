'use strict';

// see docs/decisions/0006-search-refs.md

const REFS_MAX_CHARS = 4096;
const SEARCH_BODY_MAX_CHARS = 32768;
const REFS_MARKER = '\n[refs] ';

const REF_RE = /https?:\/\/(?:www\.)?(github\.com|gitlab\.[a-z0-9.-]+)\/([\w.-]+(?:\/[\w.-]+)*?)\/(?:-\/)?(pull|pulls|issues|merge_requests)\/(\d{1,7})|(?<![\w&#!/])([#!])(\d{2,6})(?![\w])|\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

function addRef(refs, ref) {
  refs.delete(ref);
  refs.add(ref);
}

function collectRefs(text, refs, exclude) {
  if (typeof text !== 'string' || !text) return refs;
  REF_RE.lastIndex = 0;
  let match;
  while ((match = REF_RE.exec(text))) {
    if (match[4]) {
      const sign = match[3].toLowerCase() === 'merge_requests' ? '!' : '#';
      addRef(refs, sign + match[4]);
      addRef(refs, match[2].toLowerCase() + sign + match[4]);
    } else if (match[6]) {
      addRef(refs, match[5] + match[6]);
    } else if (match[7]) {
      const uuid = match[7].toLowerCase();
      if (uuid !== exclude) addRef(refs, uuid);
    }
  }
  return refs;
}

function entryTexts(entry) {
  const msg = entry && entry.message;
  const content = typeof msg === 'string' ? msg : msg && msg.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const texts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') texts.push(block.text);
    if (block.type === 'tool_use' && block.input !== undefined) texts.push(JSON.stringify(block.input));
    if (block.type === 'tool_result') {
      if (typeof block.content === 'string') texts.push(block.content);
      else if (Array.isArray(block.content)) for (const part of block.content) if (typeof part?.text === 'string') texts.push(part.text);
    }
  }
  return texts;
}

function collectEntryRefs(entry, refs, exclude) {
  for (const text of entryTexts(entry)) collectRefs(text, refs, exclude);
  return refs;
}

function newestFirst(refs) {
  const list = [...refs].reverse();
  const kept = [];
  let size = 0;
  for (const ref of list) {
    if (size + ref.length + 1 > REFS_MAX_CHARS) break;
    kept.push(ref);
    size += ref.length + 1;
  }
  return kept;
}

function splitSearchBody(body) {
  const text = typeof body === 'string' ? body : '';
  const at = text.lastIndexOf(REFS_MARKER);
  if (at < 0) return { text, refs: [] };
  return { text: text.slice(0, at), refs: text.slice(at + REFS_MARKER.length).split(' ').filter(Boolean) };
}

function searchBody(text, refs) {
  const list = Array.isArray(refs) ? refs : [];
  const section = list.length ? REFS_MARKER + list.join(' ') : '';
  return String(text || '').slice(0, SEARCH_BODY_MAX_CHARS - section.length) + section;
}

function mergeRefLists(newer, older) {
  const refs = new Set();
  for (const ref of [...older].reverse()) addRef(refs, ref);
  for (const ref of [...newer].reverse()) addRef(refs, ref);
  return newestFirst(refs);
}

function mergeSearchBodyRefs(body, newer) {
  const { text, refs } = splitSearchBody(body);
  return searchBody(text, mergeRefLists(newer, refs));
}

module.exports = { REFS_MAX_CHARS, SEARCH_BODY_MAX_CHARS, REFS_MARKER, collectRefs, collectEntryRefs, newestFirst, splitSearchBody, searchBody, mergeRefLists, mergeSearchBodyRefs };
