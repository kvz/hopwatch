import path from 'node:path'
import { escapeHtml } from './layout.ts'
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
// Barebones thumbnail renderer. No axes, labels, legend, or stats — just a
// white rect with a smoke band (P25–P75) and a median line so the target-list
// overview can read "is this target OK" at a glance. The full renderChartSvg
// is tuned for SmokePing pixel parity at 770×340 and is unreadable at ~160×40.
export function renderChartMiniSvg(
  points: ChartPoint[],
  options: {
    height: number
    now: number
    rangeMs: number
    title: string
    width: number
  },
): string {
  const width = options.width
  const height = options.height
  const now = options.now
  const start = now - options.rangeMs

  const sortedByTime = points.slice().sort((left, right) => left.timestamp - right.timestamp)
  const medianCandidates = sortedByTime
    .map((point) => point.rttP50Ms)
    .filter((value): value is number => value != null && Number.isFinite(value))
  const observedMaxRttMs = medianCandidates.length === 0 ? 10 : Math.max(...medianCandidates)
  const yMaxMs = observedMaxRttMs * 1.2 || 10
  const anyLoss = sortedByTime.some(
    (point) => point.destinationLossPct != null && point.destinationLossPct > 0,
  )

  const xOf = (timestamp: number): number =>
    ((timestamp - start) / options.rangeMs) * (width - 2) + 1
  const yOf = (rttMs: number): number => {
    const clamped = Math.max(0, Math.min(yMaxMs, rttMs))
    return (1 - clamped / yMaxMs) * (height - 2) + 1
  }

  const gaps: number[] = []
  for (let index = 1; index < sortedByTime.length; index += 1) {
    gaps.push(sortedByTime[index].timestamp - sortedByTime[index - 1].timestamp)
  }
  gaps.sort((left, right) => left - right)
  const medianGapMs = gaps.length === 0 ? options.rangeMs / 60 : gaps[Math.floor(gaps.length / 2)]
  const gapThresholdMs = medianGapMs * 1.75

  interface BandPoint {
    lower: number
    median: number | null
    timestamp: number
    upper: number
  }

  const runs: BandPoint[][] = []
  let run: BandPoint[] = []
  const flush = (): void => {
    if (run.length > 0) runs.push(run)
    run = []
  }
  for (const point of sortedByTime) {
    const lower = point.rttP25Ms ?? point.rttMinMs
    const upper = point.rttP75Ms ?? point.rttP90Ms ?? point.rttMaxMs
    if (lower == null || upper == null || !Number.isFinite(lower) || !Number.isFinite(upper)) {
      flush()
      continue
    }

    if (run.length > 0 && point.timestamp - run[run.length - 1].timestamp > gapThresholdMs) {
      flush()
    }

    run.push({
      lower,
      median: point.rttP50Ms ?? point.rttAvgMs,
      timestamp: point.timestamp,
      upper,
    })
  }
  flush()

  const bandPolygons = runs
    .map((bandRun) => {
      if (bandRun.length === 0) return ''
      const upperPath = bandRun
        .map((entry) => `${xOf(entry.timestamp).toFixed(2)},${yOf(entry.upper).toFixed(2)}`)
        .join(' ')
      const lowerPath = [...bandRun]
        .reverse()
        .map((entry) => `${xOf(entry.timestamp).toFixed(2)},${yOf(entry.lower).toFixed(2)}`)
        .join(' ')
      return `<polygon points="${upperPath} ${lowerPath}" fill="#c6d6c1" stroke="none" />`
    })
    .filter((path) => path.length > 0)
    .join('')

  const medianStroke = anyLoss ? '#9f1d1d' : '#184d47'
  const medianPaths = runs
    .map((bandRun) => {
      const segments = bandRun.filter((entry) => entry.median != null) as Array<
        BandPoint & { median: number }
      >
      if (segments.length < 2) return ''
      const d = segments
        .map((entry, index) => {
          const prefix = index === 0 ? 'M' : 'L'
          return `${prefix}${xOf(entry.timestamp).toFixed(2)},${yOf(entry.median).toFixed(2)}`
        })
        .join(' ')
      return `<path d="${d}" fill="none" stroke="${medianStroke}" stroke-width="1.2" />`
    })
    .filter((path) => path.length > 0)
    .join('')

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}" class="chart-mini-svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" stroke="#d9ddcf" stroke-width="1" />
  ${bandPolygons}
  ${medianPaths}
</svg>`
}
