// Linux-only native traceroute prober. Opens SOCK_RAW IPPROTO_ICMP via Bun
// FFI + libc, sends ICMP Echo Requests with varying IP_TTL, parses Time
// Exceeded / Echo Reply responses, reverse-resolves hop IPs, and returns a
// `RawMtrEvent[]` stream in the same shape the mtr adapter produces — so the
// collector can swap engines without touching downstream rollup/render code.
//
// Requires CAP_NET_RAW (observer systemd unit grants it; locally: sudo). Does
// not load under vitest/Node: `bun:ffi` only exists in the Bun runtime. The
// pure wire-format helpers live in ./icmp.ts and are unit-tested there.

import { dlopen, FFIType, ptr, read } from 'bun:ffi'
import { reverse } from 'node:dns/promises'
import {
  AF_INET,
  buildEchoRequest,
  buildSockaddrIn,
  decodeSeq,
  encodeSeq,
  IP_TTL,
  IPPROTO_ICMP,
  IPPROTO_IP,
  MSG_DONTWAIT,
  parseIpv4,
  parseReply,
  SOCK_RAW,
} from './icmp.ts'
import type { RawMtrEvent } from './raw.ts'

export interface NativeProbeOptions {
  // Already-resolved IPv4 target. DNS resolution is the caller's job so they
  // can share a resolver or enforce a netns-bound lookup.
  hostIp: string
  maxHops?: number
  // Probes per hop (≈ mtr -c). Sent in cycles so a black-holed hop in one
  // cycle doesn't poison all later hops.
  packets?: number
  timeoutMs?: number
  resolveReverseDns?: boolean
  // Inter-send pacing. Firing all TTLs back-to-back (<1ms) hammers routers
  // into their ICMP rate limiters (saw ~70% apparent loss against 8.8.8.8
  // with zero pacing) AND starves the non-blocking drain so destHopIndex
  // is set too late for early-stop to kick in. 25ms is well under mtr's 1s
  // default but gives replies enough headroom on low-RTT paths.
  probeIntervalMs?: number
}

const DEFAULTS = {
  maxHops: 30,
  packets: 10,
  timeoutMs: 5000,
  resolveReverseDns: true,
  probeIntervalMs: 25,
} as const

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

