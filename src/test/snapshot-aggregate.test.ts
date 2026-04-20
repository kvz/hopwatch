import { describe, expect, test } from 'vitest'
import type { SnapshotSummary } from '../lib/snapshot.ts'
import {
  getHistoricalSeverityBadge,
  getRootSuspectHop,
  type HopAggregate,
  selectSnapshotsInWindow,
  shouldSurfaceHopIssueForRoot,
  summarizeHopIssues,
  summarizeSnapshots,
} from '../lib/snapshot-aggregate.ts'

function snapshot(partial: Partial<SnapshotSummary> & { collectedAt: string }): SnapshotSummary {
  return {
    destinationAvgRttMs: null,
    destinationLossPct: 0,
    destinationRttMaxMs: null,
    destinationRttMinMs: null,
    destinationRttP50Ms: null,
    destinationRttP90Ms: null,
    destinationRttSamplesMs: null,
    diagnosis: {
      kind: 'healthy',
      label: 'Healthy',
      summary: '',
      suspectHopHost: null,
      suspectHopIndex: null,
    },
    fileName: 'ignored.json',
    host: 'example.com',
    hopCount: 0,
    hops: [],
    probeMode: 'default',
    rawText: '',
    target: 'example.com',
    worstHopLossPct: null,
    ...partial,
  }
}

const now = Date.UTC(2026, 3, 20, 12, 0, 0)
const HOUR = 60 * 60 * 1000

describe('selectSnapshotsInWindow', () => {
  test('keeps snapshots collected after (now - window)', () => {
    const snaps = [
      snapshot({ collectedAt: '20260420T100000Z' }),
      snapshot({ collectedAt: '20260420T115000Z' }),
      snapshot({ collectedAt: '20260420T080000Z' }),
    ]
    const filtered = selectSnapshotsInWindow(snaps, now, 2 * HOUR)
    expect(filtered).toHaveLength(2)
  })

  test('drops snapshots with unparseable collectedAt', () => {
    const snaps = [snapshot({ collectedAt: 'nope' })]
    expect(selectSnapshotsInWindow(snaps, now, HOUR)).toHaveLength(0)
  })
})

describe('summarizeSnapshots', () => {
  test('averages destination loss across in-window snapshots', () => {
    const snaps = [
      snapshot({ collectedAt: '20260420T110000Z', destinationLossPct: 10 }),
      snapshot({ collectedAt: '20260420T113000Z', destinationLossPct: 20 }),
    ]
    const agg = summarizeSnapshots(selectSnapshotsInWindow(snaps, now, 2 * HOUR))
    expect(agg.sampleCount).toBe(2)
    expect(agg.averageDestinationLossPct).toBe(15)
  })
})

describe('getHistoricalSeverityBadge', () => {
  test('returns Unknown for empty windows', () => {
    expect(
      getHistoricalSeverityBadge(
        { averageDestinationLossPct: null, averageWorstHopLossPct: null, sampleCount: 0 },
        {
          destinationLossCount: 0,
          healthyCount: 0,
          intermediateOnlyCount: 0,
          sampleCount: 0,
          unknownCount: 0,
        },
      ).className,
    ).toBe('unknown')
  })

  test('returns Stable when no destination loss observed', () => {
    expect(
      getHistoricalSeverityBadge(
        { averageDestinationLossPct: 0, averageWorstHopLossPct: 0, sampleCount: 20 },
        {
          destinationLossCount: 0,
          healthyCount: 20,
          intermediateOnlyCount: 0,
          sampleCount: 20,
          unknownCount: 0,
        },
      ).className,
    ).toBe('good')
  })

  test('returns Degraded when destination loss rate is high', () => {
    expect(
      getHistoricalSeverityBadge(
        { averageDestinationLossPct: 30, averageWorstHopLossPct: 20, sampleCount: 10 },
        {
          destinationLossCount: 5,
          healthyCount: 5,
          intermediateOnlyCount: 0,
          sampleCount: 10,
          unknownCount: 0,
        },
      ).className,
    ).toBe('bad')
  })

  test('returns Flaky for intermittent loss', () => {
    expect(
      getHistoricalSeverityBadge(
        { averageDestinationLossPct: 2, averageWorstHopLossPct: 1, sampleCount: 100 },
        {
          destinationLossCount: 1,
          healthyCount: 99,
          intermediateOnlyCount: 0,
          sampleCount: 100,
          unknownCount: 0,
        },
      ).className,
    ).toBe('warn')
  })
})

