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
  const hasAnonymizedHop = latestSnapshot.hops.some((hop) => hop.host === '???')
  const relativeLatestCollectedAt = formatRelativeCollectedAt(latestSnapshot.collectedAt, now)
  const absoluteLatestCollectedAt = formatAbsoluteCollectedAt(latestSnapshot.collectedAt)
  const probeIsNetns = latestSnapshot.probeMode === 'netns'
  // Strip a trailing "(hostname)" from the display target — the hostname is
  // already rendered in the intro line, and the parenthetical makes the H1
  // wrap awkwardly on narrow viewports.
  const headingText = latestSnapshot.target
    .replace(new RegExp(`\\s*\\(${latestSnapshot.host.replaceAll('.', '\\.')}\\)\\s*$`), '')
    .trim()

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
      <h1>{headingText}</h1>
      <p className="lede target-meta">
        Probing <code>{latestSnapshot.host}</code>
        {probeIsNetns ? <> from a Linux network namespace</> : null} with ICMP traceroute.
        Destination loss counts only the final hop; worst-hop loss may include intermediate router
        reply rate-limiting and is shown muted for that reason.
      </p>
      <p className="freshness">
        Last probe cycle: <strong>{relativeLatestCollectedAt}</strong>{' '}
        <span className="cell-subtle" title={absoluteLatestCollectedAt}>
          ({absoluteLatestCollectedAt})
        </span>
      </p>

      <section className="panel" id="summary">
        <h2>Summary</h2>
        <div className="summary-grid">
          <div className="summary-card">
            <strong>Latest status</strong>
            <span className={`loss ${getDiagnosisClass(latestSnapshot.diagnosis)}`}>
              {latestSnapshot.diagnosis.label}
            </span>
            <div className="cell-subtle" title={absoluteLatestCollectedAt}>
              {relativeLatestCollectedAt}
            </div>
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
            <strong>Worst intermediate non-reply</strong>
            <span className="loss muted">{formatLoss(lastWeek.averageWorstHopLossPct)}</span>
            <div>7-day avg — often ICMP rate limiting, not real loss</div>
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
          event stream is stored as JSON.
        </p>
        <details>
          <summary>Show raw mtr-report output</summary>
          <pre className="scroll-x">{latestSnapshot.rawText}</pre>
        </details>
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
        {hasAnonymizedHop ? (
          <p className="panel-hint">
            Hops labelled <code>???</code> didn't reply with a name or IP. That usually means the
            router drops or rate-limits ICMP — it doesn't mean the probe failed. 100% loss on a{' '}
            <code>???</code> row in the hop table below is normal and can be ignored.
          </p>
        ) : null}
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
                <th
                  aria-sort="descending"
                  className="is-sortable"
                  data-sort="number"
                  data-sort-default="desc"
                >
                  Snapshots with downstream loss
                </th>
                <th data-sort="number">Snapshots with isolated loss</th>
              </tr>
            </thead>
            <tbody>
              {hopIssues.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    No recurring intermediate-hop loss in the last 7 days (anonymous{' '}
                    <code>???</code> hops are excluded because 100% loss there is normally just ICMP
                    rate-limiting).
                  </td>
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
                <th
                  aria-sort="ascending"
                  className="is-sortable"
                  data-sort="number"
                  data-sort-default="asc"
                >
                  Hop
                </th>
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
                <th
                  aria-sort="descending"
                  className="is-sortable"
                  data-sort="text"
                  data-sort-default="desc"
                >
                  Collected at
                </th>
                <th data-sort="loss">Destination loss</th>
                <th data-sort="loss">Worst hop loss</th>
                <th data-sort="text">Diagnosis</th>
                <th data-sort="number">Hops</th>
                <th>Artifacts</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snapshot, i) => {
                const absoluteCollectedAt = formatAbsoluteCollectedAt(snapshot.collectedAt)
                const prev = i > 0 ? snapshots[i - 1] : null
                const sameAsPrev =
                  prev != null &&
                  prev.diagnosis.label === snapshot.diagnosis.label &&
                  prev.diagnosis.summary === snapshot.diagnosis.summary
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
                      {sameAsPrev ? null : (
                        <>
                          <br />
                          <span>
                            <DiagnosisSummary
                              summary={snapshot.diagnosis.summary}
                              hops={snapshot.hops}
                            />
                          </span>
                        </>
                      )}
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
