# Roadmap

This captures deliberate deferrals: things we know we want, that we're not
building in the initial release to keep scope tight.

## After v0.1

- **SQLite backend for snapshots and rollups.** Today every snapshot is a
  JSON file on disk. That's fine up to a few hundred targets over a year;
  a single SQLite file scales better, supports richer queries (range,
  aggregates), and survives `rm -rf ./data/some-slug/` accidents.
- **IPv6 probing.** `hopwatch` only speaks IPv4 today. Adding `probe_mode = "ipv6"`
  in TOML and passing `-6` through to `mtr` is small; validating against
  real dual-stack targets is the work.
- **Alert sinks.** Built-in webhook + Slack + PagerDuty outputs for
  sustained-loss conditions. Today alerting is external: operators read
  the dashboard or scrape the JSON.
- **Per-target probe cadence.** Currently one global interval. Useful to
  probe noisy WAN targets every 5 minutes and stable internal targets
  every hour.
- **Peer-aware UI.** Nodes dropdown already shows peers; the next step is
  showing the same target as seen from multiple peers side-by-side on
  one page. Needs a peer-to-peer JSON read API.
- **Authentication.** Right now the HTTP server is open. Bearer token
  header check is a 10-line addition; OIDC is a bigger lift.
- **Probe modes beyond MTR.** TCP-syn, HTTP-get, DNS-A, TLS-handshake.
  Keeps the name `hopwatch` honest but requires abstracting the
  "packet loss and RTT over time" data model away from MTR specifics.
- **Retention policies per target.** Today keep-days is global.

## Maybe

- **Grafana plugin.** Read hopwatch's JSON from Grafana to unify with
  other dashboards. Deferred until the JSON schema stabilizes.
- **Prometheus `/metrics` endpoint.** Expose p50/p90/loss per target for
  alerting pipelines that prefer pull-based metrics.

## Not planned

- Re-implementing SmokePing's per-target `.rrd` storage. The whole point
  of hopwatch is to move past RRD's fixed-cadence, lossy-aggregation
  model. If you want RRD, run SmokePing.
- A web-based target editor. Keep config declarative (TOML + git) so it's
  reviewable and version-controllable.
