import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { removeOldSnapshots, runCollector } from '../lib/collector.ts'
import type { LoadedConfig } from '../lib/config.ts'
import { createLogger } from '../lib/logger.ts'
import type { RawMtrEvent } from '../lib/raw.ts'

describe('removeOldSnapshots', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hopwatch-remove-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('removes stale snapshot files beyond keep_days', async () => {
    const stalePath = path.join(dir, '20240101T000000Z.json')
    await writeFile(stalePath, '{}')
    const staleTime = Date.now() - 40 * 24 * 60 * 60 * 1000
    await utimes(stalePath, new Date(staleTime), new Date(staleTime))

    await removeOldSnapshots(dir, 7)
    const remaining = await readdir(dir)
    expect(remaining).not.toContain('20240101T000000Z.json')
  })

  test('preserves rollup and alert-state files even when mtime is older than keep_days', async () => {
    const names = [
      'hourly.rollup.json',
      'daily.rollup.json',
      'alert-state.json',
      '20240101T000000Z.json',
    ]
    const stalenessMs = Date.now() - 40 * 24 * 60 * 60 * 1000
    for (const name of names) {
      const p = path.join(dir, name)
      await writeFile(p, '{}')
      await utimes(p, new Date(stalenessMs), new Date(stalenessMs))
    }

    await removeOldSnapshots(dir, 7)

    const remaining = (await readdir(dir)).sort()
    expect(remaining).toEqual(['alert-state.json', 'daily.rollup.json', 'hourly.rollup.json'])
  })
})

