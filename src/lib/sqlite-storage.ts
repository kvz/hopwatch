import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import type { MtrHistoryTarget } from './collector.ts'
import type { ProbeEngine, ProbeMode, ProbeProtocol } from './config.ts'
import type { NetworkOwnerInfo } from './network-owner.ts'
import { parseStoredRawSnapshot, type RawMtrEvent, type StoredRawSnapshot } from './raw.ts'
import {
  aggregateSnapshotsToRollupBuckets,
  buildRollupFile,
  isoBucketStartToFileName,
  type MtrRollupBucket,
  type MtrRollupFile,
  mergeRollupBuckets,
  mtrRollupFileSchema,
  type RollupGranularity,
} from './rollups.ts'
import {
  diagnoseSnapshot,
  formatCompactCollectedAt,
  type HopRecord,
  renderSnapshotRawText,
  type SnapshotSummary,
  summarizeStoredRawSnapshot,
} from './snapshot.ts'

type SqliteModule = typeof import('bun:sqlite')
type SqliteDatabase = import('bun:sqlite').Database

export interface ImportSnapshotInput {
  contents: string
  fileName: string
  sourcePath: string
  targetSlug: string
}

interface PreparedSnapshotInput extends ImportSnapshotInput {
  importedAt: string
  rawSnapshot: StoredRawSnapshot
  sha256: string
  summary: SnapshotSummary
}

type SnapshotStatementParams = [
  string, // target_slug
  string, // collected_at
  string, // file_name
  string, // source_path
  string, // sha256
  string, // imported_at
  string, // observer
  string, // label
  string, // host
  string, // target
  string, // probe_mode
  string | null, // netns
  string, // protocol
  number, // port
  string, // engine
  number, // raw_event_count
  number, // hop_count
  number | null, // destination_loss_pct
  number | null, // worst_hop_loss_pct
  number | null, // destination_avg_rtt_ms
  number | null, // destination_hop_index
  number | null, // destination_rtt_min_ms
  number | null, // destination_rtt_max_ms
  number | null, // destination_rtt_p50_ms
  number | null, // destination_rtt_p90_ms
]

type SnapshotHopStatementParams = [
  string,
  string,
  number,
  string,
  string | null,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
]

type SnapshotDestinationSampleStatementParams = [string, string, number, number]

type SnapshotEventStatementParams = [
  string,
  string,
  number,
  string,
  number,
  number | null,
  number | null,
  string | null,
]

type RollupStatementParams = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
]

type RollupBucketStatementParams = [
  string,
  string,
  string,
  number,
  number,
  number,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
]

type RollupHistogramStatementParams = [string, string, string, number, number | null, number]

type RollupHopStatementParams = [
  string,
  string,
  string,
  string,
  number,
  number,
  number,
  number,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
]

type RollupHopIndexStatementParams = [string, string, string, string, number]

export interface SqliteVerifyTarget {
  sqliteCount: number
  targetSlug: string
}

export interface SqliteVerifyResult {
  legacyBlobColumns: string[]
  ok: boolean
  orphanedRollupRows: number
  orphanedSnapshotDetailRows: number
  sqliteIntegrity: string
  sqliteSnapshotCount: number
  targets: SqliteVerifyTarget[]
}

interface CountRow {
  count: number
}

interface SnapshotCountRow {
  count: number
  target_slug: string
}

interface SnapshotRow {
  collected_at: string
  destination_avg_rtt_ms: number | null
  destination_hop_index: number | null
  destination_loss_pct: number | null
  destination_rtt_max_ms: number | null
  destination_rtt_min_ms: number | null
  destination_rtt_p50_ms: number | null
  destination_rtt_p90_ms: number | null
  engine: ProbeEngine
  file_name: string
  hop_count: number
  host: string
  imported_at: string
  label: string
  netns: string | null
  observer: string
  port: number
  probe_mode: ProbeMode
  protocol: ProbeProtocol
  raw_event_count: number
  sha256: string
  source_path: string
  target: string
  target_slug: string
  worst_hop_loss_pct: number | null
}

interface SnapshotHopRow {
  asn: string | null
  avg_ms: number | null
  best_ms: number | null
  file_name: string
  hop_index: number
  host: string
  last_ms: number | null
  loss_pct: number
  sent: number | null
  stdev_ms: number | null
  worst_ms: number | null
}

interface SnapshotDestinationSampleRow {
  file_name: string
  rtt_ms: number
}

interface SnapshotEventRow {
  event_order: number
  hop_index: number
  host: string | null
  kind: RawMtrEvent['kind']
  probe_id: number | null
  rtt_us: number | null
}

interface TargetSlugRow {
  target_slug: string
}

interface RollupRow {
  generated_at: string
  granularity: RollupGranularity
  host: string
  label: string
  observer: string
  probe_mode: ProbeMode
  schema_version: number
  target: string
  target_slug: string
}

interface RollupBucketRow {
  bucket_start: string
  destination_loss_pct: number
  destination_reply_count: number
  destination_sent_count: number
  rtt_avg_ms: number | null
  rtt_max_ms: number | null
  rtt_min_ms: number | null
  rtt_p50_ms: number | null
  rtt_p90_ms: number | null
  rtt_p99_ms: number | null
  snapshot_count: number
}

interface RollupHistogramRow {
  bucket_start: string
  count: number
  upper_bound_ms: number | null
}

