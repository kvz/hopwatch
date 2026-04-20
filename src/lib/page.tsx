import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RootIndexPage, type TargetSummaryRow } from '../components/RootIndexPage.tsx'
import { TargetIndexPage } from '../components/TargetIndexPage.tsx'
import { type ChartDefinition, loadChartDefinitions } from './chart.ts'
import type { PeerConfig } from './config.ts'
import { parseCollectedAt, readSnapshotSummary, type SnapshotSummary } from './snapshot.ts'
import {
  type DiagnosisAggregate,
  getHistoricalSeverityBadge,
  getRootSuspectHop,
  type HopAggregate,
  type SnapshotAggregate,
  summarizeDiagnoses,
  summarizeHopIssues,
  summarizeSnapshots,
} from './snapshot-aggregate.ts'

export async function listTargetSnapshots(targetDir: string): Promise<SnapshotSummary[]> {
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
  targetSlug: string,
  now = Date.now(),
  signature?: string,
): Promise<RenderedTarget | null> {
  const snapshots = await listTargetSnapshots(targetDir)
  if (snapshots.length === 0) {
    return null
  }

  const latestSnapshot = snapshots[0]
  const lastDay = summarizeSnapshots(snapshots, now, 24 * 60 * 60 * 1000)
  const lastWeek = summarizeSnapshots(snapshots, now, 7 * 24 * 60 * 60 * 1000)
  const hopIssues = summarizeHopIssues(snapshots, now, 7 * 24 * 60 * 60 * 1000).slice(0, 5)
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
  keepDays: number,
  now = Date.now(),
  signature?: string,
): Promise<string> {
  const entries = await readdir(logDir, { withFileTypes: true })
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

    targetSummaries.push({
      aggregate: summarizeSnapshots(snapshots, now, 7 * 24 * 60 * 60 * 1000),
      charts: await loadChartDefinitions(targetDir, snapshots, now),
      diagnosisAggregate: summarizeDiagnoses(snapshots, now, 7 * 24 * 60 * 60 * 1000),
      hopIssues: summarizeHopIssues(snapshots, now, 7 * 24 * 60 * 60 * 1000),
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
      selfLabel={selfLabel}
      signature={signature}
    />,
  )
}
