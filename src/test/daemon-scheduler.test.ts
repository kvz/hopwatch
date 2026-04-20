import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { LoadedConfig } from '../lib/config.ts'
import { startScheduler } from '../lib/daemon.ts'
import { parseListenAddress } from '../lib/listen.ts'
import { createLogger } from '../lib/logger.ts'

function buildConfig(overrides: { jitterSeconds?: number } = {}): LoadedConfig {
  return {
    chart: { signature: 'x' },
    peer: [],
    probe: {
      concurrency: 1,
      interval_seconds: 3600,
      ip_version: 4,
      jitter_seconds: overrides.jitterSeconds ?? 3600,
      keep_days: 7,
      mtr_bin: 'mtr',
      namespace_dir: '',
      netns_mount: true,
      packets: 10,
    },
    resolvedDataDir: path.join('/tmp', 'hopwatch-sched'),
    server: { data_dir: '/tmp', listen: ':0', node_label: 'test' },
    sourcePath: '/tmp/config.toml',
    target: [],
  }
}

describe('startScheduler', () => {
  test('coalesces overlapping runNow calls into a single in-flight cycle', async () => {
    const config = buildConfig()
    const logger = createLogger({ level: 'error', pretty: false })

    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const runCollectorFn = vi.fn(async () => {
      await gate
    })

    const scheduler = startScheduler(config, logger, { runCollectorFn })

    try {
      const first = scheduler.runNow()
      const second = scheduler.runNow()
      const third = scheduler.runNow()

      release()
      await Promise.all([first, second, third])

      expect(runCollectorFn).toHaveBeenCalledTimes(1)
    } finally {
      scheduler.stop()
    }
  })

  test('runNow at boot cancels the initial jitter timer so no extra probe fires', async () => {
    vi.useFakeTimers()
    try {
      // jitter_seconds=0 means the "initial jitter" timer is armed at 0ms, i.e.
      // ready to fire as soon as the event loop turns. Without the fix the timer
      // would trigger a second runCollectorFn call after runNow() completes.
      const config = buildConfig({ jitterSeconds: 0 })
      const logger = createLogger({ level: 'error', pretty: false })
      const runCollectorFn = vi.fn(async () => {})

      const scheduler = startScheduler(config, logger, { runCollectorFn })
      try {
        await scheduler.runNow()
        // Advance past any jitter window; the scheduler's next tick is interval+jitter
        // so well above this, and the initial-jitter timer must already be gone.
        await vi.advanceTimersByTimeAsync(100)
        expect(runCollectorFn).toHaveBeenCalledTimes(1)
      } finally {
        scheduler.stop()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  test('drain() awaits the in-flight cycle started before stop()', async () => {
    const config = buildConfig()
    const logger = createLogger({ level: 'error', pretty: false })

    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let finished = false

    const runCollectorFn = vi.fn(async () => {
      await gate
      finished = true
    })

    const scheduler = startScheduler(config, logger, { runCollectorFn })
    const inFlight = scheduler.runNow()

    scheduler.stop()
    // drain must block until the in-flight run completes
    const drainPromise = scheduler.drain()
    expect(finished).toBe(false)

    release()
    await drainPromise
    expect(finished).toBe(true)
    await inFlight
  })
})

describe('parseListenAddress', () => {
  test('bind-all listen leaves hostname undefined', () => {
    expect(parseListenAddress(':8080')).toEqual({ hostname: undefined, port: 8080 })
  })

  test('host:port parses into explicit hostname', () => {
    expect(parseListenAddress('0.0.0.0:8080')).toEqual({ hostname: '0.0.0.0', port: 8080 })
  })

  test('bracketed IPv6 address keeps its colons', () => {
    expect(parseListenAddress('[::1]:8080')).toEqual({ hostname: '::1', port: 8080 })
    expect(parseListenAddress('[::]:443')).toEqual({ hostname: '::', port: 443 })
  })

  test('rejects addresses with no port separator', () => {
    expect(() => parseListenAddress('nope')).toThrow(/Invalid listen address/)
  })

  test('rejects out-of-range ports', () => {
    expect(() => parseListenAddress(':70000')).toThrow(/Invalid listen port/)
  })
})
