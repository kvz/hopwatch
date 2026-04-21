import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import type { ProbeMode } from './config.ts'
import {
  parseStoredRawSnapshot,
  quantile,
  type StoredRawSnapshot,
  summarizeDestinationSamples,
} from './raw.ts'
import { listSnapshotFileNames } from './snapshot.ts'

export type RollupGranularity = 'hour' | 'day'

const histogramBucketSchema = z.object({
  count: z.number().int().min(0),
  upperBoundMs: z.number().positive().nullable(),
})

const mtrRollupBucketSchema = z.object({
  bucketStart: z.string().min(1),
  destinationLossPct: z.number().min(0).max(100),
  destinationReplyCount: z.number().int().min(0),
  destinationSentCount: z.number().int().min(0),
  histogram: z.array(histogramBucketSchema),
  rttAvgMs: z.number().nonnegative().nullable(),
  rttMaxMs: z.number().nonnegative().nullable(),
  rttMinMs: z.number().nonnegative().nullable(),
  rttP50Ms: z.number().nonnegative().nullable(),
  rttP90Ms: z.number().nonnegative().nullable(),
  rttP99Ms: z.number().nonnegative().nullable(),
  snapshotCount: z.number().int().min(0),
})

export const mtrRollupFileSchema = z.object({
  generatedAt: z.string().min(1),
  granularity: z.enum(['hour', 'day'] satisfies [RollupGranularity, RollupGranularity]),
  host: z.string().min(1),
  label: z.string().min(1),
  observer: z.string().min(1),
  probeMode: z.enum(['default', 'netns'] satisfies [ProbeMode, ProbeMode]),
  schemaVersion: z.literal(1),
  target: z.string().min(1),
  buckets: z.array(mtrRollupBucketSchema),
})

export type MtrRollupBucket = z.infer<typeof mtrRollupBucketSchema>
export type MtrRollupFile = z.infer<typeof mtrRollupFileSchema>

interface TargetRollupMetadata {
  host: string
  label: string
  observer: string
  probeMode: ProbeMode
  target: string
}

