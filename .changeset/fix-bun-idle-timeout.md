---
'hopwatch': patch
---

fix: bump `Bun.serve` `idleTimeout` to 240s so busy observers do not 502 while rendering dashboards.

Bun's default `idleTimeout` is 10s. With 27 targets × 14 days of accumulated snapshots, the root dashboard render legitimately took 12–29s on production observers, so Bun was closing the connection before any bytes were written and haproxy turned that into a 502. Setting `idleTimeout: 240` (4 minutes; Bun caps it at 255s) restores headroom without masking real hangs.

SQLite-backed rendering is expected to keep live dashboard reads fast enough without an HTML cache.
