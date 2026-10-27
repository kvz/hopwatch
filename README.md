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
# Loopback by default; set to "0.0.0.0:8080" to expose on every interface.
listen  = "127.0.0.1:8080"
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
# Loopback by default - the nginx recipe below terminates TLS and forwards to
# 127.0.0.1:8080. Drop the listen line or set it to "0.0.0.0:8080" if you want
# to expose the daemon directly (not recommended without an auth proxy).
listen   = "127.0.0.1:8080"
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
Description=hopwatch - SmokePing-style MTR monitor
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
# NoNewPrivileges=true and RestrictSUIDSGID=true would both block mtr-tiny's
# setuid mtr-packet helper from elevating, which is exactly how the
# unprivileged `hopwatch` user runs traceroutes in this recipe. Leave them
# off if you rely on the setuid path. If you instead give hopwatch
# CAP_NET_RAW via AmbientCapabilities, you can re-enable both.
NoNewPrivileges=false
ReadWritePaths=/var/lib/hopwatch
LockPersonality=true
RestrictRealtime=true
RestrictNamespaces=true
RestrictSUIDSGID=false
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

## Fast sentinels and external alerts

Full MTR targets keep their existing 900-second cadence. To capture short outages,
add a **separate** TCP-connect target with an explicit `interval_seconds`:

```toml
[metrics]
enabled = true                  # optional /metrics endpoint; disabled by default

[[target]]
id = "s3-eu-sentinel"
label = "S3 EU sentinel"
host = "s3.eu-west-1.amazonaws.com"
engine = "connect"
protocol = "tcp"
port = 443
interval_seconds = 30
packets = 3                     # optional, 3–5; defaults to 3 for sentinels
```

An explicit target interval opts into the sentinel scheduler: minimum 30 seconds,
at most six targets, one independent slot per target, jitter capped at two seconds,
and a ten-second deadline including DNS. A slow MTR cannot occupy a sentinel slot;
a target never overlaps itself. DNS is resolved once per sample with a two-second
budget, then connections to that IP share the remaining deadline. TCP refusal and
timeout count as destination loss; DNS, socket setup and collector errors are
recorded as collector failures. This measures TCP handshake availability, not HTTP,
TLS, DNS health or which network owner caused a failure. Intermediate-router loss
alone never contributes to these external destination-loss metrics.

At the maximum settings, six targets × five connects / 30 seconds is one new TCP
connection per second on average, with at most six active connect attempts.
Sentinels retain only 24 hours of small raw snapshots (about 2,881 per target at
30 seconds) and do not generate rollups. Pruning also removes their hop, event and
RTT rows. Full traceroute targets retain their existing raw/rollup history. Keep
both target entries when you need fast detection and long-term path diagnostics.
If an existing ID is converted, its sentinel charts use current raw samples;
previous rollups remain stored but are not used by the sentinel views.

Every new snapshot, including collector failures, carries ISO UTC `startedAt`,
`finishedAt`, `scheduledAt`, a separate `cycleId`, `destinationIp` when known, and
explicit engine/protocol. `collectedAt` and the filename now identify the target's
actual start, rather than when it entered the cycle queue. JSON raw `sent`/`reply`
events from connect and native engines carry monotonic `offsetMs` relative to
`startedAt`. These are application observations, not packet-capture timestamps.
MTR's buffered raw output does not provide event times: those offsets remain absent,
so use its target start/end range rather than inferring packet times from event
order. The target page shows actual ranges and gaps between samples. Old snapshots
remain readable and explicitly show that actual timing is unavailable. Existing
relational SQLite databases receive nullable columns automatically; no history is
rewritten. Collector failures are visible as gaps and excluded from loss rollups.

When enabled, `GET /metrics` exposes Prometheus text gauges for every configured
target, including targets without any samples. It supplies destination loss and
latency, last sample and last successful sample timestamps, latest collector
failure, retained-history collector-failure count, and consecutive failed/loss
sample counts (capped at two). Counters here are **gauges**, not lifetime totals;
pruning reduces the retained failure count. A successful sample means at least one
destination reply. Missing timestamps are zero and unavailable loss/latency is
`NaN`. State is read from SQLite, so repeated scrapes cannot count the same bad
probe twice and restarting the daemon preserves evidence.

