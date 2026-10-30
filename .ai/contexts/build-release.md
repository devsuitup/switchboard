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
dependency. This is local configuration evidence; it does not run Actions or
verify runner queue behavior.
