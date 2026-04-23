import { lookup } from 'node:dns/promises'
import {
  link,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'
import type { LoadedConfig, ProbeEngine, ProbeMode, ProbeProtocol, TargetConfig } from './config.ts'
import type { Logger } from './logger.ts'
import { parseRawMtrOutput, parseStoredRawSnapshot, type RawMtrEvent } from './raw.ts'
import { updateTargetRollups } from './rollups.ts'
import { formatCompactCollectedAt, RESERVED_TARGET_FILES } from './snapshot.ts'

export interface MtrHistoryTarget {
  slug: string
  label: string
  host: string
  probeMode: ProbeMode
  engine: ProbeEngine
  netns: string | null
  group: string
  protocol: ProbeProtocol
  port: number
}

export function targetFromConfig(config: TargetConfig): MtrHistoryTarget {
  return {
    slug: config.id,
    label: config.label,
    host: config.host,
    probeMode: config.probe_mode,
    engine: config.engine,
    netns: config.netns ?? null,
    group: config.group ?? 'default',
    protocol: config.protocol,
    port: config.port,
  }
}

export interface NativeProbeRequest {
  hostIp: string
  packets: number
  maxHops: number
  timeoutMs: number
  protocol: ProbeProtocol
  port: number
}

export type RunNativeProbeFn = (request: NativeProbeRequest) => Promise<RawMtrEvent[]>

// Load the Bun-only FFI prober lazily so this module can still be imported
// under vitest/Node (which lacks `bun:ffi`). Tests that exercise engine=native
// must inject a `runNativeProbeFn` dependency.
async function defaultRunNativeProbe(request: NativeProbeRequest): Promise<RawMtrEvent[]> {
  if (request.protocol === 'tcp') {
    const { probeTargetNativeTcp } = await import('./prober-native-tcp.ts')
    return probeTargetNativeTcp({
      hostIp: request.hostIp,
      maxHops: request.maxHops,
      packets: request.packets,
      port: request.port,
      timeoutMs: request.timeoutMs,
    })
  }
  const { probeTargetNative } = await import('./prober-native.ts')
  return probeTargetNative({
    hostIp: request.hostIp,
    maxHops: request.maxHops,
    packets: request.packets,
    timeoutMs: request.timeoutMs,
  })
}

async function defaultWarmupNativeEngine(): Promise<void> {
  const { warmupNativeEngine } = await import('./prober-native.ts')
  warmupNativeEngine()
}

type RunCommand = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{
  stderr: string
  stdout: string
}>

const execFileAsync: RunCommand = async (file, args, opts) => {
  // execa's `timeout` SIGTERMs the child after N ms and rejects the promise,
  // which is exactly the wedge-recovery behavior we want: a hung `mtr` or
  // `nsenter` that never writes to stdout must not hold the concurrency slot
  // (and therefore the next cycle) forever.
  const timeout = opts?.timeoutMs
  return timeout != null && timeout > 0 ? execa(file, args, { timeout }) : execa(file, args)
}

export interface CollectorOptions {
  concurrency: number
  ipVersion: '4' | '6'
  keepDays: number
  logDir: string
  mtrBin: string
  namespaceDir: string
  netnsMount: boolean
  packets: number
  probeTimeoutMs: number
  targets: MtrHistoryTarget[]
}

export interface CollectorDependencies {
  getNow?: () => Date
  runCommand?: RunCommand
  runNativeProbeFn?: RunNativeProbeFn
  // Calls warmupNativeEngine() from prober-native.ts; injectable so tests
  // don't have to load bun:ffi to exercise the musl / missing-glibc guard.
  warmupNativeEngineFn?: () => void
}

export function getTimestamp(now: Date = new Date()): string {
  return formatCompactCollectedAt(now)
}

export function collectorOptionsFromConfig(config: LoadedConfig): CollectorOptions {
  // Bound each probe at roughly half the cycle interval, floored at 60s. A
  // normal `mtr -c 20` finishes in ~20s; anything past the ceiling is stuck
  // and blocking the next cycle. Half-interval keeps 15-min cadences around
  // a 7.5-min ceiling - plenty of headroom for retries but not forever.
  const probeTimeoutMs = Math.max(60_000, Math.floor(config.probe.interval_seconds * 500))
  return {
    concurrency: config.probe.concurrency,
    ipVersion: String(config.probe.ip_version) as '4' | '6',
    keepDays: config.probe.keep_days,
    logDir: config.resolvedDataDir,
    mtrBin: config.probe.mtr_bin,
    namespaceDir: config.probe.namespace_dir,
    netnsMount: config.probe.netns_mount,
    packets: config.probe.packets,
    probeTimeoutMs,
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
    // Orphaned staging symlinks from updateLatestSymlink (if the process
    // crashed between `symlink` and `rename`) and orphaned rollup/snapshot
    // tmp files would otherwise accumulate indefinitely because neither
    // ends in `.txt` or `.json`. Pick them up here once they are older
    // than the retention window.
    const isStaleStaging =
      entry.name.startsWith('latest.json.new.') ||
      entry.name.includes('.tmp.') ||
      entry.name.endsWith('.tmp')
    const isRetainable = entry.name.endsWith('.txt') || entry.name.endsWith('.json')
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue
    }
    if (!isRetainable && !isStaleStaging) {
      continue
    }

    if (RESERVED_TARGET_FILES.has(entry.name)) {
      continue
    }

    const entryPath = path.join(targetDir, entry.name)
    // lstat so a dangling symlink doesn't throw ENOENT via stat().
    const entryStat = await lstat(entryPath)
    if (entryStat.mtimeMs >= cutoff) {
      continue
    }

    await rm(entryPath, { force: true })
  }
}

