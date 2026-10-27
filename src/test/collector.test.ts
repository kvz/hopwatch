import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MtrHistoryTarget } from '../lib/collector.ts'
import { runCollector } from '../lib/collector.ts'
import type { LoadedConfig } from '../lib/config.ts'
import { createLogger } from '../lib/logger.ts'
import { probeTargetConnect } from '../lib/prober-connect.ts'
import type { RawMtrEvent, StoredRawSnapshot } from '../lib/raw.ts'
import { summarizeStoredRawSnapshot } from '../lib/snapshot.ts'
import type { HopwatchStorage, ImportSnapshotInput } from '../lib/sqlite-storage.ts'

function buildConfig(dataDir: string, targetHosts: string[]): LoadedConfig {
  return {
    chart: { signature: 'RRDTOOL / TOBI OETIKER' },
    identity: { provider_contact_emails: [] },
    network_owner_contact: [],
    peer: [],
    probe: {
      concurrency: 3,
      interval_seconds: 900,
      ip_version: 4,
      jitter_seconds: 30,
      keep_days: 14,
      mtr_bin: 'mtr',
      namespace_dir: '',
      netns_mount: true,
      packets: 20,
    },
    resolvedDataDir: dataDir,
    resolvedSqlitePath: path.join(dataDir, 'hopwatch.sqlite'),
    server: {
      data_dir: dataDir,
      listen: ':8080',
      node_label: 'test-observer',
    },
    sourcePath: path.join(dataDir, 'config.toml'),
    storage: {
      sqlite_path: '',
    },
    target: targetHosts.map((host) => ({
      engine: 'mtr',
      group: 'default',
      host,
      id: host,
      label: host,
      port: 443,
      probe_mode: 'default',
      protocol: 'icmp',
    })),
  }
}

const MTR_OUTPUT = ['x 0 1', 'h 0 final.example', 'p 0 1000 1'].join('\n')

class FakeHopwatchStore implements HopwatchStorage {
  closedCount = 0
  failRollupsFor = new Set<string>()
  prunedTargetSlugs: string[] = []
  rollupTargetSlugs: string[] = []
  snapshots = new Map<string, StoredRawSnapshot>()

  close(): void {
    this.closedCount += 1
  }

  insertRawSnapshot(input: ImportSnapshotInput, rawSnapshot: StoredRawSnapshot): void {
    const key = `${input.targetSlug}/${input.fileName}`
    if (this.snapshots.has(key)) {
      throw new Error(`snapshot collision at sqlite://${key}`)
    }
    this.snapshots.set(key, rawSnapshot)
  }

  pruneRawSnapshots(targetSlug: string): number {
    this.prunedTargetSlugs.push(targetSlug)
    return 0
  }

  snapshotFor(targetSlug: string): StoredRawSnapshot | undefined {
    return [...this.snapshots.entries()].find(([key]) => key.startsWith(`${targetSlug}/`))?.[1]
  }

  updateRollupsForTarget(target: MtrHistoryTarget): void {
    if (this.failRollupsFor.has(target.slug)) {
      throw new Error('rollup boom')
    }
    if (this.snapshotFor(target.slug) == null) {
      return
    }
    this.rollupTargetSlugs.push(target.slug)
  }
}

function withStore(
  store: HopwatchStorage,
  deps: Parameters<typeof runCollector>[2] = {},
): NonNullable<Parameters<typeof runCollector>[2]> {
  return {
    ...deps,
    openStoreFn: async () => store,
  }
}

