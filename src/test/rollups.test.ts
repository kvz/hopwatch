import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { RawMtrEvent, StoredRawSnapshot } from '../lib/raw.ts'
import { aggregateSnapshotsToRollupBuckets, updateTargetRollups } from '../lib/rollups.ts'

function snap(collectedAt: string, rawEvents: RawMtrEvent[]): StoredRawSnapshot {
  return {
    collectedAt,
    fileName: `${collectedAt}.json`,
    host: 'example.com',
    label: 'example',
    observer: 'test-observer',
    probeMode: 'default',
    rawEvents,
    schemaVersion: 2,
    target: 'example.com',
  }
}

function destinationEvents(sentCount: number, rttUs: number[]): RawMtrEvent[] {
  const events: RawMtrEvent[] = [{ kind: 'host', hopIndex: 0, host: 'destination' }]
  for (let i = 0; i < sentCount; i += 1) {
    events.push({ kind: 'sent', hopIndex: 0, probeId: i })
  }
  for (let i = 0; i < rttUs.length; i += 1) {
    events.push({ kind: 'reply', hopIndex: 0, probeId: i, rttUs: rttUs[i] })
  }
  return events
}

describe('aggregateSnapshotsToRollupBuckets', () => {
  test('returns an empty array when no snapshots are provided', () => {
    expect(aggregateSnapshotsToRollupBuckets([], 'hour')).toEqual([])
  })

  test('groups snapshots from the same hour into one bucket with combined stats', () => {
    const snaps = [
      snap('20260420T100500Z', destinationEvents(20, [1000, 2000, 3000])),
      snap('20260420T104500Z', destinationEvents(20, [4000, 5000])),
    ]
    const buckets = aggregateSnapshotsToRollupBuckets(snaps, 'hour')
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({
      bucketStart: '2026-04-20T10:00:00.000Z',
      snapshotCount: 2,
      destinationSentCount: 40,
      destinationReplyCount: 5,
    })
    expect(buckets[0].destinationLossPct).toBeCloseTo(((40 - 5) / 40) * 100, 6)
    expect(buckets[0].rttMinMs).toBe(1)
    expect(buckets[0].rttMaxMs).toBe(5)
  })

  test('splits snapshots across hour boundaries', () => {
    const snaps = [
      snap('20260420T095500Z', destinationEvents(10, [1000])),
      snap('20260420T100500Z', destinationEvents(10, [2000])),
    ]
    const buckets = aggregateSnapshotsToRollupBuckets(snaps, 'hour')
    expect(buckets).toHaveLength(2)
    expect(buckets[0].bucketStart).toBe('2026-04-20T09:00:00.000Z')
    expect(buckets[1].bucketStart).toBe('2026-04-20T10:00:00.000Z')
  })

  test('buckets by day when granularity is day', () => {
    const snaps = [
      snap('20260420T000500Z', destinationEvents(10, [1000])),
      snap('20260420T230000Z', destinationEvents(10, [2000])),
      snap('20260421T010000Z', destinationEvents(10, [3000])),
    ]
    const buckets = aggregateSnapshotsToRollupBuckets(snaps, 'day')
    expect(buckets).toHaveLength(2)
    expect(buckets[0].bucketStart).toBe('2026-04-20T00:00:00.000Z')
    expect(buckets[0].snapshotCount).toBe(2)
    expect(buckets[1].bucketStart).toBe('2026-04-21T00:00:00.000Z')
  })

  test('computes 100% loss when all probes were lost', () => {
    const snaps = [snap('20260420T100000Z', destinationEvents(5, []))]
    const [bucket] = aggregateSnapshotsToRollupBuckets(snaps, 'hour')
    expect(bucket.destinationLossPct).toBe(100)
    expect(bucket.rttP50Ms).toBeNull()
    expect(bucket.histogram.every((h) => h.count === 0)).toBe(true)
  })

  test('histogram bins samples and leaves an overflow bucket', () => {
    const snaps = [snap('20260420T100000Z', destinationEvents(4, [500, 1500, 500_000, 1_100_000]))]
    const [bucket] = aggregateSnapshotsToRollupBuckets(snaps, 'hour')
    const overflow = bucket.histogram.find((h) => h.upperBoundMs == null)
    expect(overflow?.count).toBe(1)
    const totalBinned = bucket.histogram.reduce((sum, h) => sum + h.count, 0)
    expect(totalBinned).toBe(4)
  })
})

