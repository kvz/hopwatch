import type { ChartPoint } from './chart.ts'

// SmokePing's default loss_colors for pings=20 (from Smokeping.pm:1300).
// Buckets are 0, 1, 2, 3, 4-5, 6-10, 11-19, 20/20 — used to paint per-sample
// median markers (matched by `maxLossPct`) and the legend swatches below the
// chart (rendered from `legendLabel`).
export const SMOKEPING_LOSS_BUCKETS: {
  color: string
  legendLabel: string
  maxLossPct: number
}[] = [
  { color: '#26ff00', legendLabel: '0', maxLossPct: 0 },
  { color: '#00b8ff', legendLabel: '1', maxLossPct: 5 },
  { color: '#0059ff', legendLabel: '2', maxLossPct: 10 },
  { color: '#7e00ff', legendLabel: '3', maxLossPct: 15 },
  { color: '#ff00ff', legendLabel: '4-5', maxLossPct: 25 },
  { color: '#ff5500', legendLabel: '6-10', maxLossPct: 50 },
  { color: '#ff0000', legendLabel: '11-19', maxLossPct: 99.99 },
  { color: '#a00000', legendLabel: '20/20', maxLossPct: 100 },
]

export function lossColorFor(pct: number | null): string {
  const v = pct == null || !Number.isFinite(pct) ? 0 : pct
  for (const bucket of SMOKEPING_LOSS_BUCKETS) {
    if (v <= bucket.maxLossPct + 1e-9) return bucket.color
  }
  return SMOKEPING_LOSS_BUCKETS[SMOKEPING_LOSS_BUCKETS.length - 1].color
}

// Retained for reference: the Smokeping stroke color lookup keyed by loss
// percentage. Not currently consumed because renderChartSvg matches the
// reference PNGs pixel-for-pixel with AREA+STACK polygons instead.
export function getLineStrokeForLoss(lossPct: number | null): string {
  if (lossPct == null) return '#184d47'
  if (lossPct <= 0) return '#26b800'
  if (lossPct <= 5) return '#53c000'
  if (lossPct <= 10) return '#00b0c0'
  if (lossPct <= 15) return '#3b5fc7'
  if (lossPct <= 25) return '#8f3dbb'
  if (lossPct <= 50) return '#c23e8f'
  if (lossPct <= 80) return '#e06d2a'
  if (lossPct < 100) return '#cc3d17'
  return '#880000'
}

const RAW_Y_STEPS = [
  0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50,
  100, 200, 500, 1000,
]

// Retained for reference: the coarse step picker from the earlier renderer.
// pickYScale supersedes it everywhere but we keep the function exported so a
// future simplified chart (e.g. thumbnails) can reach for it without copy-paste.
export function niceYStep(rangeMs: number): number {
  const target = rangeMs / 12
  for (const candidate of RAW_Y_STEPS) {
    if (candidate >= target * 0.95) return candidate
  }
  return RAW_Y_STEPS[RAW_Y_STEPS.length - 1]
}

// Given SmokePing-style upper-limit (median_max * 1.2 from findmax), pick
// (step, yMax) to match rrdtool's rendering. Rules derived from observed
// reference behavior on .maxheight files vs rendered PNGs:
//   - Smallest step for which intervals = yMax/step ≤ 15.
//   - yMax = ceil(upper/step)*step when upper/ceil ≥ 0.985 (SmokePing snaps
//     up when the limit is within ~1.5% of the next nice value), otherwise
//     floor to the step below. This reproduces AP (2.112 → 2.0),
//     r2-EU (1.452 → 1.5), G/CF (1.617 → 1.6), Google (2.145 → 2.2),
//     EU-West (239.57 → 240).
export function pickYScale(upperLimitMs: number): { step: number; yMax: number } {
  const safe = Math.max(upperLimitMs, 1e-6)
  for (const step of RAW_Y_STEPS) {
    const intervals = safe / step
    if (intervals <= 15 + 1e-9) return { step, yMax: safe }
  }
  const step = RAW_Y_STEPS[RAW_Y_STEPS.length - 1]
  return { step, yMax: safe }
}

export function formatYLabel(ms: number): string {
  if (ms === 0) return '0.0'
  if (ms < 10) return `${ms.toFixed(1)} m`
  if (ms < 1000) return `${ms.toFixed(0)} m`
  return `${(ms / 1000).toFixed(1)}`
}

