import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'
import type { LoadedConfig, PeerConfig, ProbeMode, TargetConfig } from './config.ts'
import type { Logger } from './logger.ts'
import {
  deriveHopRecordsFromRawEvents,
  parseRawMtrOutput,
  parseStoredRawSnapshot,
  type StoredRawSnapshot,
} from './raw.ts'
import { type MtrRollupBucket, readRollupFile, updateTargetRollups } from './rollups.ts'

export interface MtrHistoryTarget {
  slug: string
  label: string
  host: string
  probeMode: ProbeMode
  netns: string | null
  group: string
}

export function targetFromConfig(config: TargetConfig): MtrHistoryTarget {
  return {
    slug: config.id,
    label: config.label,
    host: config.host,
    probeMode: config.probe_mode,
    netns: config.netns ?? null,
    group: config.group ?? 'default',
  }
}

export type { ProbeMode }

type RunCommand = (
  file: string,
  args: string[],
) => Promise<{
  stderr: string
  stdout: string
}>

const execFileAsync: RunCommand = async (file, args) => execa(file, args)

interface CollectorOptions {
  concurrency: number
  ipVersion: '4' | '6'
  keepDays: number
  logDir: string
  mtrBin: string
  namespaceDir: string
  netnsMount: boolean
  packets: number
  renderOnly: boolean
  targets: MtrHistoryTarget[]
}

interface CollectorDependencies {
  getNow?: () => Date
  runCommand?: RunCommand
}

interface HopRecord {
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

interface SnapshotDiagnosis {
  kind: 'healthy' | 'intermediate_only_loss' | 'destination_loss' | 'unknown'
  label: string
  summary: string
  suspectHopHost: string | null
  suspectHopIndex: number | null
}

interface SnapshotSummary {
  collectedAt: string
  destinationAvgRttMs: number | null
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
  rawText: string
  target: string
  worstHopLossPct: number | null
}

export interface NativeChartPoint {
  destinationLossPct: number | null
  rttAvgMs: number | null
  rttMaxMs: number | null
  rttMinMs: number | null
  rttP25Ms: number | null
  rttP50Ms: number | null
  rttP75Ms: number | null
  rttP90Ms: number | null
  rttSamplesMs: number[] | null
  timestamp: number
}

interface NativeChartDefinition {
  label: string
  points: NativeChartPoint[]
  rangeLabel: string
  sourceLabel: string
}

export function getTimestamp(now: Date = new Date()): string {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const day = String(now.getUTCDate()).padStart(2, '0')
  const hours = String(now.getUTCHours()).padStart(2, '0')
  const minutes = String(now.getUTCMinutes()).padStart(2, '0')
  const seconds = String(now.getUTCSeconds()).padStart(2, '0')
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`
}

export function collectorOptionsFromConfig(config: LoadedConfig): CollectorOptions {
  return {
    concurrency: config.probe.concurrency,
    ipVersion: String(config.probe.ip_version) as '4' | '6',
    keepDays: config.probe.keep_days,
    logDir: config.resolvedDataDir,
    mtrBin: config.probe.mtr_bin,
    namespaceDir: config.probe.namespace_dir,
    netnsMount: config.probe.netns_mount,
    packets: config.probe.packets,
    renderOnly: false,
    targets: config.target.map(targetFromConfig),
  }
}

export function getTargetSlug(target: string): string {
  return target.replaceAll(/[^A-Za-z0-9._:-]/g, '-')
}

export function getLegacyTargetSlug(targetSlug: string): string {
  return `${targetSlug}-`
}

interface SnapshotAggregate {
  averageDestinationLossPct: number | null
  averageWorstHopLossPct: number | null
  sampleCount: number
}

interface DiagnosisAggregate {
  destinationLossCount: number
  healthyCount: number
  intermediateOnlyCount: number
  sampleCount: number
  unknownCount: number
}

interface SeverityBadge {
  className: 'good' | 'warn' | 'bad' | 'unknown'
  label: string
  summary: string
}

interface HopAggregate {
  averageLossPct: number | null
  downstreamLossCount: number
  host: string
  isolatedLossCount: number
  latestHopIndex: number | null
  sampleCount: number
}

interface ObserverRegionLink {
  host: string
  isActive: boolean
  label: string
  url: string
}

function parseNullableNumber(value: string | undefined): number | null {
  if (value == null) {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isProbeMode(value: unknown): value is ProbeMode {
  return value === 'default' || value === 'netns'
}

function isDiagnosisKind(value: unknown): value is SnapshotDiagnosis['kind'] {
  return (
    value === 'healthy' ||
    value === 'intermediate_only_loss' ||
    value === 'destination_loss' ||
    value === 'unknown'
  )
}

function isNullableNumber(value: unknown): value is number | null {
  return value == null || typeof value === 'number'
}

function formatReportCollectedAt(collectedAt: string): string {
  const match = collectedAt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!match) {
    return collectedAt
  }

  const [, year, month, day, hour, minute, second] = match
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`
}

function padReportCell(value: string, width: number): string {
  return value.padStart(width, ' ')
}

function formatReportNumber(value: number | null, precision = 1): string {
  return value == null ? '--' : value.toFixed(precision)
}

function renderSnapshotRawText(
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

function getDestinationRttSamplesMs(rawSnapshot: StoredRawSnapshot): number[] {
  if (rawSnapshot.rawEvents.length === 0) {
    return []
  }

  const replyCountByHop = new Map<number, number>()
  const hostsByHop = new Map<number, Set<string>>()
  for (const event of rawSnapshot.rawEvents) {
    if (event.kind === 'reply') {
      replyCountByHop.set(event.hopIndex, (replyCountByHop.get(event.hopIndex) ?? 0) + 1)
    } else if (event.kind === 'host') {
      let hosts = hostsByHop.get(event.hopIndex)
      if (hosts == null) {
        hosts = new Set<string>()
        hostsByHop.set(event.hopIndex, hosts)
      }
      hosts.add(event.host)
    }
  }

  let maxHopIndex = -1
  for (const event of rawSnapshot.rawEvents) {
    if (event.hopIndex > maxHopIndex) maxHopIndex = event.hopIndex
  }
  if (maxHopIndex < 0) return []

  // MTR sometimes emits a phantom trailing hop past the true destination
  // (same host, TTL bumped by one) with far fewer replies than the real
  // destination — if we blindly picked the highest hopIndex we'd end up
  // with a single sample and the smoke bands would collapse to a flat line.
  // Walk back from the max hop while consecutive hops share a host and have
  // strictly more replies; that surfaces the true destination.
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

  const samples: number[] = []
  for (const event of rawSnapshot.rawEvents) {
    if (event.kind !== 'reply' || event.hopIndex !== destinationHopIndex) {
      continue
    }

    samples.push(event.rttUs / 1000)
  }

  return samples
}

function quantileOf(sortedValues: number[], percentile: number): number | null {
  if (sortedValues.length === 0) {
    return null
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * percentile) - 1),
  )
  return sortedValues[index] ?? null
}

function parseStoredSnapshotSummary(contents: string): SnapshotSummary {
  const parsed = JSON.parse(contents) as unknown
  if (
    typeof parsed === 'object' &&
    parsed != null &&
    'schemaVersion' in parsed &&
    parsed.schemaVersion === 2
  ) {
    const rawSnapshot = parseStoredRawSnapshot(contents)
    const hops = deriveHopRecordsFromRawEvents(rawSnapshot.rawEvents) as HopRecord[]
    const destinationHop = hops.at(-1) ?? null
    const destinationAvgRttMs = destinationHop?.avgMs ?? null
    const destinationLossPct = destinationHop?.lossPct ?? null
    const worstHopLossPct = hops.length === 0 ? null : Math.max(...hops.map((hop) => hop.lossPct))
    const destinationRttSamplesMs = getDestinationRttSamplesMs(rawSnapshot).sort(
      (left, right) => left - right,
    )
    const destinationRttMinMs =
      destinationRttSamplesMs.length === 0 ? null : destinationRttSamplesMs[0]
    const destinationRttMaxMs =
      destinationRttSamplesMs.length === 0
        ? null
        : destinationRttSamplesMs[destinationRttSamplesMs.length - 1]
    const destinationRttP50Ms = quantileOf(destinationRttSamplesMs, 0.5)
    const destinationRttP90Ms = quantileOf(destinationRttSamplesMs, 0.9)

    return {
      collectedAt: rawSnapshot.collectedAt,
      destinationAvgRttMs,
      destinationLossPct,
      destinationRttMaxMs,
      destinationRttMinMs,
      destinationRttP50Ms,
      destinationRttP90Ms,
      destinationRttSamplesMs:
        destinationRttSamplesMs.length === 0 ? null : destinationRttSamplesMs,
      diagnosis: diagnoseSnapshot(hops, destinationLossPct),
      fileName: rawSnapshot.fileName,
      host: rawSnapshot.host,
      hopCount: hops.length,
      hops,
      probeMode: rawSnapshot.probeMode,
      rawText: renderSnapshotRawText(rawSnapshot, hops),
      target: rawSnapshot.label,
      worstHopLossPct,
    }
  }

  if (typeof parsed !== 'object' || parsed == null) {
    throw new Error('Snapshot summary JSON must be an object')
  }

  const candidate = parsed as Record<string, unknown>
  if (
    typeof candidate.collectedAt !== 'string' ||
    !isNullableNumber(candidate.destinationLossPct) ||
    typeof candidate.fileName !== 'string' ||
    typeof candidate.host !== 'string' ||
    typeof candidate.hopCount !== 'number' ||
    !Array.isArray(candidate.hops) ||
    !isProbeMode(candidate.probeMode) ||
    typeof candidate.rawText !== 'string' ||
    typeof candidate.target !== 'string' ||
    !isNullableNumber(candidate.worstHopLossPct)
  ) {
    throw new Error('Snapshot summary JSON has invalid top-level fields')
  }

  const diagnosisCandidate = candidate.diagnosis
  if (typeof diagnosisCandidate !== 'object' || diagnosisCandidate == null) {
    throw new Error('Snapshot summary JSON is missing diagnosis')
  }

  const diagnosis = diagnosisCandidate as Record<string, unknown>
  if (
    !isDiagnosisKind(diagnosis.kind) ||
    typeof diagnosis.label !== 'string' ||
    typeof diagnosis.summary !== 'string' ||
    !(diagnosis.suspectHopHost == null || typeof diagnosis.suspectHopHost === 'string') ||
    !(diagnosis.suspectHopIndex == null || typeof diagnosis.suspectHopIndex === 'number')
  ) {
    throw new Error('Snapshot summary JSON has invalid diagnosis')
  }

  const hops = candidate.hops.map((hop): HopRecord => {
    if (typeof hop !== 'object' || hop == null) {
      throw new Error('Snapshot summary JSON has invalid hop records')
    }

    const hopCandidate = hop as Record<string, unknown>
    if (
      !(hopCandidate.asn == null || typeof hopCandidate.asn === 'string') ||
      !isNullableNumber(hopCandidate.avgMs) ||
      !isNullableNumber(hopCandidate.bestMs) ||
      typeof hopCandidate.host !== 'string' ||
      typeof hopCandidate.index !== 'number' ||
      !isNullableNumber(hopCandidate.lastMs) ||
      typeof hopCandidate.lossPct !== 'number' ||
      !isNullableNumber(hopCandidate.sent) ||
      !isNullableNumber(hopCandidate.stdevMs) ||
      !isNullableNumber(hopCandidate.worstMs)
    ) {
      throw new Error('Snapshot summary JSON has invalid hop fields')
    }

    return {
      asn: hopCandidate.asn ?? null,
      avgMs: hopCandidate.avgMs ?? null,
      bestMs: hopCandidate.bestMs ?? null,
      host: hopCandidate.host,
      index: hopCandidate.index,
      lastMs: hopCandidate.lastMs ?? null,
      lossPct: hopCandidate.lossPct,
      sent: hopCandidate.sent ?? null,
      stdevMs: hopCandidate.stdevMs ?? null,
      worstMs: hopCandidate.worstMs ?? null,
    }
  })

  return {
    collectedAt: candidate.collectedAt,
    destinationAvgRttMs: (() => {
      const destinationHop = hops.at(-1) ?? null
      return destinationHop?.avgMs ?? null
    })(),
    destinationLossPct: candidate.destinationLossPct,
    destinationRttMaxMs: (() => {
      const destinationHop = hops.at(-1) ?? null
      return destinationHop?.worstMs ?? null
    })(),
    destinationRttMinMs: (() => {
      const destinationHop = hops.at(-1) ?? null
      return destinationHop?.bestMs ?? null
    })(),
    destinationRttP50Ms: null,
    destinationRttP90Ms: null,
    destinationRttSamplesMs: null,
    diagnosis: {
      kind: diagnosis.kind,
      label: diagnosis.label,
      summary: diagnosis.summary,
      suspectHopHost: diagnosis.suspectHopHost ?? null,
      suspectHopIndex: diagnosis.suspectHopIndex ?? null,
    },
    fileName: candidate.fileName,
    host: candidate.host,
    hopCount: candidate.hopCount,
    hops,
    probeMode: candidate.probeMode,
    rawText: candidate.rawText,
    target: candidate.target,
    worstHopLossPct: candidate.worstHopLossPct,
  }
}

