import type { ReactNode } from 'react'
import type { ChartDefinition } from '../lib/chart.ts'
import type { PeerConfig } from '../lib/config.ts'
import {
  formatAbsoluteCollectedAt,
  formatLoss,
  formatRelativeCollectedAt,
  getDiagnosisClass,
  getLossClass,
  getLossOccurrenceClass,
  type SnapshotSummary,
} from '../lib/snapshot.ts'
import type {
  DiagnosisAggregate,
  HopAggregate,
  SeverityBadge,
  SnapshotAggregate,
} from '../lib/snapshot-aggregate.ts'
import { ChartCard } from './ChartCard.tsx'
import { Layout } from './Layout.tsx'
import { TopNav } from './TopNav.tsx'

export interface TargetSummaryRow {
  aggregate: SnapshotAggregate
  charts: ChartDefinition[]
  diagnosisAggregate: DiagnosisAggregate
  historicalSeverity: SeverityBadge
  hopIssues: HopAggregate[]
  suspectHop: HopAggregate | null
  summary: SnapshotSummary
  targetSlug: string
  thumbnailChart: ChartDefinition
}

interface RootIndexPageProps {
  keepDays: number
  now: number
  peers: PeerConfig[]
  rows: TargetSummaryRow[]
  selfLabel: string
  signature?: string
}

export function RootIndexPage({
  keepDays,
  now,
  peers,
  rows,
  selfLabel,
  signature,
}: RootIndexPageProps): ReactNode {
  return (
    <Layout title={`hopwatch: ${selfLabel}`}>
      <TopNav peers={peers} selfLabel={selfLabel} pathSuffix="/" title="hopwatch" />
      <h1>hopwatch</h1>
      <p className="lede">
        Node: <code>{selfLabel}</code>. Click a target to browse archived snapshots. Destination
        loss below is the 7-day average. Raw JSON snapshots are retained for {keepDays} days, then
        rolled up into coarser historical buckets.
      </p>
      <section className="panel">
        <h2>Targets</h2>
        <div className="table-wrap">
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
                <th>
                  Latency/Loss
                  <br />
                  <span>(30h)</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(
                ({
                  aggregate,
                  diagnosisAggregate,
                  historicalSeverity,
                  suspectHop,
                  summary,
                  targetSlug,
                  thumbnailChart,
                }) => {
                  const destinationLossClass = getLossClass(aggregate.averageDestinationLossPct)
                  const relativeCollectedAt = formatRelativeCollectedAt(summary.collectedAt, now)
                  const absoluteCollectedAt = formatAbsoluteCollectedAt(summary.collectedAt)
                  return (
                    <tr key={targetSlug}>
                      <td>
                        <a href={`./${encodeURIComponent(targetSlug)}/`}>{summary.target}</a>
                        <br />
                        <code>{summary.host}</code>
                      </td>
                      <td>
                        <span className={`loss ${getDiagnosisClass(summary.diagnosis)}`}>
                          {summary.diagnosis.label}
                        </span>{' '}
                        <span className="status-age" title={absoluteCollectedAt}>
                          ({relativeCollectedAt})
                        </span>
                      </td>
                      <td>{summary.hopCount}</td>
                      <td>
                        <span className={`loss ${historicalSeverity.className}`}>
                          {historicalSeverity.label}
                        </span>
                      </td>
                      <td>
                        <span className={`loss ${destinationLossClass}`}>
                          {formatLoss(aggregate.averageDestinationLossPct)}
                        </span>
                        <br />
                        <span>{aggregate.sampleCount} samples</span>
                      </td>
                      <td>
                        <span
                          className={`loss ${getLossOccurrenceClass(diagnosisAggregate.destinationLossCount, diagnosisAggregate.sampleCount)}`}
                        >
                          {diagnosisAggregate.destinationLossCount}
                        </span>
                        <span> / {diagnosisAggregate.sampleCount}</span>
                      </td>
                      <td>
                        {suspectHop != null ? (
                          <>
                            <code>{suspectHop.host}</code>
                            <br />
                            <span>
                              {suspectHop.downstreamLossCount} downstream /{' '}
                              {suspectHop.isolatedLossCount} isolated
                            </span>
                          </>
                        ) : (
                          'n/a'
                        )}
                      </td>
                      <td>
                        <a className="thumb-link" href={`./${encodeURIComponent(targetSlug)}/`}>
                          <ChartCard
                            chart={thumbnailChart}
                            now={now}
                            compact
                            signature={signature}
                          />
                        </a>
                      </td>
                    </tr>
                  )
                },
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <p>
          This overview is sorted by destination-loss frequency, then by 7-day average destination
          loss. Columns are grouped by time horizon: what is happening now first, then 7-day
          history, then the 30-hour native latency/loss chart. “Status now” answers what happened in
          the newest snapshot and shows how fresh that snapshot is; “Severity (7d)” summarizes how
          worried to be overall. “Most suspicious hop (7d)” is only shown when the same hop
          repeatedly coincides with downstream destination loss. Isolated intermediate-hop loss
          stays available on detail pages, but is not elevated here because it is often just ICMP
          reply rate limiting.
        </p>
      </section>
    </Layout>
  )
}
