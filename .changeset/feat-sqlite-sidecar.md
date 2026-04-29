---
'hopwatch': minor
---

feat: add an opt-in SQLite sidecar for safe storage migration.

Hopwatch can now import existing JSON snapshots into `data_dir/hopwatch.sqlite`, verify the
database against the JSON source of truth by count and SHA-256, and optionally dual-write new
snapshots to SQLite while leaving the current JSON read-path intact. This is the first safe step
toward moving expensive dashboard reads away from thousands of small snapshot files without
deleting or replacing existing data.