function parseHopLine(line: string): HopRecord | null {
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

function diagnoseSnapshot(hops: HopRecord[], destinationLossPct: number | null): SnapshotDiagnosis {
  if (hops.length === 0 || destinationLossPct == null) {
    return {
      kind: 'unknown',
      label: 'Unknown',
      summary: 'No hop data was parsed from this snapshot.',
      suspectHopHost: null,
      suspectHopIndex: null,
    }
  }

  const intermediateHops = hops.slice(0, -1)
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function parseSnapshotSummary(fileName: string, rawText: string): SnapshotSummary {
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
    destinationLossPct,
    destinationRttMaxMs: destinationHop?.worstMs ?? null,
    destinationRttMinMs: destinationHop?.bestMs ?? null,
    destinationRttP50Ms: null,
    destinationRttP90Ms: null,
    destinationRttSamplesMs: null,
    diagnosis: diagnoseSnapshot(hops, destinationLossPct),
    fileName,
    host: hostMatch?.[1] ?? targetMatch?.[1] ?? fileName.replace(/\.txt$/, ''),
    hopCount: hops.length,
    hops,
    probeMode: probeModeMatch?.[1] === 'netns' ? 'netns' : 'default',
    rawText,
    target: labelMatch?.[1] ?? targetMatch?.[1] ?? fileName.replace(/\.txt$/, ''),
    worstHopLossPct,
  }
}

async function readSnapshotSummary(targetDir: string, fileName: string): Promise<SnapshotSummary> {
  const jsonFile = path.join(targetDir, fileName)
  try {
    const jsonContents = await readFile(jsonFile, 'utf8')
    return parseStoredSnapshotSummary(jsonContents)
  } catch {
    const rawText = await readFile(path.join(targetDir, fileName), 'utf8')
    return parseSnapshotSummary(fileName, rawText)
  }
}

function formatLoss(lossPct: number | null): string {
  if (lossPct == null) {
    return 'n/a'
  }

  return `${lossPct.toFixed(1)}%`
}

function renderDiagnosisSummary(summary: string, hops: HopRecord[]): string {
  let rendered = escapeHtml(summary)
  const uniqueHosts = [
    ...new Set(hops.map((hop) => hop.host).filter((host) => host.trim() !== '')),
  ].sort((left, right) => right.length - left.length)

  for (const host of uniqueHosts) {
    const escapedHost = escapeHtml(host)
    rendered = rendered.replaceAll(escapedHost, `<code>${escapedHost}</code>`)
  }

  return rendered
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

function getLossClass(lossPct: number | null): string {
  return getSeverityScaleClass(lossPct, {
    redAt: 50,
  })
}

function getLossOccurrenceClass(lossCount: number, sampleCount: number): string {
  if (sampleCount <= 0) {
    return 'unknown'
  }

  return getSeverityScaleClass((lossCount / sampleCount) * 100, {
    redAt: 50,
  })
}

function getDiagnosisClass(diagnosis: SnapshotDiagnosis): string {
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

function parseCollectedAt(value: string): number | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!match) {
    return null
  }

  const [, year, month, day, hours, minutes, seconds] = match
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
  )
}

function formatAbsoluteCollectedAt(value: string): string {
  const timestamp = parseCollectedAt(value)
  if (timestamp == null) {
    return value
  }

  return new Date(timestamp).toISOString().replace('.000Z', ' UTC').replace('T', ' ')
}

