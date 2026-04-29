import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import type { Logger } from './logger.ts'
import { parseStoredRawSnapshot, type StoredRawSnapshot } from './raw.ts'
import { listSnapshotFileNames, parseStoredSnapshotSummary } from './snapshot.ts'

type SqliteModule = typeof import('bun:sqlite')
type SqliteDatabase = import('bun:sqlite').Database

interface ImportSnapshotInput {
  contents: string
  fileName: string
  sourcePath: string
  targetSlug: string
}

interface SnapshotSummaryColumns {
  destinationLossPct: number | null
  hopCount: number
  worstHopLossPct: number | null
}

interface PreparedSnapshotInput extends ImportSnapshotInput {
  importedAt: string
  rawSnapshot: StoredRawSnapshot
  sha256: string
  summary: SnapshotSummaryColumns
}

export interface SqliteImportFailure {
  error: string
  file: string
}

export interface SqliteImportResult {
  failed: SqliteImportFailure[]
  imported: number
  scanned: number
}

export interface SqliteVerifyTarget {
  fileCount: number
  sqliteCount: number
  targetSlug: string
}

export interface SqliteVerifyResult {
  extraInSqlite: string[]
  fileSnapshotCount: number
  missingInSqlite: string[]
  ok: boolean
  shaMismatches: string[]
  sqliteIntegrity: string
  sqliteSnapshotCount: number
  targets: SqliteVerifyTarget[]
}

interface SnapshotKey {
  fileName: string
  targetSlug: string
}

interface SnapshotCountRow {
  count: number
  target_slug: string
}

interface SnapshotHashRow {
  file_name: string
  sha256: string
  target_slug: string
}

interface IntegrityRow {
  integrity_check: string
}

let sqliteModulePromise: Promise<SqliteModule> | null = null

