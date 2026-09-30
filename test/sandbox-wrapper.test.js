// Behavioural coverage for scripts/claude-sandbox.sh — the bwrap wrapper the
// Sandbox session option launches. Run with a fake $HOME, a fake `claude`, and
// (mostly) a fake `bwrap`, so the assertions hold on machines where
// unprivileged user namespaces are restricted.
//
// The renderer/main.js side of the option lives in dom-sandbox-toggle.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'claude-sandbox.sh');
const LINUX = process.platform === 'linux';

/**
 * The environment every child of these tests runs with: no inherited GIT_* or
 * HUSKY* variable, so a git command inside the rig can never reach the
 * repository the suite runs from (the pre-commit hook sets GIT_INDEX_FILE).
 */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(GIT_|HUSKY)/.test(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

/** Run git in a rig directory, with a clean environment and no user config. */
function git(cwd, ...args) {
  const res = spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }),
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * Throwaway sandbox rig: fake $HOME, fake claude, project cwd.
 *
 * bwrapExit: a stand-in bwrap that fails the pre-flight with that status.
 * recordArgs: a stand-in bwrap that records each invocation's argv and exits 0.
 * claudeRunsArg: the fake claude runs its first argument as a bash script, so a
 * real-bwrap test can act from inside the sandbox.
 */
