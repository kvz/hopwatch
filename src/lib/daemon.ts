import { hostname as osHostname } from 'node:os'
// @ts-expect-error see note on sortableTablesSource - same import-attribute shape.
import copyButtonsSource from '../client/copy-buttons.ts' with { type: 'text' }
// @ts-expect-error Bun supports `with { type: 'text' }` to import the file's source as a string.
// TypeScript 5.x does not yet model this import-attribute based module shape; the runtime
// value is always a string and Bun.Transpiler handles the rest.
import relativeTimeSource from '../client/relative-time.ts' with { type: 'text' }
// @ts-expect-error see note on relativeTimeSource - same import-attribute shape.
import sortableTablesSource from '../client/sortable-tables.ts' with { type: 'text' }
import type { LoadedConfig } from './config.ts'
import { renderRootIndex, renderTargetIndex, runCollector } from './core.ts'
import { parseListenAddress } from './listen.ts'
import type { Logger } from './logger.ts'
import {
  buildSourceIdentity,
  type SourceIdentity,
  sourceIdentityWithFallback,
} from './source-identity.ts'
import { HopwatchSqliteStore } from './sqlite-storage.ts'

// Lazily transpile the sortable-tables client to browser JS on first request.
// Kept lazy so vitest (running under Node without globalThis.Bun) can import
// this module for the scheduler tests without blowing up at load time.
let sortableTablesJsCache: string | null = null
function getSortableTablesJs(): string {
  if (sortableTablesJsCache == null) {
    sortableTablesJsCache = new Bun.Transpiler({
      loader: 'ts',
      target: 'browser',
    }).transformSync(sortableTablesSource)
  }
  return sortableTablesJsCache
}

let relativeTimeJsCache: string | null = null
function getRelativeTimeJs(): string {
  if (relativeTimeJsCache == null) {
    relativeTimeJsCache = new Bun.Transpiler({
      loader: 'ts',
      target: 'browser',
    }).transformSync(relativeTimeSource)
  }
  return relativeTimeJsCache
}

let copyButtonsJsCache: string | null = null
function getCopyButtonsJs(): string {
  if (copyButtonsJsCache == null) {
    copyButtonsJsCache = new Bun.Transpiler({
      loader: 'ts',
      target: 'browser',
    }).transformSync(copyButtonsSource)
  }
  return copyButtonsJsCache
}

export interface SchedulerHandle {
  drain: () => Promise<void>
  runNow: () => Promise<void>
  stop: () => void
}

export interface SchedulerDependencies {
  // `| void` (not `| undefined`) lets vitest mocks that default to
  // Promise<void> satisfy this signature without spelling out the full
  // failed-slug shape.
  runCollectorFn?: (
    config: LoadedConfig,
    logger: Logger,
    // biome-ignore lint/suspicious/noConfusingVoidType: see note above.
  ) => Promise<{ failedTargetSlugs: string[]; failedRollupSlugs: string[] } | void>
  onCycleComplete?: () => void
}

