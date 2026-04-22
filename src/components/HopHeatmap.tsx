import type { ReactNode } from 'react'
import { renderHopHeatmapSvg } from '../lib/hop-heatmap-svg.ts'
import type { MtrRollupBucket } from '../lib/rollups.ts'

interface HopHeatmapProps {
  buckets: MtrRollupBucket[]
  now: number
  rangeLabel: string
  rangeMs: number
}

export function HopHeatmap({ buckets, now, rangeLabel, rangeMs }: HopHeatmapProps): ReactNode {
  const title = `Per-hop loss heatmap (${rangeLabel})`
  const svg = renderHopHeatmapSvg(buckets, {
    now,
    rangeMs,
    title,
    width: 900,
  })
  return (
    <div className="hop-heatmap-card">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered SVG from trusted rollup data */}
      <span dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="graph-caption">
        Each row is a router seen in the traceroute path, ordered by average hop index. Each column
        is an hourly rollup bucket; cells are colored by that hop's reply-loss percentage in the
        bucket. Hover a cell for exact loss and RTT figures.
      </div>
    </div>
  )
}
