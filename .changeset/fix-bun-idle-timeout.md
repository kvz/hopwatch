---
'hopwatch': patch
---

fix: bump `Bun.serve` `idleTimeout` to 240s so the root dashboard render does not get cut off mid-flight on busier observers.

Bun's default `idleTimeout` is 10s. With 27 targets × 14 days of accumulated snapshots, the root dashboard render legitimately took 12–29s on production observers, so Bun was closing the connection before any bytes were written and haproxy turned that into a 502. Setting `idleTimeout: 240` (4 minutes; Bun caps it at 255s) restores headroom without masking real hangs.

A separate follow-up should make the dashboard render itself cheaper, but unblocking it on existing fleets needed shipping immediately.
