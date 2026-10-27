import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { execa } from 'execa'
import type { LoadedConfig, ProbeEngine, ProbeMode, ProbeProtocol, TargetConfig } from './config.ts'
import type { Logger } from './logger.ts'
import {
  parseRawMtrOutput,
  parseStoredRawSnapshot,
  type RawMtrEvent,
  resolveDestinationHopIndex,
} from './raw.ts'
import { formatCompactCollectedAt } from './snapshot.ts'
import { HopwatchSqliteStore, type HopwatchStorage } from './sqlite-storage.ts'

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
  intervalSeconds?: number
  packets?: number
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
    intervalSeconds: config.interval_seconds,
    packets: config.packets,
  }
}

export interface NativeProbeRequest {
  timeOriginMs?: number
  hostIp: string
  packets: number
  maxHops: number
  timeoutMs: number
  protocol: ProbeProtocol
  port: number
}

export type RunNativeProbeFn = (request: NativeProbeRequest) => Promise<RawMtrEvent[]>

export interface ConnectProbeRequest {
  host: string
  packets: number
  timeoutMs: number
  ipVersion: '4' | '6'
  port: number
  signal?: AbortSignal
  timeOriginMs?: number
}

export type RunConnectProbeFn = (request: ConnectProbeRequest) => Promise<RawMtrEvent[]>

// Load the Bun-only FFI prober lazily so this module can still be imported
// under vitest/Node (which lacks `bun:ffi`). Tests that exercise engine=native
// must inject a `runNativeProbeFn` dependency.
async function defaultRunNativeProbe(request: NativeProbeRequest): Promise<RawMtrEvent[]> {
  if (request.protocol === 'tcp') {
    const { probeTargetNativeTcp } = await import('./prober-native-tcp.ts')
    return probeTargetNativeTcp({
      timeOriginMs: request.timeOriginMs,
      hostIp: request.hostIp,
      maxHops: request.maxHops,
      packets: request.packets,
      port: request.port,
      timeoutMs: request.timeoutMs,
    })
  }
  const { probeTargetNative } = await import('./prober-native.ts')
  return probeTargetNative({
    timeOriginMs: request.timeOriginMs,
    hostIp: request.hostIp,
    maxHops: request.maxHops,
    packets: request.packets,
    timeoutMs: request.timeoutMs,
  })
}

async function defaultRunConnectProbe(request: ConnectProbeRequest): Promise<RawMtrEvent[]> {
  const { probeTargetConnect } = await import('./prober-connect.ts')
  return probeTargetConnect(request)
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
  mtrBin: string
  namespaceDir: string
  netnsMount: boolean
  packets: number
  probeTimeoutMs: number
  targets: MtrHistoryTarget[]
}

export interface CollectorDependencies {
  sqliteStore?: HopwatchStorage
  scheduledAt?: Date
  getNow?: () => Date
  openStoreFn?: (dbPath: string) => Promise<HopwatchStorage>
  runCommand?: RunCommand
  runConnectProbeFn?: RunConnectProbeFn
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
    mtrBin: config.probe.mtr_bin,
    namespaceDir: config.probe.namespace_dir,
    netnsMount: config.probe.netns_mount,
    packets: config.probe.packets,
    probeTimeoutMs,
    targets: config.target.map(targetFromConfig),
  }
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
  nativeFailure?: string
  getNow?: () => Date
  scheduledAt?: Date
  signal?: AbortSignal
  timeOriginMs?: number
  runCommand?: RunCommand
  runConnectProbeFn?: RunConnectProbeFn
  runNativeProbeFn?: RunNativeProbeFn
  sqliteStore?: HopwatchStorage
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

