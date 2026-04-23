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
- **Stateless rendering.** Every page render reads from the on-disk JSON
  snapshots and rollups. Hot-reload the binary and the UI picks up immediately.
- **One binary.** `bun build --compile` produces a self-contained executable
  per platform. Linux needs `mtr` in `PATH`; that's it. `engine='native'` also
  requires a glibc Linux (the built-in prober `dlopen`s `libc.so.6` via
  `bun:ffi`) - on musl distros (Alpine) stay on the default `engine='mtr'`.

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
  handshake, TCP connect, IRTT, etc.). hopwatch currently only runs MTR.
- **Distributed master/slave topology.** SmokePing has first-class support
  for slaves reporting back to a central master. hopwatch only links peers
  via URL in the top-nav; each instance stores its own data.
- **Email/paging alerts with pattern matching.** SmokePing's alert rules and
  matchers (`>U 2 20%`, etc.) are a whole language. hopwatch has none of that,
  and probably never will - alerting belongs in the alerting system you
  already run.
- **Decade-plus historical rollups on a small disk.** rrdtool's pre-sized
  round-robin archives are hard to beat for long retention on tiny storage.
  hopwatch keeps raw snapshots on disk (pruned at `keep_days`) plus
  JSON hourly/daily rollups - correct and human-readable, but bulkier.
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
