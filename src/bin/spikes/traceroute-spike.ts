#!/usr/bin/env bun
// Traceroute feasibility spike. Linux-only, one-off tool.
//
// Opens SOCK_RAW IPPROTO_ICMP via Bun FFI + libc, sends ICMP Echo Requests
// with varying IP_TTL, parses Time Exceeded / Echo Reply responses, and
// prints a per-hop table. Requires CAP_NET_RAW (observer unit grants it;
// locally: run with sudo). This file is a throwaway — no unit tests, no
// integration with the daemon — its only job is to prove that we can get
// reliable hop data from raw sockets before we commit to replacing mtr.
//
// Usage:
//   bun src/bin/spikes/traceroute-spike.ts --target google.com [--max-hops 30] [--probes 3] [--timeout-ms 5000]

import { dlopen, FFIType, ptr, read } from 'bun:ffi'
import { lookup } from 'node:dns/promises'
import { parseArgs } from 'node:util'

const AF_INET = 2
const SOCK_RAW = 3
const IPPROTO_IP = 0
const IPPROTO_ICMP = 1
const IP_TTL = 2
const MSG_DONTWAIT = 0x40

const ICMP_ECHO_REPLY = 0
const ICMP_DEST_UNREACH = 3
const ICMP_ECHO_REQUEST = 8
const ICMP_TIME_EXCEEDED = 11

const libc = dlopen('libc.so.6', {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  setsockopt: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  sendto: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i64,
  },
  recvfrom: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i64,
  },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
})

function errno(): number {
  const p = libc.symbols.__errno_location()
  if (p == null) return -1
  return read.i32(p)
}

