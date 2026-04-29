import type { ReactNode } from 'react'

export type RichNetworkTextTokenKind = 'email' | 'network' | 'text'

export interface RichNetworkTextToken {
  kind: RichNetworkTextTokenKind
  start: number
  text: string
}

const EMAIL_PATTERN = String.raw`[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`
const IPV4_PATTERN = String.raw`(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}`
const HOSTNAME_PATTERN = String.raw`(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z][A-Z0-9-]{1,62}`
const RICH_NETWORK_TOKEN_PATTERN = new RegExp(
  `${EMAIL_PATTERN}|\\b${IPV4_PATTERN}\\b|\\b${HOSTNAME_PATTERN}\\b`,
  'gi',
)
const EMAIL_EXACT_PATTERN = new RegExp(`^${EMAIL_PATTERN}$`, 'i')

function tokenKind(text: string): RichNetworkTextTokenKind {
  return EMAIL_EXACT_PATTERN.test(text) ? 'email' : 'network'
}

export function tokenizeRichNetworkText(text: string): RichNetworkTextToken[] {
  const tokens: RichNetworkTextToken[] = []
  let lastIndex = 0

  for (const match of text.matchAll(RICH_NETWORK_TOKEN_PATTERN)) {
    const matchedText = match[0]
    const index = match.index
    if (index == null) continue

    if (index > lastIndex) {
      tokens.push({ kind: 'text', start: lastIndex, text: text.slice(lastIndex, index) })
    }

    tokens.push({ kind: tokenKind(matchedText), start: index, text: matchedText })
    lastIndex = index + matchedText.length
  }

  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', start: lastIndex, text: text.slice(lastIndex) })
  }

  return tokens
}

export interface RichNetworkTextProps {
  text: string
}

export function RichNetworkText({ text }: RichNetworkTextProps): ReactNode {
  return tokenizeRichNetworkText(text).map((token) => {
    if (token.kind === 'email') {
      return (
        <a href={`mailto:${token.text}`} key={`${token.kind}-${token.start}`}>
          {token.text}
        </a>
      )
    }

    if (token.kind === 'network') {
      return (
        <code className="network-token" key={`${token.kind}-${token.start}`}>
          {token.text}
        </code>
      )
    }

    return token.text
  })
}
