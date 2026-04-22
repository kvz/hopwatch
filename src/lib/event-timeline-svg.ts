import { bucketTimestamp } from './chart.ts'
import { formatXLabel, pickXGridStepMs } from './chart-layout.ts'
import { escapeHtml } from './layout.ts'
import type { MtrRollupBucket } from './rollups.ts'

type EventKind = 'severe-loss' | 'path-change' | 'new-hop'

interface TimelineEvent {
  description: string
  kind: EventKind
  timestamp: number
}

const EVENT_STYLES: Record<EventKind, { color: string; label: string }> = {
  'severe-loss': { color: '#ff0000', label: 'Severe destination loss (≥50%)' },
  'path-change': { color: '#7e00ff', label: 'Path change (host set shifted)' },
  'new-hop': { color: '#ff5500', label: 'New hop appeared' },
}

function buildHostSet(bucket: MtrRollupBucket): Set<string> {
  const set = new Set<string>()
  for (const hop of bucket.hops) set.add(hop.host)
  return set
}

function collectEvents(buckets: MtrRollupBucket[], now: number, rangeMs: number): TimelineEvent[] {
  const start = now - rangeMs
  const sorted = buckets.slice().sort((a, b) => a.bucketStart.localeCompare(b.bucketStart))
  const events: TimelineEvent[] = []
  const seenHosts = new Set<string>()
  let prevHostSet: Set<string> | null = null

  for (const bucket of sorted) {
    const tMid = bucketTimestamp(bucket.bucketStart, 'hour')
    const hostSet = buildHostSet(bucket)
    const withinWindow = tMid >= start && tMid <= now

    if (withinWindow && bucket.destinationLossPct >= 50) {
      events.push({
        description: `Destination loss ${bucket.destinationLossPct.toFixed(0)}% at ${bucket.bucketStart}`,
        kind: 'severe-loss',
        timestamp: tMid,
      })
    }

    if (withinWindow && prevHostSet != null) {
      const prev = prevHostSet
      const added = [...hostSet].filter((h) => !prev.has(h))
      const removed = [...prev].filter((h) => !hostSet.has(h))
      // Only flag a path change when the symmetric difference is non-trivial —
      // a single ECMP flip adds and removes one host, so require at least one
      // host on either side (i.e. the set actually moved).
      if (added.length > 0 || removed.length > 0) {
        const parts: string[] = []
        if (added.length > 0) parts.push(`+${added.slice(0, 2).join(', ')}`)
        if (removed.length > 0) parts.push(`-${removed.slice(0, 2).join(', ')}`)
        events.push({
          description: `Path change ${parts.join(' ')}`,
          kind: 'path-change',
          timestamp: tMid,
        })
      }
    }

    if (withinWindow) {
      for (const host of hostSet) {
        if (!seenHosts.has(host) && prevHostSet != null && !prevHostSet.has(host)) {
          events.push({
            description: `New hop ${host}`,
            kind: 'new-hop',
            timestamp: tMid,
          })
        }
      }
    }
    for (const host of hostSet) seenHosts.add(host)
    prevHostSet = hostSet
  }
  return events.sort((a, b) => a.timestamp - b.timestamp)
}

export function renderEventTimelineSvg(
  buckets: MtrRollupBucket[],
  options: {
    now: number
    rangeMs: number
    title: string
    width: number
  },
): string {
  const events = collectEvents(buckets, options.now, options.rangeMs)
  const width = options.width
  const height = 120
  const padding = { bottom: 30, left: 12, right: 12, top: 13 }
  const chartWidth = width - padding.left - padding.right
  const rowCount = 3
  const rowHeight = (height - padding.top - padding.bottom) / rowCount
  const start = options.now - options.rangeMs
  const xOf = (timestamp: number): number =>
    padding.left + ((timestamp - start) / options.rangeMs) * chartWidth

  const rowYFor: Record<EventKind, number> = {
    'severe-loss': padding.top + rowHeight * 0.5,
    'path-change': padding.top + rowHeight * 1.5,
    'new-hop': padding.top + rowHeight * 2.5,
  }

  const xGridStepMs = pickXGridStepMs(options.rangeMs)
  const xGridFirst = Math.ceil(start / xGridStepMs) * xGridStepMs
  const xGridLines: string[] = []
  const xTickMarks: string[] = []
  const xLabels: string[] = []
  const plotBottomY = padding.top + rowCount * rowHeight
  for (let gridT = xGridFirst; gridT <= options.now; gridT += xGridStepMs) {
    const x = xOf(gridT)
    xGridLines.push(
      `<line x1="${x.toFixed(2)}" y1="${padding.top}" x2="${x.toFixed(2)}" y2="${plotBottomY}" stroke="#eeeeee" stroke-width="1" stroke-dasharray="1,2" shape-rendering="crispEdges" />`,
    )
    xTickMarks.push(
      `<line x1="${x.toFixed(2)}" y1="${plotBottomY}" x2="${x.toFixed(2)}" y2="${(plotBottomY + 3).toFixed(2)}" stroke="#333" stroke-width="0.8" />`,
    )
    xLabels.push(
      `<text x="${x.toFixed(2)}" y="${(plotBottomY + 13).toFixed(2)}" font-size="10" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333" text-anchor="middle">${formatXLabel(gridT, xGridStepMs)}</text>`,
    )
  }

  const rowLabels = (
    Object.entries(EVENT_STYLES) as [EventKind, { color: string; label: string }][]
  )
    .map(([kind, style]) => {
      const y = rowYFor[kind]
      return `<line x1="${padding.left}" y1="${y.toFixed(2)}" x2="${width - padding.right}" y2="${y.toFixed(2)}" stroke="${style.color}" stroke-width="0.3" stroke-dasharray="2,3" opacity="0.4" shape-rendering="crispEdges" /><text x="${padding.left + 4}" y="${(y - 4).toFixed(2)}" font-size="9" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="${style.color}">${style.label}</text>`
    })
    .join('')

  const ticks = events
    .map((event) => {
      const x = xOf(event.timestamp)
      if (x < padding.left || x > width - padding.right) return ''
      const y = rowYFor[event.kind]
      const style = EVENT_STYLES[event.kind]
      return `<line x1="${x.toFixed(2)}" y1="${(y - 6).toFixed(2)}" x2="${x.toFixed(2)}" y2="${(y + 6).toFixed(2)}" stroke="${style.color}" stroke-width="2"><title>${escapeHtml(event.description)}</title></line>`
    })
    .join('')

  const plotBorder = `<rect x="${padding.left}" y="${padding.top}" width="${chartWidth}" height="${rowCount * rowHeight}" fill="none" stroke="#d9ddcf" stroke-width="1" shape-rendering="crispEdges" />`

  const emptyLabel =
    events.length === 0
      ? `<text x="${width / 2}" y="${padding.top + (rowCount * rowHeight) / 2}" font-size="11" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#666" text-anchor="middle">No notable events in this window.</text>`
      : ''

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}" class="event-timeline-svg" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  ${xGridLines.join('')}
  ${rowLabels}
  ${ticks}
  ${plotBorder}
  ${xTickMarks.join('')}
  ${xLabels.join('')}
  ${emptyLabel}
</svg>`
}
