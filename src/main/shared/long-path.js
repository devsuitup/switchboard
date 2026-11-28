'use strict';

// see .ai/contexts/session-cache.md ("Project Archive and Delete")
const fs = require('fs');
const path = require('path');

const formKey = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const shortCandidate = value => typeof value === 'string' && value.includes('~');

function* ancestry(value) {
  const rest = [];
  for (let dir = value; dir.includes('~'); ) {
    yield { dir, rest: [...rest] };
    const parent = path.win32.dirname(dir);
    if (parent === dir) return;
    rest.unshift(path.win32.basename(dir));
    dir = parent;
  }
}

function longFormSync(value, realpath) {
  for (const { dir, rest } of ancestry(value)) {
    try { return path.win32.join(realpath(dir), ...rest); } catch {}
  }
  return null;
}

async function longForm(value, realpath) {
  for (const { dir, rest } of ancestry(value)) {
    try { return path.win32.join(await realpath(dir), ...rest); } catch {}
  }
  return null;
}

function createLongPathResolver({ platform = process.platform, realpath = fs.realpathSync.native } = {}) {
  if (platform !== 'win32') return null;
  const cache = new Map();
  return value => {
    if (!shortCandidate(value)) return value;
    const key = formKey(value);
    if (!cache.has(key)) cache.set(key, longFormSync(value, realpath));
    return cache.get(key) ?? value;
  };
}

async function longPathForms(values, { platform = process.platform, realpath = fs.promises.realpath } = {}) {
  if (platform !== 'win32') return null;
  const pending = new Map();
  for (const value of values || []) if (shortCandidate(value) && !pending.has(formKey(value))) pending.set(formKey(value), value);
  const forms = {};
  await Promise.all([...pending].map(async ([key, value]) => {
    const long = await longForm(value, realpath);
    if (long !== null) forms[key] = long;
  }));
  return forms;
}

function pruneLongPathForms(forms, values) {
  if (!forms) return forms;
  const kept = {};
  for (const value of values || []) {
    if (!shortCandidate(value)) continue;
    const key = formKey(value);
    if (Object.hasOwn(forms, key)) kept[key] = forms[key];
  }
  return kept;
}

async function eachLimited(items, limit, run) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  }));
}

async function settleLongPathForms(readValues, { platform = process.platform, realpath = fs.promises.realpath, rounds = 3, concurrency = 4 } = {}) {
  if (platform !== 'win32') return null;
  const forms = {}, tries = new Map();
  for (let round = 0; round < rounds; round++) {
    const values = readValues() || [];
    const current = new Map();
    for (const value of values) if (shortCandidate(value) && !current.has(formKey(value))) current.set(formKey(value), value);
    const pending = [...current].filter(([key]) => !Object.hasOwn(forms, key) && (tries.get(key) || 0) < 2);
    if (!pending.length) return pruneLongPathForms(forms, values);
    await eachLimited(pending, concurrency, async ([key, value]) => {
      tries.set(key, (tries.get(key) || 0) + 1);
      const long = await longForm(value, realpath);
      if (long !== null) forms[key] = long;
    });
  }
  return pruneLongPathForms(forms, readValues() || []);
}

function longPathLookup(forms, fallback = null) {
  if (!forms && !fallback) return null;
  return value => {
    if (!shortCandidate(value)) return value;
    if (forms && Object.hasOwn(forms, formKey(value))) return forms[formKey(value)];
    return fallback ? fallback(value) : value;
  };
}

module.exports = { createLongPathResolver, longPathForms, settleLongPathForms, pruneLongPathForms, longPathLookup };
