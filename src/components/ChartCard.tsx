import type { ReactNode } from 'react'
import type { ChartDefinition } from '../lib/chart.ts'
import { renderChartSvg } from '../lib/chart-svg.ts'

interface ChartCardProps {
  chart: ChartDefinition
  now: number
  compact?: boolean
  signature?: string
}

export function ChartCard({ chart, now, compact = false, signature }: ChartCardProps): ReactNode {
  const width = compact ? 158 : 770
  const height = compact ? 42 : 340
  const { rangeMs } = chart
  const title = `${chart.label} latency and loss`

  if (compact) {
    const svg = renderChartSvg(chart.points, { height, mini: true, now, rangeMs, title, width })
    // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered SVG from trusted chart data
    return <span dangerouslySetInnerHTML={{ __html: svg }} />
  }

  const svg = renderChartSvg(chart.points, { height, now, rangeMs, signature, title, width })
  return (
    <div className="graph-card">
      <h3>{chart.label}</h3>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered SVG from trusted chart data */}
      <span dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="graph-caption">Latency and loss rendered from {chart.sourceLabel}.</div>
    </div>
  )
}
