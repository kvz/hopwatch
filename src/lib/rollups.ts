import { z } from 'zod'

import type { ProbeMode } from './config.ts'
import {
  average,
  quantile,
  type RawMtrEvent,
  resolveDestinationHopIndex,
  type StoredRawSnapshot,
  summarizeDestinationSamples,
} from './raw.ts'
import { parseCompactCollectedAt } from './snapshot.ts'

export type RollupGranularity = 'hour' | 'day'

const histogramBucketSchema = z.object({
  count: z.number().int().min(0),
  upperBoundMs: z.number().positive().nullable(),
})

// Per-hop aggregate within a bucket, keyed by `host` (merged `dns (ip)` form
// from raw.ts's deriveHopRecordsFromRawEvents). `hopIndexes` surfaces ECMP
// (same router seen at multiple TTLs) without fragmenting stats across rows.
// Only populated for hourly rollups - daily keeps hops: [] to avoid bloating
// the 365-day file with per-hop detail nobody renders at that horizon.
const hopRollupEntrySchema = z.object({
  host: z.string().min(1),
  hopIndexes: z.array(z.number().int().min(0)).min(1),
  representativeHopIndex: z.number().int().min(0),
  snapshotCount: z.number().int().min(0),
  sentCount: z.number().int().min(0),
  replyCount: z.number().int().min(0),
  lossPct: z.number().min(0).max(100),
  rttAvgMs: z.number().nonnegative().nullable(),
  rttMinMs: z.number().nonnegative().nullable(),
  rttMaxMs: z.number().nonnegative().nullable(),
  rttP50Ms: z.number().nonnegative().nullable(),
  rttP90Ms: z.number().nonnegative().nullable(),
  rttP99Ms: z.number().nonnegative().nullable(),
})

const mtrRollupBucketSchema = z.object({
  bucketStart: z.string().min(1),
  destinationLossPct: z.number().min(0).max(100),
  destinationReplyCount: z.number().int().min(0),
  destinationSentCount: z.number().int().min(0),
  histogram: z.array(histogramBucketSchema),
  // v1 rollups predate per-hop aggregation; treat missing `hops` as [] so old
  // files keep parsing. A full-rebuild regenerates them within the raw
  // retention window; older buckets stay hops:[] forever since raw is gone.
  hops: z.array(hopRollupEntrySchema).default([]),
  rttAvgMs: z.number().nonnegative().nullable(),
  rttMaxMs: z.number().nonnegative().nullable(),
  rttMinMs: z.number().nonnegative().nullable(),
  rttP50Ms: z.number().nonnegative().nullable(),
  rttP90Ms: z.number().nonnegative().nullable(),
  rttP99Ms: z.number().nonnegative().nullable(),
  snapshotCount: z.number().int().min(0),
})

export const mtrRollupFileSchema = z.object({
  generatedAt: z.string().min(1),
  granularity: z.enum(['hour', 'day'] satisfies [RollupGranularity, RollupGranularity]),
  host: z.string().min(1),
  label: z.string().min(1),
  observer: z.string().min(1),
  probeMode: z.enum(['default', 'netns'] satisfies [ProbeMode, ProbeMode]),
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  target: z.string().min(1),
  buckets: z.array(mtrRollupBucketSchema),
})

export type HopRollupEntry = z.infer<typeof hopRollupEntrySchema>
export type MtrRollupBucket = z.infer<typeof mtrRollupBucketSchema>
export type MtrRollupFile = z.infer<typeof mtrRollupFileSchema>

interface TargetRollupMetadata {
  host: string
  label: string
  observer: string
  probeMode: ProbeMode
  target: string
}

const histogramUpperBoundsMs = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const

