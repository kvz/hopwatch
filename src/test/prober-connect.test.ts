import net from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
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
    expect(events.filter((event) => event.kind === 'host').at(-1)).toEqual({
      host: '127.0.0.1',
      hopIndex: 0,
      kind: 'host',
    })
  })
})
