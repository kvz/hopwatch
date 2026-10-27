import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { loadConfig } from '../lib/config.ts'
import { metricsResponse, type ProbeStatus, type ProbeStatusSample } from '../lib/metrics.ts'
import { parseStoredSnapshotSummary } from '../lib/snapshot.ts'

const collectedAt = '20261027T152300Z'
function sample(overrides: Partial<ProbeStatusSample> = {}): ProbeStatusSample {
  return {
    collectedAt,
    finishedAt: '2026-10-27T15:23:10.000Z',
    destinationLossPct: 100,
    destinationAvgRttMs: null,
    failure: null,
    ...overrides,
  }
}

async function config(enabled: boolean) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hopwatch-metrics-'))
  const file = path.join(dir, 'config.toml')
  try {
    await writeFile(
      file,
      `[metrics]\nenabled = ${enabled}\n[[target]]\nid = "sentinel"\nlabel = "Sentinel"\nhost = "example.com"\nengine = "connect"\nprotocol = "tcp"\ninterval_seconds = 30\n`,
    )
    return await loadConfig(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('external alert metrics', () => {
  test('is disabled by default and never reads storage when disabled', async () => {
    const cfg = await config(false)
    delete cfg.metrics
    expect(
      metricsResponse(cfg, {
        getProbeStatus() {
          throw new Error('must not read')
        },
      }).status,
    ).toBe(404)
  })

  test('counts distinct failed samples, exposes collector failures and emits stale/missing sample time', async () => {
    const cfg = await config(true)
    const status: ProbeStatus = {
      recent: [sample(), sample()],
      lastSuccess: null,
      collectorFailures: 0,
    }
    const store = { getProbeStatus: () => status }
    let text = await metricsResponse(cfg, store).text()
    expect(text).toMatch(/hopwatch_consecutive_destination_loss_samples\{[^\n]+\} 2/)
    expect(text).toMatch(/hopwatch_consecutive_failed_samples\{[^\n]+\} 2/)
    expect(text).toMatch(/hopwatch_last_success_timestamp_seconds\{[^\n]+\} 0/)
    expect(text).toContain(String(Date.parse('2026-10-27T15:23:10Z') / 1000))
    status.recent = [sample({ destinationLossPct: null, failure: 'DNS error' }), sample()]
    status.collectorFailures = 1
    text = await metricsResponse(cfg, store).text()
    expect(text).toMatch(/hopwatch_consecutive_destination_loss_samples\{[^\n]+\} 0/)
    expect(text).toMatch(/hopwatch_consecutive_failed_samples\{[^\n]+\} 2/)
    expect(text).toMatch(/hopwatch_collector_failures\{[^\n]+\} 1/)
    expect(text).toMatch(/hopwatch_destination_loss_percent\{[^\n]+\} NaN/)
    status.recent = []
    text = await metricsResponse(cfg, store).text()
    expect(text).toMatch(/hopwatch_sample_timestamp_seconds\{[^\n]+\} 0/)
  })

  test('healthy destination with a lossy intermediate router never supplies alert evidence', async () => {
    const snapshot = parseStoredSnapshotSummary(
      JSON.stringify({
        schemaVersion: 2,
        collectedAt,
        fileName: `${collectedAt}.json`,
        host: 'example.com',
        label: 'Example',
        observer: 'test',
        probeMode: 'default',
        target: 'example.com',
        rawEvents: [
          { kind: 'host', hopIndex: 0, host: 'router' },
          { kind: 'sent', hopIndex: 0, probeId: 1 },
          { kind: 'host', hopIndex: 1, host: 'example.com' },
          { kind: 'sent', hopIndex: 1, probeId: 1 },
          { kind: 'reply', hopIndex: 1, probeId: 1, rttUs: 2000 },
        ],
      }),
    )
    expect(snapshot.worstHopLossPct).toBe(100)
    const healthy = sample({
      destinationLossPct: snapshot.destinationLossPct,
      destinationAvgRttMs: snapshot.destinationAvgRttMs,
    })
    const text = await metricsResponse(await config(true), {
      getProbeStatus: () => ({
        recent: [healthy, healthy],
        lastSuccess: healthy,
        collectorFailures: 0,
      }),
    }).text()
    expect(text).toMatch(/hopwatch_consecutive_failed_samples\{[^\n]+\} 0/)
    expect(text).toMatch(/hopwatch_destination_loss_percent\{[^\n]+\} 0/)
    expect(text).toMatch(/hopwatch_destination_latency_seconds\{[^\n]+\} 0.002/)
  })
})
