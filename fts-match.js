'use strict';

// see .ai/contexts/session-cache.md ("Search")

const FTS_QUERY_MAX_CHARS = 48;
const FTS_MIN_TERM_CHARS = 3;

function searchTerms(query) {
  return String(query || '').slice(0, FTS_QUERY_MAX_CHARS).split(/\s+/)
    .map(term => term.replace(/^[#!]+/, ''))
    .filter(term => [...term].length >= FTS_MIN_TERM_CHARS);
}

function buildFtsMatch(query, titleOnly) {
  const terms = searchTerms(query).map(term => '"' + term.replace(/"/g, '""') + '"');
  if (!terms.length) return null;
  const expression = terms.join(' AND ');
  if (!titleOnly) return expression;
  return terms.length === 1 ? 'title:' + expression : 'title:(' + expression + ')';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_PREFIX_RE = /^[0-9a-f][0-9a-f-]{5,35}$/;

function idLookupTerm(query) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw || /\s/.test(raw) || raw.length > 128) return null;
  if (raw.startsWith('sub:') && raw.length > 4) return { sessionPrefix: raw, agentPrefix: null };
  const id = raw.replace(/^agent-/, '');
  if (UUID_RE.test(id)) return { sessionPrefix: id, agentPrefix: id };
  if (!ID_PREFIX_RE.test(id) || id.replace(/-/g, '').length < 6 || !/\d/.test(id)) return null;
  return { sessionPrefix: id, agentPrefix: id };
}

function createSessionSearch(db) {
  const ftsQuery = db.prepare(`
    SELECT search_map.id, snippet(search_fts, -1, '<mark>', '</mark>', '...', 24) as snippet
    FROM search_fts
    JOIN search_map ON search_fts.rowid = search_map.rowid
    WHERE search_map.type = ? AND search_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  let idQuery;
  const lookupIds = (term, limit) => {
    if (idQuery === undefined) {
      try {
        idQuery = db.prepare(`
          SELECT sessionId AS id FROM session_cache WHERE sessionId >= @session AND sessionId < @session || '~'
          UNION
          SELECT sessionId AS id FROM session_cache WHERE @agent IS NOT NULL AND agentId >= @agent AND agentId < @agent || '~'
          LIMIT @limit
        `);
      } catch { idQuery = null; }
    }
    if (!idQuery) return [];
    return idQuery.all({ session: term.sessionPrefix, agent: term.agentPrefix, limit });
  };
  return function search(type, query, limit = 50, titleOnly = false) {
    const results = [];
    const seen = new Set();
    const term = type === 'session' ? idLookupTerm(query) : null;
    if (term) {
      for (const row of lookupIds(term, limit)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        results.push({ id: row.id, snippet: null, idMatch: true });
      }
    }
    const match = buildFtsMatch(query, titleOnly);
    if (match && results.length < limit) {
      for (const row of ftsQuery.all(type, match, limit)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        results.push({ id: row.id, snippet: row.snippet });
        if (results.length >= limit) break;
      }
    }
    return results;
  };
}

module.exports = { FTS_QUERY_MAX_CHARS, FTS_MIN_TERM_CHARS, searchTerms, buildFtsMatch, idLookupTerm, createSessionSearch };
