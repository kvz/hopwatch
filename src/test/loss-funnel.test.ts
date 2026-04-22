import { describe, expect, test } from 'vitest'
import { renderLossFunnelSvg } from '../lib/loss-funnel-svg.ts'
import type { HopRollupEntry, MtrRollupBucket } from '../lib/rollups.ts'

const NOW = Date.UTC(2026, 3, 20, 12, 0, 0)
const RANGE_MS = 7 * 24 * 60 * 60 * 1000

function mkBucket(
  bucketStart: string,
  hops: (Partial<HopRollupEntry> & {
    host: string
    hopIndexes: number[]
    lossPct: number
    sentCount?: number
    replyCount?: number
  })[],
): MtrRollupBucket {
  return {
    bucketStart,
    destinationLossPct: 0,
    destinationReplyCount: 0,
    destinationSentCount: 0,
    histogram: [],
    hops: hops.map((h) => ({
      host: h.host,
      hopIndexes: h.hopIndexes,
      lossPct: h.lossPct,
      replyCount: h.replyCount ?? 20,
      representativeHopIndex: h.representativeHopIndex ?? h.hopIndexes[0],
      rttAvgMs: null,
      rttMaxMs: null,
      rttMinMs: null,
      rttP50Ms: null,
      rttP90Ms: null,
      rttP99Ms: null,
      sentCount: h.sentCount ?? 20,
      snapshotCount: 1,
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

const OPTIONS = { now: NOW, rangeMs: RANGE_MS, title: 'Funnel', width: 900 }

describe('renderLossFunnelSvg', () => {
  test('renders empty state when no hop data present', () => {
    const svg = renderLossFunnelSvg([], OPTIONS)
    expect(svg).toContain('No per-hop rollup data')
  })

  test('bars are colored by weighted loss percentage', () => {
    const buckets = [
      mkBucket('2026-04-19T11:00:00.000Z', [
        { host: 'healthy', hopIndexes: [1], lossPct: 0, sentCount: 100, replyCount: 100 },
        { host: 'very-lossy', hopIndexes: [2], lossPct: 60, sentCount: 100, replyCount: 40 },
      ]),
    ]
    const svg = renderLossFunnelSvg(buckets, OPTIONS)
    expect(svg).toContain('fill="#26ff00"') // 0%
    expect(svg).toContain('fill="#ff0000"') // 60% → last non-total bucket
  })

  test('weighted loss aggregates sent/reply across multiple buckets', () => {
    const buckets = [
      mkBucket('2026-04-19T10:00:00.000Z', [
        { host: 'router', hopIndexes: [1], lossPct: 0, sentCount: 100, replyCount: 100 },
      ]),
      mkBucket('2026-04-19T11:00:00.000Z', [
        { host: 'router', hopIndexes: [1], lossPct: 80, sentCount: 100, replyCount: 20 },
      ]),
    ]
    const svg = renderLossFunnelSvg(buckets, OPTIONS)
    // Aggregated: 200 sent, 120 reply → 40% loss tooltip.
    expect(svg).toContain('40.0% loss (120/200 replies)')
  })
})