describe('runCollector', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'hopwatch-run-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  test.each([
    false,
    true,
  ])('keeps the resolved native endpoint without reply events (collector failure: %s)', async (failed) => {
    const config = buildConfig(dataDir, ['native'])
    Object.assign(config.target[0], { host: '127.0.0.1', engine: 'native' })
    const store = new FakeHopwatchStore()
    await runCollector(
      config,
      createLogger({ level: 'error' }),
      withStore(store, {
        runNativeProbeFn: async () => {
          if (failed) throw new Error('raw socket failed')
          return [{ kind: 'sent', hopIndex: 0, probeId: 0 }]
        },
      }),
    )
    expect(store.snapshotFor('native')?.destinationIp).toBe('127.0.0.1')
    expect(store.snapshotFor('native')?.rawEvents.some((event) => event.kind === 'host')).toBe(
      false,
    )
    expect(store.snapshotFor('native')?.failure != null).toBe(failed)
  })

  test.each([
    'EMFILE',
    'ENOBUFS',
  ])('keeps partial TCP events and IP on later %s while marking the sample unusable', async (code) => {
    let attempts = 0
    const connect = vi.spyOn(net, 'connect').mockImplementation(() => {
      const socket = new net.Socket()
      const success = attempts++ === 0
      queueMicrotask(() =>
        success
          ? socket.emit('connect')
          : socket.emit('error', Object.assign(new Error(code), { code })),
      )
      return socket
    })
    try {
      const config = buildConfig(dataDir, ['sentinel'])
      Object.assign(config.target[0], {
        host: '127.0.0.1',
        engine: 'connect',
        protocol: 'tcp',
        interval_seconds: 30,
      })
      const store = new FakeHopwatchStore()
      await runCollector(
        config,
        createLogger({ level: 'error' }),
        withStore(store, { runConnectProbeFn: probeTargetConnect }),
      )
      const saved = store.snapshotFor('sentinel')
      expect(saved).toMatchObject({ destinationIp: '127.0.0.1', failure: code })
      expect(saved?.rawEvents.filter((event) => event.kind === 'sent')).toHaveLength(2)
      expect(saved?.rawEvents.filter((event) => event.kind === 'reply')).toHaveLength(1)
      expect(summarizeStoredRawSnapshot(saved as StoredRawSnapshot).destinationLossPct).toBeNull()
    } finally {
      connect.mockRestore()
    }
  })

  test('preserves timed-out connection attempts after delayed sentinel startup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
    const connect = vi.spyOn(net, 'connect').mockImplementation(() => new net.Socket())
    try {
      const config = buildConfig(dataDir, ['sentinel'])
      Object.assign(config.target[0], {
        host: '127.0.0.1',
        engine: 'connect',
        protocol: 'tcp',
        interval_seconds: 30,
      })
      const store = new FakeHopwatchStore()
      const promise = runCollector(
        config,
        createLogger({ level: 'error' }),
        withStore(store, {
          runConnectProbeFn: async (request) => {
            await new Promise((resolve) => setTimeout(resolve, 300))
            return probeTargetConnect(request)
          },
        }),
      )
      await vi.advanceTimersByTimeAsync(10_001)
      expect((await promise).failedTargetSlugs).toEqual([])
      expect(store.snapshotFor('sentinel')?.failure).toBeUndefined()
      expect(
        store.snapshotFor('sentinel')?.rawEvents.filter((event) => event.kind === 'sent'),
      ).toHaveLength(3)
      expect(
        store.snapshotFor('sentinel')?.rawEvents.filter((event) => event.kind === 'reply'),
      ).toHaveLength(0)
    } finally {
      connect.mockRestore()
      vi.useRealTimers()
    }
  })

  test('preserves native results returned after the native drain and reverse-DNS budgets', async () => {
    vi.useFakeTimers()
    try {
      const config = buildConfig(dataDir, ['native'])
      config.target[0].engine = 'native'
      config.target[0].host = '127.0.0.1'
      config.probe.interval_seconds = 30
      const store = new FakeHopwatchStore()
      const promise = runCollector(
        config,
        createLogger({ level: 'error' }),
        withStore(store, {
          runNativeProbeFn: async (request) => {
            await new Promise((resolve) => setTimeout(resolve, request.timeoutMs + 1000))
            return [
              { kind: 'host', hopIndex: 0, host: '127.0.0.1' },
              { kind: 'sent', hopIndex: 0, probeId: 1 },
              { kind: 'reply', hopIndex: 0, probeId: 1, rttUs: 1000 },
            ]
          },
        }),
      )
      await vi.advanceTimersByTimeAsync(61_001)
      expect((await promise).failedTargetSlugs).toEqual([])
      expect(store.snapshotFor('native')?.rawEvents).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  test('keeps known native initialization errors even when the target cannot resolve', async () => {
    const config = buildConfig(dataDir, ['unresolvable.invalid'])
    config.target[0].engine = 'native'
    const store = new FakeHopwatchStore()
    await runCollector(
      config,
      createLogger({ level: 'error' }),
      withStore(store, {
        warmupNativeEngineFn: () => {
          throw new Error('missing glibc')
        },
      }),
    )
    expect(store.snapshotFor('unresolvable.invalid')?.failure).toContain('requires glibc Linux')
  })

  test('can borrow the daemon store without opening, migrating or closing another connection', async () => {
    const store = new FakeHopwatchStore()
    const openStoreFn = vi.fn(async () => {
      throw new Error('should reuse store')
    })
    await runCollector(buildConfig(dataDir, ['example']), createLogger({ level: 'error' }), {
      sqliteStore: store,
      openStoreFn,
      runCommand: async () => ({ stdout: MTR_OUTPUT, stderr: '' }),
    })
    expect(openStoreFn).not.toHaveBeenCalled()
    expect(store.closedCount).toBe(0)
    expect(store.snapshotFor('example')).toBeDefined()
  })

  test('timestamps queued targets at their actual start and persists collector failures', async () => {
    const config = buildConfig(dataDir, ['first.example', 'second.example'])
    config.probe.concurrency = 1
    const store = new FakeHopwatchStore()
    let clock = Date.parse('2026-10-27T15:23:00Z')
    const result = await runCollector(
      config,
      createLogger({ level: 'error' }),
      withStore(store, {
        getNow: () => new Date(clock),
        runCommand: async (_file, args) => {
          clock += 20_000
          if (args.includes('second.example')) throw new Error('DNS lookup failed')
          return { stdout: MTR_OUTPUT, stderr: '' }
        },
      }),
    )
    expect(store.snapshotFor('first.example')).toMatchObject({
      startedAt: '2026-10-27T15:23:00.000Z',
      finishedAt: '2026-10-27T15:23:20.000Z',
      scheduledAt: '2026-10-27T15:23:00.000Z',
    })
    expect(store.snapshotFor('second.example')).toMatchObject({
      collectedAt: '20261027T152320Z',
      startedAt: '2026-10-27T15:23:20.000Z',
      finishedAt: '2026-10-27T15:23:40.000Z',
      scheduledAt: '2026-10-27T15:23:00.000Z',
      cycleId: '20261027T152300Z',
      failure: 'DNS lookup failed',
      rawEvents: [],
    })
    expect(result.failedTargetSlugs).toEqual(['second.example'])
  })

  test('one target failing does not prevent other targets or their rollups from running', async () => {
    const config = buildConfig(dataDir, ['bad.example', 'good.example'])
    const logger = createLogger({ level: 'error', pretty: false })
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const store = new FakeHopwatchStore()

    const runCommand = async (
      _file: string,
      args: string[],
    ): Promise<{ stderr: string; stdout: string }> => {
      if (args.includes('bad.example')) {
        throw new Error('mtr boom')
      }
      return { stdout: MTR_OUTPUT, stderr: '' }
    }

    const result = await runCollector(config, logger, withStore(store, { runCommand }))

    expect(store.snapshotFor('good.example')).toBeDefined()
    expect(store.rollupTargetSlugs).toEqual(['bad.example', 'good.example'])
    expect(errorSpy).toHaveBeenCalled()
    expect(result.failedTargetSlugs).toEqual(['bad.example'])
  })

  test('one target with a rollup failure does not abort rollups for other targets', async () => {
    const config = buildConfig(dataDir, ['bad.example', 'good.example'])
    const logger = createLogger({ level: 'error', pretty: false })
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const store = new FakeHopwatchStore()
    store.failRollupsFor.add('bad.example')

    const runCommand = async (): Promise<{ stderr: string; stdout: string }> => ({
      stdout: MTR_OUTPUT,
      stderr: '',
    })

    const result = await runCollector(config, logger, withStore(store, { runCommand }))

    expect(result.failedRollupSlugs).toEqual(['bad.example'])
    expect(store.rollupTargetSlugs).toEqual(['good.example'])
    expect(errorSpy).toHaveBeenCalled()
  })

  test('returns an empty failedTargetSlugs list when every target succeeds', async () => {
    const config = buildConfig(dataDir, ['good.example'])
    const logger = createLogger({ level: 'error', pretty: false })
    const store = new FakeHopwatchStore()
    const runCommand = async (): Promise<{ stderr: string; stdout: string }> => ({
      stdout: MTR_OUTPUT,
      stderr: '',
    })

    const result = await runCollector(config, logger, withStore(store, { runCommand }))
    expect(result.failedTargetSlugs).toEqual([])
  })

  test('fails before probing when SQLite cannot be opened', async () => {
    const config = buildConfig(dataDir, ['good.example'])
    const logger = createLogger({ level: 'error', pretty: false })
    const runCommand = vi.fn(
      async (): Promise<{ stderr: string; stdout: string }> => ({
        stdout: MTR_OUTPUT,
        stderr: '',
      }),
    )

    await expect(
      runCollector(config, logger, {
        openStoreFn: async () => {
          throw new Error('sqlite open failed')
        },
        runCommand,
      }),
    ).rejects.toThrow('sqlite open failed')
    expect(runCommand).not.toHaveBeenCalled()
  })

  test('closes the SQLite store after a successful cycle', async () => {
    const config = buildConfig(dataDir, ['good.example'])
    const logger = createLogger({ level: 'error', pretty: false })
    const store = new FakeHopwatchStore()

    await runCollector(
      config,
      logger,
      withStore(store, {
        runCommand: async () => ({ stdout: MTR_OUTPUT, stderr: '' }),
      }),
    )
    expect(store.closedCount).toBe(1)
  })

  test('passes --tcp -P <port> to mtr when the target uses protocol="tcp"', async () => {
    const config = buildConfig(dataDir, ['good.example'])
    config.target[0].protocol = 'tcp'
    config.target[0].port = 8443
    const logger = createLogger({ level: 'error', pretty: false })
    const store = new FakeHopwatchStore()
    let capturedArgs: string[] = []
    const runCommand = async (
      _file: string,
      args: string[],
    ): Promise<{ stderr: string; stdout: string }> => {
      capturedArgs = args
      return { stdout: MTR_OUTPUT, stderr: '' }
    }

    await runCollector(config, logger, withStore(store, { runCommand }))

    expect(capturedArgs).toContain('--tcp')
    const portIndex = capturedArgs.indexOf('-P')
    expect(portIndex).toBeGreaterThanOrEqual(0)
    expect(capturedArgs[portIndex + 1]).toBe('8443')
    // The target host must come last so it isn't parsed as an option arg.
    expect(capturedArgs[capturedArgs.length - 1]).toBe('good.example')
  })

  test('omits --tcp and -P when the target uses the default protocol="icmp"', async () => {
    const config = buildConfig(dataDir, ['good.example'])
    const logger = createLogger({ level: 'error', pretty: false })
    const store = new FakeHopwatchStore()
    let capturedArgs: string[] = []
    const runCommand = async (
      _file: string,
      args: string[],
    ): Promise<{ stderr: string; stdout: string }> => {
      capturedArgs = args
      return { stdout: MTR_OUTPUT, stderr: '' }
    }

    await runCollector(config, logger, withStore(store, { runCommand }))

    expect(capturedArgs).not.toContain('--tcp')
    expect(capturedArgs).not.toContain('-P')
  })

  test('records a native FFI warmup failure without preventing other engines from sampling', async () => {
    // config-check and daemon start both succeed on musl because the native
    // prober dlopens libc.so.6 lazily (that library does not exist on Alpine /
    // distroless-musl). Before the warmup hook, the first probe cycle failed
    // with an opaque `dlopen libc.so.6` error from bun:ffi. We want the
    // failure surfaced once, with a clear glibc requirement, so operators
    // don't chase the symptoms.
    const config = buildConfig(dataDir, ['native.example', 'mtr.example'])
    config.target[0].engine = 'native'
    config.target[0].host = '127.0.0.1'
    const logger = createLogger({ level: 'error', pretty: false })
    const warmupNativeEngineFn = vi.fn(() => {
      throw new Error('dlopen(libc.so.6) failed: no such file')
    })

    const store = new FakeHopwatchStore()
    const result = await runCollector(
      config,
      logger,
      withStore(store, {
        runCommand: async () => ({ stdout: MTR_OUTPUT, stderr: '' }),
        warmupNativeEngineFn,
      }),
    )
    expect(result.failedTargetSlugs).toEqual(['native.example'])
    expect(store.snapshotFor('native.example')?.failure).toMatch(
      /engine='native'.*glibc|libc\.so\.6/,
    )
    expect(store.snapshotFor('mtr.example')?.failure).toBeUndefined()
    expect(store.snapshotFor('mtr.example')).toBeDefined()
    expect(warmupNativeEngineFn).toHaveBeenCalled()
  })

  test('uses three packets, a ten-second deadline and one-day retention for sentinels', async () => {
    vi.useFakeTimers()
    try {
      const config = buildConfig(dataDir, ['sentinel'])
      Object.assign(config.target[0], { engine: 'connect', protocol: 'tcp', interval_seconds: 30 })
      const store = new FakeHopwatchStore()
      const prune = vi.spyOn(store, 'pruneRawSnapshots')
      const runConnectProbeFn = vi.fn(async () => await new Promise<RawMtrEvent[]>(() => {}))
      const promise = runCollector(
        config,
        createLogger({ level: 'error' }),
        withStore(store, { runConnectProbeFn }),
      )
      await vi.advanceTimersByTimeAsync(10_001)
      const result = await promise
      expect(result.failedTargetSlugs).toEqual(['sentinel'])
      expect(runConnectProbeFn).toHaveBeenCalledWith(
        expect.objectContaining({ packets: 3, timeoutMs: 10_000 }),
      )
      expect(store.snapshotFor('sentinel')).toMatchObject({
        failure: expect.stringContaining('deadline'),
        rawEvents: [],
      })
      expect(prune).toHaveBeenCalledWith('sentinel', 1, expect.any(Number))
      expect(store.rollupTargetSlugs).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('persists an empty native result as a collector failure without destination-loss evidence', async () => {
    // When every sendto() fails, the native prober returns an empty event
    // list. Before this fix the collector persisted the snapshot anyway -
    // detail pages classified it as "unknown" (no events) while rollups saw
    // destinationSentCount=0 and rendered 100% loss, producing a dashboard
    // that disagreed with itself about the same probe.
    const config = buildConfig(dataDir, ['native.example'])
    config.target[0].engine = 'native'
    config.target[0].host = '127.0.0.1'
    const logger = createLogger({ level: 'error', pretty: false })
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const store = new FakeHopwatchStore()
    const runNativeProbeFn = vi.fn(async () => [] as RawMtrEvent[])

    const result = await runCollector(config, logger, withStore(store, { runNativeProbeFn }))
    expect(result.failedTargetSlugs).toEqual(['native.example'])
    expect(errorSpy).toHaveBeenCalled()
    expect(store.snapshotFor('native.example')).toMatchObject({
      rawEvents: [],
      destinationIp: '127.0.0.1',
      failure: expect.stringContaining('returned no events'),
    })
  })

  test('surfaces same-second snapshot collisions instead of silently overwriting', async () => {
    // Two independent processes (e.g. daemon + a manual `hopwatch collect`)
    // probing the same target in the same wall-clock second both resolve to
    // `<targetDir>/<timestamp>.json`. Before the fix, the later rename()
    // silently replaced the first snapshot's data. Now the second writer sees
    // EEXIST and the target is reported as failed, keeping the original
    // snapshot intact.
    const config = buildConfig(dataDir, ['native.example'])
    config.target[0].engine = 'native'
    config.target[0].host = '127.0.0.1'
    const logger = createLogger({ level: 'error', pretty: false })
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const store = new FakeHopwatchStore()

    const fixedNow = new Date('2026-04-21T09:45:00Z')
    const runNativeProbeFn = vi.fn(async () => [
      { kind: 'sent', hopIndex: 0, probeId: 1 } as RawMtrEvent,
      { kind: 'host', hopIndex: 0, host: '10.0.0.1' } as RawMtrEvent,
      { kind: 'reply', hopIndex: 0, probeId: 1, rttUs: 1234 } as RawMtrEvent,
    ])

    // First probe "wins" and writes the snapshot.
    await runCollector(
      config,
      logger,
      withStore(store, { getNow: () => fixedNow, runNativeProbeFn }),
    )
    const originalSnapshot = store.snapshotFor('native.example')
    expect(originalSnapshot).toBeDefined()

    // Second probe in the same second must not silently overwrite.
    const result = await runCollector(
      config,
      logger,
      withStore(store, {
        getNow: () => fixedNow,
        runNativeProbeFn,
      }),
    )
    expect(result.failedTargetSlugs).toEqual(['native.example'])
    expect(store.snapshotFor('native.example')).toBe(originalSnapshot)
  })

  test('engine="native" skips runCommand and writes the injected RawMtrEvent stream', async () => {
    const config = buildConfig(dataDir, ['native.example'])
    config.target[0].engine = 'native'
    config.target[0].host = '127.0.0.1' // bypass DNS resolution in the collector
    const logger = createLogger({ level: 'error', pretty: false })
    const store = new FakeHopwatchStore()

    const nativeEvents: RawMtrEvent[] = [
      { kind: 'sent', hopIndex: 0, probeId: 1 },
      { kind: 'host', hopIndex: 0, host: '10.0.0.1' },
      { kind: 'dns', hopIndex: 0, host: 'gw.example' },
      { kind: 'reply', hopIndex: 0, probeId: 1, rttUs: 1234 },
    ]
    const runNativeProbeFn = vi.fn(async () => nativeEvents)
    const runCommand = vi.fn(async (): Promise<{ stderr: string; stdout: string }> => {
      throw new Error('mtr path must not be called for engine=native')
    })

    const result = await runCollector(
      config,
      logger,
      withStore(store, { runCommand, runNativeProbeFn }),
    )

    expect(result.failedTargetSlugs).toEqual([])
    expect(runCommand).not.toHaveBeenCalled()
    expect(runNativeProbeFn).toHaveBeenCalledWith(
      expect.objectContaining({ hostIp: '127.0.0.1', packets: 20, maxHops: 30 }),
    )

    expect(store.snapshotFor('native.example')?.rawEvents).toEqual(nativeEvents)
  })

  test('engine="connect" skips mtr/native probing and writes connect probe events', async () => {
    const config = buildConfig(dataDir, ['connect.example'])
    config.target[0].engine = 'connect'
    config.target[0].protocol = 'tcp'
    config.target[0].port = 443
    const logger = createLogger({ level: 'error', pretty: false })
    const store = new FakeHopwatchStore()

    const connectEvents: RawMtrEvent[] = [
      { host: 'connect.example', hopIndex: 0, kind: 'dns' },
      { hopIndex: 0, kind: 'sent', probeId: 0 },
      { host: '198.51.100.10', hopIndex: 0, kind: 'host' },
      { hopIndex: 0, kind: 'reply', probeId: 0, rttUs: 1234 },
    ]
    const runConnectProbeFn = vi.fn(async () => connectEvents)
    const runCommand = vi.fn(async (): Promise<{ stderr: string; stdout: string }> => {
      throw new Error('mtr path must not be called for engine=connect')
    })
    const runNativeProbeFn = vi.fn(async () => {
      throw new Error('native path must not be called for engine=connect')
    })

    const result = await runCollector(
      config,
      logger,
      withStore(store, { runCommand, runConnectProbeFn, runNativeProbeFn }),
    )

    expect(result.failedTargetSlugs).toEqual([])
    expect(runCommand).not.toHaveBeenCalled()
    expect(runNativeProbeFn).not.toHaveBeenCalled()
    expect(runConnectProbeFn).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'connect.example',
        ipVersion: '4',
        packets: 20,
        port: 443,
      }),
    )
    expect(store.snapshotFor('connect.example')?.rawEvents).toEqual(connectEvents)
  })
})
