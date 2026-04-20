import type { ReactNode } from 'react'
import type { ChartDefinition } from '../lib/chart.ts'
import type { PeerConfig } from '../lib/config.ts'
import {
  formatAbsoluteCollectedAt,
  formatLoss,
  formatRelativeCollectedAt,
  getDiagnosisClass,
  getLossClass,
  type SnapshotSummary,
} from '../lib/snapshot.ts'
import type { HopAggregate } from '../lib/snapshot-aggregate.ts'
import { ChartCard } from './ChartCard.tsx'
import { DiagnosisSummary } from './DiagnosisSummary.tsx'
import { HopHost } from './HopHost.tsx'
import { Layout } from './Layout.tsx'
import { TopNav } from './TopNav.tsx'

interface TargetIndexPageProps {
  charts: ChartDefinition[]
  hopIssues: HopAggregate[]
  lastDay: { averageDestinationLossPct: number | null; sampleCount: number }
  lastWeek: {
    averageDestinationLossPct: number | null
    averageWorstHopLossPct: number | null
    sampleCount: number
  }
  latestSnapshot: SnapshotSummary
  now: number
  peers: PeerConfig[]
  selfHost: string | null
  selfLabel: string
  signature?: string
  snapshots: SnapshotSummary[]
  targetSlug: string
}

