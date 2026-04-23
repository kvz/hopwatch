import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ProbeMode, ProbeProtocol } from './config.ts'
import {
  deriveHopRecordsFromRawEvents,
  parseStoredRawSnapshot,
  quantile,
  resolveDestinationHopIndex,
  type StoredRawSnapshot,
  summarizeDestinationSamples,
} from './raw.ts'

const nullableNumber = z
  .number()
  .nullish()
  .transform((value) => value ?? null)
const nullableString = z
  .string()
  .nullish()
  .transform((value) => value ?? null)

const hopRecordSchema = z.object({
  asn: nullableString,
  avgMs: nullableNumber,
  bestMs: nullableNumber,
  host: z.string(),
  index: z.number(),
  lastMs: nullableNumber,
  lossPct: z.number(),
  sent: nullableNumber,
  stdevMs: nullableNumber,
  worstMs: nullableNumber,
})

export type HopRecord = z.infer<typeof hopRecordSchema>

const snapshotDiagnosisSchema = z.object({
  kind: z.enum(['healthy', 'intermediate_only_loss', 'destination_loss', 'unknown']),
  label: z.string(),
  summary: z.string(),
  suspectHopHost: nullableString,
  suspectHopIndex: nullableNumber,
})

export type SnapshotDiagnosis = z.infer<typeof snapshotDiagnosisSchema>

const legacyStoredSnapshotSummarySchema = z.object({
  collectedAt: z.string(),
  destinationLossPct: nullableNumber,
  diagnosis: snapshotDiagnosisSchema,
  fileName: z.string(),
  host: z.string(),
  hopCount: z.number(),
  hops: z.array(hopRecordSchema),
  probeMode: z.enum(['default', 'netns'] as const satisfies readonly ProbeMode[]),
  rawText: z.string(),
  target: z.string(),
  worstHopLossPct: nullableNumber,
})

export interface SnapshotSummary {
  collectedAt: string
  destinationAvgRttMs: number | null
  // 1-based hop index of the destination (matches `HopRecord.index`). Can
  // differ from `hops.at(-1)?.index` when MTR emits a phantom trailing hop
  // past the true destination; consumers that want intermediates must filter
  // by this index rather than `slice(0, -1)`.
  destinationHopIndex: number | null
  destinationLossPct: number | null
  destinationRttMaxMs: number | null
  destinationRttMinMs: number | null
  destinationRttP50Ms: number | null
  destinationRttP90Ms: number | null
  destinationRttSamplesMs: number[] | null
  diagnosis: SnapshotDiagnosis
  fileName: string
  host: string
  hopCount: number
  hops: HopRecord[]
  probeMode: ProbeMode
  protocol: ProbeProtocol
  rawText: string
  target: string
  worstHopLossPct: number | null
}

function parseNullableNumber(value: string | undefined): number | null {
  if (value == null) {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatReportCollectedAt(collectedAt: string): string {
  const parts = parseCompactCollectedAt(collectedAt)
  if (parts == null) {
    return collectedAt
  }

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hours}:${parts.minutes}:${parts.seconds}Z`
}

function padReportCell(value: string, width: number): string {
  return value.padStart(width, ' ')
}

function formatReportNumber(value: number | null, precision = 1): string {
  return value == null ? '--' : value.toFixed(precision)
}

export function renderSnapshotRawText(
  snapshot: Pick<
    StoredRawSnapshot,
    'collectedAt' | 'host' | 'label' | 'observer' | 'probeMode' | 'target' | 'rawEvents'
  >,
  hops: HopRecord[],
): string {
  const startLine = `Start: ${formatReportCollectedAt(snapshot.collectedAt)}`
  const hostColumn = `HOST: ${snapshot.observer}`.padEnd(42, ' ')
  const headerLine = `${hostColumn}  Loss%   Snt   Last    Avg   Best   Wrst  StDev`
  const hopLines = hops.map((hop) => {
    const index = `${String(hop.index).padStart(3, ' ')}.|--`
    const hostLabel = hop.host.length > 36 ? `${hop.host.slice(0, 35)}…` : hop.host
    const hostCell = hostLabel.padEnd(36, ' ')
    const lossCell = padReportCell(`${hop.lossPct.toFixed(1)}%`, 6)
    const sentCell = padReportCell(hop.sent == null ? '--' : String(hop.sent), 5)
    const lastCell = padReportCell(formatReportNumber(hop.lastMs), 6)
    const avgCell = padReportCell(formatReportNumber(hop.avgMs), 6)
    const bestCell = padReportCell(formatReportNumber(hop.bestMs), 6)
    const worstCell = padReportCell(formatReportNumber(hop.worstMs), 6)
    const stdevCell = padReportCell(formatReportNumber(hop.stdevMs, 1), 6)
    return `${index} ${hostCell}  ${lossCell}  ${sentCell}  ${lastCell}  ${avgCell}  ${bestCell}  ${worstCell}  ${stdevCell}`
  })
  return [
    `# observer=${snapshot.observer}`,
    `# target=${snapshot.target}`,
    `# host=${snapshot.host}`,
    `# label=${snapshot.label}`,
    `# probe_mode=${snapshot.probeMode}`,
    `# collected_at=${snapshot.collectedAt}`,
    '',
    startLine,
    headerLine,
    ...hopLines,
    '',
  ].join('\n')
}