async function updateLatestSymlink(outputFile: string, latestFile: string): Promise<void> {
  // Point at the snapshot by its basename so the link stays valid if the
  // whole data directory is moved or restored under a different absolute path
  // (e.g. `/var/lib/hopwatch` → `/mnt/backup/hopwatch`). Using the absolute
  // `outputFile` here worked in place but broke after relocation.
  const relativeTarget = path.basename(outputFile)
  try {
    const existingTarget = await readlink(latestFile)
    if (existingTarget === relativeTarget) {
      return
    }
  } catch {
    // No existing symlink to preserve.
  }

  // Create under a unique sibling name and rename over `latest.json` so the
  // dashboard never sees a missing file. Before this, an `rm` followed by a
  // `symlink` left a brief window where concurrent readers got 404. rename()
  // replaces the old inode atomically on the same filesystem.
  const stagingFile = `${latestFile}.new.${process.pid}.${Date.now()}`
  await rm(stagingFile, { force: true })
  await symlink(relativeTarget, stagingFile)
  await rename(stagingFile, latestFile)
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

export interface CollectSnapshotDeps {
  runCommand?: RunCommand
  runNativeProbeFn?: RunNativeProbeFn
}

// Promise.race-based timeout wrapper. Node's DNS resolver and Bun's reverse
// DNS calls ignore AbortSignal, so a stuck resolver cannot be aborted - we can
// at least release the caller on schedule and let the underlying request
// finish in the background.
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

export async function collectSnapshot(
  nodeLabel: string,
  timestamp: string,
  options: CollectorOptions,
  target: MtrHistoryTarget,
  deps: CollectSnapshotDeps = {},
  logger?: Logger,
): Promise<void> {
  const runCommand = deps.runCommand ?? execFileAsync
  const runNativeProbeFn = deps.runNativeProbeFn ?? defaultRunNativeProbe

  const targetDir = await ensureLegacyAlias(options.logDir, target.slug)
  const jsonFile = path.join(targetDir, `${timestamp}.json`)
  // pid+random suffix prevents two overlapping cycles from the same target
  // slug colliding on the staging file and publishing a partial write.
  const tmpJsonFile = `${jsonFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`
  const latestJsonFile = path.join(targetDir, 'latest.json')

  let rawEvents: RawMtrEvent[]
  if (target.engine === 'native') {
    if (options.ipVersion !== '4') {
      throw new Error(
        `target '${target.slug}' uses engine='native' but ip_version=${options.ipVersion}; IPv6 is not yet supported`,
      )
    }

    // A broken or glacial resolver would otherwise pin a collector slot forever
    // (node's DNS lookups have no default timeout); cap at ~10% of the probe
    // budget so a bad nameserver can't starve later targets in the same cycle.
    const dnsDeadlineMs = Math.max(5_000, Math.floor(options.probeTimeoutMs / 10))
    const resolved = await withTimeout(
      lookup(target.host, 4),
      dnsDeadlineMs,
      `DNS lookup for '${target.host}' timed out after ${dnsDeadlineMs}ms`,
    )
    rawEvents = await runNativeProbeFn({
      hostIp: resolved.address,
      maxHops: 30,
      packets: options.packets,
      port: target.port,
      protocol: target.protocol,
      // Honor the same probe deadline the mtr path uses. Previously this was
      // hardcoded to 5s, which truncated late replies on slow paths and
      // diverged the two engines' behavior from the scheduler's budget.
      timeoutMs: options.probeTimeoutMs,
    })
    // An empty event stream from the native prober means every sendto()
    // failed (raw-socket EPERM, missing CAP_NET_RAW after a systemd reload,
    // etc). Persisting this used to produce a dashboard that disagreed with
    // itself: detail pages classified it as `unknown` (no events) while
    // rollups counted `destinationSentCount === 0` as 100% loss. Treat it
    // as a hard probe failure instead so the target lands in
    // failedTargetSlugs and the snapshot is not written at all.
    if (rawEvents.length === 0) {
      throw new Error(
        `native probe for '${target.slug}' returned no events (likely raw-socket failure - check CAP_NET_RAW)`,
      )
    }
  } else {
    const mtrArgs = ['-b', `-${options.ipVersion}`, '-l', '-c', String(options.packets)]
    // TCP probes carry a destination port; ICMP does not. `--tcp -P <port>`
    // is the mtr CLI for TCP SYN probes and is what we need to see the
    // protocol-selective loss that ICMP probes miss on some paths.
    if (target.protocol === 'tcp') {
      mtrArgs.push('--tcp', '-P', String(target.port))
    }
    mtrArgs.push(target.host)
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

    const { stdout } = await runCommand(command, commandArgs, {
      timeoutMs: options.probeTimeoutMs,
    })
    rawEvents = parseRawMtrOutput(stdout)
  }

  const storedSnapshot = {
    schemaVersion: 2 as const,
    collectedAt: timestamp,
    fileName: path.basename(jsonFile),
    host: target.host,
    label: target.label,
    observer: nodeLabel,
    probeMode: target.probeMode,
    protocol: target.protocol,
    rawEvents,
    target: target.host,
  }
  parseStoredRawSnapshot(`${JSON.stringify(storedSnapshot)}`)
  await writeFile(tmpJsonFile, `${JSON.stringify(storedSnapshot, null, 2)}\n`)
  // Publish atomically via link() instead of rename() so a second process
  // probing the same target in the same wall-clock second collides on
  // EEXIST instead of silently overwriting the first snapshot. The common
  // single-writer case is unaffected - link()+unlink() is one extra syscall.
  try {
    await link(tmpJsonFile, jsonFile)
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      await rm(tmpJsonFile, { force: true })
      throw new Error(
        `snapshot collision at ${jsonFile}: another process already wrote this timestamp`,
      )
    }
    throw err
  } finally {
    await rm(tmpJsonFile, { force: true })
  }
  await updateLatestSymlink(jsonFile, latestJsonFile)
  await removeOldSnapshots(targetDir, options.keepDays)
  logger?.info('snapshot saved', { file: jsonFile, target: target.slug })
}

