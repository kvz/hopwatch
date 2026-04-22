import type { ReactNode } from 'react'
import { renderLossFunnelSvg } from '../lib/loss-funnel-svg.ts'
import type { MtrRollupBucket } from '../lib/rollups.ts'

interface LossFunnelProps {
  buckets: MtrRollupBucket[]
  now: number
  rangeLabel: string
  rangeMs: number
}

export function LossFunnel({ buckets, now, rangeLabel, rangeMs }: LossFunnelProps): ReactNode {
  const title = `Loss funnel (${rangeLabel})`
  const svg = renderLossFunnelSvg(buckets, { now, rangeMs, title, width: 900 })
  return (
    <div className="loss-funnel-card">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered SVG from trusted rollup data */}
      <span dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="graph-caption">
        Weighted average loss per router in traceroute path order. Intermediate bars are often ICMP
        rate-limiting rather than real loss; the final bar(s) represent the destination and are the
        truest measure of end-to-end reachability. Look for the first sharp rise to identify where
        loss starts accumulating.
      </div>
    </div>
  )
}
