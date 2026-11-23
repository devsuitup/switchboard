'use strict';

const fs = require('node:fs');

const TITLE_PATTERN = /^(feat|fix|perf|refactor|docs|test|build|ci|chore|revert)\([^\s()]+\)!?: \S.*$/u;
const TITLE_GUIDANCE = 'Use type(area): subject with a non-empty area and subject. '
  + 'Types: feat, fix, perf, refactor, docs, test, build, ci, chore, revert. '
  + 'Breaking changes may use type(area)!: subject.';

function lintPrTitle(title) {
  return typeof title === 'string' && !/[\r\n\u2028\u2029]/u.test(title) && TITLE_PATTERN.test(title)
    ? null : TITLE_GUIDANCE;
}

function runPrTitleLint({ title, summaryPath, advisory = false, write = console.log }) {
  const diagnostic = lintPrTitle(title);
  const message = diagnostic || 'PR title matches type(area): subject.';
  write(diagnostic ? `::warning::${message}` : message);
  if (summaryPath) {
    fs.appendFileSync(summaryPath, `## PR title${advisory ? ' (advisory)' : ''}\n\n${message}\n`, 'utf8');
  }
  return diagnostic && !advisory ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = runPrTitleLint({
    title: process.env.PR_TITLE,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
    advisory: process.argv.includes('--advisory'),
  });
}

module.exports = { lintPrTitle, runPrTitleLint };
