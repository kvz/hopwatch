import type { ReactNode } from 'react'
import type { ChartDefinition } from '../lib/chart.ts'
import { renderChartSvg } from '../lib/chart-svg.ts'

interface ChartCardProps {
  chart: ChartDefinition
  now: number
  compact?: boolean
  signature?: string
}

// Chart ranges like "Last 360 days" render as mostly-empty canvases on
// freshly-provisioned nodes; showing a near-blank chart implies something's
// broken. Only surface the chart once the data covers ≥10% of the window.
const MIN_COVERAGE_RATIO = 0.1

function hasEnoughCoverage(chart: ChartDefinition): boolean {
  if (chart.points.length < 2) return false
  const timestamps = chart.points.map((p) => p.timestamp)
  const span = Math.max(...timestamps) - Math.min(...timestamps)
  return span >= chart.rangeMs * MIN_COVERAGE_RATIO
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

  if (!hasEnoughCoverage(chart)) {
    return (
      <div className="graph-card graph-card--empty">
        <h3>{chart.label}</h3>
        <p className="graph-empty">
          Not enough history yet - this window will fill in as more {chart.sourceLabel} accumulate.
        </p>
      </div>
    )
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
