import { describe, expect, test } from 'vitest'
import { renderHopHeatmapSvg } from '../lib/hop-heatmap-svg.ts'
import type { HopRollupEntry, MtrRollupBucket } from '../lib/rollups.ts'

const NOW = Date.UTC(2026, 3, 20, 12, 0, 0)
const RANGE_MS = 30 * 60 * 60 * 1000

function mkBucket(
  bucketStart: string,
  hops: (Partial<HopRollupEntry> & { host: string; hopIndexes: number[]; lossPct: number })[],
): MtrRollupBucket {
  return {
    bucketStart,
    destinationLossPct: 0,
    destinationReplyCount: 20,
    destinationSentCount: 20,
    histogram: [],
    hops: hops.map((h) => ({
      host: h.host,
      hopIndexes: h.hopIndexes,
      lossPct: h.lossPct,
      replyCount: h.replyCount ?? 20,
      representativeHopIndex: h.representativeHopIndex ?? h.hopIndexes[0],
      rttAvgMs: h.rttAvgMs ?? null,
      rttMaxMs: h.rttMaxMs ?? null,
      rttMinMs: h.rttMinMs ?? null,
      rttP50Ms: h.rttP50Ms ?? null,
      rttP90Ms: h.rttP90Ms ?? null,
      rttP99Ms: h.rttP99Ms ?? null,
      sentCount: h.sentCount ?? 20,
      snapshotCount: h.snapshotCount ?? 1,
    })),
    rttAvgMs: null,
    rttMaxMs: null,
    rttMinMs: null,
    rttP50Ms: null,
    rttP90Ms: null,
    rttP99Ms: null,
    snapshotCount: 1,
  }
}

function options() {
  return { now: NOW, rangeMs: RANGE_MS, title: 'Heatmap', width: 900 }
}

describe('renderHopHeatmapSvg', () => {
  test('renders a row per unique host sorted by representative hop index', () => {
    const buckets = [
      mkBucket('2026-04-19T10:00:00.000Z', [
        { host: 'router-a', hopIndexes: [1], lossPct: 0 },
        { host: 'dest.example.com', hopIndexes: [5], lossPct: 10 },
      ]),
      mkBucket('2026-04-19T11:00:00.000Z', [
        { host: 'router-b', hopIndexes: [3], lossPct: 0 },
        { host: 'dest.example.com', hopIndexes: [5], lossPct: 0 },
      ]),
    ]
    const svg = renderHopHeatmapSvg(buckets, options())
    // Row labels use a distinctive `>HOST <tspan` shape; cell <title> tooltips
    // contain hosts too, so indexing on the plain name would match those first.
    const aIdx = svg.indexOf('>router-a <tspan')
    const bIdx = svg.indexOf('>router-b <tspan')
    const dIdx = svg.indexOf('>dest.example.com <tspan')
    expect(aIdx).toBeGreaterThan(-1)
    expect(bIdx).toBeGreaterThan(aIdx)
    expect(dIdx).toBeGreaterThan(bIdx)
  })

  test('renders empty-state message when no buckets in window carry hops', () => {
    const svg = renderHopHeatmapSvg([], options())
    expect(svg).toContain('No per-hop rollup data')
  })

  test('colors lossy cells differently from healthy cells', () => {
    const buckets = [
      mkBucket('2026-04-19T11:00:00.000Z', [
        { host: 'healthy.example', hopIndexes: [1], lossPct: 0 },
        { host: 'lossy.example', hopIndexes: [2], lossPct: 60 },
      ]),
    ]
    const svg = renderHopHeatmapSvg(buckets, options())
    // 0% → first bucket color (green). 60% → bucket whose upper is 99.99 (#ff0000).
    expect(svg).toContain('fill="#26ff00"')
    expect(svg).toContain('fill="#ff0000"')
  })

  test('ECMP: multiple hopIndexes for same host collapse into one row with range label', () => {
    const buckets = [
      mkBucket('2026-04-19T11:00:00.000Z', [
        { host: 'ecmp.example', hopIndexes: [5, 6], representativeHopIndex: 5, lossPct: 0 },
      ]),
    ]
    const svg = renderHopHeatmapSvg(buckets, options())
    expect(svg).toContain('ecmp.example')
    expect(svg).toContain('[5–6]')
  })

  test('drops buckets outside the requested time window', () => {
    const buckets = [
      // 48h before NOW - outside the 30h window.
      mkBucket('2026-04-18T12:00:00.000Z', [
        { host: 'stale.example', hopIndexes: [1], lossPct: 0 },
      ]),
      mkBucket('2026-04-19T11:00:00.000Z', [
        { host: 'fresh.example', hopIndexes: [1], lossPct: 0 },
      ]),
    ]
    const svg = renderHopHeatmapSvg(buckets, options())
    expect(svg).not.toContain('stale.example')
    expect(svg).toContain('fresh.example')
  })

  test('v1 buckets with empty hops[] render the empty-state message', () => {
    const buckets = [
      mkBucket('2026-04-19T11:00:00.000Z', []),
      mkBucket('2026-04-19T10:00:00.000Z', []),
    ]
    const svg = renderHopHeatmapSvg(buckets, options())
    expect(svg).toContain('No per-hop rollup data')
  })
})