Route alerts in your existing Prometheus/Grafana/Alertmanager installation. For
30-second sentinels, suggested expressions are:

```promql
# Two successive samples with >=50% destination loss, while samples are fresh.
(hopwatch_consecutive_destination_loss_samples{sentinel="true"} >= 2)
  and (time() - hopwatch_sample_timestamp_seconds{sentinel="true"} <= 90)

# Two failed samples, with the latest caused by a collector/DNS error.
(hopwatch_consecutive_failed_samples{sentinel="true"} >= 2)
  and (hopwatch_collector_failure{sentinel="true"} == 1)

# Missing or stale samples are a different alert from network loss.
time() - hopwatch_sample_timestamp_seconds{sentinel="true"} > 90
```

Also alert on Prometheus `up == 0` for the observer: an unreachable daemon cannot
report its own staleness. With 30-second cadence, two seconds of jitter and a
ten-second deadline, two failed samples are available within **74 seconds** of
outage onset across scheduler phases, assuming the daemon/event loop and storage
are responsive. Tests simulate 90-second and two-minute failures across phases.
Collection and rendering share the daemon event loop; heavy synchronous work can
delay these application observations, which is why actual ranges and gaps matter.
Budget external scraping and evaluation separately: 15-second scrapes plus
15-second evaluations add up to 30 seconds (up to 104 seconds to alert evaluation),
before any Alertmanager grouping or notification delay. No webhook, Slack or
PagerDuty calls are made by hopwatch. The metrics endpoint is off unless enabled;
use the same trusted network/auth proxy as the dashboard.

For api2's `scripts/configs/hopwatch.sh`, after Kevin approves a release and rollout:
keep `[probe] interval_seconds = 900` and the existing MTR entries, emit
`[metrics] enabled = true` in the generated TOML, and add up to six distinct
connect sentinel entries. Start with S3 EU TCP/443, an independent public HTTPS
control and a local Hetzner HTTPS control (for example `fsn1.your-objectstorage.com`).
Connect does not support `probe_mode = "netns"`; keep existing namespace MTR targets
and pair faster namespace checks only when a supported engine is available. Add
an authenticated scrape of the observer's proxied `/hopwatch/metrics`, and configure
external routing/rules. Updating the installed binary, observer configuration,
alert routing and any diagnostic-on-alert workflow are separate operational steps.

## How it looks

Same plot conventions as SmokePing: smoke bands (interquartile range),
loss-colored median markers, pink major grid, dashed minor grid, and the
rotated `RRDTOOL / TOBI OETIKER` signature on the right edge (kept as
[attribution](./NOTICE)).

Per-target pages add three SmokePing-can't-do-this panels on top of the
per-hop rollup (hourly MTR aggregates, 90d retention):

- **Per-hop heatmap (30h).** One row per unique router hostname (sorted
  by traceroute position), one column per hourly bucket. Cell fill uses
  the SmokePing loss palette; a neutral gray fills `(host × bucket)`
  pairs where that router wasn't observed. ECMP siblings collapse into
  one row with a `[5–6]` hop-index range label. Makes it obvious which
  hop is flapping without eyeballing every mini-chart.
- **Loss funnel (7d).** One bar per hop in path order, colored by
  weighted loss (aggregated sent/reply across the window, not an average
  of averages). Tells you at a glance whether loss is introduced by the
  first-mile CPE, a transit peer, or only the destination.
- **Event timeline (10d).** Ticks for severe destination loss (≥50%),
  path changes (host set shifted between buckets), and first-sighting
  new hops. Three lanes so the kinds stay visually distinct.

## Architecture

- **Single daemon.** `hopwatch daemon` runs probes on an internal scheduler
  and serves the HTTP UI from the same process. No cron, no systemd timers,
  no separate render worker.
- **12-factor.** Config via TOML. Log to stdout in simple structured format.
  Graceful shutdown on SIGTERM. Let systemd handle the background, logging,
  and privileges.
- **SQLite source of truth.** Probe snapshots, hop rows, raw probe events, RTT
  samples, and rollups are stored in relational SQLite tables. Page renders read
  live data directly from SQLite without an HTML cache, so hot-reloaded binaries
  and new probe cycles are visible immediately.
