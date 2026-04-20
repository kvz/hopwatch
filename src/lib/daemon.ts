import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { LoadedConfig } from './config.ts'
import { renderRootIndex, renderTargetIndex, runCollector } from './core.ts'
import type { Logger } from './logger.ts'

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
  const decoded = decodeURIComponent(urlPath)
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

interface SchedulerHandle {
  stop: () => void
}

function startScheduler(config: LoadedConfig, logger: Logger): SchedulerHandle {
  const intervalMs = config.probe.interval_seconds * 1000
  const jitterMs = config.probe.jitter_seconds * 1000
  let cancelled = false
  let activeRun: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  async function runOnce(): Promise<void> {
    if (cancelled || activeRun) {
      return
    }

    const run = (async (): Promise<void> => {
      const started = Date.now()
      try {
        await runCollector(config, logger)
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
  }

  function schedule(delay: number): void {
    if (cancelled) {
      return
    }

    timer = setTimeout(() => {
      void runOnce().then(() => {
        const jitter = Math.floor(Math.random() * Math.max(jitterMs, 1))
        schedule(intervalMs + jitter)
      })
    }, delay)
  }

  const initialJitter = Math.floor(Math.random() * Math.max(jitterMs, 1))
  schedule(initialJitter)

  return {
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

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await renderRootIndex(
          dataDir,
          config.peer,
          nodeLabel,
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
        const targetSlug = decodeURIComponent(targetMatch[1])
        const targetDir = safeResolve(dataDir, targetSlug)
        if (targetDir == null || targetDir === dataDir) {
          return new Response('forbidden', { status: 403 })
        }

        const rendered = await renderTargetIndex(
          targetDir,
          config.peer,
          nodeLabel,
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

  void runCollector(config, logger).catch((err: unknown) => {
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
  const [host] = listen.split(':')
  return host.length === 0 ? undefined : host
}

function parsePort(listen: string): number {
  const parts = listen.split(':')
  const raw = parts[parts.length - 1]
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid listen port in "${listen}"`)
  }

  return port
}
