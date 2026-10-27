import { lookup } from 'node:dns/promises'
import net from 'node:net'

import type { RawMtrEvent } from './raw.ts'

export interface ConnectProbeRequest {
  host: string
  ipVersion: '4' | '6'
  packets: number
  port: number
  timeoutMs: number
  signal?: AbortSignal
  timeOriginMs?: number
}

export interface ConnectProbeDependencies {
  lookupFn?: typeof lookup
}

async function runConnectAttempt(
  request: ConnectProbeRequest,
  address: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<number | null> {
  signal.throwIfAborted()
  const started = performance.now()
  return await new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port: request.port })
    const timer = setTimeout(() => finish(null), timeoutMs)
    const abort = (): void => {
      cleanup()
      reject(new Error('TCP connect probe deadline exceeded'))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.destroy()
    }
    const finish = (rttUs: number | null): void => {
      cleanup()
      resolve(rttUs)
    }
    signal.addEventListener('abort', abort, { once: true })
    socket.once('connect', () =>
      finish(Math.max(0, Math.round((performance.now() - started) * 1_000))),
    )
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (
        ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET'].includes(
          err.code ?? '',
        )
      ) {
        finish(null)
      } else {
        cleanup()
        reject(err)
      }
    })
  })
}

export async function probeTargetConnect(
  request: ConnectProbeRequest,
  deps: ConnectProbeDependencies = {},
): Promise<RawMtrEvent[]> {
  const origin = request.timeOriginMs ?? performance.now()
  const offsetMs = (): number => Math.max(0, performance.now() - origin)
  const controller = new AbortController()
  const signal =
    request.signal == null
      ? controller.signal
      : AbortSignal.any([controller.signal, request.signal])
  const deadline = setTimeout(() => controller.abort(), request.timeoutMs)
  const deadlineAt = performance.now() + request.timeoutMs
  try {
    // Resolve before recording any sends. A DNS error is a collector failure,
    // not evidence that a destination received and dropped TCP packets.
    let dnsTimer: ReturnType<typeof setTimeout> | undefined
    const address = await new Promise<string>((resolve, reject) => {
      dnsTimer = setTimeout(
        () => reject(new Error('DNS lookup deadline exceeded')),
        Math.min(2_000, request.timeoutMs),
      )
      const abort = (): void => reject(new Error('DNS/probe deadline exceeded'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      const resolution =
        net.isIP(request.host) !== 0
          ? Promise.resolve({ address: request.host })
          : (deps.lookupFn ?? lookup)(request.host, request.ipVersion === '4' ? 4 : 6)
      resolution
        .then((result) => resolve(result.address), reject)
        .finally(() => signal.removeEventListener('abort', abort))
    }).finally(() => clearTimeout(dnsTimer))
    signal.throwIfAborted()
    const events: RawMtrEvent[] = [
      { host: request.host, hopIndex: 0, kind: 'dns' },
      // Include the resolved destination even on total connection loss.
      { host: address, hopIndex: 0, kind: 'host' },
    ]
    for (let probeId = 0; probeId < request.packets; probeId++) {
      signal.throwIfAborted()
      const budget = Math.floor((deadlineAt - performance.now() - 50) / (request.packets - probeId))
      if (budget <= 0) throw new Error('TCP connect probe deadline exceeded')
      events.push({ hopIndex: 0, kind: 'sent', probeId, offsetMs: offsetMs() })
      const rttUs = await runConnectAttempt(request, address, signal, Math.min(5_000, budget))
      if (rttUs != null)
        events.push({ hopIndex: 0, kind: 'reply', probeId, rttUs, offsetMs: offsetMs() })
    }
    return events
  } finally {
    clearTimeout(deadline)
    controller.abort()
  }
}
