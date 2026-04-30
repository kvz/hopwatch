import { describe, expect, test } from 'vitest'
import type { NetworkOwnerInfo } from '../lib/network-owner.ts'
import { type PageSnapshotStore, renderRootIndex } from '../lib/page.tsx'
import type { MtrRollupFile } from '../lib/rollups.ts'
import type { SnapshotSummary } from '../lib/snapshot.ts'

class MemoryPageStore implements PageSnapshotStore {
  constructor(private readonly snapshotsByTarget: Map<string, SnapshotSummary[]>) {}

  getNetworkOwnerCache(): NetworkOwnerInfo | null {
    return null
  }

  getRollupFile(): MtrRollupFile | null {
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