- **SQLite-native verification.** `hopwatch storage verify` checks the live
  database for integrity, legacy blob columns, and orphaned relational rows.
- **One binary.** `bun build --compile` produces a self-contained executable
  per platform. Linux needs `mtr` in `PATH`; that's it. `engine='native'` also
  requires a glibc Linux (the built-in prober `dlopen`s `libc.so.6` via
  `bun:ffi`) - on musl distros (Alpine) stay on the default `engine='mtr'`.

### SQLite storage

SQLite is the runtime storage backend and source of truth. The database stores
snapshots and rollups as rows and reconstructs raw text or JSON responses on
demand from those rows. Legacy JSON snapshot files and JSON-blob SQLite schemas
were one-time migration formats; current builds intentionally do not support
them.

```bash
# Verify SQLite integrity and relational consistency.
hopwatch storage verify --config /etc/hopwatch/hopwatch.toml
```

To place the database somewhere other than `<data_dir>/hopwatch.sqlite`:

```toml
[storage]
sqlite_path = "/var/lib/hopwatch/hopwatch.sqlite"
```

## Building from source

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun run check    # lint, typecheck, tests
bun run dev      # run against ./hopwatch.example.toml
bun run build    # cross-compile bin-build/hopwatch-{target}
```

## Contributing

### Proposing a change

1. Branch from `main` and commit your work.
2. Add a changeset describing the user-visible effect - `bun run changeset`
   (interactive) or drop a `.changeset/<slug>.md` file like:

   ```markdown
   ---
   "hopwatch": patch
   ---

   One-line summary of the change that belongs in the release notes.
   ```

   Pick `patch` for fixes, `minor` for additive features, `major` for
   breaking changes. No changeset is needed for doc-only or infra-only
   PRs; the release workflow simply won't open a Version Packages PR for
   them.
3. Run `bun run check` locally and open the PR. CI runs format, lint,
   typecheck, and vitest (including SmokePing pixel-parity fixtures).
4. Squash-merge once green. Commit history on `main` stays linear.

### One-time repo setup

The release pipeline requires two non-default repo settings. A fork or
a freshly-created clone needs these flipped before the first release
will land - without them the `release` workflow fails at "Create Release
Pull Request" with `HttpError: GitHub Actions is not permitted to create
or approve pull requests`:

```bash
gh api --method PUT repos/<owner>/<repo>/actions/permissions/workflow \
  -f default_workflow_permissions=write \
  -F can_approve_pull_request_reviews=true
```

(or in the UI: **Settings → Actions → General → Workflow permissions →
Read and write permissions** *and* check **Allow GitHub Actions to
create and approve pull requests**).

### Cutting a release

Releases are fully automated via [changesets](https://github.com/changesets/changesets)
and GitHub Actions. You do not touch `package.json#version` or git tags by
hand.

1. **Merge a PR with a changeset into `main`.** The `release` workflow
   (`.github/workflows/release.yml`) opens (or updates) a pull request
   titled `chore: release` that bumps `package.json#version` and folds
   the pending `.changeset/*.md` entries into `CHANGELOG.md`.
2. **Review and merge the `chore: release` PR.** On merge, the same
   workflow runs `changeset tag` (creates the `vX.Y.Z` git tag),
   publishes a GitHub Release with the generated changelog, and then
   calls the `binaries` workflow via `workflow_call`.
3. **`binaries.yml` cross-compiles the matrix** -
   `linux-{x64,arm64}` and `darwin-{x64,arm64}` - using
   `bun build --compile --target=bun-<target>` and attaches each
   `hopwatch-<os>-<arch>.tar.gz` plus its `.sha256` to the release.
