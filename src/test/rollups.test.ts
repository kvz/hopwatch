import { describe, expect, test } from 'vitest'
import type { RawMtrEvent, StoredRawSnapshot } from '../lib/raw.ts'
import { aggregateSnapshotsToRollupBuckets } from '../lib/rollups.ts'

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
