import { realpath, stat } from 'node:fs/promises'
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

// Resolves a target-dashboard slug to its on-disk directory while guarding
// against symlink escape. The daemon's target route previously only applied
// the lexical `safeResolve()` check, so a symlink under data_dir pointing at
// /var/log or /etc would render — the page code then enumerated and parsed
// JSON files from outside the data tree. Must stay in lockstep with
// `resolveServeFilePath` so both entry points enforce the same containment
// contract. Returns the realpath of the directory, or null if missing /
// not-a-directory / escapes the root.
export async function resolveTargetDirPath(root: string, slug: string): Promise<string | null> {
  const lexical = safeResolve(root, slug)
  if (lexical == null) return null

  try {
    const info = await stat(lexical)
    if (!info.isDirectory()) return null
  } catch {
    return null
  }

  let realRoot: string
  let realDir: string
  try {
    realRoot = await realpath(root)
    realDir = await realpath(lexical)
  } catch {
    return null
  }

  // The bare root is never a valid target dir — the dashboard needs a leaf
  // under it. This matches the daemon's existing `targetDir === dataDir`
  // 403 guard and keeps the realpath version just as strict.
  if (realDir === realRoot) return null
  if (!realDir.startsWith(`${realRoot}${path.sep}`)) return null

  return realDir
}

// Resolves a URL path to a file on disk while guarding against symlink escape.
// `safeResolve()` only checks the lexical path, but `stat()` and `Bun.file()`
// both follow symlinks — so a symlink under data_dir pointing at /etc/passwd
// would otherwise be happily served. We realpath both the root and the
// resolved target and require the target stay within the root's realpath.
// Returns the realpath of the file to serve, or null if blocked / missing.
export async function resolveServeFilePath(root: string, urlPath: string): Promise<string | null> {
  const lexical = safeResolve(root, urlPath)
  if (lexical == null) return null

  let filePath = lexical
  try {
    const info = await stat(filePath)
    if (info.isDirectory()) {
      filePath = path.join(filePath, 'index.html')
    }
  } catch {
    return null
  }

  let realRoot: string
  let realFile: string
  try {
    realRoot = await realpath(root)
    realFile = await realpath(filePath)
  } catch {
    return null
  }

  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) {
    return null
  }

  return realFile
}

async function serveFile(root: string, urlPath: string): Promise<Response> {
  // Collapse "lexically outside root" (was 403) and "not resolvable under root"
  // (404) into a single 404 response. The split let a caller probing
  // `/../etc/passwd` distinguish "existed but denied" (403) from
  // "didn't exist" (404) — a minor oracle that leaked whether a given path
  // was even on disk outside the data dir. 404 for every failure mode
  // removes the signal without changing any legitimate response.
  const realFile = await resolveServeFilePath(root, urlPath)
  if (realFile == null) {
    return new Response('not found', { status: 404 })
  }

  const file = Bun.file(realFile)
  if (!(await file.exists())) {
    return new Response('not found', { status: 404 })
  }

  return new Response(file, {
    headers: {
      'cache-control': 'no-cache',
      'content-type': contentTypeFor(realFile),
    },
  })
}

export interface SchedulerHandle {
  drain: () => Promise<void>
  runNow: () => Promise<void>
  stop: () => void
}

export interface SchedulerDependencies {
  runCollectorFn?: (
    config: LoadedConfig,
    logger: Logger,
    // biome-ignore lint/suspicious/noConfusingVoidType: the `| void` variant is
    // the ergonomic signature for vitest mocks (which default to Promise<void>)
    // — switching to `| undefined` would force every test to spell out the full
    // failed-slug shape just to satisfy the type checker.
  ) => Promise<{ failedTargetSlugs: string[]; failedRollupSlugs: string[] } | void>
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
        const targetDir = await resolveTargetDirPath(dataDir, targetSlug)
        if (targetDir == null) {
          return new Response('not found', { status: 404 })
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