function formatRelativeCollectedAt(value: string, now: number): string {
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

function getPeerNavLinks(
  selfLabel: string,
  peers: PeerConfig[],
  pathSuffix: string,
): ObserverRegionLink[] {
  const self: ObserverRegionLink = {
    host: selfLabel,
    isActive: true,
    label: selfLabel,
    url: pathSuffix,
  }
  const remote: ObserverRegionLink[] = peers.map((peer) => ({
    host: peer.url.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    isActive: false,
    label: peer.label,
    url: `${peer.url.replace(/\/+$/, '')}${pathSuffix}`,
  }))
  return [self, ...remote]
}

interface TopNavSection {
  href: string
  label: string
}

interface TopNavOptions {
  backHref?: string
  backLabel?: string
  pathSuffix: string
  peers: PeerConfig[]
  sections?: TopNavSection[]
  selfLabel: string
  title?: string
}

function renderTopNav(options: TopNavOptions): string {
  const { backHref, backLabel, pathSuffix, peers, sections, selfLabel, title } = options
  const links = getPeerNavLinks(selfLabel, peers, pathSuffix)
  const activeLink = links.find((link) => link.isActive) ?? links[0]
  const nodeItems = links
    .map((link) => {
      const activeClass = link.isActive ? ' is-active' : ''
      const aria = link.isActive ? ' aria-current="page"' : ''
      return `      <a class="topnav-menu-item${activeClass}" href="${escapeHtml(link.url)}"${aria}><span class="topnav-menu-label">${escapeHtml(link.label)}</span><span class="topnav-menu-host">${escapeHtml(link.host)}</span></a>`
    })
    .join('\n')
  const nodesMenu = `    <details class="topnav-dropdown">
      <summary><span class="topnav-label">Node:</span> <span class="topnav-value">${escapeHtml(activeLink.label)}</span><span class="topnav-caret" aria-hidden="true">▾</span></summary>
      <div class="topnav-menu">
${nodeItems}
      </div>
    </details>`
  const tocMenu =
    sections && sections.length > 0
      ? `    <details class="topnav-dropdown topnav-dropdown--right">
      <summary><span class="topnav-label">On this page</span><span class="topnav-caret" aria-hidden="true">▾</span></summary>
      <div class="topnav-menu topnav-menu--right">
${sections
  .map(
    (section) =>
      `        <a class="topnav-menu-item" href="${escapeHtml(section.href)}">${escapeHtml(section.label)}</a>`,
  )
  .join('\n')}
      </div>
    </details>`
      : ''
  const backLink = backHref
    ? `    <a class="topnav-back" href="${escapeHtml(backHref)}"><span class="topnav-back-arrow" aria-hidden="true">‹</span> ${escapeHtml(backLabel ?? 'Back')}</a>`
    : ''
  const titleEl = title ? `  <span class="topnav-title">${escapeHtml(title)}</span>` : ''
  return `<nav class="topnav" aria-label="Primary">
  <div class="topnav-group topnav-group--left">
${[backLink, nodesMenu].filter((part) => part.length > 0).join('\n')}
  </div>
${titleEl}
  <div class="topnav-group topnav-group--right">
${tocMenu}
  </div>
</nav>`
}

function bucketTimestamp(bucketStart: string, granularity: 'hour' | 'day'): number {
  const start = Date.parse(bucketStart)
  if (Number.isNaN(start)) {
    return 0
  }

  const bucketMs = granularity === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  return start + bucketMs / 2
}

function getPointsFromSnapshots(
  snapshots: SnapshotSummary[],
  now: number,
  rangeMs: number,
): NativeChartPoint[] {
  const cutoff = now - rangeMs

  return snapshots
    .map((snapshot): NativeChartPoint | null => {
      const timestamp = parseCollectedAt(snapshot.collectedAt)
      if (timestamp == null || timestamp < cutoff) {
        return null
      }

      const sortedSamples =
        snapshot.destinationRttSamplesMs == null
          ? null
          : snapshot.destinationRttSamplesMs.slice().sort((left, right) => left - right)
      return {
        destinationLossPct: snapshot.destinationLossPct,
        rttAvgMs: snapshot.destinationAvgRttMs,
        rttMaxMs: snapshot.destinationRttMaxMs,
        rttMinMs: snapshot.destinationRttMinMs,
        rttP25Ms: sortedSamples == null ? null : quantileOf(sortedSamples, 0.25),
        rttP50Ms: snapshot.destinationRttP50Ms,
        rttP75Ms: sortedSamples == null ? null : quantileOf(sortedSamples, 0.75),
        rttP90Ms: snapshot.destinationRttP90Ms,
        rttSamplesMs: sortedSamples,
        timestamp,
      }
    })
    .filter((point): point is NativeChartPoint => point != null)
    .sort((left, right) => left.timestamp - right.timestamp)
}

function getPointsFromRollupBuckets(
  buckets: MtrRollupBucket[],
  granularity: 'hour' | 'day',
  now: number,
  rangeMs: number,
): NativeChartPoint[] {
  const cutoff = now - rangeMs

  return buckets
    .map((bucket): NativeChartPoint | null => {
      const timestamp = bucketTimestamp(bucket.bucketStart, granularity)
      if (timestamp < cutoff) {
        return null
      }

      return {
        destinationLossPct: bucket.destinationLossPct,
        rttAvgMs: bucket.rttAvgMs,
        rttMaxMs: bucket.rttMaxMs,
        rttMinMs: bucket.rttMinMs,
        rttP25Ms: null,
        rttP50Ms: bucket.rttP50Ms,
        rttP75Ms: null,
        rttP90Ms: bucket.rttP90Ms,
        rttSamplesMs: null,
        timestamp,
      }
    })
    .filter((point): point is NativeChartPoint => point != null)
    .sort((left, right) => left.timestamp - right.timestamp)
}

async function loadChartDefinitions(
  targetDir: string,
  snapshots: SnapshotSummary[],
  now: number,
): Promise<NativeChartDefinition[]> {
  const hourlyRollup = await readRollupFile(path.join(targetDir, 'hourly.rollup.json'), 'hour')
  const dailyRollup = await readRollupFile(path.join(targetDir, 'daily.rollup.json'), 'day')

  return [
    {
      label: 'Last 3 hours',
      points: getPointsFromSnapshots(snapshots, now, 3 * 60 * 60 * 1000),
      rangeLabel: '3h',
      sourceLabel: 'raw snapshots',
    },
    {
      label: 'Last 30 hours',
      points: getPointsFromSnapshots(snapshots, now, 30 * 60 * 60 * 1000),
      rangeLabel: '30h',
      sourceLabel: 'raw snapshots',
    },
    {
      label: 'Last 10 days',
      points:
        hourlyRollup == null
          ? getPointsFromSnapshots(snapshots, now, 10 * 24 * 60 * 60 * 1000)
          : getPointsFromRollupBuckets(hourlyRollup.buckets, 'hour', now, 10 * 24 * 60 * 60 * 1000),
      rangeLabel: '10d',
      sourceLabel: hourlyRollup == null ? 'raw snapshots' : 'hourly rollups',
    },
    {
      label: 'Last 360 days',
      points:
        dailyRollup == null
          ? getPointsFromSnapshots(snapshots, now, 360 * 24 * 60 * 60 * 1000)
          : getPointsFromRollupBuckets(dailyRollup.buckets, 'day', now, 360 * 24 * 60 * 60 * 1000),
      rangeLabel: '360d',
      sourceLabel: dailyRollup == null ? 'raw snapshots' : 'daily rollups',
    },
  ]
}

function getLineStrokeForLoss(lossPct: number | null): string {
  if (lossPct == null) {
    return '#184d47'
  }

  if (lossPct <= 0) {
    return '#26b800'
  }

  if (lossPct <= 5) {
    return '#53c000'
  }

  if (lossPct <= 10) {
    return '#00b0c0'
  }

  if (lossPct <= 15) {
    return '#3b5fc7'
  }

  if (lossPct <= 25) {
    return '#8f3dbb'
  }

  if (lossPct <= 50) {
    return '#c23e8f'
  }

  if (lossPct <= 80) {
    return '#e06d2a'
  }

  if (lossPct < 100) {
    return '#cc3d17'
  }

  return '#880000'
}

function niceYStep(rangeMs: number): number {
  const rawSteps = [
    0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20,
    50, 100, 200, 500, 1000,
  ]
  const target = rangeMs / 12
  for (const candidate of rawSteps) {
    if (candidate >= target * 0.95) return candidate
  }
  return rawSteps[rawSteps.length - 1]
}

// Given SmokePing-style upper-limit (median_max * 1.2 from findmax), pick
// (step, yMax) to match rrdtool's rendering. Rules derived from observed
// reference behavior on .maxheight files vs rendered PNGs:
//   - Smallest step for which intervals = yMax/step ≤ 15.
//   - yMax = ceil(upper/step)*step when upper/ceil ≥ 0.985 (SmokePing snaps
//     up when the limit is within ~1.5% of the next nice value), otherwise
//     floor to the step below. This reproduces AP (2.112 → 2.0),
//     r2-EU (1.452 → 1.5), G/CF (1.617 → 1.6), Google (2.145 → 2.2),
//     EU-West (239.57 → 240).
function pickYScale(upperLimitMs: number): { step: number; yMax: number } {
  const rawSteps = [
    0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20,
    50, 100, 200, 500, 1000,
  ]
  const safe = Math.max(upperLimitMs, 1e-6)
  for (const step of rawSteps) {
    const intervals = safe / step
    if (intervals <= 15 + 1e-9) return { step, yMax: safe }
  }
  const step = rawSteps[rawSteps.length - 1]
  return { step, yMax: safe }
}

function formatYLabel(ms: number): string {
  if (ms === 0) return '0.0'
  if (ms < 10) return `${ms.toFixed(1)} m`
  if (ms < 1000) return `${ms.toFixed(0)} m`
  return `${(ms / 1000).toFixed(1)}`
}

function formatXLabel(ts: number, stepMs: number): string {
  const date = new Date(ts)
  if (stepMs < 24 * 3600 * 1000) {
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
  }
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`
}

function formatSmokeDate(date: Date): string {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const dow = weekdays[date.getUTCDay()]
  const mon = months[date.getUTCMonth()]
  const day = String(date.getUTCDate())
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  const ss = String(date.getUTCSeconds()).padStart(2, '0')
  const year = date.getUTCFullYear()
  return `${dow} ${mon} ${day} ${hh}:${mm}:${ss} ${year}`
}

export function renderNativeChartSvg(
  points: NativeChartPoint[],
  options: {
    height: number
    now: number
    rangeMs: number
    signature?: string
    title: string
    upperLimitMs?: number
    width: number
  },
): string {
  const width = options.width
  const height = options.height
  const padding = { bottom: 82, left: 66, right: 31, top: 13 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  // SmokePing's findmax uses the `median` DS across time windows; match that.
  const medianCandidates = points
    .map((point) => point.rttP50Ms)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const observedMaxRttMs = medianCandidates.length === 0 ? 10 : Math.max(...medianCandidates)
  const yMinMs = 0
  // Prefer an explicit SmokePing-style upper-limit when provided (findmax * 1.2
  // across time windows); else approximate from observed P90/avg with ~5% headroom.
  const upperForScale =
    options.upperLimitMs != null && options.upperLimitMs > 0
      ? options.upperLimitMs
      : observedMaxRttMs * 1.2
  const { step: yStep, yMax: yMaxMs } = pickYScale(upperForScale)
  const yScale = yMaxMs - yMinMs || 1
  const now = options.now
  const start = now - options.rangeMs

  const xOf = (timestamp: number): number =>
    padding.left + ((timestamp - start) / options.rangeMs) * chartWidth
  const yOf = (rttMs: number): number => {
    const clamped = Math.max(yMinMs, Math.min(yMaxMs, rttMs))
    return padding.top + 2 + (1 - (clamped - yMinMs) / yScale) * (chartHeight - 2)
  }

  const sortedByTime = points.slice().sort((a, b) => a.timestamp - b.timestamp)
  const gaps: number[] = []
  for (let i = 1; i < sortedByTime.length; i += 1) {
    gaps.push(sortedByTime[i].timestamp - sortedByTime[i - 1].timestamp)
  }
  gaps.sort((a, b) => a - b)
  const medianGapMs = gaps.length === 0 ? options.rangeMs / 60 : gaps[Math.floor(gaps.length / 2)]
  const avgGapMs = medianGapMs
  const barHalfMs = Math.max(avgGapMs / 2, options.rangeMs / 400)
  const gapThresholdMs = avgGapMs * 1.75

  const quantile = (sorted: number[], q: number): number => {
    if (sorted.length === 0) return 0
    const pos = (sorted.length - 1) * q
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    if (lo === hi) return sorted[lo]
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
  }

  // rrdtool draws AREA+STACK as a polygon bounded above by the upper-quantile
  // curve and below by the lower-quantile curve, connecting consecutive valid
  // points with straight segments. Missing samples (NaN) break the polygon so
  // we don't bridge across gaps.
  const bandBarsForIndices = (
    ibot: number,
    itop: number,
    pingSlots: number,
    fallbackLowerKey: 'rttMinMs' | 'rttP25Ms',
    fallbackUpperKey: 'rttMaxMs' | 'rttP75Ms' | 'rttP90Ms',
    fill: string,
  ): string => {
    const plotLeft = padding.left
    const plotRight = width - padding.right
    type BandPoint = { t: number; lo: number; hi: number }
    const runs: BandPoint[][] = []
    let run: BandPoint[] = []
    const flush = (): void => {
      if (run.length > 0) runs.push(run)
      run = []
    }
    for (let idx = 0; idx < sortedByTime.length; idx += 1) {
      const point = sortedByTime[idx]
      let lower: number | null | undefined
      let upper: number | null | undefined
      if (point.rttSamplesMs != null && point.rttSamplesMs.length > 0) {
        const sorted = point.rttSamplesMs.slice().sort((a, b) => a - b)
        const qLo = (ibot - 1) / (pingSlots - 1)
        const qHi = (itop - 1) / (pingSlots - 1)
        const pick = (q: number): number => {
          const pos = (sorted.length - 1) * q
          const lo = Math.floor(pos)
          const hi = Math.ceil(pos)
          return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
        }
        lower = pick(qLo)
        upper = pick(qHi)
      } else {
        lower = point[fallbackLowerKey]
        upper = point[fallbackUpperKey]
      }
      if (lower == null || upper == null || !Number.isFinite(lower) || !Number.isFinite(upper)) {
        flush()
        continue
      }
      if (run.length > 0 && point.timestamp - run[run.length - 1].t > gapThresholdMs) {
        flush()
      }
      // rrdtool's CDEF `cp<i> = if ping<i> < upper then ping<i> else INF` hides
      // any ping exceeding the chart's upper limit. Mirror that by clipping,
      // which keeps the polygon intact and capped at the chart top.
      const clippedUpper = Math.min(upper, yMaxMs)
      if (clippedUpper <= lower) {
        flush()
        continue
      }
      run.push({ t: point.timestamp, lo: lower, hi: clippedUpper })
    }
    flush()
    const rects: string[] = []
    for (const seg of runs) {
      for (const p of seg) {
        const xLeftRaw = Math.min(plotRight, Math.max(plotLeft, xOf(p.t - 2 * barHalfMs)))
        const xRightRaw = Math.min(plotRight, Math.max(plotLeft, xOf(p.t)))
        const xLeft = Math.round(xLeftRaw)
        const xRight = Math.round(xRightRaw)
        const w = xRight - xLeft
        if (w <= 0) continue
        const yHi = Math.round(yOf(p.hi))
        const yLo = Math.round(yOf(p.lo))
        const h = yLo - yHi
        if (h <= 0) continue
        rects.push(
          `<rect x="${xLeft}" y="${yHi}" width="${w}" height="${h}" fill="${fill}" shape-rendering="crispEdges" />`,
        )
      }
    }
    return rects.join('')
  }

  // SmokePing's smokecol() from Smokeping.pm: for pings=20, half=10, the loop
  // runs ibot=1..10 (itop=20..11) drawing a band from sorted ping[ibot] up to
  // ping[itop] with grayscale int(190/half*(half-ibot))+50. Innermost (ibot=10)
  // = #323232, outermost (ibot=1) = #DDDDDD.
  const smokePings = 20
  const smokeHalf = smokePings / 2
  const smokeBands: {
    ibot: number
    itop: number
    fallbackLo: 'rttMinMs' | 'rttP25Ms'
    fallbackHi: 'rttMaxMs' | 'rttP75Ms' | 'rttP90Ms'
    fill: string
  }[] = []
  for (let ibot = 1; ibot <= smokeHalf; ibot += 1) {
    const itop = smokePings + 1 - ibot
    const gray = Math.floor((190 / smokeHalf) * (smokeHalf - ibot)) + 50
    const hex = gray.toString(16).padStart(2, '0')
    const fallbackLo: 'rttMinMs' | 'rttP25Ms' = ibot === 1 ? 'rttMinMs' : 'rttP25Ms'
    const fallbackHi: 'rttMaxMs' | 'rttP75Ms' | 'rttP90Ms' =
      ibot === 1 ? 'rttMaxMs' : ibot <= 2 ? 'rttP90Ms' : 'rttP75Ms'
    smokeBands.push({ ibot, itop, fallbackLo, fallbackHi, fill: `#${hex}${hex}${hex}` })
  }
  const smokeBandsSvg = smokeBands
    .map((band) =>
      bandBarsForIndices(
        band.ibot,
        band.itop,
        smokePings,
        band.fallbackLo,
        band.fallbackHi,
        band.fill,
      ),
    )
    .join('')

  const sampleDots = ''

  // Intentionally no LINE1:median#202020. SmokePing.pm does reference a
  // `LINE1:median#202020` but in the rrdtool-rasterized reference PNGs this
  // line is not visibly rendered across adjacent bins — each bin's 2 px
  // colored AREA strip ends up adjacent to the next bin's strip without a
  // diagonal connector. Adding a diagonal `<line>` diverges from the
  // reference (raises fixture-diff mismatch by several percentage points),
  // and stands out especially at our sparse 15-minute sample cadence where
  // bins are ~87 px wide.
  const lineSegments: string[] = []

  // Per-sample colored median markers (Smokeping.pm:1397-1405). For each
  // sample, rrdtool stacks a 2-pixel-tall AREA at `median ± 1px` in the color
  // matching the sample's loss bucket. Defaults (for pings=20): 0→green,
  // 1→cyan, 2→blue, 3→purple, 4–5→magenta, 6–10→orange, 11–19→red, 20→dark.
  const lossBuckets: { maxLossPct: number; color: string }[] = [
    { maxLossPct: 0, color: '#26ff00' },
    { maxLossPct: 5, color: '#00b8ff' },
    { maxLossPct: 10, color: '#0059ff' },
    { maxLossPct: 15, color: '#7e00ff' },
    { maxLossPct: 25, color: '#ff00ff' },
    { maxLossPct: 50, color: '#ff5500' },
    { maxLossPct: 99.99, color: '#ff0000' },
    { maxLossPct: 100, color: '#a00000' },
  ]
  const lossColorFor = (pct: number | null): string => {
    const v = pct == null || !Number.isFinite(pct) ? 0 : pct
    for (const bucket of lossBuckets) {
      if (v <= bucket.maxLossPct + 1e-9) return bucket.color
    }
    return lossBuckets[lossBuckets.length - 1].color
  }
  const medianMarkers: string[] = []
  const plotLeftMarker = padding.left
  const plotRightMarker = width - padding.right
  for (const point of points) {
    const medianMs = point.rttP50Ms ?? point.rttAvgMs
    if (medianMs == null || !Number.isFinite(medianMs)) continue
    if (medianMs > yMaxMs) continue
    const xLeftRaw = Math.max(
      plotLeftMarker,
      Math.min(plotRightMarker, xOf(point.timestamp - 2 * barHalfMs)),
    )
    const xRightRaw = Math.max(plotLeftMarker, Math.min(plotRightMarker, xOf(point.timestamp)))
    const xLeft = Math.round(xLeftRaw)
    const xRight = Math.round(xRightRaw)
    const w = xRight - xLeft
    if (w <= 0) continue
    const yMid = Math.round(yOf(medianMs))
    const color = lossColorFor(point.destinationLossPct)
    medianMarkers.push(
      `<rect x="${xLeft}" y="${yMid - 1}" width="${w}" height="2" fill="${color}" shape-rendering="crispEdges" />`,
    )
  }
  const medianMarkersSvg = medianMarkers.join('')

  const yTicks: number[] = []
  for (let value = yMinMs; value <= yMaxMs + 1e-9; value += yStep) {
    yTicks.push(Number(value.toFixed(6)))
  }
  const yGrid = yTicks
    .map((value) => {
      const y = Math.round(yOf(value))
      return `<line x1="${padding.left + 1}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#f3bfbf" stroke-width="1" stroke-dasharray="1,1" shape-rendering="crispEdges" />`
    })
    .join('')
  const yMinorPixelStep = (yStep / 2) * ((chartHeight - 2) / yScale)
  const yMinorValues: number[] = []
  if (yMinorPixelStep >= 8) {
    for (let value = yMinMs + yStep / 2; value < yMaxMs; value += yStep) {
      yMinorValues.push(value)
    }
  }
  const yMinorGrid = yMinorValues
    .map((value) => {
      const y = Math.round(yOf(value))
      return `<line x1="${padding.left + 2}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#dddddd" stroke-width="1" stroke-dasharray="1,1" shape-rendering="crispEdges" />`
    })
    .join('')
  const yTickMarks = yTicks
    .map((value) => {
      const y = yOf(value)
      return `<line x1="${padding.left - 3}" y1="${y.toFixed(2)}" x2="${padding.left}" y2="${y.toFixed(2)}" stroke="#333" stroke-width="0.8" />`
    })
    .join('')
  const yMinorTicks: string[] = []
  for (let value = yMinMs; value <= yMaxMs + 1e-9; value += yStep / 5) {
    if (Math.abs(value / yStep - Math.round(value / yStep)) < 1e-6) continue
    const y = yOf(value)
    yMinorTicks.push(
      `<line x1="${padding.left - 2}" y1="${y.toFixed(2)}" x2="${padding.left}" y2="${y.toFixed(2)}" stroke="#666" stroke-width="0.5" />`,
    )
  }
  const yLabels = yTicks
    .map((value) => {
      const y = yOf(value)
      return `<text x="${padding.left - 5}" y="${(y + 3).toFixed(2)}" font-size="10" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333" text-anchor="end">${formatYLabel(value)}</text>`
    })
    .join('')

  const xGridStepMs =
    options.rangeMs <= 4 * 3600 * 1000
      ? 20 * 60 * 1000
      : options.rangeMs <= 36 * 3600 * 1000
        ? 4 * 3600 * 1000
        : options.rangeMs <= 12 * 24 * 3600 * 1000
          ? 24 * 3600 * 1000
          : 30 * 24 * 3600 * 1000
  const xGridFirst = Math.ceil(start / xGridStepMs) * xGridStepMs
  const xGridLines: string[] = []
  const xTickMarks: string[] = []
  const xLabels: string[] = []
  for (let gridT = xGridFirst; gridT <= now; gridT += xGridStepMs) {
    const x = xOf(gridT)
    xGridLines.push(
      `<line x1="${x.toFixed(2)}" y1="${padding.top}" x2="${x.toFixed(2)}" y2="${(padding.top + chartHeight).toFixed(2)}" stroke="#f3bfbf" stroke-width="1" stroke-dasharray="1,1" shape-rendering="crispEdges" />`,
    )
    xTickMarks.push(
      `<line x1="${x.toFixed(2)}" y1="${(padding.top + chartHeight).toFixed(2)}" x2="${x.toFixed(2)}" y2="${(padding.top + chartHeight + 3).toFixed(2)}" stroke="#333" stroke-width="0.8" />`,
    )
    xLabels.push(
      `<text x="${x.toFixed(2)}" y="${(padding.top + chartHeight + 13).toFixed(2)}" font-size="10" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333" text-anchor="middle">${formatXLabel(gridT, xGridStepMs)}</text>`,
    )
  }
  const xMinorStepMs = xGridStepMs / 4
  const xMinorFirst = Math.ceil(start / xMinorStepMs) * xMinorStepMs
  const xMinorTicks: string[] = []
  const xMinorGridLines: string[] = []
  for (let minorT = xMinorFirst; minorT <= now; minorT += xMinorStepMs) {
    if (Math.abs(minorT / xGridStepMs - Math.round(minorT / xGridStepMs)) < 1e-6) continue
    const x = xOf(minorT)
    xMinorTicks.push(
      `<line x1="${x.toFixed(2)}" y1="${(padding.top + chartHeight).toFixed(2)}" x2="${x.toFixed(2)}" y2="${(padding.top + chartHeight + 2).toFixed(2)}" stroke="#666" stroke-width="0.5" />`,
    )
    xMinorGridLines.push(
      `<line x1="${x.toFixed(2)}" y1="${padding.top}" x2="${x.toFixed(2)}" y2="${(padding.top + chartHeight).toFixed(2)}" stroke="#dddddd" stroke-width="1" stroke-dasharray="1,1" shape-rendering="crispEdges" />`,
    )
  }
  const xGrid = xGridLines.join('')
  const xMinorGrid = xMinorGridLines.join('')
  const xLabelsSvg = xLabels.join('')

  // SmokePing stats use the median DS exclusively (VDEF over `median` with
  // AVERAGE/MAXIMUM/MINIMUM/LAST/STDEV). Fall back to rttAvgMs only when no
  // P50 data is present anywhere, not per-point.
  const medianOnly = points
    .map((p) => p.rttP50Ms)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const medianValues =
    medianOnly.length > 0
      ? medianOnly
      : points.map((p) => p.rttAvgMs).filter((v): v is number => v != null)
  const lossValues = points.map((p) => p.destinationLossPct).filter((v): v is number => v != null)
  const agg = (vals: number[], fn: (v: number[]) => number): string =>
    vals.length === 0 ? 'n/a' : fn(vals).toFixed(1)
  const avgOf = (vals: number[]): number => vals.reduce((s, v) => s + v, 0) / vals.length
  const lastOf = <T>(vals: T[]): T => vals[vals.length - 1]
  const rttAvg = agg(medianValues, avgOf)
  const rttMax = agg(medianValues, (v) => Math.max(...v))
  const rttMin = agg(medianValues, (v) => Math.min(...v))
  const rttNow = agg(medianValues, lastOf)
  const sdOf = (v: number[]): number => {
    if (v.length < 2) return 0
    const mean = avgOf(v)
    const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length
    return Math.sqrt(variance)
  }
  const rttSd = agg(medianValues, sdOf)
  const rttSdRaw = medianValues.length < 2 ? null : sdOf(medianValues)
  const rttAvgRaw = medianValues.length === 0 ? null : avgOf(medianValues)
  const formatAmPerS = (avg: number | null, sd: number | null): string => {
    if (avg == null || sd == null || sd === 0 || !Number.isFinite(sd)) return '-nan'
    const ratio = avg / sd
    if (!Number.isFinite(ratio)) return '-nan'
    if (Math.abs(ratio) >= 1_000_000) return `${(ratio / 1_000_000).toFixed(1)} M`
    if (Math.abs(ratio) >= 1000) return `${(ratio / 1000).toFixed(1)} k`
    return ratio.toFixed(1)
  }
  const rttAmPerS = formatAmPerS(rttAvgRaw, rttSdRaw)
  const lossAvg = lossValues.length === 0 ? 'n/a' : avgOf(lossValues).toFixed(2)
  const lossMax = lossValues.length === 0 ? 'n/a' : Math.max(...lossValues).toFixed(2)
  const lossMin = lossValues.length === 0 ? 'n/a' : Math.min(...lossValues).toFixed(2)
  const lossNow = lossValues.length === 0 ? 'n/a' : lastOf(lossValues).toFixed(2)

  const statsFontSize = 10
  const statsFontFamily = 'DejaVu Sans Mono,Menlo,Consolas,monospace'
  // SmokePing's default loss_colors for pings=20 (from Smokeping.pm:1300).
  // Buckets are 0, 1, 2, 3, 4-5, 6-10, 11-19, 20/20.
  const lossSwatches = [
    { color: '#26ff00', label: '0' },
    { color: '#00b8ff', label: '1' },
    { color: '#0059ff', label: '2' },
    { color: '#7e00ff', label: '3' },
    { color: '#ff00ff', label: '4-5' },
    { color: '#ff5500', label: '6-10' },
    { color: '#ff0000', label: '11-19' },
    { color: '#a00000', label: '20/20' },
  ]
  const legendY = padding.top + chartHeight + 58
  const legendStartX = padding.left + 84
  const maxProbes = Math.max(
    0,
    ...points.map((p) => (p.rttSamplesMs == null ? 0 : p.rttSamplesMs.length)),
  )
  const probeCountLabel =
    maxProbes === 0
      ? ''
      : `<text x="${legendStartX + lossSwatches.length * 46 + 4}" y="${legendY + 1}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333">${maxProbes}/${maxProbes}</text>`
  const legendSwatches =
    lossSwatches
      .map((swatch, index) => {
        const x = legendStartX + index * 46
        return `<rect x="${x}" y="${legendY - 8}" width="10" height="10" fill="${swatch.color}" /><text x="${x + 13}" y="${legendY + 1}" font-size="9" font-family="${statsFontFamily}" fill="#333">${swatch.label}</text>`
      })
      .join('') + probeCountLabel

  // Column positions measured against rrdtool/SmokePing reference PNGs at 697×297.
  // See docs/mtr-fixtures/real-ap/images/General/Cloudflare_last_10800.png.
  const statsLabelRightX = padding.left + 23
  const statsColStart = padding.left + 32
  const statsColWidth = 86
  const statsNumberWidth = 28
  const statsLine1Y = padding.top + chartHeight + 30
  const statsLine2Y = padding.top + chartHeight + 44
  const mkStatsCols = (values: string[], unit: string, labels: string[], y: number): string =>
    values
      .map((value, index) => {
        const numRightX = statsColStart + index * statsColWidth + statsNumberWidth
        const tailX = numRightX + 8
        return `<text x="${numRightX}" y="${y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333" text-anchor="end">${value}</text><text x="${tailX}" y="${y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333">${unit} ${labels[index]}</text>`
      })
      .join('')
  const statsTitle1 = `<text x="${statsLabelRightX}" y="${statsLine1Y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" font-weight="bold" fill="#333" text-anchor="end">median rtt:</text>`
  const statsLine1 = mkStatsCols(
    [rttAvg, rttMax, rttMin, rttNow, rttSd],
    'ms',
    ['avg', 'max', 'min', 'now', 'sd'],
    statsLine1Y,
  )
  const amPerSNumRightX = padding.left + 476
  const amPerSUnitX = padding.left + 514
  const statsLine1AmPerS = `<text x="${amPerSNumRightX}" y="${statsLine1Y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333" text-anchor="end">${rttAmPerS}</text><text x="${amPerSUnitX}" y="${statsLine1Y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333">am/s</text>`
  const statsTitle2 = `<text x="${statsLabelRightX}" y="${statsLine2Y}" font-size="${statsFontSize}" font-family="${statsFontFamily}" font-weight="bold" fill="#333" text-anchor="end">packet loss:</text>`
  const statsLine2 = mkStatsCols(
    [lossAvg, lossMax, lossMin, lossNow],
    '%',
    ['avg', 'max', 'min', 'now'],
    statsLine2Y,
  )
  const statsLegendLabel = `<text x="${statsLabelRightX}" y="${legendY + 1}" font-size="${statsFontSize}" font-family="${statsFontFamily}" font-weight="bold" fill="#333" text-anchor="end">loss color:</text>`

  const probeLineY = legendY + 14
  const probeLineLabel = `<text x="${statsLabelRightX}" y="${probeLineY}" font-size="${statsFontSize}" font-family="${statsFontFamily}" font-weight="bold" fill="#333" text-anchor="end">probe:</text>`
  const probeLineText =
    maxProbes === 0
      ? ''
      : `<text x="${legendStartX}" y="${probeLineY}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333">${maxProbes} ICMP Echo Pings (56 Bytes) every ${Math.round(avgGapMs / 1000)}s</text>`
  const renderStamp = formatSmokeDate(new Date(now))
  const renderStampText = `<text x="${width - padding.right}" y="${probeLineY}" font-size="${statsFontSize}" font-family="${statsFontFamily}" fill="#333" text-anchor="end">${renderStamp}</text>`

  const plotBorder = `<line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="#777777" stroke-width="1" shape-rendering="crispEdges" /><line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="#000" stroke-width="1" shape-rendering="crispEdges" />`

  const plotRightX = width - padding.right
  const plotBottomY = padding.top + chartHeight
  const xArrow = `<polygon points="${plotRightX + 8},${plotBottomY} ${plotRightX + 3},${plotBottomY - 3} ${plotRightX + 3},${plotBottomY + 3}" fill="#555" />`
  const yArrow = `<polygon points="${padding.left},${padding.top - 8} ${padding.left - 3},${padding.top - 3} ${padding.left + 3},${padding.top - 3}" fill="#555" />`

  const signatureText = options.signature ?? 'RRDTOOL / TOBI OETIKER'
  const rrdSig =
    signatureText === ''
      ? ''
      : `<text x="${width - 3}" y="${padding.top + chartHeight / 2}" font-size="8" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#999" text-anchor="middle" transform="rotate(-90 ${width - 3} ${padding.top + chartHeight / 2})">${escapeHtml(signatureText)}</text>`

  const secondsLabel = `<text x="12" y="${padding.top + chartHeight / 2}" font-size="10" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace" fill="#333" text-anchor="middle" transform="rotate(-90 12 ${padding.top + chartHeight / 2})">Seconds</text>`

  const plotClipId = 'mtr-plot-clip'
  const plotClip = `<clipPath id="${plotClipId}"><rect x="${padding.left}" y="${padding.top}" width="${chartWidth}" height="${chartHeight}" /></clipPath>`

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}" class="chart-svg" font-family="DejaVu Sans Mono,Menlo,Consolas,monospace">
  <defs>${plotClip}</defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  <g clip-path="url(#${plotClipId})">
  ${smokeBandsSvg}
  </g>
  ${yMinorGrid}
  ${xMinorGrid}
  ${yGrid}
  ${xGrid}
  <g clip-path="url(#${plotClipId})">
  ${sampleDots}
  ${lineSegments.join('')}
  ${medianMarkersSvg}
  </g>
  ${plotBorder}
  ${xArrow}
  ${yArrow}
  ${rrdSig}
  ${yTickMarks}
  ${yMinorTicks.join('')}
  ${xTickMarks.join('')}
  ${xMinorTicks.join('')}
  ${yLabels}
  ${xLabelsSvg}
  ${secondsLabel}
  ${statsTitle1}
  ${statsLine1}
  ${statsLine1AmPerS}
  ${statsTitle2}
  ${statsLine2}
  ${statsLegendLabel}
  ${legendSwatches}
  ${probeLineLabel}
  ${probeLineText}
  ${renderStampText}
