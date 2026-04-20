import path from 'node:path'
import { quantile } from './raw.ts'
import { type MtrRollupBucket, readRollupFile } from './rollups.ts'
import { parseCollectedAt, type SnapshotSummary } from './snapshot.ts'

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

export async function loadChartDefinitions(
  targetDir: string,
  snapshots: SnapshotSummary[],
  now: number,
): Promise<ChartDefinition[]> {
  const hourlyRollup = await readRollupFile(path.join(targetDir, 'hourly.rollup.json'), 'hour')
  const dailyRollup = await readRollupFile(path.join(targetDir, 'daily.rollup.json'), 'day')

  return [
    {
      label: 'Last 3 hours',
      points: getPointsFromSnapshots(snapshots, now, 3 * 60 * 60 * 1000),
      rangeLabel: '3h',
      sourceLabel: 'raw snapshots',
    },
    {
      label: 'Last 30 hours',
      points: getPointsFromSnapshots(snapshots, now, 30 * 60 * 60 * 1000),
      rangeLabel: '30h',
      sourceLabel: 'raw snapshots',
    },
    {
      label: 'Last 10 days',
      points:
        hourlyRollup == null
          ? getPointsFromSnapshots(snapshots, now, 10 * 24 * 60 * 60 * 1000)
          : getPointsFromRollupBuckets(hourlyRollup.buckets, 'hour', now, 10 * 24 * 60 * 60 * 1000),
      rangeLabel: '10d',
      sourceLabel: hourlyRollup == null ? 'raw snapshots' : 'hourly rollups',
    },
    {
      label: 'Last 360 days',
      points:
        dailyRollup == null
          ? getPointsFromSnapshots(snapshots, now, 360 * 24 * 60 * 60 * 1000)
          : getPointsFromRollupBuckets(dailyRollup.buckets, 'day', now, 360 * 24 * 60 * 60 * 1000),
      rangeLabel: '360d',
      sourceLabel: dailyRollup == null ? 'raw snapshots' : 'daily rollups',
    },
  ]
}
