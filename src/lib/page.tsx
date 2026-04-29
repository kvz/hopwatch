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
import { extractIpv4Address, lookupNetworkOwner, type NetworkOwnerInfo } from './network-owner.ts'
import type { MtrRollupBucket } from './rollups.ts'
import { parseCollectedAt, type SnapshotSummary } from './snapshot.ts'
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
  summarizeHopProtocolStats,
  summarizeSnapshots,
} from './snapshot-aggregate.ts'
import type { HopwatchSqliteStore } from './sqlite-storage.ts'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

export interface RenderedTarget {
  html: string
  latestSnapshot: SnapshotSummary
}

function renderDocument(element: ReactElement): string {
  return `<!doctype html>\n${renderToStaticMarkup(element)}`
}

export async function renderTargetIndex(
  store: HopwatchSqliteStore,
  peers: PeerConfig[],
  selfLabel: string,
  selfHost: string | null,
  targetSlug: string,
  now = Date.now(),
  signature?: string,
): Promise<RenderedTarget | null> {
  const snapshots = store.listSnapshotSummaries(targetSlug)
  if (snapshots.length === 0) {
    return null
  }

  let latestSnapshot = snapshots[0]
  if (latestSnapshot.rawText === '') {
    const latestRawText = store.getSnapshotRawText(targetSlug, latestSnapshot.fileName)
    if (latestRawText != null) {
      latestSnapshot = { ...latestSnapshot, rawText: latestRawText }
      snapshots[0] = latestSnapshot
    }
  }
  const lastDaySnapshots = selectSnapshotsInWindow(snapshots, now, ONE_DAY_MS)
  const lastWeekSnapshots = selectSnapshotsInWindow(snapshots, now, SEVEN_DAYS_MS)
  const lastDay = summarizeSnapshots(lastDaySnapshots)
  const lastWeek = summarizeSnapshots(lastWeekSnapshots)
  // Exclude anonymized (???) hops from the top-5 "Recurring problematic hops"
  // table - they almost always represent routers that rate-limit ICMP reply,
  // so elevating them above real suspects is misleading. The hint under the
  // diagnosis explains the convention.
  const hopIssues = summarizeHopIssues(lastWeekSnapshots)
    .filter((hop) => hop.host !== '???')
    .slice(0, 5)
  const charts = await loadChartDefinitions(store, targetSlug, snapshots, now)
  const hourlyRollup = store.getRollupFile(targetSlug, 'hour')

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
  store: HopwatchSqliteStore,
  peers: PeerConfig[],
  selfLabel: string,
  selfHost: string | null,
  keepDays: number,
  now = Date.now(),
  signature?: string,
): Promise<string> {
  const targetSummaries: Array<{
    aggregate: SnapshotAggregate
    diagnosisAggregate: DiagnosisAggregate
    hopIssues: HopAggregate[]
    hourlyBuckets: MtrRollupBucket[]
    lastWeekSnapshots: SnapshotSummary[]
    summary: SnapshotSummary
    targetSlug: string
    thumbnailChart: ChartDefinition
  }> = []
  for (const targetSlug of store.listTargetSlugs()) {
    const snapshots = store.listSnapshotSummaries(targetSlug)
    if (snapshots.length === 0) {
      continue
    }

    const lastWeekSnapshots = selectSnapshotsInWindow(snapshots, now, SEVEN_DAYS_MS)
    // The cross-target diagnosis needs per-hop bucket history so it can
    // compute "degraded since" for the suspect hop. Missing or unparseable
    // rollups are treated as no history rather than fatal - the root page
    // should still render for fresh installs that have not accumulated a
    // full hour yet.
    const hourlyRollup = store.getRollupFile(targetSlug, 'hour')
    targetSummaries.push({
      aggregate: summarizeSnapshots(lastWeekSnapshots),
      diagnosisAggregate: summarizeDiagnoses(lastWeekSnapshots),
      hopIssues: summarizeHopIssues(lastWeekSnapshots),
      hourlyBuckets: hourlyRollup?.buckets ?? [],
      lastWeekSnapshots,
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
  const crossIssues = summarizeCrossTargetHopIssues(
    targetSummaries.map((entry) => {
      const asnByHost = new Map<string, string | null>()
      for (const hop of entry.summary.hops) {
        asnByHost.set(hop.host, hop.asn)
      }
      return {
        asnByHost,
        destinationHost: entry.summary.host,
        hopIssues: entry.hopIssues,
        // Protocol was added to SnapshotSummary; use the target's most
        // recent snapshot as the source of truth. A target cannot flip
        // protocols without a config edit + rolling restart, so the
        // latest snapshot is representative of the window.
        protocol: entry.summary.protocol,
        target: entry.targetSlug,
      }
    }),
  )
  // All-traversals stats (including clean hops) feed the shape classifier
  // so it can see that ICMP probes cross the suspect hop with 0% loss
  // even when those probes never appear in the lossy-only cross-issue
  // aggregate - the signal that distinguishes protocol_selective from a
  // generic "upstream path degraded".
  const hopProtocolStats = summarizeHopProtocolStats(
    targetSummaries.map((entry) => ({
      protocol: entry.summary.protocol,
      snapshots: entry.lastWeekSnapshots,
      target: entry.targetSlug,
    })),
  )
  const rollupBucketsByTarget = targetSummaries.map((entry) => entry.hourlyBuckets)
  const perTargetSnapshots = targetSummaries.map((entry) => ({
    protocol: entry.summary.protocol,
    snapshots: entry.lastWeekSnapshots,
    target: entry.targetSlug,
  }))
  const diagnosisContext = {
    now,
    perTargetSnapshots,
    rollupBucketsByTarget,
  }
  const preliminaryCrossTargetDiagnosis = getCrossTargetDiagnosis(
    crossIssues,
    hopProtocolStats,
    diagnosisContext,
  )
  const networkOwnersByHopHost = new Map<string, NetworkOwnerInfo>()
  const suspectHopHost = preliminaryCrossTargetDiagnosis.suspect?.host
  const suspectHopIp = suspectHopHost == null ? null : extractIpv4Address(suspectHopHost)
  if (suspectHopHost != null && suspectHopIp != null) {
    const cachedOwner = store.getNetworkOwnerCache(suspectHopIp)
    if (cachedOwner != null) {
      networkOwnersByHopHost.set(suspectHopHost, cachedOwner)
    } else {
      const lookedUpOwner = await lookupNetworkOwner(suspectHopIp).catch(() => null)
      if (lookedUpOwner != null) {
        store.upsertNetworkOwnerCache(lookedUpOwner)
        networkOwnersByHopHost.set(suspectHopHost, lookedUpOwner)
      }
    }
  }
  const crossTargetDiagnosis =
    networkOwnersByHopHost.size === 0
      ? preliminaryCrossTargetDiagnosis
      : getCrossTargetDiagnosis(crossIssues, hopProtocolStats, {
          ...diagnosisContext,
          networkOwnersByHopHost,
        })

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