export function TargetIndexPage({
  charts,
  hopIssues,
  lastDay,
  lastWeek,
  latestSnapshot,
  now,
  peers,
  selfHost,
  selfLabel,
  signature,
  snapshots,
  targetSlug,
}: TargetIndexPageProps): ReactNode {
  const [mainChart, ...secondaryCharts] = charts

  return (
    <Layout title={`MTR History for ${latestSnapshot.target}`}>
      <TopNav
        backHref="../"
        backLabel="All targets"
        peers={peers}
        selfHost={selfHost}
        selfLabel={selfLabel}
        pathSuffix={`/${encodeURIComponent(targetSlug)}/`}
        sections={[
          { href: '#summary', label: 'Summary' },
          { href: '#history', label: 'Latency & loss history' },
          { href: '#raw', label: 'Latest raw output' },
          { href: '#diagnosis', label: 'Latest diagnosis' },
          { href: '#problematic-hops', label: 'Problematic hops (7d)' },
          { href: '#hop-path', label: 'Latest hop path' },
          { href: '#snapshots', label: 'Recent snapshots' },
        ]}
        title={latestSnapshot.target}
      />
      <h1>{latestSnapshot.target}</h1>
      <p className="lede target-meta">
        Observer snapshot archive for <code>{targetSlug}</code>. Host:{' '}
        <code>{latestSnapshot.host}</code>. Probe: <code>{latestSnapshot.probeMode}</code>.
        Destination loss is the last hop only; worst hop loss may include intermediate router reply
        rate limiting.
      </p>

      <section className="panel" id="summary">
        <h2>Summary</h2>
        <div className="summary-grid">
          <div className="summary-card">
            <strong>Latest status</strong>
            <span className={`loss ${getDiagnosisClass(latestSnapshot.diagnosis)}`}>
              {latestSnapshot.diagnosis.label}
            </span>
          </div>
          <div className="summary-card">
            <strong>Last 24 hours</strong>
            <span className={`loss ${getLossClass(lastDay.averageDestinationLossPct)}`}>
              {formatLoss(lastDay.averageDestinationLossPct)}
            </span>
            <div>{lastDay.sampleCount} samples</div>
          </div>
          <div className="summary-card">
            <strong>Last 7 days</strong>
            <span className={`loss ${getLossClass(lastWeek.averageDestinationLossPct)}`}>
              {formatLoss(lastWeek.averageDestinationLossPct)}
            </span>
            <div>{lastWeek.sampleCount} samples</div>
          </div>
          <div className="summary-card">
            <strong>Average worst hop loss</strong>
            <span className={`loss ${getLossClass(lastWeek.averageWorstHopLossPct)}`}>
              {formatLoss(lastWeek.averageWorstHopLossPct)}
            </span>
            <div>7-day window</div>
          </div>
        </div>
      </section>

      <section className="panel" id="history">
        <h2>Latency and loss history</h2>
        <div className="graph-grid">
          <ChartCard chart={mainChart} now={now} signature={signature} />
          <div className="graph-grid graph-grid--mini">
            {secondaryCharts.map((chart) => (
              <ChartCard key={chart.rangeLabel} chart={chart} now={now} signature={signature} />
            ))}
          </div>
        </div>
      </section>

      <section className="panel" id="raw">
        <h2>Latest raw output</h2>
        <p className="panel-hint">
          Reconstructed <code>mtr --report</code> view of the newest snapshot. The full per-probe
          event stream is stored as JSON. Expand below or grab the file.
        </p>
        <pre className="scroll-x">{latestSnapshot.rawText}</pre>
        <p className="panel-hint">
          Download the full JSON snapshot:{' '}
          <a href={`./${encodeURIComponent(latestSnapshot.fileName)}`}>{latestSnapshot.fileName}</a>
        </p>
      </section>

      <section className="panel" id="diagnosis">
        <h2>Latest diagnosis</h2>
        <p>
          <span className={`loss ${getDiagnosisClass(latestSnapshot.diagnosis)}`}>
            {latestSnapshot.diagnosis.label}
          </span>
        </p>
        <p>
          <DiagnosisSummary summary={latestSnapshot.diagnosis.summary} hops={latestSnapshot.hops} />
        </p>
      </section>

      <section className="panel" id="problematic-hops">
        <h2>Recurring problematic hops (7d)</h2>
        <div className="table-wrap">
          <table data-sortable>
            <thead>
              <tr>
                <th data-sort="text">Hop</th>
                <th data-sort="number">Latest index</th>
                <th data-sort="loss">Average loss when seen</th>
                <th data-sort="number">Snapshots with downstream loss</th>
                <th data-sort="number">Snapshots with isolated loss</th>
              </tr>
            </thead>
            <tbody>
              {hopIssues.length === 0 ? (
                <tr>
                  <td colSpan={5}>No recurring intermediate-hop loss in the last 7 days.</td>
                </tr>
              ) : (
                hopIssues.map((hopIssue) => (
                  <tr key={hopIssue.host}>
                    <td>
                      <code>{hopIssue.host}</code>
                    </td>
                    <td>{hopIssue.latestHopIndex ?? 'n/a'}</td>
                    <td>
                      <span className={`loss ${getLossClass(hopIssue.averageLossPct)}`}>
                        {formatLoss(hopIssue.averageLossPct)}
                      </span>
                    </td>
                    <td>{hopIssue.downstreamLossCount}</td>
                    <td>{hopIssue.isolatedLossCount}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" id="hop-path">
        <h2>Latest hop path</h2>
        <div className="table-wrap">
          <table data-sortable>
            <thead>
              <tr>
                <th data-sort="number">Hop</th>
                <th data-sort="text">Host</th>
                <th data-sort="loss">Loss</th>
                <th data-sort="number">Sent</th>
                <th data-sort="number">Average RTT</th>
                <th data-sort="number">Best RTT</th>
                <th data-sort="number">Worst RTT</th>
              </tr>
            </thead>
            <tbody>
              {latestSnapshot.hops.map((hop) => (
                <tr key={hop.index}>
                  <td>{hop.index}</td>
                  <td>
                    <HopHost host={hop.host} />
                    {hop.asn != null ? (
                      <>
                        <br />
                        <span>{hop.asn}</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <span className={`loss ${getLossClass(hop.lossPct)}`}>
                      {formatLoss(hop.lossPct)}
                    </span>
                  </td>
                  <td>{hop.sent ?? 'n/a'}</td>
                  <td>{hop.avgMs?.toFixed(1) ?? 'n/a'}</td>
                  <td>{hop.bestMs?.toFixed(1) ?? 'n/a'}</td>
                  <td>{hop.worstMs?.toFixed(1) ?? 'n/a'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" id="snapshots">
        <h2>Recent snapshots</h2>
        <div className="table-wrap">
          <table data-sortable>
            <thead>
              <tr>
                <th data-sort="text">Collected at</th>
                <th data-sort="loss">Destination loss</th>
                <th data-sort="loss">Worst hop loss</th>
                <th data-sort="text">Diagnosis</th>
                <th data-sort="number">Hops</th>
                <th>Artifacts</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snapshot) => {
                const absoluteCollectedAt = formatAbsoluteCollectedAt(snapshot.collectedAt)
                return (
                  <tr key={snapshot.collectedAt}>
                    <td data-sort-value={snapshot.collectedAt}>
                      <time dateTime={snapshot.collectedAt} title={snapshot.collectedAt}>
                        {formatRelativeCollectedAt(snapshot.collectedAt, now)}
                      </time>
                      <div className="cell-subtle">{absoluteCollectedAt}</div>
                    </td>
                    <td>
                      <span className={`loss ${getLossClass(snapshot.destinationLossPct)}`}>
                        {formatLoss(snapshot.destinationLossPct)}
                      </span>
                    </td>
                    <td>
                      <span className={`loss ${getLossClass(snapshot.worstHopLossPct)}`}>
                        {formatLoss(snapshot.worstHopLossPct)}
                      </span>
                    </td>
                    <td>
                      <span className={`loss ${getDiagnosisClass(snapshot.diagnosis)}`}>
                        {snapshot.diagnosis.label}
                      </span>
                      <br />
                      <span>
                        <DiagnosisSummary
                          summary={snapshot.diagnosis.summary}
                          hops={snapshot.hops}
                        />
                      </span>
                    </td>
                    <td>{snapshot.hopCount}</td>
                    <td>
                      <a href={`./${encodeURIComponent(snapshot.fileName)}`}>json</a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </Layout>
  )
}
