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
