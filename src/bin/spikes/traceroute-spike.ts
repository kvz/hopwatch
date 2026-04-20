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
import {
  AF_INET,
  buildEchoRequest,
  buildSockaddrIn,
  IP_TTL,
  IPPROTO_ICMP,
  IPPROTO_IP,
  MSG_DONTWAIT,
  type Parsed,
  parseIpv4,
  parseReply,
  SOCK_RAW,
} from '../../lib/icmp.ts'

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