export async function probeTargetNative(options: NativeProbeOptions): Promise<RawMtrEvent[]> {
  const maxHops = options.maxHops ?? DEFAULTS.maxHops
  const packets = options.packets ?? DEFAULTS.packets
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
  const resolveRdns = options.resolveReverseDns ?? DEFAULTS.resolveReverseDns
  const probeIntervalMs = options.probeIntervalMs ?? DEFAULTS.probeIntervalMs

  const targetBytes = parseIpv4(options.hostIp)
  const targetSa = buildSockaddrIn(targetBytes, 0)

  const sock = libc.symbols.socket(AF_INET, SOCK_RAW, IPPROTO_ICMP)
  if (sock < 0) {
    throw new Error(`socket(AF_INET, SOCK_RAW, IPPROTO_ICMP) failed, errno=${errno()}`)
  }

  // A random 16-bit identifier per call — not `process.pid & 0xffff`. Two
  // concurrent probes on the same host share the raw socket's incoming queue
  // (the kernel delivers every ICMP reply to every open raw ICMP socket); if
  // both calls used the same identifier, probe A could drain probe B's
  // matching replies and attribute them to the wrong target/hop. Random
  // collisions between concurrent calls are possible but negligible at the
  // concurrency we run (default 3).
  const id = Math.floor(Math.random() * 0x10000) & 0xffff
  const sendTimeNs = new Map<number, number>()
  const events: RawMtrEvent[] = []
  // Hop indices (0-based = ttl-1) where we've observed any reply, so we can
  // scope reverse DNS + bound the output to the reachable part of the path.
  const knownHostsByHop = new Map<number, Set<string>>()
  let destHopIndex: number | null = null

  const recvBuf = new Uint8Array(2048)
  const srcSa = new Uint8Array(16)
  const srcLenBuf = new Uint32Array([16])

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
    const { ttl } = decodeSeq(parsed.seq, maxHops)
    const hopIndex = ttl - 1
    let hosts = knownHostsByHop.get(hopIndex)
    if (hosts == null) {
      hosts = new Set<string>()
      knownHostsByHop.set(hopIndex, hosts)
    }
    if (!hosts.has(parsed.src)) {
      hosts.add(parsed.src)
      events.push({ kind: 'host', hopIndex, host: parsed.src })
    }
    const rttUs = Math.max(0, Math.round((arrivedNs - sendNs) / 1000))
    events.push({ kind: 'reply', hopIndex, probeId: parsed.seq, rttUs })
    if (parsed.kind === 'echo_reply' && (destHopIndex == null || hopIndex < destHopIndex)) {
      destHopIndex = hopIndex
    }
    return true
  }

  try {
    for (let cycle = 0; cycle < packets; cycle += 1) {
      for (let ttl = 1; ttl <= maxHops; ttl += 1) {
        // Stop sending past the destination once we know where it is — saves
        // ~5ms * (maxHops - destHop) per cycle on short paths.
        if (destHopIndex != null && ttl - 1 > destHopIndex) break

        const ttlBuf = new Int32Array([ttl])
        const rc = libc.symbols.setsockopt(sock, IPPROTO_IP, IP_TTL, ptr(ttlBuf), 4)
        if (rc < 0) {
          throw new Error(`setsockopt(IP_TTL=${ttl}) failed, errno=${errno()}`)
        }

        const seq = encodeSeq(cycle, ttl, maxHops)
        const packet = buildEchoRequest(id, seq, new Uint8Array(16))
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
          sendTimeNs.delete(seq)
          continue
        }
        events.push({ kind: 'sent', hopIndex: ttl - 1, probeId: seq })
        // Pace the next send while opportunistically draining replies. Using
        // a real sleep (not a spin) gives the kernel time to accept incoming
        // Time Exceeded packets and lets destHopIndex settle before cycle N+1.
        const nextSendAtNs = Bun.nanoseconds() + probeIntervalMs * 1_000_000
        while (Bun.nanoseconds() < nextSendAtNs) {
          if (!drainOnce()) await Bun.sleep(2)
        }
      }
    }

    const deadlineNs = Bun.nanoseconds() + timeoutMs * 1_000_000
    while (Bun.nanoseconds() < deadlineNs) {
      if (!drainOnce()) await Bun.sleep(5)
    }
  } finally {
    libc.symbols.close(sock)
  }

  if (resolveRdns) {
    const uniqueHosts = new Set<string>()
    for (const hosts of knownHostsByHop.values()) {
      for (const host of hosts) uniqueHosts.add(host)
    }
    // The same IP can legitimately appear on multiple hops (asymmetric paths,
    // ICMP-RESP from a routing loop, etc.). Map each IP to every hop index
    // that saw it so each hop receives its own `dns` event — the renderer
    // shows the reverse name next to each occurrence of the hop, and
    // deduplicating to the first hop hides that information on later ones.
    const hopIndicesByHost = new Map<string, number[]>()
    for (const [hopIndex, hosts] of knownHostsByHop.entries()) {
      for (const host of hosts) {
        const existing = hopIndicesByHost.get(host)
        if (existing == null) {
          hopIndicesByHost.set(host, [hopIndex])
        } else if (!existing.includes(hopIndex)) {
          existing.push(hopIndex)
        }
      }
    }
    const resolved = await Promise.all(
      Array.from(uniqueHosts).map(async (ip) => {
        const names = await reverse(ip).catch(() => [] as string[])
        return { ip, name: names[0] ?? null }
      }),
    )
    for (const { ip, name } of resolved) {
      if (name == null) continue
      const hopIndices = hopIndicesByHost.get(ip) ?? []
      for (const hopIndex of hopIndices) {
        events.push({ kind: 'dns', hopIndex, host: name })
      }
    }
  }

  return events
}
