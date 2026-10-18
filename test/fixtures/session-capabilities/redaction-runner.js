'use strict';

const os = require('node:os');
const harness = require('../../../scripts/canary-cli-capabilities');
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const token = harness.loadOAuthToken({ oauthTokenFile: process.env.CANARY_TEST_OAUTH_TOKEN_FILE,
  home: value('--home'), runtimeRoot: value('--runtime-root'), out: value('--out') });
os.release = () => token;
harness.main(args).then(code => process.exit(code)).catch(() => process.exit(2));
