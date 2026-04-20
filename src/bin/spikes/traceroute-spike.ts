#!/usr/bin/env bun
// Traceroute feasibility spike. Linux-only CLI wrapper around the native
// prober in src/lib/prober-native.ts. Resolves the target, runs the prober,
// pretty-prints a per-hop table from the emitted RawMtrEvent stream. Kept as
// an operator tool for eyeballing against mtr on the observer; the real
// integration lives in the collector.
//
// Requires CAP_NET_RAW (observer unit grants it; locally: run with sudo).
//
// Usage:
//   bun src/bin/spikes/traceroute-spike.ts --target google.com
//     [--max-hops 30] [--packets 3] [--timeout-ms 5000] [--no-rdns] [--json]

import { lookup } from 'node:dns/promises'
import { parseArgs } from 'node:util'
import { decodeSeq } from '../../lib/icmp.ts'
import { probeTargetNative } from '../../lib/prober-native.ts'
import type { RawMtrEvent } from '../../lib/raw.ts'

interface HopSummary {
  hopIndex: number
  hosts: string[]
  dnsNames: string[]
  sent: number
  rttsUs: number[]
}

function summarize(events: RawMtrEvent[], maxHops: number): HopSummary[] {
  const byHop = new Map<number, HopSummary>()
  const ensure = (hopIndex: number): HopSummary => {
    let h = byHop.get(hopIndex)
    if (h == null) {
      h = { hopIndex, hosts: [], dnsNames: [], sent: 0, rttsUs: [] }
      byHop.set(hopIndex, h)
    }
    return h
  }
  for (const event of events) {
    const hop = ensure(event.hopIndex)
    if (event.kind === 'sent') hop.sent += 1
    else if (event.kind === 'host' && !hop.hosts.includes(event.host)) hop.hosts.push(event.host)
    else if (event.kind === 'dns' && !hop.dnsNames.includes(event.host))
      hop.dnsNames.push(event.host)
    else if (event.kind === 'reply') hop.rttsUs.push(event.rttUs)
  }
  const out: HopSummary[] = []
  for (let hopIndex = 0; hopIndex < maxHops; hopIndex += 1) {
    out.push(byHop.get(hopIndex) ?? { hopIndex, hosts: [], dnsNames: [], sent: 0, rttsUs: [] })
  }
  return out
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      'max-hops': { type: 'string', default: '30' },
      packets: { type: 'string', default: '3' },
      'timeout-ms': { type: 'string', default: '5000' },
      'no-rdns': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  })

  const target = values.target
  if (target == null || target.length === 0) {
    throw new Error('--target is required (host or IPv4)')
  }
  const maxHops = Number(values['max-hops'])
  const packets = Number(values.packets)
  const timeoutMs = Number(values['timeout-ms'])

  const resolved = await lookup(target, 4)
  if (!values.json) {
    console.log(
      `traceroute-spike: target=${target} (${resolved.address}), maxHops=${maxHops}, packets=${packets}, timeoutMs=${timeoutMs}`,
    )
  }

  const events = await probeTargetNative({
    hostIp: resolved.address,
    maxHops,
    packets,
    timeoutMs,
    resolveReverseDns: !values['no-rdns'],
  })

  if (values.json) {
    for (const event of events) console.log(JSON.stringify(event))
    return
  }

  const hops = summarize(events, maxHops)
  // Find the last hop with any reply so we don't print 30 rows of silence.
  let lastInterestingHop = -1
  for (const hop of hops) {
    if (hop.rttsUs.length > 0) lastInterestingHop = hop.hopIndex
  }
  if (lastInterestingHop < 0) {
    console.log('no replies received — destination unreachable or probes blocked')
    return
  }

  for (let hopIndex = 0; hopIndex <= lastInterestingHop; hopIndex += 1) {
    const hop = hops[hopIndex]
    const ttl = hopIndex + 1
    if (hop.rttsUs.length === 0) {
      console.log(`${String(ttl).padStart(2)}  *`)
      continue
    }
    const hostLabel =
      hop.dnsNames.length > 0 ? `${hop.dnsNames[0]} (${hop.hosts.join(',')})` : hop.hosts.join(',')
    const rtts = hop.rttsUs.map((us) => `${(us / 1000).toFixed(1)}ms`).join(' ')
    const loss =
      hop.sent === 0
        ? ''
        : ` loss=${(((hop.sent - hop.rttsUs.length) / hop.sent) * 100).toFixed(0)}%`
    console.log(`${String(ttl).padStart(2)}  ${hostLabel.padEnd(48)}  ${rtts}${loss}`)
  }

  // Sanity-check: confirm seq decoding round-trips using maxHops.
  for (const event of events) {
    if (event.kind !== 'reply') continue
    const { ttl } = decodeSeq(event.probeId, maxHops)
    if (ttl - 1 !== event.hopIndex) {
      console.warn(
        `decodeSeq mismatch: probeId=${event.probeId} hopIndex=${event.hopIndex} ttl=${ttl}`,
      )
    }
  }
}

main().catch((err) => {
  if (!(err instanceof Error)) {
    throw new Error(`Was thrown a non-error: ${err}`)
  }
  console.error(err.message)
  process.exit(1)
})
