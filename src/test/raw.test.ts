import { describe, expect, test } from 'vitest'
import {
  deriveHopRecordsFromRawEvents,
  parseRawMtrOutput,
  quantile,
  type RawMtrEvent,
  reconstructRawMtrOutput,
  resolveDestinationHopIndex,
  summarizeDestinationSamples,
} from '../lib/raw.ts'

describe('parseRawMtrOutput', () => {
  test('parses a mixed event stream into typed events', () => {
    const output = [
      'x 0 1',
      'h 0 10.0.0.1',
      'd 0 gw.example',
      'p 0 1234 1',
      'x 1 2',
      'p 1 5678 2',
    ].join('\n')
    expect(parseRawMtrOutput(output)).toEqual([
      { kind: 'sent', hopIndex: 0, probeId: 1 },
      { kind: 'host', hopIndex: 0, host: '10.0.0.1' },
      { kind: 'dns', hopIndex: 0, host: 'gw.example' },
      { kind: 'reply', hopIndex: 0, probeId: 1, rttUs: 1234 },
      { kind: 'sent', hopIndex: 1, probeId: 2 },
      { kind: 'reply', hopIndex: 1, probeId: 2, rttUs: 5678 },
    ])
  })

  test('skips blank lines', () => {
    const output = ['', 'x 0 1', '   ', 'p 0 100 1', ''].join('\n')
    expect(parseRawMtrOutput(output)).toHaveLength(2)
  })

  test('rejects unknown line kinds', () => {
    expect(() => parseRawMtrOutput('z 0 1')).toThrow(/Unsupported raw mtr line kind/)
  })

  test('rejects invalid hop index', () => {
    expect(() => parseRawMtrOutput('x foo 1')).toThrow(/Invalid raw mtr hop index/)
  })

  test('rejects empty output', () => {
    expect(() => parseRawMtrOutput('')).toThrow(/did not contain any parseable events/)
  })

  test('rejects negative rtt', () => {
    expect(() => parseRawMtrOutput('p 0 -5 1')).toThrow(/Invalid raw mtr reply line/)
  })
})

describe('reconstructRawMtrOutput', () => {
  test('round-trips parsed events back to the wire format', () => {
    const input = 'x 0 1\nh 0 10.0.0.1\nd 0 gw.example\np 0 1234 1'
    const roundtripped = reconstructRawMtrOutput(parseRawMtrOutput(input))
    expect(roundtripped).toBe(input)
  })
})