function getCollectedAtDate(collectedAt: string): Date {
  const parts = parseCompactCollectedAt(collectedAt)
  if (parts == null) {
    throw new Error(`Unsupported collectedAt timestamp: ${collectedAt}`)
  }

  return new Date(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hours}:${parts.minutes}:${parts.seconds}Z`,
  )
}

function getBucketStartIso(date: Date, granularity: RollupGranularity): string {
  const bucketDate = new Date(date)
  bucketDate.setUTCMinutes(0, 0, 0)
  if (granularity === 'day') {
    bucketDate.setUTCHours(0, 0, 0, 0)
  }

  return bucketDate.toISOString()
}

function buildHistogram(rttSamplesMs: number[]): MtrRollupBucket['histogram'] {
  let previousUpperBoundMs = 0

  return [
    ...histogramUpperBoundsMs.map((upperBoundMs) => {
      const count = rttSamplesMs.filter(
        (sample) => sample > previousUpperBoundMs && sample <= upperBoundMs,
      ).length
      previousUpperBoundMs = upperBoundMs

      return {
        count,
        upperBoundMs,
      }
    }),
    {
      count: rttSamplesMs.filter(
        (sample) => sample > histogramUpperBoundsMs[histogramUpperBoundsMs.length - 1],
      ).length,
      upperBoundMs: null,
    },
  ]
}

interface HopSnapshotContribution {
  sentCount: number
  replyRttsMs: number[]
}

interface HopAccumulator {
  host: string
  // Multiset of TTL positions this host was observed at, counted per
  // contributing snapshot. Exposes ECMP without forcing a (ttl, host) primary
  // key that would fragment stats.
  hopIndexCounts: Map<number, number>
  sentCount: number
  replyRttsMs: number[]
  // Counts distinct snapshots where this host appeared at all. A snapshot
  // where the host surfaces at two TTLs (ECMP) still counts once.
  snapshotCount: number
}

function extractHopContributionsFromSnapshot(
  rawEvents: RawMtrEvent[],
): Map<string, { hopIndexes: number[]; contribution: HopSnapshotContribution }> {
  const destinationHopIndex = resolveDestinationHopIndex(rawEvents)
  const ipByHop = new Map<number, string>()
  const dnsByHop = new Map<number, string>()
  const seenHopIndexes = new Set<number>()
  const sentByHop = new Map<number, number>()
  const rttsByHop = new Map<number, number[]>()

  for (const event of rawEvents) {
    seenHopIndexes.add(event.hopIndex)
    if (event.kind === 'host') {
      ipByHop.set(event.hopIndex, event.host)
    } else if (event.kind === 'dns') {
      dnsByHop.set(event.hopIndex, event.host)
    } else if (event.kind === 'sent') {
      sentByHop.set(event.hopIndex, (sentByHop.get(event.hopIndex) ?? 0) + 1)
    } else if (event.kind === 'reply') {
      const rtts = rttsByHop.get(event.hopIndex) ?? []
      rtts.push(event.rttUs / 1000)
      rttsByHop.set(event.hopIndex, rtts)
    }
  }

  // Build contributions keyed by merged `dns (ip)` host string. This matches
  // deriveHopRecordsFromRawEvents' rendering so the UI and rollup agree on
  // hop identity, and it lets ECMP (same router answering at TTL 8 and 9)
  // aggregate into a single entry with hopIndexes: [8, 9].
  const contributions = new Map<
    string,
    { hopIndexes: number[]; contribution: HopSnapshotContribution }
  >()
  // Only include hops up to and including the resolved destination. Past the
  // destination MTR sometimes emits phantom trailing TTLs; those would inflate
  // the heatmap with a ghost "destination+1" row.
  const sortedHopIndexes = [...seenHopIndexes].sort((left, right) => left - right)
  for (const hopIndex of sortedHopIndexes) {
    if (destinationHopIndex != null && hopIndex > destinationHopIndex) continue
    const ipHost = ipByHop.get(hopIndex) ?? null
    const dnsHost = dnsByHop.get(hopIndex) ?? null
    const host =
      dnsHost != null && ipHost != null && dnsHost !== ipHost
        ? `${dnsHost} (${ipHost})`
        : (dnsHost ?? ipHost ?? '???')

    const entry = contributions.get(host) ?? {
      hopIndexes: [] as number[],
      contribution: { sentCount: 0, replyRttsMs: [] as number[] },
    }
    entry.hopIndexes.push(hopIndex)
    entry.contribution.sentCount += sentByHop.get(hopIndex) ?? 0
    entry.contribution.replyRttsMs.push(...(rttsByHop.get(hopIndex) ?? []))
    contributions.set(host, entry)
  }
  return contributions
}

function buildHopRollupEntry(accumulator: HopAccumulator): HopRollupEntry {
  const sortedRtts = [...accumulator.replyRttsMs].sort((left, right) => left - right)
  const replyCount = sortedRtts.length
  const lossPct =
    accumulator.sentCount === 0
      ? 100
      : ((accumulator.sentCount - replyCount) / accumulator.sentCount) * 100

  // Representative TTL = most commonly observed position across snapshots.
  // Used for sorting the heatmap / path-order view; ties broken toward the
  // lower (closer-to-source) TTL, which matches how operators think about
  // traceroute layouts.
  let representativeHopIndex = Number.POSITIVE_INFINITY
  let bestCount = -1
  for (const [hopIndex, count] of accumulator.hopIndexCounts) {
    if (count > bestCount || (count === bestCount && hopIndex < representativeHopIndex)) {
      bestCount = count
      representativeHopIndex = hopIndex
    }
  }

  return {
    host: accumulator.host,
    hopIndexes: [...accumulator.hopIndexCounts.keys()].sort((left, right) => left - right),
    representativeHopIndex,
    snapshotCount: accumulator.snapshotCount,
    sentCount: accumulator.sentCount,
    replyCount,
    lossPct,
    rttAvgMs: average(accumulator.replyRttsMs),
    rttMinMs: sortedRtts.length === 0 ? null : sortedRtts[0],
    rttMaxMs: sortedRtts.length === 0 ? null : sortedRtts[sortedRtts.length - 1],
    rttP50Ms: quantile(sortedRtts, 0.5),
    rttP90Ms: quantile(sortedRtts, 0.9),
    rttP99Ms: quantile(sortedRtts, 0.99),
  }
}

function buildRollupBucket(
  bucketStart: string,
  snapshotCount: number,
  destinationSentCount: number,
  rttSamplesMs: number[],
  hops: HopRollupEntry[],
): MtrRollupBucket {
  const destinationReplyCount = rttSamplesMs.length
  // When every snapshot in a bucket was completely blackholed,
  // summarizeDestinationSamples returns sentCount: 0 (no resolvable
  // destination hop). Reporting that as 0% loss would render a full hour of
  // "target unreachable" as a healthy bar on the long-range chart. Mirror
  // raw.ts's per-snapshot summary - zero sent, zero replies = 100% loss.
  // We only reach buildRollupBucket for non-empty buckets, so this branch
  // always represents "we had data, none of it hit the destination".
  const destinationLossPct =
    destinationSentCount === 0
      ? 100
      : ((destinationSentCount - destinationReplyCount) / destinationSentCount) * 100
  const sorted = [...rttSamplesMs].sort((left, right) => left - right)

  return {
    bucketStart,
    destinationLossPct,
    destinationReplyCount,
    destinationSentCount,
    histogram: buildHistogram(rttSamplesMs),
    hops,
    rttAvgMs: average(rttSamplesMs),
    rttMaxMs: sorted.length === 0 ? null : sorted[sorted.length - 1],
    rttMinMs: sorted.length === 0 ? null : sorted[0],
    rttP50Ms: quantile(sorted, 0.5),
    rttP90Ms: quantile(sorted, 0.9),
    rttP99Ms: quantile(sorted, 0.99),
    snapshotCount,
  }
}

interface BucketReducerState {
  destinationSentCount: number
  rttSamplesMs: number[]
  snapshotCount: number
  // Absent when the caller asked not to aggregate per-hop (daily rollups).
  // Keyed by hop host string; see extractHopContributionsFromSnapshot.
  hopAccumulatorsByHost?: Map<string, HopAccumulator>
}

function accumulateHopContributions(
  hopAccumulatorsByHost: Map<string, HopAccumulator>,
  snapshot: StoredRawSnapshot,
): void {
  const contributions = extractHopContributionsFromSnapshot(snapshot.rawEvents)
  for (const [host, { hopIndexes, contribution }] of contributions) {
    const accumulator = hopAccumulatorsByHost.get(host) ?? {
      host,
      hopIndexCounts: new Map<number, number>(),
      sentCount: 0,
      replyRttsMs: [] as number[],
      snapshotCount: 0,
    }
    for (const hopIndex of hopIndexes) {
      accumulator.hopIndexCounts.set(hopIndex, (accumulator.hopIndexCounts.get(hopIndex) ?? 0) + 1)
    }
    accumulator.sentCount += contribution.sentCount
    accumulator.replyRttsMs.push(...contribution.replyRttsMs)
    accumulator.snapshotCount += 1
    hopAccumulatorsByHost.set(host, accumulator)
  }
}

function buildHopsFromAccumulators(
  hopAccumulatorsByHost: Map<string, HopAccumulator>,
): HopRollupEntry[] {
  // Sort by representativeHopIndex so consumers (heatmap, loss funnel) can
  // render hops in path order without re-sorting. Ties broken by host string
  // for stable output across rebuilds.
  return [...hopAccumulatorsByHost.values()]
    .map((accumulator) => buildHopRollupEntry(accumulator))
    .sort((left, right) => {
      if (left.representativeHopIndex !== right.representativeHopIndex) {
        return left.representativeHopIndex - right.representativeHopIndex
      }
      return left.host.localeCompare(right.host)
    })
}

function reduceToRollupBuckets<T>(
  items: T[],
  granularity: RollupGranularity,
  bucketDateOf: (item: T) => Date,
  accumulate: (state: BucketReducerState, item: T) => void,
  { includeHops }: { includeHops: boolean },
): MtrRollupBucket[] {
  const bucketState = new Map<string, BucketReducerState>()
  for (const item of items) {
    const bucketStart = getBucketStartIso(bucketDateOf(item), granularity)
    const current = bucketState.get(bucketStart) ?? {
      destinationSentCount: 0,
      rttSamplesMs: [],
      snapshotCount: 0,
      hopAccumulatorsByHost: includeHops ? new Map<string, HopAccumulator>() : undefined,
    }
    accumulate(current, item)
    bucketState.set(bucketStart, current)
  }

  return [...bucketState.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bucketStart, state]) =>
      buildRollupBucket(
        bucketStart,
        state.snapshotCount,
        state.destinationSentCount,
        state.rttSamplesMs,
        state.hopAccumulatorsByHost == null
          ? []
          : buildHopsFromAccumulators(state.hopAccumulatorsByHost),
      ),
    )
}

export function aggregateSnapshotsToRollupBuckets(
  snapshots: StoredRawSnapshot[],
  granularity: RollupGranularity,
): MtrRollupBucket[] {
  // Per-hop aggregates only for hourly rollups. Daily rollups keep 365 days
  // of history; adding ~30 hops per bucket to every day for every target
  // balloons the daily file for little benefit - the visualizations that
  // consume hops (heatmap, loss funnel) operate on hourly granularity, and
  // the 14-day raw retention means per-hop signal is inherently bounded to
  // the hourly window anyway.
  const includeHops = granularity === 'hour'
  return reduceToRollupBuckets(
    snapshots,
    granularity,
    (snapshot) => getCollectedAtDate(snapshot.collectedAt),
    (state, snapshot) => {
      const summary = summarizeDestinationSamples(snapshot.rawEvents)
      state.destinationSentCount += summary.sentCount
      state.rttSamplesMs.push(...summary.rttSamplesMs)
      state.snapshotCount += 1
      if (state.hopAccumulatorsByHost != null) {
        accumulateHopContributions(state.hopAccumulatorsByHost, snapshot)
      }
    },
    { includeHops },
  )
}

export function mergeRollupBuckets(
  existingBuckets: MtrRollupBucket[],
  generatedBuckets: MtrRollupBucket[],
  now: number,
  keepDays: number,
): MtrRollupBucket[] {
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000
  const merged = new Map<string, MtrRollupBucket>()

  for (const bucket of existingBuckets) {
    merged.set(bucket.bucketStart, bucket)
  }

  // A regenerated bucket only replaces the stored bucket if it reflects at least as
  // many underlying snapshots. Otherwise the raw-retention boundary would let a
  // partial regeneration silently erase the fuller historical rollup.
  for (const bucket of generatedBuckets) {
    const existing = merged.get(bucket.bucketStart)
    if (existing != null && existing.snapshotCount > bucket.snapshotCount) {
      continue
    }
    merged.set(bucket.bucketStart, bucket)
  }

  return [...merged.values()]
    .filter((bucket) => Date.parse(bucket.bucketStart) >= cutoff)
    .sort((left, right) => left.bucketStart.localeCompare(right.bucketStart))
}

// Convert an ISO bucketStart (e.g. "2026-04-20T09:00:00.000Z") to the on-disk
// filename prefix format ("20260420T090000Z.json") used by raw snapshots, so
// we can filter by lexicographic comparison.
export function isoBucketStartToFileName(iso: string): string | null {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/)
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  return `${y}${mo}${d}T${h}${mi}${s}Z.json`
}

export function buildRollupFile(
  granularity: RollupGranularity,
  metadata: TargetRollupMetadata,
  buckets: MtrRollupBucket[],
  now: Date,
): MtrRollupFile {
  return {
    buckets,
    generatedAt: now.toISOString(),
    granularity,
    host: metadata.host,
    label: metadata.label,
    observer: metadata.observer,
    probeMode: metadata.probeMode,
    schemaVersion: 2,
    target: metadata.target,
  }
}
