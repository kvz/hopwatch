import net from 'node:net'

import type { RawMtrEvent } from './raw.ts'

export interface ConnectProbeRequest {
  host: string
  ipVersion: '4' | '6'
  packets: number
  port: number
  timeoutMs: number
}

interface ConnectAttemptResult {
  remoteAddress: string | null
  rttUs: number | null
}

function perAttemptTimeoutMs(request: ConnectProbeRequest): number {
  return Math.min(5_000, Math.max(1_000, Math.floor(request.timeoutMs / request.packets)))
}

async function runConnectAttempt(request: ConnectProbeRequest): Promise<ConnectAttemptResult> {
  const startedAt = process.hrtime.bigint()
  const family = request.ipVersion === '4' ? 4 : 6
  const timeoutMs = perAttemptTimeoutMs(request)

  return await new Promise((resolve) => {
    const socket = net.connect({
      family,
      host: request.host,
      port: request.port,
      timeout: timeoutMs,
    })
    let settled = false

    const finish = (result: ConnectAttemptResult): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.once('connect', () => {
      const elapsedUs = Number((process.hrtime.bigint() - startedAt) / 1_000n)
      finish({
        remoteAddress: socket.remoteAddress ?? null,
        rttUs: elapsedUs,
      })
    })
    socket.once('timeout', () => {
      finish({ remoteAddress: null, rttUs: null })
    })
    socket.once('error', () => {
      finish({ remoteAddress: null, rttUs: null })
    })
  })
}

export async function probeTargetConnect(request: ConnectProbeRequest): Promise<RawMtrEvent[]> {
  const events: RawMtrEvent[] = [
    {
      host: request.host,
      hopIndex: 0,
      kind: 'dns',
    },
  ]

  for (let probeId = 0; probeId < request.packets; probeId += 1) {
    events.push({
      hopIndex: 0,
      kind: 'sent',
      probeId,
    })
    const result = await runConnectAttempt(request)
    if (result.remoteAddress != null) {
      events.push({
        hopIndex: 0,
        host: result.remoteAddress,
        kind: 'host',
      })
    }
    if (result.rttUs != null) {
      events.push({
        hopIndex: 0,
        kind: 'reply',
        probeId,
        rttUs: result.rttUs,
      })
    }
  }

  return events
}
