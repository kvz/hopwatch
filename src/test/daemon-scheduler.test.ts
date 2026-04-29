import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { LoadedConfig } from '../lib/config.ts'
import { startScheduler } from '../lib/daemon.ts'
import { parseListenAddress } from '../lib/listen.ts'
import { createLogger } from '../lib/logger.ts'

function buildConfig(overrides: { jitterSeconds?: number } = {}): LoadedConfig {
  return {
    chart: { signature: 'x' },
    identity: { provider_contact_emails: [] },
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
    resolvedSqlitePath: path.join('/tmp', 'hopwatch-sched', 'hopwatch.sqlite'),
    server: { data_dir: '/tmp', listen: ':0', node_label: 'test' },
    sourcePath: '/tmp/config.toml',
    storage: {
      sqlite_path: '',
    },
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

  test('calls the cycle-complete hook after a collector run', async () => {
    const config = buildConfig()
    const logger = createLogger({ level: 'error', pretty: false })
    const onCycleComplete = vi.fn()
    const runCollectorFn = vi.fn(async () => {})

    const scheduler = startScheduler(config, logger, { onCycleComplete, runCollectorFn })
    try {
      await scheduler.runNow()
      expect(onCycleComplete).toHaveBeenCalledTimes(1)
    } finally {
      scheduler.stop()
    }
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

  test('rejects unbracketed values with multiple colons (ambiguous host:port split)', () => {
    // `lastIndexOf(':')` on `host:123:456` happily produces hostname="host:123"
    // and port=456. That's almost certainly a typo (the operator probably meant
    // to wrap an IPv6 host in brackets) and silently accepting it would bind to
    // a port nobody expected. Bracketed IPv6 (`[::1]:8080`) remains the only
    // way to encode a colon-bearing hostname.
    expect(() => parseListenAddress('host:123:456')).toThrow(/Invalid listen address/)
    expect(() => parseListenAddress('::1:8080')).toThrow(/Invalid listen address/)
  })

  test('rejects empty port values instead of coercing to ephemeral port 0', () => {
    // `Number("")` is 0 in JS; without an explicit empty-string check, a
    // misconfigured `listen = "127.0.0.1:"` would silently bind to a random
    // ephemeral port instead of surfacing the typo.
    expect(() => parseListenAddress('127.0.0.1:')).toThrow(/Invalid listen port/)
    expect(() => parseListenAddress(':')).toThrow(/Invalid listen port/)
    expect(() => parseListenAddress('[::1]:')).toThrow(/Invalid listen address|Invalid listen port/)
  })
})