export function formatXLabel(ts: number, stepMs: number): string {
  const date = new Date(ts)
  if (stepMs < 24 * 3600 * 1000) {
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
  }
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`
}

export function formatSmokeDate(date: Date): string {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const dow = weekdays[date.getUTCDay()]
  const mon = months[date.getUTCMonth()]
  const day = String(date.getUTCDate())
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  const ss = String(date.getUTCSeconds()).padStart(2, '0')
  const year = date.getUTCFullYear()
  return `${dow} ${mon} ${day} ${hh}:${mm}:${ss} ${year}`
}

// Pick a readable top-of-chart x-grid cadence for the given window. Matches
// the tiers SmokePing uses on its stock 3h/30h/10d/360d charts.
export function pickXGridStepMs(rangeMs: number): number {
  if (rangeMs <= 4 * 3600 * 1000) return 20 * 60 * 1000
  if (rangeMs <= 36 * 3600 * 1000) return 4 * 3600 * 1000
  if (rangeMs <= 12 * 24 * 3600 * 1000) return 24 * 3600 * 1000
  return 30 * 24 * 3600 * 1000
}

// Each sample's bar extends backward from its timestamp by up to
// `2 * barHalfMs` (≈ the median inter-sample gap). When the actual gap to
// the previous sample is smaller than that — e.g. cluster of retries or
// backfilled snapshots — the default width would overlap the neighbor's
// bar, drowning the chart in stacked greens and smokes. Clamp each bar's
// left edge at the previous sample's timestamp so adjacent bars meet
// cleanly regardless of local cadence.
export function computeLeftEdgeMsByTimestamp(
  sortedByTime: ChartPoint[],
  barHalfMs: number,
): Map<number, number> {
  const leftEdgeMsByTs = new Map<number, number>()
  for (let i = 0; i < sortedByTime.length; i += 1) {
    const t = sortedByTime[i].timestamp
    const defaultLeft = t - 2 * barHalfMs
    const prevT = i > 0 ? sortedByTime[i - 1].timestamp : Number.NEGATIVE_INFINITY
    leftEdgeMsByTs.set(t, Math.max(defaultLeft, prevT))
  }
  return leftEdgeMsByTs
}

export interface ChartStats {
  lossAvg: string
  lossMax: string
  lossMin: string
  lossNow: string
  rttAmPerS: string
  rttAvg: string
  rttMax: string
  rttMin: string
  rttNow: string
  rttSd: string
}

// SmokePing stats use the median DS exclusively (VDEF over `median` with
// AVERAGE/MAXIMUM/MINIMUM/LAST/STDEV). Fall back to rttAvgMs only when no
// P50 data is present anywhere, not per-point.
export function computeChartStats(points: ChartPoint[]): ChartStats {
  const medianOnly = points
    .map((p) => p.rttP50Ms)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const medianValues =
    medianOnly.length > 0
      ? medianOnly
      : points.map((p) => p.rttAvgMs).filter((v): v is number => v != null)
  const lossValues = points.map((p) => p.destinationLossPct).filter((v): v is number => v != null)

  const avgOf = (vals: number[]): number => vals.reduce((s, v) => s + v, 0) / vals.length
  const lastOf = <T>(vals: T[]): T => vals[vals.length - 1]
  const sdOf = (v: number[]): number => {
    if (v.length < 2) return 0
    const mean = avgOf(v)
    const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length
    return Math.sqrt(variance)
  }
  const agg = (vals: number[], fn: (v: number[]) => number): string =>
    vals.length === 0 ? 'n/a' : fn(vals).toFixed(1)

  const rttSdRaw = medianValues.length < 2 ? null : sdOf(medianValues)
  const rttAvgRaw = medianValues.length === 0 ? null : avgOf(medianValues)
  const formatAmPerS = (avg: number | null, sd: number | null): string => {
    if (avg == null || sd == null || sd === 0 || !Number.isFinite(sd)) return '-nan'
    const ratio = avg / sd
    if (!Number.isFinite(ratio)) return '-nan'
    if (Math.abs(ratio) >= 1_000_000) return `${(ratio / 1_000_000).toFixed(1)} M`
    if (Math.abs(ratio) >= 1000) return `${(ratio / 1000).toFixed(1)} k`
    return ratio.toFixed(1)
  }

  return {
    lossAvg: lossValues.length === 0 ? 'n/a' : avgOf(lossValues).toFixed(2),
    lossMax: lossValues.length === 0 ? 'n/a' : Math.max(...lossValues).toFixed(2),
    lossMin: lossValues.length === 0 ? 'n/a' : Math.min(...lossValues).toFixed(2),
    lossNow: lossValues.length === 0 ? 'n/a' : lastOf(lossValues).toFixed(2),
    rttAmPerS: formatAmPerS(rttAvgRaw, rttSdRaw),
    rttAvg: agg(medianValues, avgOf),
    rttMax: agg(medianValues, (v) => Math.max(...v)),
    rttMin: agg(medianValues, (v) => Math.min(...v)),
    rttNow: agg(medianValues, lastOf),
    rttSd: agg(medianValues, sdOf),
  }
}
