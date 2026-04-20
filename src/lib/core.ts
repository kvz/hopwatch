// Thin re-export facade. The implementation was split into focused submodules
// (chart, collector, layout, page, snapshot) to keep each file under ~800 lines.
// External importers (bin, daemon, tests, fixture scripts) continue to import
// from './core.ts' without changes.

export {
  bucketTimestamp,
  type ChartDefinition,
  type ChartPoint,
  getPointsFromRollupBuckets,
  getPointsFromSnapshots,
  loadChartDefinitions,
  renderChartMiniSvg,
} from './chart.ts'
export { renderChartSvg } from './chart-svg.ts'
export {
  collectorOptionsFromConfig,
  collectSnapshot,
  getLegacyTargetSlug,
  getTargetSlug,
  getTimestamp,
  type MtrHistoryTarget,
  type RunCollectorOptions,
  removeOldSnapshots,
  runCollector,
  targetFromConfig,
} from './collector.ts'
export type { ProbeMode } from './config.ts'
export { escapeHtml, getPeerNavLinks, renderLayout, renderTopNav } from './layout.ts'
export {
  listTargetSnapshots,
  renderChartCard,
  writeRootIndex,
  writeTargetIndex,
} from './page.ts'
export {
  diagnoseSnapshot,
  formatAbsoluteCollectedAt,
  formatLoss,
  formatRelativeCollectedAt,
  getDiagnosisClass,
  getLossClass,
  getLossOccurrenceClass,
  type HopRecord,
  parseCollectedAt,
  parseHopLine,
  parseSnapshotSummary,
  parseStoredSnapshotSummary,
  readSnapshotSummary,
  renderDiagnosisSummary,
  renderHopHostHtml,
  renderSnapshotRawText,
  renderUnknownHopHost,
  type SnapshotDiagnosis,
  type SnapshotSummary,
} from './snapshot.ts'
export {
  type DiagnosisAggregate,
  getHistoricalSeverityBadge,
  getRootSuspectHop,
  type HopAggregate,
  type SeverityBadge,
  type SnapshotAggregate,
  shouldSurfaceHopIssueForRoot,
  summarizeDiagnoses,
  summarizeHopIssues,
  summarizeSnapshots,
} from './snapshot-aggregate.ts'
