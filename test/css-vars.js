'use strict';

function rootTokens(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.fromEntries([...clean.matchAll(/:root\s*\{([^}]+)\}/g)]
    .flatMap(m => [...m[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(v => [v[1], v[2].trim()])));
}

function resolveCssVars(css, tokens = rootTokens(css)) {
  return css.replace(/var\((--[\w-]+)(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (match, key, fallback) =>
    Object.hasOwn(tokens, key) ? tokens[key] : fallback === undefined ? match : fallback.trim());
}

module.exports = { rootTokens, resolveCssVars };
