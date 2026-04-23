---
'hopwatch': minor
---

feat: derive the target probe-variant pill from structured fields.

Operators no longer hand-encode the probe shape into target labels (the config that produced `"Amazon S3 us-west-2 (TCP 443, mtr)"` next to `"Amazon S3 us-west-2 via Namespace"` next to `"Amazon S3 us-west-2 (s3.us-west-2.amazonaws.com)"`). A small `variant-pill` is derived at render time from the `(protocol, port, engine, probe_mode, netns)` the operator already set, and rendered next to the label on both the root index and each target page. The default ICMP/mtr/no-netns case produces no pill, so vanilla targets stay quiet.

The stored snapshot schema gains `engine`, `netns`, and `port` (all optional with sensible defaults for backward compatibility). This lets the renderer compose the pill from the snapshot alone without re-reading the live TOML.
