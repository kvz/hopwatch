---
'hopwatch': minor
---

feat: make SQLite the Hopwatch storage source of truth.

Hopwatch now imports existing JSON snapshots and rollups into `data_dir/hopwatch.sqlite`, verifies
the database against the JSON migration source by count and SHA-256, and stores new snapshots, raw
probe events, hop summaries, RTT samples, and rollups in relational SQLite tables instead of JSON
blobs. The daemon renders directly from SQLite without the old file-backed read path, so migrated
observers can safely remove the legacy JSON files after verification.