interface RollupHopRow {
  bucket_start: string
  host: string
  loss_pct: number
  reply_count: number
  representative_hop_index: number
  rtt_avg_ms: number | null
  rtt_max_ms: number | null
  rtt_min_ms: number | null
  rtt_p50_ms: number | null
  rtt_p90_ms: number | null
  rtt_p99_ms: number | null
  sent_count: number
  snapshot_count: number
}

interface RollupHopIndexRow {
  bucket_start: string
  hop_index: number
  host: string
}

interface IntegrityRow {
  integrity_check: string
}

interface TableInfoRow {
  name: string
}

interface NetworkOwnerCacheRow {
  as_name: string | null
  asn: string | null
  contact_emails_json: string
  country: string | null
  expires_at: string
  fetched_at: string
  ip: string
  prefix: string | null
  rdap_name: string | null
  registry: string | null
  source: string
}

type NetworkOwnerCacheStatementParams = [
  string,
  string | null,
  string | null,
  string,
  string | null,
  string,
  string,
  string | null,
  string | null,
  string | null,
  string,
]

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

function prepareSnapshotInput(
  input: ImportSnapshotInput,
  rawSnapshot = parseStoredRawSnapshot(input.contents),
  importedAt = new Date().toISOString(),
): PreparedSnapshotInput {
  return {
    ...input,
    importedAt,
    rawSnapshot,
    sha256: sha256(input.contents),
    summary: summarizeStoredRawSnapshot(rawSnapshot),
  }
}

function rawEventFromRow(row: SnapshotEventRow): RawMtrEvent {
  if (row.kind === 'sent') {
    if (row.probe_id == null) {
      throw new Error('Stored sent event is missing probe_id')
    }
    return { kind: 'sent', hopIndex: row.hop_index, probeId: row.probe_id }
  }

  if (row.kind === 'reply') {
    if (row.probe_id == null || row.rtt_us == null) {
      throw new Error('Stored reply event is missing probe_id or rtt_us')
    }
    return {
      kind: 'reply',
      hopIndex: row.hop_index,
      probeId: row.probe_id,
      rttUs: row.rtt_us,
    }
  }

  if (row.host == null) {
    throw new Error(`Stored ${row.kind} event is missing host`)
  }
  return { kind: row.kind, hopIndex: row.hop_index, host: row.host }
}

function rawSnapshotFromRow(row: SnapshotRow, rawEvents: RawMtrEvent[]): StoredRawSnapshot {
  return {
    collectedAt: row.collected_at,
    engine: row.engine,
    fileName: row.file_name,
    host: row.host,
    label: row.label,
    netns: row.netns,
    observer: row.observer,
    port: row.port,
    probeMode: row.probe_mode,
    protocol: row.protocol,
    rawEvents,
    schemaVersion: 2,
    target: row.target,
  }
}

function snapshotSummaryFromRows(
  row: SnapshotRow,
  hops: HopRecord[],
  destinationRttSamplesMs: number[],
  rawText = '',
): SnapshotSummary {
  return {
    collectedAt: row.collected_at,
    destinationAvgRttMs: row.destination_avg_rtt_ms,
    destinationHopIndex: row.destination_hop_index,
    destinationLossPct: row.destination_loss_pct,
    destinationRttMaxMs: row.destination_rtt_max_ms,
    destinationRttMinMs: row.destination_rtt_min_ms,
    destinationRttP50Ms: row.destination_rtt_p50_ms,
    destinationRttP90Ms: row.destination_rtt_p90_ms,
    destinationRttSamplesMs: destinationRttSamplesMs.length === 0 ? null : destinationRttSamplesMs,
    diagnosis: diagnoseSnapshot(hops, row.destination_loss_pct, row.destination_hop_index),
    engine: row.engine,
    fileName: row.file_name,
    hopCount: row.hop_count,
    hops,
    host: row.host,
    netns: row.netns,
    port: row.port,
    probeMode: row.probe_mode,
    protocol: row.protocol,
    rawText,
    target: row.label,
    worstHopLossPct: row.worst_hop_loss_pct,
  }
}

function groupByFileName<T extends { file_name: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const existing = grouped.get(row.file_name) ?? []
    existing.push(row)
    grouped.set(row.file_name, existing)
  }
  return grouped
}

function groupRollupRowsByBucket<T extends { bucket_start: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const existing = grouped.get(row.bucket_start) ?? []
    existing.push(row)
    grouped.set(row.bucket_start, existing)
  }
  return grouped
}