</svg>`
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function summarizeSnapshots(
  snapshots: SnapshotSummary[],
  now: number,
  windowMs: number,
): SnapshotAggregate {
  const cutoff = now - windowMs
  const inWindow = snapshots.filter((snapshot) => {
    const timestamp = parseCollectedAt(snapshot.collectedAt)
    return timestamp != null && timestamp >= cutoff
  })

  return {
    averageDestinationLossPct: average(
      inWindow.flatMap((snapshot) =>
        snapshot.destinationLossPct == null ? [] : [snapshot.destinationLossPct],
      ),
    ),
    averageWorstHopLossPct: average(
      inWindow.flatMap((snapshot) =>
        snapshot.worstHopLossPct == null ? [] : [snapshot.worstHopLossPct],
      ),
    ),
    sampleCount: inWindow.length,
  }
}

function summarizeDiagnoses(
  snapshots: SnapshotSummary[],
  now: number,
  windowMs: number,
): DiagnosisAggregate {
  const cutoff = now - windowMs
  const aggregate: DiagnosisAggregate = {
    destinationLossCount: 0,
    healthyCount: 0,
    intermediateOnlyCount: 0,
    sampleCount: 0,
    unknownCount: 0,
  }

  for (const snapshot of snapshots) {
    const timestamp = parseCollectedAt(snapshot.collectedAt)
    if (timestamp == null || timestamp < cutoff) {
      continue
    }

    aggregate.sampleCount += 1
    if (snapshot.diagnosis.kind === 'destination_loss') {
      aggregate.destinationLossCount += 1
    } else if (snapshot.diagnosis.kind === 'healthy') {
      aggregate.healthyCount += 1
    } else if (snapshot.diagnosis.kind === 'intermediate_only_loss') {
      aggregate.intermediateOnlyCount += 1
    } else {
      aggregate.unknownCount += 1
    }
  }

  return aggregate
}

function getHistoricalSeverityBadge(
  aggregate: SnapshotAggregate,
  diagnosisAggregate: DiagnosisAggregate,
): SeverityBadge {
  if (diagnosisAggregate.sampleCount === 0) {
    return {
      className: 'unknown',
      label: 'Unknown',
      summary: 'No snapshots were collected in this window.',
    }
  }

  if (diagnosisAggregate.destinationLossCount === 0) {
    return {
      className: 'good',
      label: 'Stable',
      summary: 'No destination loss was observed in the last 7 days.',
    }
  }

  const destinationLossRate =
    diagnosisAggregate.destinationLossCount / diagnosisAggregate.sampleCount
  if (destinationLossRate >= 0.2 || (aggregate.averageDestinationLossPct ?? 0) >= 10) {
    return {
      className: 'bad',
      label: 'Degraded',
      summary:
        'Destination loss is frequent enough in the last 7 days to treat this path as degraded.',
    }
  }

  return {
    className: 'warn',
    label: 'Flaky',
    summary:
      'Destination loss is intermittent in the last 7 days, but not frequent enough to call the path degraded.',
  }
}

function summarizeHopIssues(
  snapshots: SnapshotSummary[],
  now: number,
  windowMs: number,
): HopAggregate[] {
  const cutoff = now - windowMs
  const hopMap = new Map<string, HopAggregate>()

  for (const snapshot of snapshots) {
    const timestamp = parseCollectedAt(snapshot.collectedAt)
    if (timestamp == null || timestamp < cutoff) {
      continue
    }

    const destinationLossPct = snapshot.destinationLossPct ?? 0
    for (const hop of snapshot.hops.slice(0, -1)) {
      if (hop.lossPct <= 0) {
        continue
      }

      const existing = hopMap.get(hop.host) ?? {
        averageLossPct: null,
        downstreamLossCount: 0,
        host: hop.host,
        isolatedLossCount: 0,
        latestHopIndex: null,
        sampleCount: 0,
      }

      const totalLoss = (existing.averageLossPct ?? 0) * existing.sampleCount + hop.lossPct
      existing.sampleCount += 1
      existing.averageLossPct = totalLoss / existing.sampleCount
      existing.latestHopIndex = hop.index
      if (destinationLossPct > 0) {
        existing.downstreamLossCount += 1
      } else {
        existing.isolatedLossCount += 1
      }

      hopMap.set(hop.host, existing)
    }
  }

  return [...hopMap.values()].sort((left, right) => {
    return (
      right.downstreamLossCount - left.downstreamLossCount ||
      (right.averageLossPct ?? 0) - (left.averageLossPct ?? 0) ||
      right.sampleCount - left.sampleCount
    )
  })
}

function shouldSurfaceHopIssueForRoot(hopIssue: HopAggregate): boolean {
  if (hopIssue.host.trim() === '' || hopIssue.host === '???') {
    return false
  }

  return (
    hopIssue.downstreamLossCount >= 2 && hopIssue.downstreamLossCount >= hopIssue.isolatedLossCount
  )
}

function getRootSuspectHop(hopIssues: HopAggregate[]): HopAggregate | null {
  return hopIssues.find(shouldSurfaceHopIssueForRoot) ?? null
}

function renderLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f6f1;
      --panel: #fffdf6;
      --text: #1d2a20;
      --muted: #58635b;
      --line: #d9ddcf;
      --good: #245c2a;
      --warn: #915f00;
      --bad: #9f1d1d;
      --accent: #184d47;
      --code: #edf1e5;
      --scale-0: #245c2a;
      --scale-1: #56711c;
      --scale-2: #857000;
      --scale-3: #a15b00;
      --scale-4: #b04611;
      --scale-5: #9f1d1d;
    }

    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: linear-gradient(180deg, #f1f1ea 0%, var(--bg) 100%);
      color: var(--text);
    }

    main {
      max-width: 1480px;
      margin: 0 auto;
      padding: 32px 20px 56px;
    }

    h1, h2 {
      margin: 0 0 12px;
      line-height: 1.1;
    }

    p, li {
      line-height: 1.5;
    }

    a {
      color: var(--accent);
    }

    .topnav {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 16px;
      margin: -32px -20px 24px;
      padding: 10px 20px;
      background: rgba(255, 253, 246, 0.88);
      backdrop-filter: saturate(1.3) blur(10px);
      -webkit-backdrop-filter: saturate(1.3) blur(10px);
      border-bottom: 1px solid var(--line);
      box-shadow: 0 6px 18px rgba(17, 24, 20, 0.05);
    }

    .topnav-group {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .topnav-group--left {
      flex: 1 1 auto;
    }

    .topnav-group--right {
      flex: 0 0 auto;
      margin-left: auto;
    }

    .topnav-title {
      flex: 0 1 auto;
      min-width: 0;
      font-weight: 700;
      font-size: 14px;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .topnav-back {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border-radius: 8px;
      text-decoration: none;
      color: var(--accent);
      font-size: 13px;
      font-weight: 600;
    }

    .topnav-back:hover {
      background: rgba(24, 77, 71, 0.08);
    }

    .topnav-back-arrow {
      font-size: 16px;
      line-height: 1;
    }

    .topnav-dropdown {
      position: relative;
      font-size: 13px;
    }

    .topnav-dropdown > summary {
      list-style: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfaf4;
      color: var(--accent);
      font-weight: 600;
      user-select: none;
    }

    .topnav-dropdown > summary::-webkit-details-marker {
      display: none;
    }

    .topnav-dropdown > summary:hover {
      background: #f2efe4;
    }

    .topnav-dropdown[open] > summary {
      background: var(--accent);
      border-color: var(--accent);
      color: #f7f7f1;
    }

    .topnav-label {
      color: var(--muted);
      font-weight: 500;
    }

    .topnav-dropdown[open] .topnav-label {
      color: rgba(247, 247, 241, 0.75);
    }

    .topnav-value {
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .topnav-caret {
      font-size: 10px;
      line-height: 1;
    }

    .topnav-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      min-width: 220px;
      display: flex;
      flex-direction: column;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
      box-shadow: 0 14px 32px rgba(17, 24, 20, 0.12);
      z-index: 30;
    }

    .topnav-menu--right {
      left: auto;
      right: 0;
    }

    .topnav-menu-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 10px;
      border-radius: 6px;
      text-decoration: none;
      color: var(--text);
      font-size: 13px;
    }

    .topnav-menu-item:hover {
      background: var(--code);
    }

    .topnav-menu-item.is-active {
      background: rgba(24, 77, 71, 0.1);
      color: var(--accent);
      font-weight: 600;
    }

    .topnav-menu-label {
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 12px;
    }

    .topnav-menu-host {
      font-size: 11px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }

    .topnav-menu-item.is-active .topnav-menu-host {
      color: var(--accent);
    }

    .lede {
      color: var(--muted);
      margin-bottom: 24px;
    }

    .status-age {
      color: var(--muted);
      font-weight: 500;
      white-space: nowrap;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px 20px;
      box-shadow: 0 10px 24px rgba(17, 24, 20, 0.04);
      margin-bottom: 20px;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
    }

    .summary-card {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.5);
      padding: 12px 14px;
    }

    .summary-card strong {
      display: block;
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 4px;
    }

    .graph-grid {
      display: grid;
      gap: 14px;
    }

    .graph-grid--mini {
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }

    .graph-grid--root {
      grid-template-columns: 1fr;
    }

    .graph-card {
      display: block;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.6);
      padding: 12px;
      text-decoration: none;
      color: inherit;
      box-shadow: 0 8px 18px rgba(17, 24, 20, 0.04);
    }

    .graph-card h3 {
      margin: 0 0 8px;
      font-size: 15px;
      line-height: 1.2;
    }

    .graph-card img {
      display: block;
      width: 100%;
      height: auto;
      border-radius: 10px;
      background: #f3f5ee;
      border: 1px solid rgba(29, 42, 32, 0.08);
    }

    .chart-svg {
      display: block;
      width: 100%;
      height: auto;
      border-radius: 10px;
    }

    .thumb-link {
      display: block;
      min-width: 158px;
    }

    .thumb-link img {
      display: none;
    }

    .thumb-link svg {
      display: block;
      width: 158px;
      max-width: 100%;
      height: 42px;
      border-radius: 6px;
    }

    .graph-caption {
      margin-top: 8px;
      font-size: 12px;
      color: var(--muted);
    }

    .target-meta {
      margin-bottom: 18px;
    }

    time[data-collected-at] {
      white-space: nowrap;
    }

    .table-wrap {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      margin: 0 -4px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    th, td {
      text-align: left;
      padding: 10px 8px;
      border-top: 1px solid var(--line);
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-weight: 600;
      border-top: 0;
      padding-top: 0;
      white-space: nowrap;
    }

    code, pre {
      font-family: ui-monospace, SFMono-Regular, monospace;
    }

    pre {
      background: var(--code);
      border-radius: 12px;
      padding: 14px;
      overflow-x: auto;
      max-width: 100%;
      font-size: 12px;
      line-height: 1.45;
    }

    .scroll-x {
      max-width: 100%;
      overflow-x: auto;
    }

    .panel-hint {
      color: var(--muted);
      font-size: 13px;
      margin: 4px 0 10px;
    }

    details.raw-events {
      margin-top: 12px;
    }

    details.raw-events > summary {
      cursor: pointer;
      color: var(--accent);
      font-size: 13px;
    }

    .loss {
      font-weight: 700;
    }

    .loss.good {
      color: var(--good);
    }

    .loss.warn {
      color: var(--warn);
    }

    .loss.bad {
      color: var(--bad);
    }

    .loss.unknown {
      color: var(--muted);
    }

    .loss.scale-0 {
      color: var(--scale-0);
    }

    .loss.scale-1 {
      color: var(--scale-1);
    }

    .loss.scale-2 {
      color: var(--scale-2);
    }

    .loss.scale-3 {
      color: var(--scale-3);
    }

    .loss.scale-4 {
      color: var(--scale-4);
    }

    .loss.scale-5 {
      color: var(--scale-5);
    }

    @media (max-width: 760px) {
      main {
        padding: 20px 14px 40px;
      }

      .topnav {
        margin: -20px -14px 16px;
        padding: 8px 14px;
        gap: 10px;
      }

      .topnav-title {
        display: none;
      }

      .topnav-group {
        gap: 8px;
      }

      .topnav-menu {
        min-width: 180px;
      }

      .panel {
        padding: 14px 12px;
        border-radius: 12px;
      }

      h1 {
        font-size: 26px;
        overflow-wrap: anywhere;
      }

      th, td {
        padding: 8px 6px;
      }

      pre {
        font-size: 11px;
        padding: 10px;
      }
    }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
  <script>
    (() => {
      const formatRelative = (value) => {
        const match = value.match(/^(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z$/)
        if (!match) return value
        const [, year, month, day, hours, minutes, seconds] = match
        const timestamp = Date.UTC(
          Number(year),
          Number(month) - 1,
          Number(day),
          Number(hours),
          Number(minutes),
          Number(seconds),
        )
        const diffSeconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000))
        if (diffSeconds < 60) return \`\${diffSeconds}s ago\`
        const diffMinutes = Math.round(diffSeconds / 60)
        if (diffMinutes < 60) return \`\${diffMinutes}m ago\`
        const diffHours = Math.round(diffMinutes / 60)
        if (diffHours < 24) return \`\${diffHours}h ago\`
        const diffDays = Math.round(diffHours / 24)
        return \`\${diffDays}d ago\`
      }

      const updateTimes = () => {
        for (const element of document.querySelectorAll('[data-collected-at]')) {
          const collectedAt = element.getAttribute('data-collected-at')
          if (!collectedAt) continue
          const relative = formatRelative(collectedAt)
          element.textContent = element.getAttribute('data-relative-wrap') === 'parens'
            ? \`(\${relative})\`
            : relative
        }
      }

      updateTimes()
      window.setInterval(updateTimes, 30000)
    })()
  </script>
</body>
</html>
`
}

