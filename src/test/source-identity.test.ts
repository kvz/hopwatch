import { describe, expect, test } from 'vitest'
import {
  buildSourceIdentity,
  formatSourceIdentityInline,
  formatSourceIdentityLines,
  sourceIdentityWithFallback,
} from '../lib/source-identity.ts'

describe('source identity formatting', () => {
  test('formats an inline probing source for escalation copy', () => {
    const identity = buildSourceIdentity({
      datacenter: 'ex1-dc1',
      egressIp: '203.0.113.10',
      hostname: 'probe-1.example.net',
      location: 'Example City (ex1)',
      provider: 'Example Cloud',
      publicHostname: 'hopwatch.example.net',
      siteLabel: 'dc-1',
    })

    expect(formatSourceIdentityInline(identity)).toBe(
      'probe-1.example.net, egress 203.0.113.10, Example Cloud Example City (ex1) / ex1-dc1',
    )
  })

  test('formats source detail lines for escalation copy', () => {
    const identity = buildSourceIdentity({
      datacenter: 'ex1-dc1',
      egressIp: '203.0.113.10',
      hostname: 'probe-1.example.net',
      location: 'Example City (ex1)',
      provider: 'Example Cloud',
      publicHostname: 'hopwatch.example.net',
      siteLabel: 'dc-1',
    })

    expect(formatSourceIdentityLines(identity)).toEqual([
      'Source hostname: probe-1.example.net',
      'Source public hostname: hopwatch.example.net',
      'Source egress IP: 203.0.113.10',
      'Source provider: Example Cloud',
      'Source location: Example City (ex1)',
      'Source datacenter: ex1-dc1',
      'Internal site label: dc-1',
    ])
  })

  test('falls back to request-derived fields without overwriting configured fields', () => {
    const identity = sourceIdentityWithFallback(
      buildSourceIdentity({
        hostname: 'probe-1.example.net',
      }),
      {
        egressIp: '203.0.113.10',
        hostname: 'ignored.example.net',
        publicHostname: 'hopwatch.example.net',
      },
    )

    expect(identity).toEqual({
      datacenter: null,
      egressIp: '203.0.113.10',
      hostname: 'probe-1.example.net',
      location: null,
      provider: null,
      publicHostname: 'hopwatch.example.net',
      siteLabel: null,
    })
  })

  test('uses a generic fallback when no source details are known', () => {
    expect(formatSourceIdentityInline(null)).toBe('the probing host')
    expect(formatSourceIdentityLines(null)).toEqual([])
    expect(formatSourceIdentityInline(buildSourceIdentity({}))).toBe('the probing host')
  })
})
