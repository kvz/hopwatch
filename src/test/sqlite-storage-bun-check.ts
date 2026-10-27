import { Database } from 'bun:sqlite'
import { strict as assert } from 'node:assert'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import type { RawMtrEvent, StoredRawSnapshot } from '../lib/raw.ts'
import type { MtrRollupFile } from '../lib/rollups.ts'
import { HopwatchSqliteStore } from '../lib/sqlite-storage.ts'

function destinationEvents(): RawMtrEvent[] {
  return [
    { kind: 'host', hopIndex: 0, host: '10.0.0.1' },
    { kind: 'dns', hopIndex: 0, host: 'gw.example' },
    { kind: 'sent', hopIndex: 0, probeId: 0 },
    { kind: 'reply', hopIndex: 0, probeId: 0, rttUs: 1_000 },
    { kind: 'sent', hopIndex: 0, probeId: 1 },
    { kind: 'reply', hopIndex: 0, probeId: 1, rttUs: 2_000 },
    { kind: 'host', hopIndex: 1, host: 'example.com' },
    { kind: 'sent', hopIndex: 1, probeId: 0 },
    { kind: 'reply', hopIndex: 1, probeId: 0, rttUs: 5_000 },
    { kind: 'sent', hopIndex: 1, probeId: 1 },
  ]
}

function snapshot(events: RawMtrEvent[] = destinationEvents()): StoredRawSnapshot {
  return {
    collectedAt: '20260429T120000Z',
    engine: 'mtr',
    fileName: '20260429T120000Z.json',
    host: 'example.com',
    label: 'Example',
    netns: null,
    observer: 'test-observer',
    port: 443,
    probeMode: 'default',
    protocol: 'icmp',
    rawEvents: events,
    schemaVersion: 2,
    target: 'example.com',
  }
}

function snapshotJson(rawSnapshot: StoredRawSnapshot): string {
  return `${JSON.stringify(rawSnapshot, null, 2)}\n`
}

function rollupFile(): MtrRollupFile {
  return {
    buckets: [
      {
        bucketStart: '2026-04-29T12:00:00.000Z',
        destinationLossPct: 50,
        destinationReplyCount: 1,
        destinationSentCount: 2,
        histogram: [
          { count: 1, upperBoundMs: 10 },
          { count: 0, upperBoundMs: null },
        ],
        hops: [
          {
            host: 'example.com',
            hopIndexes: [1],
            lossPct: 50,
            replyCount: 1,
            representativeHopIndex: 1,
            rttAvgMs: 5,
            rttMaxMs: 5,
            rttMinMs: 5,
            rttP50Ms: 5,
            rttP90Ms: 5,
            rttP99Ms: 5,
            sentCount: 2,
            snapshotCount: 1,
          },
        ],
        rttAvgMs: 5,
        rttMaxMs: 5,
        rttMinMs: 5,
        rttP50Ms: 5,
        rttP90Ms: 5,
        rttP99Ms: 5,
        snapshotCount: 1,
      },
    ],
    generatedAt: '2026-04-29T12:01:00.000Z',
    granularity: 'hour',
    host: 'example.com',
    label: 'Example',
    observer: 'test-observer',
    probeMode: 'default',
    schemaVersion: 2,
    target: 'example.com',
  }
}

function tableColumns(dbPath: string, tableName: string): string[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db
      .query<{ name: string }, []>(`PRAGMA table_info(${tableName})`)
      .all()
      .map((row) => row.name)
  } finally {
    db.close()
  }
}

function assertNoJsonBlobColumns(dbPath: string): void {
  assert(!tableColumns(dbPath, 'snapshots').includes('json'))
  assert(!tableColumns(dbPath, 'snapshots').includes('summary_json'))
  assert(!tableColumns(dbPath, 'rollups').includes('json'))
}

async function checkRelationalStorage(rootDir: string): Promise<void> {
  const dbPath = path.join(rootDir, 'relational.sqlite')
  const store = await HopwatchSqliteStore.open(dbPath)
  const rawSnapshot = snapshot()
  const contents = snapshotJson(rawSnapshot)
  store.insertRawSnapshot(
    {
      contents,
      fileName: rawSnapshot.fileName,
      sourcePath: `sqlite://example/${rawSnapshot.fileName}`,
      targetSlug: 'example',
    },
    rawSnapshot,
  )
  store.upsertRollupFile('example', rollupFile())

  const [summary] = store.listSnapshotSummaries('example')
  assert.equal(summary.destinationLossPct, 50)
  assert.deepEqual(summary.destinationRttSamplesMs, [5])
  assert.deepEqual(
    summary.hops.map((hop) => hop.host),
    ['gw.example (10.0.0.1)', 'example.com'],
  )
  assert.match(store.getSnapshotRawText('example', rawSnapshot.fileName) ?? '', /example\.com/)
  assert.deepEqual(
    JSON.parse(store.getSnapshotJson('example', rawSnapshot.fileName) ?? '{}'),
    rawSnapshot,
  )
  assert.deepEqual(store.getRollupFile('example', 'hour'), rollupFile())
  assert.deepEqual(store.verify(), {
    legacyBlobColumns: [],
    ok: true,
    orphanedRollupRows: 0,
    orphanedSnapshotDetailRows: 0,
    sqliteIntegrity: 'ok',
    sqliteSnapshotCount: 1,
    targets: [{ sqliteCount: 1, targetSlug: 'example' }],
  })
  store.close()

  assertNoJsonBlobColumns(dbPath)
}