export function parseStoredSnapshotSummary(contents: string): SnapshotSummary {
  const parsed = JSON.parse(contents) as unknown
  if (
    typeof parsed === 'object' &&
    parsed != null &&
    'schemaVersion' in parsed &&
    parsed.schemaVersion === 2
  ) {
    const rawSnapshot = parseStoredRawSnapshot(contents)
    const hops = deriveHopRecordsFromRawEvents(rawSnapshot.rawEvents) as HopRecord[]
    const destinationHopIndex = resolveDestinationHopIndex(rawSnapshot.rawEvents)
    const destinationHop =
      destinationHopIndex == null
        ? null
        : (hops.find((hop) => hop.index === destinationHopIndex + 1) ?? null)
    const destinationAvgRttMs = destinationHop?.avgMs ?? null
    // Blackholed traces (`sent` events but no `reply`/`host` events at all)
    // have destinationHopIndex == null. Treat them as 100% destination loss
    // instead of "unknown" - otherwise full outages vanish from the 3h/30h
    // charts and the weekly status logic records them as "no destination
    // loss observed". Preserve null for the genuinely-empty case (probe
    // tool errored and we have zero events to work with).
    let destinationLossPct = destinationHop?.lossPct ?? null
    if (destinationLossPct == null && hasAnySentEvent(rawSnapshot.rawEvents)) {
      destinationLossPct = 100
    }
    const destinationHopIndex1Based = destinationHop?.index ?? null
    const worstHopLossPct = hops.length === 0 ? null : Math.max(...hops.map((hop) => hop.lossPct))
    const destinationRttSamplesMs = summarizeDestinationSamples(
      rawSnapshot.rawEvents,
      destinationHopIndex,
    ).rttSamplesMs.sort((left, right) => left - right)
    const destinationRttMinMs =
      destinationRttSamplesMs.length === 0 ? null : destinationRttSamplesMs[0]
    const destinationRttMaxMs =
      destinationRttSamplesMs.length === 0
        ? null
        : destinationRttSamplesMs[destinationRttSamplesMs.length - 1]
    const destinationRttP50Ms = quantile(destinationRttSamplesMs, 0.5)
    const destinationRttP90Ms = quantile(destinationRttSamplesMs, 0.9)

    return {
      collectedAt: rawSnapshot.collectedAt,
      destinationAvgRttMs,
      destinationHopIndex: destinationHopIndex1Based,
      destinationLossPct,
      destinationRttMaxMs,
      destinationRttMinMs,
      destinationRttP50Ms,
      destinationRttP90Ms,
      destinationRttSamplesMs:
        destinationRttSamplesMs.length === 0 ? null : destinationRttSamplesMs,
      diagnosis: diagnoseSnapshot(hops, destinationLossPct, destinationHopIndex1Based),
      fileName: rawSnapshot.fileName,
      host: rawSnapshot.host,
      hopCount: hops.length,
      hops,
      probeMode: rawSnapshot.probeMode,
      protocol: rawSnapshot.protocol,
      rawText: renderSnapshotRawText(rawSnapshot, hops),
      target: rawSnapshot.label,
      worstHopLossPct,
    }
  }

  const legacy = legacyStoredSnapshotSummarySchema.parse(parsed)
  const destinationHop = legacy.hops.at(-1) ?? null

  return {
    collectedAt: legacy.collectedAt,
    destinationAvgRttMs: destinationHop?.avgMs ?? null,
    destinationHopIndex: destinationHop?.index ?? null,
    destinationLossPct: legacy.destinationLossPct,
    destinationRttMaxMs: destinationHop?.worstMs ?? null,
    destinationRttMinMs: destinationHop?.bestMs ?? null,
    destinationRttP50Ms: null,
    destinationRttP90Ms: null,
    destinationRttSamplesMs: null,
    diagnosis: legacy.diagnosis,
    fileName: legacy.fileName,
    host: legacy.host,
    hopCount: legacy.hopCount,
    hops: legacy.hops,
    probeMode: legacy.probeMode,
    // No stored protocol on legacy snapshots - they predate protocol-aware
    // probing, so they were definitionally ICMP.
    protocol: 'icmp' as const,
    rawText: legacy.rawText,
    target: legacy.target,
    worstHopLossPct: legacy.worstHopLossPct,
  }
}

