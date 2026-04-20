import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { type ChartDefinition, loadChartDefinitions, renderChartMiniSvg } from './chart.ts'
import { renderChartSvg } from './chart-svg.ts'
import type { PeerConfig } from './config.ts'
import { escapeHtml, renderLayout, renderTopNav } from './layout.ts'
import {
  formatAbsoluteCollectedAt,
  formatLoss,
  formatRelativeCollectedAt,
  getDiagnosisClass,
  getLossClass,
  getLossOccurrenceClass,
  parseCollectedAt,
  readSnapshotSummary,
  renderDiagnosisSummary,
  renderHopHostHtml,
  type SnapshotSummary,
} from './snapshot.ts'
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

export function renderChartCard(
  chart: ChartDefinition,
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

  if (compact) {
    return renderChartMiniSvg(chart.points, {
      height,
      now,
      rangeMs: rangeHours * 60 * 60 * 1000,
      title: `${chart.label} latency and loss`,
      width,
    })
  }

  const svg = renderChartSvg(chart.points, {
    height,
    now,
    rangeMs: rangeHours * 60 * 60 * 1000,
    signature,
    title: `${chart.label} latency and loss`,
    width,
  })

  return `<div class="graph-card">
    <h3>${escapeHtml(chart.label)}</h3>
    ${svg}
    <div class="graph-caption">Latency and loss rendered from ${escapeHtml(chart.sourceLabel)}.</div>
  </div>`
}

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
  <td>${renderHopHostHtml(hop.host)}${hop.asn ? `<br /><span>${escapeHtml(hop.asn)}</span>` : ''}</td>
  <td><span class="loss ${getLossClass(hop.lossPct)}">${escapeHtml(formatLoss(hop.lossPct))}</span></td>
  <td>${hop.sent ?? 'n/a'}</td>
  <td>${hop.avgMs?.toFixed(1) ?? 'n/a'}</td>
  <td>${hop.bestMs?.toFixed(1) ?? 'n/a'}</td>
  <td>${hop.worstMs?.toFixed(1) ?? 'n/a'}</td>
</tr>`,
    )
    .join('\n')
  const charts = await loadChartDefinitions(targetDir, snapshots, now)
  const [mainChart, ...secondaryCharts] = charts
  const historyPanel = `<section class="panel" id="history">
  <h2>Latency and loss history</h2>
  <div class="graph-grid">
    ${renderChartCard(mainChart, now, { signature })}
    <div class="graph-grid graph-grid--mini">
      ${secondaryCharts.map((chart) => renderChartCard(chart, now, { signature })).join('\n')}
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
  <p class="panel-hint">Reconstructed <code>mtr --report</code> view of the newest snapshot. The full per-probe event stream is stored as JSON. Expand below or grab the file.</p>
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
  <td><time datetime="${escapeHtml(snapshot.collectedAt)}" title="${escapeHtml(absoluteCollectedAt)}">${escapeHtml(formatRelativeCollectedAt(snapshot.collectedAt, now))}</time><br /><code>${escapeHtml(snapshot.collectedAt)}</code></td>
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
  <td><span class="loss ${getDiagnosisClass(summary.diagnosis)}">${escapeHtml(summary.diagnosis.label)}</span> <span class="status-age" title="${escapeHtml(absoluteCollectedAt)}">(${escapeHtml(relativeCollectedAt)})</span></td>
  <td>${summary.hopCount}</td>
  <td><span class="loss ${historicalSeverity.className}">${escapeHtml(historicalSeverity.label)}</span></td>
  <td><span class="loss ${destinationLossClass}">${escapeHtml(formatLoss(aggregate.averageDestinationLossPct))}</span><br /><span>${aggregate.sampleCount} samples</span></td>
  <td><span class="loss ${getLossOccurrenceClass(diagnosisAggregate.destinationLossCount, diagnosisAggregate.sampleCount)}">${diagnosisAggregate.destinationLossCount}</span><span> / ${diagnosisAggregate.sampleCount}</span></td>
  <td>${suspectHop ? `<code>${escapeHtml(suspectHop.host)}</code><br /><span>${suspectHop.downstreamLossCount} downstream / ${suspectHop.isolatedLossCount} isolated</span>` : 'n/a'}</td>
  <td><a class="thumb-link" href="./${encodeURIComponent(targetSlug)}/">${renderChartCard(thumbnailChart, now, { compact: true, signature })}</a></td>
</tr>`
    })
    .join('\n')

  const html = renderLayout(
    `hopwatch: ${selfLabel}`,
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

  return html
}
