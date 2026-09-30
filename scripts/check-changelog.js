#!/usr/bin/env node
// see docs/changelog.md ("The CI check")
'use strict';

const WAIVER_LABEL = 'no-changelog';

function isAppPath(file) {
  if (file.startsWith('public/') || file.startsWith('workers/')) return true;
  if (file === 'scripts/claude-sandbox.sh') return true;
  return /^[^/]+\.js$/.test(file) && file !== 'eslint.config.js';
}

function checkChangelog({ files, labels }) {
  const app = files.filter(isAppPath);
  if (app.length === 0 || files.includes('CHANGELOG.md') || labels.includes(WAIVER_LABEL)) {
    return { ok: true, message: 'changelog check passed' };
  }
  return {
    ok: false,
    message: [
      'This PR changes the app without an entry in CHANGELOG.md:',
      ...app.map((f) => `  ${f}`),
      'Add one under "## Unreleased" (see docs/changelog.md), or add the',
      `"${WAIVER_LABEL}" label if users see no difference, then re-run this job.`,
    ].join('\n'),
  };
}

function parseLabels(raw) {
  if (!raw) return [];
  let labels;
  try { labels = JSON.parse(raw); } catch { labels = null; }
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) {
    throw new Error(`PR_LABELS must be a JSON array of label names, got: ${raw}`);
  }
  return labels;
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const files = input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const result = checkChangelog({ files, labels: parseLabels(process.env.PR_LABELS) });
    console.log(result.message);
    process.exitCode = result.ok ? 0 : 1;
  });
}

module.exports = { isAppPath, checkChangelog, parseLabels };
