import type { ChartPoint } from './chart.ts'
import {
  buildLossLegendLabels,
  computeChartStats,
  computeLeftEdgeMsByTimestamp,
  formatSmokeDate,
  formatXLabel,
  formatYLabel,
  lossColorFor,
  pickXGridStepMs,
  pickYScale,
} from './chart-layout.ts'
import { escapeHtml } from './layout.ts'
import { quantile } from './raw.ts'

export function renderChartSvg(
  points: ChartPoint[],
  options: {
    height: number
    // Thumbnail mode: strips axes, grid, legend, stats, signature, arrows, and
    // tick labels. Same smoke bands + loss-colored median markers as the full
    // chart, just at a smaller scale suitable for target-list thumbnails.
    mini?: boolean
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
  const mini = options.mini === true
  const padding = mini
    ? { bottom: 1, left: 1, right: 1, top: 1 }
    : { bottom: 82, left: 66, right: 31, top: 13 }
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
  const leftEdgeMsFor = computeLeftEdgeMsByTimestamp(sortedByTime, barHalfMs)

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
        // rttSamplesMs is pre-sorted in getPointsFromSnapshots (src/lib/chart.ts)
        // so each smoke band can read quantiles without re-sorting.
        const qLo = (ibot - 1) / (pingSlots - 1)
        const qHi = (itop - 1) / (pingSlots - 1)
        lower = quantile(point.rttSamplesMs, qLo)
        upper = quantile(point.rttSamplesMs, qHi)
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
  // = #323232, outermost (ibot=1) = #DDDDDD. We derive `smokePings` from the
  // actual sample count instead of hardcoding 20 so a config with
  // `probe.packets != 20` still renders coherent bands and a coherent legend.
  // Round down to an even number (half must be an integer); default to 20 for
  // point-less mini charts so the fallback shape is recognizable.
  const maxProbes = Math.max(
    0,
    ...points.map((p) => (p.rttSamplesMs == null ? 0 : p.rttSamplesMs.length)),
  )
  const smokePings = maxProbes >= 2 ? maxProbes - (maxProbes % 2) : 20
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
  // matching the sample's loss bucket.
  const medianMarkers: string[] = []
  const plotLeftMarker = padding.left
  const plotRightMarker = width - padding.right
  for (const point of points) {
    const leftMs = leftEdgeMsFor.get(point.timestamp) ?? point.timestamp - 2 * barHalfMs
    const xLeftRaw = Math.max(plotLeftMarker, Math.min(plotRightMarker, xOf(leftMs)))
    const xRightRaw = Math.max(plotLeftMarker, Math.min(plotRightMarker, xOf(point.timestamp)))
    const xLeft = Math.round(xLeftRaw)
    const xRight = Math.round(xRightRaw)
    const w = xRight - xLeft
    if (w <= 0) continue

    const medianMs = point.rttP50Ms ?? point.rttAvgMs
    const lossPct = point.destinationLossPct
    // Under near-total loss (≥95%, i.e. 19/20+ probes dropped) any surviving
    // median is a one- or two-sample artefact. Anchoring a 2px-wide strip at
    // that value — in our widest loss colour, no less — gives the chart a
    // long red line on the baseline that SmokePing deliberately avoids. Match
    // SmokePing's behaviour: treat those bins as gaps, not as dots at rtt≈0.
    const nearTotalLoss = lossPct != null && lossPct >= 95
    if (!nearTotalLoss && medianMs != null && Number.isFinite(medianMs) && medianMs <= yMaxMs) {
      const yMid = Math.round(yOf(medianMs))
      const color = lossColorFor(lossPct)
      medianMarkers.push(
        `<rect x="${xLeft}" y="${yMid - 1}" width="${w}" height="2" fill="${color}" shape-rendering="crispEdges" />`,
      )
    }
  }
  const medianMarkersSvg = medianMarkers.join('')

  if (mini) {
    // No axes, grid, ticks, legend, stats, signature or arrows — just the
    // white rect, smoke bands, loss-colored medians, and a thin outline so
    // the thumbnail can read "is this target healthy" at a glance.
    const miniBorder = `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#d9ddcf" stroke-width="1" shape-rendering="crispEdges" />`
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}" class="chart-svg chart-svg--mini">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  ${smokeBandsSvg}
  ${medianMarkersSvg}
  ${miniBorder}
</svg>`
  }

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

  const xGridStepMs = pickXGridStepMs(options.rangeMs)
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

  const stats = computeChartStats(points)

  const statsFontSize = 10
  const statsFontFamily = 'DejaVu Sans Mono,Menlo,Consolas,monospace'
  const lossSwatches = buildLossLegendLabels(maxProbes >= 1 ? maxProbes : 20)
  const legendY = padding.top + chartHeight + 58
  const legendStartX = padding.left + 84
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
    [stats.rttAvg, stats.rttMax, stats.rttMin, stats.rttNow, stats.rttSd],
    'ms',
    ['avg', 'max', 'min', 'now', 'sd'],
    statsLine1Y,
  )
  const amPerSNumRightX = padding.left + 476
  const amPerSUnitX = padding.left + 514
  const statsLine1AmPerS = `<text x="${amPerSNumRightX}" y="${statsLine1Y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333" text-anchor="end">${stats.rttAmPerS}</text><text x="${amPerSUnitX}" y="${statsLine1Y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333">am/s</text>`
  const statsTitle2 = `<text x="${statsLabelRightX}" y="${statsLine2Y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" font-weight="bold" fill="#333" text-anchor="end">packet loss:</text>`
  const statsLine2 = mkStatsCols(
    [stats.lossAvg, stats.lossMax, stats.lossMin, stats.lossNow],
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
