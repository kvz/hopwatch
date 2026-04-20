import { describe, expect, test } from 'vitest'
import type { ChartPoint } from '../lib/chart.ts'
import { renderChartSvg } from '../lib/chart-svg.ts'

const MINI_WIDTH = 158
const MINI_HEIGHT = 42
const RANGE_MS = 30 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 3, 20, 12, 0, 0)

function healthyPoint(timestamp: number, rtt: number): ChartPoint {
  return {
    destinationLossPct: 0,
    rttAvgMs: rtt,
    rttMaxMs: rtt + 0.4,
    rttMinMs: rtt - 0.1,
    rttP25Ms: rtt - 0.05,
    rttP50Ms: rtt,
    rttP75Ms: rtt + 0.1,
    rttP90Ms: rtt + 0.2,
    rttSamplesMs: [rtt - 0.1, rtt, rtt + 0.1, rtt + 0.2, rtt + 0.4],
    timestamp,
  }
}

function lossyPoint(timestamp: number, lossPct: number, rtt: number): ChartPoint {
  return {
    destinationLossPct: lossPct,
    rttAvgMs: rtt,
    rttMaxMs: rtt + 0.5,
    rttMinMs: rtt - 0.2,
    rttP25Ms: rtt - 0.1,
    rttP50Ms: rtt,
    rttP75Ms: rtt + 0.2,
    rttP90Ms: rtt + 0.3,
    rttSamplesMs: [rtt - 0.2, rtt, rtt + 0.2, rtt + 0.3, rtt + 0.5],
    timestamp,
  }
}

function miniOptions() {
  return {
    height: MINI_HEIGHT,
    mini: true as const,
    now: NOW,
    rangeMs: RANGE_MS,
    title: 'target thumbnail',
    width: MINI_WIDTH,
  }
}

describe('renderChartSvg in mini mode', () => {
  test('skips axis labels, stats, legend, and signature chrome', () => {
    const points = Array.from({ length: 10 }, (_, i) =>
      healthyPoint(NOW - (9 - i) * 3 * 60 * 60 * 1000, 1.5),
    )
    const svg = renderChartSvg(points, miniOptions())

    expect(svg).not.toContain('median rtt:')
    expect(svg).not.toContain('packet loss:')
    expect(svg).not.toContain('loss color:')
    expect(svg).not.toContain('Seconds')
    expect(svg).not.toContain('RRDTOOL')
    expect(svg).not.toContain('am/s')
    // No grid lines (pink dashed major or minor gray)
    expect(svg).not.toContain('stroke="#f3bfbf"')
  })

  test('stays within the mini viewBox', () => {
    const points = Array.from({ length: 10 }, (_, i) =>
      healthyPoint(NOW - (9 - i) * 3 * 60 * 60 * 1000, 1.5),
    )
    const svg = renderChartSvg(points, miniOptions())
    expect(svg).toContain(`viewBox="0 0 ${MINI_WIDTH} ${MINI_HEIGHT}"`)
  })

  test('colors the median marker per loss bucket (not a flat mostly-black line)', () => {
    const points = [
      healthyPoint(NOW - 5 * 60 * 60 * 1000, 1.5),
      lossyPoint(NOW - 3 * 60 * 60 * 1000, 25, 1.8),
      lossyPoint(NOW - 1 * 60 * 60 * 1000, 40, 2.0),
    ]
    const svg = renderChartSvg(points, miniOptions())

    // SmokePing loss bucket colors: 0% → #26ff00, 25% → #ff00ff, 40% → #ff5500.
    // The unified renderer paints a colored 2px median rect per bin, so the
    // mini thumbnail stops looking mostly-black when loss is present.
    expect(svg).toContain('#26ff00')
    expect(svg).toContain('#ff00ff')
    expect(svg).toContain('#ff5500')
  })

  test('100% loss bins leave a gap in mini mode too (no bottom-anchored bar)', () => {
    const points = [
      healthyPoint(NOW - 5 * 60 * 60 * 1000, 1.5),
      {
        destinationLossPct: 100,
        rttAvgMs: null,
        rttMaxMs: null,
        rttMinMs: null,
        rttP25Ms: null,
        rttP50Ms: null,
        rttP75Ms: null,
        rttP90Ms: null,
        rttSamplesMs: null,
        timestamp: NOW - 2 * 60 * 60 * 1000,
      },
    ]
    const svg = renderChartSvg(points, miniOptions())

    // #a00000 = 100% loss bucket color. SmokePing draws no marker without a
    // median — we match that, so the bucket color must not appear.
    expect(svg).not.toContain('#a00000')
  })
})
