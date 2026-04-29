import { quantile } from './raw.ts'
import type { MtrRollupBucket } from './rollups.ts'
import { parseCollectedAt, type SnapshotSummary } from './snapshot.ts'
import type { HopwatchSqliteStore } from './sqlite-storage.ts'

export interface ChartPoint {
  destinationLossPct: number | null
  rttAvgMs: number | null
  rttMaxMs: number | null
  rttMinMs: number | null
  rttP25Ms: number | null
  rttP50Ms: number | null
  rttP75Ms: number | null
  rttP90Ms: number | null
  rttSamplesMs: number[] | null
  timestamp: number
}

export interface ChartDefinition {
  label: string
  points: ChartPoint[]
  rangeLabel: string
  rangeMs: number
  sourceLabel: string
}

export function bucketTimestamp(bucketStart: string, granularity: 'hour' | 'day'): number {
  const start = Date.parse(bucketStart)
  if (Number.isNaN(start)) {
    return 0
  }

  const bucketMs = granularity === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  return start + bucketMs / 2
}

export function getPointsFromSnapshots(
  snapshots: SnapshotSummary[],
  now: number,
  rangeMs: number,
): ChartPoint[] {
  const cutoff = now - rangeMs

  return snapshots
    .map((snapshot): ChartPoint | null => {
      const timestamp = parseCollectedAt(snapshot.collectedAt)
      if (timestamp == null || timestamp < cutoff) {
        return null
      }

      const sortedSamples =
        snapshot.destinationRttSamplesMs == null
          ? null
          : snapshot.destinationRttSamplesMs.slice().sort((left, right) => left - right)
      return {
        destinationLossPct: snapshot.destinationLossPct,
        rttAvgMs: snapshot.destinationAvgRttMs,
        rttMaxMs: snapshot.destinationRttMaxMs,
        rttMinMs: snapshot.destinationRttMinMs,
        rttP25Ms: sortedSamples == null ? null : quantile(sortedSamples, 0.25),
        rttP50Ms: snapshot.destinationRttP50Ms,
        rttP75Ms: sortedSamples == null ? null : quantile(sortedSamples, 0.75),
        rttP90Ms: snapshot.destinationRttP90Ms,
        rttSamplesMs: sortedSamples,
        timestamp,
      }
    })
    .filter((point): point is ChartPoint => point != null)
    .sort((left, right) => left.timestamp - right.timestamp)
}

export function getPointsFromRollupBuckets(
  buckets: MtrRollupBucket[],
  granularity: 'hour' | 'day',
  now: number,
  rangeMs: number,
): ChartPoint[] {
  const cutoff = now - rangeMs

  return buckets
    .map((bucket): ChartPoint | null => {
      const timestamp = bucketTimestamp(bucket.bucketStart, granularity)
      if (timestamp < cutoff) {
        return null
      }

      return {
        destinationLossPct: bucket.destinationLossPct,
        rttAvgMs: bucket.rttAvgMs,
        rttMaxMs: bucket.rttMaxMs,
        rttMinMs: bucket.rttMinMs,
        rttP25Ms: null,
        rttP50Ms: bucket.rttP50Ms,
        rttP75Ms: null,
        rttP90Ms: bucket.rttP90Ms,
        rttSamplesMs: null,
        timestamp,
      }
    })
    .filter((point): point is ChartPoint => point != null)
    .sort((left, right) => left.timestamp - right.timestamp)
}

const THREE_HOURS_MS = 3 * 60 * 60 * 1000
const THIRTY_HOURS_MS = 30 * 60 * 60 * 1000
const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000
const THREE_SIXTY_DAYS_MS = 360 * 24 * 60 * 60 * 1000

// Thumbnail-only loader for the root overview. renderRootIndex used to call
// loadChartDefinitions() and throw three of the four charts away - each target
// paying for two rollup-file reads plus three unused ChartPoint arrays. This
// helper builds just the 30h snapshot-backed chart that the overview needs.
export function buildThumbnailChartDefinition(
  snapshots: SnapshotSummary[],
  now: number,
): ChartDefinition {
  return {
    label: 'Last 30 hours',
    points: getPointsFromSnapshots(snapshots, now, THIRTY_HOURS_MS),
    rangeLabel: '30h',
    rangeMs: THIRTY_HOURS_MS,
    sourceLabel: 'raw snapshots',
  }
}

export async function loadChartDefinitions(
  store: HopwatchSqliteStore,
  targetSlug: string,
  snapshots: SnapshotSummary[],
  now: number,
): Promise<ChartDefinition[]> {
  const hourlyRollup = store.getRollupFile(targetSlug, 'hour')
  const dailyRollup = store.getRollupFile(targetSlug, 'day')

  return [
    {
      label: 'Last 3 hours',
      points: getPointsFromSnapshots(snapshots, now, THREE_HOURS_MS),
      rangeLabel: '3h',
      rangeMs: THREE_HOURS_MS,
      sourceLabel: 'raw snapshots',
    },
    {
      label: 'Last 30 hours',
      points: getPointsFromSnapshots(snapshots, now, THIRTY_HOURS_MS),
      rangeLabel: '30h',
      rangeMs: THIRTY_HOURS_MS,
      sourceLabel: 'raw snapshots',
    },
    {
      label: 'Last 10 days',
      points:
        hourlyRollup == null
          ? getPointsFromSnapshots(snapshots, now, TEN_DAYS_MS)
          : getPointsFromRollupBuckets(hourlyRollup.buckets, 'hour', now, TEN_DAYS_MS),
      rangeLabel: '10d',
      rangeMs: TEN_DAYS_MS,
      sourceLabel: hourlyRollup == null ? 'raw snapshots' : 'hourly rollups',
    },
    {
      label: 'Last 360 days',
      points:
        dailyRollup == null
          ? getPointsFromSnapshots(snapshots, now, THREE_SIXTY_DAYS_MS)
          : getPointsFromRollupBuckets(dailyRollup.buckets, 'day', now, THREE_SIXTY_DAYS_MS),
      rangeLabel: '360d',
      rangeMs: THREE_SIXTY_DAYS_MS,
      sourceLabel: dailyRollup == null ? 'raw snapshots' : 'daily rollups',
    },
  ]
}
