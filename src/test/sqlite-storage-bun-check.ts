import { Database } from 'bun:sqlite'
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import type { RawMtrEvent, StoredRawSnapshot } from '../lib/raw.ts'
import type { MtrRollupFile } from '../lib/rollups.ts'
import { HopwatchSqliteStore } from '../lib/sqlite-storage.ts'

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

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
  store.close()

  assertNoJsonBlobColumns(dbPath)
}

async function checkLegacyMigration(rootDir: string): Promise<void> {
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
    sha256(contents),
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

  const store = await HopwatchSqliteStore.open(dbPath)
  assert.equal(store.listSnapshotSummaries('example').length, 1)
  assert.deepEqual(store.getRollupFile('example', 'hour'), rollupFile())
  store.close()

  assertNoJsonBlobColumns(dbPath)
}

async function main(): Promise<void> {
  const rootDir = process.argv[2]
  if (rootDir == null) {
    throw new Error('Usage: bun sqlite-storage-bun-check.ts <tmpdir>')
  }
  await mkdir(rootDir, { recursive: true })
  try {
    await checkRelationalStorage(rootDir)
    await checkLegacyMigration(rootDir)
  } finally {
    await rm(rootDir, { force: true, recursive: true })
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
