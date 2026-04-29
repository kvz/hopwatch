import { describe, expect, test } from 'vitest'
import { tokenizeRichNetworkText } from '../components/RichNetworkText.tsx'

describe('tokenizeRichNetworkText', () => {
  test('marks hostnames, IPs, and email addresses without swallowing punctuation', () => {
    expect(
      tokenizeRichNetworkText(
        'Hop 33455.your-cloud.host (5.161.8.130) to s3.us-west-2.amazonaws.com - contact network@hetzner.com.',
      ),
    ).toEqual([
      { kind: 'text', start: 0, text: 'Hop ' },
      { kind: 'network', start: 4, text: '33455.your-cloud.host' },
      { kind: 'text', start: 25, text: ' (' },
      { kind: 'network', start: 27, text: '5.161.8.130' },
      { kind: 'text', start: 38, text: ') to ' },
      { kind: 'network', start: 43, text: 's3.us-west-2.amazonaws.com' },
      { kind: 'text', start: 69, text: ' - contact ' },
      { kind: 'email', start: 80, text: 'network@hetzner.com' },
      { kind: 'text', start: 99, text: '.' },
    ])
  })

  test('does not treat ISO timestamps or percentages as network tokens', () => {
    expect(tokenizeRichNetworkText('Degraded since 2026-04-20T11:00:00.000Z at ~51.2%.')).toEqual([
      { kind: 'text', start: 0, text: 'Degraded since 2026-04-20T11:00:00.000Z at ~51.2%.' },
    ])
  })
})
