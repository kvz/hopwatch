import { describe, expect, test } from 'vitest'
import type { SnapshotSummary } from '../lib/snapshot.ts'
import {
  getCrossTargetDiagnosis,
  getHistoricalSeverityBadge,
  getRootSuspectHop,
  type HopAggregate,
  selectSnapshotsInWindow,
  shouldSurfaceHopIssueForRoot,
  summarizeCrossTargetHopIssues,
  summarizeHopIssues,
  summarizeSnapshots,
} from '../lib/snapshot-aggregate.ts'

function snapshot(partial: Partial<SnapshotSummary> & { collectedAt: string }): SnapshotSummary {
  return {
    destinationAvgRttMs: null,
    destinationHopIndex: null,
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
    protocol: 'icmp',
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
        {
          averageDestinationLossPct: null,
          averageDestinationMedianRttMs: null,
          averageWorstHopLossPct: null,
          sampleCount: 0,
        },
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
        {
          averageDestinationLossPct: 0,
          averageDestinationMedianRttMs: null,
          averageWorstHopLossPct: 0,
          sampleCount: 20,
        },
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
        {
          averageDestinationLossPct: 30,
          averageDestinationMedianRttMs: null,
          averageWorstHopLossPct: 20,
          sampleCount: 10,
        },
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
        {
          averageDestinationLossPct: 2,
          averageDestinationMedianRttMs: null,
          averageWorstHopLossPct: 1,
          sampleCount: 100,
        },
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

  test('does not count the real destination as an intermediate hop when a phantom trailing hop follows it', () => {
    // MTR sometimes emits an extra hop past the real destination (same host,
    // TTL bumped by one). `resolveDestinationHopIndex` sets
    // `destinationHopIndex` to the real hop (index 3 here), but the phantom
    // lives at index 4 — so `slice(0, -1)` would still include the real
    // destination in the intermediates tally and attribute its loss to it.
    const snap = snapshot({
      collectedAt: '20260420T120000Z',
      destinationHopIndex: 3,
      destinationLossPct: 20,
      hops: [
        {
          asn: null,
          avgMs: null,
          bestMs: null,
          host: 'router.example',
          index: 1,
          lastMs: null,
          lossPct: 0,
          sent: null,
          stdevMs: null,
          worstMs: null,
        },
        {
          asn: null,
          avgMs: null,
          bestMs: null,
          host: 'upstream.example',
          index: 2,
          lastMs: null,
          lossPct: 0,
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
        {
          asn: null,
          avgMs: null,
          bestMs: null,
          host: 'destination',
          index: 4,
          lastMs: null,
          lossPct: 80,
          sent: null,
          stdevMs: null,
          worstMs: null,
        },
      ],
    })
    const issues = summarizeHopIssues(selectSnapshotsInWindow([snap], now, HOUR))
    // Only the phantom trailing hop should be considered "beyond" the real
    // destination — i.e. the real destination (index 3) must not appear as
    // an intermediate.
    expect(issues.find((issue) => issue.latestHopIndex === 3)).toBeUndefined()
  })
})

describe('summarizeCrossTargetHopIssues + getCrossTargetDiagnosis', () => {
  const suspect = (partial: Partial<HopAggregate> & { host: string }): HopAggregate => ({
    averageLossPct: 10,
    downstreamLossCount: 2,
    isolatedLossCount: 0,
    latestHopIndex: 2,
    sampleCount: 5,
    ...partial,
  })

  test('groups a shared hop across multiple targets and sums its downstream-loss tallies', () => {
    const cross = summarizeCrossTargetHopIssues([
      {
        asnByHost: new Map([['router.example', 'AS24940']]),
        hopIssues: [
          suspect({ host: 'router.example', downstreamLossCount: 3, averageLossPct: 12 }),
        ],
        protocol: 'icmp',
        target: 's3-us-east-1',
      },
      {
        asnByHost: new Map([['router.example', 'AS24940']]),
        hopIssues: [
          suspect({ host: 'router.example', downstreamLossCount: 4, averageLossPct: 18 }),
        ],
        protocol: 'icmp',
        target: 's3-us-west-2',
      },
    ])
    expect(cross).toHaveLength(1)
    expect(cross[0]).toMatchObject({
      host: 'router.example',
      asn: 'AS24940',
      targetCount: 2,
      totalDownstreamLoss: 7,
    })
    expect(cross[0].targets.sort()).toEqual(['s3-us-east-1', 's3-us-west-2'])
  })

  test('ignores hops that a per-target aggregate already rejected as not root-suspect', () => {
    // A hop with only isolated loss shouldn't be elevated to "cross-target
    // escalation" just because it appears on many targets — that's usually
    // ICMP reply rate-limiting, not a real upstream issue.
    const cross = summarizeCrossTargetHopIssues([
      {
        asnByHost: new Map(),
        hopIssues: [
          suspect({ host: 'rate-limited.example', downstreamLossCount: 0, isolatedLossCount: 5 }),
        ],
        protocol: 'icmp',
        target: 'target-a',
      },
      {
        asnByHost: new Map(),
        hopIssues: [
          suspect({ host: 'rate-limited.example', downstreamLossCount: 0, isolatedLossCount: 5 }),
        ],
        protocol: 'icmp',
        target: 'target-b',
      },
    ])
    expect(cross).toHaveLength(0)
  })

  test('diagnosis is neutral when no hop is shared across ≥2 targets', () => {
    const diagnosis = getCrossTargetDiagnosis([
      {
        asn: null,
        averageLossPct: 5,
        host: 'isolated.example',
        icmpAverageLossPct: null,
        icmpTargetCount: 0,
        tcpAverageLossPct: null,
        tcpTargetCount: 0,
        targetCount: 1,
        targets: ['only-one'],
        totalDownstreamLoss: 3,
        totalIsolatedLoss: 0,
        totalSampleCount: 5,
      },
    ])
    expect(diagnosis.className).toBe('good')
    expect(diagnosis.suspect).toBeNull()
    expect(diagnosis.shape.kind).toBe('none')
  })

  test('diagnosis flags bad vs warn based on total downstream-loss volume', () => {
    const mildBase = {
      asn: 'AS24940',
      averageLossPct: 8,
      host: 'shared.example',
      icmpAverageLossPct: 8,
      icmpTargetCount: 2,
      tcpAverageLossPct: null,
      tcpTargetCount: 0,
      targetCount: 2,
      targets: ['a', 'b'],
      totalDownstreamLoss: 4,
      totalIsolatedLoss: 0,
      totalSampleCount: 10,
    }
    expect(getCrossTargetDiagnosis([mildBase]).className).toBe('warn')
    expect(getCrossTargetDiagnosis([mildBase]).shape.kind).toBe('downstream_from_hop')

    const severe = { ...mildBase, totalDownstreamLoss: 12 }
    expect(getCrossTargetDiagnosis([severe]).className).toBe('bad')
    // The summary should name the hop, ASN, and escalation call-to-action so
    // the page reads as actionable, not just descriptive.
    expect(getCrossTargetDiagnosis([severe]).summary).toContain('shared.example')
    expect(getCrossTargetDiagnosis([severe]).summary).toContain('AS24940')
    expect(getCrossTargetDiagnosis([severe]).summary).toContain('escalating')
  })

  test('diagnosis classifies protocol-selective loss when TCP >> ICMP at the same hop', () => {
    // Mirrors the SIN -> us-west-2 incident: same router, ICMP clean, TCP
    // drops half the probes. The panel should say "protocol-selective",
    // not the generic "upstream path degraded" — they point at different
    // remediations (fight the upstream ISP about a middlebox policy vs.
    // demand more link capacity).
    const protocolSelective = {
      asn: 'AS38093',
      averageLossPct: 30,
      host: 'vqbn-egress.example',
      icmpAverageLossPct: 0.5,
      icmpTargetCount: 1,
      tcpAverageLossPct: 51,
      tcpTargetCount: 2,
      targetCount: 3,
      targets: ['tcp-mtr', 'tcp-native', 'icmp'],
      totalDownstreamLoss: 12,
      totalIsolatedLoss: 0,
      totalSampleCount: 30,
    }
    const diagnosis = getCrossTargetDiagnosis([protocolSelective])
    expect(diagnosis.shape.kind).toBe('protocol_selective')
    expect(diagnosis.label).toBe('Protocol-selective loss')
    expect(diagnosis.summary).toContain('51.0%')
    expect(diagnosis.summary).toContain('0.5%')
    expect(diagnosis.summary).toContain('middlebox')
  })

  test('does NOT flag protocol-selective when ICMP is also lossy (real capacity problem)', () => {
    // Both protocols see substantial loss — that's not policy-driven, it's
    // the classic "sick router drops packets" signature. Fall through to
    // the generic downstream_from_hop shape so the operator gets the
    // escalate-upstream message instead of the protocol-asymmetry one.
    const bothLossy = {
      asn: 'AS24940',
      averageLossPct: 40,
      host: 'sick-router.example',
      icmpAverageLossPct: 45,
      icmpTargetCount: 1,
      tcpAverageLossPct: 48,
      tcpTargetCount: 1,
      targetCount: 2,
      targets: ['icmp', 'tcp'],
      totalDownstreamLoss: 14,
      totalIsolatedLoss: 0,
      totalSampleCount: 20,
    }
    expect(getCrossTargetDiagnosis([bothLossy]).shape.kind).toBe('downstream_from_hop')
  })

  test('does NOT flag protocol-selective when only one protocol is represented', () => {
    // Classifier requires at least one ICMP and one TCP target at the same
    // hop — a single protocol in the cluster can't establish asymmetry.
    const onlyTcp = {
      asn: null,
      averageLossPct: 50,
      host: 'tcp-only.example',
      icmpAverageLossPct: null,
      icmpTargetCount: 0,
      tcpAverageLossPct: 50,
      tcpTargetCount: 2,
      targetCount: 2,
      targets: ['a', 'b'],
      totalDownstreamLoss: 12,
      totalIsolatedLoss: 0,
      totalSampleCount: 20,
    }
    expect(getCrossTargetDiagnosis([onlyTcp]).shape.kind).toBe('downstream_from_hop')
  })

  test('per-protocol averages are computed from the per-target hop inputs', () => {
    // Regression test for the summarizer's per-protocol accumulator: ICMP
    // comes out near zero, TCP near 50%, and both target counts are 1 — the
    // exact inputs classifyCrossTargetShape needs to recognize the shape.
    const cross = summarizeCrossTargetHopIssues([
      {
        asnByHost: new Map(),
        hopIssues: [suspect({ host: 'router.example', averageLossPct: 0, downstreamLossCount: 2 })],
        protocol: 'icmp',
        target: 'icmp-target',
      },
      {
        asnByHost: new Map(),
        hopIssues: [
          suspect({ host: 'router.example', averageLossPct: 50, downstreamLossCount: 5 }),
        ],
        protocol: 'tcp',
        target: 'tcp-target',
      },
    ])
    expect(cross).toHaveLength(1)
    expect(cross[0].icmpAverageLossPct).toBe(0)
    expect(cross[0].tcpAverageLossPct).toBe(50)
    expect(cross[0].icmpTargetCount).toBe(1)
    expect(cross[0].tcpTargetCount).toBe(1)
  })
})
