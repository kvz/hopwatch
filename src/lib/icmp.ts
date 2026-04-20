// Pure ICMPv4 helpers: protocol constants, packet building, checksum, and
// reply parsing. No FFI, no sockets — lives here so it can be unit-tested
// under vitest/Node and reused by both the spike entrypoint and the real
// probe worker.
//
// Wire format references:
//   RFC 792  — ICMP
//   RFC 4884 — ICMP extensions (we ignore these for now)

export const AF_INET = 2
export const SOCK_RAW = 3
export const IPPROTO_IP = 0
export const IPPROTO_ICMP = 1
export const IP_TTL = 2
export const MSG_DONTWAIT = 0x40

export const ICMP_ECHO_REPLY = 0
export const ICMP_DEST_UNREACH = 3
export const ICMP_ECHO_REQUEST = 8
export const ICMP_TIME_EXCEEDED = 11

export type ParsedKind = 'echo_reply' | 'time_exceeded' | 'dest_unreachable'

export interface Parsed {
  kind: ParsedKind
  code: number
  id: number
  seq: number
  src: string
}

// RFC 1071 one's-complement checksum, big-endian.
export function icmpChecksum(buf: Uint8Array): number {
  let sum = 0
  const len = buf.length
  for (let i = 0; i + 1 < len; i += 2) {
    sum += (buf[i] << 8) | buf[i + 1]
  }
  if ((len & 1) === 1) {
    sum += buf[len - 1] << 8
  }
  while (sum >> 16) {
    sum = (sum & 0xffff) + (sum >> 16)
  }
  return ~sum & 0xffff
}

export function buildEchoRequest(id: number, seq: number, payload: Uint8Array): Uint8Array {
  const packet = new Uint8Array(8 + payload.length)
  packet[0] = ICMP_ECHO_REQUEST
  packet[1] = 0
  packet[2] = 0
  packet[3] = 0
  packet[4] = (id >> 8) & 0xff
  packet[5] = id & 0xff
  packet[6] = (seq >> 8) & 0xff
  packet[7] = seq & 0xff
  packet.set(payload, 8)
  const cksum = icmpChecksum(packet)
  packet[2] = (cksum >> 8) & 0xff
  packet[3] = cksum & 0xff
  return packet
}

export function buildSockaddrIn(ipBytes: Uint8Array, port: number): Uint8Array {
  // Linux x86_64 sockaddr_in is 16 bytes: family(2) port(2) addr(4) zero(8).
  const sa = new Uint8Array(16)
  sa[0] = AF_INET & 0xff
  sa[1] = (AF_INET >> 8) & 0xff
  sa[2] = (port >> 8) & 0xff
  sa[3] = port & 0xff
  sa.set(ipBytes.subarray(0, 4), 4)
  return sa
}

export function parseIpv4(ipStr: string): Uint8Array {
  const parts = ipStr.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4: ${ipStr}`)
  }
  return new Uint8Array(parts)
}

export function ipv4FromBytes(b: Uint8Array): string {
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`
}

// Sequence-number encoding we use for traceroute probes. Each cycle sweeps
// all TTLs once; we stride by `maxHops * 2` so two adjacent cycles can't
// collide on seq even if a late reply arrives after the next cycle started.
// The wire field is 16 bits, so we mask here: long runs (packets=2000,
// maxHops=30 → raw 120030) would otherwise overflow and replies would come
// back with a truncated seq that no longer keyed the sendTimeNs map. On
// wrap, older cycles reuse seqs — fine as long as each cycle's replies
// arrive within the wrap window (in practice, within the probe timeout).
export function encodeSeq(cycle: number, ttl: number, maxHops: number): number {
  return (cycle * maxHops * 2 + ttl) & 0xffff
}

export function decodeSeq(seq: number, maxHops: number): { cycle: number; ttl: number } {
  const stride = maxHops * 2
  return { cycle: Math.floor(seq / stride), ttl: seq % stride }
}

// Parse the ICMP payload delivered by a raw-socket recvfrom. `buf` starts at
// the outer IP header. `srcIpBytes` is the peer address populated in the
// recvfrom sockaddr (4 bytes, network order). Returns null if the packet is
// uninteresting (unrelated ICMP type, truncated, malformed).
export function parseReply(buf: Uint8Array, srcIpBytes: Uint8Array): Parsed | null {
  const len = buf.length
  if (len < 20) return null
  const ihl = (buf[0] & 0x0f) * 4
  if (ihl < 20 || len < ihl + 8) return null
  const icmpType = buf[ihl]
  const icmpCode = buf[ihl + 1]
  if (icmpType === ICMP_ECHO_REPLY) {
    const id = (buf[ihl + 4] << 8) | buf[ihl + 5]
    const seq = (buf[ihl + 6] << 8) | buf[ihl + 7]
    return { kind: 'echo_reply', code: icmpCode, id, seq, src: ipv4FromBytes(srcIpBytes) }
  }
  if (icmpType === ICMP_TIME_EXCEEDED || icmpType === ICMP_DEST_UNREACH) {
    // 8-byte outer ICMP header, then the original IP+ICMP headers of our probe.
    const innerIpOff = ihl + 8
    if (len < innerIpOff + 20) return null
    const innerIhl = (buf[innerIpOff] & 0x0f) * 4
    const innerIcmpOff = innerIpOff + innerIhl
    if (len < innerIcmpOff + 8) return null
    if (buf[innerIcmpOff] !== ICMP_ECHO_REQUEST) return null
    const id = (buf[innerIcmpOff + 4] << 8) | buf[innerIcmpOff + 5]
    const seq = (buf[innerIcmpOff + 6] << 8) | buf[innerIcmpOff + 7]
    return {
      kind: icmpType === ICMP_TIME_EXCEEDED ? 'time_exceeded' : 'dest_unreachable',
      code: icmpCode,
      id,
      seq,
      src: ipv4FromBytes(srcIpBytes),
    }
  }
  return null
}

// Linux x86_64 socket control message constants. See <asm-generic/socket.h>.
export const SOL_SOCKET = 1
export const SCM_TIMESTAMPNS = 35

// Walk a `struct cmsghdr` chain (the layout the kernel writes into msg_control
// on recvmsg) and return the first SCM_TIMESTAMPNS value as nanoseconds since
// the epoch. Each cmsghdr on x86_64 is: { u64 cmsg_len; i32 cmsg_level; i32
// cmsg_type; … data … }, then padded up to the next 8-byte boundary.
export function readScmTimestampNs(ctrlBuf: Uint8Array, controllenBytes: number): bigint | null {
  let off = 0
  while (off + 16 <= controllenBytes) {
    const view = new DataView(ctrlBuf.buffer, ctrlBuf.byteOffset + off)
    const cmsgLen = Number(view.getBigUint64(0, true))
    if (cmsgLen < 16 || off + cmsgLen > controllenBytes) return null
    const level = view.getInt32(8, true)
    const type = view.getInt32(12, true)
    if (level === SOL_SOCKET && type === SCM_TIMESTAMPNS && cmsgLen >= 32) {
      const ts = new DataView(ctrlBuf.buffer, ctrlBuf.byteOffset + off + 16)
      return ts.getBigInt64(0, true) * 1_000_000_000n + ts.getBigInt64(8, true)
    }
    off += (cmsgLen + 7) & ~7
  }
  return null
}
