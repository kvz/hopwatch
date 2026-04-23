// Linux-only native TCP-SYN prober. Drives kernel TCP sockets with
// non-blocking connect() while varying IP_TTL per socket, and captures
// ICMP Time Exceeded from a separate raw IPPROTO_ICMP socket — the same
// approach `mtr --tcp` uses, implemented here in Bun FFI so hopwatch ships
// as a single binary with no external mtr dependency for the TCP path.
//
// Why kernel TCP rather than IP_HDRINCL + hand-crafted SYNs:
//   - The kernel already computes TCP/IP checksums, picks source IP based
//     on the route, and manages retransmissions. Replicating that in
//     userspace is ~400 lines of additional wire-format code plus a big
//     testing surface for maybe 50ms less of wall-clock time per cycle.
//   - Downside: the kernel performs a brief 3-way handshake with the
//     destination (rather than half-open SYN/RST). For our cadence (every
//     15 min per target) that's an ignorable server-side cost and the
//     peer-side kernel closes the connection on the next packet anyway.
//   - Requires CAP_NET_RAW only for the ICMP listen socket; the TCP
//     connect sockets work as any unprivileged user.
//
// Correlation strategy:
//   - Each probe binds an ephemeral local port (kernel-assigned via
//     bind(0.0.0.0:0) + getsockname()) before connect(). We build a
//     srcPort → (cycle, ttl, fd, sendTimeNs) map.
//   - Mid-path: ICMP Time Exceeded from a raw IPPROTO_ICMP socket carries
//     the first 8 bytes of our inner TCP header, which includes the src
//     port we assigned. Looking that port up reveals which hop the reply
//     belongs to.
//   - Destination: poll(POLLOUT) on each TCP fd. POLLOUT + SO_ERROR==0
//     means the kernel saw SYN-ACK — the destination responded. We emit
//     a reply at that hop index with the RTT measured from our own
//     sendTimeNs to the moment poll() reported the completion.
//
// The event stream shape matches prober-native.ts and the mtr parser so
// everything downstream (rollup aggregation, chart rendering) is agnostic
// to which engine produced the trace.

import { dlopen, FFIType, ptr, read } from 'bun:ffi'
import { reverse } from 'node:dns/promises'
import {
  AF_INET,
  buildSockaddrIn,
  encodeSeq,
  IP_TTL,
  IPPROTO_ICMP,
  IPPROTO_IP,
  MSG_DONTWAIT,
  parseIpv4,
  SOCK_RAW,
} from './icmp.ts'
import type { RawMtrEvent } from './raw.ts'
import { IPPROTO_TCP, parseIcmpTcpReply } from './tcp.ts'

export interface NativeTcpProbeOptions {
  hostIp: string
  port: number
  maxHops?: number
  packets?: number
  timeoutMs?: number
  resolveReverseDns?: boolean
  probeIntervalMs?: number
}

const DEFAULTS = {
  maxHops: 30,
  packets: 10,
  timeoutMs: 5000,
  resolveReverseDns: true,
  probeIntervalMs: 25,
} as const

// Linux socket constants. SOCK_STREAM=1, SOCK_NONBLOCK=0o4000 (2048) are
// stable across glibc Linuxes. TCP_SYNCNT=7 caps SYN retransmissions at
// the connecting side, so the kernel doesn't auto-retry under packet loss
// and artificially inflate our apparent success rate.
const SOCK_STREAM = 1
const SOCK_NONBLOCK = 0o4000
const SOL_SOCKET = 1
const SO_REUSEADDR = 2
const SO_ERROR = 4
const TCP_SYNCNT = 7
const POLLOUT = 0x0004
const POLLERR = 0x0008
const POLLHUP = 0x0010
const POLLNVAL = 0x0020

