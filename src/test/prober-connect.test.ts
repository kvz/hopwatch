import net from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { probeTargetConnect } from '../lib/prober-connect.ts'

describe('probeTargetConnect', () => {
  const servers: net.Server[] = []

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
          }),
      ),
    )
    servers.length = 0
  })

  test('records TCP connect successes as one-hop raw events', async () => {
    const server = net.createServer((socket) => {
      socket.end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address == null || typeof address === 'string') {
      throw new Error('Expected an IPv4 listen address')
    }

    const events = await probeTargetConnect({
      host: '127.0.0.1',
      ipVersion: '4',
      packets: 3,
      port: address.port,
      timeoutMs: 3_000,
    })

    expect(events.filter((event) => event.kind === 'dns')).toEqual([
      { host: '127.0.0.1', hopIndex: 0, kind: 'dns' },
    ])
    expect(events.filter((event) => event.kind === 'sent')).toHaveLength(3)
    expect(events.filter((event) => event.kind === 'reply')).toHaveLength(3)
    const timed = events.filter((event) => event.kind === 'sent' || event.kind === 'reply')
    expect(timed.every((event) => typeof event.offsetMs === 'number')).toBe(true)
    expect(timed.map((event) => event.offsetMs)).toEqual(
      timed.map((event) => event.offsetMs).sort((a, b) => (a ?? 0) - (b ?? 0)),
    )
    expect(events.filter((event) => event.kind === 'host').at(-1)).toEqual({
      host: '127.0.0.1',
      hopIndex: 0,
      kind: 'host',
    })
  })

  test('reports DNS errors separately from destination loss and bounds a stuck resolver', async () => {
    vi.useFakeTimers()
    try {
      const probe = probeTargetConnect(
        { host: 'stuck.example', ipVersion: '4', packets: 3, port: 443, timeoutMs: 10_000 },
        {
          lookupFn: vi.fn(() => new Promise(() => {})) as never,
        },
      )
      const assertion = expect(probe).rejects.toThrow(/DNS.*deadline/)
      await vi.advanceTimersByTimeAsync(2_001)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  test('retains the resolved IP on total TCP failure', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as net.AddressInfo
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const events = await probeTargetConnect({
      host: '127.0.0.1',
      ipVersion: '4',
      packets: 3,
      port: address.port,
      timeoutMs: 10_000,
    })
    expect(events.filter((event) => event.kind === 'reply')).toEqual([])
    expect(events.filter((event) => event.kind === 'sent')).toHaveLength(3)
    expect(events).toContainEqual({ kind: 'host', hopIndex: 0, host: '127.0.0.1' })
  })
})