describe('resolveDestinationHopIndex', () => {
  test('returns null for empty events', () => {
    expect(resolveDestinationHopIndex([])).toBeNull()
  })

  test('returns the max hop when it has the most replies', () => {
    const events: RawMtrEvent[] = [
      { kind: 'host', hopIndex: 5, host: 'final' },
      { kind: 'reply', hopIndex: 5, probeId: 1, rttUs: 100 },
      { kind: 'reply', hopIndex: 5, probeId: 2, rttUs: 100 },
    ]
    expect(resolveDestinationHopIndex(events)).toBe(5)
  })

  test('walks back past a phantom hop that shares the same host but has fewer replies', () => {
    const events: RawMtrEvent[] = [
      { kind: 'host', hopIndex: 5, host: '1.1.1.1' },
      { kind: 'reply', hopIndex: 5, probeId: 1, rttUs: 100 },
      { kind: 'reply', hopIndex: 5, probeId: 2, rttUs: 100 },
      { kind: 'reply', hopIndex: 5, probeId: 3, rttUs: 100 },
      { kind: 'host', hopIndex: 6, host: '1.1.1.1' },
      { kind: 'reply', hopIndex: 6, probeId: 1, rttUs: 100 },
    ]
    expect(resolveDestinationHopIndex(events)).toBe(5)
  })

  test('picks the full-probe-cycle hop over trailing partial-probe tail (TCP mtr)', () => {
    // `mtr --tcp -c 10` emits the full 10-probe cycle at the real destination
    // (hop 12 here) and then a few "extra probes" at deeper TTLs that echo
    // the same destination IP back - 3 probes at hop 13, 1 each at hops 14-16.
    // Before the fix, resolveDestinationHopIndex compared reply counts and
    // saw hop 16 (reply=1) == hop 15 (reply=1), so it bailed out at the tail
    // and classified the 1-reply trailing slot as the destination - which
    // hides real destination loss (reply=2 out of sent=10 here) under a fake
    // 0% loss summary.
    const events: RawMtrEvent[] = []
    // Main 10-probe cycle at the real destination (hop 12). Only 2 of 10
    // probes get a SYN-ACK back; the rest are lost on the path, which is
    // the whole reason we want to surface this hop.
    for (let i = 1; i <= 10; i += 1) {
      events.push({ kind: 'sent', hopIndex: 12, probeId: i })
    }
    events.push({ kind: 'host', hopIndex: 12, host: '52.92.0.1' })
    events.push({ kind: 'reply', hopIndex: 12, probeId: 1, rttUs: 223000 })
    events.push({ kind: 'reply', hopIndex: 12, probeId: 2, rttUs: 223000 })
    // Trailing "extra probes" that mtr fires past the destination to verify
    // TTL scope. Each further hop sends fewer probes.
    const extras: [number, number][] = [
      [13, 3],
      [14, 1],
      [15, 1],
      [16, 1],
    ]
    for (const [hop, count] of extras) {
      for (let i = 1; i <= count; i += 1) {
        events.push({ kind: 'sent', hopIndex: hop, probeId: i })
        events.push({ kind: 'reply', hopIndex: hop, probeId: i, rttUs: 223000 })
      }
      events.push({ kind: 'host', hopIndex: hop, host: '52.92.0.1' })
    }
    expect(resolveDestinationHopIndex(events)).toBe(12)
  })

  test('does not walk back when the previous hop does not share a host', () => {
    const events: RawMtrEvent[] = [
      { kind: 'host', hopIndex: 4, host: 'isp.example' },
      { kind: 'reply', hopIndex: 4, probeId: 1, rttUs: 100 },
      { kind: 'host', hopIndex: 5, host: '1.1.1.1' },
      { kind: 'reply', hopIndex: 5, probeId: 1, rttUs: 100 },
    ]
    expect(resolveDestinationHopIndex(events)).toBe(5)
  })

  test('returns null when only sent events exist (black-holed destination)', () => {
    // Native prober emits one `sent` per TTL even when the path is black-holed
    // and no replies ever come back. Before the fix, maxHopIndex was computed
    // from sent events too, so an unreachable destination looked like hop 29
    // (or whatever maxHops-1 happens to be), which corrupts destination loss
    // and RTT rollups.
    const events: RawMtrEvent[] = []
    for (let ttl = 1; ttl <= 30; ttl += 1) {
      events.push({ kind: 'sent', hopIndex: ttl - 1, probeId: ttl })
    }
    expect(resolveDestinationHopIndex(events)).toBeNull()
  })

  test('returns null for a partial blackhole where sends go far past the last reply', () => {
    // Earlier behavior picked the deepest replying hop (7) as the destination
    // even when we sent all the way through hop 29 without a single response
    // past hop 7. That misidentifies a silent / firewalled destination as a
    // healthy one: under the native prober the send loop only walks past
    // destHopIndex if no echo_reply ever landed, so a 22-hop trailing silence
    // is strong evidence hop 7 is just a router and the real destination never
    // answered. Returning null lets parseStoredSnapshotSummary mark the
    // snapshot as a blackhole (100% destination loss) instead.
    const events: RawMtrEvent[] = [
      { kind: 'host', hopIndex: 7, host: 'intermediate.example' },
      { kind: 'reply', hopIndex: 7, probeId: 1, rttUs: 100 },
      { kind: 'reply', hopIndex: 7, probeId: 2, rttUs: 110 },
    ]
    for (let ttl = 8; ttl <= 30; ttl += 1) {
      events.push({ kind: 'sent', hopIndex: ttl - 1, probeId: ttl })
    }
    expect(resolveDestinationHopIndex(events)).toBeNull()
  })

  test('still picks the deepest replying hop when sends stop shortly past it (normal early-exit)', () => {
    // When destHopIndex was set by an echo_reply, the native prober stops
    // sending within a small margin. That margin (<= 3 TTLs) must NOT trigger
    // the partial-blackhole branch; the deepest responder really is the
    // destination.
    const events: RawMtrEvent[] = [
      { kind: 'host', hopIndex: 7, host: 'final.example' },
      { kind: 'reply', hopIndex: 7, probeId: 1, rttUs: 100 },
      { kind: 'reply', hopIndex: 7, probeId: 2, rttUs: 110 },
      { kind: 'sent', hopIndex: 8, probeId: 8 },
    ]
    expect(resolveDestinationHopIndex(events)).toBe(7)
  })
})

