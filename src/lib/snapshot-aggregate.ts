import { parseCollectedAt, type SnapshotSummary } from './snapshot.ts'

export interface SnapshotAggregate {
  averageDestinationLossPct: number | null
  averageWorstHopLossPct: number | null
  sampleCount: number
}

export interface DiagnosisAggregate {
  destinationLossCount: number
  healthyCount: number
  intermediateOnlyCount: number
  sampleCount: number
  unknownCount: number
}

export interface SeverityBadge {
  className: 'good' | 'warn' | 'bad' | 'unknown'
  label: string
  summary: string
}

export interface HopAggregate {
  averageLossPct: number | null
  downstreamLossCount: number
  host: string
  isolatedLossCount: number
  latestHopIndex: number | null
  sampleCount: number
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function selectSnapshotsInWindow(
  snapshots: SnapshotSummary[],
  now: number,
  windowMs: number,
): SnapshotSummary[] {
  const cutoff = now - windowMs
  return snapshots.filter((snapshot) => {
    const timestamp = parseCollectedAt(snapshot.collectedAt)
    return timestamp != null && timestamp >= cutoff
  })
}

// summarize* helpers expect snapshots already restricted to the window of
// interest — pass through selectSnapshotsInWindow() first. Letting the caller
// pre-filter once and reuse the slice for multiple aggregates (as page.tsx
// does) avoids redoing the cutoff walk per helper.
export function summarizeSnapshots(snapshotsInWindow: SnapshotSummary[]): SnapshotAggregate {
  return {
    averageDestinationLossPct: average(
      snapshotsInWindow.flatMap((snapshot) =>
        snapshot.destinationLossPct == null ? [] : [snapshot.destinationLossPct],
      ),
    ),
    averageWorstHopLossPct: average(
      snapshotsInWindow.flatMap((snapshot) =>
        snapshot.worstHopLossPct == null ? [] : [snapshot.worstHopLossPct],
      ),
    ),
    sampleCount: snapshotsInWindow.length,
  }
}

export function summarizeDiagnoses(snapshotsInWindow: SnapshotSummary[]): DiagnosisAggregate {
  const aggregate: DiagnosisAggregate = {
    destinationLossCount: 0,
    healthyCount: 0,
    intermediateOnlyCount: 0,
    sampleCount: 0,
    unknownCount: 0,
  }

  for (const snapshot of snapshotsInWindow) {
    aggregate.sampleCount += 1
    if (snapshot.diagnosis.kind === 'destination_loss') {
      aggregate.destinationLossCount += 1
    } else if (snapshot.diagnosis.kind === 'healthy') {
      aggregate.healthyCount += 1
    } else if (snapshot.diagnosis.kind === 'intermediate_only_loss') {
      aggregate.intermediateOnlyCount += 1
    } else {
      aggregate.unknownCount += 1
    }
  }

  return aggregate
}

export function getHistoricalSeverityBadge(
  aggregate: SnapshotAggregate,
  diagnosisAggregate: DiagnosisAggregate,
): SeverityBadge {
  if (diagnosisAggregate.sampleCount === 0) {
    return {
      className: 'unknown',
      label: 'Unknown',
      summary: 'No snapshots were collected in this window.',
    }
  }

  if (diagnosisAggregate.destinationLossCount === 0) {
    return {
      className: 'good',
      label: 'Stable',
      summary: 'No destination loss was observed in the last 7 days.',
    }
  }

  const destinationLossRate =
    diagnosisAggregate.destinationLossCount / diagnosisAggregate.sampleCount
  if (destinationLossRate >= 0.2 || (aggregate.averageDestinationLossPct ?? 0) >= 10) {
    return {
      className: 'bad',
      label: 'Degraded',
      summary:
        'Destination loss is frequent enough in the last 7 days to treat this path as degraded.',
    }
  }

  return {
    className: 'warn',
    label: 'Flaky',
    summary:
      'Destination loss is intermittent in the last 7 days, but not frequent enough to call the path degraded.',
  }
}

export function summarizeHopIssues(snapshotsInWindow: SnapshotSummary[]): HopAggregate[] {
  const hopMap = new Map<string, HopAggregate>()
  // Track the most-recent snapshot that observed each host so `latestHopIndex`
  // reflects the newest routing, independent of whether the caller hands us
  // snapshots oldest- or newest-first.
  const latestTsByHost = new Map<string, number>()

  for (const snapshot of snapshotsInWindow) {
    const destinationLossPct = snapshot.destinationLossPct ?? 0
    const snapshotTs = parseCollectedAt(snapshot.collectedAt) ?? 0
    // Use `<` rather than `!==` so we drop both the destination hop and any
    // phantom trailing hop MTR sometimes emits past it (same host, bumped
    // TTL). Filtering only on equality would still surface the phantom as
    // a root-suspect candidate even though it sits beyond the destination.
    // Fall back to position-based slicing for legacy snapshots where
    // destinationHopIndex is null.
    const destinationHopIndex = snapshot.destinationHopIndex
    const intermediateHops =
      destinationHopIndex != null
        ? snapshot.hops.filter((hop) => hop.index < destinationHopIndex)
        : snapshot.hops.slice(0, -1)
    for (const hop of intermediateHops) {
      if (hop.lossPct <= 0) {
        continue
      }

      const existing = hopMap.get(hop.host) ?? {
        averageLossPct: null,
        downstreamLossCount: 0,
        host: hop.host,
        isolatedLossCount: 0,
        latestHopIndex: null,
        sampleCount: 0,
      }

      const totalLoss = (existing.averageLossPct ?? 0) * existing.sampleCount + hop.lossPct
      existing.sampleCount += 1
      existing.averageLossPct = totalLoss / existing.sampleCount
      const previousLatestTs = latestTsByHost.get(hop.host) ?? Number.NEGATIVE_INFINITY
      if (snapshotTs >= previousLatestTs) {
        existing.latestHopIndex = hop.index
        latestTsByHost.set(hop.host, snapshotTs)
      }
      if (destinationLossPct > 0) {
        existing.downstreamLossCount += 1
      } else {
        existing.isolatedLossCount += 1
      }

      hopMap.set(hop.host, existing)
    }
  }

  return [...hopMap.values()].sort((left, right) => {
    return (
      right.downstreamLossCount - left.downstreamLossCount ||
      (right.averageLossPct ?? 0) - (left.averageLossPct ?? 0) ||
      right.sampleCount - left.sampleCount
    )
  })
}

export function shouldSurfaceHopIssueForRoot(hopIssue: HopAggregate): boolean {
  if (hopIssue.host.trim() === '' || hopIssue.host === '???') {
    return false
  }

  return (
    hopIssue.downstreamLossCount >= 2 && hopIssue.downstreamLossCount >= hopIssue.isolatedLossCount
  )
}

export function getRootSuspectHop(hopIssues: HopAggregate[]): HopAggregate | null {
  return hopIssues.find(shouldSurfaceHopIssueForRoot) ?? null
}