function renderNativeChartCard(
  chart: NativeChartDefinition,
  now: number,
  {
    compact = false,
    signature,
  }: {
    compact?: boolean
    signature?: string
  } = {},
): string {
  const width = compact ? 158 : 770
  const height = compact ? 42 : 340
  const rangeHours =
    chart.rangeLabel === '3h'
      ? 3
      : chart.rangeLabel === '30h'
        ? 30
        : chart.rangeLabel === '10d'
          ? 10 * 24
          : 360 * 24

  const svg = renderNativeChartSvg(chart.points, {
    height,
    now,
    rangeMs: rangeHours * 60 * 60 * 1000,
    signature,
    title: `${chart.label} latency and loss`,
    width,
  })

  if (compact) {
    return svg
  }

  return `<div class="graph-card">
    <h3>${escapeHtml(chart.label)}</h3>
    ${svg}
    <div class="graph-caption">Native latency/loss chart rendered from ${escapeHtml(chart.sourceLabel)}.</div>
  </div>`
}

async function listTargetSnapshots(targetDir: string): Promise<SnapshotSummary[]> {
  const entries = await readdir(targetDir, { withFileTypes: true })
  const snapshotFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .filter(
      (entry) =>
        !['latest.json', 'hourly.rollup.json', 'daily.rollup.json', 'alert-state.json'].includes(
          entry,
        ),
    )
    .sort()
    .reverse()

  const snapshots: SnapshotSummary[] = []
  for (const fileName of snapshotFiles) {
    snapshots.push(await readSnapshotSummary(targetDir, fileName))
  }

  return snapshots
}

