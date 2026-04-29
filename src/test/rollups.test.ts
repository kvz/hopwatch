import { describe, expect, test } from 'vitest'
import type { RawMtrEvent, StoredRawSnapshot } from '../lib/raw.ts'
import {
  aggregateSnapshotsToRollupBuckets,
  type MtrRollupBucket,
  mergeRollupBuckets,
  mtrRollupFileSchema,
} from '../lib/rollups.ts'

function snap(collectedAt: string, rawEvents: RawMtrEvent[]): StoredRawSnapshot {
  return {
    collectedAt,
    fileName: `${collectedAt}.json`,
    host: 'example.com',
    label: 'example',
    observer: 'test-observer',
    engine: 'mtr',
    netns: null,
    port: 443,
    probeMode: 'default',
    protocol: 'icmp',
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

  test('reports 100% loss (not 0%) when every snapshot in a bucket was completely blackholed', () => {
    // resolveDestinationHopIndex returns null when nothing survives - no
    // reply/host events at any hop - and summarizeDestinationSamples returns
    // sentCount: 0. Before the fix, buildRollupBucket short-circuited that to
    // destinationLossPct=0, so a full hour of "target unreachable" appeared as
    // a healthy 0% bar on the long-range chart, hiding the outage.
    const blackholed: StoredRawSnapshot = {
      collectedAt: '20260420T100000Z',
      engine: 'mtr',
      fileName: '20260420T100000Z.json',
      host: 'example.com',
      label: 'example',
      netns: null,
      observer: 'test-observer',
      port: 443,
      probeMode: 'default',
      protocol: 'icmp',
      // Only `sent` events, no replies and no host - resolveDestinationHopIndex
      // returns null, so both sentCount and replyCount are 0.
      rawEvents: [
        { kind: 'sent', hopIndex: 0, probeId: 0 },
        { kind: 'sent', hopIndex: 0, probeId: 1 },
      ],
      schemaVersion: 2,
      target: 'example.com',
    }
    const [bucket] = aggregateSnapshotsToRollupBuckets([blackholed], 'hour')
    expect(bucket.destinationLossPct).toBe(100)
  })

  test('histogram bins samples and leaves an overflow bucket', () => {
    const snaps = [snap('20260420T100000Z', destinationEvents(4, [500, 1500, 500_000, 1_100_000]))]
    const [bucket] = aggregateSnapshotsToRollupBuckets(snaps, 'hour')
    const overflow = bucket.histogram.find((h) => h.upperBoundMs == null)
    expect(overflow?.count).toBe(1)
    const totalBinned = bucket.histogram.reduce((sum, h) => sum + h.count, 0)
    expect(totalBinned).toBe(4)
  })

  test('hourly bucket aggregates per-hop stats keyed by host', () => {
    const pathEvents = (rttsByHop: Record<number, number[]>, hosts: Record<number, string>) => {
      const events: RawMtrEvent[] = []
      for (const [idxStr, host] of Object.entries(hosts)) {
        events.push({ kind: 'host', hopIndex: Number(idxStr), host })
      }
      for (const [idxStr, rtts] of Object.entries(rttsByHop)) {
        const idx = Number(idxStr)
        for (let i = 0; i < rtts.length; i += 1) {
          events.push({ kind: 'sent', hopIndex: idx, probeId: i })
          events.push({ kind: 'reply', hopIndex: idx, probeId: i, rttUs: rtts[i] })
        }
      }
      return events
    }
    const snaps = [
      snap(
        '20260420T100500Z',
        pathEvents(
          { 0: [1000], 1: [2000, 3000], 2: [5000] },
          { 0: 'router-a', 1: 'router-b', 2: 'dest' },
        ),
      ),
      snap(
        '20260420T103000Z',
        pathEvents(
          { 0: [1500], 1: [2500], 2: [4000, 4500] },
          { 0: 'router-a', 1: 'router-b', 2: 'dest' },
        ),
      ),
    ]
    const [bucket] = aggregateSnapshotsToRollupBuckets(snaps, 'hour')
    expect(bucket.hops).toHaveLength(3)
    const routerA = bucket.hops.find((h) => h.host === 'router-a')
    expect(routerA).toBeDefined()
    expect(routerA?.hopIndexes).toEqual([0])
    expect(routerA?.representativeHopIndex).toBe(0)
    expect(routerA?.snapshotCount).toBe(2)
    expect(routerA?.sentCount).toBe(2)
    expect(routerA?.replyCount).toBe(2)
    expect(routerA?.rttAvgMs).toBeCloseTo(1.25, 6)
    const routerB = bucket.hops.find((h) => h.host === 'router-b')
    expect(routerB?.sentCount).toBe(3)
    expect(routerB?.replyCount).toBe(3)
    const dest = bucket.hops.find((h) => h.host === 'dest')
    expect(dest?.representativeHopIndex).toBe(2)
  })

  test('ECMP: same host at two TTLs collapses into one hop entry with both hopIndexes', () => {
    const events: RawMtrEvent[] = [
      { kind: 'host', hopIndex: 5, host: 'edge-router' },
      { kind: 'host', hopIndex: 6, host: 'edge-router' },
      { kind: 'host', hopIndex: 7, host: 'dest' },
      { kind: 'sent', hopIndex: 5, probeId: 0 },
      { kind: 'reply', hopIndex: 5, probeId: 0, rttUs: 5000 },
      { kind: 'sent', hopIndex: 6, probeId: 1 },
      { kind: 'reply', hopIndex: 6, probeId: 1, rttUs: 6000 },
      { kind: 'sent', hopIndex: 7, probeId: 2 },
      { kind: 'reply', hopIndex: 7, probeId: 2, rttUs: 10000 },
    ]
    const [bucket] = aggregateSnapshotsToRollupBuckets([snap('20260420T100000Z', events)], 'hour')
    const edge = bucket.hops.find((h) => h.host === 'edge-router')
    expect(edge).toBeDefined()
    expect(edge?.hopIndexes).toEqual([5, 6])
    expect(edge?.sentCount).toBe(2)
    expect(edge?.replyCount).toBe(2)
  })

  test('v1 rollup files still parse and get normalized hops:[] per bucket', () => {
    const v1File = {
      buckets: [
        {
          bucketStart: '2026-04-20T10:00:00.000Z',
          destinationLossPct: 0,
          destinationReplyCount: 4,
          destinationSentCount: 4,
          histogram: [{ count: 4, upperBoundMs: 10 }],
          rttAvgMs: 5,
          rttMaxMs: 5,
          rttMinMs: 5,
          rttP50Ms: 5,
          rttP90Ms: 5,
          rttP99Ms: 5,
          snapshotCount: 4,
        },
      ],
      generatedAt: '2026-04-20T11:00:00.000Z',
      granularity: 'hour' as const,
      host: 'example.com',
      label: 'example',
      observer: 'test-observer',
      probeMode: 'default' as const,
      schemaVersion: 1 as const,
      target: 'example.com',
    }
    const parsed = mtrRollupFileSchema.parse(v1File)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.buckets[0].hops).toEqual([])
  })

  test('daily rollup keeps hops:[] even when snapshots contain hop events', () => {
    const events: RawMtrEvent[] = [
      { kind: 'host', hopIndex: 0, host: 'dest' },
      { kind: 'sent', hopIndex: 0, probeId: 0 },
      { kind: 'reply', hopIndex: 0, probeId: 0, rttUs: 5000 },
    ]
    const [bucket] = aggregateSnapshotsToRollupBuckets([snap('20260420T100000Z', events)], 'day')
    expect(bucket.hops).toEqual([])
  })

  test('daily rttAvgMs is derived from raw samples rather than histogram upper bounds', () => {
    const [bucket] = aggregateSnapshotsToRollupBuckets(
      [snap('20260420T100000Z', destinationEvents(4, [1500, 1500, 1500, 1500]))],
      'day',
    )
    expect(bucket.rttAvgMs).toBeCloseTo(1.5, 6)
    expect(bucket.rttP50Ms).toBeCloseTo(1.5, 6)
  })

  test('mergeRollupBuckets preserves a fuller historical bucket over a partial regeneration', () => {
    const fullBucket = {
      bucketStart: '2026-04-20T10:00:00.000Z',
      destinationLossPct: 0,
      destinationReplyCount: 40,
      destinationSentCount: 40,
      histogram: [{ count: 40, upperBoundMs: 10 }],
      hops: [],
      rttAvgMs: 5,
      rttMaxMs: 5,
      rttMinMs: 5,
      rttP50Ms: 5,
      rttP90Ms: 5,
      rttP99Ms: 5,
      snapshotCount: 4,
    } satisfies MtrRollupBucket
    const [partialBucket] = aggregateSnapshotsToRollupBuckets(
      [snap('20260420T104500Z', destinationEvents(10, [5000]))],
      'hour',
    )

    const [merged] = mergeRollupBuckets(
      [fullBucket],
      [partialBucket],
      Date.parse('2026-04-21T00:00:00Z'),
      90,
    )

    expect(merged.snapshotCount).toBe(4)
    expect(merged.destinationSentCount).toBe(40)
  })
})
