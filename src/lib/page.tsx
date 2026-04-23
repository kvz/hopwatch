import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RootIndexPage, type TargetSummaryRow } from '../components/RootIndexPage.tsx'
import { TargetIndexPage } from '../components/TargetIndexPage.tsx'
import {
  buildThumbnailChartDefinition,
  type ChartDefinition,
  loadChartDefinitions,
} from './chart.ts'
import type { PeerConfig } from './config.ts'
import { readRollupFile } from './rollups.ts'
import {
  listSnapshotFileNames,
  parseCollectedAt,
  readSnapshotSummary,
  type SnapshotSummary,
} from './snapshot.ts'
import {
  type DiagnosisAggregate,
  getCrossTargetDiagnosis,
  getHistoricalSeverityBadge,
  getRootSuspectHop,
  type HopAggregate,
  type SnapshotAggregate,
  selectSnapshotsInWindow,
  summarizeCrossTargetHopIssues,
  summarizeDiagnoses,
  summarizeHopIssues,
  summarizeSnapshots,
} from './snapshot-aggregate.ts'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

// Parsed snapshot summaries are cached by absolute path. Snapshot files are
// immutable once written (timestamped filenames, never updated in place), so
// a never-invalidated cache is safe _per file_. Without this, every `/` render
// reparses the entire retention window (keep_days * 96 files per target) — at
// the default 15-minute cadence and 14-day retention that is ~1,344 parses
// per target per request, which makes the open HTTP server trivial to exhaust
// with repeat GETs.
//
// To keep the cache bounded under retention rotation, listTargetSnapshots
// drops entries for files in this target's directory that are no longer on
// disk. Without that pruning, a long-lived daemon's cache would grow by one
// entry per probe cycle forever.
//
// Per-target pruning alone leaves entries for *removed* targets in memory
// forever, and is also a soft cap (bounded by keep_days × cycles). A hard LRU
// ceiling protects against runaway memory if a config rewrite renames many
// targets or if an operator browses a lot of historical data.
const SNAPSHOT_CACHE_MAX_SIZE = 10_000
const snapshotCache = new Map<string, SnapshotSummary>()

function cacheSnapshot(key: string, summary: SnapshotSummary): void {
  // Re-inserting moves the key to the end of Map iteration order; combined
  // with evicting from the front, this gives us LRU semantics.
  if (snapshotCache.has(key)) snapshotCache.delete(key)
  snapshotCache.set(key, summary)
  while (snapshotCache.size > SNAPSHOT_CACHE_MAX_SIZE) {
    const oldest = snapshotCache.keys().next().value
    if (oldest == null) break
    snapshotCache.delete(oldest)
  }
}

function touchCached(key: string): SnapshotSummary | undefined {
  const value = snapshotCache.get(key)
  if (value == null) return undefined
  snapshotCache.delete(key)
  snapshotCache.set(key, value)
  return value
}

export async function listTargetSnapshots(targetDir: string): Promise<SnapshotSummary[]> {
  const snapshotFiles = (await listSnapshotFileNames(targetDir)).reverse()
  const liveKeys = new Set<string>()
  const snapshots: SnapshotSummary[] = []
  for (const fileName of snapshotFiles) {
    const cacheKey = path.join(targetDir, fileName)
    liveKeys.add(cacheKey)
    const cached = touchCached(cacheKey)
    if (cached != null) {
      snapshots.push(cached)
      continue
    }

    try {
      const summary = await readSnapshotSummary(targetDir, fileName)
      cacheSnapshot(cacheKey, summary)
      snapshots.push(summary)
    } catch (err) {
      // A single corrupt snapshot must not kill the dashboard for an entire
      // target. Log to stderr so operators can triage — the rollup rebuilder
      // does the same with listStoredRawSnapshots.
      const reason = err instanceof Error ? err.message : String(err)
      process.stderr.write(`hopwatch: skipping unreadable snapshot ${cacheKey}: ${reason}\n`)
    }
  }

  const targetPrefix = `${targetDir}${path.sep}`
  for (const key of snapshotCache.keys()) {
    if (key.startsWith(targetPrefix) && !liveKeys.has(key)) {
      snapshotCache.delete(key)
    }
  }

  return snapshots
}

export interface RenderedTarget {
  html: string
  latestSnapshot: SnapshotSummary
}

function renderDocument(element: ReactElement): string {
  return `<!doctype html>\n${renderToStaticMarkup(element)}`
}

