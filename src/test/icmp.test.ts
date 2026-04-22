import { describe, expect, test } from 'vitest'
import {
  buildEchoRequest,
  buildSockaddrIn,
  decodeSeq,
  encodeSeq,
  ICMP_DEST_UNREACH,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  ICMP_TIME_EXCEEDED,
  icmpChecksum,
  ipv4FromBytes,
  parseIpv4,
  parseReply,
  readScmTimestampNs,
  SCM_TIMESTAMPNS,
  SOL_SOCKET,
} from '../lib/icmp.ts'

// Builds a minimal IPv4 header (20 bytes, IHL=5, no options). Checksum left
// zero because parseReply ignores it — nothing we do validates IP checksums.
function buildIpv4Header(
  payloadLen: number,
  protocol: number,
  src: number[],
  dst: number[],
): Uint8Array {
  const hdr = new Uint8Array(20)
  hdr[0] = 0x45
  hdr[1] = 0
  const totalLen = 20 + payloadLen
  hdr[2] = (totalLen >> 8) & 0xff
  hdr[3] = totalLen & 0xff
  hdr[8] = 64
  hdr[9] = protocol
  hdr.set(src, 12)
  hdr.set(dst, 16)
  return hdr
}

function buildIcmpEchoHeader(
  type: number,
  id: number,
  seq: number,
  payload: Uint8Array,
): Uint8Array {
  const pkt = new Uint8Array(8 + payload.length)
  pkt[0] = type
  pkt[4] = (id >> 8) & 0xff
  pkt[5] = id & 0xff
  pkt[6] = (seq >> 8) & 0xff
  pkt[7] = seq & 0xff
  pkt.set(payload, 8)
  const cksum = icmpChecksum(pkt)
  pkt[2] = (cksum >> 8) & 0xff
  pkt[3] = cksum & 0xff
  return pkt
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

describe('icmpChecksum', () => {
  test('returns 0xffff for all-zero buffer', () => {
    // All zeros sums to zero; ~0 in 16 bits is 0xffff.
    expect(icmpChecksum(new Uint8Array(8))).toBe(0xffff)
  })

  test('handles odd-length buffers by padding the last byte', () => {
    // sum = 0x0100 (from the single 0x01 byte shifted left 8)
    // ~0x0100 & 0xffff = 0xfeff
    expect(icmpChecksum(new Uint8Array([0x01]))).toBe(0xfeff)
  })

  test('a correctly-built packet checksums to zero when re-verified', () => {
    // Standard property: checksumming a packet whose checksum field already holds
    // the correct value yields 0 (the carries fold cleanly).
    const pkt = buildEchoRequest(0x1234, 0x0001, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(icmpChecksum(pkt)).toBe(0)
  })
})

describe('parseIpv4 / ipv4FromBytes', () => {
  test('roundtrips common addresses', () => {
    for (const ip of ['1.2.3.4', '0.0.0.0', '255.255.255.255', '10.0.0.1']) {
      expect(ipv4FromBytes(parseIpv4(ip))).toBe(ip)
    }
  })

  test('rejects malformed input', () => {
    expect(() => parseIpv4('1.2.3')).toThrow(/Invalid IPv4/)
    expect(() => parseIpv4('1.2.3.256')).toThrow(/Invalid IPv4/)
    expect(() => parseIpv4('a.b.c.d')).toThrow(/Invalid IPv4/)
    expect(() => parseIpv4('1.2.3.-1')).toThrow(/Invalid IPv4/)
  })
})

describe('buildSockaddrIn', () => {
  test('lays out family / port / address in Linux order', () => {
    const sa = buildSockaddrIn(parseIpv4('192.0.2.5'), 0x1234)
    expect(sa.length).toBe(16)
    expect(sa[0]).toBe(2)
    expect(sa[1]).toBe(0)
    // Port is network byte order: 0x1234 -> 0x12, 0x34
    expect(sa[2]).toBe(0x12)
    expect(sa[3]).toBe(0x34)
    expect(Array.from(sa.slice(4, 8))).toEqual([192, 0, 2, 5])
    // Trailing 8 bytes are zero.
    expect(Array.from(sa.slice(8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })
})

describe('buildEchoRequest', () => {
  test('writes type=8, id/seq in big-endian, and a valid checksum', () => {
    const pkt = buildEchoRequest(0xabcd, 0x0102, new Uint8Array([9, 9, 9, 9]))
    expect(pkt[0]).toBe(ICMP_ECHO_REQUEST)
    expect(pkt[1]).toBe(0)
    expect(pkt[4]).toBe(0xab)
    expect(pkt[5]).toBe(0xcd)
    expect(pkt[6]).toBe(0x01)
    expect(pkt[7]).toBe(0x02)
    // Payload lives after the 8-byte header.
    expect(Array.from(pkt.slice(8))).toEqual([9, 9, 9, 9])
    // Whole packet including the embedded checksum must verify to zero.
    expect(icmpChecksum(pkt)).toBe(0)
  })
})

describe('parseReply', () => {
  test('returns null on too-short buffers', () => {
    expect(parseReply(new Uint8Array(10), new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })

  test('ignores unrelated ICMP types (e.g. Redirect)', () => {
    const icmp = buildIcmpEchoHeader(5, 0, 0, new Uint8Array(0))
    const ip = buildIpv4Header(icmp.length, 1, [10, 0, 0, 1], [10, 0, 0, 2])
    expect(parseReply(concat(ip, icmp), new Uint8Array([10, 0, 0, 1]))).toBeNull()
  })

  test('parses an Echo Reply directly from the outer ICMP header', () => {
    const icmp = buildIcmpEchoHeader(ICMP_ECHO_REPLY, 0x1234, 0x5678, new Uint8Array(16))
    const ip = buildIpv4Header(icmp.length, 1, [8, 8, 8, 8], [10, 0, 0, 2])
    const parsed = parseReply(concat(ip, icmp), parseIpv4('8.8.8.8'))
    expect(parsed).toEqual({
      kind: 'echo_reply',
      code: 0,
      id: 0x1234,
      seq: 0x5678,
      src: '8.8.8.8',
    })
  })

  test('parses Time Exceeded by peeling the embedded inner IP+ICMP headers', () => {
    // Inner packet is our original Echo Request that the router TTL-expired.
    const innerIcmp = buildIcmpEchoHeader(ICMP_ECHO_REQUEST, 0xbeef, 0x0201, new Uint8Array(0))
    const innerIp = buildIpv4Header(innerIcmp.length, 1, [10, 0, 0, 2], [8, 8, 8, 8])
    const outerIcmp = concat(
      new Uint8Array([ICMP_TIME_EXCEEDED, 0, 0, 0, 0, 0, 0, 0]),
      innerIp,
      innerIcmp,
    )
    const outerIp = buildIpv4Header(outerIcmp.length, 1, [192, 0, 2, 1], [10, 0, 0, 2])
    const parsed = parseReply(concat(outerIp, outerIcmp), parseIpv4('192.0.2.1'))
    expect(parsed).toEqual({
      kind: 'time_exceeded',
      code: 0,
      id: 0xbeef,
      seq: 0x0201,
      src: '192.0.2.1',
    })
  })

  test('parses Destination Unreachable with preserved code', () => {
    const innerIcmp = buildIcmpEchoHeader(ICMP_ECHO_REQUEST, 0x4242, 0x0100, new Uint8Array(0))
    const innerIp = buildIpv4Header(innerIcmp.length, 1, [10, 0, 0, 2], [203, 0, 113, 9])
    const outerIcmp = concat(
      // Code 3 = port unreachable; we want to make sure `code` flows through.
      new Uint8Array([ICMP_DEST_UNREACH, 3, 0, 0, 0, 0, 0, 0]),
      innerIp,
      innerIcmp,
    )
    const outerIp = buildIpv4Header(outerIcmp.length, 1, [203, 0, 113, 9], [10, 0, 0, 2])
    const parsed = parseReply(concat(outerIp, outerIcmp), parseIpv4('203.0.113.9'))
    expect(parsed).toEqual({
      kind: 'dest_unreachable',
      code: 3,
      id: 0x4242,
      seq: 0x0100,
      src: '203.0.113.9',
    })
  })

  test('returns null when the embedded inner ICMP is not our Echo Request', () => {
    // Router quoted something that wasn't our probe — we can't attribute it, drop it.
    const innerIcmp = buildIcmpEchoHeader(ICMP_ECHO_REPLY, 0x1111, 0x2222, new Uint8Array(0))
    const innerIp = buildIpv4Header(innerIcmp.length, 1, [10, 0, 0, 2], [8, 8, 8, 8])
    const outerIcmp = concat(
      new Uint8Array([ICMP_TIME_EXCEEDED, 0, 0, 0, 0, 0, 0, 0]),
      innerIp,
      innerIcmp,
    )
    const outerIp = buildIpv4Header(outerIcmp.length, 1, [192, 0, 2, 1], [10, 0, 0, 2])
    expect(parseReply(concat(outerIp, outerIcmp), parseIpv4('192.0.2.1'))).toBeNull()
  })

  test('handles IP headers with options (IHL > 5)', () => {
    // Build a 24-byte IP header (IHL=6) with 4 bytes of options, and make sure
    // parseReply skips past the options correctly.
    const icmp = buildIcmpEchoHeader(ICMP_ECHO_REPLY, 0x9876, 0x1111, new Uint8Array(0))
    const ip = new Uint8Array(24)
    ip[0] = 0x46
    const totalLen = 24 + icmp.length
    ip[2] = (totalLen >> 8) & 0xff
    ip[3] = totalLen & 0xff
    ip[8] = 64
    ip[9] = 1
    ip.set([8, 8, 8, 8], 12)
    ip.set([10, 0, 0, 2], 16)
    const parsed = parseReply(concat(ip, icmp), parseIpv4('8.8.8.8'))
    expect(parsed?.kind).toBe('echo_reply')
    expect(parsed?.id).toBe(0x9876)
    expect(parsed?.seq).toBe(0x1111)
  })
})

describe('encodeSeq / decodeSeq', () => {
  test('roundtrips across cycles and TTLs', () => {
    const maxHops = 30
    for (let cycle = 0; cycle < 10; cycle += 1) {
      for (let ttl = 1; ttl <= maxHops; ttl += 1) {
        const seq = encodeSeq(cycle, ttl, maxHops)
        expect(decodeSeq(seq, maxHops)).toEqual({ cycle, ttl })
      }
    }
  })

  test('adjacent cycles never collide on seq', () => {
    // If a cycle-N reply arrives late, in the middle of cycle N+1, decodeSeq
    // must still attribute it to cycle N — the stride ensures no overlap.
    const maxHops = 30
    const seqsCycle0 = new Set<number>()
    for (let ttl = 1; ttl <= maxHops; ttl += 1) seqsCycle0.add(encodeSeq(0, ttl, maxHops))
    for (let ttl = 1; ttl <= maxHops; ttl += 1) {
      expect(seqsCycle0.has(encodeSeq(1, ttl, maxHops))).toBe(false)
    }
  })

  test('stays within 16 bits for typical parameters', () => {
    // ICMP seq is a 16-bit field. packets=10, maxHops=30 gives max seq
    // 9 * 60 + 30 = 570 — well under 65535.
    const maxHops = 30
    const maxSeq = encodeSeq(9, maxHops, maxHops)
    expect(maxSeq).toBeLessThan(0x10000)
  })

  test('roundtrips ttl for every valid cycle in the 11-bit cycle space', () => {
    const maxHops = 30
    for (let cycle = 0; cycle <= 2047; cycle += 17) {
      for (let ttl = 1; ttl <= maxHops; ttl += 1) {
        const seq = encodeSeq(cycle, ttl, maxHops)
        expect(decodeSeq(seq, maxHops).ttl).toBe(ttl)
      }
    }
  })

  test('always fits within the 16-bit ICMP seq field', () => {
    const maxHops = 30
    for (let cycle = 0; cycle <= 2047; cycle += 100) {
      for (let ttl = 1; ttl <= maxHops; ttl += 1) {
        const seq = encodeSeq(cycle, ttl, maxHops)
        expect(seq).toBeGreaterThanOrEqual(0)
        expect(seq).toBeLessThan(0x10000)
      }
    }
  })

  test('rejects cycles past the 11-bit cycle space instead of silently wrapping', () => {
    // Wrapping silently reused seq values within a single probe run, letting
    // a late pre-wrap reply overwrite a post-wrap send time and return
    // nonsense RTT. The cycle value must be validated by the caller;
    // probe.packets is capped at config-load time for engine='native'
    // targets so this case should never land here in practice.
    const maxHops = 30
    expect(() => encodeSeq(2048, 5, maxHops)).toThrow(/cycle=2048/)
    expect(() => encodeSeq(-1, 5, maxHops)).toThrow(/cycle=-1/)
  })
})

function buildCmsg(level: number, type: number, data: Uint8Array): Uint8Array {
  // CMSG_LEN = header (16 bytes) + data length. No tail padding on the
  // encoded message itself — readScmTimestampNs handles alignment to the
  // next cmsghdr, but for a single cmsg the un-padded length is enough.
  const header = 16
  const buf = new Uint8Array(header + data.length)
  const view = new DataView(buf.buffer)
  view.setBigUint64(0, BigInt(header + data.length), true)
  view.setInt32(8, level, true)
  view.setInt32(12, type, true)
  buf.set(data, header)
  return buf
}

function buildTimespec(secs: bigint, nsec: bigint): Uint8Array {
  const buf = new Uint8Array(16)
  const view = new DataView(buf.buffer)
  view.setBigInt64(0, secs, true)
  view.setBigInt64(8, nsec, true)
  return buf
}

describe('readScmTimestampNs', () => {
  test('returns nanoseconds for a single SCM_TIMESTAMPNS cmsg', () => {
    const ts = buildTimespec(1_700_000_000n, 123_456_789n)
    const cmsg = buildCmsg(SOL_SOCKET, SCM_TIMESTAMPNS, ts)
    const ctrl = new Uint8Array(256)
    ctrl.set(cmsg, 0)
    expect(readScmTimestampNs(ctrl, cmsg.length)).toBe(1_700_000_000_000_000_000n + 123_456_789n)
  })

  test('returns null when no timestamp cmsg is present', () => {
    const ctrl = new Uint8Array(256)
    // A foreign cmsg (different level/type) shouldn't match.
    const other = buildCmsg(999, 999, new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]))
    ctrl.set(other, 0)
    expect(readScmTimestampNs(ctrl, other.length)).toBeNull()
  })

  test('skips foreign cmsg and finds timestamp on next iteration with 8-byte alignment', () => {
    // First cmsg is 20 bytes (16-byte header + 4 bytes data) — not aligned.
    // Next cmsghdr must start at 24 (next 8-byte boundary).
    const first = buildCmsg(999, 999, new Uint8Array([1, 2, 3, 4]))
    const ts = buildTimespec(42n, 7n)
    const second = buildCmsg(SOL_SOCKET, SCM_TIMESTAMPNS, ts)
    const ctrl = new Uint8Array(256)
    ctrl.set(first, 0)
    ctrl.set(second, 24) // 20 rounded up to 24
    expect(readScmTimestampNs(ctrl, 24 + second.length)).toBe(42_000_000_007n)
  })

  test('returns null when cmsg_len is absurd (truncated/corrupt control data)', () => {
    const ctrl = new Uint8Array(256)
    const view = new DataView(ctrl.buffer)
    view.setBigUint64(0, 8n, true) // cmsg_len too small to contain level+type
    view.setInt32(8, SOL_SOCKET, true)
    view.setInt32(12, SCM_TIMESTAMPNS, true)
    // cmsgLen < 16 guards against infinite loops on corrupt data.
    expect(readScmTimestampNs(ctrl, 256)).toBeNull()
  })
})
