import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { removeOldSnapshots, runCollector } from '../lib/collector.ts'
import type { LoadedConfig } from '../lib/config.ts'
import { createLogger } from '../lib/logger.ts'

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
    server: {
      data_dir: dataDir,
      listen: ':8080',
      node_label: 'test-observer',
    },
    sourcePath: path.join(dataDir, 'config.toml'),
    target: targetHosts.map((host) => ({
      group: 'default',
      host,
      id: host,
      label: host,
      probe_mode: 'default',
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
})
