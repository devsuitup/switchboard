# Build and release workflow

`.github/workflows/build.yml` uses one event-dependent `build` matrix. PRs
include Windows, Linux x64 and Linux arm64; version-tag pushes also include
macOS. The JSON arrays in `matrix.include` must keep the non-mac entries in
sync. Each matrix job has `timeout-minutes: 60`, including macOS.

`publish` keeps `needs: build` and the default success gate. A failed or
cancelled macOS tag build blocks automatic publication; no partial-publish or
`continue-on-error` path exists. Recovery and manifest consistency requirements
are in [releasing.md](../../docs/releasing.md).

Windows stays pinned to `windows-2022`: the Server 2025 image behind
`windows-latest` lacks the Visual Studio C++ toolchain needed by node-gyp for
node-pty. Linux stays split by architecture because electron-builder's native
module rebuild between architectures applies only to the first target type;
multiple targets in one multi-architecture invocation can reuse modules from
the wrong architecture (issue #18).

`test/build-workflow.test.js` parses the actual workflow using `js-yaml` and
evaluates its expression for a PR and a tag push. It checks the exact matrices,
timeout, triggers, failure propagation configuration and strict publish
dependency. It evaluates the expression as JavaScript, not with the Actions
expression engine, so it is a configuration guard only: the proof that Actions
accepts the expression is a PR run's job list (no mac job), and the tag branch
is first seen at the next tag. It does not verify runner queue behavior either;
`timeout-minutes` bounds a hung build on a runner, not time spent queued.

Trade-off: the macOS-only "Test postinstall helpers" step now runs on tags
only. Its test files still run on Linux and Windows through `test.yml`; a
darwin-only regression in `postinstall.js` first shows at tag time, where it
blocks `publish`.
