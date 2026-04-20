# hopwatch

**SmokePing-style network latency and packet-loss monitoring. Native TypeScript, single binary, TOML configured, systemd-ready.**

hopwatch runs MTR probes against a list of network targets at a fixed cadence,
stores per-snapshot JSON on disk, and serves a live-rendered web dashboard that
looks like SmokePing (because operators already know how to read SmokePing).
It is a single-binary daemon. No Perl, no rrdtool, no database required.

> **Status: pre-release.** First tag is `v0.1.0`. API, config schema, and
> on-disk layout may change before `v1.0.0`. See [`ROADMAP.md`](./ROADMAP.md).

## Quick start

```bash
# Download the latest release for your platform
curl -fsSL https://github.com/kvz/hopwatch/releases/latest/download/hopwatch-linux-x64.tar.gz | tar -xz

# Write a config
cat > hopwatch.toml <<'EOF'
[server]
listen  = ":8080"
data_dir = "./hopwatch-data"

[probe]
interval_seconds = 900    # 15 minutes, matching SmokePing's default
packets          = 20
mtr_bin          = "mtr"

[[target]]
id       = "cloudflare"
label    = "Cloudflare public"
host     = "cloudflare.com"

[[target]]
id       = "google-dns"
label    = "Google DNS"
host     = "8.8.8.8"

[[peer]]
id    = "eu"
url   = "https://hopwatch-eu.example.com"
label = "EU"

[[peer]]
id    = "us"
url   = "https://hopwatch-us.example.com"
label = "US"
EOF

# Run it
./hopwatch daemon --config hopwatch.toml
# → http://localhost:8080
```

## How it looks

Same plot conventions as SmokePing: smoke bands (interquartile range),
loss-colored median markers, pink major grid, dashed minor grid, and the
rotated `RRDTOOL / TOBI OETIKER` signature on the right edge (kept as
[attribution](./NOTICE)).

## Architecture

- **Single daemon.** `hopwatch daemon` runs probes on an internal scheduler
  and serves the HTTP UI from the same process. No cron, no systemd timers,
  no separate render worker.
- **12-factor.** Config via TOML. Log to stdout in simple structured format.
  Graceful shutdown on SIGTERM. Let systemd handle the background, logging,
  and privileges.
- **Stateless rendering.** Every page render reads from the on-disk JSON
  snapshots and rollups. Hot-reload the binary and the UI picks up immediately.
- **One binary.** `bun build --compile` produces a self-contained executable
  per platform. Linux needs `mtr` in `PATH`; that's it.

## Building from source

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun run check    # lint, typecheck, tests
bun run dev      # run against ./hopwatch.example.toml
bun run build    # cross-compile bin-build/hopwatch-{target}
```

## Visual regression testing

We pin pixel-output parity against SmokePing reference PNGs (stored under
`src/test/fixtures/real-ap/`) with a per-fixture mismatch budget in
`src/test/parity-baseline.json`. Tests run inside a Docker image with a
pinned DejaVu font set so results are reproducible across CI and
workstations:

```bash
bun run test             # bare-metal, fast loop
bun run test:docker      # parity with CI
```

CI fails if any fixture drifts more than the tolerated mismatch or RMS delta.
On failure the rendered vs reference diff PNGs are uploaded as CI artifacts.

## Attribution

hopwatch is a clean-room re-implementation inspired by
[SmokePing](https://oss.oetiker.ch/smokeping/) and
[rrdtool](https://oss.oetiker.ch/rrdtool/), both by Tobi Oetiker. No SmokePing
or rrdtool source is included. See [`NOTICE`](./NOTICE) for full
acknowledgements.

## License

[MIT](./LICENSE).