async function writeTargetIndex(
  targetDir: string,
  peers: PeerConfig[],
  selfLabel: string,
  targetSlug: string,
  now = Date.now(),
  signature?: string,
): Promise<SnapshotSummary | null> {
  const snapshots = await listTargetSnapshots(targetDir)
  if (snapshots.length === 0) {
    return null
  }

  const latestSnapshot = snapshots[0]
  const lastDay = summarizeSnapshots(snapshots, now, 24 * 60 * 60 * 1000)
  const lastWeek = summarizeSnapshots(snapshots, now, 7 * 24 * 60 * 60 * 1000)
  const hopIssues = summarizeHopIssues(snapshots, now, 7 * 24 * 60 * 60 * 1000).slice(0, 5)
  const hopIssueRows =
    hopIssues.length === 0
      ? `<tr><td colspan="5">No recurring intermediate-hop loss in the last 7 days.</td></tr>`
      : hopIssues
          .map(
            (hopIssue) => `<tr>
  <td><code>${escapeHtml(hopIssue.host)}</code></td>
  <td>${hopIssue.latestHopIndex ?? 'n/a'}</td>
  <td><span class="loss ${getLossClass(hopIssue.averageLossPct)}">${escapeHtml(formatLoss(hopIssue.averageLossPct))}</span></td>
  <td>${hopIssue.downstreamLossCount}</td>
  <td>${hopIssue.isolatedLossCount}</td>
</tr>`,
          )
          .join('\n')
  const hopRows = latestSnapshot.hops
    .map(
      (hop) => `<tr>
  <td>${hop.index}</td>
  <td><code>${escapeHtml(hop.host)}</code>${hop.asn ? `<br /><span>${escapeHtml(hop.asn)}</span>` : ''}</td>
  <td><span class="loss ${getLossClass(hop.lossPct)}">${escapeHtml(formatLoss(hop.lossPct))}</span></td>
  <td>${hop.sent ?? 'n/a'}</td>
  <td>${hop.avgMs?.toFixed(1) ?? 'n/a'}</td>
  <td>${hop.bestMs?.toFixed(1) ?? 'n/a'}</td>
  <td>${hop.worstMs?.toFixed(1) ?? 'n/a'}</td>
</tr>`,
    )
    .join('\n')
  const nativeCharts = await loadChartDefinitions(targetDir, snapshots, now)
  const [mainChart, ...secondaryCharts] = nativeCharts
  const historyPanel = `<section class="panel" id="history">
  <h2>Latency and loss history</h2>
  <div class="graph-grid">
    ${renderNativeChartCard(mainChart, now, { signature })}
    <div class="graph-grid graph-grid--mini">
      ${secondaryCharts.map((chart) => renderNativeChartCard(chart, now, { signature })).join('\n')}
    </div>
  </div>
</section>`
  const html = renderLayout(
    `MTR History for ${latestSnapshot.target}`,
    `
${renderTopNav({
  backHref: '../',
  backLabel: 'All targets',
  peers,
  selfLabel,
  pathSuffix: `/${encodeURIComponent(targetSlug)}/`,
  sections: [
    { href: '#summary', label: 'Summary' },
    { href: '#history', label: 'Latency & loss history' },
    { href: '#raw', label: 'Latest raw output' },
    { href: '#diagnosis', label: 'Latest diagnosis' },
    { href: '#problematic-hops', label: 'Problematic hops (7d)' },
    { href: '#hop-path', label: 'Latest hop path' },
    { href: '#snapshots', label: 'Recent snapshots' },
  ],
  title: latestSnapshot.target,
})}
<h1>${escapeHtml(latestSnapshot.target)}</h1>
<p class="lede target-meta">Observer snapshot archive for <code>${escapeHtml(targetSlug)}</code>. Host: <code>${escapeHtml(latestSnapshot.host)}</code>. Probe: <code>${escapeHtml(latestSnapshot.probeMode)}</code>. Destination loss is the last hop only; worst hop loss may include intermediate router reply rate limiting.</p>
<section class="panel" id="summary">
  <h2>Summary</h2>
  <div class="summary-grid">
    <div class="summary-card">
      <strong>Latest status</strong>
      <span class="loss ${getDiagnosisClass(latestSnapshot.diagnosis)}">${escapeHtml(latestSnapshot.diagnosis.label)}</span>
    </div>
    <div class="summary-card">
      <strong>Last 24 hours</strong>
      <span class="loss ${getLossClass(lastDay.averageDestinationLossPct)}">${escapeHtml(formatLoss(lastDay.averageDestinationLossPct))}</span>
      <div>${lastDay.sampleCount} samples</div>
    </div>
    <div class="summary-card">
      <strong>Last 7 days</strong>
      <span class="loss ${getLossClass(lastWeek.averageDestinationLossPct)}">${escapeHtml(formatLoss(lastWeek.averageDestinationLossPct))}</span>
      <div>${lastWeek.sampleCount} samples</div>
    </div>
    <div class="summary-card">
      <strong>Average worst hop loss</strong>
      <span class="loss ${getLossClass(lastWeek.averageWorstHopLossPct)}">${escapeHtml(formatLoss(lastWeek.averageWorstHopLossPct))}</span>
      <div>7-day window</div>
    </div>
  </div>
</section>
${historyPanel}
<section class="panel" id="raw">
  <h2>Latest raw output</h2>
  <p class="panel-hint">Reconstructed <code>mtr --report</code> view of the newest snapshot. The full per-probe event stream is stored as JSON — expand below or grab the file.</p>
  <pre class="scroll-x">${escapeHtml(latestSnapshot.rawText)}</pre>
  <p class="panel-hint">Download the full JSON snapshot: <a href="./${encodeURIComponent(latestSnapshot.fileName)}">${escapeHtml(latestSnapshot.fileName)}</a></p>
</section>
<section class="panel" id="diagnosis">
  <h2>Latest diagnosis</h2>
  <p><span class="loss ${getDiagnosisClass(latestSnapshot.diagnosis)}">${escapeHtml(latestSnapshot.diagnosis.label)}</span></p>
  <p>${renderDiagnosisSummary(latestSnapshot.diagnosis.summary, latestSnapshot.hops)}</p>
</section>
<section class="panel" id="problematic-hops">
  <h2>Recurring problematic hops (7d)</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Hop</th>
          <th>Latest index</th>
          <th>Average loss when seen</th>
          <th>Snapshots with downstream loss</th>
          <th>Snapshots with isolated loss</th>
        </tr>
      </thead>
      <tbody>
        ${hopIssueRows}
      </tbody>
    </table>
  </div>
</section>
<section class="panel" id="hop-path">
  <h2>Latest hop path</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Hop</th>
          <th>Host</th>
          <th>Loss</th>
          <th>Sent</th>
          <th>Average RTT</th>
          <th>Best RTT</th>
          <th>Worst RTT</th>
        </tr>
      </thead>
      <tbody>
        ${hopRows}
      </tbody>
    </table>
  </div>
</section>
<section class="panel" id="snapshots">
  <h2>Recent snapshots</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Collected at</th>
          <th>Destination loss</th>
          <th>Worst hop loss</th>
          <th>Diagnosis</th>
          <th>Hops</th>
          <th>Artifacts</th>
        </tr>
      </thead>
    <tbody>
      ${snapshots
        .map((snapshot) => {
          const destinationLossClass = getLossClass(snapshot.destinationLossPct)
          const worstHopLossClass = getLossClass(snapshot.worstHopLossPct)
          const absoluteCollectedAt = formatAbsoluteCollectedAt(snapshot.collectedAt)
          return `<tr>
  <td><time datetime="${escapeHtml(snapshot.collectedAt)}" data-collected-at="${escapeHtml(snapshot.collectedAt)}" title="${escapeHtml(absoluteCollectedAt)}">${escapeHtml(formatRelativeCollectedAt(snapshot.collectedAt, now))}</time><br /><code>${escapeHtml(snapshot.collectedAt)}</code></td>
  <td><span class="loss ${destinationLossClass}">${escapeHtml(formatLoss(snapshot.destinationLossPct))}</span></td>
  <td><span class="loss ${worstHopLossClass}">${escapeHtml(formatLoss(snapshot.worstHopLossPct))}</span></td>
  <td><span class="loss ${getDiagnosisClass(snapshot.diagnosis)}">${escapeHtml(snapshot.diagnosis.label)}</span><br /><span>${renderDiagnosisSummary(snapshot.diagnosis.summary, snapshot.hops)}</span></td>
  <td>${snapshot.hopCount}</td>
  <td><a href="./${encodeURIComponent(snapshot.fileName)}">json</a></td>
</tr>`
        })
        .join('\n')}
    </tbody>
    </table>
  </div>
</section>
`,
  )

  await writeFile(path.join(targetDir, 'index.html'), html)
  await writeFile(path.join(targetDir, 'latest.html'), html)
  const latestJsonPath = path.join(targetDir, 'latest.json')
  await rm(latestJsonPath, { force: true })
  await writeFile(latestJsonPath, `${JSON.stringify(latestSnapshot, null, 2)}\n`)
  return latestSnapshot
}

