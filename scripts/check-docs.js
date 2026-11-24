#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { isAppPath, parseLabels } = require('./check-changelog');

function checkDocs({ files, labels }) {
  const app = files.filter(isAppPath);
  const hasDocs = files.some((file) => file.startsWith('docs/') || file.startsWith('.ai/contexts/') || file === 'README.md');
  if (app.length === 0 || hasDocs || labels.includes('no-docs')) {
    return { ok: true, message: 'docs check passed' };
  }
  return {
    ok: false,
    message: [
      'This PR changes the app without documentation:',
      ...app.map((file) => `  ${file}`),
      'Update the affected docs/ (or README.md) and .ai/contexts/ files in this PR,',
      'and name them in the PR body. If none are needed, write "no docs: <reason>"',
      'in the body and add the "no-docs" label, then re-run this job.',
    ].join('\n'),
  };
}

const USAGE = 'usage: check-docs.js --base <sha> --head <sha> (--labels <json array> | --repo <owner/name> --pr <number>)';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--base', '--head', '--labels', '--repo', '--pr'].includes(argv[i]) || argv[i + 1] === undefined) throw new Error(USAGE);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  if (!opts.base || !opts.head) throw new Error(USAGE);
  if (opts.labels === undefined && !(opts.repo && opts.pr)) throw new Error(USAGE);
  return opts;
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const labels = parseLabels(opts.labels !== undefined ? opts.labels
      : execFileSync('gh', ['api', `repos/${opts.repo}/issues/${opts.pr}/labels`, '--jq', '[.[].name]'], { encoding: 'utf8' }).trim());
    const files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${opts.base}...${opts.head}`], { encoding: 'utf8' })
      .split('\0').filter(Boolean);
    const result = checkDocs({ files, labels });
    console.log(result.message);
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}

module.exports = { checkDocs };
