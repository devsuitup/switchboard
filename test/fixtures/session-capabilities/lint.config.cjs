'use strict';
module.exports = [{
  files: ['**/*.js', '**/*.cjs'],
  languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: require('../../../node_modules/globals').node },
  rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }], 'no-unreachable': 'warn', 'no-redeclare': 'warn' },
}];