export function startScheduler(
  config: LoadedConfig,
  logger: Logger,
  deps: SchedulerDependencies = {},
): SchedulerHandle {
  const intervalMs = config.probe.interval_seconds * 1000
  const jitterMs = config.probe.jitter_seconds * 1000
  const runCollectorFn = deps.runCollectorFn ?? runCollector
  let cancelled = false
  let activeRun: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  async function runOnce(): Promise<void> {
    if (cancelled) {
      return
    }

    if (activeRun != null) {
      await activeRun
      return
    }

    // An explicit runNow() replaces the pending scheduled tick, so we do not get
    // a bonus cycle from an initial-jitter timer still sitting in the queue.
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }

    const run = (async (): Promise<void> => {
      const started = Date.now()
      try {
        const result = await runCollectorFn(config, logger)
        const failedTargetSlugs = result?.failedTargetSlugs ?? []
        const failedRollupSlugs = result?.failedRollupSlugs ?? []
        // A "cycle complete" log on a partially-broken cycle (snapshot
        // failures, rollup failures) is a lie that masks stale charts.
        // Emit the same elapsed-ms context either way, but log at error
        // severity with the failed slugs so operators notice.
        if (failedTargetSlugs.length > 0 || failedRollupSlugs.length > 0) {
          logger.error('cycle completed with failures', {
            elapsedMs: Date.now() - started,
            failedRollupSlugs,
            failedTargetSlugs,
            targets: config.target.length,
          })
        } else {
          logger.info('cycle complete', {
            elapsedMs: Date.now() - started,
            targets: config.target.length,
          })
        }
      } catch (err) {
        if (!(err instanceof Error)) {
          throw new Error(`Was thrown a non-error: ${err}`)
        }

        logger.error('cycle failed', { message: err.message, stack: err.stack })
      } finally {
        deps.onCycleComplete?.()
      }
    })()
    activeRun = run
    try {
      await run
    } finally {
      activeRun = null
    }

    if (!cancelled) {
      const jitter = Math.floor(Math.random() * Math.max(jitterMs, 1))
      schedule(intervalMs + jitter)
    }
  }

  function schedule(delay: number): void {
    if (cancelled || timer != null) {
      return
    }

    timer = setTimeout(() => {
      timer = null
      void runOnce()
    }, delay)
  }

  const initialJitter = Math.floor(Math.random() * Math.max(jitterMs, 1))
  schedule(initialJitter)

  return {
    async drain(): Promise<void> {
      if (activeRun != null) {
        await activeRun
      }
    },
    runNow: runOnce,
    stop(): void {
      cancelled = true
      if (timer != null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

export async function startDaemon(config: LoadedConfig, logger: Logger): Promise<void> {
  const nodeLabel = config.server.node_label ?? 'hopwatch'
  const signature = config.chart.signature
  const store = await HopwatchSqliteStore.open(config.resolvedSqlitePath)
  const baseSourceIdentity = await loadDaemonSourceIdentity(config, logger)

  const scheduler = startScheduler(config, logger)

  const server = Bun.serve({
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url)
      if (url.pathname === '/healthz') {
        return new Response('ok', { status: 200 })
      }

      // The script tag uses `./assets/sortable-tables.js` so that it resolves
      // both under the daemon's own root (`/`) and behind a reverse-proxy
      // subpath (`/hopwatch/<slug>/...`). Accept any-depth suffix here so the
      // request always hits the in-memory transpile rather than the file
      // server, which would try to find it on disk per-slug.
      if (url.pathname.endsWith('/assets/sortable-tables.js')) {
        return new Response(getSortableTablesJs(), {
          headers: {
            'cache-control': 'public, max-age=3600',
            'content-type': 'application/javascript; charset=utf-8',
          },
        })
      }

      if (url.pathname.endsWith('/assets/relative-time.js')) {
        return new Response(getRelativeTimeJs(), {
          headers: {
            'cache-control': 'public, max-age=3600',
            'content-type': 'application/javascript; charset=utf-8',
          },
        })
      }

      if (url.pathname.endsWith('/assets/copy-buttons.js')) {
        return new Response(getCopyButtonsJs(), {
          headers: {
            'cache-control': 'public, max-age=3600',
            'content-type': 'application/javascript; charset=utf-8',
          },
        })
      }

      // Reverse-proxy layer passes the client-facing hostname via X-Forwarded-Host
      // (nginx default); fall back to Host. Used to render the active peer's
      // dropdown subtitle as "<host>[/<mount>]" so it matches the format shown
      // for remote peers instead of repeating the label.
      const selfHost =
        request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? null
      const sourceIdentity = sourceIdentityWithFallback(baseSourceIdentity, {
        publicHostname: publicHostnameFromHostHeader(selfHost),
      })

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await renderRootIndex(
          store,
          config.peer,
          nodeLabel,
          selfHost,
          config.probe.keep_days,
          Date.now(),
          signature,
          sourceIdentity,
          config.server.public_url,
        )
        return new Response(html, {
          headers: { 'cache-control': 'no-cache', 'content-type': 'text/html; charset=utf-8' },
        })
      }

      const jsonMatch = /^\/([^/]+)\/([^/]+\.json)$/.exec(url.pathname)
      if (jsonMatch != null) {
        let targetSlug: string
        let fileName: string
        try {
          targetSlug = decodeURIComponent(jsonMatch[1])
          fileName = decodeURIComponent(jsonMatch[2])
        } catch {
          return new Response('bad request', { status: 400 })
        }

        let json: string | null
        if (fileName === 'latest.json') {
          json = store.getLatestSnapshotJson(targetSlug)
        } else if (fileName === 'hourly.rollup.json') {
          const rollup = store.getRollupFile(targetSlug, 'hour')
          json = rollup == null ? null : `${JSON.stringify(rollup, null, 2)}\n`
        } else if (fileName === 'daily.rollup.json') {
          const rollup = store.getRollupFile(targetSlug, 'day')
          json = rollup == null ? null : `${JSON.stringify(rollup, null, 2)}\n`
        } else {
          json = store.getSnapshotJson(targetSlug, fileName)
        }

        if (json == null) {
          return new Response('not found', { status: 404 })
        }

        return new Response(json, {
          headers: {
            'cache-control': 'no-cache',
            'content-type': 'application/json; charset=utf-8',
          },
        })
      }

      const textMatch = /^\/([^/]+)\/([^/]+\.txt)$/.exec(url.pathname)
      if (textMatch != null) {
        let targetSlug: string
        let fileName: string
        try {
          targetSlug = decodeURIComponent(textMatch[1])
          fileName = decodeURIComponent(textMatch[2])
        } catch {
          return new Response('bad request', { status: 400 })
        }

        const rawText =
          fileName === 'latest.txt'
            ? store.getLatestSnapshotRawText(targetSlug)
            : store.getSnapshotRawText(targetSlug, fileName.replace(/\.txt$/, '.json'))

        if (rawText == null) {
          return new Response('not found', { status: 404 })
        }

        return new Response(`${rawText}\n`, {
          headers: {
            'cache-control': 'no-cache',
            'content-type': 'text/plain; charset=utf-8',
          },
        })
      }

      // Target dashboards live at `/<slug>/` or `/<slug>/index.html`.
      const targetMatch = /^\/([^/]+)\/(?:(?:index\.html)?$)/.exec(url.pathname)
      if (targetMatch != null) {
        let targetSlug: string
        try {
          targetSlug = decodeURIComponent(targetMatch[1])
        } catch {
          return new Response('bad request', { status: 400 })
        }
        const rendered = await renderTargetIndex(
          store,
          config.peer,
          nodeLabel,
          selfHost,
          targetSlug,
          Date.now(),
          signature,
        ).catch((err: unknown) => {
          if (!(err instanceof Error)) {
            throw new Error(`Was thrown a non-error: ${err}`)
          }
          logger.error('render target failed', { message: err.message, target: targetSlug })
          return null
        })
        if (rendered == null) {
          return new Response('not found', { status: 404 })
        }

        return new Response(rendered.html, {
          headers: { 'cache-control': 'no-cache', 'content-type': 'text/html; charset=utf-8' },
        })
      }

      return new Response('not found', { status: 404 })
    },
    hostname: parseHostname(config.server.listen),
    // Bun.serve defaults idleTimeout to 10s; the root dashboard render
    // walks all targets and easily exceeds that on production observers
    // (27 targets × 14 days of snapshots), so the connection was getting
    // closed without a response and haproxy turned that into a 502. Bump
    // it well above measured render time. Bun caps idleTimeout at 255s.
    idleTimeout: 240,
    port: parsePort(config.server.listen),
  })

  logger.info('http server ready', {
    dbPath: config.resolvedSqlitePath,
    hostname: server.hostname,
    port: server.port,
  })

  void scheduler.runNow().catch((err: unknown) => {
    if (!(err instanceof Error)) {
      throw new Error(`Was thrown a non-error: ${err}`)
    }
    logger.error('initial probe failed', { message: err.message })
  })

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      return
    }

    stopping = true
    logger.info('shutting down', { signal })
    scheduler.stop()
    // Bound drain so a wedged probe (e.g. hung `mtr`/`nsenter`) cannot turn
    // SIGTERM into a kill-9 wait. 30s is generous for a well-behaved cycle
    // to complete and short enough that systemd's TimeoutStopSec (90s by
    // default) still has headroom for the server.stop() call afterward.
    const drainDeadlineMs = 30_000
    await Promise.race([
      scheduler.drain(),
      new Promise<void>((resolve) => setTimeout(resolve, drainDeadlineMs).unref()),
    ])
    await server.stop()
    store.close()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  await new Promise<void>((resolve) => {
    process.on('exit', () => resolve())
  })
}

