import type { ReactNode } from 'react'
import type { ChartDefinition } from '../lib/chart.ts'
import type { PeerConfig } from '../lib/config.ts'
import {
  formatAbsoluteCollectedAt,
  formatLatencyMs,
  formatLoss,
  getDiagnosisClass,
  getLossClass,
  getLossOccurrenceClass,
  type SnapshotSummary,
} from '../lib/snapshot.ts'
import type {
  CrossTargetDiagnosis,
  DiagnosisAggregate,
  HopAggregate,
  SeverityBadge,
  SnapshotAggregate,
} from '../lib/snapshot-aggregate.ts'
import { ChartCard } from './ChartCard.tsx'
import { Layout } from './Layout.tsx'
import { RelativeTime } from './RelativeTime.tsx'
import { TopNav } from './TopNav.tsx'

const SEVERITY_SORT_RANK: Record<SeverityBadge['className'], number> = {
  bad: 3,
  warn: 2,
  unknown: 1,
  good: 0,
}

export interface TargetSummaryRow {
  aggregate: SnapshotAggregate
  diagnosisAggregate: DiagnosisAggregate
  historicalSeverity: SeverityBadge
  suspectHop: HopAggregate | null
  summary: SnapshotSummary
  targetSlug: string
  thumbnailChart: ChartDefinition
}

interface RootIndexPageProps {
  crossTargetDiagnosis: CrossTargetDiagnosis
  keepDays: number
  latestCollectedAt: string | null
  now: number
  peers: PeerConfig[]
  rows: TargetSummaryRow[]
  selfHost: string | null
  selfLabel: string
  signature?: string
}

export function RootIndexPage({
  crossTargetDiagnosis,
  keepDays,
  latestCollectedAt,
  now,
  peers,
  rows,
  selfHost,
  selfLabel,
  signature,
}: RootIndexPageProps): ReactNode {
  const freshnessAbsolute =
    latestCollectedAt == null ? null : formatAbsoluteCollectedAt(latestCollectedAt)
  return (
    <Layout title={`hopwatch: ${selfLabel}`}>
      <TopNav
        peers={peers}
        selfHost={selfHost}
        selfLabel={selfLabel}
        pathSuffix="/"
        title="hopwatch"
      />
      <h1>hopwatch</h1>
      <p className="lede">
        Raw JSON snapshots are kept for {keepDays} days, then rolled up into coarser historical
        buckets.
      </p>
      {latestCollectedAt != null && freshnessAbsolute != null ? (
        <p className="freshness">
          Last probe cycle:{' '}
          <strong>
            <RelativeTime collectedAt={latestCollectedAt} now={now} />
          </strong>{' '}
          <span className="cell-subtle" title={freshnessAbsolute}>
            ({freshnessAbsolute})
          </span>
        </p>
      ) : null}
      <section className="panel">
        <h2>Cross-target diagnosis (7d)</h2>
        <p>
          <span className={`loss ${crossTargetDiagnosis.className}`}>
            {crossTargetDiagnosis.label}
          </span>{' '}
          {crossTargetDiagnosis.summary}
        </p>
      </section>
      <section className="panel">
        <h2>Targets</h2>
        <div className="table-wrap">
          <table data-sortable>
            <thead>
              <tr>
                <th data-sort="text">Target</th>
                <th data-sort="text">Status now</th>
                <th data-sort="number">Hops now</th>
                <th data-sort="number">Severity (7d)</th>
                <th data-sort="number">Latency (7d avg median)</th>
                <th data-sort="loss">Dest. loss (7d avg)</th>
                <th
                  aria-sort="descending"
                  className="is-sortable"
                  data-sort="number"
                  data-sort-default="desc"
                >
                  Loss snapshots (7d)
                </th>
                <th data-sort="text">Most suspicious hop (7d)</th>
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
                  const absoluteCollectedAt = formatAbsoluteCollectedAt(summary.collectedAt)
                  return (
                    <tr key={targetSlug}>
                      <td data-sort-value={summary.target}>
                        <a href={`./${encodeURIComponent(targetSlug)}/`}>{summary.target}</a>
                        {summary.target.includes(summary.host) ? null : (
                          <>
                            <br />
                            <code>{summary.host}</code>
                          </>
                        )}
                      </td>
                      <td data-sort-value={summary.diagnosis.label}>
                        <span className={`loss ${getDiagnosisClass(summary.diagnosis)}`}>
                          {summary.diagnosis.label}
                        </span>{' '}
                        <span className="status-age" title={absoluteCollectedAt}>
                          (<RelativeTime collectedAt={summary.collectedAt} now={now} />)
                        </span>
                      </td>
                      <td>{summary.hopCount}</td>
                      <td data-sort-value={SEVERITY_SORT_RANK[historicalSeverity.className]}>
                        <span className={`loss ${historicalSeverity.className}`}>
                          {historicalSeverity.label}
                        </span>
                      </td>
                      <td data-sort-value={aggregate.averageDestinationMedianRttMs ?? ''}>
                        {formatLatencyMs(aggregate.averageDestinationMedianRttMs)}
                      </td>
                      <td data-sort-value={aggregate.averageDestinationLossPct ?? ''}>
                        <span className={`loss ${destinationLossClass}`}>
                          {formatLoss(aggregate.averageDestinationLossPct)}
                        </span>
                        <br />
                        <span>{aggregate.sampleCount} samples</span>
                      </td>
                      <td data-sort-value={diagnosisAggregate.destinationLossCount}>
                        <span
                          className={`loss ${getLossOccurrenceClass(diagnosisAggregate.destinationLossCount, diagnosisAggregate.sampleCount)}`}
                        >
                          {diagnosisAggregate.destinationLossCount}
                        </span>
                        <span> / {diagnosisAggregate.sampleCount}</span>
                      </td>
                      <td data-sort-value={suspectHop?.host ?? ''}>
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
    </Layout>
  )
}
