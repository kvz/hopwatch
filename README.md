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

## Production install on Ubuntu

An A-to-Z recipe for the latest Ubuntu LTS. Assumes you are root (use `sudo -i`
or prefix each command with `sudo`). After this the daemon runs under its own
unprivileged user, probes with the system `mtr`, logs to the journal, and
restarts on failure.

```bash
# 1. Runtime deps. mtr-tiny ships a setuid helper (mtr-packet) so unprivileged
# users can run traceroutes without granting CAP_NET_RAW to hopwatch itself.
apt-get update
apt-get install -y mtr-tiny curl tar ca-certificates

# 2. Dedicated system user. No shell, no home dir, owns the state dir.
adduser --system --group --no-create-home --home /var/lib/hopwatch hopwatch

# 3. Binary. Replace the URL with the asset for your architecture.
curl -fsSL https://github.com/kvz/hopwatch/releases/latest/download/hopwatch-linux-x64.tar.gz \
  | tar -xz -C /usr/local/bin
chmod 0755 /usr/local/bin/hopwatch

# 4. Directories. /etc/hopwatch holds the config; /var/lib/hopwatch holds
# snapshots and rollups.
install -d -o root -g root -m 0755 /etc/hopwatch
install -d -o hopwatch -g hopwatch -m 0750 /var/lib/hopwatch

# 5. Config.
cat > /etc/hopwatch/hopwatch.toml <<'EOF'
[server]
listen   = ":8080"
data_dir = "/var/lib/hopwatch"
node_label = "observer-1"

[probe]
interval_seconds = 900
packets          = 20
keep_days        = 14
mtr_bin          = "mtr"

[[target]]
id    = "cloudflare"
label = "Cloudflare public"
host  = "cloudflare.com"

[[target]]
id    = "google-dns"
label = "Google DNS"
host  = "8.8.8.8"
EOF

# 6. systemd unit. stdout goes to the journal; sandboxing flags are opinionated
# but safe for the default MTR probe mode (netns probe mode needs additional
# capabilities and is outside the scope of this recipe).
cat > /etc/systemd/system/hopwatch.service <<'EOF'
[Unit]
Description=hopwatch — SmokePing-style MTR monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hopwatch
Group=hopwatch
ExecStart=/usr/local/bin/hopwatch daemon --config /etc/hopwatch/hopwatch.toml
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

# Sandboxing. Relax these (or drop them) if you use probe_mode = "netns".
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
NoNewPrivileges=true
ReadWritePaths=/var/lib/hopwatch
LockPersonality=true
RestrictRealtime=true
RestrictNamespaces=true
RestrictSUIDSGID=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF

# 7. Validate the config before enabling, then start.
sudo -u hopwatch /usr/local/bin/hopwatch config-check \
  --config /etc/hopwatch/hopwatch.toml

systemctl daemon-reload
systemctl enable --now hopwatch.service

# 8. Tail logs and confirm it's up.
journalctl -u hopwatch -f
# → http://<host>:8080
```

To upgrade later: drop the new binary into `/usr/local/bin/hopwatch`, then
`systemctl restart hopwatch`. State in `/var/lib/hopwatch` is preserved.

### Putting it behind nginx (optional)

```nginx
server {
  listen 443 ssl;
  server_name hopwatch.example.com;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Bind hopwatch to loopback only (`listen = "127.0.0.1:8080"`) when fronting it
with nginx.

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

## hopwatch vs SmokePing

hopwatch does not replace SmokePing — it covers the subset most operators use
day-to-day (MTR-based latency + loss graphs for a list of targets) in a form
that's easier to drop onto a host. Pick whichever matches your situation.

**Pick hopwatch when you want…**

- **One binary, one process.** `bun build --compile` produces a
  self-contained executable — no Perl, no rrdtool, no Apache/CGI, no FastCGI
  slaves. `mtr` in `PATH` is the only runtime dependency.
- **Raw trace logs you can read.** Every probe cycle writes a per-snapshot
  JSON with the full MTR event stream (`x`/`h`/`d`/`p` lines). Network
  engineers can open the snapshot on disk and see what actually happened on
  each hop — something rrdtool's binary RRAs do not give you.
- **A familiar SmokePing look.** Same plot conventions — smoke bands,
  loss-colored median markers, pink major grid, rotated RRDTOOL signature —
  so a busy netop can read the chart without context-switching.

**Stick with SmokePing when you need…**

- **Non-MTR probes.** SmokePing ships dozens of probes (HTTP, DNS, SSH, SSL
  handshake, TCP connect, IRTT, etc.). hopwatch currently only runs MTR.
- **Distributed master/slave topology.** SmokePing has first-class support
  for slaves reporting back to a central master. hopwatch only links peers
  via URL in the top-nav; each instance stores its own data.
- **Email/paging alerts with pattern matching.** SmokePing's alert rules and
  matchers (`>U 2 20%`, etc.) are a whole language. hopwatch has none of that,
  and probably never will — alerting belongs in the alerting system you
  already run.
- **Decade-plus historical rollups on a small disk.** rrdtool's pre-sized
  round-robin archives are hard to beat for long retention on tiny storage.
  hopwatch keeps raw snapshots on disk (pruned at `keep_days`) plus
  JSON hourly/daily rollups — correct and human-readable, but bulkier.
- **The ecosystem.** Plugins, recipes, Stack Overflow answers, existing
  Puppet/Ansible modules — SmokePing has a 20-year head start.

In short: if you want a familiar-looking MTR dashboard that you can `scp` to
a box and run behind systemd in five minutes, and lets you observe the
traceroutes themselves, hopwatch. If you're already running SmokePing and
using its probes, alerts, or slave fan-out, there is no reason to switch.

## Attribution

hopwatch is a clean-room re-implementation inspired by
[SmokePing](https://oss.oetiker.ch/smokeping/) and
[rrdtool](https://oss.oetiker.ch/rrdtool/), both by Tobi Oetiker. No SmokePing
or rrdtool source is included. See [`NOTICE`](./NOTICE) for full
acknowledgements.

## License

[MIT](./LICENSE).
