import { bucketTimestamp } from './chart.ts'
import { lossColorFor } from './chart-layout.ts'
import { escapeHtml } from './layout.ts'
import type { MtrRollupBucket } from './rollups.ts'

interface FunnelEntry {
  averageHopIndex: number
  host: string
  hopIndexes: Set<number>
  lossPct: number
  replyCount: number
  sentCount: number
}

// Aggregate per-host reply/sent counts across buckets inside the window, then
// derive a weighted loss percentage so a single bad hour doesn't dominate the
// bar. Sort by the average representative hop index so bars read left-to-right
// in traceroute path order.
function collectFunnelEntries(
  buckets: MtrRollupBucket[],
  now: number,
  rangeMs: number,
): FunnelEntry[] {
  const start = now - rangeMs
  const map = new Map<
    string,
    { indexSum: number; indexCount: number; hopIndexes: Set<number>; sent: number; reply: number }
  >()
  for (const bucket of buckets) {
    const tMid = bucketTimestamp(bucket.bucketStart, 'hour')
    if (tMid < start || tMid > now) continue
    for (const hop of bucket.hops) {
      let entry = map.get(hop.host)
      if (entry == null) {
        entry = { indexSum: 0, indexCount: 0, hopIndexes: new Set(), sent: 0, reply: 0 }
        map.set(hop.host, entry)
      }
      entry.indexSum += hop.representativeHopIndex
      entry.indexCount += 1
      entry.sent += hop.sentCount
      entry.reply += hop.replyCount
      for (const idx of hop.hopIndexes) entry.hopIndexes.add(idx)
    }
  }
  return Array.from(map.entries())
    .map(([host, e]) => ({
      averageHopIndex: e.indexCount === 0 ? 0 : e.indexSum / e.indexCount,
      host,
      hopIndexes: e.hopIndexes,
      lossPct: e.sent === 0 ? 0 : ((e.sent - e.reply) / e.sent) * 100,
      replyCount: e.reply,
      sentCount: e.sent,
    }))
    .sort((a, b) => {
      if (a.averageHopIndex !== b.averageHopIndex) return a.averageHopIndex - b.averageHopIndex
      return a.host.localeCompare(b.host)
    })
}

function shortenHost(host: string, maxChars: number): string {
  if (host.length <= maxChars) return host
  return `…${host.slice(host.length - (maxChars - 1))}`
}

export function renderLossFunnelSvg(
  buckets: MtrRollupBucket[],
  options: {
    now: number
    rangeMs: number
    title: string
    width: number
  },
): string {
  const entries = collectFunnelEntries(buckets, options.now, options.rangeMs)
  const width = options.width
  const padding = { bottom: 94, left: 52, right: 16, top: 13 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = 180
  const height = padding.top + chartHeight + padding.bottom

  if (entries.length === 0) {
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}" class="loss-funnel-svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  <text x="${width / 2}" y="${height / 2}" font-size="11" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#666" text-anchor="middle">No per-hop rollup data in this window yet.</text>
</svg>`
  }

  const barGap = 2
  const barWidth = Math.max(
    6,
    Math.floor((chartWidth - barGap * (entries.length - 1)) / entries.length),
  )
  const yOf = (pct: number): number => padding.top + chartHeight - (pct / 100) * chartHeight

  const yTicks = [0, 25, 50, 75, 100]
  const yGrid = yTicks
    .map((pct) => {
      const y = yOf(pct)
      return `<line x1="${padding.left}" y1="${y.toFixed(2)}" x2="${width - padding.right}" y2="${y.toFixed(2)}" stroke="#eeeeee" stroke-width="1" stroke-dasharray="1,2" shape-rendering="crispEdges" />`
    })
    .join('')
  const yLabels = yTicks
    .map((pct) => {
      const y = yOf(pct)
      return `<text x="${padding.left - 5}" y="${(y + 3).toFixed(2)}" font-size="10" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333" text-anchor="end">${pct}%</text>`
    })
    .join('')

  const bars: string[] = []
  const xLabels: string[] = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    const x = padding.left + i * (barWidth + barGap)
    const barY = yOf(entry.lossPct)
    const barH = Math.max(1, padding.top + chartHeight - barY)
    const color = lossColorFor(entry.lossPct)
    const tooltip = `${entry.host} • hop ${[...entry.hopIndexes].sort((a, b) => a - b).join(',')} • ${entry.lossPct.toFixed(1)}% loss (${entry.replyCount}/${entry.sentCount} replies)`
    bars.push(
      `<rect x="${x}" y="${barY.toFixed(2)}" width="${barWidth}" height="${barH.toFixed(2)}" fill="${color}" stroke="#333" stroke-width="0.5" shape-rendering="crispEdges"><title>${escapeHtml(tooltip)}</title></rect>`,
    )
    const labelX = x + barWidth / 2
    const labelY = padding.top + chartHeight + 12
    const shortened = shortenHost(entry.host, 22)
    xLabels.push(
      `<text x="${labelX.toFixed(2)}" y="${labelY}" font-size="9" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333" text-anchor="end" transform="rotate(-45 ${labelX.toFixed(2)} ${labelY})">${escapeHtml(shortened)}</text>`,
    )
  }

  const yAxisLine = `<line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="#777" stroke-width="1" shape-rendering="crispEdges" />`
  const xAxisLine = `<line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="#000" stroke-width="1" shape-rendering="crispEdges" />`

  const yAxisTitle = `<text x="16" y="${padding.top + chartHeight / 2}" font-size="10" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333" text-anchor="middle" transform="rotate(-90 16 ${padding.top + chartHeight / 2})">Loss %</text>`

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}" class="loss-funnel-svg" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  ${yGrid}
  ${bars.join('')}
  ${yAxisLine}
  ${xAxisLine}
  ${yLabels}
  ${xLabels.join('')}
  ${yAxisTitle}
</svg>`
}
