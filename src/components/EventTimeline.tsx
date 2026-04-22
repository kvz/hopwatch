import type { ReactNode } from 'react'
import { renderEventTimelineSvg } from '../lib/event-timeline-svg.ts'
import type { MtrRollupBucket } from '../lib/rollups.ts'

interface EventTimelineProps {
  buckets: MtrRollupBucket[]
  now: number
  rangeLabel: string
  rangeMs: number
}

export function EventTimeline({
  buckets,
  now,
  rangeLabel,
  rangeMs,
}: EventTimelineProps): ReactNode {
  const title = `Event timeline (${rangeLabel})`
  const svg = renderEventTimelineSvg(buckets, { now, rangeMs, title, width: 900 })
  return (
    <div className="event-timeline-card">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered SVG from trusted rollup data */}
      <span dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="graph-caption">
        Ticks mark noteworthy events per hourly rollup bucket: severe destination loss (≥50%), path
        changes where the set of observed routers shifts, and first-ever sightings of a new hop.
        Hover a tick for details.
      </div>
    </div>
  )
}