function hasAnySentEvent(rawEvents: readonly { kind: string }[]): boolean {
  for (const event of rawEvents) {
    if (event.kind === 'sent') return true
  }
  return false
}

export function parseHopLine(line: string): HopRecord | null {
  const hopPrefixMatch = line.match(/^\s*(\d+)\.(?:\|--)?\s+/)
  if (!hopPrefixMatch) {
    return null
  }

  const hopIndex = Number(hopPrefixMatch[1])
  const remaining = line.slice(hopPrefixMatch[0].length).trim()
  const tokens = remaining.split(/\s+/).filter(Boolean)
  const lossIndex = tokens.findIndex((token) => /^\d+(?:\.\d+)?%$/.test(token))
  if (lossIndex <= 0) {
    return null
  }

  const hostTokens = tokens.slice(0, lossIndex)
  const asn = hostTokens[0]?.startsWith('AS') ? (hostTokens.shift() ?? null) : null
  const host = hostTokens.join(' ').trim()
  if (host === '') {
    return null
  }

  return {
    asn,
    avgMs: parseNullableNumber(tokens[lossIndex + 3]),
    bestMs: parseNullableNumber(tokens[lossIndex + 4]),
    host,
    index: hopIndex,
    lastMs: parseNullableNumber(tokens[lossIndex + 2]),
    lossPct: Number(tokens[lossIndex].replace('%', '')),
    sent: parseNullableNumber(tokens[lossIndex + 1]),
    stdevMs: parseNullableNumber(tokens[lossIndex + 6]),
    worstMs: parseNullableNumber(tokens[lossIndex + 5]),
  }
}

export function diagnoseSnapshot(
  hops: HopRecord[],
  destinationLossPct: number | null,
  destinationHopIndex?: number | null,
): SnapshotDiagnosis {
  if (destinationLossPct == null) {
    return {
      kind: 'unknown',
      label: 'Unknown',
      summary: 'No hop data was parsed from this snapshot.',
      suspectHopHost: null,
      suspectHopIndex: null,
    }
  }

  // When the destination hop index is known, "intermediates" are the hops
  // strictly before it - any hop at or after the destination index is either
  // the destination itself or a phantom trailing hop MTR sometimes emits
  // (same host, bumped TTL). Using `<` rather than `!==` excludes both, so
  // the phantom can't be blamed as a suspect or diagnosis anchor.
  let intermediateHops =
    destinationHopIndex != null
      ? hops.filter((hop) => hop.index < destinationHopIndex)
      : hops.slice(0, -1)
  if (destinationHopIndex != null && intermediateHops.length === hops.length && hops.length > 0) {
    // `destinationHopIndex` was supplied but no hop's index is < it - the
    // recorded hop indices are all at or past the destination, which isn't
    // a shape we expect. Fall back to "last hop is destination" so we stay
    // consistent with the pre-fix behavior on unusual inputs.
    intermediateHops = hops.slice(0, -1)
  }
  const lossyIntermediateHops = intermediateHops.filter((hop) => hop.lossPct > 0)
  if (destinationLossPct === 0) {
    if (lossyIntermediateHops.length === 0) {
      return {
        kind: 'healthy',
        label: 'Healthy',
        summary: 'No packet loss reached any hop in this snapshot.',
        suspectHopHost: null,
        suspectHopIndex: null,
      }
    }

    const topHop = [...lossyIntermediateHops].sort((left, right) => right.lossPct - left.lossPct)[0]
    return {
      kind: 'intermediate_only_loss',
      label: 'Intermediate-Only Loss',
      summary: `Intermediate loss appears at hop ${topHop.index} (${topHop.host}) but does not reach the destination, which usually points to router reply rate limiting rather than forwarding loss.`,
      suspectHopHost: topHop.host,
      suspectHopIndex: topHop.index,
    }
  }

  const suspectHop =
    intermediateHops.find((hop, hopIndex) => {
      if (hop.lossPct <= 0) {
        return false
      }

      return hops.slice(hopIndex + 1).every((nextHop) => nextHop.lossPct > 0)
    }) ??
    lossyIntermediateHops[0] ??
    null

  if (suspectHop) {
    return {
      kind: 'destination_loss',
      label: 'Destination Loss',
      summary: `Destination loss is ${destinationLossPct.toFixed(1)}%. Loss begins around hop ${suspectHop.index} (${suspectHop.host}) and continues to the final hop.`,
      suspectHopHost: suspectHop.host,
      suspectHopIndex: suspectHop.index,
    }
  }

  return {
    kind: 'destination_loss',
    label: 'Destination Loss',
    summary: `Destination loss is ${destinationLossPct.toFixed(1)}%. No single intermediate hop stood out as a clear starting point in this snapshot.`,
    suspectHopHost: null,
    suspectHopIndex: null,
  }
}