function buildConfig(dataDir: string, targetHosts: string[]): LoadedConfig {
  return {
    chart: { signature: 'RRDTOOL / TOBI OETIKER' },
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
      sqlite_write: false,
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

describe('runCollector', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'hopwatch-run-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  test('one target failing does not prevent other targets or their rollups from running', async () => {
    const config = buildConfig(dataDir, ['bad.example', 'good.example'])
    const logger = createLogger({ level: 'error', pretty: false })
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})

    const runCommand = async (
      _file: string,
      args: string[],
    ): Promise<{ stderr: string; stdout: string }> => {
      if (args.includes('bad.example')) {
        throw new Error('mtr boom')
      }
      return { stdout: MTR_OUTPUT, stderr: '' }
    }

    const result = await runCollector(config, logger, { runCommand })

    const goodDir = path.join(dataDir, 'good.example')
    const goodEntries = await readdir(goodDir)
    expect(goodEntries.some((name) => /^\d{8}T\d{6}Z\.json$/.test(name))).toBe(true)
    expect(goodEntries).toContain('hourly.rollup.json')
    expect(goodEntries).toContain('daily.rollup.json')

    expect(errorSpy).toHaveBeenCalled()
    expect(result.failedTargetSlugs).toEqual(['bad.example'])
  })

  test('one target with an unrollable snapshot does not abort rollups for other targets', async () => {
    // Seeds target "bad.example" with a snapshot whose collectedAt passes the
    // Zod schema but fails getCollectedAtDate's strict format check. Before the
    // fix, the resulting throw inside aggregateSnapshotsToRollupBuckets
    // propagated out of updateRollupsForTargets and turned the whole collector
    // cycle into a failure, even though "good.example" had succeeded.
    const config = buildConfig(dataDir, ['bad.example', 'good.example'])
    const logger = createLogger({ level: 'error', pretty: false })
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})

    const badDir = path.join(dataDir, 'bad.example')
    await mkdir(badDir, { recursive: true })
    const malformedSnapshot = {
      collectedAt: 'not-a-real-timestamp',
      fileName: 'legacy.json',
      host: 'bad.example',
      label: 'bad.example',
      observer: 'test-observer',
      probeMode: 'default',
      rawEvents: [{ kind: 'host', hopIndex: 0, host: 'final.example' }],
      schemaVersion: 2,
      target: 'bad.example',
    }
    await writeFile(path.join(badDir, 'legacy.json'), JSON.stringify(malformedSnapshot))

    const runCommand = async (): Promise<{ stderr: string; stdout: string }> => ({
      stdout: MTR_OUTPUT,
      stderr: '',
    })

    await expect(runCollector(config, logger, { runCommand })).resolves.toBeDefined()

    const goodEntries = await readdir(path.join(dataDir, 'good.example'))
    expect(goodEntries).toContain('hourly.rollup.json')
    expect(goodEntries).toContain('daily.rollup.json')

    expect(errorSpy).toHaveBeenCalled()
  })

  test('returns an empty failedTargetSlugs list when every target succeeds', async () => {
    const config = buildConfig(dataDir, ['good.example'])
    const logger = createLogger({ level: 'error', pretty: false })
    const runCommand = async (): Promise<{ stderr: string; stdout: string }> => ({
      stdout: MTR_OUTPUT,
      stderr: '',
    })

    const result = await runCollector(config, logger, { runCommand })
    expect(result.failedTargetSlugs).toEqual([])
  })

  test('does not let an unavailable sqlite sidecar block JSON snapshot collection', async () => {
    const config = buildConfig(dataDir, ['good.example'])
    config.storage.sqlite_write = true
    await writeFile(path.join(dataDir, 'not-a-directory'), 'block sqlite open')
    config.resolvedSqlitePath = path.join(dataDir, 'not-a-directory', 'hopwatch.sqlite')
    const logger = createLogger({ level: 'error', pretty: false })
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const runCommand = async (): Promise<{ stderr: string; stdout: string }> => ({
      stdout: MTR_OUTPUT,
      stderr: '',
    })

    const result = await runCollector(config, logger, { runCommand })

    const goodEntries = await readdir(path.join(dataDir, 'good.example'))
    expect(goodEntries.some((name) => /^\d{8}T\d{6}Z\.json$/.test(name))).toBe(true)
    expect(result.failedTargetSlugs).toEqual([])
    expect(errorSpy).toHaveBeenCalledWith(
      'sqlite sidecar disabled for this cycle',
      expect.objectContaining({ dbPath: config.resolvedSqlitePath }),
    )
  })

  test('passes --tcp -P <port> to mtr when the target uses protocol="tcp"', async () => {
    const config = buildConfig(dataDir, ['good.example'])
    config.target[0].protocol = 'tcp'
    config.target[0].port = 8443
    const logger = createLogger({ level: 'error', pretty: false })
    let capturedArgs: string[] = []
    const runCommand = async (
      _file: string,
      args: string[],
    ): Promise<{ stderr: string; stdout: string }> => {
      capturedArgs = args
      return { stdout: MTR_OUTPUT, stderr: '' }
    }

    await runCollector(config, logger, { runCommand })

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
    let capturedArgs: string[] = []
    const runCommand = async (
      _file: string,
      args: string[],
    ): Promise<{ stderr: string; stdout: string }> => {
      capturedArgs = args
      return { stdout: MTR_OUTPUT, stderr: '' }
    }

    await runCollector(config, logger, { runCommand })

    expect(capturedArgs).not.toContain('--tcp')
    expect(capturedArgs).not.toContain('-P')
  })

  test('rejects engine="native" with a clear error when the FFI warmup fails (e.g. musl)', async () => {
    // config-check and daemon start both succeed on musl because the native
    // prober dlopens libc.so.6 lazily (that library does not exist on Alpine /
    // distroless-musl). Before the warmup hook, the first probe cycle failed
    // with an opaque `dlopen libc.so.6` error from bun:ffi. We want the
    // failure surfaced once, with a clear glibc requirement, so operators
    // don't chase the symptoms.
    const config = buildConfig(dataDir, ['native.example'])
    config.target[0].engine = 'native'
    config.target[0].host = '127.0.0.1'
    const logger = createLogger({ level: 'error', pretty: false })
    const warmupNativeEngineFn = vi.fn(() => {
      throw new Error('dlopen(libc.so.6) failed: no such file')
    })

    await expect(
      runCollector(config, logger, {
        runCommand: async () => ({ stdout: '', stderr: '' }),
        warmupNativeEngineFn,
      }),
    ).rejects.toThrow(/engine='native'.*glibc|libc\.so\.6/)
    expect(warmupNativeEngineFn).toHaveBeenCalled()
  })

  test('treats an empty native probe result as a failed target instead of persisting an empty snapshot', async () => {
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
    const runNativeProbeFn = vi.fn(async () => [] as RawMtrEvent[])

    const result = await runCollector(config, logger, { runNativeProbeFn })
    expect(result.failedTargetSlugs).toEqual(['native.example'])
    expect(errorSpy).toHaveBeenCalled()
    const entries = await readdir(path.join(dataDir, 'native.example')).catch(() => [])
    expect(entries.some((name) => /^\d{8}T\d{6}Z.*\.json$/.test(name))).toBe(false)
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

    const fixedNow = new Date('2026-04-21T09:45:00Z')
    const runNativeProbeFn = vi.fn(async () => [
      { kind: 'sent', hopIndex: 0, probeId: 1 } as RawMtrEvent,
      { kind: 'host', hopIndex: 0, host: '10.0.0.1' } as RawMtrEvent,
      { kind: 'reply', hopIndex: 0, probeId: 1, rttUs: 1234 } as RawMtrEvent,
    ])

    // First probe "wins" and writes the snapshot.
    await runCollector(config, logger, { getNow: () => fixedNow, runNativeProbeFn })
    const firstSnapshot = (await readdir(path.join(dataDir, 'native.example')))
      .filter((name) => /^20260421T094500Z.*\.json$/.test(name))
      .sort()[0]
    expect(firstSnapshot).toBeDefined()
    const originalContents = await readFile(
      path.join(dataDir, 'native.example', firstSnapshot),
      'utf8',
    )

    // Second probe in the same second must not silently overwrite.
    const result = await runCollector(config, logger, {
      getNow: () => fixedNow,
      runNativeProbeFn,
    })
    expect(result.failedTargetSlugs).toEqual(['native.example'])
    const preservedContents = await readFile(
      path.join(dataDir, 'native.example', firstSnapshot),
      'utf8',
    )
    expect(preservedContents).toBe(originalContents)
  })

  test('engine="native" skips runCommand and writes the injected RawMtrEvent stream', async () => {
    const config = buildConfig(dataDir, ['native.example'])
    config.target[0].engine = 'native'
    config.target[0].host = '127.0.0.1' // bypass DNS resolution in the collector
    const logger = createLogger({ level: 'error', pretty: false })

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

    const result = await runCollector(config, logger, { runCommand, runNativeProbeFn })

    expect(result.failedTargetSlugs).toEqual([])
    expect(runCommand).not.toHaveBeenCalled()
    expect(runNativeProbeFn).toHaveBeenCalledWith(
      expect.objectContaining({ hostIp: '127.0.0.1', packets: 20, maxHops: 30 }),
    )

    const entries = await readdir(path.join(dataDir, 'native.example'))
    const snapshotFile = entries.find((name) => /^\d{8}T\d{6}Z\.json$/.test(name))
    expect(snapshotFile).toBeDefined()
    if (snapshotFile == null) throw new Error('no snapshot file found')

    const contents = JSON.parse(
      await readFile(path.join(dataDir, 'native.example', snapshotFile), 'utf8'),
    )
    expect(contents.rawEvents).toEqual(nativeEvents)
  })
})
