import { describe, expect, test } from 'vitest'
import { deriveTargetVariant } from '../lib/target-variant.ts'

describe('deriveTargetVariant', () => {
  test('returns null for the vanilla ICMP / mtr / no-netns default', () => {
    // The baseline probe shape - the label is the full story, no pill
    // needed. Keeping the pill quiet here avoids polluting every row
    // with a redundant "ICMP" badge that adds no information.
    expect(
      deriveTargetVariant({
        engine: 'mtr',
        netns: null,
        port: 443,
        probeMode: 'default',
        protocol: 'icmp',
      }),
    ).toBeNull()
  })

  test('renders TCP 443 for a TCP probe over mtr with no netns', () => {
    expect(
      deriveTargetVariant({
        engine: 'mtr',
        netns: null,
        port: 443,
        probeMode: 'default',
        protocol: 'tcp',
      }),
    ).toBe('TCP 443')
  })

  test('surfaces a custom TCP port', () => {
    expect(
      deriveTargetVariant({
        engine: 'mtr',
        netns: null,
        port: 8443,
        probeMode: 'default',
        protocol: 'tcp',
      }),
    ).toBe('TCP 8443')
  })

  test('surfaces the native engine when it is the non-default choice', () => {
    expect(
      deriveTargetVariant({
        engine: 'native',
        netns: null,
        port: 443,
        probeMode: 'default',
        protocol: 'tcp',
      }),
    ).toBe('TCP 443 · native')
  })

  test('flags netns when present, even for default ICMP', () => {
    expect(
      deriveTargetVariant({
        engine: 'mtr',
        netns: 'tl-allow-external',
        port: 443,
        probeMode: 'netns',
        protocol: 'icmp',
      }),
    ).toBe('via netns tl-allow-external')
  })

  test('composes TCP + netns + native into a single pill', () => {
    expect(
      deriveTargetVariant({
        engine: 'native',
        netns: 'tl-allow-external',
        port: 443,
        probeMode: 'netns',
        protocol: 'tcp',
      }),
    ).toBe('TCP 443 · via netns tl-allow-external · native')
  })

  test('ignores netns name when probeMode is default (misconfigured carryover)', () => {
    // A stale netns name on a default-mode target should not leak into
    // the pill - probeMode is the source of truth for which namespace,
    // if any, the probe actually runs in.
    expect(
      deriveTargetVariant({
        engine: 'mtr',
        netns: 'stale-name',
        port: 443,
        probeMode: 'default',
        protocol: 'icmp',
      }),
    ).toBeNull()
  })
})