async function writeRootIndex(
  logDir: string,
  peers: PeerConfig[],
  selfLabel: string,
  keepDays: number,
  now = Date.now(),
  signature?: string,
): Promise<void> {
  const entries = await readdir(logDir, { withFileTypes: true })
  const targetDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const targetSummaries: Array<{
    aggregate: SnapshotAggregate
    charts: NativeChartDefinition[]
    diagnosisAggregate: DiagnosisAggregate
    hopIssues: HopAggregate[]
    summary: SnapshotSummary
    targetSlug: string
  }> = []
  for (const targetSlug of targetDirs) {
    const targetDir = path.join(logDir, targetSlug)
    const snapshots = await listTargetSnapshots(targetDir)
    const summary = await writeTargetIndex(targetDir, peers, selfLabel, targetSlug, now, signature)
    if (summary) {
      targetSummaries.push({
        aggregate: summarizeSnapshots(snapshots, now, 7 * 24 * 60 * 60 * 1000),
        charts: await loadChartDefinitions(targetDir, snapshots, now),
        diagnosisAggregate: summarizeDiagnoses(snapshots, now, 7 * 24 * 60 * 60 * 1000),
        hopIssues: summarizeHopIssues(snapshots, now, 7 * 24 * 60 * 60 * 1000),
        targetSlug,
        summary,
      })
    }
  }

  const rows = targetSummaries
    .sort((left, right) => {
      return (
        right.diagnosisAggregate.destinationLossCount -
          left.diagnosisAggregate.destinationLossCount ||
        (right.aggregate.averageDestinationLossPct ?? 0) -
          (left.aggregate.averageDestinationLossPct ?? 0) ||
        (parseCollectedAt(right.summary.collectedAt) ?? 0) -
          (parseCollectedAt(left.summary.collectedAt) ?? 0)
      )
    })
    .map(({ aggregate, charts, diagnosisAggregate, hopIssues, targetSlug, summary }) => {
      const destinationLossClass = getLossClass(aggregate.averageDestinationLossPct)
      const historicalSeverity = getHistoricalSeverityBadge(aggregate, diagnosisAggregate)
      const suspectHop = getRootSuspectHop(hopIssues)
      const relativeCollectedAt = formatRelativeCollectedAt(summary.collectedAt, now)
      const absoluteCollectedAt = formatAbsoluteCollectedAt(summary.collectedAt)
      const thumbnailChart = charts.find((chart) => chart.rangeLabel === '30h') ?? charts[0]
      return `<tr>
  <td><a href="./${encodeURIComponent(targetSlug)}/">${escapeHtml(summary.target)}</a><br /><code>${escapeHtml(summary.host)}</code></td>
  <td><span class="loss ${getDiagnosisClass(summary.diagnosis)}">${escapeHtml(summary.diagnosis.label)}</span> <span class="status-age" data-collected-at="${escapeHtml(summary.collectedAt)}" data-relative-wrap="parens" title="${escapeHtml(absoluteCollectedAt)}">(${escapeHtml(relativeCollectedAt)})</span></td>
  <td>${summary.hopCount}</td>
  <td><span class="loss ${historicalSeverity.className}">${escapeHtml(historicalSeverity.label)}</span></td>
  <td><span class="loss ${destinationLossClass}">${escapeHtml(formatLoss(aggregate.averageDestinationLossPct))}</span><br /><span>${aggregate.sampleCount} samples</span></td>
  <td><span class="loss ${getLossOccurrenceClass(diagnosisAggregate.destinationLossCount, diagnosisAggregate.sampleCount)}">${diagnosisAggregate.destinationLossCount}</span><span> / ${diagnosisAggregate.sampleCount}</span></td>
  <td>${suspectHop ? `<code>${escapeHtml(suspectHop.host)}</code><br /><span>${suspectHop.downstreamLossCount} downstream / ${suspectHop.isolatedLossCount} isolated</span>` : 'n/a'}</td>
  <td><a class="thumb-link" href="./${encodeURIComponent(targetSlug)}/">${renderNativeChartCard(thumbnailChart, now, { compact: true, signature })}</a></td>
</tr>`
    })
    .join('\n')

  const html = renderLayout(
    `hopwatch — ${selfLabel}`,
    `
${renderTopNav({
  peers,
  selfLabel,
  pathSuffix: '/',
  title: 'hopwatch',
})}
<h1>hopwatch</h1>
<p class="lede">Node: <code>${escapeHtml(selfLabel)}</code>. Click a target to browse archived snapshots. Destination loss below is the 7-day average. Raw JSON snapshots are retained for ${keepDays} days, then rolled up into coarser historical buckets.</p>
<section class="panel">
  <h2>Targets</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Target</th>
          <th>Status now</th>
          <th>Hops now</th>
          <th>Severity (7d)</th>
          <th>Destination loss (7d avg)</th>
          <th>Destination-loss snapshots (7d)</th>
          <th>Most suspicious hop (7d)</th>
          <th>Latency/Loss<br /><span>(30h)</span></th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</section>
<section class="panel">
  <p>This overview is sorted by destination-loss frequency, then by 7-day average destination loss. Columns are grouped by time horizon: what is happening now first, then 7-day history, then the 30-hour native latency/loss chart. “Status now” answers what happened in the newest snapshot and shows how fresh that snapshot is; “Severity (7d)” summarizes how worried to be overall. “Most suspicious hop (7d)” is only shown when the same hop repeatedly coincides with downstream destination loss. Isolated intermediate-hop loss stays available on detail pages, but is not elevated here because it is often just ICMP reply rate limiting.</p>
</section>
`,
  )

  await writeFile(path.join(logDir, 'index.html'), html)
}

