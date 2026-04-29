import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
// @ts-expect-error Bun supports `with { type: 'text' }` to import the file's source as a string.
// TypeScript 5.x does not yet model this import-attribute based module shape; the runtime
// value is always a string and Bun.Transpiler handles the rest.
import relativeTimeSource from '../client/relative-time.ts' with { type: 'text' }
// @ts-expect-error see note on relativeTimeSource - same import-attribute shape.
import sortableTablesSource from '../client/sortable-tables.ts' with { type: 'text' }
import type { LoadedConfig } from './config.ts'
import { type RenderedTarget, renderRootIndex, renderTargetIndex, runCollector } from './core.ts'
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
  // the fetch handler and produce a generic 500 - return null so the caller
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

// Shared symlink-escape guard for both entry points. safeResolve() only checks
// the lexical path, but stat() and Bun.file() follow symlinks - so a symlink
// under data_dir pointing at /etc/passwd would otherwise be happily used. We
// realpath both the root and the resolved target and require the target stay
// within the root's realpath. `allowRoot=false` additionally rejects the bare
// root itself (target dashboards need a leaf). Returns the realpath of the
// target, or null if blocked / missing / escaping.
async function realpathContained(
  root: string,
  lexical: string,
  allowRoot: boolean,
): Promise<string | null> {
  let realRoot: string
  let realTarget: string
  try {
    realRoot = await realpath(root)
    realTarget = await realpath(lexical)
  } catch {
    return null
  }

  if (realTarget === realRoot) return allowRoot ? realTarget : null
  if (!realTarget.startsWith(`${realRoot}${path.sep}`)) return null

  return realTarget
}

// Resolves a target-dashboard slug to its on-disk directory while guarding
// against symlink escape. The daemon's target route previously only applied
// the lexical `safeResolve()` check, so a symlink under data_dir pointing at
// /var/log or /etc would render - the page code then enumerated and parsed
// JSON files from outside the data tree.
export async function resolveTargetDirPath(root: string, slug: string): Promise<string | null> {
  const lexical = safeResolve(root, slug)
  if (lexical == null) return null

  try {
    const info = await stat(lexical)
    if (!info.isDirectory()) return null
  } catch {
    return null
  }

  return realpathContained(root, lexical, false)
}

// Resolves a URL path to a file on disk while guarding against symlink escape.
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

  return realpathContained(root, filePath, true)
}

async function serveFile(root: string, urlPath: string): Promise<Response> {
  // Collapse "lexically outside root" (was 403) and "not resolvable under root"
  // (404) into a single 404 response. The split let a caller probing
  // `/../etc/passwd` distinguish "existed but denied" (403) from
  // "didn't exist" (404) - a minor oracle that leaked whether a given path
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

interface RenderCacheEntry<T> {
  generation: number
  promise: Promise<T>
}

export interface RenderCache<T> {
  clear: () => void
  get: (key: string, render: () => Promise<T>) => Promise<T>
  size: () => number
}

export function createRenderCache<T>(): RenderCache<T> {
  const entries = new Map<string, RenderCacheEntry<T>>()
  let generation = 0

  return {
    clear(): void {
      generation += 1
      entries.clear()
    },
    get(key: string, render: () => Promise<T>): Promise<T> {
      const existing = entries.get(key)
      if (existing != null) {
        return existing.promise
      }

      const entryGeneration = generation
      const promise = render().catch((err: unknown) => {
        const current = entries.get(key)
        if (current?.promise === promise) {
          entries.delete(key)
        }
        throw err
      })
      entries.set(key, { generation: entryGeneration, promise })

      promise.then(
        () => {
          const current = entries.get(key)
          if (current?.promise !== promise) {
            return
          }
          if (current.generation !== generation) {
            entries.delete(key)
          }
        },
        () => {},
      )

      return promise
    },
    size(): number {
      return entries.size
    },
  }
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
  const dataDir = config.resolvedDataDir
  const rootRenderCache = createRenderCache<string>()
  const targetRenderCache = createRenderCache<RenderedTarget>()
  const warmSelfHost =
    config.server.public_url == null ? null : new URL(config.server.public_url).host

  function clearRenderCaches(): void {
    rootRenderCache.clear()
    targetRenderCache.clear()
  }

  async function renderCachedRootIndex(selfHost: string | null): Promise<string> {
    const cacheKey = selfHost ?? ''
    return rootRenderCache.get(cacheKey, async () =>
      renderRootIndex(
        dataDir,
        config.peer,
        nodeLabel,
        selfHost,
        config.probe.keep_days,
        Date.now(),
        signature,
      ),
    )
  }

  function warmRootIndex(reason: string): void {
    const started = Date.now()
    void renderCachedRootIndex(warmSelfHost)
      .then(() => {
        logger.info('root render cache warmed', {
          elapsedMs: Date.now() - started,
          reason,
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : `Was thrown a non-error: ${err}`
        logger.error('root render cache warm failed', { message, reason })
      })
  }

  const scheduler = startScheduler(config, logger, {
    onCycleComplete: () => {
      clearRenderCaches()
      warmRootIndex('cycle')
    },
  })

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

      // Reverse-proxy layer passes the client-facing hostname via X-Forwarded-Host
      // (nginx default); fall back to Host. Used to render the active peer's
      // dropdown subtitle as "<host>[/<mount>]" so it matches the format shown
      // for remote peers instead of repeating the label.
      const selfHost =
        request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? null

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await renderCachedRootIndex(selfHost)
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

        const cacheKey = `${selfHost ?? ''}\0${targetSlug}`
        const rendered = await targetRenderCache
          .get(cacheKey, async () => {
            const target = await renderTargetIndex(
              targetDir,
              config.peer,
              nodeLabel,
              selfHost,
              targetSlug,
              Date.now(),
              signature,
            )
            if (target == null) {
              throw new Error('target has no snapshots')
            }
            return target
          })
          .catch((err: unknown) => {
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
    // Bun.serve defaults idleTimeout to 10s; the root dashboard render
    // walks all targets and easily exceeds that on production observers
    // (27 targets × 14 days of snapshots), so the connection was getting
    // closed without a response and haproxy turned that into a 502. Bump
    // it well above measured render time. Bun caps idleTimeout at 255s.
    idleTimeout: 240,
    port: parsePort(config.server.listen),
  })

  logger.info('http server ready', {
    dataDir,
    hostname: server.hostname,
    port: server.port,
  })

  warmRootIndex('startup')
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
