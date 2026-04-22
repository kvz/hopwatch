import { bucketTimestamp } from './chart.ts'
import {
  formatXLabel,
  lossColorFor,
  pickXGridStepMs,
  SMOKEPING_LOSS_BUCKETS,
} from './chart-layout.ts'
import { escapeHtml } from './layout.ts'
import type { HopRollupEntry, MtrRollupBucket } from './rollups.ts'

interface HeatmapHost {
  averageHopIndex: number
  host: string
  hopIndexes: Set<number>
}

function collectHeatmapHosts(buckets: MtrRollupBucket[]): HeatmapHost[] {
  const map = new Map<string, { indexSum: number; indexCount: number; hopIndexes: Set<number> }>()
  for (const bucket of buckets) {
    for (const hop of bucket.hops) {
      let entry = map.get(hop.host)
      if (entry == null) {
        entry = { indexSum: 0, indexCount: 0, hopIndexes: new Set() }
        map.set(hop.host, entry)
      }
      entry.indexSum += hop.representativeHopIndex
      entry.indexCount += 1
      for (const idx of hop.hopIndexes) entry.hopIndexes.add(idx)
    }
  }
  return Array.from(map.entries())
    .map(([host, e]) => ({
      averageHopIndex: e.indexCount === 0 ? 0 : e.indexSum / e.indexCount,
      host,
      hopIndexes: e.hopIndexes,
    }))
    .sort((a, b) => {
      if (a.averageHopIndex !== b.averageHopIndex) return a.averageHopIndex - b.averageHopIndex
      return a.host.localeCompare(b.host)
    })
}

// Truncate long hostnames from the front so the most specific label (usually
// the router hostname) stays visible; e.g. "ae-14.r1.lon1.edge.example.com"
// becomes "…r1.lon1.edge.example.com" when the label cell is narrow.
function shortenHost(host: string, maxChars: number): string {
  if (host.length <= maxChars) return host
  return `…${host.slice(host.length - (maxChars - 1))}`
}

function formatHopIndexRange(indexes: Set<number>): string {
  if (indexes.size === 0) return ''
  if (indexes.size === 1) return `[${[...indexes][0]}]`
  const sorted = [...indexes].sort((a, b) => a - b)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (sorted.length === 2 || last - first + 1 === sorted.length) {
    return `[${first}–${last}]`
  }
  return `[${sorted.join(',')}]`
}

