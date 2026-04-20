import { readFile, rename, writeFile } from 'node:fs/promises'
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
  const destinationLossPct =
    destinationSentCount === 0
      ? 0
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

function aggregateRollupBuckets(
  buckets: MtrRollupBucket[],
  granularity: RollupGranularity,
): MtrRollupBucket[] {
  return reduceToRollupBuckets(
    buckets,
    granularity,
    (bucket) => new Date(bucket.bucketStart),
    (state, bucket) => {
      state.destinationSentCount += bucket.destinationSentCount
      state.snapshotCount += bucket.snapshotCount
      for (const histogramBucket of bucket.histogram) {
        if (histogramBucket.count === 0) continue
        const sampleValue =
          histogramBucket.upperBoundMs ??
          histogramUpperBoundsMs[histogramUpperBoundsMs.length - 1] + 1
        for (let i = 0; i < histogramBucket.count; i += 1) {
          state.rttSamplesMs.push(sampleValue)
        }
      }
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

  for (const bucket of generatedBuckets) {
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
  try {
    const contents = await readFile(filePath, 'utf8')
    const parsed = parseRollupFile(contents)
    if (parsed.granularity !== granularity) {
      throw new Error(
        `Expected ${filePath} to have granularity ${granularity}, got ${parsed.granularity}`,
      )
    }

    return parsed
  } catch {
    return null
  }
}

async function listStoredRawSnapshots(targetDir: string): Promise<StoredRawSnapshot[]> {
  const snapshotFiles = await listSnapshotFileNames(targetDir)
  const snapshots: StoredRawSnapshot[] = []
  for (const fileName of snapshotFiles) {
    try {
      const contents = await readFile(path.join(targetDir, fileName), 'utf8')
      snapshots.push(parseStoredRawSnapshot(contents))
    } catch {}
  }

  return snapshots
}

async function writeRollupFile(filePath: string, rollupFile: MtrRollupFile): Promise<void> {
  const tmpFilePath = `${filePath}.tmp`
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

export async function updateTargetRollups(
  targetDir: string,
  metadata: TargetRollupMetadata,
  now = new Date(),
  retention: { dailyKeepDays: number; hourlyKeepDays: number } = {
    dailyKeepDays: 365,
    hourlyKeepDays: 90,
  },
): Promise<void> {
  const snapshots = await listStoredRawSnapshots(targetDir)
  if (snapshots.length === 0) {
    return
  }

  const hourlyRollupPath = path.join(targetDir, 'hourly.rollup.json')
  const existingHourly = await readRollupFile(hourlyRollupPath, 'hour')
  const generatedHourly = aggregateSnapshotsToRollupBuckets(snapshots, 'hour')
  const mergedHourly = mergeRollupBuckets(
    existingHourly?.buckets ?? [],
    generatedHourly,
    now.getTime(),
    retention.hourlyKeepDays,
  )
  await writeRollupFile(hourlyRollupPath, buildRollupFile('hour', metadata, mergedHourly, now))

  const dailyRollupPath = path.join(targetDir, 'daily.rollup.json')
  const existingDaily = await readRollupFile(dailyRollupPath, 'day')
  const generatedDaily = aggregateRollupBuckets(mergedHourly, 'day')
  const mergedDaily = mergeRollupBuckets(
    existingDaily?.buckets ?? [],
    generatedDaily,
    now.getTime(),
    retention.dailyKeepDays,
  )
  await writeRollupFile(dailyRollupPath, buildRollupFile('day', metadata, mergedDaily, now))
}
