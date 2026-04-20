import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'
import type { LoadedConfig, ProbeMode, TargetConfig } from './config.ts'
import type { Logger } from './logger.ts'
import { parseRawMtrOutput, parseStoredRawSnapshot } from './raw.ts'
import { updateTargetRollups } from './rollups.ts'

export interface MtrHistoryTarget {
  slug: string
  label: string
  host: string
  probeMode: ProbeMode
  netns: string | null
  group: string
}

export function targetFromConfig(config: TargetConfig): MtrHistoryTarget {
  return {
    slug: config.id,
    label: config.label,
    host: config.host,
    probeMode: config.probe_mode,
    netns: config.netns ?? null,
    group: config.group ?? 'default',
  }
}

type RunCommand = (
  file: string,
  args: string[],
) => Promise<{
  stderr: string
  stdout: string
}>

const execFileAsync: RunCommand = async (file, args) => execa(file, args)

export interface CollectorOptions {
  concurrency: number
  ipVersion: '4' | '6'
  keepDays: number
  logDir: string
  mtrBin: string
  namespaceDir: string
  netnsMount: boolean
  packets: number
  targets: MtrHistoryTarget[]
}

export interface CollectorDependencies {
  getNow?: () => Date
  runCommand?: RunCommand
}

export function getTimestamp(now: Date = new Date()): string {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const day = String(now.getUTCDate()).padStart(2, '0')
  const hours = String(now.getUTCHours()).padStart(2, '0')
  const minutes = String(now.getUTCMinutes()).padStart(2, '0')
  const seconds = String(now.getUTCSeconds()).padStart(2, '0')
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`
}

export function collectorOptionsFromConfig(config: LoadedConfig): CollectorOptions {
  return {
    concurrency: config.probe.concurrency,
    ipVersion: String(config.probe.ip_version) as '4' | '6',
    keepDays: config.probe.keep_days,
    logDir: config.resolvedDataDir,
    mtrBin: config.probe.mtr_bin,
    namespaceDir: config.probe.namespace_dir,
    netnsMount: config.probe.netns_mount,
    packets: config.probe.packets,
    targets: config.target.map(targetFromConfig),
  }
}

export function getTargetSlug(target: string): string {
  return target.replaceAll(/[^A-Za-z0-9._:-]/g, '-')
}

export function getLegacyTargetSlug(targetSlug: string): string {
  return `${targetSlug}-`
}

export async function removeOldSnapshots(
  targetDir: string,
  keepDays: number,
  now = Date.now(),
): Promise<void> {
  const entries = await readdir(targetDir, { withFileTypes: true })
  const maxAgeMs = keepDays * 24 * 60 * 60 * 1000
  const cutoff = now - maxAgeMs

  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith('.txt') && !entry.name.endsWith('.json'))) {
      continue
    }

    const entryPath = path.join(targetDir, entry.name)
    const entryStat = await stat(entryPath)
    if (entryStat.mtimeMs >= cutoff) {
      continue
    }

    await rm(entryPath, { force: true })
  }
}

async function updateLatestSymlink(outputFile: string, latestFile: string): Promise<void> {
  try {
    const existingTarget = await readlink(latestFile)
    if (existingTarget === outputFile) {
      return
    }
  } catch {
    // No existing symlink to preserve.
  }

  await rm(latestFile, { force: true })
  await symlink(outputFile, latestFile)
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await lstat(pathname)
    return true
  } catch {
    return false
  }
}

async function moveMissingEntries(sourceDir: string, destinationDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const destinationPath = path.join(destinationDir, entry.name)
    if (await pathExists(destinationPath)) {
      continue
    }

    await rename(sourcePath, destinationPath)
  }
}

async function ensureLegacyAlias(logDir: string, targetSlug: string): Promise<string> {
  const canonicalSlug = getTargetSlug(targetSlug)
  const legacySlug = getLegacyTargetSlug(canonicalSlug)
  const canonicalDir = path.join(logDir, canonicalSlug)
  const legacyDir = path.join(logDir, legacySlug)

  if (canonicalSlug === legacySlug) {
    await mkdir(canonicalDir, { recursive: true })
    return canonicalDir
  }

  const canonicalExists = await pathExists(canonicalDir)
  const legacyExists = await pathExists(legacyDir)

  if (!canonicalExists && legacyExists) {
    await rename(legacyDir, canonicalDir)
  } else {
    await mkdir(canonicalDir, { recursive: true })
    if (legacyExists) {
      const legacyStat = await lstat(legacyDir)
      if (legacyStat.isDirectory()) {
        await moveMissingEntries(legacyDir, canonicalDir)
        await rm(legacyDir, { recursive: true, force: true })
      }
    }
  }

  await rm(legacyDir, { force: true, recursive: true })
  await symlink(canonicalSlug, legacyDir)
  return canonicalDir
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (item == null) {
        return
      }

      await worker(item)
    }
  })

  await Promise.all(workers)
}

export async function collectSnapshot(
  nodeLabel: string,
  timestamp: string,
  options: CollectorOptions,
  target: MtrHistoryTarget,
  runCommand: RunCommand = execFileAsync,
  logger?: Logger,
): Promise<void> {
  const targetDir = await ensureLegacyAlias(options.logDir, target.slug)
  const jsonFile = path.join(targetDir, `${timestamp}.json`)
  const tmpJsonFile = `${jsonFile}.tmp`
  const latestJsonFile = path.join(targetDir, 'latest.json')

  const mtrArgs = ['-b', `-${options.ipVersion}`, '-l', '-c', String(options.packets), target.host]
  if (target.probeMode === 'netns' && options.namespaceDir.trim() === '') {
    throw new Error(
      `target '${target.slug}' uses probe_mode='netns' but the probe [namespace_dir] is empty`,
    )
  }

  if (target.probeMode === 'netns' && (target.netns == null || target.netns.trim() === '')) {
    throw new Error(
      `target '${target.slug}' uses probe_mode='netns' but has no 'netns' name configured`,
    )
  }

  const nsenterArgs: string[] = []
  if (options.netnsMount) {
    nsenterArgs.push(`--mount=${options.namespaceDir}/${target.netns}/mnt/ns`)
  }
  nsenterArgs.push(`--net=${options.namespaceDir}/${target.netns}/net/ns`)
  const [command, commandArgs] =
    target.probeMode === 'netns'
      ? ['nsenter', [...nsenterArgs, options.mtrBin, ...mtrArgs]]
      : [options.mtrBin, mtrArgs]

  const { stdout } = await runCommand(command, commandArgs)
  const rawEvents = parseRawMtrOutput(stdout)

  const storedSnapshot = {
    schemaVersion: 2 as const,
    collectedAt: timestamp,
    fileName: path.basename(jsonFile),
    host: target.host,
    label: target.label,
    observer: nodeLabel,
    probeMode: target.probeMode,
    rawEvents,
    target: target.host,
  }
  parseStoredRawSnapshot(`${JSON.stringify(storedSnapshot)}`)
  await writeFile(tmpJsonFile, `${JSON.stringify(storedSnapshot, null, 2)}\n`)
  await rename(tmpJsonFile, jsonFile)
  await updateLatestSymlink(jsonFile, latestJsonFile)
  await removeOldSnapshots(targetDir, options.keepDays)
  logger?.info('snapshot saved', { file: jsonFile, target: target.slug })
}

async function updateRollupsForTargets(
  nodeLabel: string,
  options: CollectorOptions,
  nowDate: Date,
): Promise<void> {
  await mapWithConcurrency(options.targets, options.concurrency, async (target) => {
    const targetDir = await ensureLegacyAlias(options.logDir, target.slug)
    await updateTargetRollups(
      targetDir,
      {
        host: target.host,
        label: target.label,
        observer: nodeLabel,
        probeMode: target.probeMode,
        target: target.host,
      },
      nowDate,
    )
  })
}

export async function runCollector(
  config: LoadedConfig,
  logger: Logger,
  deps: CollectorDependencies = {},
): Promise<void> {
  const options = collectorOptionsFromConfig(config)

  await mkdir(options.logDir, { recursive: true })

  const nodeLabel = config.server.node_label ?? 'hopwatch'
  const nowDate = (deps.getNow ?? (() => new Date()))()
  const timestamp = getTimestamp(nowDate)
  const runCommand = deps.runCommand ?? execFileAsync

  await mapWithConcurrency(options.targets, options.concurrency, async (target) => {
    await collectSnapshot(nodeLabel, timestamp, options, target, runCommand, logger)
  })

  await updateRollupsForTargets(nodeLabel, options, nowDate)
}

export async function refreshRollups(
  config: LoadedConfig,
  deps: CollectorDependencies = {},
): Promise<void> {
  const options = collectorOptionsFromConfig(config)
  await mkdir(options.logDir, { recursive: true })
  const nodeLabel = config.server.node_label ?? 'hopwatch'
  const nowDate = (deps.getNow ?? (() => new Date()))()
  await updateRollupsForTargets(nodeLabel, options, nowDate)
}