function parseHostname(listen: string): string | undefined {
  return parseListenAddress(listen).hostname
}

function parsePort(listen: string): number {
  return parseListenAddress(listen).port
}

function publicHostnameFromHostHeader(hostHeader: string | null): string | null {
  const first = hostHeader?.split(',')[0]?.trim()
  if (first == null || first === '') {
    return null
  }

  return first.replace(/:\d+$/, '')
}

async function loadDaemonSourceIdentity(
  config: LoadedConfig,
  logger: Logger,
): Promise<SourceIdentity> {
  const egressIp =
    config.identity.egress_ip ??
    (config.identity.egress_ip_lookup_url == null
      ? null
      : await discoverEgressIp(config.identity.egress_ip_lookup_url, logger))

  return buildSourceIdentity({
    datacenter: config.identity.datacenter,
    egressIp,
    hostname: config.identity.hostname ?? osHostname(),
    location: config.identity.location,
    provider: config.identity.provider,
    publicHostname: config.identity.public_hostname,
    siteLabel: config.identity.site_label,
  })
}

async function discoverEgressIp(url: string, logger: Logger): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) {
      logger.warn('egress ip discovery failed', {
        status: response.status,
        url,
      })
      return null
    }

    const text = (await response.text()).trim()
    if (!/^[0-9a-f:.]+$/i.test(text)) {
      logger.warn('egress ip discovery returned unexpected body', { url })
      return null
    }

    return text
  } catch (err) {
    if (!(err instanceof Error)) {
      throw new Error(`Was thrown a non-error: ${err}`)
    }

    logger.warn('egress ip discovery failed', { message: err.message, url })
    return null
  }
}
