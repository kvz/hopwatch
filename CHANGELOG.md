# hopwatch

## 0.1.1

### Patch Changes

- f30f667: fix: mini chart sparkline no longer clips in narrow table columns - the thumbnail now scales responsively and anchors left via `preserveAspectRatio="xMinYMid meet"`.

## 0.1.0

### Minor Changes

- ce11730: Initial pre-release: single-binary SmokePing-style MTR monitor.

  - `hopwatch daemon` runs probes on an in-process scheduler and serves the SmokePing-compatible UI from the same process.
  - `hopwatch probe-once` / `hopwatch render` / `hopwatch config-check` utility commands.
  - TOML config (`hopwatch.toml`) with `[server]`, `[probe]`, `[[target]]`, `[[peer]]` sections.
  - Chart parity validated against real SmokePing RRD fixtures (7 references, mismatch budgets per fixture).
  - Cross-compiled binaries for `linux-{x64,arm64}` and `darwin-{x64,arm64}` uploaded to GitHub Releases.