// Lazy libc load (same rationale as prober-native.ts: dlopen fails on
// musl/macOS, so deferring until first call lets the platform check in
// the collector fire first with a clearer error).
function openLibc() {
  return dlopen('libc.so.6', {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    setsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    getsockname: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    recvfrom: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i64,
    },
    poll: { args: [FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  })
}

type Libc = ReturnType<typeof openLibc>
let cachedLibc: Libc | null = null
function getLibc(): Libc {
  if (cachedLibc != null) return cachedLibc
  cachedLibc = openLibc()
  return cachedLibc
}

function errno(libc: Libc): number {
  const p = libc.symbols.__errno_location()
  if (p == null) return -1
  return read.i32(p)
}

export function warmupNativeTcpEngine(): void {
  getLibc()
}

interface InflightProbe {
  cycle: number
  ttl: number
  fd: number
  srcPort: number
  sendTimeNs: number
  seq: number
  resolved: boolean
}

export async function probeTargetNativeTcp(options: NativeTcpProbeOptions): Promise<RawMtrEvent[]> {
  const maxHops = options.maxHops ?? DEFAULTS.maxHops
  const packets = options.packets ?? DEFAULTS.packets
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
  const resolveRdns = options.resolveReverseDns ?? DEFAULTS.resolveReverseDns
  const probeIntervalMs = options.probeIntervalMs ?? DEFAULTS.probeIntervalMs

  const targetBytes = parseIpv4(options.hostIp)
  const targetSa = buildSockaddrIn(targetBytes, options.port)
  const libc = getLibc()

  // Listener for mid-path ICMP TTL-exceeded. We open this first so any
  // hop that replies before we finish launching the last SYN is captured.
  const icmpSock = libc.symbols.socket(AF_INET, SOCK_RAW, IPPROTO_ICMP)
  if (icmpSock < 0) {
    throw new Error(
      `socket(AF_INET, SOCK_RAW, IPPROTO_ICMP) failed, errno=${errno(libc)} (need CAP_NET_RAW)`,
    )
  }

  const inflightByPort = new Map<number, InflightProbe>()
  const events: RawMtrEvent[] = []
  const knownHostsByHop = new Map<number, Set<string>>()
  let destHopIndex: number | null = null

  const recvBuf = new Uint8Array(2048)
  const srcSa = new Uint8Array(16)
  const srcLenBuf = new Uint32Array([16])

  function recordHostEvent(hopIndex: number, host: string): void {
    let hosts = knownHostsByHop.get(hopIndex)
    if (hosts == null) {
      hosts = new Set<string>()
      knownHostsByHop.set(hopIndex, hosts)
    }
    if (!hosts.has(host)) {
      hosts.add(host)
      events.push({ kind: 'host', hopIndex, host })
    }
  }

  // Returns true if we consumed a packet (so the caller should try again).
  function drainIcmp(): boolean {
    srcLenBuf[0] = 16
    const n = libc.symbols.recvfrom(
      icmpSock,
      ptr(recvBuf),
      BigInt(recvBuf.length),
      MSG_DONTWAIT,
      ptr(srcSa),
      ptr(srcLenBuf),
    )
    if (n < 0n) return false
    const arrivedNs = Bun.nanoseconds()
    const parsed = parseIcmpTcpReply(recvBuf.subarray(0, Number(n)), srcSa.subarray(4, 8))
    if (parsed == null) return true
    const probe = inflightByPort.get(parsed.innerTcpSrcPort)
    if (probe == null || probe.resolved) return true
    probe.resolved = true
    const hopIndex = probe.ttl - 1
    recordHostEvent(hopIndex, parsed.srcIcmp)
    const rttUs = Math.max(0, Math.round((arrivedNs - probe.sendTimeNs) / 1000))
    events.push({ kind: 'reply', hopIndex, probeId: probe.seq, rttUs })
    return true
  }

  // pollfd is { i32 fd, i16 events, i16 revents } = 8 bytes, packed.
  function pollFds(): void {
    const pending: InflightProbe[] = []
    for (const probe of inflightByPort.values()) {
      if (!probe.resolved) pending.push(probe)
    }
    if (pending.length === 0) return
    const fdsBuf = new ArrayBuffer(8 * pending.length)
    const view = new DataView(fdsBuf)
    for (let i = 0; i < pending.length; i += 1) {
      view.setInt32(i * 8, pending[i].fd, true)
      view.setInt16(i * 8 + 4, POLLOUT, true)
      view.setInt16(i * 8 + 6, 0, true)
    }
    const fdsBytes = new Uint8Array(fdsBuf)
    // timeout=0: non-blocking. We drive pacing from the outer loop.
    const rc = libc.symbols.poll(ptr(fdsBytes), pending.length, 0)
    if (rc <= 0) return
    const arrivedNs = Bun.nanoseconds()
    for (let i = 0; i < pending.length; i += 1) {
      const revents = view.getInt16(i * 8 + 6, true)
      if ((revents & (POLLOUT | POLLERR | POLLHUP | POLLNVAL)) === 0) continue
      const probe = pending[i]
      // SO_ERROR==0 with POLLOUT means connect() succeeded: SYN-ACK was
      // received from the destination. Any other value means the kernel
      // aborted the connect — could be ECONNREFUSED (destination replied
      // with RST), EHOSTUNREACH / ENETUNREACH (ICMP dest-unreach already
      // surfaced via drainIcmp), or ETIMEDOUT (kernel gave up after
      // TCP_SYNCNT retries). We only emit a reply for the clean success
      // case; other outcomes are surfaced by their ICMP counterparts or
      // left as silent loss.
      const errBuf = new Int32Array([0])
      const lenBuf = new Uint32Array([4])
      libc.symbols.getsockopt(probe.fd, SOL_SOCKET, SO_ERROR, ptr(errBuf), ptr(lenBuf))
      if (errBuf[0] === 0) {
        probe.resolved = true
        const hopIndex = probe.ttl - 1
        recordHostEvent(hopIndex, options.hostIp)
        const rttUs = Math.max(0, Math.round((arrivedNs - probe.sendTimeNs) / 1000))
        events.push({ kind: 'reply', hopIndex, probeId: probe.seq, rttUs })
        if (destHopIndex == null || hopIndex < destHopIndex) {
          destHopIndex = hopIndex
        }
      } else {
        // ECONNREFUSED (111) — the destination replied immediately with RST;
        // for TCP-reachability purposes that still counts as "the
        // destination is on the network" even though it's not accepting on
        // the port. We don't emit a reply to avoid inflating success on
        // firewalled ports, matching the dest_unreachable handling in the
        // ICMP prober.
        probe.resolved = true
      }
    }
  }

  function openProbeSocket(ttl: number): { fd: number; srcPort: number } | null {
    const fd = libc.symbols.socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0)
    if (fd < 0) return null
    const reuseBuf = new Int32Array([1])
    libc.symbols.setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, ptr(reuseBuf), 4)
    const bindSa = buildSockaddrIn(new Uint8Array([0, 0, 0, 0]), 0)
    if (libc.symbols.bind(fd, ptr(bindSa), bindSa.length) < 0) {
      libc.symbols.close(fd)
      return null
    }
    const nameBuf = new Uint8Array(16)
    const nameLenBuf = new Uint32Array([16])
    if (libc.symbols.getsockname(fd, ptr(nameBuf), ptr(nameLenBuf)) < 0) {
      libc.symbols.close(fd)
      return null
    }
    const srcPort = (nameBuf[2] << 8) | nameBuf[3]
    const ttlBuf = new Int32Array([ttl])
    if (libc.symbols.setsockopt(fd, IPPROTO_IP, IP_TTL, ptr(ttlBuf), 4) < 0) {
      libc.symbols.close(fd)
      return null
    }
    const synCntBuf = new Int32Array([1])
    // TCP_SYNCNT silently ignores EINVAL on old kernels; we don't abort.
    libc.symbols.setsockopt(fd, IPPROTO_TCP, TCP_SYNCNT, ptr(synCntBuf), 4)
    return { fd, srcPort }
  }

  const deadlineNs = Bun.nanoseconds() + timeoutMs * 1_000_000
  try {
    outer: for (let cycle = 0; cycle < packets; cycle += 1) {
      for (let ttl = 1; ttl <= maxHops; ttl += 1) {
        if (Bun.nanoseconds() >= deadlineNs) break outer
        // Stop sending past the destination once we've seen it respond.
        if (destHopIndex != null && ttl - 1 > destHopIndex) break

        const opened = openProbeSocket(ttl)
        if (opened == null) continue
        const sendTimeNs = Bun.nanoseconds()
        const seq = encodeSeq(cycle, ttl, maxHops)
        // connect() on a non-blocking socket returns immediately: -1 with
        // errno=EINPROGRESS if the SYN was sent, 0 if the kernel already
        // completed the handshake (localhost targets), or -1 with some
        // other errno if the send failed outright.
        libc.symbols.connect(opened.fd, ptr(targetSa), targetSa.length)
        inflightByPort.set(opened.srcPort, {
          cycle,
          fd: opened.fd,
          resolved: false,
          sendTimeNs,
          seq,
          srcPort: opened.srcPort,
          ttl,
        })
        events.push({ kind: 'sent', hopIndex: ttl - 1, probeId: seq })

        const nextSendAtNs = Bun.nanoseconds() + probeIntervalMs * 1_000_000
        while (Bun.nanoseconds() < nextSendAtNs && Bun.nanoseconds() < deadlineNs) {
          let workDone = false
          while (drainIcmp()) workDone = true
          pollFds()
          if (!workDone) await Bun.sleep(2)
        }
      }
    }

    // Drain phase: we've sent every probe, now wait for replies until the
    // deadline. drainIcmp + pollFds are both non-blocking so a quiet path
    // doesn't spin-wait.
    while (Bun.nanoseconds() < deadlineNs) {
      let workDone = false
      while (drainIcmp()) workDone = true
      pollFds()
      const anyUnresolved = Array.from(inflightByPort.values()).some((p) => !p.resolved)
      if (!anyUnresolved) break
      if (!workDone) await Bun.sleep(5)
    }
  } finally {
    libc.symbols.close(icmpSock)
    for (const probe of inflightByPort.values()) {
      libc.symbols.close(probe.fd)
    }
  }

  if (resolveRdns) {
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
    const rdnsPerHostMs = 2_000
    const resolved = await Promise.all(
      Array.from(hopIndicesByHost.keys()).map(async (ip) => {
        const lookup = reverse(ip).catch(() => [] as string[])
        const timeout = new Promise<string[]>((resolve) =>
          setTimeout(() => resolve([]), rdnsPerHostMs).unref(),
        )
        const names = await Promise.race([lookup, timeout])
        return { ip, name: names[0] ?? null }
      }),
    )
    for (const { ip, name } of resolved) {
      if (name == null) continue
      for (const hopIndex of hopIndicesByHost.get(ip) ?? []) {
        events.push({ kind: 'dns', hopIndex, host: name })
      }
    }
  }

  return events
}
