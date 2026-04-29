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
} from './chart.ts'
export { renderChartSvg } from './chart-svg.ts'
export {
  collectorOptionsFromConfig,
  collectSnapshot,
  getTimestamp,
  type MtrHistoryTarget,
  refreshRollups,
  runCollector,
  targetFromConfig,
} from './collector.ts'
export type { ProbeMode } from './config.ts'
export { escapeHtml, getPeerNavLinks } from './layout.ts'
export { type RenderedTarget, renderRootIndex, renderTargetIndex } from './page.tsx'
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
  renderSnapshotRawText,
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