const histogramUpperBoundsMs = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function getCollectedAtDate(collectedAt: string): Date {
  const match = collectedAt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!match) {
    throw new Error(`Unsupported collectedAt timestamp: ${collectedAt}`)
  }

  const [, year, month, day, hour, minute, second] = match
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`)
}

function getBucketStartIso(date: Date, granularity: RollupGranularity): string {
  const bucketDate = new Date(date)
  bucketDate.setUTCMinutes(0, 0, 0)
  if (granularity === 'day') {
    bucketDate.setUTCHours(0, 0, 0, 0)
  }

  return bucketDate.toISOString()
}

function buildHistogram(rttSamplesMs: number[]): MtrRollupBucket['histogram'] {
  let previousUpperBoundMs = 0

  return [
    ...histogramUpperBoundsMs.map((upperBoundMs) => {
      const count = rttSamplesMs.filter(
        (sample) => sample > previousUpperBoundMs && sample <= upperBoundMs,
      ).length
      previousUpperBoundMs = upperBoundMs

      return {
        count,
        upperBoundMs,
      }
    }),
    {
      count: rttSamplesMs.filter(
        (sample) => sample > histogramUpperBoundsMs[histogramUpperBoundsMs.length - 1],
      ).length,
      upperBoundMs: null,
    },
  ]
}

function buildRollupBucket(
  bucketStart: string,
  snapshotCount: number,
  destinationSentCount: number,
  rttSamplesMs: number[],
): MtrRollupBucket {
  const destinationReplyCount = rttSamplesMs.length
  // When every snapshot in a bucket was completely blackholed,
  // summarizeDestinationSamples returns sentCount: 0 (no resolvable
  // destination hop). Reporting that as 0% loss would render a full hour of
  // "target unreachable" as a healthy bar on the long-range chart. Mirror
  // raw.ts's per-snapshot summary — zero sent, zero replies = 100% loss.
  // We only reach buildRollupBucket for non-empty buckets, so this branch
  // always represents "we had data, none of it hit the destination".
  const destinationLossPct =
    destinationSentCount === 0
      ? 100
      : ((destinationSentCount - destinationReplyCount) / destinationSentCount) * 100
  const sorted = [...rttSamplesMs].sort((left, right) => left - right)

  return {
    bucketStart,
    destinationLossPct,
    destinationReplyCount,
    destinationSentCount,
    histogram: buildHistogram(rttSamplesMs),
    rttAvgMs: average(rttSamplesMs),
    rttMaxMs: sorted.length === 0 ? null : sorted[sorted.length - 1],
    rttMinMs: sorted.length === 0 ? null : sorted[0],
    rttP50Ms: quantile(sorted, 0.5),
    rttP90Ms: quantile(sorted, 0.9),
    rttP99Ms: quantile(sorted, 0.99),
    snapshotCount,
  }
}

interface BucketReducerState {
  destinationSentCount: number
  rttSamplesMs: number[]
  snapshotCount: number
}

function reduceToRollupBuckets<T>(
  items: T[],
  granularity: RollupGranularity,
  bucketDateOf: (item: T) => Date,
  accumulate: (state: BucketReducerState, item: T) => void,
): MtrRollupBucket[] {
  const bucketState = new Map<string, BucketReducerState>()
  for (const item of items) {
    const bucketStart = getBucketStartIso(bucketDateOf(item), granularity)
    const current = bucketState.get(bucketStart) ?? {
      destinationSentCount: 0,
      rttSamplesMs: [],
      snapshotCount: 0,
    }
    accumulate(current, item)
    bucketState.set(bucketStart, current)
  }

  return [...bucketState.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bucketStart, state]) =>
      buildRollupBucket(
        bucketStart,
        state.snapshotCount,
        state.destinationSentCount,
        state.rttSamplesMs,
      ),
    )
}

export function aggregateSnapshotsToRollupBuckets(
  snapshots: StoredRawSnapshot[],
  granularity: RollupGranularity,
): MtrRollupBucket[] {
  return reduceToRollupBuckets(
    snapshots,
    granularity,
    (snapshot) => getCollectedAtDate(snapshot.collectedAt),
    (state, snapshot) => {
      const summary = summarizeDestinationSamples(snapshot.rawEvents)
      state.destinationSentCount += summary.sentCount
      state.rttSamplesMs.push(...summary.rttSamplesMs)
      state.snapshotCount += 1
    },
  )
}

function mergeRollupBuckets(
  existingBuckets: MtrRollupBucket[],
  generatedBuckets: MtrRollupBucket[],
  now: number,
  keepDays: number,
): MtrRollupBucket[] {
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000
  const merged = new Map<string, MtrRollupBucket>()

  for (const bucket of existingBuckets) {
    merged.set(bucket.bucketStart, bucket)
  }

  // A regenerated bucket only replaces the stored bucket if it reflects at least as
  // many underlying snapshots. Otherwise the raw-retention boundary would let a
  // partial regeneration silently erase the fuller historical rollup.
  for (const bucket of generatedBuckets) {
    const existing = merged.get(bucket.bucketStart)
    if (existing != null && existing.snapshotCount > bucket.snapshotCount) {
      continue
    }
    merged.set(bucket.bucketStart, bucket)
  }

  return [...merged.values()]
    .filter((bucket) => Date.parse(bucket.bucketStart) >= cutoff)
    .sort((left, right) => left.bucketStart.localeCompare(right.bucketStart))
}

function parseRollupFile(contents: string): MtrRollupFile {
  return mtrRollupFileSchema.parse(JSON.parse(contents))
}

export async function readRollupFile(
  filePath: string,
  granularity: RollupGranularity,
): Promise<MtrRollupFile | null> {
  let contents: string
  try {
    contents = await readFile(filePath, 'utf8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    throw err
  }

  try {
    const parsed = parseRollupFile(contents)
    if (parsed.granularity !== granularity) {
      throw new Error(
        `Expected ${filePath} to have granularity ${granularity}, got ${parsed.granularity}`,
      )
    }

    return parsed
  } catch (err) {
    // A corrupt rollup would otherwise be silently overwritten with whatever
    // we can still reconstruct from the raw snapshot retention window —
    // dropping years of hourly/daily history in the process. Quarantine the
    // bad file with a timestamped suffix so the next write starts fresh but
    // the original is preserved for post-mortem.
    const reason = err instanceof Error ? err.message : String(err)
    const quarantinePath = `${filePath}.corrupted.${Date.now()}`
    let quarantineError: string | null = null
    try {
      await rename(filePath, quarantinePath)
    } catch (renameErr) {
      // Previously swallowed silently, which produced a log line claiming the
      // file was quarantined even when the rename had failed — and the caller
      // would then `writeRollupFile()` over `filePath`, losing the original.
      // Surface it so operators at least see both failures in the log.
      quarantineError = renameErr instanceof Error ? renameErr.message : String(renameErr)
    }
    if (quarantineError != null) {
      process.stderr.write(
        `hopwatch: corrupt rollup at ${filePath} (${reason}); ` +
          `quarantine rename to ${quarantinePath} failed (${quarantineError}) — ` +
          `about to overwrite the corrupt file\n`,
      )
    } else {
      process.stderr.write(
        `hopwatch: corrupt rollup at ${filePath}, quarantined to ${quarantinePath}: ${reason}\n`,
      )
    }
    return null
  }
}

interface ListStoredRawSnapshotsOptions {
  // Only include snapshot files whose name is >= this prefix (the filename
  // format is lexicographically sortable — `YYYYMMDDTHHmmssZ.json`). Used by
  // updateTargetRollups for incremental re-aggregation so long histories do
  // not reparse every retained file on every cycle.
  sinceFileName?: string
  onReadSnapshot?: (fileName: string) => void
}

async function listStoredRawSnapshots(
  targetDir: string,
  options: ListStoredRawSnapshotsOptions = {},
): Promise<StoredRawSnapshot[]> {
  const { sinceFileName, onReadSnapshot } = options
  const snapshotFiles = await listSnapshotFileNames(targetDir)
  const snapshots: StoredRawSnapshot[] = []
  for (const fileName of snapshotFiles) {
    if (sinceFileName != null && fileName < sinceFileName) continue
    const filePath = path.join(targetDir, fileName)
    try {
      const contents = await readFile(filePath, 'utf8')
      onReadSnapshot?.(fileName)
      snapshots.push(parseStoredRawSnapshot(contents))
    } catch (err) {
      // A single unparseable snapshot must not abort the rollup rebuild for an
      // entire target. Surface the failure on stderr so operators can find and
      // triage the bad file — silently skipping would hide real bugs (schema
      // drift, partial writes) while also papering over on-disk corruption.
      const reason = err instanceof Error ? err.message : String(err)
      process.stderr.write(`hopwatch: skipping unreadable snapshot ${filePath}: ${reason}\n`)
    }
  }

  return snapshots
}

// Convert an ISO bucketStart (e.g. "2026-04-20T09:00:00.000Z") to the on-disk
// filename prefix format ("20260420T090000Z.json") used by raw snapshots, so
// we can filter by lexicographic comparison.
function isoBucketStartToFileName(iso: string): string | null {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/)
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  return `${y}${mo}${d}T${h}${mi}${s}Z.json`
}

// Returns true if `filePath` has a `.corrupted.<ts>` sibling left behind by
// a previous readRollupFile quarantine. Used to distinguish "rollup was
// just quarantined and needs a full rebuild" from "rollup never existed
// yet (normal startup)".
async function hasQuarantinedSibling(filePath: string): Promise<boolean> {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const prefix = `${base}.corrupted.`
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return false
  }
  return entries.some((name) => name.startsWith(prefix))
}

async function writeRollupFile(filePath: string, rollupFile: MtrRollupFile): Promise<void> {
  // Stage via a pid+random suffix so two overlapping cycles writing to the
  // same rollup (e.g. a scheduled run racing a manual `hopwatch rollup`)
  // cannot clobber each other's tmp file mid-write and ship truncated JSON.
  const tmpFilePath = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`
  await writeFile(tmpFilePath, `${JSON.stringify(rollupFile, null, 2)}\n`)
  await rename(tmpFilePath, filePath)
}

