# hopwatch

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
