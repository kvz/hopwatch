import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { LoadedConfig } from '../lib/config.ts'
import { startScheduler } from '../lib/daemon.ts'
import { createLogger } from '../lib/logger.ts'

function buildConfig(): LoadedConfig {
  return {
    chart: { signature: 'x' },
    peer: [],
    probe: {
      concurrency: 1,
      interval_seconds: 3600,
      ip_version: 4,
      jitter_seconds: 3600,
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
})
