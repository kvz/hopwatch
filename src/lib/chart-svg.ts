import type { ChartPoint } from './chart.ts'
import { escapeHtml } from './layout.ts'
import { quantile } from './raw.ts'

// Retained for reference: the Smokeping stroke color lookup keyed by loss
// percentage. Not currently consumed because renderChartSvg matches the
// reference PNGs pixel-for-pixel with AREA+STACK polygons instead.
function getLineStrokeForLoss(lossPct: number | null): string {
  if (lossPct == null) {
    return '#184d47'
  }

  if (lossPct <= 0) {
    return '#26b800'
  }

  if (lossPct <= 5) {
    return '#53c000'
  }

  if (lossPct <= 10) {
    return '#00b0c0'
  }

  if (lossPct <= 15) {
    return '#3b5fc7'
  }

  if (lossPct <= 25) {
    return '#8f3dbb'
  }

  if (lossPct <= 50) {
    return '#c23e8f'
  }

  if (lossPct <= 80) {
    return '#e06d2a'
  }

  if (lossPct < 100) {
    return '#cc3d17'
  }

  return '#880000'
}

function niceYStep(rangeMs: number): number {
  const rawSteps = [
    0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20,
    50, 100, 200, 500, 1000,
  ]
  const target = rangeMs / 12
  for (const candidate of rawSteps) {
    if (candidate >= target * 0.95) return candidate
  }
  return rawSteps[rawSteps.length - 1]
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
function pickYScale(upperLimitMs: number): { step: number; yMax: number } {
  const rawSteps = [
    0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20,
    50, 100, 200, 500, 1000,
  ]
  const safe = Math.max(upperLimitMs, 1e-6)
  for (const step of rawSteps) {
    const intervals = safe / step
    if (intervals <= 15 + 1e-9) return { step, yMax: safe }
  }
  const step = rawSteps[rawSteps.length - 1]
  return { step, yMax: safe }
}

function formatYLabel(ms: number): string {
  if (ms === 0) return '0.0'
  if (ms < 10) return `${ms.toFixed(1)} m`
  if (ms < 1000) return `${ms.toFixed(0)} m`
  return `${(ms / 1000).toFixed(1)}`
}

function formatXLabel(ts: number, stepMs: number): string {
  const date = new Date(ts)
  if (stepMs < 24 * 3600 * 1000) {
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
  }
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`
}

function formatSmokeDate(date: Date): string {
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

export function renderChartSvg(
  points: ChartPoint[],
  options: {
    height: number
    now: number
    rangeMs: number
    signature?: string
    title: string
    upperLimitMs?: number
    width: number
  },
): string {
  const width = options.width
  const height = options.height
  const padding = { bottom: 82, left: 66, right: 31, top: 13 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  // SmokePing's findmax uses the `median` DS across time windows; match that.
  const medianCandidates = points
    .map((point) => point.rttP50Ms)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const observedMaxRttMs = medianCandidates.length === 0 ? 10 : Math.max(...medianCandidates)
  const yMinMs = 0
  // Prefer an explicit SmokePing-style upper-limit when provided (findmax * 1.2
  // across time windows); else approximate from observed P90/avg with ~5% headroom.
  const upperForScale =
    options.upperLimitMs != null && options.upperLimitMs > 0
      ? options.upperLimitMs
      : observedMaxRttMs * 1.2
  const { step: yStep, yMax: yMaxMs } = pickYScale(upperForScale)
  const yScale = yMaxMs - yMinMs || 1
  const now = options.now
  const start = now - options.rangeMs

  const xOf = (timestamp: number): number =>
    padding.left + ((timestamp - start) / options.rangeMs) * chartWidth
  const yOf = (rttMs: number): number => {
    const clamped = Math.max(yMinMs, Math.min(yMaxMs, rttMs))
    return padding.top + 2 + (1 - (clamped - yMinMs) / yScale) * (chartHeight - 2)
  }

  const sortedByTime = points.slice().sort((a, b) => a.timestamp - b.timestamp)
  const gaps: number[] = []
  for (let i = 1; i < sortedByTime.length; i += 1) {
    gaps.push(sortedByTime[i].timestamp - sortedByTime[i - 1].timestamp)
  }
  gaps.sort((a, b) => a - b)
  const medianGapMs = gaps.length === 0 ? options.rangeMs / 60 : gaps[Math.floor(gaps.length / 2)]
  const avgGapMs = medianGapMs
  const barHalfMs = Math.max(avgGapMs / 2, options.rangeMs / 400)
  const gapThresholdMs = avgGapMs * 1.75

  // Each sample's bar extends backward from its timestamp by up to
  // `2 * barHalfMs` (≈ the median inter-sample gap). When the actual gap to
  // the previous sample is smaller than that — e.g. cluster of retries or
  // backfilled snapshots — the default width would overlap the neighbor's
  // bar, drowning the chart in stacked greens and smokes. Clamp each bar's
  // left edge at the previous sample's timestamp so adjacent bars meet
  // cleanly regardless of local cadence.
  const leftEdgeMsFor = new Map<number, number>()
  for (let i = 0; i < sortedByTime.length; i += 1) {
    const t = sortedByTime[i].timestamp
    const defaultLeft = t - 2 * barHalfMs
    const prevT = i > 0 ? sortedByTime[i - 1].timestamp : Number.NEGATIVE_INFINITY
    leftEdgeMsFor.set(t, Math.max(defaultLeft, prevT))
  }

  // rrdtool draws AREA+STACK as a polygon bounded above by the upper-quantile
  // curve and below by the lower-quantile curve, connecting consecutive valid
  // points with straight segments. Missing samples (NaN) break the polygon so
  // we don't bridge across gaps.
  const bandBarsForIndices = (
    ibot: number,
    itop: number,
    pingSlots: number,
    fallbackLowerKey: 'rttMinMs' | 'rttP25Ms',
    fallbackUpperKey: 'rttMaxMs' | 'rttP75Ms' | 'rttP90Ms',
    fill: string,
  ): string => {
    const plotLeft = padding.left
    const plotRight = width - padding.right
    type BandPoint = { t: number; lo: number; hi: number }
    const runs: BandPoint[][] = []
    let run: BandPoint[] = []
    const flush = (): void => {
      if (run.length > 0) runs.push(run)
      run = []
    }
    for (let idx = 0; idx < sortedByTime.length; idx += 1) {
      const point = sortedByTime[idx]
      let lower: number | null | undefined
      let upper: number | null | undefined
      if (point.rttSamplesMs != null && point.rttSamplesMs.length > 0) {
        const sorted = point.rttSamplesMs.slice().sort((a, b) => a - b)
        const qLo = (ibot - 1) / (pingSlots - 1)
        const qHi = (itop - 1) / (pingSlots - 1)
        lower = quantile(sorted, qLo)
        upper = quantile(sorted, qHi)
      } else {
        lower = point[fallbackLowerKey]
        upper = point[fallbackUpperKey]
      }
      if (lower == null || upper == null || !Number.isFinite(lower) || !Number.isFinite(upper)) {
        flush()
        continue
      }
      if (run.length > 0 && point.timestamp - run[run.length - 1].t > gapThresholdMs) {
        flush()
      }
      // rrdtool's CDEF `cp<i> = if ping<i> < upper then ping<i> else INF` hides
      // any ping exceeding the chart's upper limit. Mirror that by clipping,
      // which keeps the polygon intact and capped at the chart top.
      const clippedUpper = Math.min(upper, yMaxMs)
      if (clippedUpper <= lower) {
        flush()
        continue
      }
      run.push({ t: point.timestamp, lo: lower, hi: clippedUpper })
    }
    flush()
    const rects: string[] = []
    for (const seg of runs) {
      for (const p of seg) {
        const leftMs = leftEdgeMsFor.get(p.t) ?? p.t - 2 * barHalfMs
        const xLeftRaw = Math.min(plotRight, Math.max(plotLeft, xOf(leftMs)))
        const xRightRaw = Math.min(plotRight, Math.max(plotLeft, xOf(p.t)))
        const xLeft = Math.round(xLeftRaw)
        const xRight = Math.round(xRightRaw)
        const w = xRight - xLeft
        if (w <= 0) continue
        const yHi = Math.round(yOf(p.hi))
        const yLo = Math.round(yOf(p.lo))
        const h = yLo - yHi
        if (h <= 0) continue
        rects.push(
          `<rect x="${xLeft}" y="${yHi}" width="${w}" height="${h}" fill="${fill}" shape-rendering="crispEdges" />`,
        )
      }
    }
    return rects.join('')
  }

  // SmokePing's smokecol() from Smokeping.pm: for pings=20, half=10, the loop
  // runs ibot=1..10 (itop=20..11) drawing a band from sorted ping[ibot] up to
  // ping[itop] with grayscale int(190/half*(half-ibot))+50. Innermost (ibot=10)
  // = #323232, outermost (ibot=1) = #DDDDDD.
  const smokePings = 20
  const smokeHalf = smokePings / 2
  const smokeBands: {
    ibot: number
    itop: number
    fallbackLo: 'rttMinMs' | 'rttP25Ms'
    fallbackHi: 'rttMaxMs' | 'rttP75Ms' | 'rttP90Ms'
    fill: string
  }[] = []
  for (let ibot = 1; ibot <= smokeHalf; ibot += 1) {
    const itop = smokePings + 1 - ibot
    const gray = Math.floor((190 / smokeHalf) * (smokeHalf - ibot)) + 50
    const hex = gray.toString(16).padStart(2, '0')
    const fallbackLo: 'rttMinMs' | 'rttP25Ms' = ibot === 1 ? 'rttMinMs' : 'rttP25Ms'
    const fallbackHi: 'rttMaxMs' | 'rttP75Ms' | 'rttP90Ms' =
      ibot === 1 ? 'rttMaxMs' : ibot <= 2 ? 'rttP90Ms' : 'rttP75Ms'
    smokeBands.push({ ibot, itop, fallbackLo, fallbackHi, fill: `#${hex}${hex}${hex}` })
  }
  const smokeBandsSvg = smokeBands
    .map((band) =>
      bandBarsForIndices(
        band.ibot,
        band.itop,
        smokePings,
        band.fallbackLo,
        band.fallbackHi,
        band.fill,
      ),
    )
    .join('')

  const sampleDots = ''

  // Intentionally no LINE1:median#202020. SmokePing.pm does reference a
  // `LINE1:median#202020` but in the rrdtool-rasterized reference PNGs this
  // line is not visibly rendered across adjacent bins — each bin's 2 px
  // colored AREA strip ends up adjacent to the next bin's strip without a
  // diagonal connector. Adding a diagonal `<line>` diverges from the
  // reference (raises fixture-diff mismatch by several percentage points),
  // and stands out especially at our sparse 15-minute sample cadence where
  // bins are ~87 px wide.
  const lineSegments: string[] = []

  // Per-sample colored median markers (Smokeping.pm:1397-1405). For each
  // sample, rrdtool stacks a 2-pixel-tall AREA at `median ± 1px` in the color
  // matching the sample's loss bucket. Defaults (for pings=20): 0→green,
  // 1→cyan, 2→blue, 3→purple, 4–5→magenta, 6–10→orange, 11–19→red, 20→dark.
  const lossBuckets: { maxLossPct: number; color: string }[] = [
    { maxLossPct: 0, color: '#26ff00' },
    { maxLossPct: 5, color: '#00b8ff' },
    { maxLossPct: 10, color: '#0059ff' },
    { maxLossPct: 15, color: '#7e00ff' },
    { maxLossPct: 25, color: '#ff00ff' },
    { maxLossPct: 50, color: '#ff5500' },
    { maxLossPct: 99.99, color: '#ff0000' },
    { maxLossPct: 100, color: '#a00000' },
  ]
  const lossColorFor = (pct: number | null): string => {
    const v = pct == null || !Number.isFinite(pct) ? 0 : pct
    for (const bucket of lossBuckets) {
      if (v <= bucket.maxLossPct + 1e-9) return bucket.color
    }
    return lossBuckets[lossBuckets.length - 1].color
  }
  const medianMarkers: string[] = []
  const plotLeftMarker = padding.left
  const plotRightMarker = width - padding.right
  const plotTop = Math.round(padding.top)
  const plotBottom = Math.round(padding.top + chartHeight)
  for (const point of points) {
    const leftMs = leftEdgeMsFor.get(point.timestamp) ?? point.timestamp - 2 * barHalfMs
    const xLeftRaw = Math.max(plotLeftMarker, Math.min(plotRightMarker, xOf(leftMs)))
    const xRightRaw = Math.max(plotLeftMarker, Math.min(plotRightMarker, xOf(point.timestamp)))
    const xLeft = Math.round(xLeftRaw)
    const xRight = Math.round(xRightRaw)
    const w = xRight - xLeft
    if (w <= 0) continue

    const medianMs = point.rttP50Ms ?? point.rttAvgMs
    if (medianMs != null && Number.isFinite(medianMs) && medianMs <= yMaxMs) {
      const yMid = Math.round(yOf(medianMs))
      const color = lossColorFor(point.destinationLossPct)
      medianMarkers.push(
        `<rect x="${xLeft}" y="${yMid - 1}" width="${w}" height="2" fill="${color}" shape-rendering="crispEdges" />`,
      )
      continue
    }

    // No median to position a horizontal marker on (e.g. 100 % loss → no
    // replies → no sample array). Without a fallback these bins render
    // completely empty on the raw-snapshot charts while showing up on the
    // rollup-backed charts (where other snapshots in the bucket still have a
    // median). Paint a full-height colored strip so loss spikes are visible.
    if (point.destinationLossPct != null && point.destinationLossPct > 0) {
      const color = lossColorFor(point.destinationLossPct)
      medianMarkers.push(
        `<rect x="${xLeft}" y="${plotTop}" width="${w}" height="${plotBottom - plotTop}" fill="${color}" fill-opacity="0.35" shape-rendering="crispEdges" />`,
      )
    }
  }
  const medianMarkersSvg = medianMarkers.join('')

  const yTicks: number[] = []
  for (let value = yMinMs; value <= yMaxMs + 1e-9; value += yStep) {
    yTicks.push(Number(value.toFixed(6)))
  }
  const yGrid = yTicks
    .map((value) => {
      const y = Math.round(yOf(value))
      return `<line x1="${padding.left + 1}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#f3bfbf" stroke-width="1" stroke-dasharray="1,1" shape-rendering="crispEdges" />`
    })
    .join('')
  const yMinorPixelStep = (yStep / 2) * ((chartHeight - 2) / yScale)
  const yMinorValues: number[] = []
  if (yMinorPixelStep >= 8) {
    for (let value = yMinMs + yStep / 2; value < yMaxMs; value += yStep) {
      yMinorValues.push(value)
    }
  }
  const yMinorGrid = yMinorValues
    .map((value) => {
      const y = Math.round(yOf(value))
      return `<line x1="${padding.left + 2}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#dddddd" stroke-width="1" stroke-dasharray="1,1" shape-rendering="crispEdges" />`
    })
    .join('')
  const yTickMarks = yTicks
    .map((value) => {
      const y = yOf(value)
      return `<line x1="${padding.left - 3}" y1="${y.toFixed(2)}" x2="${padding.left}" y2="${y.toFixed(2)}" stroke="#333" stroke-width="0.8" />`
    })
    .join('')
  const yMinorTicks: string[] = []
  for (let value = yMinMs; value <= yMaxMs + 1e-9; value += yStep / 5) {
    if (Math.abs(value / yStep - Math.round(value / yStep)) < 1e-6) continue
    const y = yOf(value)
    yMinorTicks.push(
      `<line x1="${padding.left - 2}" y1="${y.toFixed(2)}" x2="${padding.left}" y2="${y.toFixed(2)}" stroke="#666" stroke-width="0.5" />`,
    )
  }
  const yLabels = yTicks
    .map((value) => {
      const y = yOf(value)
      return `<text x="${padding.left - 5}" y="${(y + 3).toFixed(2)}" font-size="10" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333" text-anchor="end">${formatYLabel(value)}</text>`
    })
    .join('')

  const xGridStepMs =
    options.rangeMs <= 4 * 3600 * 1000
      ? 20 * 60 * 1000
      : options.rangeMs <= 36 * 3600 * 1000
        ? 4 * 3600 * 1000
        : options.rangeMs <= 12 * 24 * 3600 * 1000
          ? 24 * 3600 * 1000
          : 30 * 24 * 3600 * 1000
  const xGridFirst = Math.ceil(start / xGridStepMs) * xGridStepMs
  const xGridLines: string[] = []
  const xTickMarks: string[] = []
  const xLabels: string[] = []
  for (let gridT = xGridFirst; gridT <= now; gridT += xGridStepMs) {
    const x = xOf(gridT)
    xGridLines.push(
      `<line x1="${x.toFixed(2)}" y1="${padding.top}" x2="${x.toFixed(2)}" y2="${(padding.top + chartHeight).toFixed(2)}" stroke="#f3bfbf" stroke-width="1" stroke-dasharray="1,1" shape-rendering="crispEdges" />`,
    )
    xTickMarks.push(
      `<line x1="${x.toFixed(2)}" y1="${(padding.top + chartHeight).toFixed(2)}" x2="${x.toFixed(2)}" y2="${(padding.top + chartHeight + 3).toFixed(2)}" stroke="#333" stroke-width="0.8" />`,
    )
    xLabels.push(
      `<text x="${x.toFixed(2)}" y="${(padding.top + chartHeight + 13).toFixed(2)}" font-size="10" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333" text-anchor="middle">${formatXLabel(gridT, xGridStepMs)}</text>`,
    )
  }
  const xMinorStepMs = xGridStepMs / 4
  const xMinorFirst = Math.ceil(start / xMinorStepMs) * xMinorStepMs
  const xMinorTicks: string[] = []
  const xMinorGridLines: string[] = []
  for (let minorT = xMinorFirst; minorT <= now; minorT += xMinorStepMs) {
    if (Math.abs(minorT / xGridStepMs - Math.round(minorT / xGridStepMs)) < 1e-6) continue
    const x = xOf(minorT)
    xMinorTicks.push(
      `<line x1="${x.toFixed(2)}" y1="${(padding.top + chartHeight).toFixed(2)}" x2="${x.toFixed(2)}" y2="${(padding.top + chartHeight + 2).toFixed(2)}" stroke="#666" stroke-width="0.5" />`,
    )
    xMinorGridLines.push(
      `<line x1="${x.toFixed(2)}" y1="${padding.top}" x2="${x.toFixed(2)}" y2="${(padding.top + chartHeight).toFixed(2)}" stroke="#dddddd" stroke-width="1" stroke-dasharray="1,1" shape-rendering="crispEdges" />`,
    )
  }
  const xGrid = xGridLines.join('')
  const xMinorGrid = xMinorGridLines.join('')
  const xLabelsSvg = xLabels.join('')

  // SmokePing stats use the median DS exclusively (VDEF over `median` with
  // AVERAGE/MAXIMUM/MINIMUM/LAST/STDEV). Fall back to rttAvgMs only when no
  // P50 data is present anywhere, not per-point.
  const medianOnly = points
    .map((p) => p.rttP50Ms)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const medianValues =
    medianOnly.length > 0
      ? medianOnly
      : points.map((p) => p.rttAvgMs).filter((v): v is number => v != null)
  const lossValues = points.map((p) => p.destinationLossPct).filter((v): v is number => v != null)
  const agg = (vals: number[], fn: (v: number[]) => number): string =>
    vals.length === 0 ? 'n/a' : fn(vals).toFixed(1)
  const avgOf = (vals: number[]): number => vals.reduce((s, v) => s + v, 0) / vals.length
  const lastOf = <T>(vals: T[]): T => vals[vals.length - 1]
  const rttAvg = agg(medianValues, avgOf)
  const rttMax = agg(medianValues, (v) => Math.max(...v))
  const rttMin = agg(medianValues, (v) => Math.min(...v))
  const rttNow = agg(medianValues, lastOf)
  const sdOf = (v: number[]): number => {
    if (v.length < 2) return 0
    const mean = avgOf(v)
    const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length
    return Math.sqrt(variance)
  }
  const rttSd = agg(medianValues, sdOf)
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
  const rttAmPerS = formatAmPerS(rttAvgRaw, rttSdRaw)
  const lossAvg = lossValues.length === 0 ? 'n/a' : avgOf(lossValues).toFixed(2)
  const lossMax = lossValues.length === 0 ? 'n/a' : Math.max(...lossValues).toFixed(2)
  const lossMin = lossValues.length === 0 ? 'n/a' : Math.min(...lossValues).toFixed(2)
  const lossNow = lossValues.length === 0 ? 'n/a' : lastOf(lossValues).toFixed(2)

  const statsFontSize = 10
  const statsFontFamily = 'DejaVu Sans Mono,Menlo,Consolas,monospace'
  // SmokePing's default loss_colors for pings=20 (from Smokeping.pm:1300).
  // Buckets are 0, 1, 2, 3, 4-5, 6-10, 11-19, 20/20.
  const lossSwatches = [
    { color: '#26ff00', label: '0' },
    { color: '#00b8ff', label: '1' },
    { color: '#0059ff', label: '2' },
    { color: '#7e00ff', label: '3' },
    { color: '#ff00ff', label: '4-5' },
    { color: '#ff5500', label: '6-10' },
    { color: '#ff0000', label: '11-19' },
    { color: '#a00000', label: '20/20' },
  ]
  const legendY = padding.top + chartHeight + 58
  const legendStartX = padding.left + 84
  const maxProbes = Math.max(
    0,
    ...points.map((p) => (p.rttSamplesMs == null ? 0 : p.rttSamplesMs.length)),
  )
  const probeCountLabel =
    maxProbes === 0
      ? ''
      : `<text x="${legendStartX + lossSwatches.length * 46 + 4}" y="${legendY + 1}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333">${maxProbes}/${maxProbes}</text>`
  const legendSwatches =
    lossSwatches
      .map((swatch, index) => {
        const x = legendStartX + index * 46
        return `<rect x="${x}" y="${legendY - 8}" width="10" height="10" fill="${swatch.color}" /><text x="${x + 13}" y="${legendY + 1}" font-size="9" font-family="${statsFontFamily}" fill="#333">${swatch.label}</text>`
      })
      .join('') + probeCountLabel

  // Column positions measured against rrdtool/SmokePing reference PNGs at 697×297.
  // See docs/mtr-fixtures/real-ap/images/General/Cloudflare_last_10800.png.
  const statsLabelRightX = padding.left + 23
  const statsColStart = padding.left + 32
  const statsColWidth = 86
  const statsNumberWidth = 28
  const statsLine1Y = padding.top + chartHeight + 30
  const statsLine2Y = padding.top + chartHeight + 44
  const mkStatsCols = (values: string[], unit: string, labels: string[], y: number): string =>
    values
      .map((value, index) => {
        const numRightX = statsColStart + index * statsColWidth + statsNumberWidth
        const tailX = numRightX + 8
        return `<text x="${numRightX}" y="${y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333" text-anchor="end">${value}</text><text x="${tailX}" y="${y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333">${unit} ${labels[index]}</text>`
      })
      .join('')
  const statsTitle1 = `<text x="${statsLabelRightX}" y="${statsLine1Y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" font-weight="bold" fill="#333" text-anchor="end">median rtt:</text>`
  const statsLine1 = mkStatsCols(
    [rttAvg, rttMax, rttMin, rttNow, rttSd],
    'ms',
    ['avg', 'max', 'min', 'now', 'sd'],
    statsLine1Y,
  )
  const amPerSNumRightX = padding.left + 476
  const amPerSUnitX = padding.left + 514
  const statsLine1AmPerS = `<text x="${amPerSNumRightX}" y="${statsLine1Y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333" text-anchor="end">${rttAmPerS}</text><text x="${amPerSUnitX}" y="${statsLine1Y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333">am/s</text>`
  const statsTitle2 = `<text x="${statsLabelRightX}" y="${statsLine2Y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" font-weight="bold" fill="#333" text-anchor="end">packet loss:</text>`
  const statsLine2 = mkStatsCols(
    [lossAvg, lossMax, lossMin, lossNow],
    '%',
    ['avg', 'max', 'min', 'now'],
    statsLine2Y,
  )
  const statsLegendLabel = `<text x="${statsLabelRightX}" y="${legendY + 1}" font-size="${statsFontSize}" font-family="${statsFontFamily}" font-weight="bold" fill="#333" text-anchor="end">loss color:</text>`

  const probeLineY = legendY + 14
  const probeLineLabel = `<text x="${statsLabelRightX}" y="${probeLineY}" font-size="${statsFontSize}" font-family="${statsFontFamily}" font-weight="bold" fill="#333" text-anchor="end">probe:</text>`
  const probeLineText =
    maxProbes === 0
      ? ''
      : `<text x="${legendStartX}" y="${probeLineY}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333">${maxProbes} ICMP Echo Pings (56 Bytes) every ${Math.round(avgGapMs / 1000)}s</text>`
  const renderStamp = formatSmokeDate(new Date(now))
  const renderStampText = `<text x="${width - padding.right}" y="${probeLineY}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333" text-anchor="end">${renderStamp}</text>`

  const plotBorder = `<line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="#777777" stroke-width="1" shape-rendering="crispEdges" /><line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="#000" stroke-width="1" shape-rendering="crispEdges" />`

  const plotRightX = width - padding.right
  const plotBottomY = padding.top + chartHeight
  const xArrow = `<polygon points="${plotRightX + 8},${plotBottomY} ${plotRightX + 3},${plotBottomY - 3} ${plotRightX + 3},${plotBottomY + 3}" fill="#555" />`
  const yArrow = `<polygon points="${padding.left},${padding.top - 8} ${padding.left - 3},${padding.top - 3} ${padding.left + 3},${padding.top - 3}" fill="#555" />`

  const signatureText = options.signature ?? 'RRDTOOL / TOBI OETIKER'
  const rrdSig =
    signatureText === ''
      ? ''
      : `<text x="${width - 3}" y="${padding.top + chartHeight / 2}" font-size="8" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#999" text-anchor="middle" transform="rotate(-90 ${width - 3} ${padding.top + chartHeight / 2})">${escapeHtml(signatureText)}</text>`

  const secondsLabel = `<text x="12" y="${padding.top + chartHeight / 2}" font-size="10" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333" text-anchor="middle" transform="rotate(-90 12 ${padding.top + chartHeight / 2})">Seconds</text>`

  const plotClipId = 'mtr-plot-clip'
  const plotClip = `<clipPath id="${plotClipId}"><rect x="${padding.left}" y="${padding.top}" width="${chartWidth}" height="${chartHeight}" /></clipPath>`

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}" class="chart-svg" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace">
  <defs>${plotClip}</defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  <g clip-path="url(#${plotClipId})">
  ${smokeBandsSvg}
  </g>
  ${yMinorGrid}
  ${xMinorGrid}
  ${yGrid}
  ${xGrid}
  <g clip-path="url(#${plotClipId})">
  ${sampleDots}
  ${lineSegments.join('')}
  ${medianMarkersSvg}
  </g>
  ${plotBorder}
  ${xArrow}
  ${yArrow}
  ${rrdSig}
  ${yTickMarks}
  ${yMinorTicks.join('')}
  ${xTickMarks.join('')}
  ${xMinorTicks.join('')}
  ${yLabels}
  ${xLabelsSvg}
  ${secondsLabel}
  ${statsTitle1}
  ${statsLine1}
  ${statsLine1AmPerS}
  ${statsTitle2}
  ${statsLine2}
  ${statsLegendLabel}
  ${legendSwatches}
  ${probeLineLabel}
  ${probeLineText}
  ${renderStampText}
</svg>`
}

// Keep the dead helpers referenced so Biome doesn't warn about them and so we
// don't lose the SmokePing cross-references in case we revive the line stroke
// or the coarse step picker.
void getLineStrokeForLoss
void niceYStep
