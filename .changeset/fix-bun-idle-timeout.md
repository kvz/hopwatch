---
'hopwatch': patch
---

fix: bump `Bun.serve` `idleTimeout` to 240s and cache rendered dashboards so busy observers do not 502 while walking retained snapshots.

Bun's default `idleTimeout` is 10s. With 27 targets × 14 days of accumulated snapshots, the root dashboard render legitimately took 12–29s on production observers, so Bun was closing the connection before any bytes were written and haproxy turned that into a 502. Setting `idleTimeout: 240` (4 minutes; Bun caps it at 255s) restores headroom without masking real hangs.

The daemon now also caches rendered root and target dashboard HTML in memory, clears that cache when a probe cycle finishes, and warms the root dashboard after the cycle. That turns repeat dashboard opens into memory reads and moves the expensive snapshot walk off the browser request path.
