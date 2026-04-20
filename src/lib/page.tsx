import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RootIndexPage, type TargetSummaryRow } from '../components/RootIndexPage.tsx'
import { TargetIndexPage } from '../components/TargetIndexPage.tsx'
import { type ChartDefinition, loadChartDefinitions } from './chart.ts'
import type { PeerConfig } from './config.ts'
import {
  listSnapshotFileNames,
  parseCollectedAt,
  readSnapshotSummary,
  type SnapshotSummary,
} from './snapshot.ts'
import {
  type DiagnosisAggregate,
  getHistoricalSeverityBadge,
  getRootSuspectHop,
  type HopAggregate,
  type SnapshotAggregate,
  selectSnapshotsInWindow,
  summarizeDiagnoses,
  summarizeHopIssues,
  summarizeSnapshots,
} from './snapshot-aggregate.ts'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

// Parsed snapshot summaries are cached by absolute path. Snapshot files are
// immutable once written (timestamped filenames, never updated in place), so
// a never-invalidated cache is safe. Without this, every `/` render reparses
// the entire retention window (keep_days * 96 files per target) — at the
// default 15-minute cadence and 14-day retention that is ~1,344 parses per
// target per request, which makes the open HTTP server trivial to exhaust
// with repeat GETs.
const snapshotCache = new Map<string, SnapshotSummary>()

export async function listTargetSnapshots(targetDir: string): Promise<SnapshotSummary[]> {
  const snapshotFiles = (await listSnapshotFileNames(targetDir)).reverse()
  const snapshots: SnapshotSummary[] = []
  for (const fileName of snapshotFiles) {
    const cacheKey = path.join(targetDir, fileName)
    const cached = snapshotCache.get(cacheKey)
    if (cached != null) {
      snapshots.push(cached)
      continue
    }

    try {
      const summary = await readSnapshotSummary(targetDir, fileName)
      snapshotCache.set(cacheKey, summary)
      snapshots.push(summary)
    } catch (err) {
      // A single corrupt snapshot must not kill the dashboard for an entire
      // target. Log to stderr so operators can triage — the rollup rebuilder
      // does the same with listStoredRawSnapshots.
      const reason = err instanceof Error ? err.message : String(err)
      process.stderr.write(`hopwatch: skipping unreadable snapshot ${cacheKey}: ${reason}\n`)
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
  const hopIssues = summarizeHopIssues(lastWeekSnapshots).slice(0, 5)
  const charts = await loadChartDefinitions(targetDir, snapshots, now)

  const html = renderDocument(
    <TargetIndexPage
      charts={charts}
      hopIssues={hopIssues}
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
    charts: ChartDefinition[]
    diagnosisAggregate: DiagnosisAggregate
    hopIssues: HopAggregate[]
    summary: SnapshotSummary
    targetSlug: string
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
      charts: await loadChartDefinitions(targetDir, snapshots, now),
      diagnosisAggregate: summarizeDiagnoses(lastWeekSnapshots),
      hopIssues: summarizeHopIssues(lastWeekSnapshots),
      targetSlug,
      summary: snapshots[0],
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
      charts: entry.charts,
      diagnosisAggregate: entry.diagnosisAggregate,
      historicalSeverity: getHistoricalSeverityBadge(entry.aggregate, entry.diagnosisAggregate),
      hopIssues: entry.hopIssues,
      suspectHop: getRootSuspectHop(entry.hopIssues),
      summary: entry.summary,
      targetSlug: entry.targetSlug,
      thumbnailChart: entry.charts.find((chart) => chart.rangeLabel === '30h') ?? entry.charts[0],
    }))

  return renderDocument(
    <RootIndexPage
      keepDays={keepDays}
      now={now}
      peers={peers}
      rows={rows}
      selfHost={selfHost}
      selfLabel={selfLabel}
      signature={signature}
    />,
  )
}