describe('updateTargetRollups daily RTT fidelity', () => {
  let targetDir: string

  beforeEach(async () => {
    targetDir = await mkdtemp(path.join(tmpdir(), 'hopwatch-rollup-'))
  })

  afterEach(async () => {
    await rm(targetDir, { recursive: true, force: true })
  })

  test('daily rttAvgMs matches the raw samples instead of being biased to histogram upper bounds', async () => {
    // 1500us = 1.5ms. The (1ms, 2ms] histogram bucket's upperBoundMs is 2ms. When
    // daily buckets are rebuilt by expanding hourly histograms, 1.5ms becomes 2ms.
    const rttUs = [1500, 1500, 1500, 1500]
    const snapshot = {
      collectedAt: '20260420T100000Z',
      fileName: '20260420T100000Z.json',
      host: 'example.com',
      label: 'example',
      observer: 'test-observer',
      probeMode: 'default',
      rawEvents: destinationEvents(4, rttUs),
      schemaVersion: 2,
      target: 'example.com',
    }
    await writeFile(
      path.join(targetDir, '20260420T100000Z.json'),
      JSON.stringify(snapshot, null, 2),
    )

    await updateTargetRollups(targetDir, {
      host: 'example.com',
      label: 'example',
      observer: 'test-observer',
      probeMode: 'default',
      target: 'example.com',
    })

    const daily = JSON.parse(await readFile(path.join(targetDir, 'daily.rollup.json'), 'utf8'))
    expect(daily.buckets).toHaveLength(1)
    expect(daily.buckets[0].rttAvgMs).toBeCloseTo(1.5, 6)
    expect(daily.buckets[0].rttP50Ms).toBeCloseTo(1.5, 6)
  })

  test('preserves a fuller historical hourly bucket instead of overwriting with a partial regeneration', async () => {
    const fullBucket = {
      bucketStart: '2026-04-20T10:00:00.000Z',
      destinationLossPct: 0,
      destinationReplyCount: 40,
      destinationSentCount: 40,
      histogram: [{ count: 40, upperBoundMs: 10 }],
      rttAvgMs: 5,
      rttMaxMs: 5,
      rttMinMs: 5,
      rttP50Ms: 5,
      rttP90Ms: 5,
      rttP99Ms: 5,
      snapshotCount: 4,
    }
    const existingHourly = {
      buckets: [fullBucket],
      generatedAt: '2026-04-20T11:00:00.000Z',
      granularity: 'hour',
      host: 'example.com',
      label: 'example',
      observer: 'test-observer',
      probeMode: 'default',
      schemaVersion: 1,
      target: 'example.com',
    }
    await writeFile(
      path.join(targetDir, 'hourly.rollup.json'),
      JSON.stringify(existingHourly, null, 2),
    )

    // Only one snapshot survives raw pruning for this hour — regenerated bucket would
    // have snapshotCount=1, overwriting the stored snapshotCount=4 bucket.
    const partial = {
      collectedAt: '20260420T104500Z',
      fileName: '20260420T104500Z.json',
      host: 'example.com',
      label: 'example',
      observer: 'test-observer',
      probeMode: 'default',
      rawEvents: destinationEvents(10, [5000]),
      schemaVersion: 2,
      target: 'example.com',
    }
    await writeFile(path.join(targetDir, '20260420T104500Z.json'), JSON.stringify(partial, null, 2))

    await updateTargetRollups(targetDir, {
      host: 'example.com',
      label: 'example',
      observer: 'test-observer',
      probeMode: 'default',
      target: 'example.com',
    })

    const hourly = JSON.parse(await readFile(path.join(targetDir, 'hourly.rollup.json'), 'utf8'))
    const bucket = hourly.buckets.find(
      (b: { bucketStart: string }) => b.bucketStart === '2026-04-20T10:00:00.000Z',
    )
    expect(bucket).toBeDefined()
    expect(bucket.snapshotCount).toBe(4)
    expect(bucket.destinationSentCount).toBe(40)
  })
})