export function renderHopHeatmapSvg(
  buckets: MtrRollupBucket[],
  options: {
    now: number
    rangeMs: number
    title: string
    width: number
  },
): string {
  const width = options.width
  const now = options.now
  const start = now - options.rangeMs

  const windowBuckets = buckets.filter((bucket) => {
    const tMid = bucketTimestamp(bucket.bucketStart, 'hour')
    return tMid >= start && tMid <= now
  })
  const hosts = collectHeatmapHosts(windowBuckets)

  const rowHeight = 14
  const padding = { bottom: 42, left: 210, right: 16, top: 13 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = Math.max(rowHeight, hosts.length * rowHeight)
  const height = padding.top + chartHeight + padding.bottom

  const xOf = (timestamp: number): number =>
    padding.left + ((timestamp - start) / options.rangeMs) * chartWidth

  if (hosts.length === 0) {
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}" class="hop-heatmap-svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  <text x="${width / 2}" y="${height / 2}" font-size="11" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#666" text-anchor="middle">No per-hop rollup data in this window yet.</text>
</svg>`
  }

  const hostIndexMap = new Map<string, number>()
  for (let i = 0; i < hosts.length; i += 1) {
    hostIndexMap.set(hosts[i].host, i)
  }

  const halfHourMs = 30 * 60 * 1000
  const plotLeft = padding.left
  const plotRight = width - padding.right

  const cellRects: string[] = []
  for (const bucket of windowBuckets) {
    const tMid = bucketTimestamp(bucket.bucketStart, 'hour')
    const x1Raw = xOf(tMid - halfHourMs)
    const x2Raw = xOf(tMid + halfHourMs)
    const x1 = Math.round(Math.max(plotLeft, Math.min(plotRight, x1Raw)))
    const x2 = Math.round(Math.max(plotLeft, Math.min(plotRight, x2Raw)))
    const cellW = Math.max(1, x2 - x1)
    for (const hopEntry of bucket.hops) {
      const rowIndex = hostIndexMap.get(hopEntry.host)
      if (rowIndex == null) continue
      const y = padding.top + rowIndex * rowHeight
      const color = lossColorFor(hopEntry.lossPct)
      const titleText = buildCellTitle(bucket.bucketStart, hopEntry)
      cellRects.push(
        `<rect x="${x1}" y="${y}" width="${cellW}" height="${rowHeight - 1}" fill="${color}" shape-rendering="crispEdges"><title>${escapeHtml(titleText)}</title></rect>`,
      )
    }
  }

  // Fill the entire plot area with the "no data" color so any (host × bucket)
  // cell that lacks a rollup entry reads as a distinct neutral gray. Colored
  // cells render on top, so real data never gets hidden.
  const noDataBackground = `<rect x="${padding.left}" y="${padding.top}" width="${chartWidth}" height="${chartHeight}" fill="#eeeeee" shape-rendering="crispEdges" />`

  const rowLabels: string[] = []
  for (let i = 0; i < hosts.length; i += 1) {
    const y = padding.top + i * rowHeight
    const label = shortenHost(hosts[i].host, 28)
    const hopRange = formatHopIndexRange(hosts[i].hopIndexes)
    rowLabels.push(
      `<text x="${padding.left - 8}" y="${y + rowHeight - 4}" font-size="10" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333" text-anchor="end">${escapeHtml(label)} <tspan fill="#888">${escapeHtml(hopRange)}</tspan></text>`,
    )
  }

  const xGridStepMs = pickXGridStepMs(options.rangeMs)
  const xGridFirst = Math.ceil(start / xGridStepMs) * xGridStepMs
  const xTickMarks: string[] = []
  const xLabels: string[] = []
  const xGridLines: string[] = []
  const plotBottomY = padding.top + chartHeight
  for (let gridT = xGridFirst; gridT <= now; gridT += xGridStepMs) {
    const x = xOf(gridT)
    xGridLines.push(
      `<line x1="${x.toFixed(2)}" y1="${padding.top}" x2="${x.toFixed(2)}" y2="${plotBottomY}" stroke="#dddddd" stroke-width="1" stroke-dasharray="1,2" shape-rendering="crispEdges" />`,
    )
    xTickMarks.push(
      `<line x1="${x.toFixed(2)}" y1="${plotBottomY}" x2="${x.toFixed(2)}" y2="${(plotBottomY + 3).toFixed(2)}" stroke="#333" stroke-width="0.8" />`,
    )
    xLabels.push(
      `<text x="${x.toFixed(2)}" y="${(plotBottomY + 13).toFixed(2)}" font-size="10" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333" text-anchor="middle">${formatXLabel(gridT, xGridStepMs)}</text>`,
    )
  }

  const plotBorder = `<rect x="${padding.left}" y="${padding.top}" width="${chartWidth}" height="${chartHeight}" fill="none" stroke="#777777" stroke-width="1" shape-rendering="crispEdges" />`

  const legendY = plotBottomY + 30
  const legendEntries = SMOKEPING_LOSS_BUCKETS
  const legendSwatchWidth = 12
  const legendLabelGap = 4
  const legendEntryWidth = 52
  const legendStartX = padding.left
  const legendSvg = legendEntries
    .map((entry, index) => {
      const x = legendStartX + index * legendEntryWidth
      const label =
        entry.maxLossPct === 0 ? '0%' : entry.maxLossPct >= 100 ? '100%' : `≤${entry.maxLossPct}%`
      return `<rect x="${x}" y="${legendY - 9}" width="${legendSwatchWidth}" height="10" fill="${entry.color}" shape-rendering="crispEdges" /><text x="${x + legendSwatchWidth + legendLabelGap}" y="${legendY - 1}" font-size="9" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333">${label}</text>`
    })
    .join('')
  const noDataSwatchX = legendStartX + legendEntries.length * legendEntryWidth + 12
  const noDataSwatch = `<rect x="${noDataSwatchX}" y="${legendY - 9}" width="${legendSwatchWidth}" height="10" fill="#eeeeee" shape-rendering="crispEdges" /><text x="${noDataSwatchX + legendSwatchWidth + legendLabelGap}" y="${legendY - 1}" font-size="9" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333">no data</text>`
  const legendLabel = `<text x="${padding.left - 8}" y="${legendY - 1}" font-size="10" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" font-weight="bold" fill="#333" text-anchor="end">loss:</text>`

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}" class="hop-heatmap-svg" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  ${noDataBackground}
  ${xGridLines.join('')}
  ${cellRects.join('')}
  ${plotBorder}
  ${rowLabels.join('')}
  ${xTickMarks.join('')}
  ${xLabels.join('')}
  ${legendLabel}
  ${legendSvg}
  ${noDataSwatch}
</svg>`
}

function buildCellTitle(bucketStart: string, hop: HopRollupEntry): string {
  const hopIndex = formatHopIndexRange(new Set(hop.hopIndexes))
  const loss = `${hop.lossPct.toFixed(1)}% loss`
  const rtt = hop.rttP50Ms == null ? 'no RTT' : `p50 ${hop.rttP50Ms.toFixed(1)}ms`
  return `${bucketStart} • ${hop.host} ${hopIndex} • ${loss} • ${rtt} • ${hop.replyCount}/${hop.sentCount}`
}
