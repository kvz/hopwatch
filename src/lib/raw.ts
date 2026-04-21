import { z } from 'zod'

import type { ProbeMode } from './config.ts'

export interface RawHopRecord {
  asn: string | null
  avgMs: number | null
  bestMs: number | null
  host: string
  index: number
  lastMs: number | null
  lossPct: number
  sent: number | null
  stdevMs: number | null
  worstMs: number | null
}

const sentEventSchema = z.object({
  kind: z.literal('sent'),
  hopIndex: z.number().int().min(0),
  probeId: z.number().int().min(0),
})

const hostEventSchema = z.object({
  kind: z.literal('host'),
  hopIndex: z.number().int().min(0),
  host: z.string().min(1),
})

const dnsEventSchema = z.object({
  kind: z.literal('dns'),
  hopIndex: z.number().int().min(0),
  host: z.string().min(1),
})

const replyEventSchema = z.object({
  kind: z.literal('reply'),
  hopIndex: z.number().int().min(0),
  probeId: z.number().int().min(0),
  rttUs: z.number().int().min(0),
})

const rawMtrEventSchema = z.union([
  sentEventSchema,
  hostEventSchema,
  dnsEventSchema,
  replyEventSchema,
])

export type RawMtrEvent = z.infer<typeof rawMtrEventSchema>

const storedRawSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  collectedAt: z.string().min(1),
  fileName: z.string().min(1),
  host: z.string().min(1),
  label: z.string().min(1),
  observer: z.string().min(1),
  probeMode: z.enum(['default', 'netns'] as const satisfies readonly ProbeMode[]),
  rawEvents: z.array(rawMtrEventSchema),
  target: z.string().min(1),
})

export type StoredRawSnapshot = z.infer<typeof storedRawSnapshotSchema>

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function standardDeviation(values: number[]): number | null {
  const mean = average(values)
  if (mean == null || values.length === 0) {
    return null
  }

  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(values.length, 1)
  return Math.sqrt(variance)
}

export function parseRawMtrOutput(output: string): RawMtrEvent[] {
  const events: RawMtrEvent[] = []

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line === '') {
      continue
    }

    const tokens = line.split(/\s+/)
    const [kind, hopIndexToken, thirdToken, fourthToken] = tokens
    const hopIndex = Number(hopIndexToken)
    if (!Number.isInteger(hopIndex) || hopIndex < 0) {
      throw new Error(`Invalid raw mtr hop index in line: ${line}`)
    }

    if (kind === 'x') {
      const probeId = Number(thirdToken)
      if (!Number.isInteger(probeId) || probeId < 0) {
        throw new Error(`Invalid raw mtr sent probe id in line: ${line}`)
      }

      events.push({
        kind: 'sent',
        hopIndex,
        probeId,
      })
      continue
    }

    if (kind === 'h') {
      const host = tokens.slice(2).join(' ').trim()
      if (host === '') {
        throw new Error(`Invalid raw mtr host line: ${line}`)
      }

      events.push({
        kind: 'host',
        hopIndex,
        host,
      })
      continue
    }

    if (kind === 'd') {
      const host = tokens.slice(2).join(' ').trim()
      if (host === '') {
        throw new Error(`Invalid raw mtr dns line: ${line}`)
      }

      events.push({
        kind: 'dns',
        hopIndex,
        host,
      })
      continue
    }

    if (kind === 'p') {
      const rttUs = Number(thirdToken)
      const probeId = Number(fourthToken)
      if (!Number.isInteger(rttUs) || rttUs < 0 || !Number.isInteger(probeId) || probeId < 0) {
        throw new Error(`Invalid raw mtr reply line: ${line}`)
      }

      events.push({
        kind: 'reply',
        hopIndex,
        probeId,
        rttUs,
      })
      continue
    }

    throw new Error(`Unsupported raw mtr line kind '${kind}' in line: ${line}`)
  }

  if (events.length === 0) {
    throw new Error('Raw mtr output did not contain any parseable events')
  }

  return events
}