async function collectProbeEvents(
  options: CollectorOptions,
  target: MtrHistoryTarget,
  deps: CollectSnapshotDeps = {},
): Promise<RawMtrEvent[]> {
  const runCommand = deps.runCommand ?? execFileAsync
  const runConnectProbeFn = deps.runConnectProbeFn ?? defaultRunConnectProbe
  const runNativeProbeFn = deps.runNativeProbeFn ?? defaultRunNativeProbe
  let rawEvents: RawMtrEvent[]
  if (target.engine === 'connect') {
    if (target.protocol !== 'tcp') {
      throw new Error(
        `target '${target.slug}' uses engine='connect' but protocol='${target.protocol}'; engine='connect' requires protocol='tcp'`,
      )
    }

    if (target.probeMode === 'netns') {
      throw new Error(
        `target '${target.slug}' uses engine='connect' with probe_mode='netns', which is not yet supported`,
      )
    }

    rawEvents = await runConnectProbeFn({
      host: target.host,
      signal: deps.signal,
      timeOriginMs: deps.timeOriginMs,
      ipVersion: options.ipVersion,
      packets: options.packets,
      port: target.port,
      timeoutMs: options.probeTimeoutMs,
    })
    if (rawEvents.length === 0) {
      throw new Error(`connect probe for '${target.slug}' returned no events`)
    }
  } else if (target.engine === 'native') {
    if (deps.nativeFailure != null) throw new Error(deps.nativeFailure)
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
      timeOriginMs: deps.timeOriginMs,
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
    // as a collector failure: preserve its error and time range without
    // counting an empty result as destination packet loss.
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

  return rawEvents
}

export async function collectSnapshot(
  nodeLabel: string,
  timestamp: string,
  options: CollectorOptions,
  target: MtrHistoryTarget,
  deps: CollectSnapshotDeps = {},
  logger?: Logger,
): Promise<void> {
  if (deps.sqliteStore == null) throw new Error('collectSnapshot requires an open SQLite store')
  const getNow = deps.getNow ?? (() => new Date())
  const startedAt = getNow()
  const timeOriginMs = performance.now()
  const sentinel = target.intervalSeconds != null
  const settings = sentinel
    ? { ...options, packets: target.packets ?? 3, probeTimeoutMs: 10_000 }
    : options
  const controller = new AbortController()
  let rawEvents: RawMtrEvent[] = []
  let failure: string | undefined
  try {
    const probe = collectProbeEvents(settings, target, {
      ...deps,
      signal: controller.signal,
      timeOriginMs,
    })
    // Native traces own their send/drain and reverse-DNS budgets. Racing that
    // same deadline discards valid results during the final drain/rDNS phase.
    rawEvents = sentinel
      ? await withTimeout(
          probe,
          settings.probeTimeoutMs,
          `probe for '${target.slug}' exceeded ${settings.probeTimeoutMs}ms deadline`,
        )
      : await probe
  } catch (err) {
    failure = (err instanceof Error ? err.message : String(err)).slice(0, 1000)
  } finally {
    controller.abort()
  }
  const finishedAt = getNow().toISOString()
  const collectedAt = getTimestamp(startedAt)
  const destinationHop = resolveDestinationHopIndex(rawEvents)
  const destinationIp = [...rawEvents]
    .reverse()
    .find(
      (event) =>
        event.kind === 'host' && event.hopIndex === destinationHop && isIP(event.host) !== 0,
    )
  const storedSnapshot = {
    schemaVersion: 2 as const,
    collectedAt,
    startedAt: startedAt.toISOString(),
    finishedAt,
    scheduledAt: (deps.scheduledAt ?? startedAt).toISOString(),
    cycleId: timestamp,
    destinationIp: destinationIp?.kind === 'host' ? destinationIp.host : null,
    ...(failure == null ? {} : { failure }),
    engine: target.engine,
    fileName: `${collectedAt}.json`,
    host: target.host,
    label: target.label,
    netns: target.netns,
    observer: nodeLabel,
    port: target.port,
    probeMode: target.probeMode,
    protocol: target.protocol,
    rawEvents,
    target: target.host,
  }
  const snapshotContents = `${JSON.stringify(storedSnapshot, null, 2)}\n`
  deps.sqliteStore.insertRawSnapshot(
    {
      contents: snapshotContents,
      fileName: storedSnapshot.fileName,
      sourcePath: `sqlite://${target.slug}/${storedSnapshot.fileName}`,
      targetSlug: target.slug,
    },
    parseStoredRawSnapshot(snapshotContents),
  )
  logger?.info('snapshot saved', { fileName: storedSnapshot.fileName, target: target.slug })
  if (failure != null) throw new Error(failure)
}

async function updateRollupsForTargets(
  nodeLabel: string,
  options: CollectorOptions,
  store: HopwatchStorage,
  nowDate: Date,
  fullRebuild = false,
  logger?: Logger,
): Promise<string[]> {
  const failedTargetSlugs: string[] = []
  await mapWithConcurrency(options.targets, options.concurrency, async (target) => {
    try {
      // Sentinels retain one day of small raw samples; the slow trace targets
      // supply long-term rollups. Avoid rebuilding rollups on every fast tick.
      if (target.intervalSeconds != null) {
        store.pruneRawSnapshots(target.slug, 1, nowDate.getTime())
        return
      }
      store.updateRollupsForTarget(target, nodeLabel, nowDate, undefined, fullRebuild)
      store.pruneRawSnapshots(target.slug, options.keepDays, nowDate.getTime())
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
  let nativeFailure: string | undefined
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
    nativeFailure = `engine='native' requires Linux; collector is running on ${process.platform}`
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
      nativeFailure = `libc.so.6 could not be loaded (${reason}); engine='native' requires glibc Linux`
    }
  }

  const options = collectorOptionsFromConfig(config)
  const nodeLabel = config.server.node_label ?? 'hopwatch'
  const nowDate = (deps.getNow ?? (() => new Date()))()
  const timestamp = getTimestamp(nowDate)
  const snapshotDeps: CollectSnapshotDeps = {
    nativeFailure,
    getNow: deps.getNow,
    scheduledAt: deps.scheduledAt ?? nowDate,
    runCommand: deps.runCommand,
    runConnectProbeFn: deps.runConnectProbeFn,
    runNativeProbeFn: deps.runNativeProbeFn,
  }
  const openStore =
    deps.openStoreFn ??
    ((dbPath: string): Promise<HopwatchStorage> => HopwatchSqliteStore.open(dbPath))
  const sqliteStore = deps.sqliteStore ?? (await openStore(config.resolvedSqlitePath))
  snapshotDeps.sqliteStore = sqliteStore
  const failedTargetSlugs: string[] = []
  let failedRollupSlugs: string[] = []

  try {
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
    failedRollupSlugs = await updateRollupsForTargets(
      nodeLabel,
      options,
      sqliteStore,
      nowDate,
      false,
      logger,
    )
  } finally {
    if (deps.sqliteStore == null) sqliteStore.close()
  }

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
  const nodeLabel = config.server.node_label ?? 'hopwatch'
  const nowDate = (deps.getNow ?? (() => new Date()))()
  const openStore =
    deps.openStoreFn ??
    ((dbPath: string): Promise<HopwatchStorage> => HopwatchSqliteStore.open(dbPath))
  const sqliteStore = await openStore(config.resolvedSqlitePath)
  let failedTargetSlugs: string[]
  try {
    // `hopwatch rollup` is the recovery escape hatch - always do a full rebuild.
    failedTargetSlugs = await updateRollupsForTargets(
      nodeLabel,
      options,
      sqliteStore,
      nowDate,
      true,
      logger,
    )
  } finally {
    sqliteStore.close()
  }
  return { failedTargetSlugs }
}