function makeRig({ bwrapExit = null, recordArgs = false, claudeRunsArg = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sandbox-')));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  const argsDir = path.join(root, 'bwrap-args');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(proj);

  fs.writeFileSync(path.join(bin, 'claude'), claudeRunsArg
    ? '#!/usr/bin/env bash\nexec bash -c "$1"\n'
    : '#!/usr/bin/env bash\necho FAKE-CLAUDE "$@"\n');
  fs.chmodSync(path.join(bin, 'claude'), 0o755);

  if (recordArgs) {
    fs.mkdirSync(argsDir);
    fs.writeFileSync(path.join(bin, 'bwrap'), [
      '#!/usr/bin/env bash',
      '[ "${1:-}" = "--version" ] && { echo "bubblewrap 0.11.1"; exit 0; }',
      `n=$(ls "${argsDir}" | wc -l)`,
      `printf '%s\\0' "$@" > "${argsDir}/$n"`,
      'exit 0',
    ].join('\n') + '\n');
    fs.chmodSync(path.join(bin, 'bwrap'), 0o755);
  } else if (bwrapExit !== null) {
    // Stand-in bwrap that reproduces the Ubuntu 23.10+ restricted-userns
    // failure. --version is answered so the wrapper's debug probe works.
    fs.writeFileSync(path.join(bin, 'bwrap'), [
      '#!/usr/bin/env bash',
      '[ "${1:-}" = "--version" ] && { echo "bubblewrap 0.9.0"; exit 0; }',
      'echo "bwrap: setting up uid map: Permission denied" >&2',
      `exit ${bwrapExit}`,
    ].join('\n') + '\n');
    fs.chmodSync(path.join(bin, 'bwrap'), 0o755);
  }

  return {
    root, home, proj,
    /** Run the wrapper; returns { status, stdout, stderr }. */
    run(args = ['--version'], env = {}, cwd = proj) {
      const res = spawnSync('bash', [SCRIPT, ...args], {
        cwd,
        encoding: 'utf8',
        env: cleanEnv({
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          SWITCHBOARD_SANDBOX_DEBUG: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          ...env,
        }),
      });
      return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
    },
    /** The argv of the stand-in bwrap's last invocation (the real launch). */
    lastBwrapArgs() {
      const runs = fs.readdirSync(argsDir).map(Number).sort((a, b) => a - b);
      assert.ok(runs.length > 0, 'bwrap was never invoked');
      const raw = fs.readFileSync(path.join(argsDir, String(runs[runs.length - 1])), 'utf8');
      return raw.split('\0').slice(0, -1);
    },
    cleanup() {
      spawnSync('chmod', ['-R', 'u+w', root]);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const TWO_ARG_OPS = new Set(['--bind', '--ro-bind', '--symlink', '--file', '--setenv', '--bind-data', '--ro-bind-data']);
const ONE_ARG_OPS = new Set(['--tmpfs', '--dir', '--chdir', '--dev', '--proc', '--remount-ro']);

/** bwrap argv → [{ op, src, dest, index }], in mount order; stops at the program. */
function parseMounts(argv) {
  const ops = [];
  for (let i = 0; i < argv.length; i++) {
    const op = argv[i];
    if (TWO_ARG_OPS.has(op)) { ops.push({ op, src: argv[i + 1], dest: argv[i + 2], index: ops.length }); i += 2; }
    else if (ONE_ARG_OPS.has(op)) { ops.push({ op, src: null, dest: argv[i + 1], index: ops.length }); i += 1; }
    else if (!op.startsWith('--')) break;
  }
  return ops;
}

/** The last mount covering `p` (at `p` or at an ancestor): what decides its access. */
function accessAt(ops, p) {
  const covering = ops.filter(o => ['--bind', '--ro-bind', '--tmpfs', '--symlink'].includes(o.op)
    && (o.dest === p || p.startsWith(o.dest + '/')));
  return covering.length ? covering[covering.length - 1].op : undefined;
}

/** The last mount whose destination is exactly `dest` — the one the sandbox sees. */
function mountAt(ops, dest) {
  const at = ops.filter(o => o.dest === dest && o.op !== '--chdir' && o.op !== '--setenv');
  return at.length ? at[at.length - 1] : undefined;
}

test('sandbox wrapper: refuses to be the first claude launch instead of pre-seeding config', { skip: !LINUX && 'linux only' }, () => {
  const rig = makeRig({ bwrapExit: 1 });
  try {
    const { status, stderr } = rig.run();
    assert.equal(status, 125, 'must fail closed');
    assert.match(stderr, /run claude once outside the sandbox first/);
    assert.deepEqual(fs.readdirSync(rig.home), [], '$HOME must be left completely untouched');
  } finally {
    rig.cleanup();
  }
});

test('sandbox wrapper: a failed bwrap pre-flight leaves no state behind in $HOME', { skip: !LINUX && 'linux only' }, () => {
  const rig = makeRig({ bwrapExit: 1 });
  try {
    fs.mkdirSync(path.join(rig.home, '.claude'));
    const { status, stderr } = rig.run();
    assert.equal(status, 125, 'must fail closed');
    assert.match(stderr, /bwrap failed to set up the sandbox/);

    // The regression this guards: mkdir'ing the state dirs and seeding
    // ~/.claude.json with '{}' before bwrap has proven it can even start.
    assert.deepEqual(fs.readdirSync(rig.home).sort(), ['.claude'],
      'a launch bwrap refused must not create state dirs or seed ~/.claude.json');
  } finally {
    rig.cleanup();
  }
});

test('sandbox wrapper: restricted-userns failure points at the sysctl and AppArmor remedies', { skip: !LINUX && 'linux only' }, () => {
  const rig = makeRig({ bwrapExit: 1 });
  try {
    fs.mkdirSync(path.join(rig.home, '.claude'));
    const { stderr } = rig.run();
    assert.match(stderr, /setting up uid map: Permission denied/, "bwrap's own message must still be shown");
    assert.match(stderr, /apparmor_restrict_unprivileged_userns/, 'must name the sysctl');
    assert.match(stderr, /sysctl --system/, 'must give a persistent fix, not just a runtime one');
    assert.match(stderr, /AppArmor profile with 'userns,'/, 'must offer the profile alternative');
  } finally {
    rig.cleanup();
  }
});

test('sandbox wrapper: extra binds survive a newline in a path and missing ones are reported', { skip: !LINUX && 'linux only' }, () => {
  const rig = makeRig({ bwrapExit: 1 });
  try {
    fs.mkdirSync(path.join(rig.home, '.claude'));
    // 'IFS=: read -a' without -d '' stops at the first newline, silently
    // dropping every bind after it — here that would lose "after".
    const weird = path.join(rig.root, 'we\nird');
    const after = path.join(rig.root, 'after');
    fs.mkdirSync(weird);
    fs.mkdirSync(after);

    const { stderr } = rig.run(['--version'], {
      SWITCHBOARD_SANDBOX_DEBUG: '1',
      SWITCHBOARD_SANDBOX_BINDS: `${weird}:${after}:${path.join(rig.root, 'gone')}`,
    });
    assert.ok(stderr.includes(`rw-bind ${weird}`), 'a path containing a newline must be bound whole');
    assert.ok(stderr.includes(`rw-bind ${after}`), 'binds after a newline-containing one must not be dropped');
    assert.match(stderr, /skipping bind — does not exist/, 'a missing extra bind must be reported, not mkdir\'d');
    assert.ok(!fs.existsSync(path.join(rig.root, 'gone')), 'a missing extra bind must not be created on the host');
  } finally {
    rig.cleanup();
  }
});

test('sandbox wrapper: resolves the real binary when "claude" is also a shell function', { skip: !LINUX && 'linux only' }, () => {
  const rig = makeRig({ bwrapExit: 1 });
  try {
    fs.mkdirSync(path.join(rig.home, '.claude'));
    // Switchboard launches us from `bash -l -i -c`, so the user's profile is in
    // play. `command -v claude` reports a function as the bare word "claude",
    // whose readlink -f is not the binary — that is how an empty program name
    // reached bwrap ("bwrap: execvp : No such file or directory").
    const { stderr } = rig.run(['--version'], { SWITCHBOARD_SANDBOX_DEBUG: '1' });
    const line = stderr.split('\n').find(l => l.startsWith('claude-sandbox: claude:'));
    assert.ok(line, 'the resolved binary must be reported under debug');
    assert.match(line, /-> \S+/, 'the resolution target must never be empty');
    assert.doesNotMatch(line, /-> *$/, 'an empty resolution would be handed to bwrap as argv[0]');
  } finally {
    rig.cleanup();
  }
});

test('sandbox wrapper: refuses to bind $HOME or an ancestor as the project dir', { skip: !LINUX && 'linux only' }, () => {
  const rig = makeRig({ bwrapExit: 1 });
  try {
    fs.mkdirSync(path.join(rig.home, '.claude'));
    fs.writeFileSync(path.join(rig.home, 'private-key'), 'secret');

    // Launched with the wrong cwd, the wrapper would bind all of $HOME — the
    // exact tree it advertises as hidden — and still report success.
    const res = spawnSync('bash', [SCRIPT, '--version'], {
      cwd: rig.home, encoding: 'utf8',
      env: { ...process.env, HOME: rig.home, PATH: `${path.join(rig.root, 'bin')}:${process.env.PATH}` },
    });
    assert.equal(res.status, 125, 'must fail closed');
    assert.match(res.stderr, /refusing to bind/);
    assert.match(res.stderr, /\$HOME itself/);

    // And via an extra bind, not just cwd.
    const res2 = spawnSync('bash', [SCRIPT, '--version'], {
      cwd: rig.proj, encoding: 'utf8',
      env: {
        ...process.env, HOME: rig.home,
        PATH: `${path.join(rig.root, 'bin')}:${process.env.PATH}`,
        SWITCHBOARD_SANDBOX_BINDS: path.dirname(rig.home),
      },
    });
    assert.equal(res2.status, 125, 'a parent of $HOME must be refused too');
    assert.match(res2.stderr, /parent of \$HOME/);
  } finally {
    rig.cleanup();
  }
});

// Needs a working unprivileged userns; skipped where the kernel/AppArmor says
// no (Ubuntu 23.10+ defaults, most CI containers). Same bwrap shape the wrapper
// builds, minus the per-launch binds — the lib symlinks matter, without them
// execve of the payload fails on missing ld.so rather than on the namespace.
const realBwrapWorks = LINUX && spawnSync('bwrap', [
  '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-all', '--share-net', '--dir', '/var',
  '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
  '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
  '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
  '/bin/true',
], { encoding: 'utf8' }).status === 0;

test('sandbox wrapper: a successful launch creates the state dirs and hides the rest of $HOME',
  { skip: !realBwrapWorks && 'requires a usable unprivileged user namespace' }, () => {
    const rig = makeRig();
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      fs.writeFileSync(path.join(rig.home, 'private-key'), 'secret');

      const { status, stdout } = rig.run(['--print', 'hi']);
      assert.equal(status, 0, 'must launch');
      assert.match(stdout, /FAKE-CLAUDE --print hi/, 'claude args must be passed through');

      // Created only once bwrap proved the sandbox is constructible.
      for (const rel of ['.config/claude', '.cache/claude', '.local/share/claude']) {
        assert.ok(fs.existsSync(path.join(rig.home, rel)), `${rel} must exist after a successful launch`);
      }
      assert.equal(fs.existsSync(path.join(rig.home, '.claude.json')), false,
        'the sandbox gets a private ~/.claude.json; none is created on the host');
      assert.equal(fs.readFileSync(path.join(rig.home, 'private-key'), 'utf8'), 'secret',
        'unrelated $HOME files must be untouched');
    } finally {
      rig.cleanup();
    }
  });

/** A ~/.claude with the shape the CLI leaves behind: state, config, a script. */
function seedClaudeDir(home) {
  const dir = path.join(home, '.claude');
  for (const d of ['projects', 'hooks', 'commands', 'agents', 'skills', 'plugins', 'shell-snapshots']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'settings.local.json'), '{}\n');
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'history.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'statusline.sh'), 'echo status\n');
  fs.writeFileSync(path.join(dir, 'statusline'), 'echo status\n', { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'keybindings.json'), '[]\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '');
  fs.writeFileSync(path.join(dir, 'policy-limits.json'), '{}\n');
  for (const d of ['output-styles', 'rules', 'ide', 'some-future-dir', 'todos', 'agent-memory']) {
    fs.mkdirSync(path.join(dir, d));
  }
  return dir;
}

test('sandbox wrapper: ~/.claude is a private tmpfs, its state bound back read-write and its executable config read-only',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      const dir = seedClaudeDir(rig.home);
      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      const ops = parseMounts(rig.lastBwrapArgs());

      assert.equal(ops.find(o => o.op === '--bind' && o.dest === dir), undefined,
        '~/.claude must no longer be bound read-write as a whole');
      const tmpfs = mountAt(ops, dir);
      assert.equal(tmpfs?.op, '--tmpfs', 'new entries at the top of ~/.claude must land in a private tmpfs');

      for (const name of ['settings.json', 'settings.local.json', 'hooks', 'commands', 'agents', 'skills', 'plugins',
        'statusline.sh', 'statusline', 'keybindings.json', 'CLAUDE.md', 'output-styles', 'rules', 'ide', 'some-future-dir']) {
        const m = mountAt(ops, path.join(dir, name));
        assert.equal(m?.op, '--ro-bind', `${name} must be read-only: only listed state is writable`);
        assert.ok(m.index > tmpfs.index, `${name} must be mounted on top of the tmpfs`);
      }
      for (const name of ['projects', 'shell-snapshots', 'todos', 'agent-memory', '.credentials.json', 'history.jsonl', 'policy-limits.json']) {
        const m = mountAt(ops, path.join(dir, name));
        assert.equal(m?.op, '--bind', `${name} must stay read-write`);
        assert.ok(m.index > tmpfs.index, `${name} must be mounted on top of the tmpfs`);
      }
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: a symlinked ~/.claude entry is recreated as a link, and its target is read-only wherever the sandbox could write it',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      const dir = path.join(rig.home, '.claude');
      fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
      const dotfiles = path.join(rig.proj, 'dotfiles');
      const lab = path.join(rig.root, 'lab');
      fs.mkdirSync(path.join(dotfiles, 'skills', 'mine'), { recursive: true });
      fs.mkdirSync(path.join(lab, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(dotfiles, 'settings.json'), '{}\n');
      fs.symlinkSync(path.join(dotfiles, 'settings.json'), path.join(dir, 'settings.json'));
      fs.symlinkSync(path.join(lab, 'agents'), path.join(dir, 'agents'));
      fs.symlinkSync(path.join(dotfiles, 'skills', 'mine'), path.join(dir, 'skills', 'mine'));

      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      const ops = parseMounts(rig.lastBwrapArgs());

      const link = mountAt(ops, path.join(dir, 'settings.json'));
      assert.deepEqual([link?.op, link?.src], ['--symlink', path.join(dotfiles, 'settings.json')],
        'the link must be recreated inside the tmpfs, where replacing it touches nothing on the host');
      const target = mountAt(ops, path.join(dotfiles, 'settings.json'));
      assert.equal(target?.op, '--ro-bind', 'a link target inside a writable bind must be read-only');
      assert.ok(target.index > mountAt(ops, rig.proj).index, 'the target must be mounted over the project bind');

      const skill = mountAt(ops, path.join(dotfiles, 'skills', 'mine'));
      assert.equal(skill?.op, '--ro-bind', 'a link inside a protected directory must have its target protected too');

      assert.equal(mountAt(ops, path.join(dir, 'agents'))?.op, '--symlink');
      assert.equal(ops.find(o => o.dest === path.join(lab, 'agents')), undefined,
        'a target the sandbox cannot see must stay invisible, not be exposed read-only');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: a link at any depth under a read-only entry has its target protected, through linked directories too',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      const dir = path.join(rig.home, '.claude');
      fs.mkdirSync(path.join(dir, 'skills', 'a', 'b'), { recursive: true });
      const deep = path.join(rig.proj, 'deep.md');
      fs.writeFileSync(deep, '');
      fs.symlinkSync(deep, path.join(dir, 'skills', 'a', 'b', 'x'));
      const shared = path.join(rig.proj, 'shared');
      const further = path.join(rig.proj, 'further.sh');
      fs.mkdirSync(path.join(shared, 'inner'), { recursive: true });
      fs.writeFileSync(further, '');
      fs.symlinkSync(further, path.join(shared, 'inner', 'y'));
      fs.symlinkSync(shared, path.join(dir, 'skills', 'a', 'linked'));

      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      const ops = parseMounts(rig.lastBwrapArgs());
      assert.equal(mountAt(ops, deep)?.op, '--ro-bind', 'a link three levels down must have its target protected');
      assert.equal(mountAt(ops, shared)?.op, '--ro-bind');
      assert.equal(mountAt(ops, further)?.op, '--ro-bind', 'a link inside a linked directory must be followed too');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: a cycle of directory links under a read-only entry is followed once, not forever',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      const dir = path.join(rig.home, '.claude');
      fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
      const loop = path.join(rig.proj, 'loop');
      fs.mkdirSync(loop);
      fs.symlinkSync(loop, path.join(loop, 'self'));
      fs.symlinkSync(loop, path.join(dir, 'skills', 'loop'));
      const res = spawnSync('bash', [SCRIPT, '--version'], {
        cwd: rig.proj, encoding: 'utf8', timeout: 20000,
        env: cleanEnv({ HOME: rig.home, PATH: `${path.join(rig.root, 'bin')}:${process.env.PATH}` }),
      });
      assert.equal(res.status, 0, res.error ? String(res.error) : res.stderr);
      const binds = parseMounts(rig.lastBwrapArgs()).filter(o => o.dest === loop);
      assert.equal(binds.length, 1, 'the target must be mounted once');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: a symlinked state entry has its target bound read-write, so the session\'s state still lands',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      const dir = path.join(rig.home, '.claude');
      fs.mkdirSync(dir);
      const store = path.join(rig.root, 'store', 'projects');
      fs.mkdirSync(store, { recursive: true });
      fs.symlinkSync(store, path.join(dir, 'projects'));
      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      const ops = parseMounts(rig.lastBwrapArgs());
      assert.equal(mountAt(ops, path.join(dir, 'projects'))?.op, '--symlink');
      assert.deepEqual([mountAt(ops, store)?.op, mountAt(ops, store)?.src], ['--bind', store]);
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: refuses a symlinked state entry whose target contains $HOME',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      const dir = path.join(rig.home, '.claude');
      fs.mkdirSync(dir);
      fs.symlinkSync(rig.root, path.join(dir, 'projects'));
      const { status, stderr } = rig.run();
      assert.equal(status, 125, 'must fail closed');
      assert.match(stderr, /projects links to .* which contains \$HOME/);
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: the state dirs the CLI writes are created before launch, so they are not lost in the tmpfs',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      const ops = parseMounts(rig.lastBwrapArgs());
      for (const name of ['projects', 'todos', 'shell-snapshots', 'session-env', 'sessions']) {
        const p = path.join(rig.home, '.claude', name);
        assert.ok(fs.statSync(p).isDirectory(), `${name} must exist on the host`);
        assert.equal(mountAt(ops, p)?.op, '--bind', `${name} must be bound read-write`);
      }
      const ide = path.join(rig.home, '.claude', 'ide');
      assert.ok(fs.statSync(ide).isDirectory(), 'ide must exist, so lock files Switchboard writes later are visible');
      assert.equal(mountAt(ops, ide)?.op, '--ro-bind',
        'ide must be read-only: its lock files tell later sessions which port to trust');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: ~/.claude.json, which holds the MCP servers, is a private copy rather than a bind of the host file',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      const cfg = path.join(rig.home, '.claude.json');
      fs.writeFileSync(cfg, '{"mcpServers":{}}\n');
      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      const m = mountAt(parseMounts(rig.lastBwrapArgs()), cfg);
      assert.equal(m?.op, '--file', 'the file must be copied into the sandbox, not bound');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: the project\'s .claude is read-only on top of the project bind, its listed state bound back read-write',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      const dot = path.join(rig.proj, '.claude');
      fs.mkdirSync(path.join(dot, 'commands'), { recursive: true });
      fs.mkdirSync(path.join(dot, 'worktrees'));
      fs.mkdirSync(path.join(dot, 'agent-memory'));
      fs.writeFileSync(path.join(dot, 'settings.json'), '{}\n');
      fs.writeFileSync(path.join(dot, 'statusline'), 'echo\n');

      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      const ops = parseMounts(rig.lastBwrapArgs());
      const projBind = mountAt(ops, rig.proj);
      const dotMount = mountAt(ops, dot);
      assert.deepEqual([dotMount?.op, dotMount?.src], ['--ro-bind', dot],
        'the directory itself must be read-only, so a new entry fails instead of vanishing');
      assert.ok(dotMount.index > projBind.index, 'it must cover the project bind');
      assert.equal(accessAt(ops, path.join(dot, 'settings.json')), '--ro-bind');
      assert.equal(accessAt(ops, path.join(dot, 'commands', 'x.md')), '--ro-bind');
      assert.equal(accessAt(ops, path.join(dot, 'settings.local.json')), '--ro-bind', 'a new entry must be refused');
      assert.equal(accessAt(ops, path.join(dot, 'statusline')), '--ro-bind', 'an unlisted entry must be read-only');
      assert.equal(mountAt(ops, path.join(dot, 'worktrees'))?.op, '--bind');
      assert.equal(mountAt(ops, path.join(dot, 'agent-memory'))?.op, '--bind');
      assert.ok(mountAt(ops, path.join(dot, 'worktrees')).index > dotMount.index);
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: links in the project\'s .claude have their targets protected, except inside its state',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      const dot = path.join(rig.proj, '.claude');
      fs.mkdirSync(path.join(dot, 'commands', 'sub'), { recursive: true });
      fs.mkdirSync(path.join(dot, 'worktrees', 'wt'), { recursive: true });
      const cmd = path.join(rig.proj, 'cmd.md');
      const hook = path.join(rig.proj, 'hook.sh');
      const lib = path.join(rig.proj, 'lib');
      fs.writeFileSync(cmd, '');
      fs.writeFileSync(hook, '');
      fs.mkdirSync(lib);
      fs.symlinkSync(cmd, path.join(dot, 'commands', 'sub', 'x.md'));
      fs.symlinkSync(hook, path.join(dot, 'statusline'));
      fs.symlinkSync(lib, path.join(dot, 'worktrees', 'wt', 'lib'));

      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      const ops = parseMounts(rig.lastBwrapArgs());
      assert.equal(mountAt(ops, cmd)?.op, '--ro-bind', 'a nested link\'s target must be read-only');
      assert.equal(mountAt(ops, hook)?.op, '--ro-bind', 'a top-level link\'s target must be read-only');
      assert.equal(mountAt(ops, lib), undefined, 'links inside worktrees are project source, left alone');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: a symlinked state entry in the project\'s .claude has its target bound read-write',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      fs.mkdirSync(path.join(rig.proj, '.claude'));
      const elsewhere = path.join(rig.root, 'wts');
      fs.mkdirSync(elsewhere);
      fs.symlinkSync(elsewhere, path.join(rig.proj, '.claude', 'worktrees'));
      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      assert.equal(mountAt(parseMounts(rig.lastBwrapArgs()), elsewhere)?.op, '--bind');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: a project without .claude gets an empty one, so the sandbox cannot create its settings',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      const dot = path.join(rig.proj, '.claude');
      assert.deepEqual(fs.readdirSync(dot), [], 'the placeholder must be an empty directory');
      assert.equal(mountAt(parseMounts(rig.lastBwrapArgs()), dot)?.op, '--ro-bind');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: an Additional Directory the user cannot write gets no .claude placeholder, and still launches',
  { skip: (!LINUX || process.getuid?.() === 0) && 'linux, non-root only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      const docs = path.join(rig.root, 'docs');
      fs.mkdirSync(docs, { mode: 0o555 });
      const { status, stderr } = rig.run(['--version'], { SWITCHBOARD_SANDBOX_BINDS: docs });
      assert.equal(status, 0, stderr);
      assert.equal(fs.existsSync(path.join(docs, '.claude')), false);
      assert.equal(mountAt(parseMounts(rig.lastBwrapArgs()), docs)?.op, '--bind');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: an extra bind that is a file is bound as it is, with no .claude or .git handling',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      const notes = path.join(rig.root, 'notes.txt');
      fs.writeFileSync(notes, '');
      const { status, stderr } = rig.run(['--version'], { SWITCHBOARD_SANDBOX_BINDS: notes });
      assert.equal(status, 0, stderr);
      assert.equal(mountAt(parseMounts(rig.lastBwrapArgs()), notes)?.op, '--bind');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: a .claude that is a plain file is read-only, so it cannot be swapped for a directory',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      fs.writeFileSync(path.join(rig.proj, '.claude'), '');
      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      assert.equal(mountAt(parseMounts(rig.lastBwrapArgs()), path.join(rig.proj, '.claude'))?.op, '--ro-bind');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: refuses a project whose .claude is a symbolic link, which a read-only mount cannot protect',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      fs.mkdirSync(path.join(rig.root, 'shared-claude'));
      fs.symlinkSync(path.join(rig.root, 'shared-claude'), path.join(rig.proj, '.claude'));
      const { status, stderr } = rig.run();
      assert.equal(status, 125, 'must fail closed');
      assert.match(stderr, /\.claude is a symbolic link/);
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: a working directory below another bind\'s .claude is mounted after that .claude, and keeps its own protection',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      const wt = path.join(rig.proj, '.claude', 'worktrees', 'wt');
      fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });

      const { status, stderr } = rig.run(['--version'], { SWITCHBOARD_SANDBOX_BINDS: rig.proj }, wt);
      assert.equal(status, 0, stderr);
      const ops = parseMounts(rig.lastBwrapArgs());
      const rootDot = mountAt(ops, path.join(rig.proj, '.claude'));
      const wtBind = mountAt(ops, wt);
      const wtDot = mountAt(ops, path.join(wt, '.claude'));
      assert.equal(rootDot?.op, '--ro-bind');
      assert.equal(wtBind?.op, '--bind');
      assert.ok(wtBind.index > rootDot.index, 'the worktree must not be hidden under the root\'s read-only .claude');
      assert.equal(wtDot?.op, '--ro-bind');
      assert.ok(wtDot.index > wtBind.index, 'the worktree\'s own .claude must be protected on top of its bind');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: a repository\'s config and hooks are read-only, and its .git cannot be moved aside',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      git(rig.proj, 'init', '-q');
      const gitDir = path.join(rig.proj, '.git');

      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      const ops = parseMounts(rig.lastBwrapArgs());
      const projBind = mountAt(ops, rig.proj);
      const pin = mountAt(ops, gitDir);
      assert.deepEqual([pin?.op, pin?.src], ['--bind', gitDir], '.git must be a mount point of its own');
      assert.ok(pin.index > projBind.index);
      for (const p of [path.join(gitDir, 'config'), path.join(gitDir, 'hooks')]) {
        const m = mountAt(ops, p);
        assert.equal(m?.op, '--ro-bind', `${p} must be read-only`);
        assert.ok(m.index > pin.index, `${p} must be mounted over the .git bind`);
      }
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: the directory core.hooksPath names is read-only too, and created when missing',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      git(rig.proj, 'init', '-q');
      git(rig.proj, 'config', 'core.hooksPath', '.husky/_');
      fs.rmSync(path.join(rig.proj, '.git', 'hooks'), { recursive: true, force: true });

      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      const ops = parseMounts(rig.lastBwrapArgs());
      const husky = path.join(rig.proj, '.husky', '_');
      assert.ok(fs.statSync(husky).isDirectory(), 'a missing hooks directory must be created as a mount point');
      assert.equal(mountAt(ops, husky)?.op, '--ro-bind');
      assert.ok(fs.statSync(path.join(rig.proj, '.git', 'hooks')).isDirectory(), '.git/hooks must be recreated too');
      assert.equal(mountAt(ops, path.join(rig.proj, '.git', 'hooks'))?.op, '--ro-bind',
        '.git/hooks stays protected: unsetting core.hooksPath later would bring it back into use');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: in a linked worktree, the .git file and the worktree\'s commondir are read-only',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      git(rig.proj, 'init', '-q');
      git(rig.proj, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
      const wt = path.join(rig.root, 'wt');
      git(rig.proj, 'worktree', 'add', '-q', wt);
      git(rig.proj, 'config', 'extensions.worktreeConfig', 'true');
      git(rig.proj, 'config', '--worktree', 'x.main', '1');
      git(wt, 'config', '--worktree', 'x.linked', '1');

      const { status, stderr } = rig.run(['--version'], { SWITCHBOARD_SANDBOX_BINDS: rig.proj }, wt);
      assert.equal(status, 0, stderr);
      const ops = parseMounts(rig.lastBwrapArgs());
      assert.equal(mountAt(ops, path.join(wt, '.git'))?.op, '--ro-bind', 'the gitdir pointer must be read-only');
      assert.equal(mountAt(ops, path.join(rig.proj, '.git', 'worktrees', 'wt', 'commondir'))?.op, '--ro-bind');
      assert.equal(mountAt(ops, path.join(rig.proj, '.git', 'config'))?.op, '--ro-bind');
      assert.equal(mountAt(ops, path.join(rig.proj, '.git', 'config.worktree'))?.op, '--ro-bind');
      assert.equal(mountAt(ops, path.join(rig.proj, '.git', 'worktrees', 'wt', 'config.worktree'))?.op, '--ro-bind');
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: refuses a repository whose git paths contain a newline, which cannot be read back reliably',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      git(rig.proj, 'init', '-q');
      git(rig.proj, 'config', 'core.hooksPath', 'hooks\nsplit');
      const { status, stderr } = rig.run();
      assert.equal(status, 125, 'must fail closed');
      assert.match(stderr, /newline/);
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: refuses a project whose .git is a symbolic link',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      const elsewhere = path.join(rig.root, 'repo');
      fs.mkdirSync(elsewhere);
      git(elsewhere, 'init', '-q');
      fs.symlinkSync(path.join(elsewhere, '.git'), path.join(rig.proj, '.git'));
      const { status, stderr } = rig.run();
      assert.equal(status, 125, 'must fail closed');
      assert.match(stderr, /\.git is a symbolic link/);
    } finally {
      rig.cleanup();
    }
  });

test('sandbox wrapper: refuses a repository whose .git/hooks is a symbolic link',
  { skip: !LINUX && 'linux only' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      git(rig.proj, 'init', '-q');
      fs.rmSync(path.join(rig.proj, '.git', 'hooks'), { recursive: true, force: true });
      fs.mkdirSync(path.join(rig.proj, 'githooks'));
      fs.symlinkSync('../githooks', path.join(rig.proj, '.git', 'hooks'));
      const { status, stderr } = rig.run();
      assert.equal(status, 125, 'must fail closed');
      assert.match(stderr, /hooks is a symbolic link/);
      assert.match(stderr, /core\.hooksPath/, 'must point at the supported alternative');
    } finally {
      rig.cleanup();
    }
  });

const resolvConfTarget = LINUX ? (() => {
  try { return fs.realpathSync('/etc/resolv.conf'); } catch { return null; }
})() : null;
const resolvConfLinksOut = !!resolvConfTarget && !/^\/(etc|usr)\//.test(resolvConfTarget);

test('sandbox wrapper: an /etc/resolv.conf that links out of /etc has its target\'s directory bound, so DNS works',
  { skip: !resolvConfLinksOut && 'this host\'s /etc/resolv.conf is not a link out of /etc' }, () => {
    const rig = makeRig({ recordArgs: true });
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      const { status, stderr } = rig.run();
      assert.equal(status, 0, stderr);
      const dir = path.dirname(resolvConfTarget);
      const m = mountAt(parseMounts(rig.lastBwrapArgs()), dir);
      assert.deepEqual([m?.op, m?.src], ['--ro-bind', dir],
        'the directory, not the file: resolvers replace the file by a rename');
    } finally {
      rig.cleanup();
    }
  });

