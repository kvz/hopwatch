import { describe, expect, test } from 'vitest'
import type { ChartPoint } from '../lib/chart.ts'
import {
  computeChartStats,
  computeLeftEdgeMsByTimestamp,
  formatYLabel,
  lossColorFor,
  pickXGridStepMs,
  pickYScale,
  SMOKEPING_LOSS_BUCKETS,
} from '../lib/chart-layout.ts'

function point(partial: Partial<ChartPoint> & { timestamp: number }): ChartPoint {
  return {
    destinationLossPct: null,
    rttAvgMs: null,
    rttMaxMs: null,
    rttMinMs: null,
    rttP25Ms: null,
    rttP50Ms: null,
    rttP75Ms: null,
    rttP90Ms: null,
    rttSamplesMs: null,
    ...partial,
  }
}

describe('pickYScale', () => {
  test('keeps yMax under ~15 intervals for known reference cases', () => {
    expect(pickYScale(2.112).step).toBeLessThanOrEqual(0.2)
    expect(pickYScale(239.57).step).toBeLessThanOrEqual(20)
  })

  test('coerces tiny upper bounds up to a safe floor', () => {
    const scale = pickYScale(0)
    expect(scale.step).toBeGreaterThan(0)
    expect(scale.yMax).toBeGreaterThan(0)
  })
})

describe('lossColorFor', () => {
  test('returns the brightest green for zero loss', () => {
    expect(lossColorFor(0)).toBe(SMOKEPING_LOSS_BUCKETS[0].color)
  })

  test('returns the darkest red for total loss', () => {
    expect(lossColorFor(100)).toBe(SMOKEPING_LOSS_BUCKETS[SMOKEPING_LOSS_BUCKETS.length - 1].color)
  })

  test('treats null/NaN as healthy', () => {
    expect(lossColorFor(null)).toBe(SMOKEPING_LOSS_BUCKETS[0].color)
    expect(lossColorFor(Number.NaN)).toBe(SMOKEPING_LOSS_BUCKETS[0].color)
  })

  test('picks mid bucket for intermediate loss', () => {
    const bucket = SMOKEPING_LOSS_BUCKETS.find((b) => b.legendLabel === '4-5')
    expect(lossColorFor(20)).toBe(bucket?.color)
  })
})

describe('computeLeftEdgeMsByTimestamp', () => {
  test('clamps each bar to the previous sample timestamp when clusters tighten', () => {
    const barHalfMs = 300_000
    const points = [
      point({ timestamp: 1_000_000 }),
      point({ timestamp: 1_050_000 }),
      point({ timestamp: 2_000_000 }),
    ]
    const map = computeLeftEdgeMsByTimestamp(points, barHalfMs)
    expect(map.get(1_000_000)).toBe(1_000_000 - 2 * barHalfMs)
    expect(map.get(1_050_000)).toBe(1_000_000)
    expect(map.get(2_000_000)).toBe(2_000_000 - 2 * barHalfMs)
  })
})

describe('pickXGridStepMs', () => {
  test.each([
    [3 * 60 * 60 * 1000, 20 * 60 * 1000],
    [30 * 60 * 60 * 1000, 4 * 60 * 60 * 1000],
    [10 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000],
    [360 * 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000],
  ])('window %i → step %i', (rangeMs, expected) => {
    expect(pickXGridStepMs(rangeMs)).toBe(expected)
  })
})

describe('computeChartStats', () => {
  test('returns n/a strings when all samples are missing', () => {
    const stats = computeChartStats([point({ timestamp: 0 })])
    expect(stats.rttAvg).toBe('n/a')
    expect(stats.lossAvg).toBe('n/a')
    expect(stats.rttAmPerS).toBe('-nan')
  })

  test('uses median values for avg/max/min/now when present', () => {
    const stats = computeChartStats([
      point({ timestamp: 1, rttP50Ms: 10, destinationLossPct: 0 }),
      point({ timestamp: 2, rttP50Ms: 20, destinationLossPct: 5 }),
      point({ timestamp: 3, rttP50Ms: 30, destinationLossPct: 10 }),
    ])
    expect(stats.rttMin).toBe('10.0')
    expect(stats.rttMax).toBe('30.0')
    expect(stats.rttNow).toBe('30.0')
    expect(stats.lossMax).toBe('10.00')
  })

  test('falls back to rttAvgMs when no median samples are available', () => {
    const stats = computeChartStats([
      point({ timestamp: 1, rttAvgMs: 50 }),
      point({ timestamp: 2, rttAvgMs: 100 }),
    ])
    expect(stats.rttAvg).toBe('75.0')
  })
})

describe('formatYLabel', () => {
  test.each([
    [0, '0.0'],
    [5.5, '5.5 m'],
    [50, '50 m'],
    [1500, '1.5'],
  ])('formats %i as %s', (ms, label) => {
    expect(formatYLabel(ms)).toBe(label)
  })
})