function buildRollupFile(
  granularity: RollupGranularity,
  metadata: TargetRollupMetadata,
  buckets: MtrRollupBucket[],
  now: Date,
): MtrRollupFile {
  return {
    buckets,
    generatedAt: now.toISOString(),
    granularity,
    host: metadata.host,
    label: metadata.label,
    observer: metadata.observer,
    probeMode: metadata.probeMode,
    schemaVersion: 1,
    target: metadata.target,
  }
}

interface UpdateTargetRollupsHooks {
  // Force a full re-aggregation that ignores the incremental cutoff. The
  // `hopwatch rollup` CLI uses this to recover from a situation where the
  // on-disk rollup is stale or incomplete; scheduled probes stay incremental.
  fullRebuild?: boolean
  onReadSnapshot?: (fileName: string) => void
}

export async function updateTargetRollups(
  targetDir: string,
  metadata: TargetRollupMetadata,
  now = new Date(),
  retention: { dailyKeepDays: number; hourlyKeepDays: number } = {
    dailyKeepDays: 365,
    hourlyKeepDays: 90,
  },
  hooks: UpdateTargetRollupsHooks = {},
): Promise<void> {
  const hourlyRollupPath = path.join(targetDir, 'hourly.rollup.json')
  const dailyRollupPath = path.join(targetDir, 'daily.rollup.json')

  // Read existing rollups first so we can derive an incremental re-aggregation
  // cutoff. Before this, every probe cycle reparsed and Zod-validated every
  // retained snapshot (keep_days * 96 files per target), which scales work
  // with total history instead of the ~1 new snapshot per cycle. Using the
  // latest hourly bucket start as the floor means only the currently-forming
  // hour bucket gets regenerated; older buckets survive via
  // mergeRollupBuckets' snapshotCount guard. The daily rollup also re-forms
  // its current (partial) bucket without reading yesterday's files again.
  const existingHourly = await readRollupFile(hourlyRollupPath, 'hour')
  const existingDaily = await readRollupFile(dailyRollupPath, 'day')

  let sinceFileName: string | undefined
  // A quarantined rollup (readRollupFile renamed it to `.corrupted.<ts>`)
  // leaves the other rollup intact. If we then derive sinceFileName from the
  // survivor's latest bucket, the rebuild for the missing side is scoped to
  // that narrow window and every older retained bucket is erased for good.
  // Force a full rebuild so the quarantined side repopulates from on-disk
  // history. Startup-state (neither rollup ever existed, or both absent) is
  // NOT in this branch, so the normal incremental path still applies there.
  const hourlyWasQuarantined =
    existingHourly == null && (await hasQuarantinedSibling(hourlyRollupPath))
  const dailyWasQuarantined =
    existingDaily == null && (await hasQuarantinedSibling(dailyRollupPath))
  const rollupJustQuarantined = hourlyWasQuarantined || dailyWasQuarantined
  if (!hooks.fullRebuild && !rollupJustQuarantined) {
    // Use the earlier of (latest hourly bucket start, latest daily bucket start)
    // as the incremental cutoff. Deriving it from only the hourly rollup freezes
    // the daily rollup: once the current hour advances past the day's first hour,
    // the regenerated daily bucket for today covers fewer snapshots than the
    // stored one, and mergeRollupBuckets' snapshotCount guard (which exists so
    // that raw-retention pruning doesn't silently erase fuller historical
    // buckets) keeps the stale daily bucket. The daily bucket start is always
    // at or before the latest hourly bucket start, so using it as the floor
    // regenerates both current buckets with a complete view.
    const latestHourlyStart = existingHourly?.buckets
      .map((bucket) => bucket.bucketStart)
      .sort()
      .at(-1)
    const latestDailyStart = existingDaily?.buckets
      .map((bucket) => bucket.bucketStart)
      .sort()
      .at(-1)
    const candidates: string[] = []
    if (latestHourlyStart != null) candidates.push(latestHourlyStart)
    if (latestDailyStart != null) candidates.push(latestDailyStart)
    if (candidates.length > 0) {
      const earliest = candidates.sort()[0]
      const converted = isoBucketStartToFileName(earliest)
      if (converted != null) sinceFileName = converted
    }
  }

  const snapshots = await listStoredRawSnapshots(targetDir, {
    sinceFileName,
    onReadSnapshot: hooks.onReadSnapshot,
  })
  if (snapshots.length === 0 && existingHourly == null && existingDaily == null) {
    return
  }

  const generatedHourly = aggregateSnapshotsToRollupBuckets(snapshots, 'hour')
  const mergedHourly = mergeRollupBuckets(
    existingHourly?.buckets ?? [],
    generatedHourly,
    now.getTime(),
    retention.hourlyKeepDays,
  )
  await writeRollupFile(hourlyRollupPath, buildRollupFile('hour', metadata, mergedHourly, now))

  const generatedDaily = aggregateSnapshotsToRollupBuckets(snapshots, 'day')
  const mergedDaily = mergeRollupBuckets(
    existingDaily?.buckets ?? [],
    generatedDaily,
    now.getTime(),
    retention.dailyKeepDays,
  )
  await writeRollupFile(dailyRollupPath, buildRollupFile('day', metadata, mergedDaily, now))
}