async function checkLegacyBlobSchemasFailFast(rootDir: string): Promise<void> {
  const dbPath = path.join(rootDir, 'legacy.sqlite')
  const rawSnapshot = snapshot()
  const contents = snapshotJson(rawSnapshot)
  const db = new Database(dbPath, { create: true, readwrite: true })
  db.run(`
    CREATE TABLE snapshots (
      target_slug TEXT NOT NULL,
      file_name TEXT NOT NULL,
      source_path TEXT,
      sha256 TEXT,
      imported_at TEXT,
      json TEXT NOT NULL,
      summary_json TEXT,
      PRIMARY KEY (target_slug, file_name)
    )
  `)
  db.query<unknown, [string, string, string, string, string, string, string]>(
    `
      INSERT INTO snapshots (
        target_slug,
        file_name,
        source_path,
        sha256,
        imported_at,
        json,
        summary_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    'example',
    rawSnapshot.fileName,
    `/tmp/${rawSnapshot.fileName}`,
    'legacy-sha256',
    '2026-04-29T12:02:00.000Z',
    contents,
    '{}',
  )
  db.run(`
    CREATE TABLE rollups (
      target_slug TEXT NOT NULL,
      granularity TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (target_slug, granularity)
    )
  `)
  db.query<unknown, [string, string, string, string]>(
    'INSERT INTO rollups (target_slug, granularity, generated_at, json) VALUES (?, ?, ?, ?)',
  ).run('example', 'hour', '2026-04-29T12:01:00.000Z', `${JSON.stringify(rollupFile(), null, 2)}\n`)
  db.close()

  await assert.rejects(
    HopwatchSqliteStore.open(dbPath),
    /Unsupported legacy SQLite schema: snapshots still contains json\/summary_json columns/,
  )
}

async function checkProbeTimingMigrationAndRetention(rootDir: string): Promise<void> {
  const dbPath = path.join(rootDir, 'timing.sqlite')
  let store = await HopwatchSqliteStore.open(dbPath)
  const insert = (raw: StoredRawSnapshot): void =>
    store.insertRawSnapshot(
      {
        contents: snapshotJson(raw),
        fileName: raw.fileName,
        sourcePath: `sqlite://sentinel/${raw.fileName}`,
        targetSlug: 'sentinel',
      },
      raw,
    )
  const legacy = snapshot()
  insert(legacy)
  store.close()
  // Recreate the previous relational schema with an existing legacy snapshot.
  const db = new Database(dbPath)
  for (const name of [
    'started_at',
    'finished_at',
    'scheduled_at',
    'cycle_id',
    'destination_ip',
    'failure',
  ])
    db.run(`ALTER TABLE snapshots DROP COLUMN ${name}`)
  db.run('ALTER TABLE snapshot_events DROP COLUMN offset_ms')
  db.close()
  store = await HopwatchSqliteStore.open(dbPath)
  assert.deepEqual(JSON.parse(store.getLatestSnapshotJson('sentinel') ?? '{}'), legacy)
  const timed: StoredRawSnapshot = {
    ...snapshot(),
    engine: 'connect',
    protocol: 'tcp',
    collectedAt: '20261027T152300Z',
    fileName: '20261027T152300Z.json',
    startedAt: '2026-10-27T15:23:00.123Z',
    finishedAt: '2026-10-27T15:23:10.000Z',
    scheduledAt: '2026-10-27T15:23:00.000Z',
    cycleId: '20261027T152300Z',
    destinationIp: '203.0.113.5',
    rawEvents: destinationEvents().map((event, i) => ({ ...event, offsetMs: i * 10 })),
  }
  insert(timed)
  assert.deepEqual(JSON.parse(store.getLatestSnapshotJson('sentinel') ?? '{}'), timed)
  assert.equal(store.listSnapshotSummaries('sentinel')[0].startedAt, timed.startedAt)
  assert.match(
    store.getLatestSnapshotRawText('sentinel') ?? '',
    /finishedAt=2026-10-27T15:23:10.000Z/,
  )
  insert({ ...timed, collectedAt: '20261027T152330Z', fileName: '20261027T152330Z.json' })
  store.close()
  store = await HopwatchSqliteStore.open(dbPath)
  assert.equal(store.getProbeStatus('sentinel').recent.length, 2)
  assert.equal(store.getProbeStatus('sentinel').recent[0].destinationLossPct, 50)
  const failure: StoredRawSnapshot = {
    ...timed,
    collectedAt: '20261027T152400Z',
    fileName: '20261027T152400Z.json',
    rawEvents: [],
    failure: 'DNS unavailable',
  }
  insert(failure)
  const status = store.getProbeStatus('sentinel')
  assert.equal(status.collectorFailures, 1)
  assert.equal(status.recent[0].destinationLossPct, null)
  assert.equal(status.lastSuccess?.collectedAt, '20261027T152330Z')
  assert.equal(store.listSnapshotSummaries('sentinel')[0].diagnosis.label, 'Collector failure')
  assert.equal(store.pruneRawSnapshots('sentinel', 1, Date.parse('2026-10-28T15:24:01Z')), 4)
  assert.equal(store.getProbeStatus('sentinel').recent.length, 0)
  assert.equal(store.verify().orphanedSnapshotDetailRows, 0)
  store.close()
}

async function main(): Promise<void> {
  const rootDir = process.argv[2]
  if (rootDir == null) {
    throw new Error('Usage: bun sqlite-storage-bun-check.ts <tmpdir>')
  }
  await mkdir(rootDir, { recursive: true })
  try {
    await checkRelationalStorage(rootDir)
    await checkLegacyBlobSchemasFailFast(rootDir)
    await checkProbeTimingMigrationAndRetention(rootDir)
  } finally {
    await rm(rootDir, { force: true, recursive: true })
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
