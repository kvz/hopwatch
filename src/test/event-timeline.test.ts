import { describe, expect, test } from 'vitest'
import { renderEventTimelineSvg } from '../lib/event-timeline-svg.ts'
import type { HopRollupEntry, MtrRollupBucket } from '../lib/rollups.ts'

const NOW = Date.UTC(2026, 3, 20, 12, 0, 0)
const RANGE_MS = 10 * 24 * 60 * 60 * 1000

function mkBucket(
  bucketStart: string,
  destinationLossPct: number,
  hops: { host: string; hopIndexes: number[]; lossPct: number }[],
): MtrRollupBucket {
  return {
    bucketStart,
    destinationLossPct,
    destinationReplyCount: 20,
    destinationSentCount: 20,
    histogram: [],
    hops: hops.map(
      (h): HopRollupEntry => ({
        host: h.host,
        hopIndexes: h.hopIndexes,
        lossPct: h.lossPct,
        replyCount: 20,
        representativeHopIndex: h.hopIndexes[0],
        rttAvgMs: null,
        rttMaxMs: null,
        rttMinMs: null,
        rttP50Ms: null,
        rttP90Ms: null,
        rttP99Ms: null,
        sentCount: 20,
        snapshotCount: 1,
      }),
    ),
    rttAvgMs: null,
    rttMaxMs: null,
    rttMinMs: null,
    rttP50Ms: null,
    rttP90Ms: null,
    rttP99Ms: null,
    snapshotCount: 1,
  }
}

const OPTIONS = { now: NOW, rangeMs: RANGE_MS, title: 'Timeline', width: 900 }

describe('renderEventTimelineSvg', () => {
  test('renders empty state when no events detected', () => {
    const svg = renderEventTimelineSvg([], OPTIONS)
    expect(svg).toContain('No notable events')
  })

  test('flags severe destination loss (>=50%) as an event tick', () => {
    const buckets = [
      mkBucket('2026-04-19T10:00:00.000Z', 0, [{ host: 'a', hopIndexes: [1], lossPct: 0 }]),
      mkBucket('2026-04-19T11:00:00.000Z', 75, [{ host: 'a', hopIndexes: [1], lossPct: 0 }]),
    ]
    const svg = renderEventTimelineSvg(buckets, OPTIONS)
    expect(svg).toContain('Destination loss 75%')
  })

  test('flags path change when the host set shifts between buckets', () => {
    const buckets = [
      mkBucket('2026-04-19T10:00:00.000Z', 0, [
        { host: 'a', hopIndexes: [1], lossPct: 0 },
        { host: 'b', hopIndexes: [2], lossPct: 0 },
      ]),
      mkBucket('2026-04-19T11:00:00.000Z', 0, [
        { host: 'a', hopIndexes: [1], lossPct: 0 },
        { host: 'c', hopIndexes: [2], lossPct: 0 },
      ]),
    ]
    const svg = renderEventTimelineSvg(buckets, OPTIONS)
    expect(svg).toContain('Path change')
    expect(svg).toContain('New hop c')
  })

  test('does not flag first bucket in the series as a path change', () => {
    const buckets = [
      mkBucket('2026-04-19T10:00:00.000Z', 0, [{ host: 'a', hopIndexes: [1], lossPct: 0 }]),
    ]
    const svg = renderEventTimelineSvg(buckets, OPTIONS)
    // The legend row-label always mentions "Path change (host set shifted)";
    // a real tick would contain a `+` or `-` delta fragment. Assert the delta
    // form is absent rather than the legend substring.
    expect(svg).not.toMatch(/Path change [+-]/)
    expect(svg).toContain('No notable events')
  })
})
