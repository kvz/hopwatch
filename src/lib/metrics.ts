import type { LoadedConfig } from './config.ts'
import { parseCollectedAt } from './snapshot.ts'

export interface ProbeStatusSample {
  collectedAt: string
  finishedAt: string | null
  destinationLossPct: number | null
  destinationAvgRttMs: number | null
  failure: string | null
}

export interface ProbeStatus {
  recent: ProbeStatusSample[]
  lastSuccess: ProbeStatusSample | null
  collectorFailures: number
}

export interface ProbeStatusStore {
  getProbeStatus(targetSlug: string): ProbeStatus
}

function sampleTime(sample: ProbeStatusSample | null | undefined): number {
  if (sample == null) return 0
  return (
    (sample.finishedAt == null
      ? (parseCollectedAt(sample.collectedAt) ?? 0)
      : Date.parse(sample.finishedAt)) / 1000
  )
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')
}

// A scrape is read-only and uses persisted samples. Repeated scrapes of one bad
// sample cannot masquerade as two consecutive probes; state survives restarts.
export function metricsResponse(config: LoadedConfig, store: ProbeStatusStore): Response {
  if (!config.metrics?.enabled) return new Response('not found', { status: 404 })
  const lines = ['# All hopwatch metrics are gauges; failure counts cover retained raw history.']
  const names = [
    'sample_timestamp_seconds',
    'last_success_timestamp_seconds',
    'destination_loss_percent',
    'destination_latency_seconds',
    'collector_failures',
    'collector_failure',
    'consecutive_failed_samples',
    'consecutive_destination_loss_samples',
  ]
  for (const name of names) lines.push(`# TYPE hopwatch_${name} gauge`)
  for (const target of config.target) {
    const status = store.getProbeStatus(target.id)
    const latest = status.recent[0]
    const labels = `target="${escapeLabel(target.id)}",observer="${escapeLabel(config.server.node_label ?? 'hopwatch')}",engine="${target.engine}",protocol="${target.protocol}",sentinel="${target.interval_seconds != null}"`
    const emit = (name: string, value: number): void => {
      lines.push(`hopwatch_${name}{${labels}} ${value}`)
    }
    const consecutive = (predicate: (sample: ProbeStatusSample) => boolean): number => {
      let count = 0
      for (const sample of status.recent) {
        if (!predicate(sample)) break
        count++
      }
      return count
    }
    emit('sample_timestamp_seconds', sampleTime(latest))
    emit('last_success_timestamp_seconds', sampleTime(status.lastSuccess))
    emit('destination_loss_percent', latest?.destinationLossPct ?? Number.NaN)
    emit(
      'destination_latency_seconds',
      latest?.destinationAvgRttMs == null ? Number.NaN : latest.destinationAvgRttMs / 1000,
    )
    emit('collector_failures', status.collectorFailures)
    emit('collector_failure', latest?.failure == null ? 0 : 1)
    emit(
      'consecutive_failed_samples',
      consecutive((sample) => sample.failure != null || (sample.destinationLossPct ?? 0) >= 50),
    )
    emit(
      'consecutive_destination_loss_samples',
      consecutive((sample) => sample.failure == null && (sample.destinationLossPct ?? 0) >= 50),
    )
  }
  return new Response(`${lines.join('\n')}\n`, {
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