4. **Verify the release.** The install commands in the [Quick start](#quick-start)
   and [Production install](#production-install-on-ubuntu) sections pull
   from `releases/latest/download/...`, so a healthy release makes both
   recipes work without edits. A quick end-to-end check:

   ```bash
   # Pick the asset matching your machine, e.g. hopwatch-linux-x64.
   asset="hopwatch-darwin-arm64"
   base="https://github.com/<owner>/<repo>/releases/latest/download/${asset}.tar.gz"
   tmp=$(mktemp -d) && cd "$tmp"
   curl -fsSL -O "${base}" && curl -fsSL -O "${base}.sha256"
   shasum -a 256 -c "${asset}.tar.gz.sha256"   # "OK"
   tar -xzf "${asset}.tar.gz" && ./hopwatch --version
   ```

   The printed version should match the tag you just released.

> **Note - the `chore: release` PR has no CI checks.** The
> changesets-created PR is authored by `GITHUB_TOKEN`, and GitHub
> intentionally does not trigger downstream workflows for events emitted
> by that token (otherwise workflows could loop). This means `check.yml`
> never runs on the Version Packages PR. That's safe here because the
> PR only mutates `package.json#version` and `CHANGELOG.md` - CI
> already ran green on the source PR before it hit `main`.

If the `binaries` job fails after the release is already tagged, fix
the workflow and re-run it via
`gh workflow run binaries.yml -f tag=vX.Y.Z` - the job uploads with
`--clobber` so re-running is idempotent. If the release itself is bad
(e.g. wrong changelog, wrong version), delete the tag and release in the
GitHub UI, revert the `chore: release` commit, and start over from a
fresh Version Packages PR.

### Local release dry run

```bash
bun run changeset:version   # simulate the version bump locally
git diff                    # inspect package.json + CHANGELOG.md
git checkout -- .           # discard; let CI do the real thing
```

## Visual regression testing

We pin pixel-output parity against SmokePing reference PNGs stored under
`src/test/fixtures/smokeping/`. Each fixture's locked `mismatchPct` and
`rmsDelta` live in `fixtures.json` alongside the points + reference PNG
that produced them. The vendored DejaVu Mono font under `vendor/fonts/`
keeps rasterization reproducible across CI and workstations:

```bash
bun run test                                         # normal run (CI + local)
bun run test:docker                                  # parity with CI
UPDATE_PARITY_BASELINE=1 bun run test -- chart-parity # relock after an intentional change
bun run scripts/update-smokeping-fixtures.ts          # regenerate points from RRDs
```

CI fails if any fixture's mismatchPct or rmsDelta drifts outside the
per-manifest `tolerancePct` / `toleranceRms` of its locked value - in
either direction, so improvements must be re-locked explicitly rather
than silently banked. On failure the rendered vs reference diff PNGs are
uploaded as CI artifacts.

## hopwatch vs SmokePing

hopwatch does not replace SmokePing - it covers the subset most operators use
day-to-day (MTR-based latency + loss graphs for a list of targets) in a form
that's easier to drop onto a host. Pick whichever matches your situation.

**Pick hopwatch when you want…**

- **One binary, one process.** `bun build --compile` produces a
  self-contained executable - no Perl, no rrdtool, no Apache/CGI, no FastCGI
  slaves. `mtr` in `PATH` is the only runtime dependency.
- **Raw trace logs you can read.** Every probe cycle writes a per-snapshot
  JSON with the full MTR event stream (`x`/`h`/`d`/`p` lines). Network
  engineers can open the snapshot on disk and see what actually happened on
  each hop - something rrdtool's binary RRAs do not give you.
- **A familiar SmokePing look.** Same plot conventions - smoke bands,
  loss-colored median markers, pink major grid, rotated RRDTOOL signature -
  so a busy netop can read the chart without context-switching.

**Stick with SmokePing when you need…**

- **Non-MTR probes.** SmokePing ships dozens of probes (HTTP, DNS, SSH, SSL
  handshake, TCP connect, IRTT, etc.). hopwatch provides traceroute and TCP-connect measurements.
- **Distributed master/slave topology.** SmokePing has first-class support
  for slaves reporting back to a central master. hopwatch only links peers
  via URL in the top-nav; each instance stores its own data.
- **Email/paging alerts with pattern matching.** SmokePing's alert rules and
  matchers (`>U 2 20%`, etc.) are a whole language. hopwatch exposes optional Prometheus gauges for external alerting;
  pattern matching and notification routing belong in the alerting system you already run.
- **Decade-plus historical rollups on a tiny disk.** rrdtool's pre-sized
  round-robin archives are hard to beat for long retention on constrained
  storage. hopwatch keeps recent raw snapshots plus hourly/daily rollups in
  SQLite - easier to query and migrate, but not as compact as RRAs.
- **The ecosystem.** Plugins, recipes, Stack Overflow answers, existing
  Puppet/Ansible modules - SmokePing has a 20-year head start.

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
