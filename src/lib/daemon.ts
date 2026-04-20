import { stat } from 'node:fs/promises'
import path from 'node:path'
// @ts-expect-error Bun supports `with { type: 'text' }` to import the file's source as a string.
// TypeScript 5.x does not yet model this import-attribute based module shape; the runtime
// value is always a string and Bun.Transpiler handles the rest.
import sortableTablesSource from '../client/sortable-tables.ts' with { type: 'text' }
import type { LoadedConfig } from './config.ts'
import { renderRootIndex, renderTargetIndex, runCollector } from './core.ts'
import { parseListenAddress } from './listen.ts'
import type { Logger } from './logger.ts'

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

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

function safeResolve(root: string, urlPath: string): string | null {
  // decodeURIComponent throws URIError on malformed percent-encoding (e.g.
  // `/%E0%A4`). A probe or attacker hitting such a URL must not bubble up to
  // the fetch handler and produce a generic 500 — return null so the caller
  // can respond with a 4xx.
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }

  const trimmed = decoded.replace(/^\/+/, '')
  const resolved = path.resolve(root, trimmed)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return null
  }

  return resolved
}

async function serveFile(root: string, urlPath: string): Promise<Response> {
  const resolved = safeResolve(root, urlPath)
  if (resolved == null) {
    return new Response('forbidden', { status: 403 })
  }

  let filePath = resolved
  try {
    const info = await stat(filePath)
    if (info.isDirectory()) {
      filePath = path.join(filePath, 'index.html')
    }
  } catch {
    return new Response('not found', { status: 404 })
  }

  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    return new Response('not found', { status: 404 })
  }

  return new Response(file, {
    headers: {
      'cache-control': 'no-cache',
      'content-type': contentTypeFor(filePath),
    },
  })
}

export interface SchedulerHandle {
  drain: () => Promise<void>
  runNow: () => Promise<void>
  stop: () => void
}

export interface SchedulerDependencies {
  runCollectorFn?: (config: LoadedConfig, logger: Logger) => Promise<void>
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
        await runCollectorFn(config, logger)
        logger.info('cycle complete', {
          elapsedMs: Date.now() - started,
          targets: config.target.length,
        })
      } catch (err) {
        if (!(err instanceof Error)) {
          throw new Error(`Was thrown a non-error: ${err}`)
        }

        logger.error('cycle failed', { message: err.message, stack: err.stack })
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
  // The native prober uses bun:ffi to dlopen('libc.so.6') + AF_INET raw
  // sockets — that only exists on Linux. Darwin/Windows builds are published
  // (binaries.yml), so catch the mismatch at startup rather than failing
  // mid-probe on the first cycle. config-check still passes on any platform
  // so operators can validate linux-targeted configs from a dev machine.
  if (process.platform !== 'linux') {
    for (const target of config.target) {
      if (target.engine === 'native') {
        throw new Error(
          `target '${target.id}' uses engine='native' but this daemon is running on ${process.platform}; engine='native' requires Linux`,
        )
      }
    }
  }

  const scheduler = startScheduler(config, logger)

  const nodeLabel = config.server.node_label ?? 'hopwatch'
  const signature = config.chart.signature
  const dataDir = config.resolvedDataDir

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

      // Reverse-proxy layer passes the client-facing hostname via X-Forwarded-Host
      // (nginx default); fall back to Host. Used to render the active peer's
      // dropdown subtitle as "<host>[/<mount>]" so it matches the format shown
      // for remote peers instead of repeating the label.
      const selfHost =
        request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? null

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await renderRootIndex(
          dataDir,
          config.peer,
          nodeLabel,
          selfHost,
          config.probe.keep_days,
          Date.now(),
          signature,
        )
        return new Response(html, {
          headers: { 'cache-control': 'no-cache', 'content-type': 'text/html; charset=utf-8' },
        })
      }

      // Target dashboards live at `/<slug>/` or `/<slug>/index.html`. Everything else
      // (snapshot JSONs, latest.json, favicon, nested assets) still falls through to
      // the static file server below.
      const targetMatch = /^\/([^/]+)\/(?:(?:index\.html)?$)/.exec(url.pathname)
      if (targetMatch != null) {
        let targetSlug: string
        try {
          targetSlug = decodeURIComponent(targetMatch[1])
        } catch {
          return new Response('bad request', { status: 400 })
        }
        const targetDir = safeResolve(dataDir, targetSlug)
        if (targetDir == null || targetDir === dataDir) {
          return new Response('forbidden', { status: 403 })
        }

        const rendered = await renderTargetIndex(
          targetDir,
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

      return serveFile(dataDir, url.pathname)
    },
    hostname: parseHostname(config.server.listen),
    port: parsePort(config.server.listen),
  })

  logger.info('http server ready', {
    dataDir,
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