function hopRecordFromRow(row: SnapshotHopRow): HopRecord {
  return {
    asn: row.asn,
    avgMs: row.avg_ms,
    bestMs: row.best_ms,
    host: row.host,
    index: row.hop_index,
    lastMs: row.last_ms,
    lossPct: row.loss_pct,
    sent: row.sent,
    stdevMs: row.stdev_ms,
    worstMs: row.worst_ms,
  }
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
    this.initializeSnapshotTables()
    this.initializeRollupTables()
    this.initializeNetworkOwnerTables()
    this.createIndexes()
    this.db
      .query<unknown, [string, string]>(
        'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
      )
      .run('schema_version', '4')
  }

  private tableColumns(tableName: string): Set<string> {
    return new Set(
      this.db
        .query<TableInfoRow, []>(`PRAGMA table_info(${tableName})`)
        .all()
        .map((row) => row.name),
    )
  }

  private initializeSnapshotTables(): void {
    const columns = this.tableColumns('snapshots')
    if (columns.size === 0) {
      this.createSnapshotsTable('snapshots')
      this.createSnapshotDetailTables()
      return
    }

    if (columns.has('json') || columns.has('summary_json')) {
      throw new Error(
        'Unsupported legacy SQLite schema: snapshots still contains json/summary_json columns. Migrate it with Hopwatch v0.3.0 before running this build.',
      )
    }

    this.createSnapshotDetailTables()
  }

  private createSnapshotsTable(tableName: string): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        target_slug TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        file_name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
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
        destination_avg_rtt_ms REAL,
        destination_hop_index INTEGER,
        destination_rtt_min_ms REAL,
        destination_rtt_max_ms REAL,
        destination_rtt_p50_ms REAL,
        destination_rtt_p90_ms REAL,
        PRIMARY KEY (target_slug, file_name)
      )
    `)
  }

  private createSnapshotDetailTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS snapshot_hops (
        target_slug TEXT NOT NULL,
        file_name TEXT NOT NULL,
        hop_index INTEGER NOT NULL,
        host TEXT NOT NULL,
        asn TEXT,
        loss_pct REAL NOT NULL,
        sent INTEGER,
        last_ms REAL,
        avg_ms REAL,
        best_ms REAL,
        worst_ms REAL,
        stdev_ms REAL,
        PRIMARY KEY (target_slug, file_name, hop_index)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS snapshot_destination_samples (
        target_slug TEXT NOT NULL,
        file_name TEXT NOT NULL,
        sample_index INTEGER NOT NULL,
        rtt_ms REAL NOT NULL,
        PRIMARY KEY (target_slug, file_name, sample_index)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS snapshot_events (
        target_slug TEXT NOT NULL,
        file_name TEXT NOT NULL,
        event_order INTEGER NOT NULL,
        kind TEXT NOT NULL,
        hop_index INTEGER NOT NULL,
        probe_id INTEGER,
        rtt_us INTEGER,
        host TEXT,
        PRIMARY KEY (target_slug, file_name, event_order)
      )
    `)
  }

  private initializeRollupTables(): void {
    const columns = this.tableColumns('rollups')
    if (columns.size > 0 && columns.has('json')) {
      throw new Error(
        'Unsupported legacy SQLite schema: rollups still contains a json column. Migrate it with Hopwatch v0.3.0 before running this build.',
      )
    }

    this.createRollupTables()
  }

  private createRollupTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS rollups (
        target_slug TEXT NOT NULL,
        granularity TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        host TEXT NOT NULL,
        label TEXT NOT NULL,
        observer TEXT NOT NULL,
        probe_mode TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        target TEXT NOT NULL,
        PRIMARY KEY (target_slug, granularity)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS rollup_buckets (
        target_slug TEXT NOT NULL,
        granularity TEXT NOT NULL,
        bucket_start TEXT NOT NULL,
        snapshot_count INTEGER NOT NULL,
        destination_sent_count INTEGER NOT NULL,
        destination_reply_count INTEGER NOT NULL,
        destination_loss_pct REAL NOT NULL,
        rtt_avg_ms REAL,
        rtt_min_ms REAL,
        rtt_max_ms REAL,
        rtt_p50_ms REAL,
        rtt_p90_ms REAL,
        rtt_p99_ms REAL,
        PRIMARY KEY (target_slug, granularity, bucket_start)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS rollup_histogram_bins (
        target_slug TEXT NOT NULL,
        granularity TEXT NOT NULL,
        bucket_start TEXT NOT NULL,
        bin_index INTEGER NOT NULL,
        upper_bound_ms REAL,
        count INTEGER NOT NULL,
        PRIMARY KEY (target_slug, granularity, bucket_start, bin_index)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS rollup_hops (
        target_slug TEXT NOT NULL,
        granularity TEXT NOT NULL,
        bucket_start TEXT NOT NULL,
        host TEXT NOT NULL,
        representative_hop_index INTEGER NOT NULL,
        snapshot_count INTEGER NOT NULL,
        sent_count INTEGER NOT NULL,
        reply_count INTEGER NOT NULL,
        loss_pct REAL NOT NULL,
        rtt_avg_ms REAL,
        rtt_min_ms REAL,
        rtt_max_ms REAL,
        rtt_p50_ms REAL,
        rtt_p90_ms REAL,
        rtt_p99_ms REAL,
        PRIMARY KEY (target_slug, granularity, bucket_start, host)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS rollup_hop_indexes (
        target_slug TEXT NOT NULL,
        granularity TEXT NOT NULL,
        bucket_start TEXT NOT NULL,
        host TEXT NOT NULL,
        hop_index INTEGER NOT NULL,
        PRIMARY KEY (target_slug, granularity, bucket_start, host, hop_index)
      )
    `)
  }

  private initializeNetworkOwnerTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS network_owner_cache (
        ip TEXT PRIMARY KEY,
        as_name TEXT,
        asn TEXT,
        contact_emails_json TEXT NOT NULL,
        country TEXT,
        expires_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        prefix TEXT,
        rdap_name TEXT,
        registry TEXT,
        source TEXT NOT NULL
      )
    `)
  }

  private createIndexes(): void {
    this.db.run(`
      CREATE INDEX IF NOT EXISTS snapshots_target_collected_at_idx
      ON snapshots (target_slug, collected_at DESC)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS snapshots_collected_at_idx
      ON snapshots (collected_at DESC)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS snapshot_hops_target_file_idx
      ON snapshot_hops (target_slug, file_name, hop_index)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS snapshot_events_target_file_idx
      ON snapshot_events (target_slug, file_name, event_order)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS rollup_buckets_target_granularity_idx
      ON rollup_buckets (target_slug, granularity, bucket_start)
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS network_owner_cache_expires_at_idx
      ON network_owner_cache (expires_at)
    `)
  }

  getNetworkOwnerCache(ip: string, now = new Date()): NetworkOwnerInfo | null {
    const row = this.db
      .query<NetworkOwnerCacheRow, [string, string]>(
        `
          SELECT *
          FROM network_owner_cache
          WHERE ip = ? AND expires_at > ?
        `,
      )
      .get(ip, now.toISOString())
    if (row == null) return null

    let contactEmails: string[] = []
    const parsed: unknown = JSON.parse(row.contact_emails_json)
    if (Array.isArray(parsed)) {
      contactEmails = parsed.filter((item): item is string => typeof item === 'string')
    }

    return {
      asName: row.as_name,
      asn: row.asn,
      contactEmails,
      country: row.country,
      fetchedAt: row.fetched_at,
      ip: row.ip,
      prefix: row.prefix,
      rdapName: row.rdap_name,
      registry: row.registry,
      source: row.source,
    }
  }

  upsertNetworkOwnerCache(owner: NetworkOwnerInfo, now = new Date()): void {
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
    this.db
      .query<unknown, NetworkOwnerCacheStatementParams>(
        `
          INSERT INTO network_owner_cache (
            ip,
            as_name,
            asn,
            contact_emails_json,
            country,
            expires_at,
            fetched_at,
            prefix,
            rdap_name,
            registry,
            source
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET
            as_name = excluded.as_name,
            asn = excluded.asn,
            contact_emails_json = excluded.contact_emails_json,
            country = excluded.country,
            expires_at = excluded.expires_at,
            fetched_at = excluded.fetched_at,
            prefix = excluded.prefix,
            rdap_name = excluded.rdap_name,
            registry = excluded.registry,
            source = excluded.source
        `,
      )
      .run(
        owner.ip,
        owner.asName,
        owner.asn,
        JSON.stringify(owner.contactEmails),
        owner.country,
        expiresAt,
        owner.fetchedAt,
        owner.prefix,
        owner.rdapName,
        owner.registry,
        owner.source,
      )
  }

  upsertRawSnapshot(input: ImportSnapshotInput, rawSnapshot: StoredRawSnapshot): void {
    this.upsertPreparedSnapshot(prepareSnapshotInput(input, rawSnapshot))
  }

  insertRawSnapshot(input: ImportSnapshotInput, rawSnapshot: StoredRawSnapshot): void {
    try {
      this.insertPreparedSnapshot(prepareSnapshotInput(input, rawSnapshot))
    } catch (err) {
      if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) {
        throw new Error(
          `snapshot collision at sqlite://${input.targetSlug}/${input.fileName}: another process already wrote this timestamp`,
        )
      }
      throw err
    }
  }

  private upsertPreparedSnapshot(input: PreparedSnapshotInput): void {
    const upsert = this.db.transaction((snapshot: PreparedSnapshotInput) => {
      this.upsertPreparedSnapshotInto('snapshots', snapshot)
    })
    upsert.immediate(input)
  }

  private insertPreparedSnapshot(input: PreparedSnapshotInput): void {
    const insert = this.db.transaction((snapshot: PreparedSnapshotInput) => {
      this.insertPreparedSnapshotInto('snapshots', snapshot)
    })
    insert.immediate(input)
  }

  private upsertPreparedSnapshotInto(tableName: string, input: PreparedSnapshotInput): void {
    this.db
      .query<unknown, SnapshotStatementParams>(
        `
          INSERT INTO ${tableName} (
            target_slug,
            collected_at,
            file_name,
            source_path,
            sha256,
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
            worst_hop_loss_pct,
            destination_avg_rtt_ms,
            destination_hop_index,
            destination_rtt_min_ms,
            destination_rtt_max_ms,
            destination_rtt_p50_ms,
            destination_rtt_p90_ms
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(target_slug, file_name) DO UPDATE SET
            collected_at = excluded.collected_at,
            source_path = excluded.source_path,
            sha256 = excluded.sha256,
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
            worst_hop_loss_pct = excluded.worst_hop_loss_pct,
            destination_avg_rtt_ms = excluded.destination_avg_rtt_ms,
            destination_hop_index = excluded.destination_hop_index,
            destination_rtt_min_ms = excluded.destination_rtt_min_ms,
            destination_rtt_max_ms = excluded.destination_rtt_max_ms,
            destination_rtt_p50_ms = excluded.destination_rtt_p50_ms,
            destination_rtt_p90_ms = excluded.destination_rtt_p90_ms
        `,
      )
      .run(...this.snapshotStatementParams(input))
    this.replaceSnapshotDetails(input)
  }

  private insertPreparedSnapshotInto(tableName: string, input: PreparedSnapshotInput): void {
    this.db
      .query<unknown, SnapshotStatementParams>(
        `
          INSERT INTO ${tableName} (
            target_slug,
            collected_at,
            file_name,
            source_path,
            sha256,
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
            worst_hop_loss_pct,
            destination_avg_rtt_ms,
            destination_hop_index,
            destination_rtt_min_ms,
            destination_rtt_max_ms,
            destination_rtt_p50_ms,
            destination_rtt_p90_ms
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(...this.snapshotStatementParams(input))
    this.replaceSnapshotDetails(input)
  }

  private snapshotStatementParams(input: PreparedSnapshotInput): SnapshotStatementParams {
    return [
      input.targetSlug,
      input.rawSnapshot.collectedAt,
      input.fileName,
      input.sourcePath,
      input.sha256,
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
      input.summary.destinationAvgRttMs,
      input.summary.destinationHopIndex,
      input.summary.destinationRttMinMs,
      input.summary.destinationRttMaxMs,
      input.summary.destinationRttP50Ms,
      input.summary.destinationRttP90Ms,
    ]
  }

  private replaceSnapshotDetails(input: PreparedSnapshotInput): void {
    for (const tableName of ['snapshot_hops', 'snapshot_destination_samples', 'snapshot_events']) {
      this.db
        .query<unknown, [string, string]>(
          `DELETE FROM ${tableName} WHERE target_slug = ? AND file_name = ?`,
        )
        .run(input.targetSlug, input.fileName)
    }

    const insertHop = this.db.query<unknown, SnapshotHopStatementParams>(
      `
        INSERT INTO snapshot_hops (
          target_slug,
          file_name,
          hop_index,
          host,
          asn,
          loss_pct,
          sent,
          last_ms,
          avg_ms,
          best_ms,
          worst_ms,
          stdev_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    for (const hop of input.summary.hops) {
      insertHop.run(
        input.targetSlug,
        input.fileName,
        hop.index,
        hop.host,
        hop.asn,
        hop.lossPct,
        hop.sent,
        hop.lastMs,
        hop.avgMs,
        hop.bestMs,
        hop.worstMs,
        hop.stdevMs,
      )
    }

    const insertSample = this.db.query<unknown, SnapshotDestinationSampleStatementParams>(
      `
        INSERT INTO snapshot_destination_samples (
          target_slug,
          file_name,
          sample_index,
          rtt_ms
        )
        VALUES (?, ?, ?, ?)
      `,
    )
    for (const [sampleIndex, rttMs] of (input.summary.destinationRttSamplesMs ?? []).entries()) {
      insertSample.run(input.targetSlug, input.fileName, sampleIndex, rttMs)
    }

    const insertEvent = this.db.query<unknown, SnapshotEventStatementParams>(
      `
        INSERT INTO snapshot_events (
          target_slug,
          file_name,
          event_order,
          kind,
          hop_index,
          probe_id,
          rtt_us,
          host
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    for (const [eventOrder, event] of input.rawSnapshot.rawEvents.entries()) {
      insertEvent.run(
        input.targetSlug,
        input.fileName,
        eventOrder,
        event.kind,
        event.hopIndex,
        'probeId' in event ? event.probeId : null,
        'rttUs' in event ? event.rttUs : null,
        'host' in event ? event.host : null,
      )
    }
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
    const rows = this.db
      .query<SnapshotRow, [string]>(
        'SELECT * FROM snapshots WHERE target_slug = ? ORDER BY collected_at DESC',
      )
      .all(targetSlug)
    if (rows.length === 0) {
      return []
    }

    const hopsByFileName = groupByFileName(
      this.db
        .query<SnapshotHopRow, [string]>(
          `
            SELECT file_name, hop_index, host, asn, loss_pct, sent, last_ms, avg_ms, best_ms, worst_ms, stdev_ms
            FROM snapshot_hops
            WHERE target_slug = ?
            ORDER BY file_name ASC, hop_index ASC
          `,
        )
        .all(targetSlug),
    )
    const samplesByFileName = groupByFileName(
      this.db
        .query<SnapshotDestinationSampleRow, [string]>(
          `
            SELECT file_name, rtt_ms
            FROM snapshot_destination_samples
            WHERE target_slug = ?
            ORDER BY file_name ASC, sample_index ASC
          `,
        )
        .all(targetSlug),
    )

    return rows.map((row) =>
      snapshotSummaryFromRows(
        row,
        (hopsByFileName.get(row.file_name) ?? []).map(hopRecordFromRow),
        (samplesByFileName.get(row.file_name) ?? []).map((sample) => sample.rtt_ms),
      ),
    )
  }

  listRawSnapshotsSince(targetSlug: string, sinceFileName?: string): StoredRawSnapshot[] {
    const rows =
      sinceFileName == null
        ? this.db
            .query<SnapshotRow, [string]>(
              'SELECT * FROM snapshots WHERE target_slug = ? ORDER BY file_name ASC',
            )
            .all(targetSlug)
        : this.db
            .query<SnapshotRow, [string, string]>(
              'SELECT * FROM snapshots WHERE target_slug = ? AND file_name >= ? ORDER BY file_name ASC',
            )
            .all(targetSlug, sinceFileName)
    if (rows.length === 0) {
      return []
    }

    const eventRows =
      sinceFileName == null
        ? this.db
            .query<SnapshotEventRow & { file_name: string }, [string]>(
              `
                SELECT file_name, event_order, kind, hop_index, probe_id, rtt_us, host
                FROM snapshot_events
                WHERE target_slug = ?
                ORDER BY file_name ASC, event_order ASC
              `,
            )
            .all(targetSlug)
        : this.db
            .query<SnapshotEventRow & { file_name: string }, [string, string]>(
              `
                SELECT file_name, event_order, kind, hop_index, probe_id, rtt_us, host
                FROM snapshot_events
                WHERE target_slug = ? AND file_name >= ?
                ORDER BY file_name ASC, event_order ASC
              `,
            )
            .all(targetSlug, sinceFileName)
    const eventsByFileName = groupByFileName(eventRows)
    return rows.map((row) =>
      rawSnapshotFromRow(row, (eventsByFileName.get(row.file_name) ?? []).map(rawEventFromRow)),
    )
  }

  getSnapshotJson(targetSlug: string, fileName: string): string | null {
    const snapshot = this.getRawSnapshot(targetSlug, fileName)
    return snapshot == null ? null : `${JSON.stringify(snapshot, null, 2)}\n`
  }

  getLatestSnapshotJson(targetSlug: string): string | null {
    const row = this.getLatestSnapshotRow(targetSlug)
    if (row == null) return null
    const snapshot = this.getRawSnapshot(row.target_slug, row.file_name)
    return snapshot == null ? null : `${JSON.stringify(snapshot, null, 2)}\n`
  }

  getSnapshotRawText(targetSlug: string, fileName: string): string | null {
    const row = this.getSnapshotRow(targetSlug, fileName)
    if (row == null) return null
    const hops = this.listHopRecords(targetSlug, fileName)
    return renderSnapshotRawText(rawSnapshotFromRow(row, []), hops)
  }

  private getRawSnapshot(targetSlug: string, fileName: string): StoredRawSnapshot | null {
    const row = this.getSnapshotRow(targetSlug, fileName)
    if (row == null) return null
    const events = this.db
      .query<SnapshotEventRow, [string, string]>(
        `
          SELECT event_order, kind, hop_index, probe_id, rtt_us, host
          FROM snapshot_events
          WHERE target_slug = ? AND file_name = ?
          ORDER BY event_order ASC
        `,
      )
      .all(targetSlug, fileName)
      .map(rawEventFromRow)
    return rawSnapshotFromRow(row, events)
  }

  private getSnapshotRow(targetSlug: string, fileName: string): SnapshotRow | null {
    return (
      this.db
        .query<SnapshotRow, [string, string]>(
          'SELECT * FROM snapshots WHERE target_slug = ? AND file_name = ?',
        )
        .get(targetSlug, fileName) ?? null
    )
  }

  private getLatestSnapshotRow(targetSlug: string): SnapshotRow | null {
    return (
      this.db
        .query<SnapshotRow, [string]>(
          'SELECT * FROM snapshots WHERE target_slug = ? ORDER BY collected_at DESC LIMIT 1',
        )
        .get(targetSlug) ?? null
    )
  }

  private listHopRecords(targetSlug: string, fileName: string): HopRecord[] {
    return this.db
      .query<SnapshotHopRow, [string, string]>(
        `
          SELECT file_name, hop_index, host, asn, loss_pct, sent, last_ms, avg_ms, best_ms, worst_ms, stdev_ms
          FROM snapshot_hops
          WHERE target_slug = ? AND file_name = ?
          ORDER BY hop_index ASC
        `,
      )
      .all(targetSlug, fileName)
      .map(hopRecordFromRow)
  }

  getRollupFile(targetSlug: string, granularity: RollupGranularity): MtrRollupFile | null {
    const rollup = this.db
      .query<RollupRow, [string, string]>(
        'SELECT * FROM rollups WHERE target_slug = ? AND granularity = ?',
      )
      .get(targetSlug, granularity)
    if (rollup == null) return null

    const bucketRows = this.db
      .query<RollupBucketRow, [string, string]>(
        `
          SELECT *
          FROM rollup_buckets
          WHERE target_slug = ? AND granularity = ?
          ORDER BY bucket_start ASC
        `,
      )
      .all(targetSlug, granularity)
    const histogramByBucket = groupRollupRowsByBucket(
      this.db
        .query<RollupHistogramRow, [string, string]>(
          `
            SELECT bucket_start, upper_bound_ms, count
            FROM rollup_histogram_bins
            WHERE target_slug = ? AND granularity = ?
            ORDER BY bucket_start ASC, bin_index ASC
          `,
        )
        .all(targetSlug, granularity),
    )
    const hopsByBucket = groupRollupRowsByBucket(
      this.db
        .query<RollupHopRow, [string, string]>(
          `
            SELECT *
            FROM rollup_hops
            WHERE target_slug = ? AND granularity = ?
            ORDER BY bucket_start ASC, representative_hop_index ASC, host ASC
          `,
        )
        .all(targetSlug, granularity),
    )
    const hopIndexesByKey = new Map<string, number[]>()
    const hopIndexRows = this.db
      .query<RollupHopIndexRow, [string, string]>(
        `
          SELECT bucket_start, host, hop_index
          FROM rollup_hop_indexes
          WHERE target_slug = ? AND granularity = ?
          ORDER BY bucket_start ASC, host ASC, hop_index ASC
        `,
      )
      .all(targetSlug, granularity)
    for (const row of hopIndexRows) {
      const key = `${row.bucket_start}\0${row.host}`
      const current = hopIndexesByKey.get(key) ?? []
      current.push(row.hop_index)
      hopIndexesByKey.set(key, current)
    }

    const buckets: MtrRollupBucket[] = bucketRows.map((bucket) => ({
      bucketStart: bucket.bucket_start,
      destinationLossPct: bucket.destination_loss_pct,
      destinationReplyCount: bucket.destination_reply_count,
      destinationSentCount: bucket.destination_sent_count,
      histogram: (histogramByBucket.get(bucket.bucket_start) ?? []).map((histogram) => ({
        count: histogram.count,
        upperBoundMs: histogram.upper_bound_ms,
      })),
      hops: (hopsByBucket.get(bucket.bucket_start) ?? []).map((hop) => ({
        host: hop.host,
        hopIndexes: hopIndexesByKey.get(`${hop.bucket_start}\0${hop.host}`) ?? [],
        lossPct: hop.loss_pct,
        replyCount: hop.reply_count,
        representativeHopIndex: hop.representative_hop_index,
        rttAvgMs: hop.rtt_avg_ms,
        rttMaxMs: hop.rtt_max_ms,
        rttMinMs: hop.rtt_min_ms,
        rttP50Ms: hop.rtt_p50_ms,
        rttP90Ms: hop.rtt_p90_ms,
        rttP99Ms: hop.rtt_p99_ms,
        sentCount: hop.sent_count,
        snapshotCount: hop.snapshot_count,
      })),
      rttAvgMs: bucket.rtt_avg_ms,
      rttMaxMs: bucket.rtt_max_ms,
      rttMinMs: bucket.rtt_min_ms,
      rttP50Ms: bucket.rtt_p50_ms,
      rttP90Ms: bucket.rtt_p90_ms,
      rttP99Ms: bucket.rtt_p99_ms,
      snapshotCount: bucket.snapshot_count,
    }))

    const parsed = mtrRollupFileSchema.parse({
      buckets,
      generatedAt: rollup.generated_at,
      granularity: rollup.granularity,
      host: rollup.host,
      label: rollup.label,
      observer: rollup.observer,
      probeMode: rollup.probe_mode,
      schemaVersion: rollup.schema_version,
      target: rollup.target,
    })
    if (parsed.granularity !== granularity) {
      throw new Error(
        `Expected ${targetSlug}/${granularity} rollup to have granularity ${granularity}, got ${parsed.granularity}`,
      )
    }
    return parsed
  }

  upsertRollupFile(targetSlug: string, rollupFile: MtrRollupFile): void {
    const upsert = this.db.transaction((file: MtrRollupFile) => {
      this.db
        .query<unknown, [string, string]>(
          'DELETE FROM rollup_hop_indexes WHERE target_slug = ? AND granularity = ?',
        )
        .run(targetSlug, file.granularity)
      this.db
        .query<unknown, [string, string]>(
          'DELETE FROM rollup_hops WHERE target_slug = ? AND granularity = ?',
        )
        .run(targetSlug, file.granularity)
      this.db
        .query<unknown, [string, string]>(
          'DELETE FROM rollup_histogram_bins WHERE target_slug = ? AND granularity = ?',
        )
        .run(targetSlug, file.granularity)
      this.db
        .query<unknown, [string, string]>(
          'DELETE FROM rollup_buckets WHERE target_slug = ? AND granularity = ?',
        )
        .run(targetSlug, file.granularity)

      this.db
        .query<unknown, RollupStatementParams>(
          `
            INSERT INTO rollups (
              target_slug,
              granularity,
              generated_at,
              host,
              label,
              observer,
              probe_mode,
              schema_version,
              target
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(target_slug, granularity) DO UPDATE SET
              generated_at = excluded.generated_at,
              host = excluded.host,
              label = excluded.label,
              observer = excluded.observer,
              probe_mode = excluded.probe_mode,
              schema_version = excluded.schema_version,
              target = excluded.target
          `,
        )
        .run(
          targetSlug,
          file.granularity,
          file.generatedAt,
          file.host,
          file.label,
          file.observer,
          file.probeMode,
          file.schemaVersion,
          file.target,
        )

      const insertBucket = this.db.query<unknown, RollupBucketStatementParams>(
        `
          INSERT INTO rollup_buckets (
            target_slug,
            granularity,
            bucket_start,
            snapshot_count,
            destination_sent_count,
            destination_reply_count,
            destination_loss_pct,
            rtt_avg_ms,
            rtt_min_ms,
            rtt_max_ms,
            rtt_p50_ms,
            rtt_p90_ms,
            rtt_p99_ms
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      const insertHistogram = this.db.query<unknown, RollupHistogramStatementParams>(
        `
          INSERT INTO rollup_histogram_bins (
            target_slug,
            granularity,
            bucket_start,
            bin_index,
            upper_bound_ms,
            count
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      const insertHop = this.db.query<unknown, RollupHopStatementParams>(
        `
          INSERT INTO rollup_hops (
            target_slug,
            granularity,
            bucket_start,
            host,
            representative_hop_index,
            snapshot_count,
            sent_count,
            reply_count,
            loss_pct,
            rtt_avg_ms,
            rtt_min_ms,
            rtt_max_ms,
            rtt_p50_ms,
            rtt_p90_ms,
            rtt_p99_ms
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      const insertHopIndex = this.db.query<unknown, RollupHopIndexStatementParams>(
        `
          INSERT INTO rollup_hop_indexes (
            target_slug,
            granularity,
            bucket_start,
            host,
            hop_index
          )
          VALUES (?, ?, ?, ?, ?)
        `,
      )

      for (const bucket of file.buckets) {
        insertBucket.run(
          targetSlug,
          file.granularity,
          bucket.bucketStart,
          bucket.snapshotCount,
          bucket.destinationSentCount,
          bucket.destinationReplyCount,
          bucket.destinationLossPct,
          bucket.rttAvgMs,
          bucket.rttMinMs,
          bucket.rttMaxMs,
          bucket.rttP50Ms,
          bucket.rttP90Ms,
          bucket.rttP99Ms,
        )
        for (const [binIndex, histogram] of bucket.histogram.entries()) {
          insertHistogram.run(
            targetSlug,
            file.granularity,
            bucket.bucketStart,
            binIndex,
            histogram.upperBoundMs,
            histogram.count,
          )
        }
        for (const hop of bucket.hops) {
          insertHop.run(
            targetSlug,
            file.granularity,
            bucket.bucketStart,
            hop.host,
            hop.representativeHopIndex,
            hop.snapshotCount,
            hop.sentCount,
            hop.replyCount,
            hop.lossPct,
            hop.rttAvgMs,
            hop.rttMinMs,
            hop.rttMaxMs,
            hop.rttP50Ms,
            hop.rttP90Ms,
            hop.rttP99Ms,
          )
          for (const hopIndex of hop.hopIndexes) {
            insertHopIndex.run(targetSlug, file.granularity, bucket.bucketStart, hop.host, hopIndex)
          }
        }
      }
    })
    upsert.immediate(rollupFile)
  }

  pruneRawSnapshots(targetSlug: string, keepDays: number, now: number): number {
    const cutoff = new Date(now - keepDays * 24 * 60 * 60 * 1000)
    const cutoffFileName = `${formatCompactCollectedAt(cutoff)}.json`
    const params: [string, string] = [targetSlug, cutoffFileName]
    for (const tableName of ['snapshot_hops', 'snapshot_destination_samples', 'snapshot_events']) {
      this.db
        .query<unknown, [string, string]>(
          `DELETE FROM ${tableName} WHERE target_slug = ? AND file_name < ?`,
        )
        .run(...params)
    }
    return this.db
      .query<unknown, [string, string]>(
        'DELETE FROM snapshots WHERE target_slug = ? AND file_name < ?',
      )
      .run(...params).changes
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

  integrityCheck(): string {
    return (
      this.db.query<IntegrityRow, []>('PRAGMA integrity_check').get()?.integrity_check ??
      'missing integrity_check result'
    )
  }

  verify(): SqliteVerifyResult {
    const sqliteCounts = this.getSnapshotCountsByTarget()
    const targets = [...sqliteCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([targetSlug, sqliteCount]) => ({ sqliteCount, targetSlug }))
    const sqliteSnapshotCount = [...sqliteCounts.values()].reduce((sum, count) => sum + count, 0)
    const sqliteIntegrity = this.integrityCheck()
    const legacyBlobColumns = this.legacyBlobColumns()
    const orphanedSnapshotDetailRows = this.countOrphanedSnapshotDetailRows()
    const orphanedRollupRows = this.countOrphanedRollupRows()
    const ok =
      sqliteIntegrity === 'ok' &&
      legacyBlobColumns.length === 0 &&
      orphanedSnapshotDetailRows === 0 &&
      orphanedRollupRows === 0

    return {
      legacyBlobColumns,
      ok,
      orphanedRollupRows,
      orphanedSnapshotDetailRows,
      sqliteIntegrity,
      sqliteSnapshotCount,
      targets,
    }
  }

  private legacyBlobColumns(): string[] {
    const snapshotColumns = this.tableColumns('snapshots')
    const rollupColumns = this.tableColumns('rollups')
    const columns: string[] = []
    for (const columnName of ['json', 'summary_json']) {
      if (snapshotColumns.has(columnName)) columns.push(`snapshots.${columnName}`)
    }
    if (rollupColumns.has('json')) columns.push('rollups.json')
    return columns
  }

  private countOrphanedSnapshotDetailRows(): number {
    return (
      this.db
        .query<CountRow, []>(
          `
            SELECT (
              SELECT COUNT(*)
              FROM snapshot_hops AS detail
              LEFT JOIN snapshots AS snapshot
                ON snapshot.target_slug = detail.target_slug
                AND snapshot.file_name = detail.file_name
              WHERE snapshot.file_name IS NULL
            ) + (
              SELECT COUNT(*)
              FROM snapshot_destination_samples AS detail
              LEFT JOIN snapshots AS snapshot
                ON snapshot.target_slug = detail.target_slug
                AND snapshot.file_name = detail.file_name
              WHERE snapshot.file_name IS NULL
            ) + (
              SELECT COUNT(*)
              FROM snapshot_events AS detail
              LEFT JOIN snapshots AS snapshot
                ON snapshot.target_slug = detail.target_slug
                AND snapshot.file_name = detail.file_name
              WHERE snapshot.file_name IS NULL
            ) AS count
          `,
        )
        .get()?.count ?? 0
    )
  }

  private countOrphanedRollupRows(): number {
    return (
      this.db
        .query<CountRow, []>(
          `
            SELECT (
              SELECT COUNT(*)
              FROM rollup_buckets AS detail
              LEFT JOIN rollups AS rollup
                ON rollup.target_slug = detail.target_slug
                AND rollup.granularity = detail.granularity
              WHERE rollup.target_slug IS NULL
            ) + (
              SELECT COUNT(*)
              FROM rollup_histogram_bins AS detail
              LEFT JOIN rollups AS rollup
                ON rollup.target_slug = detail.target_slug
                AND rollup.granularity = detail.granularity
              WHERE rollup.target_slug IS NULL
            ) + (
              SELECT COUNT(*)
              FROM rollup_hops AS detail
              LEFT JOIN rollups AS rollup
                ON rollup.target_slug = detail.target_slug
                AND rollup.granularity = detail.granularity
              WHERE rollup.target_slug IS NULL
            ) + (
              SELECT COUNT(*)
              FROM rollup_hop_indexes AS detail
              LEFT JOIN rollups AS rollup
                ON rollup.target_slug = detail.target_slug
                AND rollup.granularity = detail.granularity
              WHERE rollup.target_slug IS NULL
            ) AS count
          `,
        )
        .get()?.count ?? 0
    )
  }
}