export function parseSnapshotSummary(fileName: string, rawText: string): SnapshotSummary {
  const targetMatch = rawText.match(/^# target=(.+)$/m)
  const hostMatch = rawText.match(/^# host=(.+)$/m)
  const labelMatch = rawText.match(/^# label=(.+)$/m)
  const probeModeMatch = rawText.match(/^# probe_mode=(.+)$/m)
  const collectedAtMatch = rawText.match(/^# collected_at=(.+)$/m)
  const hops = rawText.split('\n').flatMap((line) => {
    const hop = parseHopLine(line)
    if (!hop) {
      return []
    }

    return [hop]
  })
  const destinationHop = hops.at(-1) ?? null
  const worstHopLossPct = hops.length === 0 ? null : Math.max(...hops.map((hop) => hop.lossPct))
  const destinationLossPct = destinationHop?.lossPct ?? null

  return {
    collectedAt: collectedAtMatch?.[1] ?? fileName.replace(/\.txt$/, ''),
    destinationAvgRttMs: destinationHop?.avgMs ?? null,
    destinationHopIndex: destinationHop?.index ?? null,
    destinationLossPct,
    destinationRttMaxMs: destinationHop?.worstMs ?? null,
    destinationRttMinMs: destinationHop?.bestMs ?? null,
    destinationRttP50Ms: null,
    destinationRttP90Ms: null,
    destinationRttSamplesMs: null,
    diagnosis: diagnoseSnapshot(hops, destinationLossPct, destinationHop?.index ?? null),
    fileName,
    host: hostMatch?.[1] ?? targetMatch?.[1] ?? fileName.replace(/\.txt$/, ''),
    hopCount: hops.length,
    hops,
    probeMode: probeModeMatch?.[1] === 'netns' ? 'netns' : 'default',
    // Legacy .txt snapshots predate protocol-aware probing; treat as ICMP.
    protocol: 'icmp' as const,
    rawText,
    target: labelMatch?.[1] ?? targetMatch?.[1] ?? fileName.replace(/\.txt$/, ''),
    worstHopLossPct,
  }
}

export const RESERVED_TARGET_FILES: ReadonlySet<string> = new Set([
  'latest.json',
  'hourly.rollup.json',
  'daily.rollup.json',
  'alert-state.json',
])

export async function listSnapshotFileNames(targetDir: string): Promise<string[]> {
  const entries = await readdir(targetDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .filter((name) => !RESERVED_TARGET_FILES.has(name))
    .sort()
}

export async function readSnapshotSummary(
  targetDir: string,
  fileName: string,
): Promise<SnapshotSummary> {
  // Only .json snapshots land here (listSnapshotFileNames filters for that
  // extension). Any parse failure therefore signals corruption or schema
  // drift, not a legacy raw-text snapshot - let the error propagate so the
  // caller can log + skip + quarantine. Swallowing it and re-parsing the
  // same file as legacy text would hide on-disk data loss by producing a
  // synthetic "unknown" snapshot that pollutes the dashboard.
  const jsonFile = path.join(targetDir, fileName)
  const jsonContents = await readFile(jsonFile, 'utf8')
  return parseStoredSnapshotSummary(jsonContents)
}

export function formatLoss(lossPct: number | null): string {
  if (lossPct == null) {
    return 'n/a'
  }

  return `${lossPct.toFixed(1)}%`
}

export function formatLatencyMs(rttMs: number | null): string {
  if (rttMs == null || !Number.isFinite(rttMs)) {
    return 'n/a'
  }
  if (rttMs < 10) return `${rttMs.toFixed(1)} ms`
  if (rttMs < 1000) return `${rttMs.toFixed(0)} ms`
  return `${(rttMs / 1000).toFixed(1)} s`
}

function getSeverityScaleClass(
  value: number | null,
  {
    redAt = 50,
  }: {
    redAt?: number
  } = {},
): string {
  if (value == null) {
    return 'unknown'
  }

  const normalized = Math.max(0, Math.min(value / redAt, 1))
  if (normalized === 0) {
    return 'scale-0'
  }

  if (normalized < 0.1) {
    return 'scale-1'
  }

  if (normalized < 0.2) {
    return 'scale-2'
  }

  if (normalized < 0.4) {
    return 'scale-3'
  }

  if (normalized < 0.7) {
    return 'scale-4'
  }

  return 'scale-5'
}

export function getLossClass(lossPct: number | null): string {
  return getSeverityScaleClass(lossPct, {
    redAt: 50,
  })
}

export function getLossOccurrenceClass(lossCount: number, sampleCount: number): string {
  if (sampleCount <= 0) {
    return 'unknown'
  }

  return getSeverityScaleClass((lossCount / sampleCount) * 100, {
    redAt: 50,
  })
}

export function getDiagnosisClass(diagnosis: SnapshotDiagnosis): string {
  if (diagnosis.kind === 'destination_loss') {
    return 'bad'
  }

  if (diagnosis.kind === 'intermediate_only_loss') {
    return 'warn'
  }

  if (diagnosis.kind === 'healthy') {
    return 'good'
  }

  return 'unknown'
}

export interface CompactCollectedAtParts {
  day: string
  hours: string
  minutes: string
  month: string
  seconds: string
  year: string
}

// Single source of truth for the on-disk `YYYYMMDDTHHmmssZ` timestamp format
// used by snapshot filenames and `collectedAt` fields. All callers that need
// to parse/reformat this timestamp should go through here so the regex and
// semantics stay in lockstep. `formatCompactCollectedAt` is the inverse -
// used by the collector when naming new snapshots.
export function formatCompactCollectedAt(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  const seconds = String(date.getUTCSeconds()).padStart(2, '0')
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`
}

export function parseCompactCollectedAt(value: string): CompactCollectedAtParts | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!match) return null
  const [, year, month, day, hours, minutes, seconds] = match
  return { day, hours, minutes, month, seconds, year }
}

export function parseCollectedAt(value: string): number | null {
  const parts = parseCompactCollectedAt(value)
  if (parts == null) {
    return null
  }

  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hours),
    Number(parts.minutes),
    Number(parts.seconds),
  )
}

export function formatAbsoluteCollectedAt(value: string): string {
  const timestamp = parseCollectedAt(value)
  if (timestamp == null) {
    return value
  }

  return new Date(timestamp).toISOString().replace('.000Z', ' UTC').replace('T', ' ')
}

const DAY_LABEL_FORMATTER = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

export function formatSnapshotDay(value: string): string {
  const timestamp = parseCollectedAt(value)
  if (timestamp == null) return value.slice(0, 10)
  return DAY_LABEL_FORMATTER.format(new Date(timestamp))
}

export function formatRelativeCollectedAt(value: string, now: number): string {
  const timestamp = parseCollectedAt(value)
  if (timestamp == null) {
    return value
  }

  const diffMs = Math.max(0, now - timestamp)
  const diffSeconds = Math.max(1, Math.round(diffMs / 1000))
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`
  }

  const diffMinutes = Math.round(diffSeconds / 60)
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`
  }

  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours}h ago`
  }

  const diffDays = Math.round(diffHours / 24)
  return `${diffDays}d ago`
}