async function updateRollupsForTargets(
  nodeLabel: string,
  options: CollectorOptions,
  nowDate: Date,
  fullRebuild = false,
  logger?: Logger,
): Promise<string[]> {
  const failedTargetSlugs: string[] = []
  await mapWithConcurrency(options.targets, options.concurrency, async (target) => {
    try {
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
        undefined,
        { fullRebuild },
      )
    } catch (err) {
      // Isolate rollup failures per-target. Without this a single unparseable
      // snapshot or transient write error aborted the rollup phase for every
      // remaining target and turned the whole collector cycle into a failure,
      // even when fresh raw snapshots had already been persisted.
      if (!(err instanceof Error)) {
        throw new Error(`Was thrown a non-error: ${err}`)
      }
      failedTargetSlugs.push(target.slug)
      logger?.error('rollup failed', { error: err.message, target: target.slug })
    }
  })
  return failedTargetSlugs
}

export interface RunCollectorResult {
  failedTargetSlugs: string[]
  failedRollupSlugs: string[]
}

export async function runCollector(
  config: LoadedConfig,
  logger: Logger,
  deps: CollectorDependencies = {},
): Promise<RunCollectorResult> {
  // The native prober uses bun:ffi to dlopen('libc.so.6') + AF_INET raw
  // sockets - that only exists on Linux. Catch the mismatch here (shared by
  // both the daemon's scheduler and `hopwatch probe-once`) instead of failing
  // mid-probe; config-check still passes on any platform so operators can
  // validate linux-targeted configs from a dev machine. Tests that inject a
  // mock `runNativeProbeFn` bypass the FFI load entirely and therefore also
  // bypass this guard - the check is about protecting the real code path.
  const nativeTargets = config.target.filter((target) => target.engine === 'native')
  // An explicit `warmupNativeEngineFn` in deps opts into the warmup path and
  // bypasses the platform check below, so tests can exercise the "libc failed
  // to load" branch on any OS without smuggling a no-op runNativeProbeFn in.
  const shouldRunWarmup =
    nativeTargets.length > 0 &&
    (deps.warmupNativeEngineFn != null ||
      (process.platform === 'linux' && deps.runNativeProbeFn == null))
  if (
    nativeTargets.length > 0 &&
    process.platform !== 'linux' &&
    deps.runNativeProbeFn == null &&
    deps.warmupNativeEngineFn == null
  ) {
    throw new Error(
      `target '${nativeTargets[0].id}' uses engine='native' but collector is running on ${process.platform}; engine='native' requires Linux`,
    )
  }
  // Linux-but-musl (Alpine, distroless-musl) does not ship glibc, so
  // dlopen('libc.so.6') inside the native prober fails with an opaque
  // bun:ffi error on every probe cycle. Warm the FFI load up front so the
  // failure surfaces once, with a clear glibc requirement, before the first
  // probe - matching the intent of the platform check above.
  if (shouldRunWarmup) {
    try {
      const warmup = deps.warmupNativeEngineFn ?? defaultWarmupNativeEngine
      await warmup()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(
        `target '${nativeTargets[0].id}' uses engine='native' but libc.so.6 could not be loaded (${reason}); engine='native' requires glibc Linux`,
      )
    }
  }

  const options = collectorOptionsFromConfig(config)

  await mkdir(options.logDir, { recursive: true })

  const nodeLabel = config.server.node_label ?? 'hopwatch'
  const nowDate = (deps.getNow ?? (() => new Date()))()
  const timestamp = getTimestamp(nowDate)
  const snapshotDeps: CollectSnapshotDeps = {
    runCommand: deps.runCommand,
    runNativeProbeFn: deps.runNativeProbeFn,
  }
  const failedTargetSlugs: string[] = []

  await mapWithConcurrency(options.targets, options.concurrency, async (target) => {
    try {
      await collectSnapshot(nodeLabel, timestamp, options, target, snapshotDeps, logger)
    } catch (err) {
      if (!(err instanceof Error)) {
        throw new Error(`Was thrown a non-error: ${err}`)
      }
      failedTargetSlugs.push(target.slug)
      logger.error('snapshot failed', { error: err.message, target: target.slug })
    }
  })

  const failedRollupSlugs = await updateRollupsForTargets(
    nodeLabel,
    options,
    nowDate,
    false,
    logger,
  )

  return { failedTargetSlugs, failedRollupSlugs }
}

export interface RefreshRollupsResult {
  failedTargetSlugs: string[]
}

export async function refreshRollups(
  config: LoadedConfig,
  logger: Logger | undefined,
  deps: CollectorDependencies = {},
): Promise<RefreshRollupsResult> {
  const options = collectorOptionsFromConfig(config)
  await mkdir(options.logDir, { recursive: true })
  const nodeLabel = config.server.node_label ?? 'hopwatch'
  const nowDate = (deps.getNow ?? (() => new Date()))()
  // `hopwatch rollup` is the recovery escape hatch - always do a full rebuild.
  const failedTargetSlugs = await updateRollupsForTargets(nodeLabel, options, nowDate, true, logger)
  return { failedTargetSlugs }
}
