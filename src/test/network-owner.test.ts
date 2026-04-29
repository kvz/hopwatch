import { describe, expect, test } from 'vitest'
import {
  applyNetworkOwnerContactOverrides,
  cleanAsName,
  extractIpv4Address,
  formatNetworkOwnerLabel,
} from '../lib/network-owner.ts'

describe('network owner helpers', () => {
  test('extracts IPv4 addresses from rich hop labels', () => {
    expect(extractIpv4Address('s3-website.us-west-2.amazonaws.com (132.147.112.101)')).toBe(
      '132.147.112.101',
    )
    expect(extractIpv4Address('not an ip')).toBeNull()
    expect(extractIpv4Address('999.999.999.999')).toBeNull()
  })

  test('cleans Team Cymru AS names for operator-facing labels', () => {
    expect(cleanAsName('VIEWQWEST-SG-AP Viewqwest Pte Ltd, SG')).toBe('Viewqwest Pte Ltd')
    expect(cleanAsName('AMAZON-02 - Amazon.com, Inc., US')).toBe('Amazon.com, Inc.')
  })

  test('formats an owner label with ASN when available', () => {
    expect(
      formatNetworkOwnerLabel({
        asName: 'VIEWQWEST-SG-AP Viewqwest Pte Ltd, SG',
        asn: 'AS18106',
        contactEmails: ['noc.sg@viewqwest.com'],
        country: 'SG',
        fetchedAt: '2026-04-29T00:00:00.000Z',
        ip: '132.147.112.101',
        prefix: '132.147.112.0/24',
        rdapName: 'VIEWQWEST-NET',
        registry: 'apnic',
        source: 'test',
      }),
    ).toBe('Viewqwest Pte Ltd (AS18106)')
  })

  test('applies configured contact overrides before RDAP fallback contacts', () => {
    const owner = {
      asName: 'Arelion Sweden AB',
      asn: 'AS1299',
      contactEmails: ['abuse@twelve99.net'],
      country: 'SE',
      fetchedAt: '2026-04-29T00:00:00.000Z',
      ip: '62.115.136.103',
      prefix: '62.115.136.0/24',
      rdapName: 'TELIANET',
      registry: 'ripencc',
      source: 'test',
    }

    expect(
      applyNetworkOwnerContactOverrides(owner, [
        { asn: 'AS1299', contactEmails: ['support@arelion.com'] },
      ]).contactEmails,
    ).toEqual(['support@arelion.com', 'abuse@twelve99.net'])
  })
})
