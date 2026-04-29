# hopwatch

## 0.4.1

### Patch Changes

- 3418ea5: Show cached hop owner/contact enrichment in cross-target diagnoses and add a copy escalation action.
- 9e23eb1: Surface protocol-selective S3 TCP loss across probe variants in the cross-target diagnosis.

## 0.4.0

### Minor Changes

- 8c85104: feat: make SQLite the Hopwatch storage source of truth.

  Hopwatch now stores snapshots, raw probe events, hop summaries, RTT samples, and rollups in
  relational SQLite tables instead of JSON blobs. The daemon renders directly from SQLite without the
  old file-backed read path, and `hopwatch storage verify` now checks SQLite integrity and relational
  consistency without depending on legacy JSON files.

### Patch Changes

- 8c85104: fix: bump `Bun.serve` `idleTimeout` to 240s so busy observers do not 502 while rendering dashboards.

  Bun's default `idleTimeout` is 10s. With 27 targets × 14 days of accumulated snapshots, the root dashboard render legitimately took 12–29s on production observers, so Bun was closing the connection before any bytes were written and haproxy turned that into a 502. Setting `idleTimeout: 240` (4 minutes; Bun caps it at 255s) restores headroom without masking real hangs.

  SQLite-backed rendering is expected to keep live dashboard reads fast enough without an HTML cache.

## 0.3.0

### Minor Changes

- 04ff151: feat: derive the target probe-variant pill from structured fields.

  Operators no longer hand-encode the probe shape into target labels (the config that produced `"Amazon S3 us-west-2 (TCP 443, mtr)"` next to `"Amazon S3 us-west-2 via Namespace"` next to `"Amazon S3 us-west-2 (s3.us-west-2.amazonaws.com)"`). A small `variant-pill` is derived at render time from the `(protocol, port, engine, probe_mode, netns)` the operator already set, and rendered next to the label on both the root index and each target page. The default ICMP/mtr/no-netns case produces no pill, so vanilla targets stay quiet.

  The stored snapshot schema gains `engine`, `netns`, and `port` (all optional with sensible defaults for backward compatibility). This lets the renderer compose the pill from the snapshot alone without re-reading the live TOML.

### Patch Changes

- b626189: fix: truncate long hostnames in the "Most suspicious hop (7d)" cell with ellipsis + hover tooltip, so a couple of rows with lengthy `name (ip)` values can no longer push the root-index table past the viewport and hide the mini-chart column off the right edge. Full hostname remains available via the browser's native `title` tooltip on hover.

## 0.2.0

### Minor Changes

- 97ad1d9: feat: TCP-SYN probe support, for both the `mtr` and `native` engines.

  Targets gain two new config fields: `protocol = "icmp" | "tcp"` (default `icmp`) and `port` (default `443`, consulted only when protocol is `tcp`). ICMP-only probing can silently report a healthy path while real HTTPS traffic experiences tens of percentage points of loss - this was observed on a Hetzner SIN → AWS us-west-2 route where ICMP showed 0% destination loss and TCP 443 showed ~50%. Adding a `s3-us-west-2-tcp` target alongside the existing ICMP target now surfaces this divergence on the dashboard.

  - `engine = "mtr"`: hopwatch passes `--tcp -P <port>` to the external mtr binary.
  - `engine = "native"`: new `prober-native-tcp.ts` drives kernel TCP sockets with non-blocking `connect()` and varying `IP_TTL`, and captures ICMP Time Exceeded from a separate raw `IPPROTO_ICMP` socket (requires `CAP_NET_RAW`). The emitted event stream matches the ICMP native prober and the mtr parser, so downstream rollup aggregation and chart rendering are unchanged.

  IPv6 TCP probing is validated-rejected at config load - we haven't exercised it against real v6 paths yet.

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