describe('summarizeHopIssues + getRootSuspectHop', () => {
  test('tallies downstream vs isolated loss per hop and surfaces a root suspect', () => {
    const snaps = [
      snapshot({
        collectedAt: '20260420T113000Z',
        destinationLossPct: 10,
        hops: [
          {
            asn: null,
            avgMs: null,
            bestMs: null,
            host: 'router.example',
            index: 2,
            lastMs: null,
            lossPct: 30,
            sent: null,
            stdevMs: null,
            worstMs: null,
          },
          {
            asn: null,
            avgMs: null,
            bestMs: null,
            host: 'destination',
            index: 3,
            lastMs: null,
            lossPct: 10,
            sent: null,
            stdevMs: null,
            worstMs: null,
          },
        ],
      }),
      snapshot({
        collectedAt: '20260420T114500Z',
        destinationLossPct: 20,
        hops: [
          {
            asn: null,
            avgMs: null,
            bestMs: null,
            host: 'router.example',
            index: 2,
            lastMs: null,
            lossPct: 40,
            sent: null,
            stdevMs: null,
            worstMs: null,
          },
          {
            asn: null,
            avgMs: null,
            bestMs: null,
            host: 'destination',
            index: 3,
            lastMs: null,
            lossPct: 20,
            sent: null,
            stdevMs: null,
            worstMs: null,
          },
        ],
      }),
    ]
    const issues = summarizeHopIssues(selectSnapshotsInWindow(snaps, now, HOUR))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      host: 'router.example',
      downstreamLossCount: 2,
      isolatedLossCount: 0,
      sampleCount: 2,
    })
    expect(getRootSuspectHop(issues)?.host).toBe('router.example')
  })

  test('hops with only isolated loss are not root suspects', () => {
    const hop: HopAggregate = {
      averageLossPct: 10,
      downstreamLossCount: 0,
      host: 'router.example',
      isolatedLossCount: 3,
      latestHopIndex: 2,
      sampleCount: 3,
    }
    expect(shouldSurfaceHopIssueForRoot(hop)).toBe(false)
  })

  test('latestHopIndex tracks the most recent snapshot regardless of input order', () => {
    // Same hop host reported at different indices across snapshots — the UI
    // should surface the most recently observed index, so a routing change
    // (hop 2 → hop 5) is reflected in the "latest index" column even when
    // callers pass snapshots newest-first (as renderRootIndex does).
    const newest = snapshot({
      collectedAt: '20260420T115000Z',
      destinationLossPct: 5,
      hops: [
        {
          asn: null,
          avgMs: null,
          bestMs: null,
          host: 'router.example',
          index: 5,
          lastMs: null,
          lossPct: 20,
          sent: null,
          stdevMs: null,
          worstMs: null,
        },
        {
          asn: null,
          avgMs: null,
          bestMs: null,
          host: 'destination',
          index: 6,
          lastMs: null,
          lossPct: 5,
          sent: null,
          stdevMs: null,
          worstMs: null,
        },
      ],
    })
    const oldest = snapshot({
      collectedAt: '20260420T100000Z',
      destinationLossPct: 5,
      hops: [
        {
          asn: null,
          avgMs: null,
          bestMs: null,
          host: 'router.example',
          index: 2,
          lastMs: null,
          lossPct: 20,
          sent: null,
          stdevMs: null,
          worstMs: null,
        },
        {
          asn: null,
          avgMs: null,
          bestMs: null,
          host: 'destination',
          index: 3,
          lastMs: null,
          lossPct: 5,
          sent: null,
          stdevMs: null,
          worstMs: null,
        },
      ],
    })
    // Production order: page.tsx reverses listSnapshotFileNames to pass snapshots
    // newest-first. If summarizeHopIssues picked latestHopIndex by iteration
    // order, the oldest (index 2) would win. It must use collectedAt instead.
    const issues = summarizeHopIssues(selectSnapshotsInWindow([newest, oldest], now, 4 * HOUR))
    const router = issues.find((hop) => hop.host === 'router.example')
    expect(router?.latestHopIndex).toBe(5)
  })

  test('placeholder ??? hops are filtered from root suspect', () => {
    const hop: HopAggregate = {
      averageLossPct: 100,
      downstreamLossCount: 5,
      host: '???',
      isolatedLossCount: 0,
      latestHopIndex: null,
      sampleCount: 5,
    }
    expect(shouldSurfaceHopIssueForRoot(hop)).toBe(false)
  })
})