// Every write below is attempted from inside a real sandbox; what counts is
// what reached the host afterwards. Each attempt prints its own outcome, which
// the assertion messages carry.
const PERSISTENCE_ATTEMPTS = String.raw`
attempt() { local name="$1"; shift; if ( eval "$*" ) 2>/dev/null; then echo "$name: written"; else echo "$name: refused"; fi; }
C="$HOME/.claude"
attempt user-settings-through-link 'echo evil > "$C/settings.json"'
attempt user-settings-link-target 'echo evil > "$PWD/dotfiles/settings.json"'
attempt user-settings-link-replaced 'rm -f "$C/settings.json" && echo evil > "$C/settings.json"'
attempt user-settings-local-created 'echo evil > "$C/settings.local.json"'
attempt user-hook 'echo evil > "$C/hooks/evil.sh"'
attempt user-command 'echo evil > "$C/commands/evil.md"'
attempt user-agent-through-link 'echo evil > "$C/agents/evil.md"'
attempt user-skill 'mkdir -p "$C/skills/evil" && echo evil > "$C/skills/evil/SKILL.md"'
attempt user-statusline-script 'echo evil > "$C/statusline.sh"'
attempt user-statusline-extensionless 'echo evil > "$C/statusline"'
attempt user-keybindings 'echo evil > "$C/keybindings.json"'
attempt ide-lock 'echo "{\"port\":1}" > "$C/ide/1.lock"'
attempt skill-deep-link 'echo evil > "$C/skills/a/b/x"'
attempt mcp-servers 'echo "{\"mcpServers\":{\"evil\":{\"command\":\"evil\"}}}" > "$HOME/.claude.json"'
attempt project-settings 'echo evil > .claude/settings.json'
attempt project-settings-local-created 'echo evil > .claude/settings.local.json'
attempt project-new-entry 'echo x > .claude/newdir-probe.txt'
attempt project-claude-moved 'mv .claude .claude-x && mkdir .claude && echo evil > .claude/settings.json'
attempt git-hook 'echo evil > .git/hooks/pre-commit'
attempt git-hookspath-dir 'echo evil > .husky/_/pre-commit'
attempt git-config-hookspath 'git config core.hooksPath evil-hooks'
attempt git-config-fsmonitor 'git config core.fsmonitor evil'
attempt git-dir-moved 'mv .git .git-x'
attempt transcript 'mkdir -p "$C/projects/p" && echo "{}" >> "$C/projects/p/s.jsonl"'
attempt credentials-refresh 'echo refreshed > "$C/.credentials.json"'
attempt source-file 'echo "export {}" > src.js'
attempt git-commit 'git add src.js && git -c user.name=t -c user.email=t@t commit -qm src'
attempt resolv-conf 'test -s /etc/resolv.conf && cat /etc/resolv.conf > /dev/null'
`;