describe('summarizeDestinationSamples', () => {
  test('returns empty summary when no destination hop', () => {
    expect(summarizeDestinationSamples([])).toEqual({ rttSamplesMs: [], sentCount: 0 })
  })

  test('collects sent count and rtt samples (in ms) for the destination hop only', () => {
    const events: RawMtrEvent[] = [
      { kind: 'host', hopIndex: 2, host: 'final' },
      { kind: 'sent', hopIndex: 2, probeId: 1 },
      { kind: 'sent', hopIndex: 2, probeId: 2 },
      { kind: 'sent', hopIndex: 2, probeId: 3 },
      { kind: 'reply', hopIndex: 2, probeId: 1, rttUs: 1500 },
      { kind: 'reply', hopIndex: 2, probeId: 2, rttUs: 2500 },
      { kind: 'sent', hopIndex: 1, probeId: 1 },
      { kind: 'reply', hopIndex: 1, probeId: 1, rttUs: 999 },
    ]
    expect(summarizeDestinationSamples(events)).toEqual({
      rttSamplesMs: [1.5, 2.5],
      sentCount: 3,
    })
  })
})

describe('deriveHopRecordsFromRawEvents', () => {
  test('builds per-hop records with 1-based index and ms-converted rtts', () => {
    const events: RawMtrEvent[] = [
      { kind: 'host', hopIndex: 0, host: '10.0.0.1' },
      { kind: 'sent', hopIndex: 0, probeId: 1 },
      { kind: 'reply', hopIndex: 0, probeId: 1, rttUs: 1000 },
      { kind: 'host', hopIndex: 1, host: '1.1.1.1' },
      { kind: 'dns', hopIndex: 1, host: 'one.one.one.one' },
      { kind: 'sent', hopIndex: 1, probeId: 1 },
      { kind: 'sent', hopIndex: 1, probeId: 2 },
      { kind: 'reply', hopIndex: 1, probeId: 1, rttUs: 2000 },
    ]
    const records = deriveHopRecordsFromRawEvents(events)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ host: '10.0.0.1', index: 1, lossPct: 0 })
    expect(records[1]).toMatchObject({
      host: 'one.one.one.one (1.1.1.1)',
      index: 2,
      lossPct: 50,
      bestMs: 2,
    })
  })

  test('marks 100% loss when nothing replies', () => {
    const events: RawMtrEvent[] = [
      { kind: 'host', hopIndex: 0, host: '???' },
      { kind: 'sent', hopIndex: 0, probeId: 1 },
      { kind: 'sent', hopIndex: 0, probeId: 2 },
    ]
    expect(deriveHopRecordsFromRawEvents(events)[0].lossPct).toBe(100)
  })
})

describe('quantile', () => {
  test('returns null for empty arrays', () => {
    expect(quantile([], 0.5)).toBeNull()
  })

  test('returns the single value for a singleton', () => {
    expect(quantile([42], 0.5)).toBe(42)
  })

  test('linearly interpolates between neighbors (numpy default)', () => {
    expect(quantile([0, 10], 0.5)).toBe(5)
    expect(quantile([0, 5, 10], 0.25)).toBe(2.5)
  })
})
