---
'hopwatch': minor
---

feat: TCP-SYN probe support, for both the `mtr` and `native` engines.

Targets gain two new config fields: `protocol = "icmp" | "tcp"` (default `icmp`) and `port` (default `443`, consulted only when protocol is `tcp`). ICMP-only probing can silently report a healthy path while real HTTPS traffic experiences tens of percentage points of loss - this was observed on a Hetzner SIN → AWS us-west-2 route where ICMP showed 0% destination loss and TCP 443 showed ~50%. Adding a `s3-us-west-2-tcp` target alongside the existing ICMP target now surfaces this divergence on the dashboard.

- `engine = "mtr"`: hopwatch passes `--tcp -P <port>` to the external mtr binary.
- `engine = "native"`: new `prober-native-tcp.ts` drives kernel TCP sockets with non-blocking `connect()` and varying `IP_TTL`, and captures ICMP Time Exceeded from a separate raw `IPPROTO_ICMP` socket (requires `CAP_NET_RAW`). The emitted event stream matches the ICMP native prober and the mtr parser, so downstream rollup aggregation and chart rendering are unchanged.

IPv6 TCP probing is validated-rejected at config load - we haven't exercised it against real v6 paths yet.
