// Pure TCP/IP wire-format helpers for the native TCP-SYN prober. No FFI,
// no sockets — lives here so it can be unit-tested under vitest/Node and
// reused by the FFI-backed prober in prober-native-tcp.ts.
//
// The only TCP bit we need in userspace is reading the src port out of
// the inner TCP header that routers echo back inside ICMP Time Exceeded
// / Destination Unreachable messages — that's how we correlate a mid-
// path reply to the probe that triggered it.

import { ICMP_DEST_UNREACH, ICMP_TIME_EXCEEDED, ipv4FromBytes } from './icmp.ts'

export const IPPROTO_TCP = 6

export interface ParsedIcmpTcpReply {
  srcIcmp: string
  innerTcpSrcPort: number
}

// `buf` starts at the outer IPv4 header as delivered by recvfrom on a raw
// IPPROTO_ICMP socket. `srcBytes` is the peer IP from the recvfrom
// sockaddr. Returns null if the packet isn't something we care about
// (wrong ICMP type, truncated, or the inner payload isn't TCP).
export function parseIcmpTcpReply(
  buf: Uint8Array,
  srcBytes: Uint8Array,
): ParsedIcmpTcpReply | null {
  const len = buf.length
  if (len < 20) return null
  const ihl = (buf[0] & 0x0f) * 4
  if (ihl < 20 || len < ihl + 8) return null
  const icmpType = buf[ihl]
  if (icmpType !== ICMP_TIME_EXCEEDED && icmpType !== ICMP_DEST_UNREACH) return null
  // Outer ICMP header is 8 bytes, then the inner IP header of our probe.
  const innerIpOff = ihl + 8
  if (len < innerIpOff + 20) return null
  const innerProto = buf[innerIpOff + 9]
  if (innerProto !== IPPROTO_TCP) return null
  const innerIhl = (buf[innerIpOff] & 0x0f) * 4
  const innerTcpOff = innerIpOff + innerIhl
  // RFC 792 only guarantees routers copy back the first 8 bytes of the
  // inner transport header. For TCP that's srcPort(2) + dstPort(2) +
  // seqNum(4); the src port is all we need.
  if (len < innerTcpOff + 4) return null
  const innerTcpSrcPort = (buf[innerTcpOff] << 8) | buf[innerTcpOff + 1]
  return { srcIcmp: ipv4FromBytes(srcBytes), innerTcpSrcPort }
}
