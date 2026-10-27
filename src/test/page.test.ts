import { describe, expect, test, vi } from 'vitest'
import { loadChartDefinitions } from '../lib/chart.ts'
import type { NetworkOwnerInfo } from '../lib/network-owner.ts'
import { type PageSnapshotStore, renderRootIndex, renderTargetIndex } from '../lib/page.tsx'
import { buildRollupFile, type MtrRollupFile, type RollupGranularity } from '../lib/rollups.ts'
import type { SnapshotSummary } from '../lib/snapshot.ts'

class MemoryPageStore implements PageSnapshotStore {
  constructor(private readonly snapshotsByTarget: Map<string, SnapshotSummary[]>) {}

  getNetworkOwnerCache(): NetworkOwnerInfo | null {
    return null
  }

  getRollupFile(_targetSlug: string, _granularity: RollupGranularity): MtrRollupFile | null {
    return null
  }

  getSnapshotRawText(): string | null {
    return null
  }

  listSnapshotSummaries(targetSlug: string): SnapshotSummary[] {
    return this.snapshotsByTarget.get(targetSlug) ?? []
  }

  listTargetSlugs(): string[] {
    return [...this.snapshotsByTarget.keys()].sort()
  }

  upsertNetworkOwnerCache(): void {}
}

function snapshot(partial: Partial<SnapshotSummary> & { collectedAt: string }): SnapshotSummary {
  const { collectedAt, ...overrides } = partial

  return {
    collectedAt,
    destinationAvgRttMs: 10,
    destinationHopIndex: 1,
    destinationLossPct: 0,
    destinationRttMaxMs: 10,
    destinationRttMinMs: 10,
    destinationRttP50Ms: 10,
    destinationRttP90Ms: 10,
    destinationRttSamplesMs: [10],
    diagnosis: {
      kind: 'healthy',
      label: 'Healthy',
      summary: 'No loss detected.',
      suspectHopHost: null,
      suspectHopIndex: null,
    },
    engine: 'mtr',
    fileName: `${collectedAt}.json`,
    hopCount: 1,
    hops: [
      {
        asn: null,
        avgMs: 10,
        bestMs: 10,
        host: partial.host ?? 'example.com',
        index: 1,
        lastMs: 10,
        lossPct: 0,
        sent: 20,
        stdevMs: 0,
        worstMs: 10,
      },
    ],
    host: 'example.com',
    netns: null,
    port: 443,
    probeMode: 'default',
    protocol: 'icmp',
    rawText: '',
    target: 'Example',
    worstHopLossPct: 0,
    ...overrides,
  }
}

describe('renderRootIndex', () => {
  test('a converted sentinel uses current raw samples instead of frozen historical rollups', async () => {
    const now = Date.parse('2026-10-27T15:25:00Z')
    const current = snapshot({ collectedAt: '20261027T152400Z', destinationLossPct: 100 })
    const getRollupFile = vi.fn((_target: string, granularity: 'hour' | 'day') =>
      buildRollupFile(
        granularity,
        {
          host: 'example.com',
          label: 'Example',
          observer: 'observer',
          probeMode: 'default',
          target: 'example.com',
        },
        [],
        new Date('2026-10-26T12:00:00Z'),
      ),
    )
    const store = new MemoryPageStore(new Map([['example', [current]]]))
    store.getRollupFile = getRollupFile
    const charts = await loadChartDefinitions(store, 'example', [current], now, false)
    expect(charts.every((chart) => chart.sourceLabel === 'raw snapshots')).toBe(true)
    expect(
      charts.every((chart) => chart.points.some((point) => point.destinationLossPct === 100)),
    ).toBe(true)
    const rendered = await renderTargetIndex(
      store,
      [],
      'observer',
      null,
      'example',
      now,
      undefined,
      false,
    )
    expect(rendered?.html).not.toContain('hourly rollups')
    expect(rendered?.html).not.toContain('daily rollups')
    await renderRootIndex(
      store,
      [],
      'observer',
      null,
      14,
      now,
      undefined,
      undefined,
      undefined,
      [],
      ['example'],
      new Set(['example']),
    )
    expect(getRollupFile).not.toHaveBeenCalled()
  })

  test('target pages show actual probe ranges, gaps, and explicit legacy uncertainty', async () => {
    const current = snapshot({
      collectedAt: '20261027T152400Z',
      startedAt: '2026-10-27T15:24:00.000Z',
      finishedAt: '2026-10-27T15:24:10.000Z',
    })
    const previous = snapshot({
      collectedAt: '20261027T152330Z',
      startedAt: '2026-10-27T15:23:30.000Z',
      finishedAt: '2026-10-27T15:23:40.000Z',
    })
    const store = new MemoryPageStore(
      new Map([['example', [current, previous, snapshot({ collectedAt: '20261027T150000Z' })]]]),
    )
    const rendered = await renderTargetIndex(
      store,
      [],
      'observer',
      null,
      'example',
      Date.parse('2026-10-27T15:25:00Z'),
    )
    expect(rendered?.html).toContain('2026-10-27T15:24:00.000Z')
    expect(rendered?.html).toContain('2026-10-27T15:24:10.000Z')
    expect(rendered?.html).toContain('Gap since previous finish: 20.0s')
    expect(rendered?.html).toContain('15:24:00.000 UTC</time>')
    expect(rendered?.html).toContain('Actual probe times unavailable (legacy cycle timestamp)')
  })
  test('hides stale targets that are no longer in the active config', async () => {
    const now = Date.UTC(2026, 3, 30, 12, 0, 0)
    const store = new MemoryPageStore(
      new Map([
        ['active-target', [snapshot({ collectedAt: '20260430T115000Z', target: 'Active Target' })]],
        [
          'retired-target',
          [snapshot({ collectedAt: '20260421T101542Z', target: 'Retired Google DNS' })],
        ],
      ]),
    )

    const html = await renderRootIndex(
      store,
      [],
      'observer',
      'observer.example.com',
      14,
      now,
      undefined,
      undefined,
      undefined,
      [],
      ['active-target'],
    )

    expect(html).toContain('Active Target')
    expect(html).not.toContain('Retired Google DNS')
  })

  test('keeps recently-seen unconfigured targets during the grace window', async () => {
    const now = Date.UTC(2026, 3, 30, 12, 0, 0)
    const store = new MemoryPageStore(
      new Map([
        [
          'new-target',
          [snapshot({ collectedAt: '20260430T113000Z', target: 'Recently Seen Target' })],
        ],
      ]),
    )

    const html = await renderRootIndex(
      store,
      [],
      'observer',
      'observer.example.com',
      14,
      now,
      undefined,
      undefined,
      undefined,
      [],
      ['active-target'],
    )

    expect(html).toContain('Recently Seen Target')
  })
})