export async function removeOldSnapshots(
  targetDir: string,
  keepDays: number,
  now = Date.now(),
): Promise<void> {
  const entries = await readdir(targetDir, { withFileTypes: true })
  const maxAgeMs = keepDays * 24 * 60 * 60 * 1000
  const cutoff = now - maxAgeMs

  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith('.txt') && !entry.name.endsWith('.json'))) {
      continue
    }

    const entryPath = path.join(targetDir, entry.name)
    const entryStat = await stat(entryPath)
    if (entryStat.mtimeMs >= cutoff) {
      continue
    }

    await rm(entryPath, { force: true })
  }
}

async function updateLatestSymlink(outputFile: string, latestFile: string): Promise<void> {
  try {
    const existingTarget = await readlink(latestFile)
    if (existingTarget === outputFile) {
      return
    }
  } catch {
    // No existing symlink to preserve.
  }

  await rm(latestFile, { force: true })
  await symlink(outputFile, latestFile)
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await lstat(pathname)
    return true
  } catch {
    return false
  }
}

async function moveMissingEntries(sourceDir: string, destinationDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const destinationPath = path.join(destinationDir, entry.name)
    if (await pathExists(destinationPath)) {
      continue
    }

    await rename(sourcePath, destinationPath)
  }
}

async function ensureLegacyAlias(logDir: string, targetSlug: string): Promise<string> {
  const canonicalSlug = getTargetSlug(targetSlug)
  const legacySlug = getLegacyTargetSlug(canonicalSlug)
  const canonicalDir = path.join(logDir, canonicalSlug)
  const legacyDir = path.join(logDir, legacySlug)

  if (canonicalSlug === legacySlug) {
    await mkdir(canonicalDir, { recursive: true })
    return canonicalDir
  }

  const canonicalExists = await pathExists(canonicalDir)
  const legacyExists = await pathExists(legacyDir)

  if (!canonicalExists && legacyExists) {
    await rename(legacyDir, canonicalDir)
  } else {
    await mkdir(canonicalDir, { recursive: true })
    if (legacyExists) {
      const legacyStat = await lstat(legacyDir)
      if (legacyStat.isDirectory()) {
        await moveMissingEntries(legacyDir, canonicalDir)
        await rm(legacyDir, { recursive: true, force: true })
      }
    }
  }

  await rm(legacyDir, { force: true, recursive: true })
  await symlink(canonicalSlug, legacyDir)
  return canonicalDir
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (item == null) {
        return
      }

      await worker(item)
    }
  })

  await Promise.all(workers)
}

export async function collectSnapshot(
  nodeLabel: string,
  timestamp: string,
  options: CollectorOptions,
  target: MtrHistoryTarget,
  runCommand: RunCommand = execFileAsync,
  logger?: Logger,
): Promise<void> {
  const targetDir = await ensureLegacyAlias(options.logDir, target.slug)
  const jsonFile = path.join(targetDir, `${timestamp}.json`)
  const tmpJsonFile = `${jsonFile}.tmp`
  const latestJsonFile = path.join(targetDir, 'latest.json')

  const mtrArgs = ['-b', `-${options.ipVersion}`, '-l', '-c', String(options.packets), target.host]
  if (target.probeMode === 'netns' && options.namespaceDir.trim() === '') {
    throw new Error(
      `target '${target.slug}' uses probe_mode='netns' but the probe [namespace_dir] is empty`,
    )
  }

  if (target.probeMode === 'netns' && (target.netns == null || target.netns.trim() === '')) {
    throw new Error(
      `target '${target.slug}' uses probe_mode='netns' but has no 'netns' name configured`,
    )
  }

  const nsenterArgs: string[] = []
  if (options.netnsMount) {
    nsenterArgs.push(`--mount=${options.namespaceDir}/${target.netns}/mnt/ns`)
  }
  nsenterArgs.push(`--net=${options.namespaceDir}/${target.netns}/net/ns`)
  const [command, commandArgs] =
    target.probeMode === 'netns'
      ? ['nsenter', [...nsenterArgs, options.mtrBin, ...mtrArgs]]
      : [options.mtrBin, mtrArgs]

  const { stdout } = await runCommand(command, commandArgs)
  const rawEvents = parseRawMtrOutput(stdout)

  const storedSnapshot = {
    schemaVersion: 2 as const,
    collectedAt: timestamp,
    fileName: path.basename(jsonFile),
    host: target.host,
    label: target.label,
    observer: nodeLabel,
    probeMode: target.probeMode,
    rawEvents,
    target: target.host,
  }
  parseStoredRawSnapshot(`${JSON.stringify(storedSnapshot)}`)
  await writeFile(tmpJsonFile, `${JSON.stringify(storedSnapshot, null, 2)}\n`)
  await rename(tmpJsonFile, jsonFile)
  await updateLatestSymlink(jsonFile, latestJsonFile)
  await removeOldSnapshots(targetDir, options.keepDays)
  logger?.info('snapshot saved', { file: jsonFile, target: target.slug })
}

async function updateRollupsForTargets(
  nodeLabel: string,
  options: CollectorOptions,
  nowDate: Date,
): Promise<void> {
  await mapWithConcurrency(options.targets, options.concurrency, async (target) => {
    const targetDir = await ensureLegacyAlias(options.logDir, target.slug)
    await updateTargetRollups(
      targetDir,
      {
        host: target.host,
        label: target.label,
        observer: nodeLabel,
        probeMode: target.probeMode,
        target: target.host,
      },
      nowDate,
    )
  })
}

export interface RunCollectorOptions {
  renderOnly?: boolean
}

export async function runCollector(
  config: LoadedConfig,
  logger: Logger,
  runOptions: RunCollectorOptions = {},
  deps: CollectorDependencies = {},
): Promise<void> {
  const options = collectorOptionsFromConfig(config)
  options.renderOnly = runOptions.renderOnly ?? false

  await mkdir(options.logDir, { recursive: true })

  const nodeLabel = config.server.node_label ?? 'hopwatch'
  const nowDate = (deps.getNow ?? (() => new Date()))()
  const now = nowDate.getTime()
  const timestamp = getTimestamp(nowDate)
  const runCommand = deps.runCommand ?? execFileAsync

  if (!options.renderOnly) {
    await mapWithConcurrency(options.targets, options.concurrency, async (target) => {
      await collectSnapshot(nodeLabel, timestamp, options, target, runCommand, logger)
    })
  }

  await updateRollupsForTargets(nodeLabel, options, nowDate)
  await writeRootIndex(
    options.logDir,
    config.peer,
    nodeLabel,
    options.keepDays,
    now,
    config.chart.signature,
  )
}