export async function renderTargetIndex(
  targetDir: string,
  peers: PeerConfig[],
  selfLabel: string,
  selfHost: string | null,
  targetSlug: string,
  now = Date.now(),
  signature?: string,
): Promise<RenderedTarget | null> {
  const snapshots = await listTargetSnapshots(targetDir)
  if (snapshots.length === 0) {
    return null
  }

  const latestSnapshot = snapshots[0]
  const lastDaySnapshots = selectSnapshotsInWindow(snapshots, now, ONE_DAY_MS)
  const lastWeekSnapshots = selectSnapshotsInWindow(snapshots, now, SEVEN_DAYS_MS)
  const lastDay = summarizeSnapshots(lastDaySnapshots)
  const lastWeek = summarizeSnapshots(lastWeekSnapshots)
  // Exclude anonymized (???) hops from the top-5 "Recurring problematic hops"
  // table — they almost always represent routers that rate-limit ICMP reply,
  // so elevating them above real suspects is misleading. The hint under the
  // diagnosis explains the convention.
  const hopIssues = summarizeHopIssues(lastWeekSnapshots)
    .filter((hop) => hop.host !== '???')
    .slice(0, 5)
  const charts = await loadChartDefinitions(targetDir, snapshots, now)
  const hourlyRollup = await readRollupFile(path.join(targetDir, 'hourly.rollup.json'), 'hour')

  const html = renderDocument(
    <TargetIndexPage
      charts={charts}
      hopIssues={hopIssues}
      hourlyBuckets={hourlyRollup?.buckets ?? []}
      lastDay={lastDay}
      lastWeek={lastWeek}
      latestSnapshot={latestSnapshot}
      now={now}
      peers={peers}
      selfHost={selfHost}
      selfLabel={selfLabel}
      signature={signature}
      snapshots={snapshots}
      targetSlug={targetSlug}
    />,
  )

  return { html, latestSnapshot }
}

export async function renderRootIndex(
  logDir: string,
  peers: PeerConfig[],
  selfLabel: string,
  selfHost: string | null,
  keepDays: number,
  now = Date.now(),
  signature?: string,
): Promise<string> {
  // A freshly-provisioned daemon serves `/` before the first probe cycle has
  // had a chance to create its data directory. Treat a missing logDir as "no
  // targets yet" so the root page renders an empty table instead of 500ing.
  const entries = await readdir(logDir, { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return []
      throw err
    },
  )
  const targetDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const targetSummaries: Array<{
    aggregate: SnapshotAggregate
    diagnosisAggregate: DiagnosisAggregate
    hopIssues: HopAggregate[]
    summary: SnapshotSummary
    targetSlug: string
    thumbnailChart: ChartDefinition
  }> = []
  for (const targetSlug of targetDirs) {
    const targetDir = path.join(logDir, targetSlug)
    const snapshots = await listTargetSnapshots(targetDir)
    if (snapshots.length === 0) {
      continue
    }

    const lastWeekSnapshots = selectSnapshotsInWindow(snapshots, now, SEVEN_DAYS_MS)
    targetSummaries.push({
      aggregate: summarizeSnapshots(lastWeekSnapshots),
      diagnosisAggregate: summarizeDiagnoses(lastWeekSnapshots),
      hopIssues: summarizeHopIssues(lastWeekSnapshots),
      summary: snapshots[0],
      targetSlug,
      thumbnailChart: buildThumbnailChartDefinition(snapshots, now),
    })
  }

  const rows: TargetSummaryRow[] = targetSummaries
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
    .map((entry) => ({
      aggregate: entry.aggregate,
      diagnosisAggregate: entry.diagnosisAggregate,
      historicalSeverity: getHistoricalSeverityBadge(entry.aggregate, entry.diagnosisAggregate),
      suspectHop: getRootSuspectHop(entry.hopIssues),
      summary: entry.summary,
      targetSlug: entry.targetSlug,
      thumbnailChart: entry.thumbnailChart,
    }))

  // ASN labels are per-target/per-snapshot; keep the latest seen mapping per
  // host so the cross-target diagnosis can attribute a hop to its upstream
  // network without re-walking the full snapshot set.
  const crossTargetDiagnosis = getCrossTargetDiagnosis(
    summarizeCrossTargetHopIssues(
      targetSummaries.map((entry) => {
        const asnByHost = new Map<string, string | null>()
        for (const hop of entry.summary.hops) {
          asnByHost.set(hop.host, hop.asn)
        }
        return {
          asnByHost,
          hopIssues: entry.hopIssues,
          // Protocol was added to SnapshotSummary; use the target's most
          // recent snapshot as the source of truth. A target cannot flip
          // protocols without a config edit + rolling restart, so the
          // latest snapshot is representative of the window.
          protocol: entry.summary.protocol,
          target: entry.summary.target,
        }
      }),
    ),
  )

  const latestCollectedAt = rows.reduce<string | null>((acc, row) => {
    const rowTs = parseCollectedAt(row.summary.collectedAt) ?? 0
    const accTs = acc == null ? 0 : (parseCollectedAt(acc) ?? 0)
    return rowTs > accTs ? row.summary.collectedAt : acc
  }, null)

  return renderDocument(
    <RootIndexPage
      crossTargetDiagnosis={crossTargetDiagnosis}
      keepDays={keepDays}
      latestCollectedAt={latestCollectedAt}
      now={now}
      peers={peers}
      rows={rows}
      selfHost={selfHost}
      selfLabel={selfLabel}
      signature={signature}
    />,
  )
}
