import { describe, expect, test } from 'vitest'
import type { HopRecord } from '../lib/snapshot.ts'
import { diagnoseSnapshot, parseStoredSnapshotSummary } from '../lib/snapshot.ts'

function hop(partial: Partial<HopRecord> & { index: number }): HopRecord {
  return {
    asn: null,
    avgMs: null,
    bestMs: null,
    host: 'router.example',
    lastMs: null,
    lossPct: 0,
    sent: null,
    stdevMs: null,
    worstMs: null,
    ...partial,
  }
}

describe('parseStoredSnapshotSummary', () => {
  test('reports a blackholed trace as 100% destination loss instead of unknown', () => {
    // v2 snapshot with `sent` events at every ttl but no `reply` or `host`
    // events anywhere - the path is fully black-holed. Previously this
    // bubbled up as destinationLossPct = null and diagnosis = 'unknown',
    // causing the 3h/30h charts to skip the bar and the weekly status
    // logic to record it as "no destination loss observed".
    const rawEvents = [
      { kind: 'sent', hopIndex: 0, probeId: 1 },
      { kind: 'sent', hopIndex: 1, probeId: 2 },
      { kind: 'sent', hopIndex: 2, probeId: 3 },
    ]
    const contents = JSON.stringify({
      collectedAt: '20260420T120000Z',
      fileName: 'fixture.json',
      host: 'unreachable.example',
      label: 'unreachable',
      observer: 'test-observer',
      probeMode: 'default',
      rawEvents,
      schemaVersion: 2,
      target: 'unreachable.example',
    })
    const summary = parseStoredSnapshotSummary(contents)
    expect(summary.destinationLossPct).toBe(100)
    expect(summary.diagnosis.kind).toBe('destination_loss')
  })
})

describe('diagnoseSnapshot', () => {
  test('treats the destination-by-index as the destination even when a phantom trailing hop follows it', () => {
    // MTR sometimes emits a phantom trailing hop past the real destination
    // (same host, bumped TTL). If diagnose uses `slice(0, -1)` it will
    // misclassify the real destination as an intermediate and report
    // "intermediate-only loss" when in fact it's destination loss.
    const hops = [
      hop({ index: 1, host: 'router.example', lossPct: 0 }),
      hop({ index: 2, host: 'upstream.example', lossPct: 0 }),
      hop({ index: 3, host: 'destination', lossPct: 20 }),
      hop({ index: 4, host: 'destination', lossPct: 80 }),
    ]
    const diagnosis = diagnoseSnapshot(hops, 20, 3)
    expect(diagnosis.kind).toBe('destination_loss')
  })
})