test('sandbox wrapper: from inside a real sandbox, every persistence write is refused or discarded, and the session\'s own writes land',
  { skip: !realBwrapWorks && 'requires a usable unprivileged user namespace' }, () => {
    const rig = makeRig({ claudeRunsArg: true });
    try {
      const C = path.join(rig.home, '.claude');
      for (const d of ['hooks', 'commands', 'skills/a/b', 'ide']) fs.mkdirSync(path.join(C, d), { recursive: true });
      const store = path.join(rig.root, 'store', 'projects');
      fs.mkdirSync(store, { recursive: true });
      fs.symlinkSync(store, path.join(C, 'projects'));
      fs.writeFileSync(path.join(C, '.credentials.json'), 'old\n');
      fs.writeFileSync(path.join(C, 'statusline.sh'), 'echo status\n');
      fs.writeFileSync(path.join(C, 'statusline'), 'echo status\n');
      fs.writeFileSync(path.join(C, 'keybindings.json'), '[]\n');
      fs.writeFileSync(path.join(rig.proj, 'deep.md'), 'skill\n');
      fs.symlinkSync(path.join(rig.proj, 'deep.md'), path.join(C, 'skills', 'a', 'b', 'x'));
      const dotfiles = path.join(rig.proj, 'dotfiles');
      fs.mkdirSync(dotfiles);
      fs.writeFileSync(path.join(dotfiles, 'settings.json'), '{}\n');
      fs.symlinkSync(path.join(dotfiles, 'settings.json'), path.join(C, 'settings.json'));
      const lab = path.join(rig.root, 'lab', 'agents');
      fs.mkdirSync(lab, { recursive: true });
      fs.symlinkSync(lab, path.join(C, 'agents'));
      fs.writeFileSync(path.join(rig.home, '.claude.json'), '{"mcpServers":{}}\n');
      fs.mkdirSync(path.join(rig.proj, '.claude'));
      fs.writeFileSync(path.join(rig.proj, '.claude', 'settings.json'), '{}\n');
      git(rig.proj, 'init', '-q');
      git(rig.proj, 'config', 'core.hooksPath', '.husky/_');

      const res = rig.run([PERSISTENCE_ATTEMPTS]);
      assert.equal(res.status, 0, res.stderr);
      const said = res.stdout;
      const read = (p) => fs.readFileSync(p, 'utf8');
      const gone = (p) => !fs.existsSync(p);

      assert.equal(read(path.join(dotfiles, 'settings.json')), '{}\n', `a symlinked settings file must be unchanged\n${said}`);
      assert.equal(fs.readlinkSync(path.join(C, 'settings.json')), path.join(dotfiles, 'settings.json'), 'the link must be unchanged');
      assert.ok(gone(path.join(C, 'settings.local.json')), `a new user settings file must not reach the host\n${said}`);
      assert.ok(gone(path.join(C, 'hooks', 'evil.sh')), `user hooks must be read-only\n${said}`);
      assert.ok(gone(path.join(C, 'commands', 'evil.md')), `user commands must be read-only\n${said}`);
      assert.deepEqual(fs.readdirSync(lab), [], `a symlinked agents dir must be unchanged\n${said}`);
      assert.ok(gone(path.join(C, 'skills', 'evil')), `user skills must be read-only\n${said}`);
      assert.equal(read(path.join(C, 'statusline.sh')), 'echo status\n', `a script in ~/.claude must be read-only\n${said}`);
      assert.equal(read(path.join(C, 'statusline')), 'echo status\n', `an extensionless script must be read-only\n${said}`);
      assert.equal(read(path.join(C, 'keybindings.json')), '[]\n', `keybindings must be read-only\n${said}`);
      assert.ok(gone(path.join(C, 'ide', '1.lock')), `an IDE lock file must not reach the host\n${said}`);
      assert.equal(read(path.join(rig.proj, 'deep.md')), 'skill\n', `a deep skill link's target must be read-only\n${said}`);
      assert.equal(read(path.join(rig.home, '.claude.json')), '{"mcpServers":{}}\n', `MCP servers must not reach the host\n${said}`);
      assert.equal(read(path.join(rig.proj, '.claude', 'settings.json')), '{}\n', `project settings must be read-only\n${said}`);
      assert.ok(gone(path.join(rig.proj, '.claude', 'settings.local.json')), `new project settings must not reach the host\n${said}`);
      for (const name of ['project-settings', 'project-settings-local-created', 'project-new-entry']) {
        assert.match(said, new RegExp(`^${name}: refused$`, 'm'), `${name} must fail inside the sandbox, not vanish silently`);
      }
      assert.ok(gone(path.join(rig.proj, '.claude-x')), `the project's .claude must not be movable\n${said}`);
      assert.ok(gone(path.join(rig.proj, '.git', 'hooks', 'pre-commit')), `.git/hooks must be read-only\n${said}`);
      assert.ok(gone(path.join(rig.proj, '.husky', '_', 'pre-commit')), `the core.hooksPath directory must be read-only\n${said}`);
      assert.equal(git(rig.proj, 'config', '--get', 'core.hooksPath'), '.husky/_', `core.hooksPath must be unchanged\n${said}`);
      assert.equal(spawnSync('git', ['config', '--get', 'core.fsmonitor'], { cwd: rig.proj, env: cleanEnv() }).status, 1,
        `core.fsmonitor must not be set\n${said}`);
      assert.ok(gone(path.join(rig.proj, '.git-x')) && fs.existsSync(path.join(rig.proj, '.git', 'config')),
        `.git must not be movable\n${said}`);

      assert.equal(read(path.join(store, 'p', 's.jsonl')), '{}\n', `a transcript must land through a symlinked projects\n${said}`);
      assert.equal(read(path.join(C, '.credentials.json')), 'refreshed\n', `credentials must be refreshable\n${said}`);
      assert.equal(read(path.join(rig.proj, 'src.js')), 'export {}\n', `a source file must be written\n${said}`);
      assert.equal(git(rig.proj, 'log', '--format=%s', '-1'), 'src', `a commit must land\n${said}`);
      assert.match(said, /resolv-conf: written/, 'the resolver configuration must be readable');
    } finally {
      rig.cleanup();
    }
  });
