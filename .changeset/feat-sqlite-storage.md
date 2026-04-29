---
'hopwatch': minor
---

feat: make SQLite the Hopwatch storage source of truth.

Hopwatch now stores snapshots, raw probe events, hop summaries, RTT samples, and rollups in
relational SQLite tables instead of JSON blobs. The daemon renders directly from SQLite without the
old file-backed read path, and `hopwatch storage verify` now checks SQLite integrity and relational
consistency without depending on legacy JSON files.
