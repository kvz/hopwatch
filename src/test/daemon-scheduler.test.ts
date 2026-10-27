import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { runCollector } from '../lib/collector.ts'
import type { LoadedConfig } from '../lib/config.ts'
import { startScheduler } from '../lib/daemon.ts'
import { parseListenAddress } from '../lib/listen.ts'
import { createLogger } from '../lib/logger.ts'
import type { StoredRawSnapshot } from '../lib/raw.ts'

function buildConfig(overrides: { jitterSeconds?: number } = {}): LoadedConfig {
  return {
    chart: { signature: 'x' },
    identity: { provider_contact_emails: [] },
    network_owner_contact: [],
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
  test('sentinels keep sampling while MTR is blocked and never overlap themselves', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T15:23:00Z'))
    const config = buildConfig({ jitterSeconds: 0 })
    config.target = [
      {
        id: 'trace',
        host: 'trace.example',
        label: 'Trace',
        engine: 'mtr',
        protocol: 'icmp',
        port: 443,
        probe_mode: 'default',
      },
      {
        id: 'sentinel',
        host: 's3.example',
        label: 'Sentinel',
        engine: 'connect',
        protocol: 'tcp',
        port: 443,
        probe_mode: 'default',
        interval_seconds: 30,
      },
    ]
    const starts: number[] = []
    let active = 0
    let maxActive = 0
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runCollectorFn = vi.fn(async (subset: LoadedConfig) => {
      if (subset.target.some((target) => target.id === 'trace')) await gate
      if (subset.target.some((target) => target.id === 'sentinel')) {
        starts.push(Date.now())
        maxActive = Math.max(maxActive, ++active)
        await new Promise((resolve) => setTimeout(resolve, 10_000))
        active--
      }
    })
    const scheduler = startScheduler(config, createLogger({ level: 'error' }), { runCollectorFn })
    try {
      void scheduler.runNow()
      await vi.advanceTimersByTimeAsync(95_000)
      expect(starts).toHaveLength(4)
      expect(maxActive).toBe(1)
      expect(starts.map((start) => start - starts[0])).toEqual([0, 30_000, 60_000, 90_000])
    } finally {
      scheduler.stop()
      release()
      await vi.advanceTimersByTimeAsync(10_000)
      await scheduler.drain()
      vi.useRealTimers()
    }
  })

  test.each(
    [90, 120].flatMap((duration) => [0, 1, 10, 20, 29, 31].map((phase) => ({ duration, phase }))),
  )('observes $duration-second outages within 75 seconds at phase $phase with maximum jitter', async ({
    duration,
    phase,
  }) => {
    vi.useFakeTimers()
    const base = Date.parse('2026-10-27T15:23:00Z')
    vi.setSystemTime(new Date(base))
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999999)
    const config = buildConfig({ jitterSeconds: 30 })
    config.target = [
      {
        id: 'sentinel',
        host: 'example.com',
        label: 'Sentinel',
        engine: 'connect',
        protocol: 'tcp',
        port: 443,
        probe_mode: 'default',
        interval_seconds: 30,
      },
    ]
    const samples: StoredRawSnapshot[] = []
    const onset = base + 60_000 + phase * 1000
    const logger = createLogger({ level: 'error' })
    const scheduler = startScheduler(config, logger, {
      runCollectorFn: (subset, log, deps) =>
        runCollector(subset, log, {
          ...deps,
          openStoreFn: async () => ({
            close() {},
            insertRawSnapshot(_input, snapshot) {
              samples.push(snapshot)
            },
            pruneRawSnapshots() {
              return 0
            },
            updateRollupsForTarget() {},
          }),
          runConnectProbeFn: async () => {
            const failed = Date.now() >= onset && Date.now() < onset + duration * 1000
            await new Promise((resolve) => setTimeout(resolve, 9_999))
            return [
              { kind: 'host', hopIndex: 0, host: '203.0.113.1' },
              { kind: 'sent', hopIndex: 0, probeId: 0 },
              ...(failed ? [] : [{ kind: 'reply' as const, hopIndex: 0, probeId: 0, rttUs: 1000 }]),
            ]
          },
        }),
    })
    try {
      await vi.advanceTimersByTimeAsync(260_000)
      const failures = samples.filter(
        (sample) => !sample.rawEvents.some((event) => event.kind === 'reply'),
      )
      expect(failures.length).toBeGreaterThanOrEqual(2)
      expect(Date.parse(failures[1].finishedAt ?? '') - onset).toBeLessThanOrEqual(75_000)
      expect(Date.parse(failures[0].startedAt ?? '')).toBeGreaterThanOrEqual(onset)
      expect(samples.at(-1)?.rawEvents.some((event) => event.kind === 'reply')).toBe(true)
      expect(samples.every((sample) => sample.startedAt === sample.scheduledAt)).toBe(true)
    } finally {
      scheduler.stop()
      await vi.advanceTimersByTimeAsync(10_000)
      await scheduler.drain()
      random.mockRestore()
      vi.useRealTimers()
    }
  })

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

  test('schedules recurring cycles relative to cycle start time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-30T00:00:00Z'))
    try {
      const config = buildConfig({ jitterSeconds: 0 })
      const logger = createLogger({ level: 'error', pretty: false })
      const runCollectorFn = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10 * 60 * 1000)
        })
      })

      const scheduler = startScheduler(config, logger, { runCollectorFn })
      try {
        const firstRun = scheduler.runNow()
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        await firstRun

        await vi.advanceTimersByTimeAsync(50 * 60 * 1000 - 1)
        expect(runCollectorFn).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(1)
        expect(runCollectorFn).toHaveBeenCalledTimes(2)
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
