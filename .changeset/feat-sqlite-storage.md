---
'hopwatch': minor
---

feat: make SQLite the Hopwatch storage source of truth.

Hopwatch now imports existing JSON snapshots and rollups into `data_dir/hopwatch.sqlite`, verifies
the database against the JSON migration source by count and SHA-256, and stores new snapshots and
rollups directly in SQLite. The daemon renders directly from SQLite without the old file-backed
read path, so migrated observers can safely remove the legacy JSON files after verification.
