import type { ProbeProtocol } from './config.ts'
import { formatNetworkOwnerLabel, type NetworkOwnerInfo } from './network-owner.ts'
import { average } from './raw.ts'
import type { MtrRollupBucket } from './rollups.ts'
import { parseCollectedAt, type SnapshotSummary } from './snapshot.ts'
import {
  formatSourceIdentityInline,
  formatSourceIdentityLines,
  type SourceIdentity,
} from './source-identity.ts'

export interface SnapshotAggregate {
  averageDestinationLossPct: number | null
  averageDestinationMedianRttMs: number | null
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
// interest - pass through selectSnapshotsInWindow() first. Letting the caller
// pre-filter once and reuse the slice for multiple aggregates (as page.tsx
// does) avoids redoing the cutoff walk per helper.
export function summarizeSnapshots(snapshotsInWindow: SnapshotSummary[]): SnapshotAggregate {
  return {
    averageDestinationLossPct: average(
      snapshotsInWindow.flatMap((snapshot) =>
        snapshot.destinationLossPct == null ? [] : [snapshot.destinationLossPct],
      ),
    ),
    averageDestinationMedianRttMs: average(
      snapshotsInWindow.flatMap((snapshot) => {
        const rtt = snapshot.destinationRttP50Ms ?? snapshot.destinationAvgRttMs
        return rtt == null ? [] : [rtt]
      }),
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

// One hop host that shows downstream-loss on multiple targets, with enough
// volume to be worth escalating to the upstream network. Derived deterministically
// from per-target HopAggregates - no new probes needed.
export interface CrossTargetHopIssue {
  // Deduped destination host names reached through this hop with
  // downstream loss. Separate from `targets`, which lists probe paths
  // (labels). "3 probe paths for 1 destination host" reads far differently
  // from "3 destinations affected", so the renderer needs both counts.
  affectedDestinations: string[]
  asn: string | null
  averageLossPct: number | null
  host: string
  // Per-protocol loss at this hop, so the shape classifier can spot
  // protocol-selective loss (same router, ICMP clean, TCP lossy) - that
  // pattern is where ICMP-only monitoring silently under-reports
  // reachability of real HTTPS traffic.
  icmpAverageLossPct: number | null
  icmpTargetCount: number
  tcpAverageLossPct: number | null
  tcpTargetCount: number
  targetCount: number
  targets: string[]
  totalDownstreamLoss: number
  totalIsolatedLoss: number
  totalSampleCount: number
}

export interface CrossTargetDestinationProtocolIssue {
  destinationHost: string
  icmpAverageLossPct: number | null
  icmpDestinationLossCount: number
  icmpSampleCount: number
  icmpTargetCount: number
  icmpTargets: string[]
  tcpAverageLossPct: number | null
  tcpDestinationLossCount: number
  tcpPorts: number[]
  tcpSampleCount: number
  tcpTargetCount: number
  tcpTargets: string[]
}

// Shape classification for the cross-target diagnosis. Each kind describes
// a signature in the probe data itself, so the panel sentence can say
// WHAT kind of problem this is, not just "there is loss". All kinds are
// derived deterministically from the aggregates we already compute.
//
// Shapes currently implemented:
//   - `none`: no shared hop across ≥2 targets. No pattern to surface.
//   - `protocol_selective`: one hop shows ≥30pp more loss for TCP probes
//     than for ICMP probes on the same destination - points to a
//     middlebox policer or asymmetric ECMP, not capacity.
//   - `downstream_from_hop`: one hop coincides with destination loss on
//     multiple targets (the existing "upstream path degraded" shape),
//     with no protocol asymmetry. Generic network problem at or before
//     that hop.
//   - `destination_protocol_selective`: one destination is lossy for TCP
//     across multiple probe paths, while ICMP to the same destination is
//     clean. This can still be actionable when ECMP hides any single shared
//     hop.
//
// Shapes left for follow-up (would need additional inputs to this function):
//   - `destination_only`: destination drops despite clean intermediate
//     hops. Needs per-target destination loss plumbed through.
//   - `path_flap`, `topology_change`: need per-bucket host-set history.
export type CrossTargetShapeKind =
  | 'none'
  | 'protocol_selective'
  | 'downstream_from_hop'
  | 'destination_protocol_selective'

export interface CrossTargetShape {
  destinationIssue?: CrossTargetDestinationProtocolIssue | null
  kind: CrossTargetShapeKind
  hop: CrossTargetHopIssue | null
}

export interface CrossTargetDiagnosis {
  className: 'good' | 'warn' | 'bad'
  escalation: CrossTargetEscalation | null
  label: string
  shape: CrossTargetShape
  summary: string
  suspect: CrossTargetHopIssue | null
}

export interface CrossTargetEscalation {
  contactEmails: string[]
  copyText: string
  ownerLabel: string
}

interface PerTargetHopInput {
  asnByHost: Map<string, string | null>
  // The target's destination host (snapshot.host) - the actual service
  // name being probed, independent of which probe path (slug) reaches it.
  // Used to dedupe the "N affected destinations" count so 3 probe paths
  // to s3.us-west-2 do not read as "3 destinations are broken".
  destinationHost: string
  hopIssues: HopAggregate[]
  protocol: ProbeProtocol
  target: string
}

interface PerProtocolAccumulator {
  sampleCount: number
  weightedLoss: number
  targets: Set<string>
}

// Per-(hop-host, protocol) loss statistics over ALL observed hops in the
// window, including clean ones. This is deliberately a separate pass from
// the lossy-only CrossTargetHopIssue aggregate: for the `protocol_selective`
// shape we need "ICMP traverses this hop cleanly" as a positive signal, and
// a clean ICMP traversal generates zero HopAggregate entries (the upstream
// summarizeHopIssues filters out hops with lossPct == 0).
export interface HopProtocolStat {
  averageLossPct: number
  sampleCount: number
  targetCount: number
}

export interface PerTargetSnapshots {
  protocol: ProbeProtocol
  snapshots: SnapshotSummary[]
  // Unique probe-path identifier, not the human label. Multiple probe
  // variants can share a label ("Amazon S3 us-west-2") but still be
  // independent evidence for a cross-target pattern.
  target: string
}

export function summarizeHopProtocolStats(
  perTarget: PerTargetSnapshots[],
): Map<string, Map<ProbeProtocol, HopProtocolStat>> {
  interface Accum {
    sampleCount: number
    weightedLoss: number
    targets: Set<string>
  }
  const accum = new Map<string, Map<ProbeProtocol, Accum>>()
  for (const entry of perTarget) {
    for (const snap of entry.snapshots) {
      // Skip the destination hop and anything past it: we are measuring
      // intermediate hops' behavior, and a hop counted as "destination" on
      // one target may happen to be an intermediate on another.
      const destIndex = snap.destinationHopIndex ?? Number.POSITIVE_INFINITY
      for (const hop of snap.hops) {
        if (hop.host === '' || hop.host === '???') continue
        if (hop.index >= destIndex) continue
        let byProto = accum.get(hop.host)
        if (byProto == null) {
          byProto = new Map()
          accum.set(hop.host, byProto)
        }
        let slot = byProto.get(entry.protocol)
        if (slot == null) {
          slot = { sampleCount: 0, weightedLoss: 0, targets: new Set() }
          byProto.set(entry.protocol, slot)
        }
        slot.sampleCount += 1
        slot.weightedLoss += hop.lossPct
        slot.targets.add(entry.target)
      }
    }
  }

  const out = new Map<string, Map<ProbeProtocol, HopProtocolStat>>()
  for (const [host, byProto] of accum.entries()) {
    const inner = new Map<ProbeProtocol, HopProtocolStat>()
    for (const [protocol, a] of byProto.entries()) {
      inner.set(protocol, {
        averageLossPct: a.sampleCount === 0 ? 0 : a.weightedLoss / a.sampleCount,
        sampleCount: a.sampleCount,
        targetCount: a.targets.size,
      })
    }
    out.set(host, inner)
  }
  return out
}

export function summarizeCrossTargetHopIssues(
  perTarget: PerTargetHopInput[],
): CrossTargetHopIssue[] {
  const byHost = new Map<string, CrossTargetHopIssue>()
  // Per-hop / per-protocol running accumulators. Weighted-loss is kept raw
  // (pct * sampleCount) so we can compute the final weighted average once
  // at the end without accumulating rounding error in a running average.
  const protocolByHost = new Map<string, Map<ProbeProtocol, PerProtocolAccumulator>>()

  for (const entry of perTarget) {
    for (const hop of entry.hopIssues) {
      // Non-surfaceable hops on a single target should stay non-surfaceable at
      // the cross-target level too; escalation copy shouldn't name a hop that
      // never actually coincided with destination loss.
      if (!shouldSurfaceHopIssueForRoot(hop)) continue

      const existing = byHost.get(hop.host) ?? {
        affectedDestinations: [],
        asn: null,
        averageLossPct: null,
        host: hop.host,
        icmpAverageLossPct: null,
        icmpTargetCount: 0,
        tcpAverageLossPct: null,
        tcpTargetCount: 0,
        targetCount: 0,
        targets: [],
        totalDownstreamLoss: 0,
        totalIsolatedLoss: 0,
        totalSampleCount: 0,
      }
      if (!existing.targets.includes(entry.target)) {
        existing.targets.push(entry.target)
        existing.targetCount = existing.targets.length
      }
      if (!existing.affectedDestinations.includes(entry.destinationHost)) {
        existing.affectedDestinations.push(entry.destinationHost)
      }
      existing.totalDownstreamLoss += hop.downstreamLossCount
      existing.totalIsolatedLoss += hop.isolatedLossCount
      const weightedLoss =
        (existing.averageLossPct ?? 0) * existing.totalSampleCount +
        (hop.averageLossPct ?? 0) * hop.sampleCount
      existing.totalSampleCount += hop.sampleCount
      existing.averageLossPct =
        existing.totalSampleCount === 0 ? null : weightedLoss / existing.totalSampleCount
      // Last ASN wins - good enough for the diagnosis line, and skips the
      // bookkeeping of tracking "which target reported which ASN".
      existing.asn = entry.asnByHost.get(hop.host) ?? existing.asn
      byHost.set(hop.host, existing)

      let byProtocol = protocolByHost.get(hop.host)
      if (byProtocol == null) {
        byProtocol = new Map()
        protocolByHost.set(hop.host, byProtocol)
      }
      let slot = byProtocol.get(entry.protocol)
      if (slot == null) {
        slot = { sampleCount: 0, weightedLoss: 0, targets: new Set() }
        byProtocol.set(entry.protocol, slot)
      }
      slot.sampleCount += hop.sampleCount
      slot.weightedLoss += (hop.averageLossPct ?? 0) * hop.sampleCount
      slot.targets.add(entry.target)
    }
  }

  // Finalize per-protocol averages once, after all input has been absorbed.
  for (const [host, issue] of byHost.entries()) {
    const byProtocol = protocolByHost.get(host)
    if (byProtocol == null) continue
    const icmp = byProtocol.get('icmp')
    if (icmp != null && icmp.sampleCount > 0) {
      issue.icmpAverageLossPct = icmp.weightedLoss / icmp.sampleCount
      issue.icmpTargetCount = icmp.targets.size
    }
    const tcp = byProtocol.get('tcp')
    if (tcp != null && tcp.sampleCount > 0) {
      issue.tcpAverageLossPct = tcp.weightedLoss / tcp.sampleCount
      issue.tcpTargetCount = tcp.targets.size
    }
  }

  return [...byHost.values()].sort((left, right) => {
    return (
      right.targetCount - left.targetCount ||
      right.totalDownstreamLoss - left.totalDownstreamLoss ||
      (right.averageLossPct ?? 0) - (left.averageLossPct ?? 0)
    )
  })
}

// Minimum delta (percentage points) between TCP and ICMP loss at the same
// hop for the shape to be classified as `protocol_selective`. 30pp is well
// above day-to-day variance in either protocol and well below the ~50pp
// signal we've seen on SIN -> us-west-2, so it separates real protocol
// asymmetry from noise without hiding mid-severity cases.
const PROTOCOL_SELECTIVE_DELTA_THRESHOLD_PCT = 30
const DESTINATION_PROTOCOL_SELECTIVE_MIN_TCP_TARGETS = 2
const DESTINATION_PROTOCOL_SELECTIVE_MIN_SAMPLES = 10
// Per-hop loss above which a bucket counts as "still degraded" for the
// purpose of the "degraded since" timeline. Low enough to not declare
// recovery on minor variance, high enough to close the run on genuine
// clean periods.
const DEGRADED_BUCKET_HOP_LOSS_PCT = 10

export interface HopDegradedTimeline {
  firstDegradedAt: string
  durationHours: number
}

// Returns the richest-known display name for a hop IP, reading across the
// entire 7d bucket history. Per-snapshot rDNS is flaky (mtr's PTR lookup
// times out under load), so individual snapshots may report a bare IP
// even for hops that resolve cleanly in other snapshots. Merging across
// the window recovers the best-known name and keeps the panel from
// flip-flopping between "132.147.112.101" and
// "fnet117-f60-60-access.vqbn.com.sg (132.147.112.101)".
export function findRichestHopDisplayName(
  hopHost: string,
  rollupBucketsByTarget: MtrRollupBucket[][],
): string {
  // The hop.host field in our rollups is already in the merged
  // "dns (ip)" form (or bare IP when rDNS failed). Scan for any entry
  // whose host string both starts with the current hop display AND is
  // longer - meaning it carries additional info (typically the PTR).
  let best = hopHost
  for (const buckets of rollupBucketsByTarget) {
    for (const bucket of buckets) {
      for (const hop of bucket.hops) {
        if (hop.host === best) continue
        // Match when the two strings name the same IP endpoint but the
        // candidate has more content (usually a resolved PTR). Checking
        // both "X in Y" and "Y in X" is cheap and handles either order
        // of which snapshot had rDNS.
        if (hop.host.includes(hopHost) && hop.host.length > best.length) {
          best = hop.host
        } else if (best.includes(hop.host) && best.length < hop.host.length) {
          best = hop.host
        }
      }
    }
  }
  return best
}

// Destinations that traverse this hop CLEANLY in the window - i.e.
// the hop appears in their snapshot hops with loss below the
// DEGRADED_BUCKET_HOP_LOSS_PCT floor. Useful counterpoint to the
// "affected destinations" list: showing that N other destinations go
// through the same hop and stay healthy proves the problem is
// prefix-specific, not a general-purpose router failure.
export function findUnaffectedSiblingDestinations(
  hopHost: string,
  affectedDestinations: readonly string[],
  perTarget: PerTargetSnapshots[],
): string[] {
  const affectedSet = new Set(affectedDestinations)
  const cleanDestinations = new Set<string>()
  const anyLossDestinations = new Set<string>()
  for (const entry of perTarget) {
    if (affectedSet.has(entry.snapshots[0]?.host ?? '')) continue
    let traversedClean = false
    let traversedLossy = false
    for (const snap of entry.snapshots) {
      const destIndex = snap.destinationHopIndex ?? Number.POSITIVE_INFINITY
      for (const hop of snap.hops) {
        if (hop.host !== hopHost) continue
        if (hop.index >= destIndex) continue
        if (hop.lossPct < DEGRADED_BUCKET_HOP_LOSS_PCT) {
          traversedClean = true
        } else {
          traversedLossy = true
        }
      }
    }
    const destinationHost = entry.snapshots[0]?.host
    if (destinationHost == null || destinationHost === '') continue
    if (traversedClean) cleanDestinations.add(destinationHost)
    if (traversedLossy) anyLossDestinations.add(destinationHost)
  }
  // A destination that sometimes sees loss at this hop is not "clean" -
  // drop any that also appear in anyLossDestinations so the sibling list
  // really is "traversal was clean every time we saw it".
  for (const lossy of anyLossDestinations) cleanDestinations.delete(lossy)
  return [...cleanDestinations].sort()
}

// Walk backward from the most recent bucket across every target's hourly
// rollup and return the start of the latest uninterrupted run of buckets
// in which this hop's loss stayed above DEGRADED_BUCKET_HOP_LOSS_PCT.
// Returns null if the most recent bucket is already clean - the hop is
// not in a degraded state right now, so there is no active timeline.
export function computeHopDegradedSince(
  hopHost: string,
  rollupBucketsByTarget: MtrRollupBucket[][],
  now: number = Date.now(),
): HopDegradedTimeline | null {
  // Collapse to one loss value per bucket start: max across every target
  // that saw this hop. Taking the max means a single target showing loss
  // is enough to count the bucket as degraded, which matches operator
  // intuition ("is the hop broken right now?") better than averaging
  // across paths that may not all probe TCP.
  const maxHopLossByBucket = new Map<string, number>()
  for (const buckets of rollupBucketsByTarget) {
    for (const bucket of buckets) {
      const hopEntry = bucket.hops.find((entry) => entry.host === hopHost)
      if (hopEntry == null) continue
      const previous = maxHopLossByBucket.get(bucket.bucketStart) ?? 0
      if (hopEntry.lossPct > previous) {
        maxHopLossByBucket.set(bucket.bucketStart, hopEntry.lossPct)
      } else if (!maxHopLossByBucket.has(bucket.bucketStart)) {
        maxHopLossByBucket.set(bucket.bucketStart, hopEntry.lossPct)
      }
    }
  }
  if (maxHopLossByBucket.size === 0) return null

  const sorted = [...maxHopLossByBucket.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )
  const [, latestLoss] = sorted[sorted.length - 1]
  if (latestLoss < DEGRADED_BUCKET_HOP_LOSS_PCT) return null

  let firstDegradedAt = sorted[sorted.length - 1][0]
  for (let i = sorted.length - 2; i >= 0; i -= 1) {
    const [bucketStart, lossPct] = sorted[i]
    if (lossPct < DEGRADED_BUCKET_HOP_LOSS_PCT) break
    firstDegradedAt = bucketStart
  }

  const startMs = Date.parse(firstDegradedAt)
  const durationHours = Number.isFinite(startMs)
    ? Math.max(0, Math.round((now - startMs) / (60 * 60 * 1000)))
    : 0
  return { firstDegradedAt, durationHours }
}
// Floor for ICMP loss before we consider the hop "ICMP-clean" for the
// purpose of the protocol-selective check. Some routers return ICMP only
// when overloaded even on healthy paths; don't let a 2-3% ICMP baseline
// disqualify an otherwise clear TCP-vs-ICMP split.
const PROTOCOL_SELECTIVE_ICMP_CEILING_PCT = 10

interface DestinationProtocolAccumulator {
  destinationLossCount: number
  ports: Set<number>
  sampleCount: number
  targets: Set<string>
  weightedLoss: number
}

function emptyDestinationProtocolAccumulator(): DestinationProtocolAccumulator {
  return {
    destinationLossCount: 0,
    ports: new Set(),
    sampleCount: 0,
    targets: new Set(),
    weightedLoss: 0,
  }
}

export function summarizeDestinationProtocolIssues(
  perTarget: PerTargetSnapshots[],
): CrossTargetDestinationProtocolIssue[] {
  const byDestination = new Map<string, Map<ProbeProtocol, DestinationProtocolAccumulator>>()
  for (const entry of perTarget) {
    for (const snapshot of entry.snapshots) {
      const lossPct = snapshot.destinationLossPct
      if (lossPct == null) continue
      let byProtocol = byDestination.get(snapshot.host)
      if (byProtocol == null) {
        byProtocol = new Map()
        byDestination.set(snapshot.host, byProtocol)
      }
      let accumulator = byProtocol.get(entry.protocol)
      if (accumulator == null) {
        accumulator = emptyDestinationProtocolAccumulator()
        byProtocol.set(entry.protocol, accumulator)
      }
      accumulator.sampleCount += 1
      accumulator.weightedLoss += lossPct
      accumulator.targets.add(entry.target)
      accumulator.ports.add(snapshot.port)
      if (lossPct > 0) {
        accumulator.destinationLossCount += 1
      }
    }
  }

  const issues: CrossTargetDestinationProtocolIssue[] = []
  for (const [destinationHost, byProtocol] of byDestination.entries()) {
    const icmp = byProtocol.get('icmp')
    const tcp = byProtocol.get('tcp')
    if (tcp == null || tcp.sampleCount === 0) continue
    issues.push({
      destinationHost,
      icmpAverageLossPct:
        icmp == null || icmp.sampleCount === 0 ? null : icmp.weightedLoss / icmp.sampleCount,
      icmpDestinationLossCount: icmp?.destinationLossCount ?? 0,
      icmpSampleCount: icmp?.sampleCount ?? 0,
      icmpTargetCount: icmp?.targets.size ?? 0,
      icmpTargets: [...(icmp?.targets ?? [])].sort(),
      tcpAverageLossPct: tcp.weightedLoss / tcp.sampleCount,
      tcpDestinationLossCount: tcp.destinationLossCount,
      tcpPorts: [...tcp.ports].sort((left, right) => left - right),
      tcpSampleCount: tcp.sampleCount,
      tcpTargetCount: tcp.targets.size,
      tcpTargets: [...tcp.targets].sort(),
    })
  }

  return issues.sort((left, right) => {
    const leftDelta = (left.tcpAverageLossPct ?? 0) - (left.icmpAverageLossPct ?? 0)
    const rightDelta = (right.tcpAverageLossPct ?? 0) - (right.icmpAverageLossPct ?? 0)
    return (
      right.tcpTargetCount - left.tcpTargetCount ||
      rightDelta - leftDelta ||
      right.tcpDestinationLossCount - left.tcpDestinationLossCount ||
      (right.tcpAverageLossPct ?? 0) - (left.tcpAverageLossPct ?? 0)
    )
  })
}

export function classifyDestinationProtocolShape(
  perTarget: PerTargetSnapshots[],
): CrossTargetShape {
  const primary =
    summarizeDestinationProtocolIssues(perTarget).find((issue) => {
      const icmpLossPct = issue.icmpAverageLossPct
      const tcpLossPct = issue.tcpAverageLossPct
      return (
        issue.tcpTargetCount >= DESTINATION_PROTOCOL_SELECTIVE_MIN_TCP_TARGETS &&
        issue.tcpSampleCount >= DESTINATION_PROTOCOL_SELECTIVE_MIN_SAMPLES &&
        issue.icmpSampleCount >= DESTINATION_PROTOCOL_SELECTIVE_MIN_SAMPLES &&
        icmpLossPct != null &&
        tcpLossPct != null &&
        icmpLossPct <= PROTOCOL_SELECTIVE_ICMP_CEILING_PCT &&
        tcpLossPct - icmpLossPct >= PROTOCOL_SELECTIVE_DELTA_THRESHOLD_PCT
      )
    }) ?? null

  if (primary == null) {
    return { kind: 'none', hop: null }
  }

  return { destinationIssue: primary, kind: 'destination_protocol_selective', hop: null }
}

export function classifyCrossTargetShape(
  crossIssues: CrossTargetHopIssue[],
  // Optional: per-hop per-protocol stats over ALL traversals (including
  // clean ones). When provided, takes precedence over the lossy-only
  // per-protocol fields on the issue itself - a clean ICMP probe past
  // this hop contributes 0% to this map but leaves no trace in the
  // CrossTargetHopIssue (HopAggregate upstream filters out zero-loss
  // hops). That clean signal is what makes `protocol_selective`
  // distinguishable from "we only happen to have TCP probes through
  // this hop, so there is nothing to compare".
  hopProtocolStats?: Map<string, Map<ProbeProtocol, HopProtocolStat>>,
): CrossTargetShape {
  // One shared hop across ≥2 targets is the escalation trigger. A single hop
  // hitting one target is already surfaced by that target's own "Most
  // suspicious hop (7d)" column; the cross-target panel only earns its space
  // when a hop is plausibly upstream infrastructure, not a single target's
  // own network.
  const primary = crossIssues.find((issue) => issue.targetCount >= 2) ?? null
  if (primary == null) {
    return { kind: 'none', hop: null }
  }

  let icmpLossPct: number | null = primary.icmpAverageLossPct
  let tcpLossPct: number | null = primary.tcpAverageLossPct
  let icmpTargetCount = primary.icmpTargetCount
  let tcpTargetCount = primary.tcpTargetCount
  const byProto = hopProtocolStats?.get(primary.host)
  if (byProto != null) {
    const icmp = byProto.get('icmp')
    const tcp = byProto.get('tcp')
    if (icmp != null && icmp.sampleCount > 0) {
      icmpLossPct = icmp.averageLossPct
      icmpTargetCount = icmp.targetCount
    }
    if (tcp != null && tcp.sampleCount > 0) {
      tcpLossPct = tcp.averageLossPct
      tcpTargetCount = tcp.targetCount
    }
  }

  // Protocol-selective: we have at least one ICMP and one TCP target
  // covering this same hop, ICMP loss is below the noise floor, and TCP
  // loss is substantially higher. That signature points to a middlebox
  // policer or asymmetric-ECMP flow selection rather than raw capacity
  // loss - a qualitatively different failure mode from "sick router".
  if (
    icmpTargetCount >= 1 &&
    tcpTargetCount >= 1 &&
    icmpLossPct != null &&
    tcpLossPct != null &&
    icmpLossPct <= PROTOCOL_SELECTIVE_ICMP_CEILING_PCT &&
    tcpLossPct - icmpLossPct >= PROTOCOL_SELECTIVE_DELTA_THRESHOLD_PCT
  ) {
    // Seed the primary's per-protocol numbers so renderers don't have to
    // re-do the lookup.
    primary.icmpAverageLossPct = icmpLossPct
    primary.tcpAverageLossPct = tcpLossPct
    primary.icmpTargetCount = icmpTargetCount
    primary.tcpTargetCount = tcpTargetCount
    return { kind: 'protocol_selective', hop: primary }
  }

  return { kind: 'downstream_from_hop', hop: primary }
}

export interface CrossTargetDiagnosisContext {
  networkOwnersByHopHost?: Map<string, NetworkOwnerInfo>
  sourceIdentity?: SourceIdentity
  // Per-target hourly rollup buckets. Enables "Degraded since" timeline
  // and PTR discovery for the suspect hop.
  rollupBucketsByTarget?: MtrRollupBucket[][]
  // Per-target snapshot window (7d typically). Enables the
  // unaffected-siblings count, which proves the problem is
  // prefix-specific instead of a generic router failure.
  perTargetSnapshots?: PerTargetSnapshots[]
  now?: number
}

function buildCrossTargetEscalation({
  destinationList,
  hopDisplay,
  owner,
  primary,
  shapeKind,
  sourceIdentity,
}: {
  destinationList: string
  hopDisplay: string
  owner: NetworkOwnerInfo | null
  primary: CrossTargetHopIssue
  shapeKind: CrossTargetShapeKind
  sourceIdentity?: SourceIdentity
}): CrossTargetEscalation | null {
  if (owner == null) return null

  const ownerLabel = formatNetworkOwnerLabel(owner)
  const contacts =
    owner.contactEmails.length === 0
      ? 'No public NOC contact found in RDAP; use the owner/ASN as the escalation target.'
      : owner.contactEmails.join(', ')
  const protocolLine =
    shapeKind === 'protocol_selective'
      ? `TCP loss is ~${(primary.tcpAverageLossPct ?? 0).toFixed(1)}% while ICMP loss is ~${(primary.icmpAverageLossPct ?? 0).toFixed(1)}% on the same hop.`
      : `The hop coincides with ${primary.totalDownstreamLoss} downstream-loss snapshots.`

  return {
    contactEmails: owner.contactEmails,
    copyText: [
      `Please investigate persistent packet loss observed by continuous MTR-style probes from ${formatSourceIdentityInline(sourceIdentity)} to ${destinationList}.`,
      ...formatSourceIdentityLines(sourceIdentity),
      `Suspect hop: ${hopDisplay}`,
      `Report to: ${ownerLabel}`,
      `Contact: ${contacts}`,
      owner.prefix == null ? null : `Prefix: ${owner.prefix}`,
      protocolLine,
      `Affected probe paths: ${primary.targets.join(', ')}`,
    ]
      .filter((line): line is string => line != null)
      .join('\n'),
    ownerLabel,
  }
}

export function getCrossTargetDiagnosis(
  crossIssues: CrossTargetHopIssue[],
  hopProtocolStats?: Map<string, Map<ProbeProtocol, HopProtocolStat>>,
  context: CrossTargetDiagnosisContext = {},
): CrossTargetDiagnosis {
  const rollupBucketsByTarget = context.rollupBucketsByTarget
  const perTargetSnapshots = context.perTargetSnapshots
  const networkOwnersByHopHost = context.networkOwnersByHopHost
  const sourceIdentity = context.sourceIdentity
  const now = context.now ?? Date.now()
  const shape = classifyCrossTargetShape(crossIssues, hopProtocolStats)
  if (shape.kind === 'none' || shape.hop == null) {
    const destinationShape =
      perTargetSnapshots == null
        ? ({ kind: 'none', hop: null } satisfies CrossTargetShape)
        : classifyDestinationProtocolShape(perTargetSnapshots)
    if (
      destinationShape.kind === 'destination_protocol_selective' &&
      destinationShape.destinationIssue != null
    ) {
      const issue = destinationShape.destinationIssue
      const tcpPorts =
        issue.tcpPorts.length === 0
          ? ''
          : `/${issue.tcpPorts.length === 1 ? issue.tcpPorts[0] : issue.tcpPorts.join(',')}`
      const tcpLossPct = issue.tcpAverageLossPct ?? 0
      const icmpLossPct = issue.icmpAverageLossPct ?? 0
      return {
        className: 'bad',
        escalation: null,
        label: 'Protocol-selective destination loss',
        shape: destinationShape,
        summary: `${issue.destinationHost} shows TCP${tcpPorts} destination loss across ${issue.tcpTargetCount} probe paths (~${tcpLossPct.toFixed(1)}% average, ${issue.tcpDestinationLossCount}/${issue.tcpSampleCount} lossy snapshots) while ICMP probes to the same destination stay near-clean (~${icmpLossPct.toFixed(1)}% average across ${issue.icmpTargetCount} probe paths). This points to TCP path, middlebox, ECMP, or destination-edge behavior rather than general packet loss; ICMP-only monitoring would miss it.`,
        suspect: null,
      }
    }

    return {
      className: 'good',
      escalation: null,
      label: 'No cross-target pattern',
      shape,
      summary:
        'No single hop is implicated in downstream destination loss across multiple targets in the last 7 days.',
      suspect: null,
    }
  }

  const primary = shape.hop
  const asnLabel = primary.asn == null ? '' : ` (${primary.asn})`
  const destinationCount = primary.affectedDestinations.length
  const destinationNoun = destinationCount === 1 ? 'destination' : 'destinations'
  const destinationList = primary.affectedDestinations.slice(0, 3).join(', ')
  const moreDestinations =
    primary.affectedDestinations.length > 3
      ? ` (+${primary.affectedDestinations.length - 3} more)`
      : ''
  // When probe paths and destinations are 1:1 there is no "M paths for N
  // destinations" story to tell - collapse the phrase to "N probe path(s)"
  // so the reader is not counting twice.
  const probePathPhrase =
    primary.targetCount === destinationCount
      ? `${primary.targetCount} probe ${primary.targetCount === 1 ? 'path' : 'paths'}`
      : `${primary.targetCount} probe paths across ${destinationCount} ${destinationNoun}`
  const severe = primary.totalDownstreamLoss >= 10
  // Upgrade the hop display string with any richer PTR-bearing form seen
  // across the full 7d history. Per-snapshot rDNS is flaky, so the
  // current-cycle primary.host may be the bare IP even when other
  // snapshots resolved it. Falls back cleanly when no rollups given.
  const hopDisplay =
    rollupBucketsByTarget == null
      ? primary.host
      : findRichestHopDisplayName(primary.host, rollupBucketsByTarget)
  const timeline =
    rollupBucketsByTarget == null
      ? null
      : computeHopDegradedSince(primary.host, rollupBucketsByTarget, now)
  // "Degraded since ..." sentence appended when we have rollup history.
  // <1h rounds to "just flagged" so we do not claim a degraded run the
  // data does not actually support; 1h+ is the normal case.
  const timelineSuffix =
    timeline == null
      ? ''
      : timeline.durationHours < 1
        ? ` Degraded since ${timeline.firstDegradedAt} (just flagged).`
        : ` Degraded since ${timeline.firstDegradedAt} (continuous ${timeline.durationHours}h).`
  const unaffectedSiblings =
    perTargetSnapshots == null
      ? []
      : findUnaffectedSiblingDestinations(
          primary.host,
          primary.affectedDestinations,
          perTargetSnapshots,
        )
  // "N sibling destinations through this hop are unaffected" sentence -
  // evidence the problem is prefix-specific rather than a broken router.
  // Shown only when we actually observed at least one clean sibling, so
  // the panel stays quiet when there is no evidence either way.
  const siblingsSuffix =
    unaffectedSiblings.length === 0
      ? ''
      : ` ${unaffectedSiblings.length} sibling ${
          unaffectedSiblings.length === 1 ? 'destination' : 'destinations'
        } through this hop (${unaffectedSiblings.slice(0, 3).join(', ')}${unaffectedSiblings.length > 3 ? ', …' : ''}) are unaffected, so the problem is prefix-specific, not a generic router failure.`

  if (shape.kind === 'protocol_selective') {
    const icmpPct = primary.icmpAverageLossPct ?? 0
    const tcpPct = primary.tcpAverageLossPct ?? 0
    const owner = networkOwnersByHopHost?.get(primary.host) ?? null
    const escalation = buildCrossTargetEscalation({
      destinationList: `${destinationList}${moreDestinations}`,
      hopDisplay,
      owner,
      primary,
      shapeKind: shape.kind,
      sourceIdentity,
    })
    const escalationSuffix =
      escalation == null
        ? ' The fix is typically upstream of hopwatch: raise it with the network owning this hop, or re-route around it.'
        : ` Report this to ${escalation.ownerLabel}${escalation.contactEmails.length === 0 ? '' : ` (${escalation.contactEmails.join(', ')})`}, or ask your upstream/provider to escalate there.`
    return {
      className: 'bad',
      escalation,
      label: 'Protocol-selective loss',
      shape,
      summary: `Hop ${hopDisplay}${asnLabel} drops ~${tcpPct.toFixed(1)}% of TCP probes to ${destinationList}${moreDestinations} but only ~${icmpPct.toFixed(1)}% of ICMP probes on the same hop (${probePathPhrase}). Protocol-selective loss points to a middlebox policer or asymmetric ECMP on a per-flow-hash basis - not plain capacity - so ICMP-only monitoring would report this path as healthy while real HTTPS traffic degrades.${escalationSuffix}${timelineSuffix}${siblingsSuffix}`,
      suspect: primary,
    }
  }

  const lossLabel =
    primary.averageLossPct == null ? '' : ` at ~${primary.averageLossPct.toFixed(1)}% average loss`
  const owner = networkOwnersByHopHost?.get(primary.host) ?? null
  const escalation = buildCrossTargetEscalation({
    destinationList: `${destinationList}${moreDestinations}`,
    hopDisplay,
    owner,
    primary,
    shapeKind: shape.kind,
    sourceIdentity,
  })
  const escalationSuffix =
    escalation == null
      ? 'consider escalating with the upstream network'
      : `consider escalating with ${escalation.ownerLabel}${escalation.contactEmails.length === 0 ? '' : ` (${escalation.contactEmails.join(', ')})`}`
  return {
    className: severe ? 'bad' : 'warn',
    escalation,
    label: severe ? 'Upstream path degraded' : 'Shared hop flaky',
    shape,
    summary: `Hop ${hopDisplay}${asnLabel} sits on the path to ${destinationCount} ${destinationNoun} (${destinationList}${moreDestinations}) via ${probePathPhrase} and coincides with ${primary.totalDownstreamLoss} downstream-loss snapshots${lossLabel} - ${escalationSuffix}.${timelineSuffix}${siblingsSuffix}`,
    suspect: primary,
  }
}