function icmpChecksum(buf: Uint8Array): number {
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

function buildEchoRequest(id: number, seq: number, payload: Uint8Array): Uint8Array {
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

function buildSockaddrIn(ipBytes: Uint8Array, port: number): Uint8Array {
  // Linux x86_64 sockaddr_in is 16 bytes: family(2) port(2) addr(4) zero(8).
  const sa = new Uint8Array(16)
  sa[0] = AF_INET & 0xff
  sa[1] = (AF_INET >> 8) & 0xff
  sa[2] = (port >> 8) & 0xff
  sa[3] = port & 0xff
  sa.set(ipBytes.subarray(0, 4), 4)
  return sa
}

function parseIpv4(ipStr: string): Uint8Array {
  const parts = ipStr.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4: ${ipStr}`)
  }
  return new Uint8Array(parts)
}

function ipv4FromBytes(b: Uint8Array): string {
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`
}

interface Parsed {
  kind: 'echo_reply' | 'time_exceeded' | 'dest_unreachable'
  code: number
  id: number
  seq: number
  src: string
}

function parseReply(buf: Uint8Array, srcIpBytes: Uint8Array): Parsed | null {
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
    // 8-byte ICMP header, then the original IP+ICMP headers of our probe.
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      'max-hops': { type: 'string', default: '30' },
      probes: { type: 'string', default: '3' },
      'timeout-ms': { type: 'string', default: '5000' },
    },
  })

  const target = values.target
  if (target == null || target.length === 0) {
    throw new Error('--target is required (host or IPv4)')
  }
  const maxHops = Number(values['max-hops'])
  const probesPerHop = Number(values.probes)
  const timeoutMs = Number(values['timeout-ms'])

  const resolved = await lookup(target, 4)
  const targetBytes = parseIpv4(resolved.address)
  const targetSa = buildSockaddrIn(targetBytes, 0)

  console.log(
    `traceroute-spike: target=${target} (${resolved.address}), maxHops=${maxHops}, probesPerHop=${probesPerHop}, timeoutMs=${timeoutMs}`,
  )

  const sock = libc.symbols.socket(AF_INET, SOCK_RAW, IPPROTO_ICMP)
  if (sock < 0) {
    throw new Error(`socket(AF_INET, SOCK_RAW, IPPROTO_ICMP) failed, errno=${errno()}`)
  }

  const id = process.pid & 0xffff
  const sendTimeNs = new Map<number, number>()

  interface HopSample {
    src: string
    rttMs: number
    kind: Parsed['kind']
  }
  const hopSamples = new Map<number, HopSample[]>()
  const recvBuf = new Uint8Array(2048)
  const srcSa = new Uint8Array(16)
  const srcLenBuf = new Uint32Array([16])

  // Drain the receive queue once. Returns false if the queue is empty.
  function drainOnce(): boolean {
    srcLenBuf[0] = 16
    const n = libc.symbols.recvfrom(
      sock,
      ptr(recvBuf),
      BigInt(recvBuf.length),
      MSG_DONTWAIT,
      ptr(srcSa),
      ptr(srcLenBuf),
    )
    if (n < 0n) return false
    const arrivedNs = Bun.nanoseconds()
    const parsed = parseReply(recvBuf.subarray(0, Number(n)), srcSa.subarray(4, 8))
    if (parsed == null || parsed.id !== id) return true
    const sendNs = sendTimeNs.get(parsed.seq)
    if (sendNs == null) return true
    const rttMs = (arrivedNs - sendNs) / 1_000_000
    const ttl = Math.floor(parsed.seq / 256)
    const list = hopSamples.get(ttl) ?? []
    list.push({ src: parsed.src, rttMs, kind: parsed.kind })
    hopSamples.set(ttl, list)
    return true
  }

  for (let ttl = 1; ttl <= maxHops; ttl += 1) {
    const ttlBuf = new Int32Array([ttl])
    const rc = libc.symbols.setsockopt(sock, IPPROTO_IP, IP_TTL, ptr(ttlBuf), 4)
    if (rc < 0) {
      libc.symbols.close(sock)
      throw new Error(`setsockopt(IP_TTL=${ttl}) failed, errno=${errno()}`)
    }

    for (let probe = 0; probe < probesPerHop; probe += 1) {
      const seq = ttl * 256 + probe
      const packet = buildEchoRequest(id, seq, new Uint8Array(16))
      // Capture send timestamp immediately before sendto so RTT measurement
      // excludes JS work we did before the syscall.
      sendTimeNs.set(seq, Bun.nanoseconds())
      const sent = libc.symbols.sendto(
        sock,
        ptr(packet),
        BigInt(packet.length),
        0,
        ptr(targetSa),
        targetSa.length,
      )
      if (sent < 0n) {
        console.warn(`  sendto(ttl=${ttl}, probe=${probe}) failed, errno=${errno()}`)
        sendTimeNs.delete(seq)
        continue
      }
      // Drain anything already waiting so RTTs aren't dominated by the
      // time we spend looping over remaining TTLs before polling.
      while (drainOnce()) {}
    }
  }

  const deadlineNs = Bun.nanoseconds() + timeoutMs * 1_000_000
  while (Bun.nanoseconds() < deadlineNs) {
    if (!drainOnce()) await Bun.sleep(5)
  }

  libc.symbols.close(sock)

  let destReachedAt: number | null = null
  for (let ttl = 1; ttl <= maxHops; ttl += 1) {
    const samples = hopSamples.get(ttl) ?? []
    if (samples.length === 0) {
      console.log(`${ttl.toString().padStart(2)}  *`)
      continue
    }
    const ips = Array.from(new Set(samples.map((s) => s.src))).join(',')
    const rtts = samples.map((s) => `${s.rttMs.toFixed(1)}ms`).join(' ')
    const marker = samples.some((s) => s.kind === 'echo_reply') ? ' <-- dest' : ''
    console.log(`${ttl.toString().padStart(2)}  ${ips.padEnd(20)}  ${rtts}${marker}`)
    if (samples.some((s) => s.kind === 'echo_reply')) {
      destReachedAt = ttl
      break
    }
  }
  if (destReachedAt == null) {
    console.log('destination never echoed back within the time budget')
  }
}

main().catch((err) => {
  if (!(err instanceof Error)) {
    throw new Error(`Was thrown a non-error: ${err}`)
  }
  console.error(err.message)
  process.exit(1)
})
