import { describe, expect, test } from 'vitest'
import type { ChartPoint } from '../lib/chart.ts'
import { renderChartSvg } from '../lib/chart-svg.ts'

const WIDTH = 697
const HEIGHT = 297
const RANGE_MS = 3 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 3, 20, 12, 0, 0)

function totalLossPoint(timestamp: number): ChartPoint {
  return {
    destinationLossPct: 100,
    rttAvgMs: null,
    rttMaxMs: null,
    rttMinMs: null,
    rttP25Ms: null,
    rttP50Ms: null,
    rttP75Ms: null,
    rttP90Ms: null,
    rttSamplesMs: null,
    timestamp,
  }
}

function nearTotalLossWithTinyMedianPoint(timestamp: number): ChartPoint {
  // 19/20 probes lost, one probe got through quickly. A strict reading of the
  // sample data yields a median near 0 ms — but SmokePing suppresses the dot
  // under near-total loss rather than anchoring a red marker on the baseline.
  return {
    destinationLossPct: 95,
    rttAvgMs: 0.9,
    rttMaxMs: 0.9,
    rttMinMs: 0.9,
    rttP25Ms: 0.9,
    rttP50Ms: 0.9,
    rttP75Ms: 0.9,
    rttP90Ms: 0.9,
    rttSamplesMs: [0.9],
    timestamp,
  }
}

function healthyPoint(timestamp: number): ChartPoint {
  return {
    destinationLossPct: 0,
    rttAvgMs: 1.5,
    rttMaxMs: 1.9,
    rttMinMs: 1.4,
    rttP25Ms: 1.45,
    rttP50Ms: 1.5,
    rttP75Ms: 1.6,
    rttP90Ms: 1.7,
    rttSamplesMs: [1.4, 1.5, 1.6, 1.7, 1.9],
    timestamp,
  }
}

function extractLossBars(svg: string): Array<{
  x: number
  y: number
  width: number
  height: number
  fill: string
  opacity: string | null
}> {
  const pattern =
    /<rect\s+x="(\d+(?:\.\d+)?)"\s+y="(\d+(?:\.\d+)?)"\s+width="(\d+(?:\.\d+)?)"\s+height="(\d+(?:\.\d+)?)"\s+fill="(#[0-9a-fA-F]+)"(?:\s+fill-opacity="([^"]+)")?\s+shape-rendering="crispEdges"\s*\/>/g
  const out: Array<{
    x: number
    y: number
    width: number
    height: number
    fill: string
    opacity: string | null
  }> = []
  for (const match of svg.matchAll(pattern)) {
    out.push({
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
      fill: match[5],
      opacity: match[6] ?? null,
    })
  }
  return out
}

describe('renderChartSvg loss bar', () => {
  test('100% loss bins leave a gap — no median to anchor a marker on, same as SmokePing', () => {
    const points = [totalLossPoint(NOW - 30 * 60 * 1000)]
    const svg = renderChartSvg(points, {
      height: HEIGHT,
      now: NOW,
      rangeMs: RANGE_MS,
      title: 'loss',
      upperLimitMs: 2,
      width: WIDTH,
    })

    const rects = extractLossBars(svg)
    const lossRects = rects.filter((r) => r.fill.toLowerCase() === '#a00000')
    expect(lossRects).toHaveLength(0)

    // And no translucent full-height strip either.
    const translucent = rects.filter((r) => r.opacity != null)
    expect(translucent).toHaveLength(0)
  })

  test('near-total-loss bins (≥95% loss) suppress the median marker so nothing red rides the floor', () => {
    const points = [nearTotalLossWithTinyMedianPoint(NOW - 30 * 60 * 1000)]
    const svg = renderChartSvg(points, {
      height: HEIGHT,
      now: NOW,
      rangeMs: RANGE_MS,
      title: 'near-total-loss',
      upperLimitMs: 2,
      width: WIDTH,
    })

    const rects = extractLossBars(svg)
    // The two loss colors that would otherwise sit on the floor: #ff0000 (19/20
    // lost) and #a00000 (20/20 lost). SmokePing treats near-total-loss bins as
    // gaps rather than anchoring a wide 2px strip at rtt≈0.
    const redMarkers = rects.filter(
      (r) => r.fill.toLowerCase() === '#ff0000' || r.fill.toLowerCase() === '#a00000',
    )
    expect(redMarkers).toHaveLength(0)
  })

  test('healthy bins keep their 2px colored median marker and no bottom loss bar is drawn', () => {
    const points = [healthyPoint(NOW - 30 * 60 * 1000)]
    const svg = renderChartSvg(points, {
      height: HEIGHT,
      now: NOW,
      rangeMs: RANGE_MS,
      title: 'healthy',
      upperLimitMs: 2,
      width: WIDTH,
    })

    const rects = extractLossBars(svg)
    const medianRects = rects.filter((r) => r.height === 2)
    expect(medianRects.length).toBeGreaterThanOrEqual(1)

    // No translucent full-height strip.
    const translucent = rects.filter((r) => r.opacity != null)
    expect(translucent).toHaveLength(0)
  })
})