async function loadSqlite(): Promise<SqliteModule> {
  sqliteModulePromise ??= import('bun:sqlite')
  return sqliteModulePromise
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function snapshotKey(input: SnapshotKey): string {
  return `${input.targetSlug}/${input.fileName}`
}

function prepareSnapshotInput(input: ImportSnapshotInput): PreparedSnapshotInput {
  const rawSnapshot = parseStoredRawSnapshot(input.contents)
  const summary = parseStoredSnapshotSummary(input.contents)
  return {
    ...input,
    importedAt: new Date().toISOString(),
    rawSnapshot,
    sha256: sha256(input.contents),
    summary: {
      destinationLossPct: summary.destinationLossPct,
      hopCount: summary.hopCount,
      worstHopLossPct: summary.worstHopLossPct,
    },
  }
}

export class HopwatchSqliteStore {
  private constructor(private readonly db: SqliteDatabase) {}

  static async open(dbPath: string): Promise<HopwatchSqliteStore> {
    await mkdir(path.dirname(dbPath), { recursive: true })
    const { Database } = await loadSqlite()
    const store = new HopwatchSqliteStore(new Database(dbPath, { create: true, readwrite: true }))
    store.initialize()
    return store
  }

  close(): void {
    this.db.close()
  }

  initialize(): void {
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('PRAGMA synchronous = NORMAL')
    this.db.run('PRAGMA busy_timeout = 5000')
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS snapshots (
        target_slug TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        file_name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        json TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        observer TEXT NOT NULL,
        label TEXT NOT NULL,
        host TEXT NOT NULL,
        target TEXT NOT NULL,
        probe_mode TEXT NOT NULL,
        netns TEXT,
        protocol TEXT NOT NULL,
        port INTEGER NOT NULL,
        engine TEXT NOT NULL,
        raw_event_count INTEGER NOT NULL,
        hop_count INTEGER NOT NULL,
        destination_loss_pct REAL,
        worst_hop_loss_pct REAL,
        PRIMARY KEY (target_slug, file_name)
      )
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS snapshots_target_collected_at_idx
      ON snapshots (target_slug, collected_at DESC)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS snapshots_collected_at_idx
      ON snapshots (collected_at DESC)
    `)
    this.db
      .query<unknown, [string, string]>(
        'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
      )
      .run('schema_version', '1')
  }

  upsertSnapshot(input: ImportSnapshotInput): void {
    this.upsertPreparedSnapshot(prepareSnapshotInput(input))
  }

  upsertRawSnapshot(input: ImportSnapshotInput, rawSnapshot: StoredRawSnapshot): void {
    const summary = parseStoredSnapshotSummary(input.contents)
    this.upsertPreparedSnapshot({
      ...input,
      importedAt: new Date().toISOString(),
      rawSnapshot,
      sha256: sha256(input.contents),
      summary: {
        destinationLossPct: summary.destinationLossPct,
        hopCount: summary.hopCount,
        worstHopLossPct: summary.worstHopLossPct,
      },
    })
  }

  upsertPreparedSnapshots(inputs: PreparedSnapshotInput[]): void {
    const insertMany = this.db.transaction((snapshots: PreparedSnapshotInput[]) => {
      for (const snapshot of snapshots) {
        this.upsertPreparedSnapshot(snapshot)
      }
    })
    insertMany.immediate(inputs)
  }

  private upsertPreparedSnapshot(input: PreparedSnapshotInput): void {
    this.db
      .query<
        unknown,
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string | null,
          string,
          number,
          string,
          number,
          number,
          number | null,
          number | null,
        ]
      >(
        `
          INSERT INTO snapshots (
            target_slug,
            collected_at,
            file_name,
            source_path,
            sha256,
            json,
            imported_at,
            observer,
            label,
            host,
            target,
            probe_mode,
            netns,
            protocol,
            port,
            engine,
            raw_event_count,
            hop_count,
            destination_loss_pct,
            worst_hop_loss_pct
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(target_slug, file_name) DO UPDATE SET
            collected_at = excluded.collected_at,
            source_path = excluded.source_path,
            sha256 = excluded.sha256,
            json = excluded.json,
            imported_at = excluded.imported_at,
            observer = excluded.observer,
            label = excluded.label,
            host = excluded.host,
            target = excluded.target,
            probe_mode = excluded.probe_mode,
            netns = excluded.netns,
            protocol = excluded.protocol,
            port = excluded.port,
            engine = excluded.engine,
            raw_event_count = excluded.raw_event_count,
            hop_count = excluded.hop_count,
            destination_loss_pct = excluded.destination_loss_pct,
            worst_hop_loss_pct = excluded.worst_hop_loss_pct
        `,
      )
      .run(
        input.targetSlug,
        input.rawSnapshot.collectedAt,
        input.fileName,
        input.sourcePath,
        input.sha256,
        input.contents,
        input.importedAt,
        input.rawSnapshot.observer,
        input.rawSnapshot.label,
        input.rawSnapshot.host,
        input.rawSnapshot.target,
        input.rawSnapshot.probeMode,
        input.rawSnapshot.netns,
        input.rawSnapshot.protocol,
        input.rawSnapshot.port,
        input.rawSnapshot.engine,
        input.rawSnapshot.rawEvents.length,
        input.summary.hopCount,
        input.summary.destinationLossPct,
        input.summary.worstHopLossPct,
      )
  }

  getSnapshotCountsByTarget(): Map<string, number> {
    const rows = this.db
      .query<SnapshotCountRow, []>(
        'SELECT target_slug, COUNT(*) AS count FROM snapshots GROUP BY target_slug',
      )
      .all()
    return new Map(rows.map((row) => [row.target_slug, row.count]))
  }

  getSnapshotHashes(): Map<string, string> {
    const rows = this.db
      .query<SnapshotHashRow, []>('SELECT target_slug, file_name, sha256 FROM snapshots')
      .all()
    return new Map(
      rows.map((row) => [
        snapshotKey({ targetSlug: row.target_slug, fileName: row.file_name }),
        row.sha256,
      ]),
    )
  }

  integrityCheck(): string {
    return (
      this.db.query<IntegrityRow, []>('PRAGMA integrity_check').get()?.integrity_check ??
      'missing integrity_check result'
    )
  }
}

async function listTargetDirs(dataDir: string): Promise<string[]> {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return []
      throw err
    },
  )
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

async function collectFileHashes(dataDir: string): Promise<{
  countsByTarget: Map<string, number>
  hashes: Map<string, string>
  total: number
}> {
  const countsByTarget = new Map<string, number>()
  const hashes = new Map<string, string>()
  let total = 0

  for (const targetSlug of await listTargetDirs(dataDir)) {
    const targetDir = path.join(dataDir, targetSlug)
    const fileNames = await listSnapshotFileNames(targetDir)
    countsByTarget.set(targetSlug, fileNames.length)
    total += fileNames.length

    for (const fileName of fileNames) {
      const contents = await readFile(path.join(targetDir, fileName), 'utf8')
      hashes.set(snapshotKey({ fileName, targetSlug }), sha256(contents))
    }
  }

  return { countsByTarget, hashes, total }
}

export async function importSnapshotsFromDataDir(
  store: HopwatchSqliteStore,
  dataDir: string,
  logger?: Logger,
): Promise<SqliteImportResult> {
  const result: SqliteImportResult = {
    failed: [],
    imported: 0,
    scanned: 0,
  }

  for (const targetSlug of await listTargetDirs(dataDir)) {
    const targetDir = path.join(dataDir, targetSlug)
    const fileNames = await listSnapshotFileNames(targetDir)
    const preparedSnapshots: PreparedSnapshotInput[] = []
    for (const fileName of fileNames) {
      result.scanned += 1
      const sourcePath = path.join(targetDir, fileName)
      try {
        const contents = await readFile(sourcePath, 'utf8')
        preparedSnapshots.push(prepareSnapshotInput({ contents, fileName, sourcePath, targetSlug }))
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        result.failed.push({ error, file: sourcePath })
        logger?.error('sqlite snapshot import failed', { error, file: sourcePath })
      }
    }

    try {
      store.upsertPreparedSnapshots(preparedSnapshots)
      result.imported += preparedSnapshots.length
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      for (const snapshot of preparedSnapshots) {
        result.failed.push({ error, file: snapshot.sourcePath })
      }
      logger?.error('sqlite target import transaction failed', {
        error,
        target: targetSlug,
      })
    }
  }

  return result
}

export async function verifySqliteAgainstDataDir(
  store: HopwatchSqliteStore,
  dataDir: string,
  options: { strictExtra?: boolean } = {},
): Promise<SqliteVerifyResult> {
  const fileState = await collectFileHashes(dataDir)
  const sqliteCounts = store.getSnapshotCountsByTarget()
  const sqliteHashes = store.getSnapshotHashes()
  const targetSlugs = new Set([...fileState.countsByTarget.keys(), ...sqliteCounts.keys()])
  const targets = [...targetSlugs].sort().map((targetSlug) => ({
    fileCount: fileState.countsByTarget.get(targetSlug) ?? 0,
    sqliteCount: sqliteCounts.get(targetSlug) ?? 0,
    targetSlug,
  }))

  const missingInSqlite: string[] = []
  const shaMismatches: string[] = []
  for (const [key, fileHash] of fileState.hashes) {
    const sqliteHash = sqliteHashes.get(key)
    if (sqliteHash == null) {
      missingInSqlite.push(key)
      continue
    }
    if (sqliteHash !== fileHash) {
      shaMismatches.push(key)
    }
  }

  const extraInSqlite: string[] = []
  for (const key of sqliteHashes.keys()) {
    if (!fileState.hashes.has(key)) {
      extraInSqlite.push(key)
    }
  }

  const sqliteSnapshotCount = [...sqliteCounts.values()].reduce((sum, count) => sum + count, 0)
  const sqliteIntegrity = store.integrityCheck()
  const ok =
    sqliteIntegrity === 'ok' &&
    missingInSqlite.length === 0 &&
    shaMismatches.length === 0 &&
    (!options.strictExtra || extraInSqlite.length === 0)

  return {
    extraInSqlite,
    fileSnapshotCount: fileState.total,
    missingInSqlite,
    ok,
    shaMismatches,
    sqliteIntegrity,
    sqliteSnapshotCount,
    targets,
  }
}
