import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import type { MtrHistoryTarget } from './collector.ts'
import type { Logger } from './logger.ts'
import { parseStoredRawSnapshot, type StoredRawSnapshot } from './raw.ts'
import {
  aggregateSnapshotsToRollupBuckets,
  buildRollupFile,
  isoBucketStartToFileName,
  type MtrRollupFile,
  mergeRollupBuckets,
  mtrRollupFileSchema,
  type RollupGranularity,
} from './rollups.ts'
import {
  formatCompactCollectedAt,
  listSnapshotFileNames,
  parseSnapshotSummaryJson,
  parseStoredSnapshotSummary,
  type SnapshotSummary,
} from './snapshot.ts'

type SqliteModule = typeof import('bun:sqlite')
type SqliteDatabase = import('bun:sqlite').Database

export interface ImportSnapshotInput {
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
  summaryJson: string
}

type SnapshotStatementParams = [
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

export interface SqliteImportFailure {
  error: string
  file: string
}

export interface SqliteImportResult {
  failed: SqliteImportFailure[]
  imported: number
  rollupsImported: number
  rollupsScanned: number
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

interface SnapshotJsonRow {
  json: string
}

interface SnapshotSummaryJsonRow {
  file_name: string
  json: string
  summary_json: string | null
  target_slug: string
}

interface TargetSlugRow {
  target_slug: string
}

interface RollupRow {
  json: string
}

interface IntegrityRow {
  integrity_check: string
}

interface TableInfoRow {
  name: string
}

export interface HopwatchStorage {
  close(): void
  insertRawSnapshot(input: ImportSnapshotInput, rawSnapshot: StoredRawSnapshot): void
  pruneRawSnapshots(targetSlug: string, keepDays: number, now: number): number
  updateRollupsForTarget(
    target: MtrHistoryTarget,
    observer: string,
    now?: Date,
    retention?: { dailyKeepDays: number; hourlyKeepDays: number },
    fullRebuild?: boolean,
  ): void
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
    summaryJson: stringifyStoredSummary(summary),
  }
}

function stringifyStoredSummary(summary: SnapshotSummary): string {
  return `${JSON.stringify({ ...summary, rawText: '' }, null, 2)}\n`
}

export class HopwatchSqliteStore implements HopwatchStorage {
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
        summary_json TEXT,
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
      CREATE TABLE IF NOT EXISTS rollups (
        target_slug TEXT NOT NULL,
        granularity TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (target_slug, granularity)
      )
    `)
    this.ensureSnapshotSummaryColumn()
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
      .run('schema_version', '2')
    this.backfillSnapshotSummaries()
  }

  private ensureSnapshotSummaryColumn(): void {
    const columns = new Set(
      this.db
        .query<TableInfoRow, []>('PRAGMA table_info(snapshots)')
        .all()
        .map((row) => row.name),
    )
    if (!columns.has('summary_json')) {
      this.db.run('ALTER TABLE snapshots ADD COLUMN summary_json TEXT')
    }
  }

  private backfillSnapshotSummaries(): void {
    const rows = this.db
      .query<SnapshotSummaryJsonRow, []>(
        `
          SELECT target_slug, file_name, json, summary_json
          FROM snapshots
          WHERE summary_json IS NULL OR instr(summary_json, '"rawText": ""') = 0
        `,
      )
      .all()
    if (rows.length === 0) {
      return
    }

    const update = this.db.query<unknown, [string, string, string]>(
      'UPDATE snapshots SET summary_json = ? WHERE target_slug = ? AND file_name = ?',
    )
    const backfill = this.db.transaction((items: SnapshotSummaryJsonRow[]) => {
      for (const row of items) {
        const summary = parseStoredSnapshotSummary(row.json)
        update.run(stringifyStoredSummary(summary), row.target_slug, row.file_name)
      }
    })
    backfill.immediate(rows)
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
      summaryJson: stringifyStoredSummary(summary),
    })
  }

  insertRawSnapshot(input: ImportSnapshotInput, rawSnapshot: StoredRawSnapshot): void {
    const summary = parseStoredSnapshotSummary(input.contents)
    try {
      this.insertPreparedSnapshot({
        ...input,
        importedAt: new Date().toISOString(),
        rawSnapshot,
        sha256: sha256(input.contents),
        summary: {
          destinationLossPct: summary.destinationLossPct,
          hopCount: summary.hopCount,
          worstHopLossPct: summary.worstHopLossPct,
        },
        summaryJson: stringifyStoredSummary(summary),
      })
    } catch (err) {
      if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) {
        throw new Error(
          `snapshot collision at sqlite://${input.targetSlug}/${input.fileName}: another process already wrote this timestamp`,
        )
      }
      throw err
    }
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
      .query<unknown, SnapshotStatementParams>(
        `
          INSERT INTO snapshots (
            target_slug,
            collected_at,
            file_name,
            source_path,
            sha256,
            json,
            summary_json,
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(target_slug, file_name) DO UPDATE SET
            collected_at = excluded.collected_at,
            source_path = excluded.source_path,
            sha256 = excluded.sha256,
            json = excluded.json,
            summary_json = excluded.summary_json,
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
        input.summaryJson,
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

  private insertPreparedSnapshot(input: PreparedSnapshotInput): void {
    this.db
      .query<unknown, SnapshotStatementParams>(
        `
          INSERT INTO snapshots (
            target_slug,
            collected_at,
            file_name,
            source_path,
            sha256,
            json,
            summary_json,
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.targetSlug,
        input.rawSnapshot.collectedAt,
        input.fileName,
        input.sourcePath,
        input.sha256,
        input.contents,
        input.summaryJson,
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

  listTargetSlugs(): string[] {
    return this.db
      .query<TargetSlugRow, []>(
        'SELECT DISTINCT target_slug FROM snapshots ORDER BY target_slug ASC',
      )
      .all()
      .map((row) => row.target_slug)
  }

  listSnapshotSummaries(targetSlug: string): SnapshotSummary[] {
    return this.db
      .query<SnapshotSummaryJsonRow, [string]>(
        'SELECT target_slug, file_name, json, summary_json FROM snapshots WHERE target_slug = ? ORDER BY collected_at DESC',
      )
      .all(targetSlug)
      .map((row) =>
        row.summary_json == null
          ? parseStoredSnapshotSummary(row.json)
          : parseSnapshotSummaryJson(row.summary_json),
      )
  }

  listRawSnapshotsSince(targetSlug: string, sinceFileName?: string): StoredRawSnapshot[] {
    const rows =
      sinceFileName == null
        ? this.db
            .query<SnapshotJsonRow, [string]>(
              'SELECT json FROM snapshots WHERE target_slug = ? ORDER BY file_name ASC',
            )
            .all(targetSlug)
        : this.db
            .query<SnapshotJsonRow, [string, string]>(
              'SELECT json FROM snapshots WHERE target_slug = ? AND file_name >= ? ORDER BY file_name ASC',
            )
            .all(targetSlug, sinceFileName)
    return rows.map((row) => parseStoredRawSnapshot(row.json))
  }

  getSnapshotJson(targetSlug: string, fileName: string): string | null {
    return (
      this.db
        .query<SnapshotJsonRow, [string, string]>(
          'SELECT json FROM snapshots WHERE target_slug = ? AND file_name = ?',
        )
        .get(targetSlug, fileName)?.json ?? null
    )
  }

  getLatestSnapshotJson(targetSlug: string): string | null {
    return (
      this.db
        .query<SnapshotJsonRow, [string]>(
          'SELECT json FROM snapshots WHERE target_slug = ? ORDER BY collected_at DESC LIMIT 1',
        )
        .get(targetSlug)?.json ?? null
    )
  }

  getRollupFile(targetSlug: string, granularity: RollupGranularity): MtrRollupFile | null {
    const json =
      this.db
        .query<RollupRow, [string, string]>(
          'SELECT json FROM rollups WHERE target_slug = ? AND granularity = ?',
        )
        .get(targetSlug, granularity)?.json ?? null
    if (json == null) return null
    const parsed = mtrRollupFileSchema.parse(JSON.parse(json))
    if (parsed.granularity !== granularity) {
      throw new Error(
        `Expected ${targetSlug}/${granularity} rollup to have granularity ${granularity}, got ${parsed.granularity}`,
      )
    }
    return parsed
  }

  upsertRollupFile(targetSlug: string, rollupFile: MtrRollupFile): void {
    this.db
      .query<unknown, [string, string, string, string]>(
        `
          INSERT INTO rollups (target_slug, granularity, generated_at, json)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(target_slug, granularity) DO UPDATE SET
            generated_at = excluded.generated_at,
            json = excluded.json
        `,
      )
      .run(
        targetSlug,
        rollupFile.granularity,
        rollupFile.generatedAt,
        `${JSON.stringify(rollupFile, null, 2)}\n`,
      )
  }

  pruneRawSnapshots(targetSlug: string, keepDays: number, now: number): number {
    const cutoff = new Date(now - keepDays * 24 * 60 * 60 * 1000)
    const cutoffFileName = `${formatCompactCollectedAt(cutoff)}.json`
    return this.db
      .query<unknown, [string, string]>(
        'DELETE FROM snapshots WHERE target_slug = ? AND file_name < ?',
      )
      .run(targetSlug, cutoffFileName).changes
  }

  updateRollupsForTarget(
    target: MtrHistoryTarget,
    observer: string,
    now = new Date(),
    retention: { dailyKeepDays: number; hourlyKeepDays: number } = {
      dailyKeepDays: 365,
      hourlyKeepDays: 90,
    },
    fullRebuild = false,
  ): void {
    const existingHourly = this.getRollupFile(target.slug, 'hour')
    const existingDaily = this.getRollupFile(target.slug, 'day')
    let sinceFileName: string | undefined

    if (!fullRebuild) {
      const latestHourlyStart = existingHourly?.buckets
        .map((bucket) => bucket.bucketStart)
        .sort()
        .at(-1)
      const latestDailyStart = existingDaily?.buckets
        .map((bucket) => bucket.bucketStart)
        .sort()
        .at(-1)
      const candidates: string[] = []
      if (latestHourlyStart != null) candidates.push(latestHourlyStart)
      if (latestDailyStart != null) candidates.push(latestDailyStart)
      if (candidates.length > 0) {
        const earliest = candidates.sort()[0]
        const converted = isoBucketStartToFileName(earliest)
        if (converted != null) sinceFileName = converted
      }
    }

    const snapshots = this.listRawSnapshotsSince(target.slug, sinceFileName)
    if (snapshots.length === 0 && existingHourly == null && existingDaily == null) {
      return
    }

    const metadata = {
      host: target.host,
      label: target.label,
      observer,
      probeMode: target.probeMode,
      target: target.host,
    }

    const generatedHourly = aggregateSnapshotsToRollupBuckets(snapshots, 'hour')
    const mergedHourly = mergeRollupBuckets(
      existingHourly?.buckets ?? [],
      generatedHourly,
      now.getTime(),
      retention.hourlyKeepDays,
    )
    this.upsertRollupFile(target.slug, buildRollupFile('hour', metadata, mergedHourly, now))

    const generatedDaily = aggregateSnapshotsToRollupBuckets(snapshots, 'day')
    const mergedDaily = mergeRollupBuckets(
      existingDaily?.buckets ?? [],
      generatedDaily,
      now.getTime(),
      retention.dailyKeepDays,
    )
    this.upsertRollupFile(target.slug, buildRollupFile('day', metadata, mergedDaily, now))
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

async function importRollupIfPresent(
  store: HopwatchSqliteStore,
  targetDir: string,
  targetSlug: string,
  granularity: RollupGranularity,
): Promise<boolean> {
  const fileName = `${granularity === 'hour' ? 'hourly' : 'daily'}.rollup.json`
  const filePath = path.join(targetDir, fileName)
  let contents: string
  try {
    contents = await readFile(filePath, 'utf8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return false
    }
    throw err
  }
  const rollup = mtrRollupFileSchema.parse(JSON.parse(contents))
  if (rollup.granularity !== granularity) {
    throw new Error(`Expected ${filePath} to be ${granularity}, got ${rollup.granularity}`)
  }
  store.upsertRollupFile(targetSlug, rollup)
  return true
}

export async function importSnapshotsFromDataDir(
  store: HopwatchSqliteStore,
  dataDir: string,
  logger?: Logger,
): Promise<SqliteImportResult> {
  const result: SqliteImportResult = {
    failed: [],
    imported: 0,
    rollupsImported: 0,
    rollupsScanned: 0,
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
      logger?.error('sqlite target import transaction failed', { error, target: targetSlug })
    }

    for (const granularity of ['hour', 'day'] as const) {
      result.rollupsScanned += 1
      const fileName = `${granularity === 'hour' ? 'hourly' : 'daily'}.rollup.json`
      try {
        if (await importRollupIfPresent(store, targetDir, targetSlug, granularity)) {
          result.rollupsImported += 1
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        result.failed.push({ error, file: path.join(targetDir, fileName) })
        logger?.error('sqlite rollup import failed', { error, target: targetSlug })
      }
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
