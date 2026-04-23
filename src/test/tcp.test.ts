import { describe, expect, test } from 'vitest'
import { parseIcmpTcpReply } from '../lib/tcp.ts'

// Build a synthetic ICMP Time Exceeded packet as the kernel delivers it on a
// raw IPPROTO_ICMP socket: outer IP header, ICMP header (type/code/cksum +
// 4 unused bytes), inner IP header of our original packet, inner TCP header
// (first 8 bytes - src/dst port + seq - is what RFC 792 guarantees routers
// copy back). We only care about the fields parseIcmpTcpReply actually
// reads, so everything else is zeroed.
function buildTimeExceededWithTcp(innerSrcPort: number, innerProto = 6): Uint8Array {
  const outerIpLen = 20
  const icmpLen = 8
  const innerIpLen = 20
  const innerTcpLen = 8
  const buf = new Uint8Array(outerIpLen + icmpLen + innerIpLen + innerTcpLen)

  // Outer IP: version=4 (high 4 bits), IHL=5 (low 4 bits) = 0x45.
  buf[0] = 0x45

  // ICMP header at offset 20: type=11 (Time Exceeded), code=0, checksum ignored
  // by parseIcmpTcpReply, then 4 bytes unused.
  buf[outerIpLen + 0] = 11

  // Inner IP at offset 28: IHL=5 (20 bytes), protocol=innerProto at byte 9.
  buf[outerIpLen + icmpLen + 0] = 0x45
  buf[outerIpLen + icmpLen + 9] = innerProto

  // Inner TCP at offset 48: srcPort in big-endian.
  const tcpOff = outerIpLen + icmpLen + innerIpLen
  buf[tcpOff + 0] = (innerSrcPort >> 8) & 0xff
  buf[tcpOff + 1] = innerSrcPort & 0xff
  return buf
}

describe('parseIcmpTcpReply', () => {
  test('extracts the inner TCP source port from a Time Exceeded reply', () => {
    const packet = buildTimeExceededWithTcp(54321)
    const srcBytes = new Uint8Array([203, 0, 113, 7])
    const parsed = parseIcmpTcpReply(packet, srcBytes)
    expect(parsed).toEqual({ srcIcmp: '203.0.113.7', innerTcpSrcPort: 54321 })
  })

  test('also accepts Destination Unreachable with a TCP inner payload', () => {
    const packet = buildTimeExceededWithTcp(42000)
    packet[20] = 3 // ICMP type = Destination Unreachable
    const parsed = parseIcmpTcpReply(packet, new Uint8Array([10, 0, 0, 1]))
    expect(parsed?.innerTcpSrcPort).toBe(42000)
  })

  test('returns null when the inner protocol is not TCP', () => {
    // Inner IP.protocol = 1 (ICMP), which would match the existing ICMP
    // prober but is not something our TCP prober should correlate to.
    const packet = buildTimeExceededWithTcp(12345, 1)
    const parsed = parseIcmpTcpReply(packet, new Uint8Array([10, 0, 0, 1]))
    expect(parsed).toBeNull()
  })

  test('returns null for truncated payloads', () => {
    const packet = buildTimeExceededWithTcp(12345).subarray(0, 40)
    const parsed = parseIcmpTcpReply(packet, new Uint8Array([10, 0, 0, 1]))
    expect(parsed).toBeNull()
  })

  test('returns null for unrelated ICMP types (Echo Reply)', () => {
    const packet = buildTimeExceededWithTcp(12345)
    packet[20] = 0 // ICMP type = Echo Reply - not something we care about here
    const parsed = parseIcmpTcpReply(packet, new Uint8Array([10, 0, 0, 1]))
    expect(parsed).toBeNull()
  })
})