export function parseStoredRawSnapshot(contents: string): StoredRawSnapshot {
  return storedRawSnapshotSchema.parse(JSON.parse(contents))
}

export function reconstructRawMtrOutput(rawEvents: RawMtrEvent[]): string {
  return rawEvents
    .map((event) => {
      if (event.kind === 'sent') {
        return `x ${event.hopIndex} ${event.probeId}`
      }

      if (event.kind === 'host') {
        return `h ${event.hopIndex} ${event.host}`
      }

      if (event.kind === 'dns') {
        return `d ${event.hopIndex} ${event.host}`
      }

      return `p ${event.hopIndex} ${event.rttUs} ${event.probeId}`
    })
    .join('\n')
}

export function deriveHopRecordsFromRawEvents(rawEvents: RawMtrEvent[]): RawHopRecord[] {
  const ipByHop = new Map<number, string>()
  const dnsByHop = new Map<number, string>()
  const sentByHop = new Map<number, number[]>()
  const replyRttsByHop = new Map<number, number[]>()
  const lastRttByHop = new Map<number, number>()
  const seenHopIndexes = new Set<number>()

  for (const event of rawEvents) {
    seenHopIndexes.add(event.hopIndex)

    if (event.kind === 'host') {
      ipByHop.set(event.hopIndex, event.host)
      continue
    }

    if (event.kind === 'dns') {
      dnsByHop.set(event.hopIndex, event.host)
      continue
    }

    if (event.kind === 'sent') {
      const current = sentByHop.get(event.hopIndex) ?? []
      current.push(event.probeId)
      sentByHop.set(event.hopIndex, current)
      continue
    }

    const rtts = replyRttsByHop.get(event.hopIndex) ?? []
    const rttMs = event.rttUs / 1000
    rtts.push(rttMs)
    replyRttsByHop.set(event.hopIndex, rtts)
    lastRttByHop.set(event.hopIndex, rttMs)
  }

  return [...seenHopIndexes]
    .sort((left, right) => left - right)
    .map((hopIndex) => {
      const sentIds = sentByHop.get(hopIndex) ?? []
      const rtts = replyRttsByHop.get(hopIndex) ?? []
      const sentCount = sentIds.length
      const lossPct = sentCount === 0 ? 100 : ((sentCount - rtts.length) / sentCount) * 100
      const ipHost = ipByHop.get(hopIndex) ?? null
      const dnsHost = dnsByHop.get(hopIndex) ?? null
      const host =
        dnsHost != null && ipHost != null && dnsHost !== ipHost
          ? `${dnsHost} (${ipHost})`
          : (dnsHost ?? ipHost ?? '???')

      return {
        asn: null,
        avgMs: average(rtts),
        bestMs: rtts.length === 0 ? null : Math.min(...rtts),
        host,
        index: hopIndex + 1,
        lastMs: lastRttByHop.get(hopIndex) ?? null,
        lossPct,
        sent: sentCount,
        stdevMs: standardDeviation(rtts),
        worstMs: rtts.length === 0 ? null : Math.max(...rtts),
      }
    })
}

