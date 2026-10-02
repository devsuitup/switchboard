#!/usr/bin/env node
// see docs/changelog.md ("The CI check")
'use strict';

const { execFileSync } = require('child_process');

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

const USAGE = 'usage: check-changelog.js --base <sha> --head <sha> (--labels <json array> | --repo <owner/name> --pr <number>)';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(USAGE);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  if (!opts.base || !opts.head) throw new Error(USAGE);
  if (opts.labels === undefined && !(opts.repo && opts.pr)) throw new Error(USAGE);
  return opts;
}

function changedFiles(base, head) {
  return execFileSync('git', ['diff', '--name-only', '--no-renames', `${base}...${head}`], { encoding: 'utf8' })
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function prLabels(repo, pr) {
  const out = execFileSync('gh', ['api', `repos/${repo}/issues/${pr}/labels`, '--jq', '[.[].name]'], { encoding: 'utf8' });
  return parseLabels(out.trim());
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const labels = opts.labels !== undefined ? parseLabels(opts.labels) : prLabels(opts.repo, opts.pr);
    const result = checkChangelog({ files: changedFiles(opts.base, opts.head), labels });
    console.log(result.message);
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}

module.exports = { isAppPath, checkChangelog, parseLabels };