// MTR sometimes emits a phantom trailing hop past the true destination (same
// host, TTL bumped by one) with far fewer replies than the real destination.
// Walking back from the max hop while consecutive hops share a host and have
// strictly more replies surfaces the true destination. Shared across raw
// summaries, rollup aggregation, and chart sample extraction so all three
// agree on which hop is "the destination".
export function resolveDestinationHopIndex(rawEvents: RawMtrEvent[]): number | null {
  if (rawEvents.length === 0) {
    return null
  }

  const replyCountByHop = new Map<number, number>()
  const hostsByHop = new Map<number, Set<string>>()
  // The deepest hop with any `reply` or `host` event — not the deepest `sent`.
  // Black-holed traces emit a `sent` per TTL up to maxHops with no replies; if
  // maxHopIndex followed those, an unreachable path would look like the
  // destination is at hop `maxHops - 1` and corrupt every downstream aggregate
  // (destination loss %, summary RTT, diagnosis).
  let maxHopIndex = -1
  let maxSentHopIndex = -1
  for (const event of rawEvents) {
    if (event.kind === 'reply') {
      replyCountByHop.set(event.hopIndex, (replyCountByHop.get(event.hopIndex) ?? 0) + 1)
      if (event.hopIndex > maxHopIndex) maxHopIndex = event.hopIndex
    } else if (event.kind === 'host') {
      let hosts = hostsByHop.get(event.hopIndex)
      if (hosts == null) {
        hosts = new Set<string>()
        hostsByHop.set(event.hopIndex, hosts)
      }
      hosts.add(event.host)
      if (event.hopIndex > maxHopIndex) maxHopIndex = event.hopIndex
    } else if (event.kind === 'sent' && event.hopIndex > maxSentHopIndex) {
      maxSentHopIndex = event.hopIndex
    }
  }

  if (maxHopIndex < 0) {
    return null
  }

  // Partial blackhole: we sent probes well past the last responding hop.
  // This means the packets stopped getting replies somewhere in the middle,
  // and the deepest responder is almost certainly NOT the destination — it's
  // just the last hop that answered before the path went dark. Returning it
  // as the destination would make the trace look healthy (100% at "dest")
  // when the real destination never responded. Threshold of 3 matches the
  // idle-TTL margin the prober keeps past destHopIndex in its send loop.
  if (maxSentHopIndex > maxHopIndex + 3) {
    return null
  }

  const finalHosts = hostsByHop.get(maxHopIndex) ?? new Set<string>()
  let destinationHopIndex = maxHopIndex
  for (let hopIndex = maxHopIndex - 1; hopIndex >= 0; hopIndex -= 1) {
    const hosts = hostsByHop.get(hopIndex)
    if (hosts == null) break
    let sharesHost = false
    for (const host of hosts) {
      if (finalHosts.has(host)) {
        sharesHost = true
        break
      }
    }
    if (!sharesHost) break
    const prevReplyCount = replyCountByHop.get(hopIndex) ?? 0
    const currentReplyCount = replyCountByHop.get(destinationHopIndex) ?? 0
    if (prevReplyCount <= currentReplyCount) break
    destinationHopIndex = hopIndex
  }

  return destinationHopIndex
}

// Linear-interpolation quantile (NIST / numpy default). Used everywhere we
// compute percentiles from RTT samples so the smoke-band, summary stats, and
// rollup aggregates all agree on the same math.
export interface DestinationSampleSummary {
  rttSamplesMs: number[]
  sentCount: number
}

export function summarizeDestinationSamples(
  rawEvents: RawMtrEvent[],
  destinationHopIndex: number | null = resolveDestinationHopIndex(rawEvents),
): DestinationSampleSummary {
  if (destinationHopIndex == null) {
    return { rttSamplesMs: [], sentCount: 0 }
  }

  const rttSamplesMs: number[] = []
  let sentCount = 0
  for (const event of rawEvents) {
    if (event.hopIndex !== destinationHopIndex) continue
    if (event.kind === 'sent') {
      sentCount += 1
    } else if (event.kind === 'reply') {
      rttSamplesMs.push(event.rttUs / 1000)
    }
  }

  return { rttSamplesMs, sentCount }
}

export function quantile(sortedValues: number[], percentile: number): number | null {
  if (sortedValues.length === 0) {
    return null
  }

  const pos = (sortedValues.length - 1) * percentile
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const lower = sortedValues[lo]
  if (lower == null) {
    return null
  }
  if (lo === hi) {
    return lower
  }
  const upper = sortedValues[hi]
  if (upper == null) {
    return lower
  }
  return lower + (upper - lower) * (pos - lo)
}
